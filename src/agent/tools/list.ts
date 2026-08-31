import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, ToolEnv, ToolExecContext, ToolOutput } from "./index.ts";
import { resolveWorkspacePath } from "./index.ts";

export const ListArgs = Type.Object({
	path: Type.Optional(
		Type.String({ default: ".", description: "Directory path, relative to workspace (default '.')" }),
	),
});
export type ListArgs = Static<typeof ListArgs>;

const MAX_ENTRIES = 500;

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function createListTool(env: ToolEnv): AgentTool {
	return {
		name: "list",
		kind: "list",
		description:
			"List a directory's entries with name/type/size. Read-only. Concurrency: runs in parallel with other reads/writes/lists and never needs approval; only queues while bash is executing.",
		parameters: ListArgs,
		describe: (a) => `list ${String(a.path ?? ".")}`,
		async execute(args: Record<string, unknown>, _ctx: ToolExecContext): Promise<ToolOutput> {
			const a = args as unknown as ListArgs;
			const boundary = resolveWorkspacePath(env, a.path ?? ".");
			if (!boundary.ok) return { isError: true, text: boundary.error };

			let entries;
			try {
				entries = await readdir(boundary.abs, { withFileTypes: true });
			} catch (err) {
				return { isError: true, text: `list failed: ${err instanceof Error ? err.message : String(err)}` };
			}

			entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
			const rows: string[] = [];
			for (const entry of entries.slice(0, MAX_ENTRIES)) {
				if (entry.isDirectory()) {
					rows.push(`${entry.name}/  <dir>`);
					continue;
				}
				try {
					const st = await lstat(`${boundary.abs}${path.sep}${entry.name}`);
					rows.push(`${entry.name}  ${formatSize(st.size)}`);
				} catch {
					rows.push(entry.name);
				}
			}
			let text = rows.length > 0 ? rows.join("\n") : "(empty directory)";
			if (entries.length > MAX_ENTRIES) {
				text += `\n[Truncated] Showing ${MAX_ENTRIES} of ${entries.length} entries.`;
			}
			return { isError: false, text };
		},
	};
}
