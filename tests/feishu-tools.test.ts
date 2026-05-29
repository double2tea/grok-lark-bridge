import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeishuApiPort } from '../src/feishu-api.js';
import { FeishuToolExecutor } from '../src/feishu-tools.js';
import { findTool } from '../src/permissions.js';
import { SessionService } from '../src/session.js';
import { StateStore } from '../src/storage.js';
import type { FeishuCardUpdate } from '../src/types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class FakeFeishuApi implements FeishuApiPort {
  readonly cards: FeishuCardUpdate[] = [];
  readonly texts: string[] = [];

  sendText(_chatId: string, text: string): Promise<string | undefined> {
    this.texts.push(text);
    return Promise.resolve('msg_text');
  }

  sendCard(_chatId: string, update: FeishuCardUpdate): Promise<string | undefined> {
    this.cards.push(update);
    return Promise.resolve('msg_card');
  }

  patchCard(): Promise<void> {
    return Promise.resolve();
  }

  rawOpenApi(): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }

  request(): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }
}

describe('FeishuToolExecutor', () => {
  it('waits for approval and returns the execution result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    dirs.push(dir);
    const store = new StateStore(dir);
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

    const api = new FakeFeishuApi();
    const sessions = new SessionService(
      store,
      {
        adminOpenIds: [],
        allowedChatIds: [],
        defaultApprovalPolicy: 'confirm_write',
        approvalOverrides: [],
        enableAdvancedOpenApiTool: false
      },
      '/tmp'
    );
    const executor = new FeishuToolExecutor(api, store, sessions);
    const tool = findTool('lark_msg_send');
    if (!tool) {
      throw new Error('missing tool');
    }

    const pending = executor.call(tool, {
      context_key: 'chat_1',
      requested_by_open_id: 'ou_1',
      chat_id: 'chat_target',
      text: 'hello'
    });

    await waitForCard(api);
    expect(api.cards).toHaveLength(1);
    const approvalId = readApprovalId(api.cards[0]);
    await executor.executePendingApproval(approvalId);
    await expect(pending).resolves.toEqual({ text: 'Message sent.' });
    expect(api.texts).toEqual(['hello']);
    store.close();
  });
});

async function waitForCard(api: FakeFeishuApi): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (api.cards.length > 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('approval card was not sent');
}

function readApprovalId(card: FeishuCardUpdate): string {
  const action = card.actions?.[0];
  const approvalId = action?.value.approval_id;
  if (!approvalId) {
    throw new Error('approval id missing');
  }
  return approvalId;
}
