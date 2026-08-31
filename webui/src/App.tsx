// WebUI 主应用：左侧会话栏 + 右侧对话区（设计方案 §28-§33）。
// 全部状态由下行事件流推导（snapshot 重建 + 增量事件），前端不持有业务状态。
import { PromptInput, PromptInputBody, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Plus, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Timeline } from "./Conversation.tsx";
import {
	appendEvent,
	buildTimeline,
	deriveRunning,
	type AgentEvent,
	type Downlink,
	type PermissionDecision,
	type RunMode,
	type SessionInfo,
	type Uplink,
} from "./protocol.ts";

interface AppState {
	connected: boolean;
	sessionId: string;
	mode: RunMode;
	askUserEnabled: boolean;
	events: AgentEvent[];
	sessions: SessionInfo[];
	serverRunning: boolean;
}

export default function App() {
	const [state, setState] = useState<AppState>({
		connected: false,
		sessionId: "",
		mode: "default",
		askUserEnabled: true,
		events: [],
		sessions: [],
		serverRunning: false,
	});
	const socketRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		let stopped = false;
		let retry: ReturnType<typeof setTimeout>;
		const connect = () => {
			const protocol = location.protocol === "https:" ? "wss" : "ws";
			const ws = new WebSocket(`${protocol}://${location.host}/ws`);
			socketRef.current = ws;
			ws.onopen = () => setState((s) => ({ ...s, connected: true }));
			ws.onclose = () => {
				setState((s) => ({ ...s, connected: false }));
				if (!stopped) retry = setTimeout(connect, 2000); // 断线重连，snapshot 兜底恢复
			};
			ws.onmessage = (msg) => {
				const data = JSON.parse(String(msg.data)) as Downlink;
				if (data.type === "snapshot") {
					setState((s) => ({
						...s,
						sessionId: data.sessionId,
						mode: data.mode,
						askUserEnabled: data.askUserEnabled,
						events: data.events,
						serverRunning: data.running,
					}));
				} else if (data.type === "session_list") {
					setState((s) => ({ ...s, sessions: data.sessions }));
				} else {
					setState((s) => ({ ...s, events: appendEvent(s.events, data) }));
				}
			};
		};
		connect();
		return () => {
			stopped = true;
			clearTimeout(retry);
			socketRef.current?.close();
		};
	}, []);

	const send = useCallback((message: Uplink) => {
		if (socketRef.current?.readyState === WebSocket.OPEN) {
			socketRef.current.send(JSON.stringify(message));
		}
	}, []);

	const running = state.serverRunning || deriveRunning(state.events);
	const streaming = useMemo(() => {
		let streaming = false;
		for (const e of state.events) {
			if (e.type === "assistant_started") streaming = true;
			if (e.type === "assistant_completed" || e.type === "turn_completed" || e.type === "agent_error") streaming = false;
		}
		return streaming;
	}, [state.events]);
	const items = useMemo(() => buildTimeline(state.events), [state.events]);
	const metrics = useMemo(() => {
		let turns = 0;
		let denom = 0;
		let cacheRead = 0;
		let ok = 0;
		let failed = 0;
		for (const e of state.events) {
			if (e.type === "assistant_completed" && e.usage) {
				turns += 1;
				denom += e.usage.input + e.usage.cacheRead + e.usage.cacheWrite;
				cacheRead += e.usage.cacheRead;
			}
			if (e.type === "tool_completed") (e.ok ? ok++ : failed++);
		}
		return { cachePct: turns > 0 && denom > 0 ? Math.round((cacheRead / denom) * 100) : null, ok, total: ok + failed };
	}, [state.events]);

	const actions = useMemo(
		() => ({
			respondPermission: (requestId: string, decision: PermissionDecision) => send({ type: "permission_response", requestId, decision }),
			respondAsk: (callId: string, answer: string) => send({ type: "ask_user_response", callId, answer }),
		}),
		[send],
	);

	return (
		<div className="bg-background text-foreground flex h-screen">
			<aside className="bg-muted/30 border-border flex w-60 shrink-0 flex-col border-r">
				<div className="border-border flex items-center justify-between border-b px-4 py-3">
					<span className="text-sm font-semibold">mini-coding-agent</span>
					<Badge variant={state.connected ? "secondary" : "destructive"} className="text-[10px]">
						{state.connected ? "已连接" : "连接中"}
					</Badge>
				</div>
				<div className="p-2">
					<Button className="w-full justify-start gap-2" size="sm" variant="outline" onClick={() => send({ type: "session_new" })}>
						<Plus className="size-4" />
						新建会话
					</Button>
				</div>
				<nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
					{state.sessions.map((session) => (
						<button
							key={session.id}
							type="button"
							onClick={() => send({ type: "session_load", sessionId: session.id })}
							className={cn(
								"hover:bg-muted w-full truncate rounded-md px-3 py-2 text-left text-sm",
								session.id === state.sessionId ? "bg-muted font-medium" : "text-muted-foreground",
							)}
							title={session.title}
						>
							{session.title}
						</button>
					))}
				</nav>
				<div className="border-border text-muted-foreground border-t px-4 py-2 text-xs">Workspace：本地工作目录</div>
			</aside>

			<main className="flex min-w-0 flex-1 flex-col">
				<header className="border-border flex h-12 items-center gap-2 border-b px-4">
					<Button
						size="sm"
						variant={state.mode === "default" ? "default" : "outline"}
						onClick={() => send({ type: "mode_change", mode: state.mode === "default" ? "full_access" : "default" })}
					>
						{state.mode === "default" ? "Default 模式" : "Full Access 模式"}
					</Button>
					<Button
						size="sm"
						variant={state.askUserEnabled ? "secondary" : "outline"}
						onClick={() => send({ type: "ask_user_toggle", enabled: !state.askUserEnabled })}
					>
						提问：{state.askUserEnabled ? "开" : "关"}
					</Button>
					<div className="ml-auto flex items-center gap-2">
						{metrics.cachePct != null ? <Badge variant="secondary">cache {metrics.cachePct}%</Badge> : null}
						{metrics.total > 0 ? (
							<Badge variant="secondary">
								tools {metrics.ok}/{metrics.total}
							</Badge>
						) : null}
						{running ? (
							<Button size="sm" variant="destructive" className="gap-1" onClick={() => send({ type: "interrupt" })}>
								<Square className="size-3" />
								中断
							</Button>
						) : null}
					</div>
				</header>

				<div className="min-h-0 flex-1">
					<Timeline items={items} streaming={streaming} actions={actions} />
				</div>

				<div className="border-border border-t p-3">
					<PromptInput
						className="mx-auto max-w-3xl"
						onSubmit={(message) => {
							const text = (message.text ?? "").trim();
							if (text) send({ type: "user_message", text });
						}}
					>
						<PromptInputBody>
							<PromptInputTextarea placeholder={running ? "任务执行中（Esc 不可用，可点右上中断）…" : "输入任务，Enter 发送，Shift+Enter 换行"} />
						</PromptInputBody>
						<PromptInputSubmit status={running ? "streaming" : undefined} onStop={() => send({ type: "interrupt" })} />
					</PromptInput>
				</div>
			</main>
		</div>
	);
}
