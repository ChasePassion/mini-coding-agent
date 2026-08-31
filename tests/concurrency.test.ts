// 并发控制全场景矩阵（技术方案 §9.1，对应设计方案 §16 并发规则总表逐格 + 竞态路径）。
// 每个用例结尾断言事件序列；所有等待都用 waitFor 断言中间态，不依赖时序运气。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionDecision } from "../src/events.ts";
import { type ToolOutput } from "../src/agent/tools/index.ts";
import {
	allowOnce,
	completedIdx,
	deferred,
	fakeTool,
	harness,
	permissionScript,
	sleep,
	startedIdx,
	toolCall,
	waitFor,
	WORKSPACE,
} from "./helpers.ts";

const OUT: ToolOutput = { isError: false, text: "ok" };

test("C1: 同文件读并行（read A ×3 同时发，真并行无串行化）", async () => {
	const reads = fakeTool("read", "read");
	const h = harness([reads.tool]);
	const calls = [toolCall("read", { path: "a.py" }), toolCall("read", { path: "a.py" }), toolCall("read", { path: "a.py" })];
	const done = h.scheduler.execute(calls);
	await waitFor(() => reads.gates.length === 3);
	// 三个都已 started 且都未 completed（共享锁同时持有）
	for (const c of calls) {
		assert.ok(startedIdx(h, c.id) >= 0, `${c.id} should be started`);
		assert.equal(completedIdx(h, c.id), -1);
	}
	for (const g of reads.gates) g.resolve(OUT);
	const results = await done;
	assert.equal(results.length, 3);
	assert.ok(results.every((r) => !r.isError));
});

test("C2: 读后写等待（read A 挂起 + write A → write 无 started；read 完成后 write 才执行）", async () => {
	const reads = fakeTool("read", "read");
	const writes = fakeTool("write", "write");
	const h = harness([reads.tool, writes.tool]);
	const rc = toolCall("read", { path: "a.py" });
	const wc = toolCall("write", { path: "a.py", content: "x" });
	const done = h.scheduler.execute([rc, wc]);
	await waitFor(() => reads.gates.length === 1);
	assert.equal(writes.gates.length, 0, "write must wait while read holds the file");
	reads.gates[0].resolve(OUT);
	await waitFor(() => writes.gates.length === 1);
	writes.gates[0].resolve(OUT);
	const results = await done;
	assert.ok(!results[1].isError);
	assert.ok(completedIdx(h, rc.id) < startedIdx(h, wc.id), "read completes before write starts");
});

test("C3: 写后读等待（write A 持锁挂起后，read A 排队）", async () => {
	const reads = fakeTool("read", "read");
	const writes = fakeTool("write", "write");
	const h = harness([reads.tool, writes.tool]);
	const wc = toolCall("write", { path: "a.py", content: "x" });
	const p1 = h.scheduler.execute([wc]);
	await waitFor(() => writes.gates.length === 1); // write 已持有 a.py 独占锁并挂起
	const rc = toolCall("read", { path: "a.py" });
	const p2 = h.scheduler.execute([rc]);
	await sleep(20);
	assert.equal(reads.gates.length, 0);
	writes.gates[0].resolve(OUT);
	await waitFor(() => reads.gates.length === 1);
	reads.gates[0].resolve(OUT);
	await Promise.all([p1, p2]);
	assert.ok(completedIdx(h, wc.id) < startedIdx(h, rc.id));
});

test("C4: 同文件写互斥（write A ×2 串行完成）", async () => {
	const writes = fakeTool("write", "write");
	const h = harness([writes.tool]);
	const w1 = toolCall("write", { path: "a.py", content: "1" });
	const w2 = toolCall("write", { path: "a.py", content: "2" });
	const done = h.scheduler.execute([w1, w2]);
	await waitFor(() => writes.gates.length === 1);
	assert.equal(writes.gates.length, 1, "second write must wait");
	writes.gates[0].resolve(OUT);
	await waitFor(() => writes.gates.length === 2);
	writes.gates[1].resolve(OUT);
	await done;
	assert.ok(completedIdx(h, w1.id) < startedIdx(h, w2.id));
});

