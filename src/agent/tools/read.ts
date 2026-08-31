import { readFile } from "node:fs/promises";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, ToolEnv, ToolExecContext, ToolOutput } from "./index.ts";
import { resolveWorkspacePath } from "./index.ts";

export const ReadArgs = Type.Object({
	path: Type.String({
		description: "File path, relative to workspace (absolute allowed only in Full Access mode)",
	}),
	offset: Type.Optional(
		Type.Integer({ minimum: 1, default: 1, description: "1-based start line" }),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 2000, default: 500, description: "Max lines to return" }),
	),
});
export type ReadArgs = Static<typeof ReadArgs>;

const TOKEN_CAP = 10_000;

// CJK 加权估算：汉字/假名/谚文 ≈ 1.5 token/字，其余 ≈ 4 字符/token
export function estimateTokens(s: string): number {
	let cjk = 0;
	for (const ch of s) {
		if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) cjk++;
	}
	return Math.ceil(cjk * 1.5) + Math.ceil((s.length - cjk) / 4);
}

export function createReadTool(env: ToolEnv): AgentTool {
	return {
		name: "read",
		kind: "read",
		description:
			"Read a text file and return numbered lines. Pagination: pass `offset` (1-based start line) and `limit` (max lines). The response is capped at ~10k tokens; when truncated you get a notice with the next offset — call read again with that offset to continue. Concurrency: reads never require user approval; multiple reads, even of the same file, run in parallel; reads queue while a bash command is running.",
		parameters: ReadArgs,
		describe: (a) => `read ${String(a.path ?? "")}`,
		async execute(args: Record<string, unknown>, _ctx: ToolExecContext): Promise<ToolOutput> {
			const a = args as unknown as ReadArgs;
			const boundary = resolveWorkspacePath(env, a.path);
			if (!boundary.ok) return { isError: true, text: boundary.error };

			let content: string;
			try {
				content = await readFile(boundary.abs, "utf8");
			} catch (err) {
				return { isError: true, text: `read failed: ${err instanceof Error ? err.message : String(err)}` };
			}
			if (content.includes("\0")) {
				return { isError: true, text: `read failed: not a text file (contains NUL byte): ${a.path}` };
			}

			const lines = content.split("\n");
			const total = lines.length;
			if (total === 0) return { isError: false, text: "(empty file)" };

			const start = a.offset ?? 1;
			if (start > total) {
				return { isError: true, text: `offset ${start} is beyond the end of file (${total} lines).` };
			}
			const maxLines = a.limit ?? 500;

			// 逐行累加到 token 预算用尽（行边界截断，保证至少返回一行）
			const out: string[] = [];
			let tokens = 0;
			let last = start;
			for (let i = start - 1; i < total && out.length < maxLines; i++) {
				const line = `${i + 1}: ${lines[i]}`;
				tokens += estimateTokens(line);
				out.push(line);
				last = i + 1;
				if (tokens >= TOKEN_CAP) break;
			}

			let text = out.join("\n");
			if (last < total) {
				text += `\n[Truncated] Showing lines ${start}-${last} of ${total} (~${tokens} tokens, cap ${TOKEN_CAP}). Call read(path, offset=${last + 1}) to continue.`;
			}
			return { isError: false, text };
		},
	};
}
