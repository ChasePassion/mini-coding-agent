import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, ToolEnv, ToolExecContext, ToolOutput } from "./index.ts";

export const BashArgs = Type.Object({
	command: Type.String({
		description: "Shell command to execute (runs via bash, cwd = workspace)",
	}),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 600_000,
			default: 120_000,
			description: "Timeout in milliseconds (default 120000)",
		}),
	),
});
export type BashArgs = Static<typeof BashArgs>;

const OUTPUT_CAP = 50_000;

let bashAvailable: boolean | null = null;

/** Windows：优先本机 Git Bash（bash -lc）；缺失时降级 cmd /c 并在输出中注明（技术方案 §6.8）。 */
function hasBash(): boolean {
	if (bashAvailable === null) {
		try {
			bashAvailable =
				spawnSync("bash", ["-lc", "echo ok"], { encoding: "utf8", timeout: 10_000 }).status === 0;
		} catch {
			bashAvailable = false;
		}
	}
	return bashAvailable;
}

function appendCapped(current: string, chunk: string): string {
	if (current.length >= OUTPUT_CAP) return current;
	return (current + chunk).slice(0, OUTPUT_CAP);
}

/**
 * bash 静态越狱检测（Default 模式，设计方案 §3.1 的 best-effort 边界强化）：
 * 扫描命令中显式出现的路径（绝对路径 / 盘符 / ~ / .. 逃逸），解析后落在 Workspace
 * 外即拒绝。注意这只能拦截"命令本身引用了外部路径"——脚本内部再去读外部文件属于
 * 已知盲区（可靠拦截需要容器级沙箱），已在 README 与系统提示词中声明。
 */
export function detectWorkspaceEscape(command: string, workspace: string): string | null {
	const tokens = command.split(/\s+/).filter(Boolean);
	for (const raw of tokens) {
		const t = raw.replace(/^["']+|["']+$/g, "");
		if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue; // 跳过 URL
		const looksPath =
			/[\\/]/.test(t) || /^[A-Za-z]:/.test(t) || t === ".." || t === "../" || t.startsWith("~");
		if (!looksPath) continue;
		const abs = t.startsWith("~") ? path.join(os.homedir(), t.slice(1).replace(/^[/\\]/, "")) : path.resolve(workspace, t);
		const rel = path.relative(workspace, abs);
		if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return t;
	}
	return null;
}

export function createBashTool(env: ToolEnv): AgentTool {
	return {
		name: "bash",
		kind: "bash",
		description:
			"Execute a shell command in the workspace via bash. Boundary: in Default mode, commands that explicitly reference paths outside the workspace (absolute paths, drive letters, ~, or ../ escapes) are rejected - keep file references relative to the workspace. Concurrency: globally exclusive — while a command runs, no other tool (read/write/list/bash) executes; everything queues. A queued bash first reserves the execution slot, then asks for approval, so once you are approved the command starts immediately; a Deny releases the slot instantly. In Default mode every command needs user approval.",
		parameters: BashArgs,
		describe: (a) => `bash: ${String(a.command ?? "").slice(0, 80)}`,
		async execute(args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolOutput> {
			const a = args as unknown as BashArgs;
			const timeoutMs = a.timeoutMs ?? 120_000;

			// Default 模式：静态越狱检测（显式外部路径引用直接拒绝）
			if (env.getMode() === "default") {
				const escape = detectWorkspaceEscape(a.command, env.workspace);
				if (escape) {
					return {
						isError: true,
						text: `Access denied: the command references a path outside the workspace (${env.workspace}): ${escape}. In Default mode bash must stay inside the workspace; ask the user to switch to Full Access mode (via /mode) if external access is intended.`,
					};
				}
			}

			const useBash = hasBash();
			const shell = useBash
				? { file: "bash", args: ["-lc", a.command] }
				: { file: "cmd", args: ["/c", a.command] };

			return await new Promise<ToolOutput>((resolve) => {
				let stdout = "";
				let stderr = "";
				let timedOut = false;
				let aborted = false;

				const child = spawn(shell.file, shell.args, {
					cwd: env.workspace,
					stdio: ["ignore", "pipe", "pipe"],
				});

				const killTree = () => {
					if (child.pid == null) return;
					if (process.platform === "win32") {
						spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
					} else {
						try {
							child.kill("SIGKILL");
						} catch {
							// 进程已退出
						}
					}
				};
				const timer = setTimeout(() => {
					timedOut = true;
					killTree();
				}, timeoutMs);
				const onAbort = () => {
					aborted = true;
					killTree();
				};
				ctx.signal?.addEventListener("abort", onAbort, { once: true });

				child.stdout?.setEncoding("utf8");
				child.stderr?.setEncoding("utf8");
				child.stdout?.on("data", (d: string) => {
					stdout = appendCapped(stdout, d);
				});
				child.stderr?.on("data", (d: string) => {
					stderr = appendCapped(stderr, d);
				});

				const finish = (code: number | null) => {
					clearTimeout(timer);
					ctx.signal?.removeEventListener("abort", onAbort);
					const ok = code === 0 && !timedOut && !aborted;
					const parts = [
						`$ ${a.command}${useBash ? "" : "\n(note: bash unavailable, ran via cmd)"}`,
						`exit: ${code ?? "none"}${timedOut ? ` (timed out after ${timeoutMs}ms)` : ""}${aborted ? " (aborted by user)" : ""}`,
					];
					if (stdout.trim()) parts.push("--- stdout ---", stdout.trimEnd());
					if (stderr.trim()) parts.push("--- stderr ---", stderr.trimEnd());
					if (stdout.length >= OUTPUT_CAP) parts.push(`(stdout truncated at ${OUTPUT_CAP} chars)`);
					resolve({ isError: !ok, text: parts.join("\n") });
				};

				child.on("error", (err) => {
					clearTimeout(timer);
					ctx.signal?.removeEventListener("abort", onAbort);
					resolve({ isError: true, text: `failed to spawn shell: ${err.message}` });
				});
				child.on("close", (code) => finish(code));
			});
		},
	};
}
