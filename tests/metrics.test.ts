// 指标采集测试（§9.1）：缓存命中率、工具成功率、deny 计数隔离。
import assert from "node:assert/strict";
import { test } from "node:test";
import { MetricsCollector } from "../src/agent/metrics.ts";
import type { AgentEvent } from "../src/events.ts";

function feed(collector: MetricsCollector, events: AgentEvent[]): void {
	for (const e of events) collector.onEvent(e);
}

test("缓存命中率：按锚点公式（分母 = input+cacheRead+cacheWrite 三类之和）", () => {
	// 字段语义已实测验证（scripts/usage-probe.ts，MiniMax CN）：
	// input 完全不含缓存 token（探测三轮 input=0，输入 token 只进 cacheRead/cacheWrite），
	// 故三类之和恰好每个 token 计一次，公式成立。§9.1 示例 150/300 与锚点公式的 400 分母
	// 属原文算术笔误，以锚点公式为准。
	// 另：MiniMax 对紧接着的下一次请求可能整体重写缓存（cacheRead=0）而非命中，
	// 属 provider 行为，不影响本公式。
	const m = new MetricsCollector();
	feed(m, [
		{ type: "assistant_completed", messageId: "m1", text: "", stopReason: "stop", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 100 } },
		{ type: "assistant_completed", messageId: "m2", text: "", stopReason: "stop", usage: { input: 50, output: 10, cacheRead: 150, cacheWrite: 0 } },
	]);
	assert.equal(m.turns, 2);
	assert.equal(m.usage.input, 150);
	assert.equal(m.usage.cacheRead, 150);
	assert.equal(m.usage.cacheWrite, 100);
	assert.equal(m.cacheHitRate, 150 / 400);
});

test("空数据：命中率为 0、成功率为 1（避免 0/0）", () => {
	const m = new MetricsCollector();
	assert.equal(m.cacheHitRate, 0);
	assert.equal(m.toolSuccessRate, 1);
	assert.equal(m.turns, 0);
});

test("deny 计数隔离：拒绝不进失败分母（toolSuccessRate = 3/3，denied = 2）", () => {
	const m = new MetricsCollector();
	feed(m, [
		{ type: "tool_completed", callId: "1", toolName: "write", ok: true, durationMs: 1 },
		{ type: "tool_completed", callId: "2", toolName: "read", ok: true, durationMs: 1 },
		{ type: "tool_completed", callId: "3", toolName: "bash", ok: true, durationMs: 1 },
		{ type: "permission_resolved", requestId: "4", decision: "deny" },
		{ type: "permission_resolved", requestId: "5", decision: "deny" },
	]);
	assert.equal(m.tools.ok, 3);
	assert.equal(m.tools.failed, 0);
	assert.equal(m.tools.denied, 2);
	assert.equal(m.toolSuccessRate, 1);
});

test("失败计入成功率分母", () => {
	const m = new MetricsCollector();
	feed(m, [
		{ type: "tool_completed", callId: "1", toolName: "write", ok: true, durationMs: 1 },
		{ type: "tool_completed", callId: "2", toolName: "bash", ok: false, durationMs: 1, error: "x" },
	]);
	assert.equal(m.toolSuccessRate, 1 / 2);
});