test("C5: 异文件互不阻塞（write A 挂起 + read B + write B + list 立即并行）", async () => {
	const reads = fakeTool("read", "read");
	const writes = fakeTool("write", "write");
	const lists = fakeTool("list", "list");
	const h = harness([reads.tool, writes.tool, lists.tool]);
	const wa = toolCall("write", { path: "a.py", content: "x" });
	const rb = toolCall("read", { path: "b.py" });
	const wb = toolCall("write", { path: "b.py", content: "x" });
	const ls = toolCall("list", { path: "." });
	const done = h.scheduler.execute([wa, rb, wb, ls]);
	await waitFor(() => writes.gates.length === 1 && reads.gates.length === 1 && lists.gates.length === 1);
	// write A 独占 a.py，但 b.py 的读/写与 list 均已启动（write B 为 writes.gates[0]）
	writes.gates[0].resolve(OUT);
	reads.gates[0].resolve(OUT);
	lists.gates[0].resolve(OUT);
	await waitFor(() => writes.gates.length === 2);
	writes.gates[1].resolve(OUT);
	const results = await done;
	assert.ok(results.every((r) => !r.isError));
});

test("C6: 异文件读写并行（read A 挂起 + write B 立即执行）", async () => {
	const reads = fakeTool("read", "read");
	const writes = fakeTool("write", "write");
	const h = harness([reads.tool, writes.tool]);
	const done = h.scheduler.execute([
		toolCall("read", { path: "a.py" }),
		toolCall("write", { path: "b.py", content: "x" }),
	]);
	await waitFor(() => reads.gates.length === 1 && writes.gates.length === 1);
	reads.gates[0].resolve(OUT);
	writes.gates[0].resolve(OUT);
	await done;
});

test("C7: bash×bash 串行（第二条等待第一条完成）", async () => {
	const bashes = fakeTool("bash", "bash");
	const h = harness([bashes.tool], allowOnce);
	const b1 = toolCall("bash", { command: "npm test" });
	const b2 = toolCall("bash", { command: "npm run build" });
	const done = h.scheduler.execute([b1, b2]);
	await waitFor(() => bashes.gates.length === 1);
	await sleep(30);
	assert.equal(bashes.gates.length, 1, "second bash must wait");
	bashes.gates[0].resolve(OUT);
	await waitFor(() => bashes.gates.length === 2);
	bashes.gates[1].resolve(OUT);
	await done;
	assert.ok(completedIdx(h, b1.id) < startedIdx(h, b2.id));
});

test("C8: bash 排斥读（bash 独占执行期间 read 排队）", async () => {
	const bashes = fakeTool("bash", "bash");
	const reads = fakeTool("read", "read");
	const h = harness([bashes.tool, reads.tool]);
	const bc = toolCall("bash", { command: "npm test" });
	const p1 = h.scheduler.execute([bc]);
	await waitFor(() => bashes.gates.length === 1); // bash 已独占执行
	const rc = toolCall("read", { path: "a.py" });
	const p2 = h.scheduler.execute([rc]);
	await sleep(20);
	assert.equal(reads.gates.length, 0);
	bashes.gates[0].resolve(OUT);
	await waitFor(() => reads.gates.length === 1);
	reads.gates[0].resolve(OUT);
	await Promise.all([p1, p2]);
	assert.ok(completedIdx(h, bc.id) < startedIdx(h, rc.id));
});

test("C9: bash 排斥写与 list（二者全部排队）", async () => {
	const bashes = fakeTool("bash", "bash");
	const writes = fakeTool("write", "write");
	const lists = fakeTool("list", "list");
	const h = harness([bashes.tool, writes.tool, lists.tool]);
	const bc = toolCall("bash", { command: "npm test" });
	const p1 = h.scheduler.execute([bc]);
	await waitFor(() => bashes.gates.length === 1);
	const p2 = h.scheduler.execute([
		toolCall("write", { path: "b.py", content: "x" }),
		toolCall("list", { path: "." }),
	]);
	await sleep(20);
	assert.equal(writes.gates.length, 0);
	assert.equal(lists.gates.length, 0);
	bashes.gates[0].resolve(OUT);
	await waitFor(() => writes.gates.length === 1 && lists.gates.length === 1);
	writes.gates[0].resolve(OUT);
	lists.gates[0].resolve(OUT);
	await Promise.all([p1, p2]);
});

