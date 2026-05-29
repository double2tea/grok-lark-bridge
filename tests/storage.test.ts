import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/storage.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StateStore', () => {
  it('deduplicates processed events and persists sessions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    dirs.push(dir);
    const store = new StateStore(dir);

    expect(store.hasProcessedEvent('evt_1')).toBe(false);
    store.markProcessedEvent('evt_1');
    expect(store.hasProcessedEvent('evt_1')).toBe(true);

    store.upsertSession({
      key: 'chat_1',
      chatId: 'chat_1',
      threadId: null,
      grokSessionId: 'grok_1',
      cwd: '/tmp',
      approvalPolicy: 'confirm_write',
      runStatus: 'idle',
      activeMessageId: null
    });

    expect(store.getSession('chat_1')?.grokSessionId).toBe('grok_1');
    store.close();
  });
});
