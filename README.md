# mini-coding-agent

一个最小可用的 Coding Agent：自写 Agent Loop + 四个基础工具（read / write / list / bash）+ ask_user + 并发调度（两级锁 + Bash 预约）+ 权限控制 + TUI。

> 面试项目。产品规格见 [`设计方案.md`](./设计方案.md)，技术设计见 [`技术方案.md`](./技术方案.md)。Phase 1 = 基础 Agent + TUI；Phase 2 = 并发调度 + 权限深化 + ask_user + 指标与界面增强。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 MINIMAX_CN_API_KEY（sk-cp- 前缀的 coding plan Key）
npm start              # 启动时选择 TUI / WebUI（或 npm start -- --interface web）
```

- TUI：`Enter` 发送任务，`Esc` 中断当前任务，`Ctrl+C` 退出
- WebUI：自动打开 `http://localhost:4162`（左侧会话历史 + 右侧对话；权限/ask_user 以卡片交互；刷新后经 snapshot 恢复）
- Slash 命令（TUI，带补全）：`/mode` 切换模式、`/ask-user` 开关 ask_user、`/ui` 展开思考/工具详情、`/clear`、`/help`
- WebUI 前端构建：`cd webui && npm install && npm run build`（产物 `webui/dist`，服务端自动托管）

## 架构

两层架构，Agent 层与前端（TUI / 未来的 WebUI）之间只有一条事件流：

```
┌────────────────────────────────────────────┐
│ TUI（@earendil-works/pi-tui，事件流渲染端） │
└──────────────┬─────────────────────────────┘
               │ AgentEvent（统一事件契约，src/events.ts）
┌──────────────┴─────────────────────────────┐
│ Agent 层                                    │
│  loop.ts       while 循环（stopReason 驱动）│
│  scheduler.ts  权限 + 调度（Phase 1 串行）  │
│  tools/        read / write / list / bash   │
└──────────────┬─────────────────────────────┘
               │ stream(context)（唯一出口）
┌──────────────┴─────────────────────────────┐
│ AI 适配层 src/ai/client.ts（@earendil-works/pi-ai，默认 minimax-cn） │
└────────────────────────────────────────────┘
```

- **AI 适配层**：pi-ai 的执行调用只出现在 `src/ai/client.ts` 一个文件里，换 provider / 换模型 / 离线测试只动这一层。
- **Agent Loop**：`stopReason === "toolUse"` 就继续，否则退出；对权限、并发、锁零感知，全部下沉给 Scheduler。
- **事件模型**：`AgentEvent` 判别联合（会话 / 回合 / 工具调度态与执行态分离 / ask_user / 异常），前端不持有业务状态，一切由事件推导。

## 工具与并发语义（Phase 2 已由 Scheduler 实现）

| 工具 | 权限（Default 模式） | 并发语义 |
| --- | --- | --- |
| `read` | 免批准 | 同文件读并行；分页读取（offset/limit，~10k token 截断 + 续读提示） |
| `write` | 需批准（允许一次 / 本次会话均允许 / 拒绝） | 同文件独占（FIFO，写防饥饿），异文件并行；先批准后加锁 |
| `list` | 免批准 | 与读并行 |
| `bash` | 需批准（同上） | 全局独占：执行期间一切工具排队；先预约执行权再弹权限窗，Deny 立即归还 |
| `ask_user` | 免批准 | 挂起等用户回答期间其他工具照常执行 |

- **两级锁**：全局门（bash 独占 / 其余共享）+ 文件读写锁（read 共享 / write 独占），等待队列严格 FIFO。
- **Bash 预约**（设计方案 §10/§11）：bash 先等所有在途工具结束 → 预约执行权（挡住新工具）→ 请求权限 → 批准后立即独占执行；拒绝立即归还执行资格。用户批准后不会出现"还要排队"的体验。
- **冲突等待而非报错**：并发冲突由 Scheduler 自动排队，模型永远收不到 "File Locked" 类错误。
- 工具 description 面向模型写明上述语义（见 `src/agent/tools/`），模型据此正确发起并行调用；`validateToolArguments`（TypeBox）把模型幻觉参数变成干净的错误结果而不是异常。

