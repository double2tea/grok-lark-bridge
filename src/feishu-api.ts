import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { BridgeConfig, CardAction, FeishuCardUpdate } from './types.js';
import { expandHome, sanitizeForCard, truncate } from './utils.js';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
type MessageResourceType = 'image' | 'file' | 'audio' | 'media';

export interface MessageResourceDownload {
  readonly messageId: string;
  readonly fileKey: string;
  readonly resourceType: MessageResourceType;
  readonly targetDir: string;
  readonly fileName?: string;
}

export interface MessageReplyOptions {
  readonly replyToMessageId?: string;
  readonly replyInThread?: boolean;
}

export interface FeishuApiPort {
  sendText(
    chatId: string,
    text: string,
    options?: MessageReplyOptions
  ): Promise<string | undefined>;
  sendImage(
    chatId: string,
    sourcePath: string,
    options?: MessageReplyOptions
  ): Promise<string | undefined>;
  sendFile(
    chatId: string,
    sourcePath: string,
    fileName?: string,
    options?: MessageReplyOptions
  ): Promise<string | undefined>;
  sendAudio(
    chatId: string,
    sourcePath: string,
    duration?: number,
    options?: MessageReplyOptions
  ): Promise<string | undefined>;
  sendVideo(
    chatId: string,
    sourcePath: string,
    input?: { readonly duration?: number; readonly coverImageKey?: string },
    options?: MessageReplyOptions
  ): Promise<string | undefined>;
  downloadMessageResource(input: MessageResourceDownload): Promise<string>;
  patchText(messageId: string, text: string): Promise<void>;
  sendCard(
    chatId: string,
    update: FeishuCardUpdate,
    options?: MessageReplyOptions
  ): Promise<string | undefined>;
  patchCard(messageId: string, update: FeishuCardUpdate): Promise<void>;
  rawOpenApi(input: {
    readonly method: HttpMethod;
    readonly path: string;
    readonly params?: Record<string, string | number | boolean>;
    readonly data?: unknown;
  }): Promise<unknown>;
  request(
    method: HttpMethod,
    url: string,
    input?: {
      readonly params?: Record<string, string | number | boolean>;
      readonly data?: unknown;
    }
  ): Promise<unknown>;
}

const messageCreateResponseSchema = z.object({
  data: z
    .object({
      message_id: z.string().optional()
    })
    .optional()
});
const feishuRequestTimeoutMs = 15000;
const feishuUploadTimeoutMs = 120000;

export class FeishuApi implements FeishuApiPort {
  private readonly client: lark.Client;

  constructor(config: Pick<BridgeConfig, 'feishuAppId' | 'feishuAppSecret'>) {
    this.client = new lark.Client({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error
    });
  }

  async sendText(
    chatId: string,
    text: string,
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    return this.sendMessage(chatId, 'text', { text }, options);
  }

  async sendImage(
    chatId: string,
    sourcePath: string,
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    const imageKey = await this.uploadImage(sourcePath);
    return this.sendMessage(chatId, 'image', { image_key: imageKey }, options);
  }

  async sendFile(
    chatId: string,
    sourcePath: string,
    fileName = path.basename(sourcePath),
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    const fileKey = await this.uploadFile(sourcePath, 'stream', fileName);
    return this.sendMessage(chatId, 'file', { file_key: fileKey }, options);
  }

  async sendAudio(
    chatId: string,
    sourcePath: string,
    duration?: number,
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    const fileKey = await this.uploadFile(sourcePath, 'opus', path.basename(sourcePath), duration);
    return this.sendMessage(chatId, 'audio', { file_key: fileKey }, options);
  }

  async sendVideo(
    chatId: string,
    sourcePath: string,
    input: { readonly duration?: number; readonly coverImageKey?: string } = {},
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    const fileKey = await this.uploadFile(
      sourcePath,
      'mp4',
      path.basename(sourcePath),
      input.duration
    );
    return this.sendMessage(
      chatId,
      'media',
      {
        file_key: fileKey,
        ...(input.coverImageKey ? { image_key: input.coverImageKey } : {})
      },
      options
    );
  }

  async downloadMessageResource(input: MessageResourceDownload): Promise<string> {
    const resource = await retryOnRateLimit(() =>
      withTimeout(
        this.client.im.v1.messageResource.get({
          path: {
            message_id: input.messageId,
            file_key: input.fileKey
          },
          params: { type: input.resourceType }
        }),
        feishuUploadTimeoutMs,
        'Feishu message resource download timed out'
      )
    );
    fs.mkdirSync(input.targetDir, { recursive: true });
    const filePath = path.join(
      input.targetDir,
      safeFileName(
        input.fileName ??
          `${input.resourceType}-${input.fileKey}${defaultExtension(input.resourceType)}`
      )
    );
    await resource.writeFile(filePath);
    return filePath;
  }

