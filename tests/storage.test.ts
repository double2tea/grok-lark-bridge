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
      rootId: null,
      threadId: null,
      grokSessionId: 'grok_1',
      nativeSessionId: null,
      cwd: '/tmp',
      approvalPolicy: 'confirm_write',
      runStatus: 'idle',
      activeMessageId: null
    });

    expect(store.getSession('chat_1')?.grokSessionId).toBe('grok_1');
    store.setNativeSessionIdByGrokSessionId('grok_1', 'acp_1');
    expect(store.getSession('chat_1')?.nativeSessionId).toBe('acp_1');
    store.close();
  });

  it('clears stale native ACP binding when cwd creates a new Grok session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    dirs.push(dir);
    const store = new StateStore(dir);

    store.upsertSession({
      key: 'chat_1',
      chatId: 'chat_1',
      rootId: null,
      threadId: null,
      grokSessionId: 'grok_1',
      nativeSessionId: 'acp_1',
      cwd: '/tmp/old',
      approvalPolicy: 'auto',
      runStatus: 'idle',
      activeMessageId: null
    });

    store.setSessionCwd('chat_1', '/tmp/new', 'grok_2');

    expect(store.getSession('chat_1')).toMatchObject({
      grokSessionId: 'grok_2',
      nativeSessionId: null,
      cwd: '/tmp/new'
    });
    store.close();
  });

  it('persists session aliases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    dirs.push(dir);
    const store = new StateStore(dir);

    store.rememberSessionAliases('chat_1:root_1', ['chat_1:msg_1', 'chat_1:thread_1']);

    expect(store.resolveSessionAlias('chat_1:msg_1')).toBe('chat_1:root_1');
    expect(store.resolveSessionAlias('chat_1:thread_1')).toBe('chat_1:root_1');
    store.close();
  });
});
