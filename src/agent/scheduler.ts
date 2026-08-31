// Tool Scheduler（Phase 1：串行执行版）。
// 对 Loop 的接口与并发版（锚点③）完全一致：execute(toolCalls) -> ToolResultMessage[]，
// 权限（Default 模式 write/bash + 会话级授权）在本层生效；锁与并发调度 Phase 2 接入（锚点③整体替换）。
import { validateToolArguments, type Tool, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, PermissionDecision, RunMode, ToolCallInfo } from "../events.ts";
import type { AgentTool } from "./tools/index.ts";

export interface PermissionRequester {
	request(call: ToolCallInfo, summary: string): Promise<PermissionDecision>;
}

export class ToolScheduler {
	private sessionGrants = new Set<string>();

	constructor(
		private readonly registry: { get(name: string): AgentTool | undefined },
		private readonly permissions: PermissionRequester,
		private readonly emit: (e: AgentEvent) => void,
		private readonly ctx: { workspace: string; getMode(): RunMode; signal?: AbortSignal },
	) {}

	async execute(calls: ToolCall[]): Promise<ToolResultMessage[]> {
		const results: ToolResultMessage[] = [];
		// Phase 1：串行 for 循环。Phase 2（锚点③）：Promise.all 并发 + 两级锁 + Bash 预约。
		for (const call of calls) {
			results.push(await this.runOne(call));
		}
		return results;
	}

	private async runOne(call: ToolCall): Promise<ToolResultMessage> {
		const info: ToolCallInfo = {
			callId: call.id,
			toolName: call.name,
			args: (call.arguments ?? {}) as Record<string, unknown>,
		};
		this.emit({ type: "tool_queued", call: info });
		const startedAt = Date.now();
		const finish = (ok: boolean, text: string): ToolResultMessage => {
			const durationMs = Date.now() - startedAt;
			this.emit({
				type: "tool_completed",
				callId: call.id,
				toolName: call.name,
				ok,
				durationMs,
				output: ok ? text : undefined,
				error: ok ? undefined : text,
			});
			return {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text }],
				isError: !ok,
				timestamp: Date.now(),
			};
		};

		const tool = this.registry.get(call.name);
		if (!tool) return finish(false, `Unknown tool: ${call.name}`);
		const mode = this.ctx.getMode();

		// ── 权限（先批准，后执行；write 不持任何资源，bash 的预约机制 Phase 2 引入）──
		if (
			mode === "default" &&
			(tool.kind === "write" || tool.kind === "bash") &&
			!this.sessionGrants.has(tool.name)
		) {
			const decision = await this.permissions.request(info, tool.describe(info.args));
			this.emit({ type: "permission_resolved", requestId: call.id, decision });
			if (decision === "deny") return finish(false, "User denied permission for this tool call.");
			if (decision === "allow_session") this.sessionGrants.add(tool.name);
		}

		// ── 参数防御性校验（模型幻觉参数 → 干净的 isError 结果而非异常）──
		let args = info.args;
		try {
			const schemaTool: Tool = {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			};
			args = validateToolArguments(schemaTool, call);
		} catch (err) {
			return finish(false, `Invalid tool arguments: ${err instanceof Error ? err.message : String(err)}`);
		}

		// ── 执行 ──
		this.emit({ type: "tool_started", callId: call.id });
		try {
			const output = await tool.execute(args, { signal: this.ctx.signal });
			return finish(!output.isError, output.text);
		} catch (err) {
			return finish(false, err instanceof Error ? err.message : String(err));
		}
	}
}