  async patchText(messageId: string, text: string): Promise<void> {
    await this.request('PUT', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: truncate(sanitizeForCard(text), 8000) })
      }
    });
  }

  async sendCard(
    chatId: string,
    update: FeishuCardUpdate,
    options: MessageReplyOptions = {}
  ): Promise<string | undefined> {
    return this.sendMessage(chatId, 'interactive', buildCard(update), options);
  }

  async patchCard(messageId: string, update: FeishuCardUpdate): Promise<void> {
    await this.request('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      data: {
        content: JSON.stringify(buildCard(update))
      }
    });
  }

  async rawOpenApi(input: {
    readonly method: HttpMethod;
    readonly path: string;
    readonly params?: Record<string, string | number | boolean>;
    readonly data?: unknown;
  }): Promise<unknown> {
    if (!input.path.startsWith('/open-apis/')) {
      throw new Error('raw_openapi path must start with /open-apis/');
    }
    return this.request(input.method, input.path, {
      params: input.params,
      data: input.data
    });
  }

  async request(
    method: HttpMethod,
    url: string,
    input: {
      readonly params?: Record<string, string | number | boolean>;
      readonly data?: unknown;
    } = {}
  ): Promise<unknown> {
    return retryOnRateLimit(async () =>
      withTimeout(
        this.client.request<unknown>({
          method,
          url,
          params: input.params,
          data: input.data
        }),
        feishuRequestTimeoutMs,
        `Feishu ${method} ${url} timed out`
      )
    );
  }

  protected async uploadImage(sourcePath: string): Promise<string> {
    const response = await retryOnRateLimit(() =>
      withTimeout(
        this.client.im.v1.image.create({
          data: {
            image_type: 'message',
            image: fs.readFileSync(expandHome(sourcePath))
          }
        }),
        feishuUploadTimeoutMs,
        'Feishu image upload timed out'
      )
    );
    const imageKey = response?.image_key;
    if (!imageKey) {
      throw new Error('Feishu image upload did not return image_key');
    }
    return imageKey;
  }

  protected async uploadFile(
    sourcePath: string,
    fileType: FeishuFileType,
    fileName: string,
    duration?: number
  ): Promise<string> {
    const response = await retryOnRateLimit(() =>
      withTimeout(
        this.client.im.v1.file.create({
          data: {
            file_type: fileType,
            file_name: fileName,
            file: fs.readFileSync(expandHome(sourcePath)),
            ...(duration === undefined ? {} : { duration })
          }
        }),
        feishuUploadTimeoutMs,
        'Feishu file upload timed out'
      )
    );
    const fileKey = response?.file_key;
    if (!fileKey) {
      throw new Error('Feishu file upload did not return file_key');
    }
    return fileKey;
  }

  private async sendMessage(
    chatId: string,
    msgType: 'text' | 'interactive' | 'image' | 'file' | 'audio' | 'media',
    content: Record<string, unknown>,
    options: MessageReplyOptions
  ): Promise<string | undefined> {
    const encodedContent = JSON.stringify(content);
    if (options.replyToMessageId) {
      const response = await this.request(
        'POST',
        `/open-apis/im/v1/messages/${encodeURIComponent(options.replyToMessageId)}/reply`,
        {
          data: {
            msg_type: msgType,
            content: encodedContent,
            reply_in_thread: options.replyInThread ?? true
          }
        }
      );
      return messageCreateResponseSchema.parse(response).data?.message_id;
    }
    const response = await this.request('POST', '/open-apis/im/v1/messages', {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content: encodedContent
      }
    });
    return messageCreateResponseSchema.parse(response).data?.message_id;
  }
}

function buildCard(update: FeishuCardUpdate): Record<string, unknown> {
  const bodyElement = {
    tag: 'markdown',
    content: truncate(sanitizeForCard(update.body), 8000)
  };
  const processPanel = buildProcessPanel(update);
  if (processPanel) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: update.title },
        template: cardTemplate(update.status)
      },
      body: {
        elements: [processPanel, bodyElement, ...buildActions(update.actions ?? [])]
      }
    };
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: update.title },
      template: cardTemplate(update.status)
    },
    elements: [bodyElement, ...buildActions(update.actions ?? [])]
  };
}

function buildProcessPanel(update: FeishuCardUpdate): Record<string, unknown> | null {
  const content = truncate(sanitizeForCard(update.processLog ?? ''), 6000).trim();
  if (!content) {
    return null;
  }
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: update.processLogTitle ?? '本轮处理'
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px'
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [
      {
        tag: 'markdown',
        content,
        text_size: 'notation'
      }
    ]
  };
}

function buildActions(actions: readonly CardAction[]): readonly Record<string, unknown>[] {
  if (actions.length === 0) {
    return [];
  }
  return [
    {
      tag: 'action',
      actions: actions.map((action) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: action.text },
        type: action.type ?? 'default',
        value: action.value
      }))
    }
  ];
}

function cardTemplate(status: FeishuCardUpdate['status']): string {
  switch (status) {
    case 'success':
      return 'green';
    case 'error':
      return 'red';
    case 'warning':
      return 'orange';
    case 'info':
      return 'blue';
  }
}

function defaultExtension(type: MessageResourceType): string {
  switch (type) {
    case 'image':
      return '.jpg';
    case 'audio':
      return '.opus';
    case 'media':
      return '.mp4';
    case 'file':
      return '.bin';
  }
}

function safeFileName(fileName: string): string {
  return fileName.replace(/[/\\:\0]/gu, '_').slice(0, 180);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function retryOnRateLimit<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const waitMs = rateLimitWaitMs(error);
    if (waitMs === undefined) {
      throw error;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, waitMs);
    });
    return operation();
  }
}

function rateLimitWaitMs(error: unknown): number | undefined {
  const maybeResponse = getRecord(error, 'response');
  if (!maybeResponse) {
    return undefined;
  }
  const status = maybeResponse.status;
  if (status !== 429) {
    return undefined;
  }
  const headers = getRecord(maybeResponse, 'headers');
  if (!headers) {
    return 1000;
  }
  const reset = headers['x-ogw-ratelimit-reset'];
  if (typeof reset !== 'string') {
    return 1000;
  }
  const seconds = Number.parseInt(reset, 10);
  return Number.isFinite(seconds) ? Math.max(seconds * 1000, 1000) : 1000;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) {
    return undefined;
  }
  return child as Record<string, unknown>;
}
