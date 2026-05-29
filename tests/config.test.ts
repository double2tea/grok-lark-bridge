import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadLocalConfig, saveLocalConfig } from '../src/config.js';

const dirs: string[] = [];
afterEach(() => {
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  delete process.env.FEISHU_ENCRYPT_KEY;
  delete process.env.FEISHU_VERIFICATION_TOKEN;
  delete process.env.GROK_BIN;
  delete process.env.DATA_DIR;
  delete process.env.DEFAULT_WORKSPACE_ROOT;
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('config', () => {
  it('saves and loads local config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    dirs.push(dir);
    const file = path.join(dir, 'config.json');

    saveLocalConfig({ feishuAppId: 'cli_local', feishuAppSecret: 'secret' }, file);

    expect(loadLocalConfig(file).feishuAppId).toBe('cli_local');
  });

  it('loads env before local config', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    dirs.push(projectRoot, localRoot);
    fs.mkdirSync(path.join(projectRoot, 'config'));
    fs.writeFileSync(
      path.join(projectRoot, 'config', 'access.json'),
      JSON.stringify({ adminOpenIds: [], allowedChatIds: [] })
    );
    fs.writeFileSync(
      path.join(projectRoot, 'config', 'feishu-permissions.json'),
      JSON.stringify({ scopes: { tenant: [] } })
    );
    process.env.FEISHU_APP_ID = 'cli_env';
    process.env.FEISHU_APP_SECRET = 'secret_env';
    process.env.DATA_DIR = localRoot;

    const config = loadConfig(projectRoot);

    expect(config.feishuAppId).toBe('cli_env');
    expect(config.feishuAppSecret).toBe('secret_env');
    expect(config.dataDir).toBe(localRoot);
  });
});
