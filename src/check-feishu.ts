#!/usr/bin/env node
import { loadConfig } from './config.js';
import { checkFeishuCredentials } from './feishu-auth.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const result = await checkFeishuCredentials(config);
  if (!result.ok) {
    process.stderr.write(`Feishu credential check failed: ${result.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Feishu credential check ok: ${result.message}, expire=${String(result.expireSeconds ?? 'unknown')}s\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
