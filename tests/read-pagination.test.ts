// read 分页与 Workspace 边界测试（§9.1）：offset/limit 边界、token 截断续读、CJK 估算、二进制、越界。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createReadTool, estimateTokens } from "../src/agent/tools/read.ts";
import type { RunMode } from "../src/events.ts";

let workspace = "";
before(() => {
	workspace = mkdtempSync(path.join(tmpdir(), "mca-read-"));
});
after(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function makeRead(mode: RunMode = "default") {
	const modeState = { value: mode };
	return createReadTool({ workspace, getMode: () => modeState.value });
}

test("estimateTokens：CJK / ASCII / 混合三例", () => {
	assert.equal(estimateTokens("四个汉字"), Math.ceil(4 * 1.5)); // 6
	assert.equal(estimateTokens("abcdefgh"), Math.ceil(8 / 4)); // 2
	assert.equal(estimateTokens("ab汉字"), Math.ceil(2 * 1.5) + Math.ceil(2 / 4)); // 3 + 1 = 4
});

test("offset/limit 窗口读取（带行号）", async () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
	await writeFile(path.join(workspace, "win.txt"), lines.join("\n"));
	const read = makeRead();
	const out = await read.execute({ path: "win.txt", offset: 10, limit: 5 }, {});
	assert.ok(!out.isError);
	const got = out.text.split("\n");
	assert.equal(got.length, 6); // 5 行内容 + 续读提示（未读完全文时始终给出）
	assert.equal(got[0], "10: line-10");
	assert.equal(got[4], "14: line-14");
	assert.match(got[5] ?? "", /\[Truncated\] Showing lines 10-14 of 100 .*offset=15\) to continue\./);
});

test("offset 超出文件末尾 → isError 且有提示", async () => {
	await writeFile(path.join(workspace, "small.txt"), "a\nb\nc\n");
	const read = makeRead();
	const out = await read.execute({ path: "small.txt", offset: 99 }, {});
	assert.ok(out.isError);
	assert.match(out.text, /beyond the end of file/);
});

test("超过 10k token 在行边界截断，尾部给出续读 offset", async () => {
	// 30 行 × 1000 个汉字 ≈ 1500 token/行 → 约 7 行触顶
	const bigLine = "汉".repeat(1000);
	await writeFile(path.join(workspace, "big.txt"), Array.from({ length: 30 }, () => bigLine).join("\n"));
	const read = makeRead();
	const out = await read.execute({ path: "big.txt" }, {});
	assert.ok(!out.isError);
	const notice = out.text.split("\n").at(-1) ?? "";
	assert.match(notice, /\[Truncated\] Showing lines 1-(\d+) of 30/);
	const next = Number(notice.match(/offset=(\d+)/)?.[1] ?? 0);
	assert.ok(next > 1 && next <= 30, `next offset should be within (1, 30], got ${next}`);
	// 续读从 next 开始仍然可读
	const out2 = await read.execute({ path: "big.txt", offset: next }, {});
	assert.ok(!out2.isError);
	assert.match(out2.text, new RegExp(`^${next}: `));
});

test("limit 与 token cap 双重生效（limit 更小者获胜）", async () => {
	const bigLine = "汉".repeat(1000);
	await writeFile(path.join(workspace, "cap.txt"), Array.from({ length: 30 }, () => bigLine).join("\n"));
	const read = makeRead();
	const out = await read.execute({ path: "cap.txt", limit: 3 }, {});
	assert.ok(!out.isError);
	const got = out.text.split("\n");
	assert.equal(got.length, 4); // 3 行 + 截断提示（last < total 依然给出续读 offset）
	assert.match(got.at(-1) ?? "", /\[Truncated\] Showing lines 1-3 of 30 .*offset=4\) to continue\./);
});

test("二进制文件（含 NUL）→ isError", async () => {
	await writeFile(path.join(workspace, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
	const read = makeRead();
	const out = await read.execute({ path: "bin.dat" }, {});
	assert.ok(out.isError);
	assert.match(out.text, /NUL/);
});

test("Workspace 边界：Default 拒绝越界，Full Access 放行", async () => {
	// 在 workspace 外放一个文件
	const outside = path.join(tmpdir(), "mca-outside.txt");
	await writeFile(outside, "outside");
	const denied = makeRead("default");
	const out1 = await denied.execute({ path: path.join("..", "mca-outside.txt") }, {});
	assert.ok(out1.isError);
	assert.match(out1.text, /escapes the workspace/);

	const full = makeRead("full_access");
	const out2 = await full.execute({ path: outside }, {});
	assert.ok(!out2.isError);
	assert.match(out2.text, /outside/);
});
