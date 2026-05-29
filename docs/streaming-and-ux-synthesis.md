# Grok Lark Bridge — Streaming & UX 合理演进方案（2026 社区模式结合）

## 核心原则（不可妥协）

- **安全边界必须保留**：context_key + requested_by_open_id 强制校验 + 写操作必须走飞书卡片审批（confirm_write 默认策略）。
- **审批结果必须能回传给 Grok**（这是当前最大断层，必须先修）。
- **所有飞书能力变更都必须经过显式人类确认**，不能为了“丝滑”而悄悄放权。

在以上前提下，**最大化借鉴社区成熟模式**（主要是 zarazhangrui + cc-connect + tomeraitz 的精华）。

## 社区通用优秀模式总结（已验证有效的）

1. **增量状态机 + 结构化 Block**（zarazhangrui 最强）
   - 用 reducer 管理 RunState（blocks: text streaming / tool with status / reasoning）。
   - 每次收到事件只做 append 或小更新，而不是全量替换 body。
   - 最终渲染时才生成卡片 JSON，中间大量复用状态。

2. **Preempt + Coalesce**（几乎所有好项目都有）
   - 新消息到达时，如果当前 run 还在跑，直接 abort 旧的 + 用新 prompt 继续（或合并 prompt）。
   - 快速连发消息合并成一次请求，避免“启动”卡片狂刷。

3. **持久会话而非每次独立任务**（cc-connect、zarazhangrui）
   - 同一个 chat/thread 是一个长期 agent 会话。
   - Follow-up 消息**不发新的“正在启动”卡片**，而是延续或追加到现有卡片状态。
   - 只有真正新对话或显式 /new 才重置状态 + 发初始卡片。

4. **Idle Watchdog + 结构化日志 + 自诊断**（多个项目）
   - N 分钟无输出自动终止 + 卡片标注。
   - /doctor 把日志喂回 agent 自己诊断。

5. **Agent 主动问人（高级 HIL）**（tomeraitz 最佳实践）
   - 提供 `ask_human` 类工具，让 agent 中途可以发问题卡片，阻塞等待人类在同一线程回复，然后把回复作为 tool result 注入。
   - 可以和现有审批模型共存（ask_human 可以走轻量确认或直接走 read 策略）。

6. **卡片更新策略**
   - 避免高频 patchCard（飞书限流 + 成本）。
   - 采用“状态机 + 节流渲染”：状态实时更新，渲染节流（300-600ms 合理区间）。
   - 工具开始/结束、重大状态变化时做更明显的更新。

## 最合理的混合方案（推荐路径）

### Phase 1（1-2 周，最大 ROI，解决你当前痛点）

- 引入 **RunState reducer + Block 模型**（直接参考 zarazhangrui 的 run-state.ts 适配）。
  - 支持：streaming text、tool_use（带 status）、tool_result、简易 reasoning。
  - GrokEvent 映射层做 best-effort 解析（ACP 事件有限就尽力而为，CLI 路径可以更丰富）。
- **Follow-up 不重复发启动卡片**：
  - 如果当前 session 有 active card 且 terminal !== done，则直接复用/追加该卡片的状态。
  - 只有新会话或显式重置才发“Grok 正在处理”初始卡片。
- 加强 Preempt 逻辑（新消息到达时 abort 当前 controller）。
- 把审批结果**可靠回传**给 Grok（新增 pending result 查询工具或直接在 execute 后注入事件）。

这个阶段就能把“总是启动 CLI + 感觉没流式”的体验大幅改善，同时几乎不破坏现有安全模型。

### Phase 2（中长期）

- 完整实现 Idle Watchdog + /doctor（日志喂 agent）。
- 引入 `lark_ask_human` 工具（参考 tomeraitz），让 Grok 可以主动发起问题并等待回复。
  - 这个工具可以设计成“轻审批”或直接允许（因为只是问问题）。
- 进一步丰富 Block 类型（文件变更、命令输出片段等）。
- 考虑把卡片渲染逻辑独立成模块（像 zarazhangrui 的 card/ 目录）。

### Phase 3（可选，架构升级）

- 如果 Grok ACP 事件未来更丰富，再补齐 tool call 的实时可见性。
- 评估是否需要 per-run 更强的进程隔离（当前共享 ACP 仍是最大风险）。
- 考虑支持多 agent 编排（cc-connect 模式），但这对当前项目优先级较低。

## 具体矛盾与我们的取舍

- **审批严格 vs 流畅自主**：保留严格写审批，只在“问问题”类操作上开放更轻的机制。
- **ACP 事件贫乏**：接受现实，用状态机 + 尽力解析 + 结构化工具跟踪来弥补感知体验。
- **卡片更新成本**：用 reducer + 合理节流（绝不 token-by-token patch）。
- **安全 vs 便利**：所有涉及飞书变更的操作永远走显式卡片；纯本地/只读操作可以更自由。

这个方案既尊重了本项目“飞书作为强审批边界 + Grok 作为受控 coding agent”的独特定位，又吸收了 2026 年社区验证过的最有效 UX 模式。

---

**下一步行动建议**（如果你同意这个方向）：

1. 先实现 Phase 1 的 RunState + 不重复启动卡片 + 审批结果回传。
2. 我可以现在就开始写一个适配版的 `src/card/run-state.ts` + 修改 orchestrator 的更新逻辑（最小侵入）。

需要我立刻开始写代码原型吗？还是先调整这个方案？
