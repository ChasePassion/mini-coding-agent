// 冒烟脚本（技术方案 1.2）：连通公司 Key，打印一次流式回复与 usage。
// 用法：npm run smoke
import { createLLMClient } from "../src/ai/client.ts";
import { loadConfig } from "../src/config.ts";

async function main(): Promise<void> {
	const config = loadConfig(process.cwd());
	if (!config.apiKey) {
		console.error("缺少 MINIMAX_CN_API_KEY：请配置 .env（参见 .env.example）");
		process.exit(1);
	}
	const client = createLLMClient(config);
	console.log(`[smoke] provider=${config.provider} model=${config.modelId}`);

	const stream = client.stream({
		systemPrompt: "You are a smoke test endpoint.",
		messages: [{ role: "user", content: "Reply with exactly: SMOKE_OK", timestamp: Date.now() }],
	});
	for await (const ev of stream) {
		if (ev.type === "text_delta" && ev.delta) process.stdout.write(ev.delta);
	}
	const message = await stream.result();
	const u = message.usage;
	console.log(
		`\n[smoke] stopReason=${message.stopReason} in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}`,
	);
	if (message.stopReason !== "stop") process.exit(1);
}

void main();
