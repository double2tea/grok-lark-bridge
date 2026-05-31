import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeishuApiPort } from '../src/feishu-api.js';
import { FeishuToolExecutor } from '../src/feishu-tools.js';
import { GrokRunAbortedError } from '../src/grok.js';
import { RuntimeOrchestrator } from '../src/orchestrator.js';
import { SessionService } from '../src/session.js';
import { StateStore } from '../src/storage.js';
import type {
  BridgeConfig,
  FeishuCardUpdate,
  GrokBackend,
  GrokEvent,
  GrokRunInput,
  IncomingMessage
} from '../src/types.js';

const dirs: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class FakeFeishuApi implements FeishuApiPort {
  readonly cards: FeishuCardUpdate[] = [];
  readonly texts: string[] = [];
  readonly patchedTexts: string[] = [];
  readonly images: string[] = [];

  constructor(
    private readonly failCards = false,
    private readonly failTextPatches = false
  ) {}

  sendText(_chatId: string, text: string): Promise<string | undefined> {
    this.texts.push(text);
    return Promise.resolve('msg_text');
  }

  sendImage(_chatId: string, sourcePath: string): Promise<string | undefined> {
    this.images.push(sourcePath);
    return Promise.resolve('msg_image');
  }

  sendFile(): Promise<string | undefined> {
    return Promise.resolve('msg_file');
  }

  sendAudio(): Promise<string | undefined> {
    return Promise.resolve('msg_audio');
  }

  sendVideo(): Promise<string | undefined> {
    return Promise.resolve('msg_video');
  }

  patchText(_messageId: string, text: string): Promise<void> {
    if (this.failTextPatches) {
      return Promise.reject(new Error('edit limit'));
    }
    this.patchedTexts.push(text);
    return Promise.resolve();
  }

  sendCard(_chatId: string, update: FeishuCardUpdate): Promise<string | undefined> {
    if (this.failCards) {
      return Promise.reject(new Error('card failed'));
    }
    this.cards.push(update);
    return Promise.resolve('msg_card');
  }

  patchCard(_messageId: string, update: FeishuCardUpdate): Promise<void> {
    this.cards.push(update);
    return Promise.resolve();
  }

  rawOpenApi(): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }

  request(): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }
}

class FakeGrok implements GrokBackend {
  readonly prompts: string[] = [];

  constructor(private readonly events: readonly GrokEvent[] = [{ type: 'text', text: '你好' }]) {}

  run(
    input: GrokRunInput,
    onEvent: (event: GrokEvent) => Promise<void>,
    signal: AbortSignal
  ): Promise<number> {
    void signal;
    this.prompts.push(input.prompt);
    return this.events
      .reduce((promise, event) => promise.then(() => onEvent(event)), Promise.resolve())
      .then(() => 0);
  }
}

class BlockingGrok implements GrokBackend {
  readonly prompts: string[] = [];
  abortedCount = 0;
  private readonly resolvers: ((code: number) => void)[] = [];

  run(input: GrokRunInput, _onEvent: (event: GrokEvent) => Promise<void>, signal: AbortSignal) {
    this.prompts.push(input.prompt);
    return new Promise<number>((resolve, reject) => {
      const finish = (code: number): void => {
        signal.removeEventListener('abort', abort);
        resolve(code);
      };
      const abort = (): void => {
        this.abortedCount += 1;
        signal.removeEventListener('abort', abort);
        reject(new GrokRunAbortedError());
      };
      signal.addEventListener('abort', abort, { once: true });
      this.resolvers.push(finish);
    });
  }

  finishNext(code = 0): void {
    this.resolvers.shift()?.(code);
  }
}

