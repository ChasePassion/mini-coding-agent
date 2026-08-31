// 指标采集测试（§9.1）：缓存命中率、工具成功率、deny 计数隔离。
import assert from "node:assert/strict";
import { test } from "node:test";
import { MetricsCollector } from "../src/agent/metrics.ts";
import type { AgentEvent } from "../src/events.ts";

function feed(collector: MetricsCollector, events: AgentEvent[]): void {
	for (const e of events) collector.onEvent(e);
}

test("缓存命中率：按锚点公式（分母 = input+cacheRead+cacheWrite 三类之和）", () => {
	// 注：技术方案 §9.1 示例断言 150/300，但其 §6.7 锚点公式对同样数字给出 400 分母（两类输入
	// 计入方式不同）。锚点公式是唯一实现（getter 集中改动点），此处按公式断言 150/400；
	// 真实 MiniMax usage 字段语义（input 是否已含 cache token）待线上核对后统一调整。
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
