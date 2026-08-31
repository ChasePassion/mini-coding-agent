// usage 字段语义探测：三轮对话（round1 写入 prompt cache，round2/3 命中读取），
// 判断 MiniMax 的 input 是否已包含 cacheRead/cacheWrite —— 决定命中率分母公式。
import type { Context } from "@earendil-works/pi-ai";
import { createLLMClient } from "../src/ai/client.ts";
import { loadConfig } from "../src/config.ts";

async function main(): Promise<void> {
	const config = loadConfig(process.cwd());
	if (!config.apiKey) {
		console.error("缺少 MINIMAX_CN_API_KEY");
		process.exit(1);
	}
	const client = createLLMClient(config);
	const context: Context = {
		systemPrompt: "You are a cache probe. Answer with one short sentence.",
		messages: [],
		tools: [],
	};
	const bigContext = `cache probe payload:\n${"The quick brown fox jumps over the lazy dog. ".repeat(600)}`;
	for (let round = 1; round <= 3; round++) {
		context.messages.push({
			role: "user",
			content: round === 1 ? bigContext : `第 ${round} 轮：请只回答 "OK"。`,
			timestamp: Date.now(),
		});
		const stream = client.stream(context);
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const _ev of stream) {
			// 驱动流式完成
		}
		const message = await stream.result();
		context.messages.push(message);
		const u = message.usage;
		console.log(
			`round ${round}: input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} totalTokens=${u.totalTokens}`,
		);
	}
}

void main();
