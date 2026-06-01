# Official Lark MCP

This project intentionally keeps its built-in MCP server narrow. Use it for bridge-local actions such as sending local artifacts back to the active Feishu conversation, reading the current chat history, and polling bridge approvals.

For general Feishu OpenAPI work, use the official Lark OpenAPI MCP server:

- package: `@larksuiteoapi/lark-mcp`
- docs: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_installation
- repository: https://github.com/larksuite/lark-openapi-mcp

## Reuse The Bridge App

Use the same Feishu self-built app already configured for Grok Lark Bridge. You do not need a second bot.

- Bridge uses `FEISHU_APP_ID` and `FEISHU_APP_SECRET` to get `tenant_access_token` for bot messages, cards, WebSocket events, and bridge-local MCP tools.
- Official MCP uses the same `FEISHU_APP_ID` and `FEISHU_APP_SECRET` plus user OAuth to get `user_access_token` for user-visible docs, wiki, bitable, calendar, search, and related APIs.

This means there is one app, but two identity modes.

## Feishu App Setup

In Feishu Open Platform, update the same app:

1. Keep the bot capability and existing event subscriptions used by the bridge.
2. Add the official MCP user scopes needed for your tools. `config/official-lark-mcp-permissions.json` is a starting point based on the official MCP bot guide. This file is for Feishu Open Platform batch import only; the bridge runtime still reads `config/feishu-permissions.json` for bridge-local tools.
3. Add an OAuth redirect URL required by the official MCP login flow.
4. Publish the app version so the permission and OAuth changes take effect.

## One Command Setup

After the app has the official MCP permissions, OAuth redirect URL, and a published version, run:

```bash
npm run setup:lark-mcp
```

This command reuses the bridge app credentials already stored by `npm run setup`, writes a combined MCP config to `~/.grok-lark-bridge/grok-mcp.config.json`, and starts the official MCP user OAuth login. Open the printed authorization URL and approve it with the Feishu user account whose resources Grok should access.

To generate the MCP config without starting OAuth login:

```bash
npm run setup:lark-mcp -- --config-only
```

The generated config contains both MCP servers:

```json
{
  "mcpServers": {
    "grok-lark-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/Grok Lark Bridge/dist/mcp-server.js"]
    },
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

Use `grok-lark-bridge` only for bridge-specific actions:

- send local image, audio, video, or file artifacts back to the current Feishu conversation
- read the active Feishu chat history
- poll bridge approval results

Bridge-local tools require `context_key` and `requested_by_open_id`. Official Lark MCP tools do not use those bridge-only fields unless a tool schema explicitly asks for them.
