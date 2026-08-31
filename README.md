# mini-coding-agent

一个最小可用的 Coding Agent：自写 Agent Loop + 四个基础工具（read / write / list / bash）+ 权限控制 + TUI。

> 面试项目 Phase 1 基线。产品规格见 [`设计方案.md`](./设计方案.md)，技术设计见 [`技术方案.md`](./技术方案.md)。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 MINIMAX_CN_API_KEY（sk-cp- 前缀的 coding plan Key）
npm start              # 在目标项目目录启动 TUI，当前目录即 Workspace
```

- `Enter` 发送任务，`Esc` 中断当前任务，`Ctrl+C` 退出
- Slash 命令：`/mode` 切换模式、`/clear` 清空会话、`/help` 帮助

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

## 工具与并发语义

| 工具 | 权限（Default 模式） | 并发语义（Phase 2 由 Scheduler 实现） |
| --- | --- | --- |
| `read` | 免批准 | 同文件读并行；分页读取（offset/limit，~10k token 截断 + 续读提示） |
| `write` | 需批准（允许一次 / 本次会话均允许 / 拒绝） | 同文件独占，异文件并行 |
| `list` | 免批准 | 与读并行 |
| `bash` | 需批准（同上） | 全局独占：执行期间一切工具排队 |

工具 description 面向模型写明上述语义（见 `src/agent/tools/`），模型据此正确发起并行调用；`validateToolArguments`（TypeBox）把模型幻觉参数变成干净的错误结果而不是异常。

## 模式与安全

- **Default 模式**：`read/write/list` 有 Workspace 硬边界（resolve + 前缀检查，越界直接拒绝）；`write/bash` 每次执行前需用户批准，可选「本次会话均允许」。bash 为 best-effort 边界（cwd 固定为 Workspace + 系统提示词声明，可靠沙箱需要容器级隔离，见技术方案 §6.8 的取舍说明）。
- **Full Access 模式**：解除文件边界与审批（`/mode` 切换，仅在两轮任务之间生效）。

## 验证

```bash
npm run typecheck                 # tsc --noEmit
npm run smoke                     # 连通 Key 的一次流式调用
npm run task -- "总结 设计方案.md"          # headless 跑单个任务（事件流打印到终端）
npm run task -- "写一个脚本并运行" --auto   # --auto 自动批准权限请求（缺省一律拒绝）
```

Phase 1 验收三案例（设计方案 §37）均已通过：

1. **总结 README.md**（读文件 → 分页续读 → 中文总结）
2. **写 Python 脚本统计 CSV 数据**（权限拒绝路径 + 批准路径均验证）
3. **创建脚本并运行它**（bash 执行 + 结果回填 + 最终答案）

另验证了 Workspace 边界：越界路径（如 `E:/demo/../../Windows/win.ini`）被硬边界拒绝。

## 录屏说明

开发过程录屏文件后续存放于 `recordings/` 目录（不包含 Key 等敏感信息）。

## Roadmap（Phase 2）

- [ ] 工具并行调用：Scheduler 换并发版（两级锁：全局门 + 文件读写锁，Bash 预约执行权）
- [ ] `ask_user` 工具与开关（动态增删 tool schema）
- [ ] WebUI（WebSocket 消费同一事件流）
- [ ] 等待队列展示与 slash 命令补全

详细设计见技术方案 §8 阶段二。