test("C10: 读排斥 bash（read A 挂起时 bash 排队至 read 完成）", async () => {
	const reads = fakeTool("read", "read");
	const bashes = fakeTool("bash", "bash");
	const h = harness([reads.tool, bashes.tool]);
	const rc = toolCall("read", { path: "a.py" });
	const bc = toolCall("bash", { command: "npm test" });
	const done = h.scheduler.execute([rc, bc]);
	await waitFor(() => reads.gates.length === 1);
	assert.equal(bashes.gates.length, 0);
	reads.gates[0].resolve(OUT);
	await waitFor(() => bashes.gates.length === 1);
	bashes.gates[0].resolve(OUT);
	await done;
	assert.ok(completedIdx(h, rc.id) < startedIdx(h, bc.id));
});

test("C11: 忙时 bash 不弹窗（read 完成前无 permission_required，完成后才预约并询问）", async () => {
	const reads = fakeTool("read", "read");
	const bashes = fakeTool("bash", "bash");
	const h = harness([reads.tool, bashes.tool], permissionScript(() => "allow_once"));
	const done = h.scheduler.execute([
		toolCall("read", { path: "a.py" }),
		toolCall("bash", { command: "npm test" }),
	]);
	await waitFor(() => reads.gates.length === 1);
	await sleep(30);
	assert.equal(h.permissions.calls.length, 0, "must not ask for bash permission while tools are in flight");
	reads.gates[0].resolve(OUT);
	await waitFor(() => h.permissions.calls.length === 1);
	await waitFor(() => bashes.gates.length === 1);
	bashes.gates[0].resolve(OUT);
	const results = await done;
	assert.ok(results.every((r) => !r.isError));
});

test("C12: 预约挡新工具（bash 等待批准期间新 read 保持排队）", async () => {
	const bashes = fakeTool("bash", "bash");
	const reads = fakeTool("read", "read");
	const decision = deferred<PermissionDecision>();
	const h = harness([bashes.tool, reads.tool], permissionScript(() => decision.promise));
	const p1 = h.scheduler.execute([toolCall("bash", { command: "npm test" })]);
	await waitFor(() => h.permissions.calls.length === 1); // bash 已预约并询问
	const p2 = h.scheduler.execute([toolCall("read", { path: "b.py" })]);
	await sleep(30);
	assert.equal(reads.gates.length, 0, "new read must not overtake the bash reservation");
	decision.resolve("allow_once");
	await waitFor(() => bashes.gates.length === 1);
	assert.equal(reads.gates.length, 0, "read still queued while bash runs exclusively");
	bashes.gates[0].resolve(OUT);
	await waitFor(() => reads.gates.length === 1);
	reads.gates[0].resolve(OUT);
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.ok(!r1[0].isError && !r2[0].isError);
});

test("C13: Deny 立即释放预约（bash 无 started，read 立即执行，bash 收到 denied 结果）", async () => {
	const bashes = fakeTool("bash", "bash");
	const reads = fakeTool("read", "read");
	const decision = deferred<PermissionDecision>();
	const h = harness([bashes.tool, reads.tool], permissionScript(() => decision.promise));
	const bc = toolCall("bash", { command: "npm test" });
	const p1 = h.scheduler.execute([bc]);
	await waitFor(() => h.permissions.calls.length === 1);
	const p2 = h.scheduler.execute([toolCall("read", { path: "b.py" })]);
	await sleep(20);
	assert.equal(reads.gates.length, 0);
	decision.resolve("deny");
	await waitFor(() => reads.gates.length === 1); // Deny 立即归还执行资格
	assert.equal(bashes.gates.length, 0, "denied bash never starts");
	reads.gates[0].resolve(OUT);
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.ok(r1[0].isError, "bash result is an error");
	assert.match(r1[0].content[0].type === "text" ? r1[0].content[0].text : "", /denied/i);
	assert.ok(!r2[0].isError);
});