describe('RuntimeOrchestrator', () => {
  it('uses a lightweight status card for ordinary text replies', async () => {
    const { orchestrator, api } = createRuntime(new FakeFeishuApi());
    await orchestrator.handleMessage(message());
    await waitFor(() => api.texts.includes('你好'));

    expect(api.cards[0]?.title).toBe('Grok 已收到');
    expect(api.cards.at(-1)?.title).toBe('Grok 已回复');
  });

  it('falls back to text when a command card cannot be sent', async () => {
    const { orchestrator, api } = createRuntime(new FakeFeishuApi(true));
    await orchestrator.handleMessage(message('/status'));
    await waitFor(() => api.texts.some((text) => text.includes('Grok 卡片发送失败')));

    expect(api.texts.join('\n')).toContain('Grok 卡片发送失败');
  });

  it('batches quick consecutive messages into one Grok run', async () => {
    const grok = new FakeGrok();
    const { orchestrator } = createRuntime(new FakeFeishuApi(), grok);
    await orchestrator.handleMessage(message('第一条', 'evt_1'));
    await orchestrator.handleMessage(message('第二条', 'evt_2'));
    await waitFor(() => grok.prompts.length === 1);

    expect(grok.prompts[0]).toContain('用户连续发送了 2 条消息');
    expect(grok.prompts[0]).toContain('1. 第一条');
    expect(grok.prompts[0]).toContain('2. 第二条');
  });

  it('streams assistant text through an editable text message', async () => {
    const api = new FakeFeishuApi();
    const grok = new FakeGrok([
      { type: 'text', text: '你' },
      { type: 'text', text: '好' }
    ]);
    const { orchestrator } = createRuntime(api, grok);
    await orchestrator.handleMessage(message());
    await waitFor(() => api.patchedTexts.includes('你好'));

    expect(api.texts).toContain('你');
    expect(api.cards.at(-1)?.body).toContain('文本输出见下方消息');
  });

  it('puts final text in the card when message editing fails', async () => {
    const api = new FakeFeishuApi(false, true);
    const grok = new FakeGrok([
      { type: 'text', text: '你' },
      { type: 'text', text: '好' },
      { type: 'text', text: '呀' }
    ]);
    const { orchestrator } = createRuntime(api, grok);
    await orchestrator.handleMessage(message());
    await waitFor(() => api.cards.at(-1)?.title === 'Grok 已回复');

    expect(api.texts).toEqual(['你']);
    expect(api.cards.at(-1)?.body).toContain('你好呀');
  });

  it('shows queued follow-up messages while a run is active', async () => {
    const api = new FakeFeishuApi();
    const grok = new BlockingGrok();
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('第一条', 'evt_1'));
    await waitFor(() => grok.prompts.length === 1);
    await orchestrator.handleMessage(message('第二条', 'evt_2'));
    await sleep(50);

    expect(api.texts).not.toContain('已收到新消息，已加入当前 Grok 会话队列。');

    grok.finishNext();
    await waitFor(() => grok.prompts.length === 2);
    grok.finishNext();
    await waitFor(() => api.cards.at(-1)?.title === 'Grok 已回复');
  });

  it('does not run queued messages after stop', async () => {
    const api = new FakeFeishuApi();
    const grok = new BlockingGrok();
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('第一条', 'evt_1'));
    await waitFor(() => grok.prompts.length === 1);
    await orchestrator.handleMessage(message('第二条', 'evt_2'));
    await sleep(50);
    await orchestrator.handleMessage(message('/stop', 'evt_stop'));
    await waitFor(() => api.cards.some((card) => card.title === 'Grok 已停止'));
    await sleep(50);

    expect(grok.prompts).toEqual(['第一条']);
  });

  it('handles commands immediately while a run is active', async () => {
    const api = new FakeFeishuApi();
    const grok = new BlockingGrok();
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('第一条', 'evt_1'));
    await waitFor(() => grok.prompts.length === 1);
    await orchestrator.handleMessage(message('/help', 'evt_help'));

    expect(api.cards.some((card) => card.body.includes('常用命令可以直接点击'))).toBe(true);
    expect(grok.prompts).toEqual(['第一条']);
  });

  it('warns about no first output without aborting the run', async () => {
    vi.useFakeTimers();
    const api = new FakeFeishuApi();
    const grok = new BlockingGrok();
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('需要较长搜索', 'evt_slow'));
    await vi.advanceTimersByTimeAsync(1200);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(1500);

    expect(api.cards.at(-1)?.title).toBe('Grok 仍在处理');
    expect(api.cards.at(-1)?.body).toContain('继续等待 Grok');
    expect(grok.abortedCount).toBe(0);
  });

  it('sends local image artifacts returned by Grok tools', async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-artifact-'));
    dirs.push(artifactDir);
    const imagePath = path.join(artifactDir, 'venus.png');
    fs.writeFileSync(imagePath, 'png');
    const api = new FakeFeishuApi();
    const grok = new FakeGrok([
      {
        type: 'tool',
        name: 'Generate image',
        text: 'done',
        status: 'done',
        kind: 'media',
        artifactPath: imagePath
      }
    ]);
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('生成图片', 'evt_image'));
    await waitFor(() => api.images.includes(imagePath));

    expect(api.cards.at(-1)?.body).toContain('已发送图片：venus.png');
  });

  it('explains image artifact URLs instead of silently dropping them', async () => {
    const api = new FakeFeishuApi();
    const grok = new FakeGrok([
      {
        type: 'tool',
        name: 'Generate image',
        text: 'done',
        status: 'done',
        kind: 'media',
        artifactUrl: 'https://example.com/venus.png'
      }
    ]);
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('生成图片', 'evt_image_url'));
    await waitFor(() => api.cards.some((card) => card.body.includes('图片 URL')));

    expect(api.images).toEqual([]);
  });

  it('renders command results as cards', async () => {
    const api = new FakeFeishuApi();
    const { orchestrator } = createRuntime(api);

    await orchestrator.handleMessage(message('/doctor', 'evt_doctor'));

    expect(api.texts).toEqual([]);
    expect(api.cards.at(-1)?.title).toBe('Bridge 诊断');
    expect(api.cards.at(-1)?.actions?.length).toBeGreaterThan(0);
  });

  it('renders manual stop as a stopped run instead of an error', async () => {
    const api = new FakeFeishuApi();
    const grok = new BlockingGrok();
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('第一条', 'evt_1'));
    await waitFor(() => grok.prompts.length === 1);
    await orchestrator.handleMessage(message('/stop', 'evt_stop'));
    await waitFor(() => api.cards.some((card) => card.title === 'Grok 已停止'));

    expect(api.cards.at(-1)?.status).toBe('warning');
  });
});

