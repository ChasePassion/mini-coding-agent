import * as readline from "node:readline/promises";
import { createLLMClient } from "./ai/client.ts";
import { loadConfig } from "./config.ts";
import type { RunMode } from "./events.ts";
import { type ToolEnv } from "./agent/tools/index.ts";
import { createDefaultTools } from "./agent/tools/default.ts";
import { TuiApp } from "./tui/app.ts";

async function selectInterface(): Promise<"tui" | "web"> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	console.log("Select Interface:\n  1) TUI\n  2) WebUI");
	const answer = (await rl.question("选择 [1]: ")).trim().toLowerCase();
	rl.close();
	return answer === "2" || answer === "web" || answer === "webui" ? "web" : "tui";
}

async function main(): Promise<void> {
	const workspace = process.cwd();
	const config = loadConfig(workspace);
	if (!config.apiKey) {
		console.error("缺少 API Key：请在 .env 中设置 MINIMAX_CN_API_KEY（参见 .env.example）。");
		process.exit(1);
	}
	const client = createLLMClient(config);

	// --interface tui|web（缺省交互选择，设计方案 §2）
	const args = process.argv.slice(2);
	const flagIndex = args.indexOf("--interface");
	const flag =
		flagIndex >= 0
			? args[flagIndex + 1]
			: args.find((a) => a.startsWith("--interface="))?.split("=")[1];
	const iface = flag === "tui" || flag === "web" ? flag : await selectInterface();

	if (iface === "web") {
		const { startWebServer } = await import("./web/server.ts");
		await startWebServer({ client, workspace });
		return;
	}

	const modeRef: { mode: RunMode } = { mode: "default" };
	const env: ToolEnv = { workspace, getMode: () => modeRef.mode };
	const registry = createDefaultTools(env);
	// ask_user 工具由 AgentSession 在构造时注册（其执行体依赖前端注入的 ask 实现）

	const app = new TuiApp({
		client,
		registry,
		workspace,
		sessionId: `session-${Date.now().toString(36)}`,
		modeRef,
	});
	app.start();
}

void main();
