import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeishuApiPort, MessageReplyOptions } from '../src/feishu-api.js';
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
  readonly textTargets: MessageReplyOptions[] = [];
  readonly cardTargets: MessageReplyOptions[] = [];
  readonly imageTargets: MessageReplyOptions[] = [];
  readonly videoTargets: MessageReplyOptions[] = [];
  readonly patchedTexts: string[] = [];
  readonly images: string[] = [];
  readonly videos: string[] = [];
  readonly downloads: string[] = [];

  constructor(
    private readonly failCards = false,
    private readonly failTextPatches = false
  ) {}

  sendText(
    _chatId: string,
    text: string,
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    this.texts.push(text);
    this.textTargets.push(options);
    return Promise.resolve('msg_text');
  }

  sendImage(
    _chatId: string,
    sourcePath: string,
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    this.images.push(sourcePath);
    this.imageTargets.push(options);
    return Promise.resolve('msg_image');
  }

  sendFile(): Promise<string | undefined> {
    return Promise.resolve('msg_file');
  }

  sendAudio(): Promise<string | undefined> {
    return Promise.resolve('msg_audio');
  }

  sendVideo(
    _chatId: string,
    sourcePath: string,
    _input?: { readonly duration?: number; readonly coverImageKey?: string },
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    this.videos.push(sourcePath);
    this.videoTargets.push(options);
    return Promise.resolve('msg_video');
  }

  downloadMessageResource(
    input: Parameters<FeishuApiPort['downloadMessageResource']>[0]
  ): Promise<string> {
    fs.mkdirSync(input.targetDir, { recursive: true });
    const filePath = path.join(input.targetDir, input.fileName ?? `${input.resourceType}.bin`);
    fs.writeFileSync(filePath, input.fileKey);
    this.downloads.push(`${input.messageId}:${input.resourceType}:${input.fileKey}:${filePath}`);
    return Promise.resolve(filePath);
  }

  patchText(_messageId: string, text: string): Promise<void> {
    if (this.failTextPatches) {
      return Promise.reject(new Error('edit limit'));
    }
    this.patchedTexts.push(text);
    return Promise.resolve();
  }

  sendCard(
    _chatId: string,
    update: FeishuCardUpdate,
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    if (this.failCards) {
      return Promise.reject(new Error('card failed'));
    }
    this.cards.push(update);
    this.cardTargets.push(options);
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
  readonly inputs: GrokRunInput[] = [];

  constructor(private readonly events: readonly GrokEvent[] = [{ type: 'text', text: '你好' }]) {}

  run(
    input: GrokRunInput,
    onEvent: (event: GrokEvent) => Promise<void>,
    signal: AbortSignal
  ): Promise<number> {
    void signal;
    this.inputs.push(input);
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
    await waitFor(() => api.cards.at(-1)?.title === 'Grok 已回复');

    expect(api.cards[0]?.title).toBe('Grok 已收到');
    expect(api.cards.at(-1)?.title).toBe('Grok 已回复');
    expect(api.cards.at(-1)?.body).toBe('你好');
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

  it('downloads batched attachments from their source message', async () => {
    const api = new FakeFeishuApi();
    const grok = new FakeGrok();
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('描述这张图', 'evt_text'));
    await orchestrator.handleMessage({
      ...message('', 'evt_image'),
      messageId: 'om_image',
      attachments: [
        {
          messageId: 'om_image',
          kind: 'image',
          resourceType: 'image',
          fileKey: 'img_1',
          fileName: 'upload.png'
        }
      ]
    });
    await waitFor(() => grok.prompts.length === 1);

    expect(api.downloads[0]).toContain('om_image:image:img_1:');
  });

  it('renders assistant text in the final card body', async () => {
    const api = new FakeFeishuApi();
    const grok = new FakeGrok([
      { type: 'text', text: '你' },
      { type: 'text', text: '好' }
    ]);
    const { orchestrator } = createRuntime(api, grok);
    await orchestrator.handleMessage(message());
    await waitFor(() => api.cards.at(-1)?.title === 'Grok 已回复');

    expect(api.texts).toEqual([]);
    expect(api.patchedTexts).toEqual([]);
    expect(api.cards.at(-1)?.body).toBe('你好');
  });

  it('keeps one text fallback and final answer when run cards cannot be sent', async () => {
    const api = new FakeFeishuApi(true);
    const grok = new FakeGrok([
      { type: 'text', text: '你' },
      { type: 'text', text: '好' }
    ]);
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message());
    await waitFor(() => api.texts.some((text) => text.includes('Grok 已回复\n你好')));

    expect(api.cards).toEqual([]);
    expect(api.texts.filter((text) => text.includes('Grok 卡片发送失败'))).toHaveLength(1);
    expect(api.texts).toContain('Grok 已回复\n你好');
  });

  it('downloads inbound media and passes local paths to Grok', async () => {
    const api = new FakeFeishuApi();
    const grok = new FakeGrok();
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage({
      ...message('', 'evt_inbound_image'),
      messageId: 'om_image',
      attachments: [
        {
          messageId: 'om_image',
          kind: 'image',
          resourceType: 'image',
          fileKey: 'img_1',
          fileName: 'upload.png'
        }
      ]
    });
    await waitFor(() => grok.prompts.length === 1);

    expect(api.downloads[0]).toContain('image:img_1:');
    expect(grok.prompts[0]).toContain('用户随消息上传了以下附件');
    expect(grok.prompts[0]).toContain('image:');
    expect(grok.prompts[0]).toContain('upload.png');
    expect(grok.prompts[0]).not.toContain('image_key');
  });

  it('keeps the full assistant text in the card when plain text editing is unavailable', async () => {
    const api = new FakeFeishuApi(false, true);
    const grok = new FakeGrok([
      { type: 'text', text: '你' },
      { type: 'text', text: '好' },
      { type: 'text', text: '呀' }
    ]);
    const { orchestrator } = createRuntime(api, grok);
    await orchestrator.handleMessage(message());
    await waitFor(() => api.cards.at(-1)?.title === 'Grok 已回复');

    expect(api.texts).toEqual([]);
    expect(api.patchedTexts).toEqual([]);
    expect(api.cards.at(-1)?.body).toBe('你好呀');
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

  it('sends local video artifacts returned by Grok tools', async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-artifact-'));
    dirs.push(artifactDir);
    const videoPath = path.join(artifactDir, 'venus.mp4');
    fs.writeFileSync(videoPath, 'mp4');
    const api = new FakeFeishuApi();
    const grok = new FakeGrok([
      {
        type: 'tool',
        name: 'Generate video',
        text: 'done',
        status: 'done',
        kind: 'media',
        artifactPath: videoPath
      }
    ]);
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('生成视频', 'evt_video'));
    await waitFor(() => api.videos.includes(videoPath));

    expect(api.images).toEqual([]);
    expect(api.cards.at(-1)?.body).toContain('已发送视频：venus.mp4');
  });

  it('explains media artifact URLs instead of silently dropping them', async () => {
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
    await waitFor(() => api.cards.some((card) => card.body.includes('媒体 URL')));

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

  it('creates a replyable topic seed session with its own cwd', async () => {
    const api = new FakeFeishuApi();
    const grok = new FakeGrok();
    const { orchestrator, store } = createRuntime(api, grok);
    const topicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-topic-'));
    dirs.push(topicDir);

    await orchestrator.handleMessage(
      message(`新话题：重构 storage，路径 ${topicDir}`, 'evt_topic')
    );

    expect(api.texts[0]).toContain('新话题：重构 storage');
    expect(api.texts[0]).toContain(`工作目录：${topicDir}`);
    expect(store.getSession('chat_1:msg_text')?.cwd).toBe(topicDir);
    expect(grok.prompts).toEqual([]);

    await orchestrator.handleMessage({
      ...message('继续', 'evt_topic_reply'),
      messageId: 'msg_reply',
      parentId: 'msg_text',
      threadId: 'thread_1'
    });
    await waitFor(() => grok.inputs.length === 1);

    expect(grok.inputs[0]?.contextKey).toBe('chat_1:msg_text');
    expect(grok.inputs[0]?.cwd).toBe(topicDir);
    expect(api.cardTargets.at(-1)).toEqual({
      replyToMessageId: 'msg_text',
      replyInThread: true
    });
  });

  it('rejects topic seeds with a missing cwd before creating a reply target', async () => {
    const api = new FakeFeishuApi();
    const grok = new FakeGrok();
    const { orchestrator, store } = createRuntime(api, grok);
    const missingDir = path.join(os.tmpdir(), `grok-topic-missing-${String(Date.now())}`);

    await orchestrator.handleMessage(
      message(`新话题：坏路径，路径 ${missingDir}`, 'evt_bad_topic')
    );

    expect(api.texts).toEqual([]);
    expect(api.cards.at(-1)?.title).toBe('新话题创建失败');
    expect(api.cards.at(-1)?.body).toBe(`Topic workspace does not exist: ${missingDir}`);
    expect(store.getSession('chat_1:msg_text')).toBeUndefined();
    expect(grok.prompts).toEqual([]);
  });

  it('rejects replies in an existing topic when its cwd no longer exists', async () => {
    const api = new FakeFeishuApi();
    const grok = new FakeGrok();
    const { orchestrator, store } = createRuntime(api, grok);
    const missingDir = path.join(os.tmpdir(), `grok-topic-gone-${String(Date.now())}`);
    store.upsertSession({
      key: 'chat_1:msg_root',
      chatId: 'chat_1',
      rootId: 'msg_root',
      threadId: null,
      grokSessionId: 'grok_topic',
      nativeSessionId: null,
      cwd: missingDir,
      approvalPolicy: 'auto',
      runStatus: 'idle',
      activeMessageId: null
    });

    await orchestrator.handleMessage({
      ...message('继续', 'evt_missing_topic_cwd'),
      messageId: 'msg_reply',
      parentId: 'msg_root',
      threadId: 'thread_1'
    });
    await waitFor(() => api.cards.at(-1)?.title === '工作目录无效');

    expect(api.cards.at(-1)?.body).toBe(`Workspace does not exist: ${missingDir}`);
    expect(api.cardTargets.at(-1)).toEqual({
      replyToMessageId: 'msg_root',
      replyInThread: true
    });
    expect(grok.prompts).toEqual([]);
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

  it('reports manual stop through text fallback when run cards cannot be sent', async () => {
    const api = new FakeFeishuApi(true);
    const grok = new BlockingGrok();
    const { orchestrator } = createRuntime(api, grok);

    await orchestrator.handleMessage(message('第一条', 'evt_1'));
    await waitFor(() => grok.prompts.length === 1);
    await orchestrator.handleMessage(message('/stop', 'evt_stop'));
    await waitFor(() => api.texts.some((text) => text.includes('Grok 已停止')));

    expect(api.texts).toContain('Grok 已停止\n本轮运行已手动停止。');
  });
});

function createRuntime(
  api: FakeFeishuApi,
  grok = new FakeGrok()
): {
  readonly orchestrator: RuntimeOrchestrator;
  readonly api: FakeFeishuApi;
  readonly store: StateStore;
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
    api,
    store
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
    mentionsBot: false,
    attachments: []
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