## 模式与安全

- **Default 模式**：`read/write/list` 有 Workspace 硬边界（resolve + 前缀检查，越界直接拒绝）；`write/bash` 每次执行前需用户批准，可选「本次会话均允许」。bash 为 best-effort 边界（cwd 固定为 Workspace + 系统提示词声明，可靠沙箱需要容器级隔离，见技术方案 §6.8 的取舍说明）。
- **Full Access 模式**：解除文件边界与审批（`/mode` 切换，仅在两轮任务之间生效）。

## 验证

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # §9.1 离线测试矩阵（node:test，零网络）：并发 C1-C21、指标、read 分页、loop、abort、参数校验
npm run smoke                     # 连通 Key 的一次流式调用
npm run task -- "总结 设计方案.md"          # headless 跑单个任务（事件流带时间戳打印）
npm run task -- "写一个脚本并运行" --auto   # --auto 自动批准权限请求（缺省一律拒绝）
```

Phase 1 验收三案例（设计方案 §37）均已通过：

1. **总结 README.md**（读文件 → 分页续读 → 中文总结）
2. **写 Python 脚本统计 CSV 数据**（权限拒绝路径 + 批准路径均验证）
3. **创建脚本并运行它**（bash 执行 + 结果回填 + 最终答案）

另验证了 Workspace 边界：越界路径（如 `E:/demo/../../Windows/win.ini`）被硬边界拒绝。

Phase 2 专项验证：

- **并行工具调用**：两个 read 同毫秒 `tool_started`，真并发非串行（headless 时间戳可见）
- **ask_user**：模型两次挂起提问 → 回答作为 Tool Result 回填 → loop 继续 → 写文件
- **37 个离线单测**覆盖并发矩阵全部场景（含 Bash 预约竞态 C11-C13、FIFO 批量放行、写防饥饿、锁键归一化、异常/中断不漏锁）

## 界面

**TUI 与 WebUI 消费同一事件流、共享同一会话核心（`AgentSession`）**——前端形态只体现在注入的权限/提问实现上。

- **TUI**：头部（Workspace / 模式 / ask_user 开关）+ 对话流（工具行 `排队 → ◌ → ✓/×`，等待队列可见）+ 输入框上方右侧常驻 cache 命中率
- **WebUI**（AI Elements 组件）：左侧会话历史（新建/切换，持久化于 `~/.mini-agent/sessions/`，含 events.jsonl 与上下文快照）、右侧对话区；工具卡四态（Pending/Running/Completed/Error，可展开参数与输出）、思考过程折叠（Reasoning，带时长）、权限确认卡（Confirmation，三选项）、ask_user 卡（选项 + 自定义输入）、顶栏模式切换/ask_user 开关/指标 chip/中断按钮
- Slash 命令（TUI 带自动补全）：`/mode`、`/ask-user`（OFF 时从模型可见 schema 中移除）、`/ui`（展开思考/工具详情，全量重绘）、`/clear`、`/help`
- 每轮结束打印指标摘要：`— cache 62% · tools 5/6 · deny 1 —`（deny 不计入失败分母）
- `Esc` / 中断按钮触发 AbortSignal（贯穿到 bash 子进程）；刷新 WebUI 后经 snapshot 恢复，pending 的权限/提问会重发，不会挂起 agent

## 录屏说明

开发过程录屏文件后续存放于 `recordings/` 目录（不包含 Key 等敏感信息）。

## Roadmap

- [x] ~~工具并行调用：两级锁（全局门 + 文件读写锁）+ Bash 预约执行权~~（Phase 2 完成）
- [x] ~~`ask_user` 工具与开关~~（Phase 2 完成）
- [x] ~~指标采集（缓存命中率 / 工具成功率）与 `/ui` 折叠开关、slash 补全、等待队列展示~~（Phase 2 完成）
- [x] ~~WebUI（WebSocket 消费同一事件流，快照恢复，权限/ask_user 卡片，会话侧栏）~~（Phase 3 完成，[vercel/ai-elements](https://github.com/vercel/ai-elements) 组件）

详细设计见技术方案 §8。