test("C14: bash 会话授权（allow_session 后第二次不再询问）", async () => {
	const bashes = fakeTool("bash", "bash");
	let asked = 0;
	const h = harness([bashes.tool], permissionScript(() => (++asked === 1 ? "allow_session" : "deny")));
	const p1 = h.scheduler.execute([toolCall("bash", { command: "a" })]);
	await waitFor(() => bashes.gates.length === 1);
	bashes.gates[0].resolve(OUT);
	await p1;
	const p2 = h.scheduler.execute([toolCall("bash", { command: "b" })]);
	await waitFor(() => bashes.gates.length === 2);
	bashes.gates[1].resolve(OUT);
	const r2 = await p2;
	assert.equal(h.permissions.calls.length, 1, "second bash must not re-ask");
	assert.ok(!r2[0].isError);
});

test("C15: write 会话授权（同理）", async () => {
	const writes = fakeTool("write", "write");
	let asked = 0;
	const h = harness([writes.tool], permissionScript(() => (++asked === 1 ? "allow_session" : "deny")));
	const p1 = h.scheduler.execute([toolCall("write", { path: "a.py", content: "1" })]);
	await waitFor(() => writes.gates.length === 1);
	writes.gates[0].resolve(OUT);
	await p1;
	const p2 = h.scheduler.execute([toolCall("write", { path: "a.py", content: "2" })]);
	await waitFor(() => writes.gates.length === 2);
	writes.gates[1].resolve(OUT);
	const r2 = await p2;
	assert.equal(h.permissions.calls.length, 1);
	assert.ok(!r2[0].isError);
});

test("C16: FIFO 读批量放行（write 完成后两个 read 同时 started）", async () => {
	const reads = fakeTool("read", "read");
	const writes = fakeTool("write", "write");
	const h = harness([reads.tool, writes.tool]);
	const r1 = toolCall("read", { path: "a.py" });
	const p1 = h.scheduler.execute([r1]);
	await waitFor(() => reads.gates.length === 1); // read1 持共享锁挂起
	const wc = toolCall("write", { path: "a.py", content: "x" });
	const p2 = h.scheduler.execute([wc]);
	// 等 write 过完权限并真正排入文件锁等待队列
	await waitFor(() => h.events.some((e) => e.type === "permission_resolved" && e.requestId === wc.id));
	await sleep(10);
	const p3 = h.scheduler.execute([
		toolCall("read", { path: "a.py" }),
		toolCall("read", { path: "a.py" }),
	]);
	await sleep(20);
	assert.equal(reads.gates.length, 1, "后续 read 排在 FIFO 队首 write 之后");
	reads.gates[0].resolve(OUT);
	await waitFor(() => writes.gates.length === 1);
	assert.equal(reads.gates.length, 1, "write 执行期间 read 仍排队");
	writes.gates[0].resolve(OUT);
	await waitFor(() => reads.gates.length === 3); // 批量放行：两个 read 同时启动
	reads.gates[1].resolve(OUT);
	reads.gates[2].resolve(OUT);
	const results = await Promise.all([p1, p2, p3]);
	assert.ok(results.every((rs) => rs.every((r) => !r.isError)));
});

test("C17: 写防饥饿（排队 write 之后的新 read 不得插队）", async () => {
	const reads = fakeTool("read", "read");
	const writes = fakeTool("write", "write");
	const h = harness([reads.tool, writes.tool]);
	const r1 = toolCall("read", { path: "a.py" });
	const r2 = toolCall("read", { path: "a.py" });
	const p1 = h.scheduler.execute([r1, r2]);
	await waitFor(() => reads.gates.length === 2); // 两个读并行持锁
	const wc = toolCall("write", { path: "a.py", content: "x" });
	const p2 = h.scheduler.execute([wc]);
	await waitFor(() => h.events.some((e) => e.type === "permission_resolved" && e.requestId === wc.id));
	await sleep(10); // write 已在文件锁队列
	const r3 = toolCall("read", { path: "a.py" });
	const p3 = h.scheduler.execute([r3]);
	await sleep(20);
	assert.equal(reads.gates.length, 2, "新 read 不得越过排队的 write");
	reads.gates[0].resolve(OUT);
	reads.gates[1].resolve(OUT);
	await waitFor(() => writes.gates.length === 1);
	assert.equal(reads.gates.length, 2, "write 获得锁前 read 仍等待");
	writes.gates[0].resolve(OUT);
	await waitFor(() => reads.gates.length === 3);
	reads.gates[2].resolve(OUT);
	await Promise.all([p1, p2, p3]);
	assert.ok(completedIdx(h, wc.id) < startedIdx(h, r3.id));
});

