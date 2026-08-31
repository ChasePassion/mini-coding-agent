import path from "node:path";
import type { TSchema, Tool } from "@earendil-works/pi-ai";
import type { RunMode } from "../../events.ts";

export type ToolKind = "read" | "write" | "list" | "bash" | "ask";

export interface ToolExecContext {
	signal?: AbortSignal;
}

export interface ToolOutput {
	isError: boolean;
	text: string;
}

/** Agent 工具：TypeBox schema + 并发语义 kind + 执行体。Scheduler 只依赖此接口。 */
export interface AgentTool {
	name: string;
	kind: ToolKind;
	description: string;
	parameters: TSchema;
	/** 权限弹窗里的一行摘要 */
	describe(args: Record<string, unknown>): string;
	execute(args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolOutput>;
}

/** 工具运行环境：Workspace 与当前模式（Default 硬边界 / Full Access 解除） */
export interface ToolEnv {
	workspace: string;
	getMode(): RunMode;
}

/**
 * Workspace 边界（设计方案 §3.1）：read/write/list 为硬边界（resolve + 前缀检查），
 * Full Access 模式解除。路径归一化防止 `./a.py`、`a.py`、`..\x` 绕过。
 */
export function resolveWorkspacePath(env: ToolEnv, target: string): { ok: true; abs: string } | { ok: false; error: string } {
	const abs = path.resolve(env.workspace, target);
	if (env.getMode() === "full_access") return { ok: true, abs };
	const rel = path.relative(env.workspace, abs);
	if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return { ok: true, abs };
	return { ok: false, error: `Access denied: path escapes the workspace (${env.workspace}): ${target}` };
}

/** 固定顺序注册（read, write, list, bash[, ask_user]）——顺序稳定保证 tools 前缀缓存命中（§6.6）。 */
export class ToolRegistry {
	private readonly tools = new Map<string, AgentTool>();
	constructor(tools: AgentTool[]) {
		for (const t of tools) this.tools.set(t.name, t);
	}
	get(name: string): AgentTool | undefined {
		return this.tools.get(name);
	}
	/** pi-ai Context.tools 形态 */
	list(): Tool[] {
		return [...this.tools.values()].map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}
}
