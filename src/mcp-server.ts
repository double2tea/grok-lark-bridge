#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { FeishuApi } from './feishu-api.js';
import { FeishuToolExecutor } from './feishu-tools.js';
import { enabledTools } from './permissions.js';
import { SessionService } from './session.js';
import { StateStore } from './storage.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env.GROK_LARK_BRIDGE_PROJECT_ROOT ?? process.cwd());
  const store = new StateStore(config.dataDir);
  const sessions = new SessionService(store, config.access, config.defaultWorkspaceRoot);
  const api = new FeishuApi(config);
  const executor = new FeishuToolExecutor(api, store, sessions);
  const server = new McpServer({
    name: 'grok-lark-bridge',
    version: '0.1.0'
  });

  for (const tool of enabledTools(
    config.permissionScopes,
    config.access.enableAdvancedOpenApiTool
  )) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape
      },
      async (input: unknown) => {
        const result = await executor.call(tool, input);
        return {
          content: [{ type: 'text' as const, text: result.text }]
        };
      }
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