function createRuntime(
  api: FakeFeishuApi,
  grok = new FakeGrok()
): {
  readonly orchestrator: RuntimeOrchestrator;
  readonly api: FakeFeishuApi;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
  dirs.push(dir);
  const config: BridgeConfig = {
    feishuAppId: 'app',
    feishuAppSecret: 'secret',
    grokBin: 'grok',
    dataDir: dir,
    defaultWorkspaceRoot: '/tmp',
    access: {
      adminOpenIds: [],
      allowedChatIds: [],
      defaultApprovalPolicy: 'auto',
      approvalOverrides: [],
      enableAdvancedOpenApiTool: false
    },
    permissionScopes: { scopes: { tenant: [] } }
  };
  const store = new StateStore(dir);
  stores.push(store);
  const sessions = new SessionService(store, config.access, config.defaultWorkspaceRoot);
  const tools = new FeishuToolExecutor(api, store, sessions);
  return {
    orchestrator: new RuntimeOrchestrator(config, api, store, sessions, grok, tools),
    api
  };
}

function message(text = '你好', eventId = `evt_${String(Math.random())}`): IncomingMessage {
  return {
    eventId,
    chatId: 'chat_1',
    messageId: 'msg_1',
    senderOpenId: 'ou_1',
    chatType: 'p2p',
    text,
    mentionsBot: false
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 250; index += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('condition was not met');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
