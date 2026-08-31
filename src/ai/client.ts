// src/ai/client.ts —— AI 适配层：pi-ai 只在此文件出现执行调用。
// 按锚点②注释的许可，subscribe 薄封装替换为直接 AsyncIterable（loop 内 for await 消费）。
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/** pi-ai AssistantMessageEventStream 的结构收窄：事件流 + 最终消息，便于测试注入替换。 */
export interface LLMStream extends AsyncIterable<{ type: string; delta?: string }> {
	result(): Promise<AssistantMessage>;
}

export interface LLMClient {
	model: Model<string>;
	stream(context: Context, opts?: { signal?: AbortSignal }): LLMStream;
}

export function createLLMClient(config: { provider: string; modelId: string; apiKey?: string }): LLMClient {
	const models = builtinModels();
	const model = models.getModel(config.provider, config.modelId);
	if (!model) throw new Error(`Unknown model: ${config.provider}/${config.modelId}`);
	return {
		model,
		stream: (context, opts) =>
			models.streamSimple(model, context, { apiKey: config.apiKey, signal: opts?.signal }),
	};
}
