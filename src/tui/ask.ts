import { Editor, SelectList, Text, VStack, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../events.ts";
import type { AskUserFn } from "../agent/tools/ask.ts";
import { editorTheme, selectListTheme } from "./theme.ts";

/**
 * ask_user 的 TUI 实现（设计方案 §20/§33）：选项列表 + 始终保留的「自定义输入…」。
 * user_input_requested / user_input_received 事件由本实现发出（与权限请求器对称）。
 */
export function createTuiAskUser(deps: {
	tui: TUI;
	emit: (e: AgentEvent) => void;
	restoreFocus: () => void;
	onDialogOpenChange: (open: boolean) => void;
}): AskUserFn {
	const { tui, emit, restoreFocus, onDialogOpenChange } = deps;
	return (question: string, options: string[]) =>
		new Promise<string>((resolve) => {
			const callId = `ask-${Date.now().toString(36)}`;
			emit({ type: "user_input_requested", callId, question, options });
			onDialogOpenChange(true);

			const finish = (answer: string) => {
				emit({ type: "user_input_received", callId, answer });
				onDialogOpenChange(false);
				restoreFocus();
				resolve(answer);
			};

			const items: SelectItem[] = [
				...options.map((o) => ({ value: o, label: o })),
				{ value: "__custom__", label: "自定义输入…" },
			];
			const list = new SelectList(items, Math.min(items.length, 8), selectListTheme);
			const handle = tui.showOverlay(new VStack([new Text(`Agent 提问：${question}`, 1, 0), list]));

			list.onSelect = (item) => {
				if (item.value !== "__custom__") {
					handle.hide();
					finish(item.value);
					return;
				}
				// 自定义输入：切换为 Editor overlay
				handle.hide();
				const editor = new Editor(tui, editorTheme);
				const editHandle = tui.showOverlay(new VStack([new Text(`你的回答：${question}`, 1, 0), editor]));
				tui.setFocus(editor);
				editor.onSubmit = (text) => {
					editHandle.hide();
					finish(text.trim() || "（空）");
				};
				tui.requestRender();
			};
			list.onCancel = () => {
				handle.hide();
				finish("（用户取消了回答）");
			};

			tui.setFocus(list);
			tui.requestRender();
		});
}
