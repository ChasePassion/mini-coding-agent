import { SelectList, Text, VStack, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import type { AgentEvent, PermissionDecision, ToolCallInfo } from "../events.ts";
import type { PermissionRequester } from "../agent/scheduler.ts";
import { dialogOverlayOptions, selectListTheme } from "./theme.ts";

const OPTIONS: SelectItem[] = [
	{ value: "allow_once", label: "允许一次" },
	{ value: "allow_session", label: "本次会话均允许" },
	{ value: "deny", label: "拒绝" },
];

/**
 * TUI 权限请求器（设计方案 §6/§32）：SelectList 三选项，Esc = 拒绝。
 * permission_required 事件由本实现发出（与 §6.4 的 WebUI 实现对称），
 * permission_resolved 由 Scheduler 发出。
 */
export class TuiPermissionRequester implements PermissionRequester {
	constructor(
		private readonly tui: TUI,
		private readonly emit: (e: AgentEvent) => void,
		private readonly restoreFocus: () => void,
		private readonly onDialogOpenChange: (open: boolean) => void,
	) {}

	request(call: ToolCallInfo, summary: string): Promise<PermissionDecision> {
		return new Promise<PermissionDecision>((resolve) => {
			this.emit({ type: "permission_required", requestId: call.callId, call, summary });
			this.onDialogOpenChange(true);

			const verb =
				call.toolName === "bash"
					? "Agent 请求执行命令"
					: call.toolName === "write"
						? "Agent 请求写入文件"
						: `Agent 请求使用工具 ${call.toolName}`;
			const list = new SelectList([...OPTIONS], OPTIONS.length, selectListTheme);
			const handle = this.tui.showOverlay(
				new VStack([new Text(`${verb}：`, 1, 0), new Text(summary, 1, 0), list]),
				dialogOverlayOptions,
			);

			const done = (decision: PermissionDecision) => {
				this.onDialogOpenChange(false);
				handle.hide();
				this.restoreFocus();
				resolve(decision);
			};
			list.onSelect = (item) => done(item.value as PermissionDecision);
			list.onCancel = () => done("deny");

			this.tui.setFocus(list);
			this.tui.requestRender();
		});
	}
}
