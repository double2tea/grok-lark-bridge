#!/usr/bin/env node
import { loadConfig } from './config.js';
import { FeishuApi } from './feishu-api.js';
import { FeishuGateway } from './feishu-gateway.js';
import { FeishuToolExecutor } from './feishu-tools.js';
import { GrokAcpBackend } from './grok.js';
import { RuntimeOrchestrator } from './orchestrator.js';
import { SessionService } from './session.js';
import { StateStore } from './storage.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.dataDir);
  store.pruneProcessedEvents(24 * 60 * 60 * 1000);

  const sessions = new SessionService(store, config.access, config.defaultWorkspaceRoot);
  const api = new FeishuApi(config);
  const tools = new FeishuToolExecutor(api, store, sessions);
  const grok = new GrokAcpBackend(config.grokBin, process.cwd());
  const orchestrator = new RuntimeOrchestrator(config, api, store, sessions, grok, tools);
  const gateway = new FeishuGateway(config, {
    onMessage: (message) => orchestrator.handleMessage(message),
    onCardAction: (action) => orchestrator.handleCardAction(action)
  });

  await gateway.start();
  process.stdout.write('Grok Lark Bridge started with Feishu WebSocket long connection.\n');

  const shutdown = (): void => {
    grok.close();
    gateway.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
