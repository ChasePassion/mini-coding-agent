// Headless 任务驱动器（验收三案例用，也验证「前端只是事件流的消费者」）。
// 用法：npm run task -- "总结 README.md" [--auto]
//   --auto：权限请求自动批准（allow_once）；缺省时 headless 模式一律拒绝。
import type { Context, Message } from "@earendil-works/pi-ai";
import { createLLMClient } from "../src/ai/client.ts";
import { loadConfig } from "../src/config.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { ToolScheduler, type PermissionRequester } from "../src/agent/scheduler.ts";
import { ToolRegistry, type ToolEnv } from "../src/agent/tools/index.ts";
import { createBashTool } from "../src/agent/tools/bash.ts";
import { createListTool } from "../src/agent/tools/list.ts";
import { createReadTool } from "../src/agent/tools/read.ts";
import { createWriteTool } from "../src/agent/tools/write.ts";
import type { AgentEvent, RunMode, ToolCallInfo } from "../src/events.ts";

async function main(): Promise<void> {
	const taskArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const auto = process.argv.includes("--auto");
	const task = taskArgs[0];
	if (!task) {
		console.error("用法: npm run task -- \"任务描述\" [--auto]");
		process.exit(1);
	}

	const workspace = process.cwd();
	const config = loadConfig(workspace);
	if (!config.apiKey) {
		console.error("缺少 MINIMAX_CN_API_KEY");
		process.exit(1);
	}
	const client = createLLMClient(config);
	const modeRef: { mode: RunMode } = { mode: "default" };
	const env: ToolEnv = { workspace, getMode: () => modeRef.mode };
	const registry = new ToolRegistry([
		createReadTool(env),
		createWriteTool(env),
		createListTool(env),
		createBashTool(env),
	]);

	const label = (call: ToolCallInfo): string => {
		if (call.toolName === "bash") return `bash: ${String(call.args.command ?? "").slice(0, 60)}`;
		return `${call.toolName} ${String(call.args.path ?? "")}`.trim();
	};
	const emit = (e: AgentEvent): void => {
		switch (e.type) {
			case "tool_queued":
				console.log(`· ${label(e.call)}`);
				break;
			case "tool_started":
				console.log(`◌ ${e.callId}`);
				break;
			case "tool_completed":
				console.log(e.ok ? `✓ ${e.toolName} (${e.durationMs}ms)` : `× ${e.toolName}: ${e.error?.slice(0, 200)}`);
				break;
			case "permission_required":
				console.log(`? 权限请求：${e.summary}`);
				break;
			case "permission_resolved":
				console.log(`  → ${e.decision}`);
				break;
			case "assistant_delta":
				process.stdout.write(e.delta);
				break;
			case "assistant_completed":
				process.stdout.write("\n");
				break;
			case "agent_error":
				console.error(`✗ ${e.message}`);
				break;
			default:
				break;
		}
	};

	const permissions: PermissionRequester = {
		request: async (_call, summary) => {
			if (!auto) {
				console.log(`? 权限请求：${summary} → deny（headless 默认拒绝；--auto 可自动批准）`);
				return "deny";
			}
			console.log(`? 权限请求：${summary} → allow_once (--auto)`);
			return "allow_once";
		},
	};
	const scheduler = new ToolScheduler(registry, permissions, emit, {
		workspace,
		getMode: () => modeRef.mode,
	});

	const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];
	const context: Context = {
		systemPrompt: buildSystemPrompt(workspace, "default"),
		messages,
		tools: registry.list(),
	};
	await runAgentLoop(context, { client, scheduler, emit });
}

void main();
