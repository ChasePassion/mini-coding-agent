// 协议与时间线推导：与 src/events.ts 的 AgentEvent 契约保持一致（前端本地副本，
// 避免前端构建依赖服务端源码树）。时间线 fold 逻辑与 TUI 的 rebuildTranscript 同构。

export type RunMode = "default" | "full_access";
export type PermissionDecision = "allow_once" | "allow_session" | "deny";

export interface ToolCallInfo {
	callId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type AgentEvent =
	| { type: "session_started"; sessionId: string; workspace: string; mode: RunMode }
	| { type: "mode_changed"; mode: RunMode }
	| { type: "ask_user_toggled"; enabled: boolean }
	| { type: "user_message_added"; messageId: string; content: string; timestamp: number }
	| { type: "turn_started"; turnId: string }
	| { type: "assistant_started"; messageId: string }
	| { type: "assistant_delta"; messageId: string; delta: string }
	| {
			type: "assistant_completed";
			messageId: string;
			text: string;
			stopReason: string;
			usage?: TokenUsage;
			thinking?: string;
			thinkingMs?: number;
	  }
	| { type: "turn_completed"; turnId: string; stopReason: string }
	| { type: "tool_queued"; call: ToolCallInfo }
	| { type: "permission_required"; requestId: string; call: ToolCallInfo; summary: string }
	| { type: "permission_resolved"; requestId: string; decision: PermissionDecision }
	| { type: "tool_started"; callId: string }
	| { type: "tool_completed"; callId: string; toolName: string; ok: boolean; durationMs: number; output?: string; error?: string }
	| { type: "user_input_requested"; callId: string; question: string; options: string[] }
	| { type: "user_input_received"; callId: string; answer: string }
	| { type: "agent_error"; message: string };

export interface SessionInfo {
	id: string;
	title: string;
	updatedAt: number;
}

export type Downlink =
	| AgentEvent
	| {
			type: "snapshot";
			sessionId: string;
			mode: RunMode;
			askUserEnabled: boolean;
			running: boolean;
			events: AgentEvent[];
	  }
	| { type: "session_list"; sessions: SessionInfo[] };

export type Uplink =
	| { type: "user_message"; text: string }
	| { type: "permission_response"; requestId: string; decision: PermissionDecision }
	| { type: "ask_user_response"; callId: string; answer: string }
	| { type: "mode_change"; mode: RunMode }
	| { type: "ask_user_toggle"; enabled: boolean }
	| { type: "interrupt" }
	| { type: "session_new" }
	| { type: "session_load"; sessionId: string };

/** AI Elements Tool 组件的状态（ToolUIPart["state"] 子集） */
export type ToolCardState = "input-streaming" | "input-available" | "output-available" | "output-error";

export interface PermissionInfo {
	requestId: string;
	summary: string;
	decision?: PermissionDecision;
	pending: boolean;
}

export type TimelineItem =
	| { kind: "user"; content: string }
	| { kind: "assistant"; text: string; thinking?: string; thinkingSec?: number }
	| {
			kind: "tool";
			callId: string;
			label: string;
			args: Record<string, unknown>;
			state: ToolCardState;
			durationMs?: number;
			output?: string;
			error?: string;
			permission?: PermissionInfo;
	  }
	| { kind: "ask"; callId: string; question: string; options: string[]; answer?: string; pending: boolean }
	| { kind: "error"; message: string }
	| { kind: "summary"; cachePct: number | null; toolsOk: number; toolsTotal: number; denied: number };

export function toolLabel(call: ToolCallInfo): string {
	switch (call.toolName) {
		case "read":
		case "write":
		case "list":
			return `${call.toolName} ${String(call.args.path ?? "")}`.trim();
		case "bash":
			return `bash: ${String(call.args.command ?? "").slice(0, 80)}`;
		case "ask_user":
			return `ask_user: ${String(call.args.question ?? "").slice(0, 80)}`;
		default:
			return call.toolName;
	}
}

/** 事件 → 时间线（与 TUI rebuildTranscript 同构：工具终态预计算 + 权限按 requestId 归组） */
export function buildTimeline(events: AgentEvent[]): TimelineItem[] {
	const toolFinal = new Map<string, { started: boolean; ok?: boolean; durationMs?: number; output?: string; error?: string }>();
	for (const e of events) {
		if (e.type === "tool_started") {
			const t = toolFinal.get(e.callId);
			if (t) t.started = true;
			else toolFinal.set(e.callId, { started: true });
		} else if (e.type === "tool_completed") {
			const t = toolFinal.get(e.callId) ?? { started: true };
			t.ok = e.ok;
			t.durationMs = e.durationMs;
			t.output = e.output;
			t.error = e.error;
			toolFinal.set(e.callId, t);
		}
	}

	const permissionByCall = new Map<string, PermissionInfo>();
	for (const e of events) {
		if (e.type === "permission_required") {
			permissionByCall.set(e.requestId, { requestId: e.requestId, summary: e.summary, pending: true });
		} else if (e.type === "permission_resolved") {
			const rec = permissionByCall.get(e.requestId);
			if (rec) {
				rec.decision = e.decision;
				rec.pending = false;
			}
		}
	}

	const askByCall = new Map<string, { question: string; options: string[]; answer?: string }>();
	for (const e of events) {
		if (e.type === "user_input_requested") askByCall.set(e.callId, { question: e.question, options: e.options });
		else if (e.type === "user_input_received") {
			const rec = askByCall.get(e.callId);
			if (rec) rec.answer = e.answer;
		}
	}

	// 轮末指标（累计到该 turn_completed 为止）
	const items: TimelineItem[] = [];
	let m = { usageIn: 0, cacheRead: 0, cacheWrite: 0, ok: 0, failed: 0, denied: 0, turns: 0 };
	for (const e of events) {
		switch (e.type) {
			case "user_message_added":
				items.push({ kind: "user", content: e.content });
				break;
			case "assistant_completed":
				items.push({
					kind: "assistant",
					text: e.text,
					thinking: e.thinking,
					thinkingSec: e.thinkingMs != null ? Math.max(1, Math.round(e.thinkingMs / 1000)) : undefined,
				});
				if (e.usage) {
					m.turns += 1;
					m.usageIn += e.usage.input;
					m.cacheRead += e.usage.cacheRead;
					m.cacheWrite += e.usage.cacheWrite;
				}
				break;
			case "tool_queued": {
				const final = toolFinal.get(e.call.callId);
				const state: ToolCardState = final?.ok === undefined ? (final?.started ? "input-available" : "input-streaming") : final.ok ? "output-available" : "output-error";
				items.push({
					kind: "tool",
					callId: e.call.callId,
					label: toolLabel(e.call),
					args: e.call.args,
					state,
					durationMs: final?.durationMs,
					output: final?.output,
					error: final?.error,
					permission: permissionByCall.get(e.call.callId),
				});
				break;
			}
			case "user_input_requested": {
				const rec = askByCall.get(e.callId);
				if (rec) {
					items.push({ kind: "ask", callId: e.callId, question: rec.question, options: rec.options, answer: rec.answer, pending: rec.answer == null });
				}
				break;
			}
			case "agent_error":
				items.push({ kind: "error", message: e.message });
				break;
			case "turn_completed": {
				const denom = m.usageIn + m.cacheRead + m.cacheWrite;
				const cachePct = m.turns > 0 && denom > 0 ? Math.round((m.cacheRead / denom) * 100) : null;
				items.push({ kind: "summary", cachePct, toolsOk: m.ok, toolsTotal: m.ok + m.failed, denied: m.denied });
				break;
			}
			default:
				break;
		}
		if (e.type === "tool_completed") {
			if (e.ok) m.ok += 1;
			else m.failed += 1;
		}
		if (e.type === "permission_resolved" && e.decision === "deny") m.denied += 1;
	}
	return items;
}

/** 幂等追加：服务端在重连 snapshot 后会重发 pending 权限/提问，按 id 去重 */
export function appendEvent(events: AgentEvent[], e: AgentEvent): AgentEvent[] {
	const idOf = (ev: AgentEvent): string | null => {
		if (ev.type === "permission_required") return `pr:${ev.requestId}`;
		if (ev.type === "permission_resolved") return `pres:${ev.requestId}`;
		if (ev.type === "user_input_requested") return `uir:${ev.callId}`;
		if (ev.type === "user_input_received") return `uin:${ev.callId}`;
		return null;
	};
	const key = idOf(e);
	if (key && events.some((x) => idOf(x) === key)) return events;
	return [...events, e];
}

/** running = 存在未收尾的 turn */
export function deriveRunning(events: AgentEvent[]): boolean {
	let running = false;
	for (const e of events) {
		if (e.type === "turn_started") running = true;
		if (e.type === "turn_completed") running = false;
	}
	return running;
}
