# Grok Lark Bridge

本项目把 Grok Build CLI 接入飞书：飞书 SDK / OpenAPI 负责收发消息、卡片和机器人权限；Grok 负责 coding agent 执行；通用飞书资源操作交给官方 `lark-mcp`。

**近期核心体验升级**：

- 结构化流式响应（RunState 增量更新，支持文本 + 工具状态可视化）
- 同会话 follow-up 消息复用卡片，不再重复显示“正在启动”
- 桥接自身不暴露本地 MCP 工具；飞书通用操作交给官方 `lark-mcp`

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

如果只需要“飞书聊天遥控 Grok + 普通文本回复”，核心权限是 `im:message:send_as_bot` 和事件订阅；如果需要读取用户随消息上传的附件，还需要 `im:message:readonly`。文档、任务、日历、多维表格、通讯录等 scopes 走官方 `lark-mcp` 的用户身份权限。

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

本项目不再暴露 bridge-local MCP server。通用飞书 OpenAPI 能力（云文档搜索、Wiki、Docx、多维表格、日历、通讯录等）统一推荐接入飞书官方 OpenAPI MCP。

### 推荐：接入飞书官方 OpenAPI MCP

复用本项目已经创建的飞书自建应用即可，不需要创建第二个机器人。Bridge 继续使用同一个 App ID / Secret 以应用身份收发消息；官方 MCP 使用同一个 App ID / Secret 做一次用户 OAuth 授权，以用户身份访问你有权限的云文档、多维表格、日历等资源。

在飞书开放平台补充用户身份权限、配置 OAuth 重定向 URL、发布应用后，运行项目封装脚本：

```bash
npm run setup:lark-mcp
```

该脚本会复用 bridge 已保存的 App ID / Secret，生成官方 MCP 配置到 `~/.grok-lark-bridge/grok-mcp.config.json`，并启动官方 MCP 的一次性用户 OAuth 登录。只想生成配置、不立刻登录时可运行：

```bash
npm run setup:lark-mcp -- --config-only
```

官方 MCP 需要在飞书开放平台为同一个应用补充用户身份权限、配置 OAuth 重定向 URL，并发布应用版本。更完整步骤见 [docs/official-lark-mcp.md](docs/official-lark-mcp.md)。

## Commands

- `/help`
- `/status`
- `/new`
- `/topic <title> [路径 <path>]`
- `/stop`
- `/cd <path>`
- `/workspace list|save|use|remove`
- `/approval confirm_write|confirm_all|auto`
- `/mcp tools`
- `/mcp scopes`
- `/doctor`

也可以直接发送自然语言创建新话题种子消息：

```text
新话题：重构 storage，路径 /Users/chacha/Documents/Grok Lark Bridge
```

机器人会发送一条种子消息。回复这条种子消息即可进入新的飞书话题，并自动使用独立 Grok 会话；直接在底部输入框发送仍会回到原会话。

## Media Messages

普通文本回复由桥接服务直接发送。Grok 运行过程中产出的本地图片或 MP4 artifact 会由桥接服务通过飞书 SDK / OpenAPI 自动回传到当前会话，不需要 bridge-local MCP 工具。

## Approval Policy

- `auto`：默认值。
- `confirm_write` / `confirm_all`：保留命令兼容性；bridge-local MCP 工具归零后不再拦截本地工具调用。

Bridge 使用租户机器人身份收发消息。官方 `lark-mcp` 使用用户 OAuth 访问用户可见资源。

## Streaming & Conversation Continuity（流式与会话连续性）

- **结构化增量更新**：使用 RunState reducer 管理卡片内容，支持文本流式追加、工具调用状态（running/done/error/pending_approval）可视化，以及状态提示。
- **普通聊天轻量状态**：普通文本对话默认先发送一张“Grok 已收到”状态卡，再用普通文本消息承载回复，避免用户误判卡住。
- **Idle Watchdog**：长时间无输出自动终止并在卡片中清晰标注（可通过配置调整时长）。

这些改进参考了社区成熟桥接（zarazhangrui/feishu-claude-code-bridge、cc-connect 等）的 proven 模式，同时把飞书资源操作收口到官方 MCP。

相关实现集中在 `src/card/run-state.ts` 与 `src/orchestrator.ts`。
