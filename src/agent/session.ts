// AgentSession：共享会话核心。TUI 与 WebUI 消费同一编排（runTurn/模式/开关/中断/事件日志），
// 前端形态（终端组件 or WebSocket）只体现在注入的 hooks 上。
import type { Context, Message } from "@earendil-works/pi-ai";
import type { LLMClient } from "../ai/client.ts";
import type { AgentEvent, PermissionDecision, RunMode, ToolCallInfo } from "../events.ts";
import { runAgentLoop } from "./loop.ts";
import { MetricsCollector } from "./metrics.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { ToolScheduler } from "./scheduler.ts";
import { createAskTool } from "./tools/ask.ts";
import type { ToolRegistry } from "./tools/index.ts";

export interface SessionHooks {
	requestPermission(call: ToolCallInfo, summary: string): Promise<PermissionDecision>;
	askUser(question: string, options: string[]): Promise<string>;
	/** 事件出口：UI 渲染 / WS 广播 / 持久化都挂这里（Session 内部同时维护事件日志与指标） */
	onEvent(e: AgentEvent): void;
}

export class AgentSession {
	readonly events: AgentEvent[] = [];
	readonly messages: Message[] = [];
	readonly modeRef: { mode: RunMode };
	metrics = new MetricsCollector();
	askUserEnabled = true;
	running = false;
	private abortController: AbortController | null = null;
	private readonly signalHolder: { signal?: AbortSignal } = {};
	private readonly scheduler: ToolScheduler;

	constructor(
		private readonly opts: {
			client: LLMClient;
			registry: ToolRegistry;
			workspace: string;
			sessionId: string;
			hooks: SessionHooks;
			/** 外部共享的模式引用（工具 env 的 getMode 与 Session 必须指向同一状态） */
			modeRef?: { mode: RunMode };
		},
	) {
		this.modeRef = opts.modeRef ?? { mode: "default" };
		const { hooks } = opts;
		opts.registry.register(createAskTool((q, o) => hooks.askUser(q, o)));

		// ctx.signal 走 getter 桥接：每轮任务的 AbortController 动态挂载，工具可感知中断
		const signalHolder = this.signalHolder;
		this.scheduler = new ToolScheduler(
			opts.registry,
			{ request: (call, summary) => hooks.requestPermission(call, summary) },
			(e) => this.emit(e),
			{
				workspace: opts.workspace,
				getMode: () => this.modeRef.mode,
				get signal() {
					return signalHolder.signal;
				},
			},
		);
	}

	get id(): string {
		return this.opts.sessionId;
	}

	get workspace(): string {
		return this.opts.workspace;
	}

	emit(e: AgentEvent): void {
		this.events.push(e);
		this.metrics.onEvent(e);
		this.opts.hooks.onEvent(e);
	}

	setMode(mode: RunMode): void {
		if (this.modeRef.mode === mode) return;
		this.modeRef.mode = mode;
		this.emit({ type: "mode_changed", mode });
	}

	toggleAskUser(enabled: boolean): void {
		if (this.askUserEnabled === enabled) return;
		this.askUserEnabled = enabled;
		this.emit({ type: "ask_user_toggled", enabled });
	}

	interrupt(): void {
		this.abortController?.abort();
	}

	reset(): void {
		this.messages.length = 0;
		this.events.length = 0;
		this.metrics = new MetricsCollector();
	}

	async runTurn(text: string): Promise<void> {
		this.running = true;
		this.abortController = new AbortController();
		this.signalHolder.signal = this.abortController.signal;

		this.messages.push({ role: "user", content: text, timestamp: Date.now() });
		this.emit({
			type: "user_message_added",
			messageId: `user-${Date.now().toString(36)}`,
			content: text,
			timestamp: Date.now(),
		});

		const context: Context = {
			systemPrompt: buildSystemPrompt(this.opts.workspace, this.modeRef.mode),
			messages: this.messages,
			tools: this.opts.registry.list({ askUser: this.askUserEnabled }),
		};
		try {
			await runAgentLoop(context, {
				client: this.opts.client,
				scheduler: this.scheduler,
				emit: (e) => this.emit(e),
				signal: this.abortController.signal,
			});
		} finally {
			this.running = false;
			this.abortController = null;
			this.signalHolder.signal = undefined;
		}
	}
}
