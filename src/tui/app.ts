import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	HStack,
	Loader,
	Markdown,
	ProcessTerminal,
	ScrollView,
	SelectList,
	SettingsList,
	Spacer,
	Text,
	TuiAltScreen,
	VStack,
	matchesKey,
	type SelectItem,
	type SettingItem,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import type { LLMClient } from "../ai/client.ts";
import { AgentSession } from "../agent/session.ts";
import type { ToolRegistry } from "../agent/tools/index.ts";
import type { AgentEvent, PermissionDecision, RunMode, ToolCallInfo } from "../events.ts";
import { createTuiAskUser } from "./ask.ts";
import { TuiPermissionRequester } from "./permission.ts";
import {
	colors,
	dialogOverlayOptions,
	editorTheme,
	markdownTheme,
	selectListTheme,
	settingsListTheme,
} from "./theme.ts";

const HELP_MARKDOWN = [
	"**命令**",
	"- `/mode` — 切换 Default / Full Access 模式",
	"- `/ask-user` — 开关 ask_user 工具（OFF 时从模型可见工具中移除）",
	"- `/ui` — 界面设置：展开思考过程 / 展开工具详情",
	"- `/clear` — 清空当前会话",
	"- `/help` — 显示本帮助",
	"",
	"**按键**",
	"- `Enter` 发送 · `Esc` 中断当前任务 · `Ctrl+C` 退出",
	"",
	"**模式**",
	"- Default：read/list 直接执行；write/bash 需逐次批准（可选「本次会话均允许」）；文件访问限制在 Workspace 内",
	"- Full Access：解除文件边界与审批",
].join("\n");

const WELCOME = "输入任务开始。/help 查看帮助 · Esc 中断 · Ctrl+C 退出";

interface ToolState {
	call: ToolCallInfo;
	started: boolean;
	done?: { ok: boolean; durationMs: number; output?: string; error?: string };
}

function toolLabel(call: ToolCallInfo): string {
	switch (call.toolName) {
		case "read":
		case "write":
		case "list":
			return `${call.toolName} ${String(call.args.path ?? "")}`.trim();
		case "bash":
			return `bash: ${String(call.args.command ?? "").slice(0, 60)}`;
		case "ask_user":
			return `ask_user: ${String(call.args.question ?? "").slice(0, 60)}`;
		default:
			return call.toolName;
	}
}

function truncate(text: string, max: number): string {
	return text.length <= max ? `${text}` : `${text.slice(0, max)}…`;
}

/**
 * 聊天 TUI（设计方案 §23/§24/§26/§27）：事件流的渲染端。
 * 编排全部委托 AgentSession（与 WebUI 共享同一核心）；渲染 = 从事件日志全量重建 transcript。
 */
export class TuiApp {
	readonly editor: Editor;
	private readonly tui: TuiAltScreen;
	private readonly transcript = new Container();
	private readonly header = new Text("", 1, 0);
	private readonly status = new Text("", 1, 0); // 输入框上方右侧的指标栏（cache 命中率）
	private readonly session: AgentSession;
	private expandThinking = false;
	private expandTools = false;
	private streaming = false;
	private dialogOpen = false;
	private loader: Loader | null = null;

	constructor(
		private readonly opts: {
			client: LLMClient;
			registry: ToolRegistry;
			workspace: string;
			sessionId: string;
			modeRef: { mode: RunMode };
		},
	) {
		this.tui = new TuiAltScreen(new ProcessTerminal());
		this.editor = new Editor(this.tui, editorTheme);
		this.editor.onSubmit = (text) => this.handleSubmit(text);

		// 注意：SlashCommand.name 不带前导斜杠——Editor 的 applyCompletion 会自行补 "/"（否则出现 "//"）
		const slashCommands: SlashCommand[] = [
			{ name: "mode", description: "切换 Default / Full Access 模式" },
			{ name: "ask-user", description: "开关 ask_user 工具" },
			{ name: "ui", description: "界面设置（思考/工具详情）" },
			{ name: "clear", description: "清空当前会话" },
			{ name: "help", description: "显示帮助" },
		];
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(slashCommands, opts.workspace, null),
		);

