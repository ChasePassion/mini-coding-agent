import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, ToolExecContext, ToolOutput } from "./index.ts";

export const AskArgs = Type.Object({
	question: Type.String({ description: "Question to ask the user" }),
	options: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 2,
			maxItems: 4,
			description: "2-4 short answer options when the question has a natural choice set",
		}),
	),
});
export type AskArgs = Static<typeof AskArgs>;

/** ask 的 UI 实现由前端注入（工具本身保持 UI 无关）：TUI 弹选项+自定义输入，测试注入脚本化答案 */
export type AskUserFn = (question: string, options: string[]) => Promise<string>;

export function createAskTool(ask: AskUserFn): AgentTool {
	return {
		name: "ask_user",
		kind: "ask",
		description:
			"Ask the human a question and block until they answer; the answer is returned to you as the tool result. Provide 2-4 short options when possible; the user can always reply with custom input. Use it only for genuine ambiguity (requirements, trade-offs), never for facts you can look up yourself. While waiting, other in-flight tools keep running.",
		parameters: AskArgs,
		describe: (a) => `ask_user: ${String(a.question ?? "").slice(0, 60)}`,
		async execute(args: Record<string, unknown>, _ctx: ToolExecContext): Promise<ToolOutput> {
			const a = args as unknown as AskArgs;
			const answer = await ask(a.question, a.options ?? []);
			return { isError: false, text: `User answered: ${answer}` };
		},
	};
}
