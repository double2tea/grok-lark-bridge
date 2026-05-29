import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { BridgeConfig, CardAction, FeishuCardUpdate } from './types.js';
import { expandHome, sanitizeForCard, truncate } from './utils.js';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

export interface FeishuApiPort {
  sendText(chatId: string, text: string): Promise<string | undefined>;
  sendImage(chatId: string, sourcePath: string): Promise<string | undefined>;
  sendFile(chatId: string, sourcePath: string, fileName?: string): Promise<string | undefined>;
  sendAudio(chatId: string, sourcePath: string, duration?: number): Promise<string | undefined>;
  sendVideo(
    chatId: string,
    sourcePath: string,
    input?: { readonly duration?: number; readonly coverImageKey?: string }
  ): Promise<string | undefined>;
  patchText(messageId: string, text: string): Promise<void>;
  sendCard(chatId: string, update: FeishuCardUpdate): Promise<string | undefined>;
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

  async sendText(chatId: string, text: string): Promise<string | undefined> {
    const response = await this.request('POST', '/open-apis/im/v1/messages', {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text })
      }
    });
    return messageCreateResponseSchema.parse(response).data?.message_id;
  }

  async sendImage(chatId: string, sourcePath: string): Promise<string | undefined> {
    const imageKey = await this.uploadImage(sourcePath);
    return this.sendUploadedMessage(chatId, 'image', { image_key: imageKey });
  }

  async sendFile(
    chatId: string,
    sourcePath: string,
    fileName = path.basename(sourcePath)
  ): Promise<string | undefined> {
    const fileKey = await this.uploadFile(sourcePath, 'stream', fileName);
    return this.sendUploadedMessage(chatId, 'file', { file_key: fileKey });
  }

  async sendAudio(
    chatId: string,
    sourcePath: string,
    duration?: number
  ): Promise<string | undefined> {
    const fileKey = await this.uploadFile(sourcePath, 'opus', path.basename(sourcePath), duration);
    return this.sendUploadedMessage(chatId, 'audio', { file_key: fileKey });
  }

  async sendVideo(
    chatId: string,
    sourcePath: string,
    input: { readonly duration?: number; readonly coverImageKey?: string } = {}
  ): Promise<string | undefined> {
    const fileKey = await this.uploadFile(
      sourcePath,
      'mp4',
      path.basename(sourcePath),
      input.duration
    );
    return this.sendUploadedMessage(chatId, 'media', {
      file_key: fileKey,
      ...(input.coverImageKey ? { image_key: input.coverImageKey } : {})
    });
  }

  async patchText(messageId: string, text: string): Promise<void> {
    await this.request('PUT', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: truncate(sanitizeForCard(text), 8000) })
      }
    });
  }

  async sendCard(chatId: string, update: FeishuCardUpdate): Promise<string | undefined> {
    const response = await this.request('POST', '/open-apis/im/v1/messages', {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(buildCard(update))
      }
    });
    return messageCreateResponseSchema.parse(response).data?.message_id;
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
      this.client.request<unknown>({
        method,
        url,
        params: input.params,
        data: input.data
      })
    );
  }

  protected async uploadImage(sourcePath: string): Promise<string> {
    const response = await retryOnRateLimit(() =>
      this.client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: fs.readFileSync(expandHome(sourcePath))
        }
      })
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
      this.client.im.v1.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: fs.readFileSync(expandHome(sourcePath)),
          ...(duration === undefined ? {} : { duration })
        }
      })
    );
    const fileKey = response?.file_key;
    if (!fileKey) {
      throw new Error('Feishu file upload did not return file_key');
    }
    return fileKey;
  }

  private async sendUploadedMessage(
    chatId: string,
    msgType: 'image' | 'file' | 'audio' | 'media',
    content: Record<string, string>
  ): Promise<string | undefined> {
    const response = await this.request('POST', '/open-apis/im/v1/messages', {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content)
      }
    });
    return messageCreateResponseSchema.parse(response).data?.message_id;
  }
}

function buildCard(update: FeishuCardUpdate): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: update.title },
      template: cardTemplate(update.status)
    },
    elements: [
      {
        tag: 'markdown',
        content: truncate(sanitizeForCard(update.body), 8000)
      },
      ...buildActions(update.actions ?? [])
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
