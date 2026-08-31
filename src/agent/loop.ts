// src/agent/loop.ts —— Agent 层核心：一个 while 循环
// 退出条件：stopReason !== "toolUse"（含 error/aborted 分支）。对权限/并发/锁零感知。
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import type { AgentEvent, TokenUsage } from "../events.ts";
import type { LLMClient } from "../ai/client.ts";
import type { ToolScheduler } from "./scheduler.ts";

export interface AgentLoopOptions {
	client: LLMClient;
	scheduler: ToolScheduler;
	emit: (event: AgentEvent) => void;
	signal?: AbortSignal;
}

const isToolCall = (c: AssistantMessage["content"][number]): c is ToolCall => c.type === "toolCall";
const textOf = (m: AssistantMessage) =>
	m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
const usageOf = (u: AssistantMessage["usage"]): TokenUsage => ({
	input: u.input,
	output: u.output,
	cacheRead: u.cacheRead,
	cacheWrite: u.cacheWrite,
});

export async function runAgentLoop(context: Context, opts: AgentLoopOptions): Promise<void> {
	const { client, scheduler, emit, signal } = opts;
	const turnId = `turn-${Date.now().toString(36)}`;
	emit({ type: "turn_started", turnId });

	try {
		while (!signal?.aborted) {
			// 1) LLM 推理：流式 delta 一对一转发为 UI 事件（for await 驱动流，见锚点②注释）
			const assistantId = `assistant-${Date.now().toString(36)}`;
			emit({ type: "assistant_started", messageId: assistantId });
			const stream = client.stream(context, { signal });
			let thinkingText = "";
			let thinkingStart = 0;
			for await (const ev of stream) {
				if (ev.type === "text_delta" && ev.delta) {
					emit({ type: "assistant_delta", messageId: assistantId, delta: ev.delta });
				} else if (ev.type === "thinking_delta" && ev.delta) {
					if (!thinkingStart) thinkingStart = Date.now();
					thinkingText += ev.delta; // 思考内容随 assistant_completed 一次性携带（§6.10 折叠展示）
				}
			}
			const message = await stream.result();
			context.messages.push(message);
			const thinkingMs = thinkingStart ? Date.now() - thinkingStart : undefined;

			// 2) 失败/中止：终止本轮（请求级失败不抛异常，由 stopReason 携带）
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				emit({ type: "agent_error", message: message.errorMessage ?? "LLM request failed" });
				emit({ type: "turn_completed", turnId, stopReason: message.stopReason });
				return;
			}
			emit({
				type: "assistant_completed",
				messageId: assistantId,
				text: textOf(message),
				stopReason: message.stopReason,
				usage: usageOf(message.usage),
				thinking: thinkingText || undefined,
				thinkingMs,
			});

			// 3) 退出条件：没有工具需要执行 → 最终答案，退出 loop
			const toolCalls = message.content.filter(isToolCall);
			if (message.stopReason !== "toolUse" || toolCalls.length === 0) {
				emit({ type: "turn_completed", turnId, stopReason: message.stopReason });
				return;
			}

			// 4) 工具执行：权限/排队/锁/并发全部由 Scheduler 负责，Loop 只等最终结果
			const results = await scheduler.execute(toolCalls);
			context.messages.push(...results);
			// 继续 while：带着工具结果进入下一轮推理
		}
		emit({ type: "turn_completed", turnId, stopReason: "aborted" });
	} catch (err) {
		emit({ type: "agent_error", message: err instanceof Error ? err.message : String(err) });
		emit({ type: "turn_completed", turnId, stopReason: "error" });
	}
}
