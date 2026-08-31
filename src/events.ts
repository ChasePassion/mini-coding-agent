// 统一事件模型：Agent 运行时的唯一事实来源。
// TUI（进程内）与 WebUI（WebSocket）消费同一份协议；前端不持有业务状态，一切由事件推导。

export type RunMode = "default" | "full_access";
export type PermissionDecision = "allow_once" | "allow_session" | "deny";

export interface ToolCallInfo {
	callId: string;
	toolName: string;
	args: Record<string, unknown>;
}

/** 来自 AssistantMessage.usage 的子集，供指标采集（缓存命中率等） */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type AgentEvent =
	// ── 会话与开关 ──
	| { type: "session_started"; sessionId: string; workspace: string; mode: RunMode }
	| { type: "mode_changed"; mode: RunMode }
	| { type: "ask_user_toggled"; enabled: boolean }
	// ── 一轮任务（turn = 一次用户输入到最终答案）──
	| { type: "user_message_added"; messageId: string; content: string; timestamp: number }
	| { type: "turn_started"; turnId: string }
	| { type: "assistant_started"; messageId: string }
	| { type: "assistant_delta"; messageId: string; delta: string }
	| { type: "assistant_completed"; messageId: string; text: string; stopReason: string; usage?: TokenUsage; thinking?: string; thinkingMs?: number }
	| { type: "turn_completed"; turnId: string; stopReason: string }
	// ── 工具：调度态（queued）与执行态（started/completed）严格分离 ──
	| { type: "tool_queued"; call: ToolCallInfo }
	| { type: "permission_required"; requestId: string; call: ToolCallInfo; summary: string }
	| { type: "permission_resolved"; requestId: string; decision: PermissionDecision }
	| { type: "tool_started"; callId: string }
	| { type: "tool_completed"; callId: string; toolName: string; ok: boolean; durationMs: number; output?: string; error?: string }
	// ── ask_user ──
	| { type: "user_input_requested"; callId: string; question: string; options: string[] }
	| { type: "user_input_received"; callId: string; answer: string }
	// ── 异常 ──
	| { type: "agent_error"; message: string };
