// 默认工具集工厂：每个会话独立的 registry + modeRef（避免多会话共享模式状态）
import type { ToolEnv } from "./index.ts";
import { ToolRegistry } from "./index.ts";
import { createBashTool } from "./bash.ts";
import { createListTool } from "./list.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export function createDefaultTools(env: ToolEnv): ToolRegistry {
	return new ToolRegistry([
		createReadTool(env),
		createWriteTool(env),
		createListTool(env),
		createBashTool(env),
	]);
}
