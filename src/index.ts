#!/usr/bin/env node
import { loadConfig } from './config.js';
import { FeishuApi } from './feishu-api.js';
import { FeishuGateway } from './feishu-gateway.js';
import { GrokAcpBackend } from './grok.js';
import { acquireInstanceLock } from './instance-lock.js';
import { RuntimeOrchestrator } from './orchestrator.js';
import { SessionService } from './session.js';
import { StateStore } from './storage.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const instanceLock = acquireInstanceLock(config.dataDir);
  try {
    const store = new StateStore(config.dataDir);
    store.pruneProcessedEvents(24 * 60 * 60 * 1000);
    store.pruneSessionEvents(30 * 24 * 60 * 60 * 1000);

    const sessions = new SessionService(store, config.access, config.defaultWorkspaceRoot);
    const api = new FeishuApi(config);
    const grok = new GrokAcpBackend(
      config.grokBin,
      process.cwd(),
      (binding) => {
        store.setNativeSessionIdByGrokSessionId(binding.grokSessionId, binding.nativeSessionId);
      },
      (event) => {
        store.recordSessionEvent(event);
      }
    );
    const orchestrator = new RuntimeOrchestrator(config, api, store, sessions, grok);
    const gateway = new FeishuGateway(config, {
      onMessage: (message) => orchestrator.handleMessage(message),
      onCardAction: (action) => orchestrator.handleCardAction(action)
    });

    let closed = false;

    const shutdown = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      grok.close();
      gateway.close();
      store.close();
      instanceLock.release();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      await gateway.start();
      process.stdout.write('Grok Lark Bridge started with Feishu WebSocket long connection.\n');
    } catch (error) {
      grok.close();
      gateway.close();
      store.close();
      instanceLock.release();
      throw error;
    }
  } catch (error) {
    instanceLock.release();
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
