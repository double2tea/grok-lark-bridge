import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSessionKey, SessionService } from '../src/session.js';
import { StateStore } from '../src/storage.js';
import type { AccessConfig, IncomingMessage } from '../src/types.js';

const dirs: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SessionService', () => {
  it('uses root_id as the first-class topic anchor', () => {
    expect(makeSessionKey({ chatId: 'chat_1', rootId: 'root_1', threadId: 'thread_1' })).toBe(
      'chat_1:root_1'
    );
  });

  it('remembers message and parent aliases for the canonical topic session', () => {
    const { service, store } = createService();
    const first = service.getOrCreateFromMessage(
      message({
        messageId: 'msg_root',
        rootId: 'root_1',
        threadId: 'thread_1'
      })
    );

    const followUp = service.getOrCreateFromMessage(
      message({
        messageId: 'msg_child',
        parentId: 'msg_root',
        threadId: 'thread_1'
      })
    );

    expect(first.key).toBe('chat_1:root_1');
    expect(followUp.key).toBe(first.key);
    expect(store.resolveSessionAlias('chat_1:msg_root')).toBe(first.key);
    expect(store.resolveSessionAlias('chat_1:thread_1')).toBe(first.key);
  });
});

function createService(): {
  readonly service: SessionService;
  readonly store: StateStore;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
  dirs.push(dir);
  const store = new StateStore(dir);
  stores.push(store);
  return {
    service: new SessionService(store, access, dir),
    store
  };
}

function message(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    eventId: 'evt_1',
    chatId: 'chat_1',
    messageId: 'msg_1',
    senderOpenId: 'ou_1',
    chatType: 'group',
    text: 'hello',
    mentionsBot: true,
    attachments: [],
    ...overrides
  };
}

const access: AccessConfig = {
  adminOpenIds: ['ou_1'],
  allowedChatIds: ['chat_1'],
  defaultApprovalPolicy: 'auto',
  approvalOverrides: [],
  enableAdvancedOpenApiTool: false
};
