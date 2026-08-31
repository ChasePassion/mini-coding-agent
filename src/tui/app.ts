import type { Context, Message } from "@earendil-works/pi-ai";
import {
	Container,
	Editor,
	Loader,
	Markdown,
	ProcessTerminal,
	ScrollView,
	SelectList,
	Text,
	TuiAltScreen,
	VStack,
	matchesKey,
	type SelectItem,
} from "@earendil-works/pi-tui";
import type { LLMClient } from "../ai/client.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { ToolScheduler } from "../agent/scheduler.ts";
import type { ToolRegistry } from "../agent/tools/index.ts";
import type { AgentEvent, RunMode, ToolCallInfo } from "../events.ts";
import { TuiPermissionRequester } from "./permission.ts";
import { colors, editorTheme, markdownTheme, selectListTheme } from "./theme.ts";

const HELP_MARKDOWN = [
	"**命令**",
	"- `/mode` — 切换 Default / Full Access 模式",
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

interface ToolRow {
	row: Text;
	label: string;
}

function toolLabel(call: ToolCallInfo): string {
	switch (call.toolName) {
		case "read":
		case "write":
		case "list":
			return `${call.toolName} ${String(call.args.path ?? "")}`.trim();
		case "bash":
			return `bash: ${String(call.args.command ?? "").slice(0, 60)}`;
		default:
			return call.toolName;
	}
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 聊天 TUI（设计方案 §23/§24/§25/§27）：事件流的唯一渲染端，不持有业务状态。 */
export class TuiApp {
	readonly editor: Editor;
	private readonly tui: TuiAltScreen;
	private readonly transcript = new Container();
	private readonly header = new Text("", 1, 0);
	private readonly toolRows = new Map<string, ToolRow>();
	private readonly scheduler: ToolScheduler;
	private readonly signalHolder: { signal?: AbortSignal } = {};
	private messages: Message[] = [];
	private mode: RunMode = "default";
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
		this.refreshHeader();
		this.transcript.addChild(
			new Text(colors.dim("输入任务开始。/help 查看帮助 · Esc 中断 · Ctrl+C 退出"), 1, 0),
		);
		this.onEvent({ type: "session_started", sessionId: this.opts.sessionId, workspace: this.opts.workspace, mode: this.mode });
		this.tui.setFocus(this.editor);
		this.tui.start();
	}

	private refreshHeader(): void {
		const modeLabel =
			this.mode === "default" ? colors.green("Default 模式") : colors.yellow("Full Access 模式");
		this.header.setText(
			`${colors.bold("mini-coding-agent")}${colors.dim(" · ")}${this.opts.workspace}${colors.dim(" · ")}${modeLabel}`,
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
			case "/clear":
				this.messages = [];
				this.toolRows.clear();
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
					new Text(colors.yellow(`未知命令 ${text}，可用：/mode /clear /help`), 1, 0),
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
			tools: this.opts.registry.list(),
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
		switch (e.type) {
			case "session_started":
			case "mode_changed":
				this.refreshHeader();
				return;
			case "user_message_added":
				this.transcript.addChild(new Text(`${colors.bold("❯ ")}${e.content}`, 1, 0));
				break;
			case "assistant_started":
				this.startLoader();
				break;
			case "assistant_delta":
				break; // 流式渲染需完整 Markdown 文本，completed 时一次性展示
			case "assistant_completed":
				this.stopLoader();
				if (e.text.trim()) this.transcript.addChild(new Markdown(e.text, 1, 0, markdownTheme));
				break;
			case "tool_queued": {
				const label = toolLabel(e.call);
				const row = new Text(colors.dim(`· ${label}`), 1, 0);
				this.toolRows.set(e.call.callId, { row, label });
				this.transcript.addChild(row);
				break;
			}
			case "permission_required":
				this.transcript.addChild(new Text(colors.yellow(`? 权限请求：${e.summary}`), 1, 0));
				break;
			case "tool_started": {
				const entry = this.toolRows.get(e.callId);
				if (entry) entry.row.setText(colors.cyan(`◌ ${entry.label}`));
				break;
			}
			case "tool_completed": {
				const entry = this.toolRows.get(e.callId);
				const label = entry?.label ?? e.toolName;
				if (entry) this.toolRows.delete(e.callId);
				const line = e.ok
					? colors.green(`✓ ${label} (${e.durationMs}ms)`)
					: colors.red(`× ${label}`);
				if (entry) entry.row.setText(line);
				else this.transcript.addChild(new Text(line, 1, 0));
				if (!e.ok && e.error) {
					this.transcript.addChild(new Text(colors.dim(`  ${truncate(e.error.replace(/\n/g, " "), 200)}`), 1, 0));
				}
				break;
			}
			case "agent_error":
				this.stopLoader();
				this.transcript.addChild(new Text(colors.red(`✗ ${e.message}`), 1, 0));
				break;
			case "turn_completed":
				this.stopLoader();
				break;
			default:
				break;
		}
		this.tui.requestRender();
	}

	private startLoader(): void {
		this.stopLoader();
		this.loader = new Loader(this.tui, colors.cyan, colors.dim, "生成中…");
		this.transcript.addChild(this.loader);
	}

	private stopLoader(): void {
		if (this.loader) {
			this.transcript.removeChild(this.loader);
			this.loader.stop();
			this.loader = null;
		}
	}
}
