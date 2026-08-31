// Tool Scheduler：并发冲突的唯一裁决点（锚点③）。
// 两级锁：全局门（bash 独占 / 其余共享）+ 文件读写锁（read 共享 / write 独占）。
// bash 预约（bashReserved）：先拿执行资格再打扰用户；Deny 立即归还（设计方案 §10/§11）。
//
// 与锚点③的一处必要修正：锚点以 active===0 判定 bash 可预约，但 execute() 已把 bash
// 自身计入 active，Default 模式下单独一条 bash 会自死锁。这里改为 nonBashPending 计数
// （bash 不计入自己），预约条件 = 无在途非 bash 工具 && 无预约。锁结构、FIFO、预约协议不变。
import path from "node:path";
import { validateToolArguments, type Tool, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, PermissionDecision, RunMode, ToolCallInfo } from "../events.ts";
import type { AgentTool } from "./tools/index.ts";

export interface PermissionRequester {
	request(call: ToolCallInfo, summary: string): Promise<PermissionDecision>;
}

/** 文件锁等待者：write=true 表示独占写请求 */
type FileWaiter = { write: boolean; resolve: () => void };
/** 全局门等待者：bash=true 表示独占执行请求 */
type GateWaiter = { bash: boolean; resolve: () => void };

class LockManager {
	private shared = 0; // 全局门共享持有数（read/write/list/ask_user）
	private exclusive = false; // bash 持有全局独占
	private gateWaiters: GateWaiter[] = [];
	private files = new Map<string, { readers: number; writer: boolean; waiters: FileWaiter[] }>();

	async acquireGate(bash: boolean): Promise<void> {
		if (bash) {
			if (!this.exclusive && this.shared === 0 && this.gateWaiters.length === 0) {
				this.exclusive = true;
				return;
			}
			await new Promise<void>((r) => this.gateWaiters.push({ bash: true, resolve: r }));
			return;
		}
		if (!this.exclusive && this.gateWaiters.length === 0) {
			this.shared++;
			return;
		}
		await new Promise<void>((r) => this.gateWaiters.push({ bash: false, resolve: r }));
	}

	releaseGate(bash: boolean): void {
		if (bash) this.exclusive = false;
		else this.shared--;
		this.pumpGate();
	}

	private pumpGate(): void {
		while (this.gateWaiters.length > 0) {
			const w = this.gateWaiters[0];
			if (w.bash) {
				if (this.exclusive || this.shared > 0) return;
				this.gateWaiters.shift();
				this.exclusive = true;
				w.resolve();
				return; // bash 独占后停止放行
			}
			if (this.exclusive) return;
			this.gateWaiters.shift();
			this.shared++; // 共享请求可连续批量放行
			w.resolve();
		}
	}

	async acquireFile(key: string, mode: "read" | "write"): Promise<void> {
		let f = this.files.get(key);
		if (!f) {
			f = { readers: 0, writer: false, waiters: [] };
			this.files.set(key, f);
		}
		if (mode === "read" && !f.writer && f.waiters.length === 0) {
			f.readers++;
			return;
		}
		if (mode === "write" && !f.writer && f.readers === 0 && f.waiters.length === 0) {
			f.writer = true;
			return;
		}
		await new Promise<void>((r) => f!.waiters.push({ write: mode === "write", resolve: r }));
	}

	releaseFile(key: string, mode: "read" | "write"): void {
		const f = this.files.get(key);
		if (!f) return;
		if (mode === "read") f.readers--;
		else f.writer = false;
		while (f.waiters.length > 0) {
			const w = f.waiters[0];
			if (w.write) {
				if (f.readers === 0 && !f.writer) {
					f.waiters.shift();
					f.writer = true;
					w.resolve();
				}
				return; // 队首写请求不满足 → 停止放行（FIFO 防写饥饿）
			}
			if (f.writer) return;
			f.waiters.shift();
			f.readers++; // 队首读请求 → 连续批量放行
			w.resolve();
		}
	}
}

export class ToolScheduler {
	private bashReserved = false;
	private bashReservedWaiters: Array<() => void> = [];
	private nonBashPending = 0; // 在途非 bash 工具数（bash 的预约资格条件）
	private bashEligibleWaiters: Array<() => void> = [];
	private sessionGrants = new Set<string>();
	private locks = new LockManager();

