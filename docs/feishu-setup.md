# Feishu Bot Setup

## 1. Create Or Register The App

推荐方式：

```bash
npm run setup
```

终端会显示飞书授权链接。用飞书打开并确认后，项目会把 App ID / Secret 保存到：

```text
~/.grok-lark-bridge/config.json
```

手动方式：

在飞书开放平台创建企业自建应用，复制：

- App ID -> `FEISHU_APP_ID`
- App Secret -> `FEISHU_APP_SECRET`

如果事件订阅开启了加密或校验，也填入：

- Encrypt Key -> `FEISHU_ENCRYPT_KEY`
- Verification Token -> `FEISHU_VERIFICATION_TOKEN`

## 2. Enable Bot And Events

启用机器人能力，并在事件订阅里选择 WebSocket 长连接。

订阅事件：

- `im.message.receive_v1`
- `card.action.trigger`

## 3. Import Scopes

在权限管理中批量导入 `config/feishu-permissions.json`，提交管理员审批。

最小聊天桥接只需要机器人消息能力和事件订阅。`config/feishu-permissions.json` 里的文档、任务、日历、多维表格、通讯录等权限，是给 Grok 通过 MCP 主动操作飞书资源用的；不用这些工具时可以不申请。

## 4. Local Checks

如果没有使用 `npm run setup`，复制环境文件：

```bash
cp .env.example .env
```

填好 `.env` 后运行：

```bash
npm run doctor
npm run feishu:check
```

`doctor` 检查本地配置；`feishu:check` 会向飞书换取 `tenant_access_token`，用于确认 App ID/Secret 有效。

## 5. Optional: Official Lark MCP

如果你希望 Grok 像用户本人一样搜索和操作飞书云文档、多维表格、日历等资源，推荐在同一个飞书自建应用上接入官方 `@larksuiteoapi/lark-mcp`。不需要创建第二个机器人，但需要为同一个应用补充用户身份权限和 OAuth 授权。应用发布后运行：

```bash
npm run setup:lark-mcp
```

详见 [official-lark-mcp.md](official-lark-mcp.md)。

## 6. Start

```bash
npm run dev
```

看到 `Grok Lark Bridge started with Feishu WebSocket long connection.` 后，在飞书私聊机器人发送 `/status` 验证。
