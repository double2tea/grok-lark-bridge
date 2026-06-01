# Official Lark MCP

Grok Lark Bridge now exposes zero bridge-local MCP tools. The bridge handles Feishu message delivery, cards, WebSocket events, and local image/video artifact return internally. Use the official Lark OpenAPI MCP server for general Feishu resource operations.

- package: `@larksuiteoapi/lark-mcp`
- docs: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_installation
- repository: https://github.com/larksuite/lark-openapi-mcp

## Reuse The Bridge App

Use the same Feishu self-built app already configured for Grok Lark Bridge. You do not need a second bot.

- Bridge uses `FEISHU_APP_ID` and `FEISHU_APP_SECRET` to get `tenant_access_token` for bot messages, cards, and WebSocket events.
- Official MCP uses the same `FEISHU_APP_ID` and `FEISHU_APP_SECRET` plus user OAuth to get `user_access_token` for user-visible docs, wiki, bitable, calendar, search, and related APIs.

This means there is one app, but two identity modes.

## Feishu App Setup

In Feishu Open Platform, update the same app:

1. Keep the bot capability and existing event subscriptions used by the bridge.
2. Import the bridge runtime scopes from `config/feishu-permissions.json`.
3. Add the official MCP user scopes needed for your tools. `config/official-lark-mcp-permissions.json` is a starting point for Feishu Open Platform batch import.
4. Add the OAuth redirect URL required by the official MCP login flow.
5. Publish the app version so the permission and OAuth changes take effect.

## One Command Setup

After the app has the official MCP permissions, OAuth redirect URL, and a published version, run:

```bash
npm run setup:lark-mcp
```

This command reuses the bridge app credentials already stored by `npm run setup`, writes an official-only MCP config to `~/.grok-lark-bridge/grok-mcp.config.json`, and starts the official MCP user OAuth login. Open the printed authorization URL and approve it with the Feishu user account whose resources Grok should access.

To generate the MCP config without starting OAuth login:

```bash
npm run setup:lark-mcp -- --config-only
```

The generated config contains only the official MCP server:

```json
{
  "mcpServers": {
    "lark-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@larksuiteoapi/lark-mcp",
        "mcp",
        "-a",
        "<FEISHU_APP_ID>",
        "-s",
        "<FEISHU_APP_SECRET>",
        "--oauth",
        "--token-mode",
        "user_access_token"
      ]
    }
  }
}
```

Copy the generated JSON into Grok's MCP configuration.

## Tool Routing

Use the official `lark-mcp` server for normal Feishu OpenAPI work:

- search docs
- read or create docs
- inspect wiki
- create or update bitable apps, tables, fields, and records
- calendar and contact operations

Do not configure or call a `grok-lark-bridge` MCP server. Bridge-only context fields such as `context_key` and `requested_by_open_id` are for internal routing and should not be passed to official MCP tools unless that tool schema explicitly asks for them.
