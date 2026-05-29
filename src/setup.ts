#!/usr/bin/env node
import * as lark from '@larksuiteoapi/node-sdk';
import { loadLocalConfig, localConfigPath, saveLocalConfig } from './config.js';

async function main(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });

  process.stdout.write('Starting Feishu app registration...\n');
  const result = await lark.registerApp({
    source: 'grok-lark-bridge',
    signal: controller.signal,
    appPreset: {
      name: 'Grok Lark Bridge',
      desc: 'Connect Grok Build CLI to Feishu through a local bridge.'
    },
    onQRCodeReady(info) {
      process.stdout.write(`Open this Feishu authorization link:\n${info.url}\n`);
      process.stdout.write(`Expires in ${String(info.expireIn)} seconds.\n`);
    },
    onStatusChange(info) {
      process.stdout.write(`Registration status: ${info.status}\n`);
    }
  });

  const existing = loadLocalConfig();
  saveLocalConfig({
    ...existing,
    feishuAppId: result.client_id,
    feishuAppSecret: result.client_secret,
    defaultWorkspaceRoot: existing.defaultWorkspaceRoot ?? process.cwd()
  });

  process.stdout.write(`Saved Feishu app credentials to ${localConfigPath()}\n`);
  if (result.user_info?.open_id) {
    process.stdout.write(`Registered by open_id: ${result.user_info.open_id}\n`);
  }
  process.stdout.write(
    'Next: import config/feishu-permissions.json scopes and enable bot WebSocket events.\n'
  );
}

main().catch((error: unknown) => {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === 'string' ? record.code : 'error';
  const description =
    typeof record.description === 'string'
      ? record.description
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`Setup failed (${code}): ${description}\n`);
  process.exitCode = 1;
});
