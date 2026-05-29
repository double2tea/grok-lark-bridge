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

## 5. Start

```bash
npm run dev
```

看到 `Grok Lark Bridge started with Feishu WebSocket long connection.` 后，在飞书私聊机器人发送 `/status` 验证。
