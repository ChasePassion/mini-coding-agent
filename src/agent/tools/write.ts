import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, ToolEnv, ToolExecContext, ToolOutput } from "./index.ts";
import { resolveWorkspacePath } from "./index.ts";

export const WriteArgs = Type.Object({
	path: Type.String({
		description: "File path, relative to workspace (absolute allowed only in Full Access mode)",
	}),
	content: Type.String({
		description: "Full file content to write (creates or overwrites the file)",
	}),
});
export type WriteArgs = Static<typeof WriteArgs>;

export function createWriteTool(env: ToolEnv): AgentTool {
	return {
		name: "write",
		kind: "write",
		description:
			"Create or overwrite a file (parent directories are created automatically). Concurrency: exclusive per file — a write waits until all in-flight reads/writes of the same file finish; writes to different files run in parallel. Never runs while a bash command executes (bash is globally exclusive). In Default mode every write needs user approval (Allow Once / Allow for Session / Deny); approval is requested before any lock is taken, so an unanswered dialog never blocks other files.",
		parameters: WriteArgs,
		describe: (a) => `write ${String(a.path ?? "")}`,
		async execute(args: Record<string, unknown>, _ctx: ToolExecContext): Promise<ToolOutput> {
			const a = args as unknown as WriteArgs;
			const boundary = resolveWorkspacePath(env, a.path);
			if (!boundary.ok) return { isError: true, text: boundary.error };

			try {
				await mkdir(path.dirname(boundary.abs), { recursive: true });
				await writeFile(boundary.abs, a.content, "utf8");
			} catch (err) {
				return { isError: true, text: `write failed: ${err instanceof Error ? err.message : String(err)}` };
			}
			const lineCount = a.content.split("\n").length;
			const bytes = Buffer.byteLength(a.content, "utf8");
			return { isError: false, text: `Wrote ${lineCount} lines (${bytes} bytes) to ${a.path}.` };
		},
	};
}
