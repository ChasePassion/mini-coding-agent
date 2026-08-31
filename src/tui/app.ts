import type { Context, Message } from "@earendil-works/pi-ai";
import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Loader,
	Markdown,
	ProcessTerminal,
	ScrollView,
	SelectList,
	SettingsList,
	Text,
	TuiAltScreen,
	VStack,
	matchesKey,
	type SelectItem,
	type SettingItem,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import type { LLMClient } from "../ai/client.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { MetricsCollector } from "../agent/metrics.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { ToolScheduler } from "../agent/scheduler.ts";
import { createAskTool } from "../agent/tools/ask.ts";
import type { ToolRegistry } from "../agent/tools/index.ts";
import type { AgentEvent, RunMode, ToolCallInfo } from "../events.ts";
import { createTuiAskUser } from "./ask.ts";
import { TuiPermissionRequester } from "./permission.ts";
import { colors, editorTheme, markdownTheme, selectListTheme, settingsListTheme } from "./theme.ts";

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

interface ToolState {
	call: ToolCallInfo;
	started: boolean;
	done?: { ok: boolean; durationMs: number; output?: string; error?: string };
}

/**
 * 聊天 TUI（设计方案 §23/§24/§26/§27）：事件流的唯一渲染端，不持有业务状态。
 * 渲染 = 从事件日志全量重建 transcript（/ui 折叠切换、未来 WebUI snapshot 共用同一推导逻辑）。
 */
export class TuiApp {
	readonly editor: Editor;
	private readonly tui: TuiAltScreen;
	private readonly transcript = new Container();
	private readonly header = new Text("", 1, 0);
	private readonly scheduler: ToolScheduler;
	private readonly signalHolder: { signal?: AbortSignal } = {};
	private events: AgentEvent[] = [];
	private metrics = new MetricsCollector();
	private messages: Message[] = [];
	private mode: RunMode = "default";
	private askUserEnabled = true;
	private expandThinking = false;
	private expandTools = false;
	private streaming = false;
	private running = false;
	private abortController: AbortController | null = null;
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

