// 时间线渲染：全部使用 AI Elements 组件（conversation/message/tool/reasoning/confirmation/loader）
import {
	Confirmation,
	ConfirmationAccepted,
	ConfirmationAction,
	ConfirmationActions,
	ConfirmationRejected,
	ConfirmationRequest,
	ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
	Tool,
	ToolContent,
	ToolHeader,
	type ToolHeaderProps,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useState, type FormEvent } from "react";
import { Streamdown } from "streamdown";
import type { PermissionDecision, TimelineItem } from "./protocol.ts";

export interface ConversationActions {
	respondPermission(requestId: string, decision: PermissionDecision): void;
	respondAsk(callId: string, answer: string): void;
}

function PermissionCard({ item, actions }: { item: Extract<TimelineItem, { kind: "tool" }>; actions: ConversationActions }) {
	const permission = item.permission;
	if (!permission) return null;
	// 事件模型 → Confirmation 状态机映射：
	// pending → approval-requested；allow → approval-responded+approved；deny → output-denied
	const state = permission.pending
		? ("approval-requested" as const)
		: permission.decision === "deny"
			? ("output-denied" as const)
			: ("approval-responded" as const);
	const approval = { id: permission.requestId, approved: permission.decision ? permission.decision !== "deny" : undefined };
	return (
		<Confirmation state={state} approval={approval} className="mb-2">
			<ConfirmationTitle>
				{permission.pending ? "权限请求" : null} {permission.summary}
			</ConfirmationTitle>
			<ConfirmationRequest>
				<ConfirmationActions>
					<ConfirmationAction variant="outline" onClick={() => actions.respondPermission(permission.requestId, "deny")}>
						拒绝
					</ConfirmationAction>
					<ConfirmationAction variant="outline" onClick={() => actions.respondPermission(permission.requestId, "allow_session")}>
						本次会话均允许
					</ConfirmationAction>
					<ConfirmationAction onClick={() => actions.respondPermission(permission.requestId, "allow_once")}>
						允许一次
					</ConfirmationAction>
				</ConfirmationActions>
			</ConfirmationRequest>
			<ConfirmationAccepted>
				<p className="text-muted-foreground text-sm">✓ 已允许（{permission.decision === "allow_session" ? "本会话" : "一次"}）</p>
			</ConfirmationAccepted>
			<ConfirmationRejected>
				<p className="text-muted-foreground text-sm">× 已拒绝</p>
			</ConfirmationRejected>
		</Confirmation>
	);
}

function AskCard({ item, actions }: { item: Extract<TimelineItem, { kind: "ask" }>; actions: ConversationActions }) {
	const [custom, setCustom] = useState("");
	const submitCustom = (e: FormEvent) => {
		e.preventDefault();
		if (custom.trim()) actions.respondAsk(item.callId, custom.trim());
	};
	return (
		<div className="mb-2 rounded-md border p-3">
			<p className="text-sm font-medium">Agent 提问：{item.question}</p>
			{item.pending ? (
				<div className="mt-2 space-y-2">
					<div className="flex flex-wrap gap-2">
						{item.options.map((option) => (
							<Button key={option} size="sm" variant="outline" onClick={() => actions.respondAsk(item.callId, option)}>
								{option}
							</Button>
						))}
					</div>
					<form className="flex gap-2" onSubmit={submitCustom}>
						<Input
							value={custom}
							onChange={(e) => setCustom(e.target.value)}
							placeholder="自定义输入…"
							className="h-8 text-sm"
						/>
						<Button size="sm" type="submit">
							提交
						</Button>
					</form>
				</div>
			) : (
				<p className="mt-1 text-muted-foreground text-sm">↩ 回答：{item.answer}</p>
			)}
		</div>
	);
}

export function Timeline({
	items,
	streaming,
	actions,
}: {
	items: TimelineItem[];
	streaming: boolean;
	actions: ConversationActions;
}) {
	return (
		<Conversation className="h-full">
			<ConversationContent className="mx-auto w-full max-w-3xl px-4 pb-8">
				{items.length === 0 && !streaming ? (
					<ConversationEmptyState
						title="mini-coding-agent"
						description="输入任务开始。write / bash 会请求你的批准；模型可通过 ask_user 向你提问。"
					/>
				) : null}
				{items.map((item, index) => {
					switch (item.kind) {
						case "user":
							return (
								<Message key={`u${index}`} from="user">
									<MessageContent className="rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
										{item.content}
									</MessageContent>
								</Message>
							);
						case "assistant":
							return (
								<Message key={`a${index}`} from="assistant">
									{item.thinking ? (
										<Reasoning duration={item.thinkingSec} className="mb-1">
											<ReasoningTrigger />
											<ReasoningContent>{item.thinking}</ReasoningContent>
										</Reasoning>
									) : null}
									{item.text.trim() ? (
										<MessageContent className="text-sm">
											<Streamdown>{item.text}</Streamdown>
										</MessageContent>
									) : null}
								</Message>
							);
						case "tool":
							return (
								<div key={`t${index}`} className="mb-3">
									<PermissionCard item={item} actions={actions} />
									{item.state !== "output-error" || !item.permission?.decision || item.permission.decision !== "deny" ? (
										<Tool>
											<ToolHeader
												type="dynamic-tool"
												toolName={item.label}
												title={item.label}
												state={item.state as ToolHeaderProps["state"]}
											/>
											<ToolContent>
												<ToolInput input={item.args} />
												<ToolOutput
													output={item.state === "output-available" ? `${item.output ?? ""}${item.durationMs != null ? `\n(${item.durationMs}ms)` : ""}` : undefined}
													errorText={item.state === "output-error" ? item.error : undefined}
												/>
											</ToolContent>
										</Tool>
									) : null}
								</div>
							);
						case "ask":
							return <AskCard key={`k${index}`} item={item} actions={actions} />;
						case "error":
							return (
								<p key={`e${index}`} className="text-destructive text-sm">
									✗ {item.message}
								</p>
							);
						case "summary": {
							const parts: string[] = [];
							if (item.cachePct != null) parts.push(`cache ${item.cachePct}%`);
							if (item.toolsTotal > 0) parts.push(`tools ${item.toolsOk}/${item.toolsTotal}`);
							if (item.denied > 0) parts.push(`deny ${item.denied}`);
							if (parts.length === 0) return null;
							return (
								<p key={`s${index}`} className={cn("text-muted-foreground mb-3 text-xs")}>
									— {parts.join(" · ")} —
								</p>
							);
						}
						default:
							return null;
					}
				})}
				{streaming ? (
					<div className="text-muted-foreground flex items-center gap-2 text-sm">
						<Loader size={14} />
						生成中…
					</div>
				) : null}
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	);
}
