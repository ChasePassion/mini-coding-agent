import { createLLMClient } from "./ai/client.ts";
import { loadConfig } from "./config.ts";
import type { RunMode } from "./events.ts";
import { ToolRegistry, type ToolEnv } from "./agent/tools/index.ts";
import { createBashTool } from "./agent/tools/bash.ts";
import { createListTool } from "./agent/tools/list.ts";
import { createReadTool } from "./agent/tools/read.ts";
import { createWriteTool } from "./agent/tools/write.ts";
import { TuiApp } from "./tui/app.ts";

function main(): void {
	const workspace = process.cwd();
	const config = loadConfig(workspace);
	if (!config.apiKey) {
		console.error("缺少 API Key：请在 .env 中设置 MINIMAX_CN_API_KEY（参见 .env.example）。");
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
	// ask_user 工具由 TuiApp 在构造时注册（其执行体依赖 TUI 对话框，晚绑定注入）

	const app = new TuiApp({
		client,
		registry,
		workspace,
		sessionId: `session-${Date.now().toString(36)}`,
		modeRef,
	});
	app.start();
}

main();
