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
  readonly media: string[] = [];

  sendText(_chatId: string, text: string): Promise<string | undefined> {
    this.texts.push(text);
    return Promise.resolve('msg_text');
  }

  sendImage(_chatId: string, sourcePath: string): Promise<string | undefined> {
    this.media.push(`image:${sourcePath}`);
    return Promise.resolve('msg_image');
  }

  sendFile(_chatId: string, sourcePath: string, fileName?: string): Promise<string | undefined> {
    this.media.push(`file:${sourcePath}:${fileName ?? ''}`);
    return Promise.resolve('msg_file');
  }

  sendAudio(_chatId: string, sourcePath: string, duration?: number): Promise<string | undefined> {
    this.media.push(`audio:${sourcePath}:${String(duration ?? '')}`);
    return Promise.resolve('msg_audio');
  }

  sendVideo(
    _chatId: string,
    sourcePath: string,
    input?: { readonly duration?: number; readonly coverImageKey?: string }
  ): Promise<string | undefined> {
    this.media.push(
      `video:${sourcePath}:${String(input?.duration ?? '')}:${input?.coverImageKey ?? ''}`
    );
    return Promise.resolve('msg_video');
  }

  sendCard(_chatId: string, update: FeishuCardUpdate): Promise<string | undefined> {
    this.cards.push(update);
    return Promise.resolve('msg_card');
  }

  patchText(): Promise<void> {
    return Promise.resolve();
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
  it('returns an approval id and lets the agent poll the result', async () => {
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

    const requested = await executor.call(tool, {
      context_key: 'chat_1',
      requested_by_open_id: 'ou_1',
      chat_id: 'chat_target',
      text: 'hello'
    });

    await waitForCard(api);
    expect(api.cards).toHaveLength(1);
    const approvalId = readApprovalId(api.cards[0]);
    expect(readContextKey(api.cards[0])).toBe('chat_1');
    expect(requested.text).toBe(`Approval requested: ${approvalId}`);
    await executor.executePendingApproval(approvalId);
    const result = await executor.call(findRequiredTool('lark_get_approval_result'), {
      context_key: 'chat_1',
      requested_by_open_id: 'ou_1',
      approval_id: approvalId
    });

    expect(JSON.parse(result.text)).toMatchObject({
      status: 'approved',
      result: 'Message sent.'
    });
    expect(api.texts).toEqual(['hello']);
    store.close();
  });

  it('sends media tools through the Feishu media API port', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
    dirs.push(dir);
    const store = new StateStore(dir);
    store.upsertSession({
      key: 'chat_1',
      chatId: 'chat_1',
      threadId: null,
      grokSessionId: 'grok_1',
      cwd: '/tmp',
      approvalPolicy: 'auto',
      runStatus: 'idle',
      activeMessageId: null
    });

    const api = new FakeFeishuApi();
    const sessions = new SessionService(
      store,
      {
        adminOpenIds: [],
        allowedChatIds: [],
        defaultApprovalPolicy: 'auto',
        approvalOverrides: [],
        enableAdvancedOpenApiTool: false
      },
      '/tmp'
    );
    const executor = new FeishuToolExecutor(api, store, sessions);

    const result = await executor.call(findRequiredTool('lark_msg_send_video'), {
      context_key: 'chat_1',
      requested_by_open_id: 'ou_1',
      chat_id: 'chat_target',
      file_path: '/tmp/demo.mp4',
      duration: 1200,
      cover_image_key: 'img_1'
    });

    expect(JSON.parse(result.text)).toEqual({ message_id: 'msg_video' });
    expect(api.media).toEqual(['video:/tmp/demo.mp4:1200:img_1']);
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

function readContextKey(card: FeishuCardUpdate): string | undefined {
  return card.actions?.[0]?.value.context_key;
}

function findRequiredTool(name: string) {
  const tool = findTool(name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}
