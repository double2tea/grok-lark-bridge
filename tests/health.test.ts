import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/health.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runDoctor', () => {
  it('reports missing environment without throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(
      path.join(dir, 'config', 'access.json'),
      JSON.stringify({ adminOpenIds: [], allowedChatIds: [] })
    );
    fs.writeFileSync(
      path.join(dir, 'config', 'feishu-permissions.json'),
      JSON.stringify({ scopes: { tenant: [] } })
    );

    const checks = runDoctor(dir);

    expect(checks.some((check) => check.name === '.env' && check.ok)).toBe(true);
    expect(checks.some((check) => check.name === 'FEISHU_APP_ID')).toBe(true);
    expect(checks.some((check) => check.name === 'feishu-permissions.json')).toBe(true);
  });
});
