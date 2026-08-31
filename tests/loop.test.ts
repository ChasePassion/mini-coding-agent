// Agent Loop 测试（§9.1）：脚本化 fake streamFn，覆盖 多轮工具→停止 / 立即停止 / error / usage 与 thinking 透传 / abort（C20）。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Context, StopReason, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { LLMClient, LLMStream } from "../src/ai/client.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import type { AgentEvent } from "../src/events.ts";
import type { ToolOutput } from "../src/agent/tools/index.ts";
import { deferred, fakeTool, harness, waitFor } from "./helpers.ts";

let seq = 0;

function mkAssistant(opts: {
	text?: string;
	thinking?: string;
	toolCalls?: { name: string; args: Record<string, unknown> }[];
	stopReason: StopReason;
	errorMessage?: string;
	usage?: Usage;
}): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (opts.thinking) {
		content.push({ type: "thinking", text: opts.thinking } as AssistantMessage["content"][number]);
	}
	if (opts.text) content.push({ type: "text", text: opts.text });
	for (const tc of opts.toolCalls ?? []) {
		seq += 1;
		content.push({ type: "toolCall", id: `tc-${seq}`, name: tc.name, arguments: tc.args } satisfies ToolCall);
	}
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "minimax-cn",
		model: "test-model",
		usage: opts.usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: opts.stopReason,
		errorMessage: opts.errorMessage,
	};
}

function fakeClient(script: AssistantMessage[]): LLMClient {
	let i = 0;
	return {
		model: undefined as never,
		stream: (_context: Context): LLMStream => {
			const msg = script[i++];
			if (!msg) throw new Error("test script exhausted");
			async function* iterate() {
				for (const block of msg.content) {
					if (block.type === "thinking") yield { type: "thinking_delta", delta: (block as { text: string }).text };
					else if (block.type === "text") yield { type: "text_delta", delta: block.text };
				}
			}
			return {
				[Symbol.asyncIterator]: iterate,
				result: async () => msg,
			};
		},
	};
}

function mkContext(): Context {
	return {
		systemPrompt: "test",
		messages: [{ role: "user", content: "go", timestamp: Date.now() }],
		tools: [],
	};
}

test("多轮：toolUse→toolUse→stop，消息与事件序列正确", async () => {
	const reads = fakeTool("read", "read", { immediate: { isError: false, text: "content" } });
	const writes = fakeTool("write", "write", { immediate: { isError: false, text: "wrote" } });
	const h = harness([reads.tool, writes.tool]);
	const events: AgentEvent[] = [];
	const context = mkContext();
	const client = fakeClient([
		mkAssistant({ text: "先看看", toolCalls: [{ name: "read", args: { path: "a.py" } }], stopReason: "toolUse" }),
		mkAssistant({ text: "再写", toolCalls: [{ name: "write", args: { path: "a.py", content: "x" } }], stopReason: "toolUse" }),
		mkAssistant({ text: "完成", stopReason: "stop" }),
	]);
	await runAgentLoop(context, { client, scheduler: h.scheduler, emit: (e) => events.push(e) });
	// user + 3 assistant + 2 toolResult
	assert.equal(context.messages.length, 6);
	const toolResults = context.messages.filter((m) => m.role === "toolResult");
	assert.equal(toolResults.length, 2);
	assert.ok(toolResults.every((m) => !m.isError));
	assert.equal(events.filter((e) => e.type === "assistant_completed").length, 3);
	const last = events.at(-1);
	assert.ok(last && last.type === "turn_completed" && last.stopReason === "stop");
});

test("立即停止：无工具一轮即退", async () => {
	const h = harness([]);
	const events: AgentEvent[] = [];
	await runAgentLoop(mkContext(), {
		client: fakeClient([mkAssistant({ text: "hi", stopReason: "stop" })]),
		scheduler: h.scheduler,
		emit: (e) => events.push(e),
	});
	assert.equal(events.filter((e) => e.type === "tool_queued").length, 0);
	assert.equal(events.at(-1)?.type, "turn_completed");
});

test("error：agent_error + turn_completed(error)", async () => {
	const h = harness([]);
	const events: AgentEvent[] = [];
	await runAgentLoop(mkContext(), {
		client: fakeClient([mkAssistant({ text: "", stopReason: "error", errorMessage: "boom" })]),
		scheduler: h.scheduler,
		emit: (e) => events.push(e),
	});
	assert.ok(events.some((e) => e.type === "agent_error" && e.message === "boom"));
	const last = events.at(-1);
	assert.ok(last?.type === "turn_completed" && last.stopReason === "error");
});

test("usage 与 thinking 随 assistant_completed 透传", async () => {
	const h = harness([]);
	const events: AgentEvent[] = [];
	await runAgentLoop(mkContext(), {
		client: fakeClient([
			mkAssistant({
				text: "答案",
				thinking: "让我想想",
				stopReason: "stop",
				usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 100 },
			}),
		]),
		scheduler: h.scheduler,
		emit: (e) => events.push(e),
	});
	const completed = events.find((e) => e.type === "assistant_completed");
	assert.ok(completed?.type === "assistant_completed");
	assert.deepEqual(completed.usage, { input: 100, output: 5, cacheRead: 0, cacheWrite: 100 });
	assert.equal(completed.thinking, "让我想想");
	assert.ok(typeof completed.thinkingMs === "number");
});

test("C20: abort 不漏锁（工具对 signal reject → finally 释放锁 → 后续 read 立即执行 + turn_completed）", async () => {
	const writes = fakeTool("write", "write", { signalAware: true });
	const reads = fakeTool("read", "read");
	const h = harness([writes.tool, reads.tool]);
	const events: AgentEvent[] = [];
	const context = mkContext();
	const client = fakeClient([
		mkAssistant({ toolCalls: [{ name: "write", args: { path: "a.py", content: "x" } }], stopReason: "toolUse" }),
	]);
	const loopDone = runAgentLoop(context, {
		client,
		scheduler: h.scheduler,
		emit: (e) => events.push(e),
		signal: h.controller.signal,
	});
	await waitFor(() => writes.gates.length === 1); // write 已在执行并持有 a.py 独占锁
	h.controller.abort(); // signalAware 假工具 reject
	await loopDone;
	const last = events.at(-1);
	assert.ok(last?.type === "turn_completed", "loop ends with turn_completed");
	// 锁已释放：新的 read a.py 应立即获得执行
	const p = h.scheduler.execute([{ type: "toolCall", id: "after-abort", name: "read", arguments: { path: "a.py" } }]);
	await waitFor(() => reads.gates.length === 1, 500);
	reads.gates[0].resolve({ isError: false, text: "ok" } satisfies ToolOutput);
	const results = await p;
	assert.ok(!results[0].isError);
});
