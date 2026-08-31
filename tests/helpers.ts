// 测试共享工具（§9.1）：受控假工具（execute 挂起直到测试手动放行）、脚本化权限、事件断言。
// 所有用例零网络、零 sleep 依赖时序运气：中间态用 waitFor 断言。
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { ToolScheduler, type PermissionRequester } from "../src/agent/scheduler.ts";
import type { AgentEvent, PermissionDecision, RunMode, ToolCallInfo } from "../src/events.ts";
import { ToolRegistry, type AgentTool, type ToolExecContext, type ToolKind, type ToolOutput } from "../src/agent/tools/index.ts";

export const WORKSPACE = path.resolve(os.tmpdir(), "mca-test-ws");

let seq = 0;
export function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
	seq += 1;
	return { type: "toolCall", id: `call-${seq}`, name, arguments: args };
}

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * 受控假工具：同名多次调用共享一个定义（与真实工具一致）；
 * 每次执行压入一个新 gate，测试按下标放行（下标顺序 = 实际启动顺序）。
 */
export function fakeTool(
	name: string,
	kind: ToolKind,
	opts?: { signalAware?: boolean; immediate?: ToolOutput },
): { tool: AgentTool; gates: Deferred<ToolOutput>[] } {
	const gates: Deferred<ToolOutput>[] = [];
	const tool: AgentTool = {
		name,
		kind,
		description: `fake ${name}`,
		parameters: Type.Object({}),
		describe: (a) => `${name} ${String(a.path ?? a.command ?? "")}`.trim(),
		execute: (_args: Record<string, unknown>, ctx: ToolExecContext) => {
			if (opts?.immediate) return Promise.resolve(opts.immediate);
			const g = deferred<ToolOutput>();
			gates.push(g);
			if (opts?.signalAware) {
				ctx.signal?.addEventListener("abort", () => g.reject(new Error("aborted by signal")), { once: true });
			}
			return g.promise;
		},
	};
	return { tool, gates };
}

export type ScriptedPermissions = PermissionRequester & {
	calls: ToolCallInfo[];
	summaries: string[];
};

export function permissionScript(
	script: (call: ToolCallInfo) => PermissionDecision | Promise<PermissionDecision>,
): ScriptedPermissions {
	const calls: ToolCallInfo[] = [];
	const summaries: string[] = [];
	return {
		calls,
		summaries,
		request: async (call, summary) => {
			calls.push(call);
			summaries.push(summary);
			return script(call);
		},
	};
}

export const allowOnce = permissionScript(() => "allow_once");
export const alwaysDeny = permissionScript(() => "deny");

export interface Harness {
	scheduler: ToolScheduler;
	events: AgentEvent[];
	permissions: ScriptedPermissions;
	mode: { value: RunMode };
	controller: AbortController;
}

export function harness(
	tools: AgentTool[],
	permissions: ScriptedPermissions = allowOnce,
	mode: RunMode = "default",
): Harness {
	const events: AgentEvent[] = [];
	const registry = new ToolRegistry(tools);
	const modeState = { value: mode };
	const controller = new AbortController();
	const scheduler = new ToolScheduler(registry, permissions, (e) => events.push(e), {
		workspace: WORKSPACE,
		getMode: () => modeState.value,
		signal: controller.signal,
	});
	return { scheduler, events, permissions, mode: modeState, controller };
}

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`waitFor timeout after ${ms}ms`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const startedIdx = (h: Harness, id: string) =>
	h.events.findIndex((e) => e.type === "tool_started" && e.callId === id);
export const completedIdx = (h: Harness, id: string) =>
	h.events.findIndex((e) => e.type === "tool_completed" && e.callId === id);
