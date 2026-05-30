# Grok Lark Bridge

本项目把 Grok Build CLI 接入飞书：飞书 SDK / OpenAPI 负责收发消息、卡片和机器人权限；Grok 负责 coding agent 执行；本地 MCP server 只在 Grok 需要主动操作飞书资源时，把已授权 OpenAPI 暴露成工具。

**近期核心体验升级**：

- 结构化流式响应（RunState 增量更新，支持文本 + 工具状态可视化）
- 同会话 follow-up 消息复用卡片，不再重复显示“正在启动”
- 完善的审批结果反馈机制（agent 可通过 `lark_get_approval_result` 工具获取人类决策后继续）

## Quick Start

1. 安装依赖并构建：

```bash
npm install
npm run build
```

2. 推荐使用授权向导自动创建/绑定飞书应用：

```bash
npm run setup
```

授权完成后，App ID/Secret 会保存到 `~/.grok-lark-bridge/config.json`。

如果你希望手动配置，也可以复制 `.env.example` 为 `.env`，填入飞书自建应用的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。`.env` 会优先覆盖本地配置。

如果飞书事件订阅启用了加密或校验，也配置 `FEISHU_ENCRYPT_KEY` 和 `FEISHU_VERIFICATION_TOKEN`。

3. 在飞书开放平台启用机器人和事件订阅，使用 WebSocket 长连接，订阅：

- `im.message.receive_v1`
- `card.action.trigger`

4. 在权限管理中批量导入 `config/feishu-permissions.json` 的 tenant scopes，并提交管理员审批。

如果只需要“飞书聊天遥控 Grok + 普通文本回复”，核心权限是 `im:message:send_as_bot` 和事件订阅；文档、任务、日历、多维表格、通讯录等 scopes 只用于 MCP 工具。

5. 可选：配置管理员 open_id：

```json
{
  "adminOpenIds": ["你的 open_id"]
}
```

可以先给机器人发送 `/status`，返回里的 `sender open_id` 就是当前用户的 open_id。`adminOpenIds` 为空时不限制管理员命令，适合个人或小范围试用；填入 open_id 后才会启用白名单限制。

6. 运行桥接服务：

```bash
npm run dev
```

联调前可以先跑诊断：

```bash
npm run doctor
npm run feishu:check
```

完整飞书配置步骤见 [docs/feishu-setup.md](docs/feishu-setup.md)。

## Grok MCP 配置

普通聊天回复不需要 MCP：桥接服务会直接用飞书 SDK / OpenAPI 把 Grok 的文本结果发回当前会话。

只有当你希望 Grok 主动创建飞书任务、读写文档、发送本地文件/图片/音频/视频、查询多维表格等，才需要把本项目的 MCP server 配给 Grok。

把本项目的 MCP server 加入 Grok 的 MCP 配置。构建后命令为：

```json
{
  "mcpServers": {
    "grok-lark-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/Grok Lark Bridge/dist/mcp-server.js"]
    }
  }
}
```

Grok 每次通过桥接运行时会收到当前飞书 `context_key` 和 `requested_by_open_id`，调用飞书工具时必须原样传入这两个字段。

### 审批结果反馈机制（重要）

当 Grok 调用需要审批的写工具时，会立即收到类似 `Approval requested: approval_xxx` 的结果。此时 Grok 应在后续思考中主动调用新的只读工具：

```json
{
  "name": "lark_get_approval_result",
  "arguments": {
    "context_key": "...",
    "requested_by_open_id": "...",
    "approval_id": "approval_xxx"
  }
}
```

该工具会返回审批状态（pending / approved / rejected）及结果文本。审批通过后，Grok 可继续使用该结果推进任务。

此设计完整闭环了“等待飞书审批结果”的流程，同时保持了原有的强审批边界与审计能力。

## Commands

- `/help`
- `/status`
- `/new`
- `/stop`
- `/cd <path>`
- `/workspace list|save|use|remove`
- `/approval confirm_write|confirm_all|auto`
- `/mcp tools`
- `/mcp scopes`
- `/doctor`

## Media Messages

Grok can send generated local files back to Feishu through MCP tools. These are for agent-initiated file delivery, not for ordinary chat replies:

- `lark_msg_send_image`：上传本地图片并发送图片消息。
- `lark_msg_send_video`：上传本地 MP4 并发送视频消息。
- `lark_msg_send_audio`：上传本地 OPUS 并发送音频消息。
- `lark_msg_send_file`：上传本地文件并发送文件消息。

These tools use the Feishu SDK IM upload APIs (`im.v1.image.create` / `im.v1.file.create`) and then send the corresponding message type. They require the bot message permission already used by text messages: `im:message:send_as_bot`.

## Approval Policy

- `auto`：默认值，直接执行已授权工具，适合个人机器人和小范围试用。
- `confirm_write`：读操作直接执行，写操作发确认卡片。
- `confirm_all`：所有 MCP 工具调用都发确认卡片。

本方案使用租户机器人身份，不包含用户 OAuth。所有能力边界来自飞书应用已审批 scopes。

## Streaming & Conversation Continuity（流式与会话连续性）

- **结构化增量更新**：使用 RunState reducer 管理卡片内容，支持文本流式追加、工具调用状态（running/done/error/pending_approval）可视化，以及状态提示。
- **普通聊天轻量状态**：普通文本对话默认先发送一张“Grok 已收到”状态卡，再用普通文本消息承载回复，避免用户误判卡住。
- **Idle Watchdog**：长时间无输出自动终止并在卡片中清晰标注（可通过配置调整时长）。
- **审批与主卡片联动**：审批通过/执行后，会自动在对应会话的主运行卡片中追加状态更新。

这些改进参考了社区成熟桥接（zarazhangrui/feishu-claude-code-bridge、cc-connect 等）的 proven 模式，同时保留了本项目的强安全与审批模型。

相关实现集中在 `src/card/run-state.ts` 与 `src/orchestrator.ts`。
