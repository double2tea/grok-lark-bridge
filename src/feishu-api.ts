import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { BridgeConfig, CardAction, FeishuCardUpdate } from './types.js';
import { sanitizeForCard, truncate } from './utils.js';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface FeishuApiPort {
  sendText(chatId: string, text: string): Promise<string | undefined>;
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