		this.session = new AgentSession({
			client: opts.client,
			registry: opts.registry,
			workspace: opts.workspace,
			sessionId: opts.sessionId,
			modeRef: opts.modeRef,
			hooks: {
				requestPermission: (call: ToolCallInfo, summary: string) =>
					new TuiPermissionRequester(
						this.tui,
						(e) => this.session.emit(e),
						() => this.tui.setFocus(this.editor),
						(open) => {
							this.dialogOpen = open;
						},
					).request(call, summary),
				askUser: createTuiAskUser({
					tui: this.tui,
					emit: (e) => this.session.emit(e),
					restoreFocus: () => this.tui.setFocus(this.editor),
					onDialogOpenChange: (open) => {
						this.dialogOpen = open;
					},
				}),
				onEvent: (e) => this.onEvent(e),
			},
		});

		this.tui.setLayoutRoot(
			new VStack([
				{ component: this.header, basis: "auto", shrink: 0 },
				{
					component: new ScrollView(this.transcript, { follow: "end", primary: true }),
					basis: 0,
					grow: 1,
					minSize: 3,
				},
				{ component: new HStack([new Spacer(), this.status]), basis: "auto", shrink: 0 },
				{ component: this.editor, basis: "auto", shrink: 1 },
			]),
		);

		this.tui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c")) {
				this.tui.stop();
				process.exit(0);
			}
			if (matchesKey(data, "escape") && this.session.running && !this.dialogOpen) this.interrupt();
			return undefined;
		});
	}

	start(): void {
		this.session.emit({
			type: "session_started",
			sessionId: this.opts.sessionId,
			workspace: this.opts.workspace,
			mode: this.session.modeRef.mode,
		});
		this.tui.setFocus(this.editor);
		this.tui.start();
	}

	private refreshHeader(): void {
		const modeLabel =
			this.session.modeRef.mode === "default"
				? colors.green("Default 模式")
				: colors.yellow("Full Access 模式");
		const askLabel = this.session.askUserEnabled ? colors.dim("提问 开") : colors.dim("提问 关");
		this.header.setText(
			`${colors.bold("mini-coding-agent")}${colors.dim(" · ")}${this.opts.workspace}${colors.dim(" · ")}${modeLabel}${colors.dim(" · ")}${askLabel}`,
		);
		// 注：cache 公式对 MiniMax usage 字段语义的适配是已知遗留问题，阶段三 commit 后统一修复
		const cache =
			this.session.metrics.turns > 0 ? `cache ${(this.session.metrics.cacheHitRate * 100).toFixed(0)}%` : "cache --";
		this.status.setText(colors.dim(cache));
		this.tui.requestRender();
	}

	private interrupt(): void {
		this.session.interrupt();
		this.transcript.addChild(new Text(colors.yellow("· 已请求中断，等待收尾…"), 1, 0));
		this.tui.requestRender();
	}

	private handleSubmit(raw: string): void {
		const text = raw.trim();
		if (!text) return;
		if (this.session.running) {
			this.transcript.addChild(new Text(colors.red("任务进行中，请先按 Esc 中断再输入"), 1, 0));
			this.tui.requestRender();
			return;
		}
		if (text.startsWith("/")) {
			this.handleCommand(text);
			return;
		}
		void this.session.runTurn(text);
	}

	private handleCommand(text: string): void {
		switch (text) {
			case "/mode":
				this.showModeDialog();
				return;
			case "/ask-user":
				this.showAskUserDialog();
				return;
			case "/ui":
				this.showUiDialog();
				return;
			case "/clear":
				this.session.reset();
				this.transcript.clear();
				this.transcript.addChild(new Text(colors.dim("会话已清空"), 1, 0));
				this.refreshHeader();
				this.tui.requestRender();
				return;
			case "/help":
				this.transcript.addChild(new Markdown(HELP_MARKDOWN, 1, 0, markdownTheme));
				this.tui.requestRender();
				return;
			default:
				this.transcript.addChild(
					new Text(colors.yellow(`未知命令 ${text}，可用：/mode /ask-user /ui /clear /help`), 1, 0),
				);
				this.tui.requestRender();
		}
	}

	private showModeDialog(): void {
		if (this.session.running) {
			this.transcript.addChild(new Text(colors.yellow("任务进行中无法切换模式，请先按 Esc 中断"), 1, 0));
			this.tui.requestRender();
			return;
		}
		const items: SelectItem[] = [
			{ value: "default", label: "Default 模式（限制在 Workspace，write/bash 需批准）" },
			{ value: "full_access", label: "Full Access 模式（解除边界与审批）" },
		];
		const list = new SelectList(items, items.length, selectListTheme);
		list.setSelectedIndex(this.session.modeRef.mode === "default" ? 0 : 1);
		const handle = this.tui.showOverlay(new VStack([new Text("选择模式", 1, 0), list]), dialogOverlayOptions);
		this.dialogOpen = true;
		this.tui.setFocus(list);
		const done = () => {
			this.dialogOpen = false;
			handle.hide();
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
		list.onSelect = (item) => {
			const next = item.value as RunMode;
			done();
			this.session.setMode(next);
		};
		list.onCancel = done;
	}

	private showAskUserDialog(): void {
		const items: SelectItem[] = [
			{ value: "on", label: "开启（模型可使用 ask_user 提问）" },
			{ value: "off", label: "关闭（从模型可见工具中移除）" },
		];
		const list = new SelectList(items, items.length, selectListTheme);
		list.setSelectedIndex(this.session.askUserEnabled ? 0 : 1);
		const handle = this.tui.showOverlay(new VStack([new Text("ask_user 工具", 1, 0), list]), dialogOverlayOptions);
		this.dialogOpen = true;
		this.tui.setFocus(list);
		const done = () => {
			this.dialogOpen = false;
			handle.hide();
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
		list.onSelect = (item) => {
			const next = item.value === "on";
			done();
			this.session.toggleAskUser(next);
		};
		list.onCancel = done;
	}

	private showUiDialog(): void {
		const items: SettingItem[] = [
			{
				id: "thinking",
				label: "展开思考过程",
				description: "默认折叠为一行摘要（💭 thinking）",
				currentValue: this.expandThinking ? "开" : "关",
				values: ["开", "关"],
			},
			{
				id: "tools",
				label: "展开工具详情",
				description: "默认只显示单行工具状态（✓/×），展开后附带输出",
				currentValue: this.expandTools ? "开" : "关",
				values: ["开", "关"],
			},
		];
		let handle: { hide(): void } | undefined;
		const closeDialog = () => {
			this.dialogOpen = false;
			handle?.hide();
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
		};
		const list = new SettingsList(
			items,
			items.length,
			settingsListTheme,
			(id, newValue) => {
				if (id === "thinking") this.expandThinking = newValue === "开";
				if (id === "tools") this.expandTools = newValue === "开";
				// 全量重绘：折叠是纯渲染行为，事件流不变（§6.10）
				this.rebuildTranscript();
			},
			closeDialog,
		);
		handle = this.tui.showOverlay(new VStack([new Text("界面设置", 1, 0), list]), dialogOverlayOptions);
		this.dialogOpen = true;
		this.tui.setFocus(list);
	}

	private onEvent(e: AgentEvent): void {
		if (e.type === "assistant_started") this.streaming = true;
		if (e.type === "assistant_completed" || e.type === "turn_completed") this.streaming = false;
		this.rebuildTranscript();
		this.refreshHeader();
	}

	/** 渲染 = fold(事件日志)：唯一构建 UI 状态的方式，与折叠开关、WebUI snapshot 共用 */
	private rebuildTranscript(): void {
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		this.transcript.clear();
		const events = this.session.events;

		// 工具调用终态预计算（按事件顺序推导）
		const tools = new Map<string, ToolState>();
		for (const e of events) {
			if (e.type === "tool_queued") tools.set(e.call.callId, { call: e.call, started: false });
		}
		for (const e of events) {
			if (e.type === "tool_started") {
				const t = tools.get(e.callId);
				if (t) t.started = true;
			} else if (e.type === "tool_completed") {
				const t = tools.get(e.callId);
				if (t) t.done = { ok: e.ok, durationMs: e.durationMs, output: e.output, error: e.error };
			}
		}

		// 权限记录按 requestId（= callId）归组：跟随对应工具行渲染，而不是独立成行
		// （否则会在时间线上晚于该工具的 ✓ 行出现，视觉顺序错乱）
		const permissionByCall = new Map<string, { summary: string; decision?: PermissionDecision }>();
		for (const e of events) {
			if (e.type === "permission_required") permissionByCall.set(e.requestId, { summary: e.summary });
			else if (e.type === "permission_resolved") {
				const rec = permissionByCall.get(e.requestId);
				if (rec) rec.decision = e.decision;
			}
		}
		const decisionLabel = (d?: PermissionDecision): string =>
			d === "allow_once"
				? " → 已允许（一次）"
				: d === "allow_session"
					? " → 已允许（本会话）"
					: d === "deny"
						? " → 已拒绝"
						: "";

		for (const e of events) {
			switch (e.type) {
				case "user_message_added":
					this.transcript.addChild(new Text(`${colors.bold("❯ ")}${e.content}`, 1, 0));
					break;
				case "assistant_completed": {
					if (e.thinking) {
						this.transcript.addChild(
							new Text(
								colors.dim(
									this.expandThinking
										? truncate(e.thinking, 4000)
										: `💭 thinking (${((e.thinkingMs ?? 0) / 1000).toFixed(1)}s)`,
								),
								1,
								0,
							),
						);
					}
					if (e.text.trim()) this.transcript.addChild(new Markdown(e.text, 1, 0, markdownTheme));
					break;
				}
				case "tool_queued": {
					const state = tools.get(e.call.callId);
					const label = toolLabel(e.call);
					const permission = permissionByCall.get(e.call.callId);
					if (permission) {
						this.transcript.addChild(
							new Text(colors.yellow(`? 权限请求：${permission.summary}${decisionLabel(permission.decision)}`), 1, 0),
						);
					}
					let line: string;
					if (state?.done) {
						line = state.done.ok
							? colors.green(`✓ ${label} (${state.done.durationMs}ms)`)
							: colors.red(`× ${label}`);
					} else if (state?.started) {
						line = colors.cyan(`◌ ${label}`);
					} else {
						line = colors.dim(`· 等待中 ${label}`);
					}
					this.transcript.addChild(new Text(line, 1, 0));
					if (state?.done && !state.done.ok && state.done.error) {
						this.transcript.addChild(
							new Text(colors.dim(`  ${truncate(state.done.error.replace(/\n/g, " "), 200)}`), 1, 0),
						);
					} else if (state?.done?.ok && this.expandTools && state.done.output) {
						this.transcript.addChild(
							new Text(colors.dim(`  ${truncate(state.done.output, 1200)}`), 1, 0),
						);
					}
					break;
				}
				case "user_input_requested":
					this.transcript.addChild(new Text(colors.cyan(`? Agent 提问：${e.question}`), 1, 0));
					break;
				case "user_input_received":
					this.transcript.addChild(new Text(colors.dim(`↩ 用户回答：${e.answer}`), 1, 0));
					break;
				case "agent_error":
					this.transcript.addChild(new Text(colors.red(`✗ ${e.message}`), 1, 0));
					break;
				case "turn_completed": {
					const m = this.session.metrics;
					const parts: string[] = [];
					if (m.turns > 0) parts.push(`cache ${(m.cacheHitRate * 100).toFixed(0)}%`);
					const total = m.tools.ok + m.tools.failed;
					if (total > 0) parts.push(`tools ${m.tools.ok}/${total}`);
					if (m.tools.denied > 0) parts.push(`deny ${m.tools.denied}`);
					if (parts.length > 0) {
						this.transcript.addChild(new Text(colors.dim(`— ${parts.join(" · ")} —`), 1, 0));
					}
					break;
				}
				default:
					break;
			}
		}

		if (!events.some((e) => e.type === "user_message_added")) {
			this.transcript.addChild(new Text(colors.dim(WELCOME), 1, 0));
		}
		if (this.streaming) {
			this.loader = new Loader(this.tui, colors.cyan, colors.dim, "生成中…");
			this.transcript.addChild(this.loader);
		}
		this.tui.requestRender();
	}
}