test("C18: 锁键归一化（./a.py 与 a.py 是同一把锁）", async () => {
	const reads = fakeTool("read", "read");
	const writes = fakeTool("write", "write");
	const h = harness([reads.tool, writes.tool]);
	const rc = toolCall("read", { path: "./a.py" });
	const wc = toolCall("write", { path: "a.py", content: "x" });
	const done = h.scheduler.execute([rc, wc]);
	await waitFor(() => reads.gates.length === 1);
	await sleep(20);
	assert.equal(writes.gates.length, 0, "same resolved key → write waits");
	reads.gates[0].resolve(OUT);
	await waitFor(() => writes.gates.length === 1);
	writes.gates[0].resolve(OUT);
	await done;
});

test("C19: 工具抛错不漏锁（write reject 后 read 立即可执行）", async () => {
	const writes = fakeTool("write", "write");
	const reads = fakeTool("read", "read");
	const h = harness([writes.tool, reads.tool]);
	const wc = toolCall("write", { path: "a.py", content: "x" });
	const p1 = h.scheduler.execute([wc]);
	await waitFor(() => writes.gates.length === 1);
	writes.gates[0].reject(new Error("disk on fire"));
	const r1 = await p1;
	assert.ok(r1[0].isError);
	assert.ok(h.events.some((e) => e.type === "tool_completed" && e.callId === wc.id && !e.ok));
	const rc = toolCall("read", { path: "a.py" });
	const p2 = h.scheduler.execute([rc]);
	await waitFor(() => reads.gates.length === 1, 500); // 锁已释放，立即获得
	reads.gates[0].resolve(OUT);
	const r2 = await p2;
	assert.ok(!r2[0].isError);
});

test("C21: ask_user 与读并行（ask 挂起等答案时 read B 立即执行）", async () => {
	const asks = fakeTool("ask_user", "ask");
	const reads = fakeTool("read", "read");
	const h = harness([asks.tool, reads.tool]);
	const ac = toolCall("ask_user", { question: "Which language?" });
	const rc = toolCall("read", { path: "b.py" });
	const done = h.scheduler.execute([ac, rc]);
	await waitFor(() => asks.gates.length === 1 && reads.gates.length === 1);
	reads.gates[0].resolve(OUT);
	await waitFor(() => completedIdx(h, rc.id) >= 0);
	assert.equal(completedIdx(h, ac.id), -1, "ask_user still waiting for the human");
	asks.gates[0].resolve({ isError: false, text: "User answered: Python" });
	const results = await done;
	assert.ok(!results[0].isError);
});

test("参数防御性校验：非法参数 → 干净的 isError 结果而非异常", async () => {
	const { createReadTool } = await import("../src/agent/tools/read.ts");
	const real = createReadTool({ workspace: WORKSPACE, getMode: () => "default" });
	const h = harness([real]);
	const r1 = await h.scheduler.execute([toolCall("read", { offset: 0 })]); // 违反 minimum:1
	assert.ok(r1[0].isError);
	assert.match(r1[0].content[0].type === "text" ? r1[0].content[0].text : "", /invalid/i);
	const r2 = await h.scheduler.execute([toolCall("read", {})]); // 缺必填 path
	assert.ok(r2[0].isError);
});

// C20（abort 不漏锁 + turn_completed）在 loop.test.ts 中以 signalAware 假工具覆盖