	constructor(
		private readonly registry: { get(name: string): AgentTool | undefined },
		private readonly permissions: PermissionRequester,
		private readonly emit: (e: AgentEvent) => void,
		private readonly ctx: { workspace: string; getMode(): RunMode; signal?: AbortSignal },
	) {}

	private isBash(name: string): boolean {
		return this.registry.get(name)?.kind === "bash";
	}

	/** bash 预约资格：无在途非 bash 工具且无既有预约（单线程内条件检查与置位原子） */
	private async waitUntilBashEligible(): Promise<void> {
		while (this.nonBashPending > 0 || this.bashReserved) {
			await new Promise<void>((r) => this.bashEligibleWaiters.push(r));
		}
	}

	private notifyBashEligible(): void {
		for (const w of this.bashEligibleWaiters.splice(0)) w();
	}

	private notifyBashCleared(): void {
		for (const w of this.bashReservedWaiters.splice(0)) w();
	}

	/** 非 bash 工具不得越过 bash 预约（设计方案 §11） */
	private async waitUntilBashCleared(): Promise<void> {
		while (this.bashReserved) {
			await new Promise<void>((r) => this.bashReservedWaiters.push(r));
		}
	}

	async execute(calls: ToolCall[]): Promise<ToolResultMessage[]> {
		for (const c of calls) {
			if (!this.isBash(c.name)) this.nonBashPending++;
		}
		const tasks = calls.map(async (c) => {
			try {
				return await this.runOne(c);
			} finally {
				if (!this.isBash(c.name)) this.nonBashPending--;
				this.notifyBashEligible();
				if (!this.bashReserved) this.notifyBashCleared();
			}
		});
		return Promise.all(tasks);
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

		// ── 参数防御性校验（§6.5：模型幻觉参数 → 干净的 isError 结果而非异常）──
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

		// ── 阶段 1：权限（先要批准，后占资源）──
		if (mode === "default" && (tool.kind === "write" || tool.kind === "bash") && !this.sessionGrants.has(tool.name)) {
			let reservedHere = false;
			if (tool.kind === "bash") {
				await this.waitUntilBashEligible(); // bash：先等全部在途非 bash 工具结束
				this.bashReserved = true; // 预约执行权，挡住新工具
				reservedHere = true;
			}
			const decision = await this.permissions.request(info, tool.describe(info.args));
			this.emit({ type: "permission_resolved", requestId: call.id, decision });
			if (decision === "deny") {
				if (reservedHere) {
					this.bashReserved = false; // Deny 立即归还资格
					this.notifyBashCleared();
					this.notifyBashEligible();
				}
				return finish(false, "User denied permission for this tool call.");
			}
			if (decision === "allow_session") this.sessionGrants.add(tool.name);
			// Allow：bash 保持预约，直到下方拿到独占锁后再释放
		}

		// ── 阶段 2：加锁执行 ──
		const fileMode = tool.kind === "read" || tool.kind === "write" ? tool.kind : null;
		const fileKey = fileMode ? path.resolve(this.ctx.workspace, String(info.args.path ?? ".")) : null;
		try {
			if (tool.kind === "bash") {
				await this.locks.acquireGate(true); // 全局独占
				this.bashReserved = false; // 已握锁，释放预约
				this.notifyBashCleared();
				this.notifyBashEligible();
			} else {
				await this.waitUntilBashCleared(); // 新工具不得越过 bash 预约
				if (fileMode && fileKey) await this.locks.acquireFile(fileKey, fileMode); // read 共享 / write 独占
				await this.locks.acquireGate(false); // 全局门共享（list/ask_user 仅此一道）
			}
		} catch {
			// 加锁等待期被取消：由下方 finally 统一逆序释放，不泄漏锁
		}

		this.emit({ type: "tool_started", callId: call.id });
		try {
			const output = await tool.execute(args, { signal: this.ctx.signal });
			return finish(!output.isError, output.text);
		} catch (err) {
			return finish(false, err instanceof Error ? err.message : String(err));
		} finally {
			// 逆序释放
			if (tool.kind === "bash") this.locks.releaseGate(true);
			else {
				this.locks.releaseGate(false);
				if (fileMode && fileKey) this.locks.releaseFile(fileKey, fileMode);
			}
		}
	}
}
