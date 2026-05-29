#!/usr/bin/env node
import { runDoctor } from './health.js';

function main(): void {
  const checks = runDoctor();
  let failed = false;

  for (const check of checks) {
    const marker = check.ok ? 'ok' : 'fail';
    process.stdout.write(`[${marker}] ${check.name}: ${check.detail}\n`);
    failed ||= !check.ok;
  }

  process.exitCode = failed ? 1 : 0;
}

main();
