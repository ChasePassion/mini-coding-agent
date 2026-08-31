// WebUI 服务端（技术方案 §6.2/§8-3.1）：node:http 静态托管 webui/dist + ws 网关。
// 下行：全部 AgentEvent + snapshot/session_list；上行：user_message / permission_response /
// ask_user_response / mode_change / ask_user_toggle / interrupt / session_new / session_load。
// 会话持久化：~/.mini-agent/sessions/<id>/{meta.json, events.jsonl, context.json}。
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMClient } from "../ai/client.ts";
import { AgentSession } from "../agent/session.ts";
import { createDefaultTools } from "../agent/tools/default.ts";
import type { AgentEvent, PermissionDecision, RunMode, ToolCallInfo } from "../events.ts";
import type { ToolEnv } from "../agent/tools/index.ts";

const STORE_ROOT = path.join(os.homedir(), ".mini-agent", "sessions");
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "webui", "dist");
const DEFAULT_PORT = 4162;

interface SessionMeta {
	id: string;
	title: string;
	workspace: string;
	createdAt: number;
	updatedAt: number;
	mode: RunMode;
	askUserEnabled: boolean;
}

interface ManagedSession {
	meta: SessionMeta;
	session: AgentSession;
	dir: string;
	pendingPermissions: Map<string, (decision: PermissionDecision) => void>;
	pendingAsk: Map<string, (answer: string) => void>;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

export async function startWebServer(opts: { client: LLMClient; workspace: string; port?: number }): Promise<void> {
	const port = opts.port ?? (Number(process.env.MINI_AGENT_PORT) || DEFAULT_PORT);
	await mkdir(STORE_ROOT, { recursive: true });
	const sockets = new Set<WebSocket>();
	const loaded = new Map<string, ManagedSession>();
	let active: ManagedSession;

	const broadcast = (payload: unknown): void => {
		const text = JSON.stringify(payload);
		for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(text);
	};

	const saveMeta = async (m: ManagedSession): Promise<void> => {
		m.meta.updatedAt = Date.now();
		m.meta.mode = m.session.modeRef.mode;
		m.meta.askUserEnabled = m.session.askUserEnabled;
		await writeFile(path.join(m.dir, "meta.json"), JSON.stringify(m.meta, null, "\t"), "utf8");
	};

	const createManaged = async (id: string, restore?: { events: AgentEvent[]; messages: unknown[]; meta: SessionMeta }): Promise<ManagedSession> => {
		const dir = path.join(STORE_ROOT, id);
		await mkdir(dir, { recursive: true });
		const modeRef: { mode: RunMode } = { mode: restore?.meta.mode ?? "default" };
		const env: ToolEnv = { workspace: opts.workspace, getMode: () => modeRef.mode };
		const managed: ManagedSession = {
			meta: restore?.meta ?? {
				id,
				title: "新会话",
				workspace: opts.workspace,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				mode: "default",
				askUserEnabled: true,
			},
			session: undefined as never,
			dir,
			pendingPermissions: new Map(),
			pendingAsk: new Map(),
		};
		const session = new AgentSession({
			client: opts.client,
			registry: createDefaultTools(env),
			workspace: opts.workspace,
			sessionId: id,
			modeRef,
			hooks: {
				requestPermission: (call: ToolCallInfo, summary: string) =>
					new Promise<PermissionDecision>((resolve) => {
						managed.pendingPermissions.set(call.callId, resolve);
						// permission_required 由请求方发出（§6.4），permission_resolved 由 Scheduler 发出
						session.emit({ type: "permission_required", requestId: call.callId, call, summary });
					}),
				askUser: (question, options) =>
					new Promise<string>((resolve) => {
						const callId = `ask-${Date.now().toString(36)}`;
						managed.pendingAsk.set(callId, resolve);
						session.emit({ type: "user_input_requested", callId, question, options });
					}),
				onEvent: (e: AgentEvent) => {
					broadcast(e);
					void appendFile(path.join(managed.dir, "events.jsonl"), `${JSON.stringify(e)}\n`, "utf8").catch(() => {});
					if (e.type === "user_message_added" && managed.meta.title === "新会话") {
						managed.meta.title = e.content.slice(0, 24) || "新会话";
					}
					if (e.type === "turn_completed") {
						// 持久化上下文快照（pi-ai 的 Message 均为可序列化纯数据）
						void writeFile(
							path.join(managed.dir, "context.json"),
							JSON.stringify(session.messages),
							"utf8",
						).catch(() => {});
						void saveMeta(managed);
						void sendSessionList();
					}
					if (e.type === "mode_changed" || e.type === "ask_user_toggled") void saveMeta(managed);
				},
			},
		});
		managed.session = session;
		if (restore) {
			for (const e of restore.events) {
				session.events.push(e);
				session.metrics.onEvent(e);
			}
			(session.messages as unknown[]).push(...(restore.messages ?? []));
		} else {
			session.emit({ type: "session_started", sessionId: id, workspace: opts.workspace, mode: modeRef.mode });
		}
		await saveMeta(managed);
		return managed;
	};

	const listSessions = async (): Promise<SessionMeta[]> => {
		const result: SessionMeta[] = [];
		if (!existsSync(STORE_ROOT)) return result;
		for (const name of await readdir(STORE_ROOT)) {
			try {
				const raw = await readFile(path.join(STORE_ROOT, name, "meta.json"), "utf8");
				result.push(JSON.parse(raw) as SessionMeta);
			} catch {
				// 跳过损坏的会话目录
			}
		}
		return result.sort((a, b) => b.updatedAt - a.updatedAt);
	};

	const sendSessionList = async (): Promise<void> => {
		broadcast({ type: "session_list", sessions: await listSessions() });
	};

	const loadSession = async (id: string): Promise<ManagedSession> => {
		const existing = loaded.get(id);
		if (existing) return existing;
		const dir = path.join(STORE_ROOT, id);
		const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as SessionMeta;
		const events: AgentEvent[] = [];
		try {
			const lines = (await readFile(path.join(dir, "events.jsonl"), "utf8")).split("\n").filter(Boolean);
			for (const line of lines) events.push(JSON.parse(line) as AgentEvent);
		} catch {
			// 无事件文件则从空开始
		}
		let messages: unknown[] = [];
		try {
			messages = JSON.parse(await readFile(path.join(dir, "context.json"), "utf8")) as unknown[];
		} catch {
			// 无上下文则从空开始
		}
		const managed = await createManaged(id, { events, messages, meta });
		loaded.set(id, managed);
		return managed;
	};

	const sendSnapshot = (ws: WebSocket): void => {
		const s = active.session;
		ws.send(
			JSON.stringify({
				type: "snapshot",
				sessionId: active.meta.id,
				mode: s.modeRef.mode,
				askUserEnabled: s.askUserEnabled,
				running: s.running,
				events: s.events,
			}),
		);
		// 刷新恢复：重发 pending 权限/提问，避免弹窗等待中刷新导致 agent 挂起（技术方案 §10）
		for (const [requestId] of active.pendingPermissions) {
			const req = s.events.find((e) => e.type === "permission_required" && e.requestId === requestId);
			if (req?.type === "permission_required") ws.send(JSON.stringify(req));
		}
		for (const [callId] of active.pendingAsk) {
			const req = s.events.findLast((e) => e.type === "user_input_requested" && e.callId === callId);
			if (req?.type === "user_input_requested") ws.send(JSON.stringify(req));
		}
	};

	// —— HTTP：静态托管 webui/dist（SPA 回退 index.html） ——
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://localhost");
			let filePath = path.join(DIST_DIR, url.pathname === "/" ? "index.html" : url.pathname);
			if (!filePath.startsWith(DIST_DIR)) {
				res.writeHead(403).end("Forbidden");
				return;
			}
			if (!existsSync(filePath) || url.pathname.endsWith("/")) filePath = path.join(DIST_DIR, "index.html");
			try {
				const data = await readFile(filePath);
				res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
				res.end(data);
			} catch {
				res.writeHead(404).end("Not Found（请先构建前端：cd webui && npm run build）");
			}
		})();
	});

	const wss = new WebSocketServer({ server, path: "/ws" });
	wss.on("connection", (ws: WebSocket) => {
		sockets.add(ws);
		void sendSnapshot(ws);
		void sendSessionList();
		ws.on("message", (data) => {
			void (async () => {
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(String(data));
				} catch {
					return;
				}
				const s = active.session;
				switch (msg.type) {
					case "user_message": {
						const text = String(msg.text ?? "").trim();
						if (!text || s.running) return;
						await s.runTurn(text);
						return;
					}
					case "permission_response": {
						const requestId = String(msg.requestId);
						const resolve = active.pendingPermissions.get(requestId);
						if (resolve) {
							active.pendingPermissions.delete(requestId);
							resolve(msg.decision as PermissionDecision);
						}
						return;
					}
					case "ask_user_response": {
						const callId = String(msg.callId);
						const resolve = active.pendingAsk.get(callId);
						if (resolve) {
							active.pendingAsk.delete(callId);
							resolve(String(msg.answer ?? ""));
						}
						return;
					}
					case "mode_change":
						s.setMode(msg.mode as RunMode);
						return;
					case "ask_user_toggle":
						s.toggleAskUser(Boolean(msg.enabled));
						return;
					case "interrupt":
						s.interrupt();
						return;
					case "session_new": {
						const id = `session-${Date.now().toString(36)}`;
						active = await createManaged(id);
						loaded.set(id, active);
						for (const ws2 of sockets) sendSnapshot(ws2);
						void sendSessionList();
						return;
					}
					case "session_load": {
						const id = String(msg.sessionId);
						try {
							active = await loadSession(id);
						} catch {
							ws.send(JSON.stringify({ type: "agent_error", message: `会话不存在或已损坏：${id}` }));
							return;
						}
						for (const ws2 of sockets) sendSnapshot(ws2);
						return;
					}
					default:
						return;
				}
			})();
		});
		ws.on("close", () => sockets.delete(ws));
	});

	active = await createManaged(`session-${Date.now().toString(36)}`);
	loaded.set(active.meta.id, active);

	server.listen(port, () => {
		console.log(`mini-coding-agent WebUI: http://localhost:${port}（Workspace: ${opts.workspace}）`);
	});
}
