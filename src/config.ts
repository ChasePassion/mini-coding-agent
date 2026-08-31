import { existsSync } from "node:fs";

export interface AgentConfig {
	provider: string;
	modelId: string;
	apiKey?: string;
	workspace: string;
}

/** 加载 .env（存在时）并读取 provider/model 配置。Key 只经环境变量与显式传参，严禁入库。 */
export function loadConfig(workspace: string): AgentConfig {
	if (existsSync(".env")) {
		try {
			process.loadEnvFile(".env");
		} catch {
			// .env 格式异常时回退到真实环境变量
		}
	}
	return {
		provider: process.env.MINI_AGENT_PROVIDER || "minimax-cn",
		modelId: process.env.MINI_AGENT_MODEL || "MiniMax-M2.7",
		apiKey: process.env.MINIMAX_CN_API_KEY,
		workspace,
	};
}
