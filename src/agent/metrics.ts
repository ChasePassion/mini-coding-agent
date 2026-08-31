// MetricsCollector（§6.7）：纯事件消费者，无 IO。TUI 进程内 / WebUI 前端各自实例化喂同一事件流。
import type { AgentEvent } from "../events.ts";

export interface ToolMetrics {
	ok: number;
	failed: number;
	denied: number; // 用户拒绝单独计数，不计入失败率
}

export class MetricsCollector {
	tools: ToolMetrics = { ok: 0, failed: 0, denied: 0 };
	usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	turns = 0;

	onEvent(ev: AgentEvent): void {
		if (ev.type === "assistant_completed" && ev.usage) {
			this.turns++;
			for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				this.usage[k] += ev.usage[k];
			}
		}
		if (ev.type === "tool_completed") {
			if (ev.ok) this.tools.ok++;
			else this.tools.failed++;
		}
		if (ev.type === "permission_resolved" && ev.decision === "deny") this.tools.denied++;
	}

	// 命中率分母 = 三类输入 token 之和（pi-ai 的 Usage 中 input 与 cache 字段分立，Anthropic 语义）
	get cacheHitRate(): number {
		const denom = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
		return denom === 0 ? 0 : this.usage.cacheRead / denom;
	}

	get toolSuccessRate(): number {
		const n = this.tools.ok + this.tools.failed;
		return n === 0 ? 1 : this.tools.ok / n;
	}
}