		const slashCommands: SlashCommand[] = [
			{ name: "/mode", description: "切换 Default / Full Access 模式" },
			{ name: "/ask-user", description: "开关 ask_user 工具" },
			{ name: "/ui", description: "界面设置（思考/工具详情）" },
			{ name: "/clear", description: "清空当前会话" },
			{ name: "/help", description: "显示帮助" },
		];
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(slashCommands, opts.workspace, null),
		);

		const ask = createTuiAskUser({
			tui: this.tui,
			emit: (e) => this.onEvent(e),
			restoreFocus: () => this.tui.setFocus(this.editor),
			onDialogOpenChange: (open) => {
				this.dialogOpen = open;
			},
		});
		opts.registry.register(createAskTool(ask));

		// ctx.signal 走 getter 桥接 signalHolder：每轮任务的 AbortController 动态挂载，工具可感知中断
		// （getter 内 this 指向 ctx 对象，故先捕获 holder 引用）
		const signalHolder = this.signalHolder;
		this.scheduler = new ToolScheduler(
			opts.registry,
			new TuiPermissionRequester(
				this.tui,
				(e) => this.onEvent(e),
				() => this.tui.setFocus(this.editor),
				(open) => {
					this.dialogOpen = open;
				},
			),
			(e) => this.onEvent(e),
			{
				workspace: opts.workspace,
				getMode: () => this.mode,
				get signal() {
					return signalHolder.signal;
				},
			},
		);

		this.tui.setLayoutRoot(
			new VStack([
				{ component: this.header, basis: "auto", shrink: 0 },
				{
					component: new ScrollView(this.transcript, { follow: "end", primary: true }),
					basis: 0,
					grow: 1,
					minSize: 3,
				},
				{ component: this.editor, basis: "auto", shrink: 1 },
			]),
		);

		this.tui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c")) {
				this.tui.stop();
				process.exit(0);
			}
			if (matchesKey(data, "escape") && this.running && !this.dialogOpen) this.interrupt();
			return undefined;
		});
	}

	start(): void {
		this.onEvent({
			type: "session_started",
			sessionId: this.opts.sessionId,
			workspace: this.opts.workspace,
			mode: this.mode,
		});
		this.tui.setFocus(this.editor);
		this.tui.start();
	}

	private refreshHeader(): void {
		const modeLabel =
			this.mode === "default" ? colors.green("Default 模式") : colors.yellow("Full Access 模式");
		const askLabel = this.askUserEnabled ? colors.dim("提问 开") : colors.dim("提问 关");
		this.header.setText(
			`${colors.bold("mini-coding-agent")}${colors.dim(" · ")}${this.opts.workspace}${colors.dim(" · ")}${modeLabel}${colors.dim(" · ")}${askLabel}`,
		);
		this.tui.requestRender();
	}

	private interrupt(): void {
		this.abortController?.abort();
		this.transcript.addChild(new Text(colors.yellow("· 已请求中断，等待收尾…"), 1, 0));
		this.tui.requestRender();
	}

	private handleSubmit(raw: string): void {
		const text = raw.trim();
		if (!text) return;
		if (this.running) {
			this.transcript.addChild(new Text(colors.red("任务进行中，请先按 Esc 中断再输入"), 1, 0));
			this.tui.requestRender();
			return;
		}
		if (text.startsWith("/")) {
			this.handleCommand(text);
			return;
		}
		void this.runTurn(text);
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
				this.messages = [];
				this.events = [];
				this.metrics = new MetricsCollector();
				this.transcript.clear();
				this.transcript.addChild(new Text(colors.dim("会话已清空"), 1, 0));
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
		if (this.running) {
			this.transcript.addChild(new Text(colors.yellow("任务进行中无法切换模式，请先按 Esc 中断"), 1, 0));
			this.tui.requestRender();
			return;
		}
		const items: SelectItem[] = [
			{ value: "default", label: "Default 模式（限制在 Workspace，write/bash 需批准）" },
			{ value: "full_access", label: "Full Access 模式（解除边界与审批）" },
		];
		const list = new SelectList(items, items.length, selectListTheme);
		list.setSelectedIndex(this.mode === "default" ? 0 : 1);
		const handle = this.tui.showOverlay(new VStack([new Text("选择模式", 1, 0), list]));
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
			if (next !== this.mode) {
				this.mode = next;
				this.opts.modeRef.mode = next;
				this.onEvent({ type: "mode_changed", mode: next });
			}
		};
		list.onCancel = done;
	}

	private showAskUserDialog(): void {
		const items: SelectItem[] = [
			{ value: "on", label: "开启（模型可使用 ask_user 提问）" },
			{ value: "off", label: "关闭（从模型可见工具中移除）" },
		];
		const list = new SelectList(items, items.length, selectListTheme);
		list.setSelectedIndex(this.askUserEnabled ? 0 : 1);
		const handle = this.tui.showOverlay(new VStack([new Text("ask_user 工具", 1, 0), list]));
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
			if (next !== this.askUserEnabled) {
				this.askUserEnabled = next;
				this.onEvent({ type: "ask_user_toggled", enabled: next });
			}
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
		handle = this.tui.showOverlay(new VStack([new Text("界面设置", 1, 0), list]));
		this.dialogOpen = true;
		this.tui.setFocus(list);
	}

	private async runTurn(text: string): Promise<void> {
		this.running = true;
		this.abortController = new AbortController();
		this.signalHolder.signal = this.abortController.signal;

		this.messages.push({ role: "user", content: text, timestamp: Date.now() });
		this.onEvent({
			type: "user_message_added",
			messageId: `user-${Date.now().toString(36)}`,
			content: text,
			timestamp: Date.now(),
		});

		const context: Context = {
			systemPrompt: buildSystemPrompt(this.opts.workspace, this.mode),
			messages: this.messages,
			tools: this.opts.registry.list({ askUser: this.askUserEnabled }),
		};
		try {
			await runAgentLoop(context, {
				client: this.opts.client,
				scheduler: this.scheduler,
				emit: (e) => this.onEvent(e),
				signal: this.abortController.signal,
			});
		} finally {
			this.running = false;
			this.abortController = null;
			this.signalHolder.signal = undefined;
		}
	}

	private onEvent(e: AgentEvent): void {
		this.events.push(e);
		this.metrics.onEvent(e);
		if (e.type === "assistant_started") this.streaming = true;
		if (e.type === "assistant_completed" || e.type === "turn_completed") this.streaming = false;
		this.rebuildTranscript();
		this.refreshHeader();
	}

	/** 渲染 = fold(事件日志)：唯一构建 UI 状态的方式，与折叠开关、未来 WebUI snapshot 共用 */
	private rebuildTranscript(): void {
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		this.transcript.clear();

		// 工具调用终态预计算（按事件顺序推导）
		const tools = new Map<string, ToolState>();
		for (const e of this.events) {
			if (e.type === "tool_queued") tools.set(e.call.callId, { call: e.call, started: false });
		}
		for (const e of this.events) {
			if (e.type === "tool_started") {
				const t = tools.get(e.callId);
				if (t) t.started = true;
			} else if (e.type === "tool_completed") {
				const t = tools.get(e.callId);
				if (t) t.done = { ok: e.ok, durationMs: e.durationMs, output: e.output, error: e.error };
			}
		}

		for (const e of this.events) {
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
				case "permission_required":
					this.transcript.addChild(new Text(colors.yellow(`? 权限请求：${e.summary}`), 1, 0));
					break;
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
					const m = this.metrics;
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

		if (!this.events.some((e) => e.type === "user_message_added")) {
			this.transcript.addChild(new Text(colors.dim(WELCOME), 1, 0));
		}
		if (this.streaming) {
			this.loader = new Loader(this.tui, colors.cyan, colors.dim, "生成中…");
			this.transcript.addChild(this.loader);
		}
		this.tui.requestRender();
	}
}
