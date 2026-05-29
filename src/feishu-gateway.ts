import * as lark from '@larksuiteoapi/node-sdk';
import type { BridgeConfig, IncomingCardAction, IncomingMessage } from './types.js';
import { isRecord, readString } from './utils.js';

export interface FeishuGatewayHandlers {
  readonly onMessage: (message: IncomingMessage) => Promise<void>;
  readonly onCardAction: (action: IncomingCardAction) => Promise<void>;
}

export class FeishuGateway {
  private readonly wsClient: lark.WSClient;
  private readonly dispatcher: lark.EventDispatcher;

  constructor(config: BridgeConfig, handlers: FeishuGatewayHandlers) {
    this.dispatcher = new lark.EventDispatcher({
      encryptKey: config.feishuEncryptKey,
      verificationToken: config.feishuVerificationToken
    }).register({
      'im.message.receive_v1': (data: unknown) => {
        try {
          const message = normalizeMessageEvent(data);
          runInBackground('message event', handlers.onMessage(message));
        } catch (error) {
          logEventError('message event normalize', error);
        }
        return {};
      },
      'card.action.trigger': (data: unknown) => {
        try {
          const action = normalizeCardActionEvent(data);
          runInBackground('card action event', handlers.onCardAction(action));
        } catch (error) {
          logEventError('card action normalize', error);
        }
        return {};
      }
    });

    this.wsClient = new lark.WSClient({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      domain: lark.Domain.Feishu,
      autoReconnect: true,
      source: 'grok-lark-bridge',
      loggerLevel: lark.LoggerLevel.error
    });
  }

  async start(): Promise<void> {
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
  }

  close(): void {
    this.wsClient.close();
  }
}

export function normalizeMessageEvent(data: unknown): IncomingMessage {
  const root = toRecord(data);
  const header = toRecord(root.header ?? {});
  const event = toRecord(root.event ?? root);
  const message = toRecord(event.message);
  const sender = toRecord(event.sender);
  const senderId = toRecord(sender.sender_id);
  const eventId =
    readString(header, 'event_id') ?? readString(root, 'event_id') ?? readRequired(root, 'uuid');
  const content = readContentText(readRequired(message, 'content'));
  const chatType = readRequired(message, 'chat_type') === 'p2p' ? 'p2p' : 'group';

  return {
    eventId,
    chatId: readRequired(message, 'chat_id'),
    messageId: readRequired(message, 'message_id'),
    senderOpenId: readRequired(senderId, 'open_id'),
    chatType,
    text: content,
    mentionsBot: hasMention(message),
    threadId: readString(message, 'thread_id')
  };
}

export function normalizeCardActionEvent(data: unknown): IncomingCardAction {
  const root = toRecord(data);
  const header = toRecord(root.header ?? {});
  const event = toRecord(root.event ?? root);
  const action = toRecord(event.action);
  const value = toRecord(action.value ?? {});
  const operator = toRecord(event.operator ?? {});
  const message = toRecord(event.message ?? {});
  const eventId =
    readString(header, 'event_id') ?? readString(root, 'event_id') ?? readRequired(root, 'uuid');

  return {
    eventId,
    action: readRequired(value, 'action'),
    approvalId: readString(value, 'approval_id'),
    contextKey: readString(value, 'context_key'),
    operatorOpenId: readString(operator, 'open_id') ?? readString(operator, 'operator_id') ?? '',
    messageId: readString(message, 'message_id')
  };
}

function runInBackground(label: string, task: Promise<void>): void {
  task.catch((error: unknown) => {
    logEventError(label, error);
  });
}

function logEventError(label: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`Feishu ${label} failed: ${message}`);
}

function readContentText(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) {
      return readString(parsed, 'text') ?? content;
    }
    return content;
  } catch {
    return content;
  }
}

function hasMention(message: Record<string, unknown>): boolean {
  const mentions = message.mentions;
  return Array.isArray(mentions) && mentions.length > 0;
}

function readRequired(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!value) {
    throw new Error(`Missing Feishu event field: ${key}`);
  }
  return value;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return value;
}
