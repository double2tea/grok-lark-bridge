import { describe, expect, it } from 'vitest';
import { normalizeCardActionEvent, normalizeMessageEvent } from '../src/feishu-gateway.js';

describe('Feishu event normalization', () => {
  it('normalizes message receive events', () => {
    const message = normalizeMessageEvent({
      header: { event_id: 'evt_1' },
      event: {
        sender: { sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'group',
          content: JSON.stringify({ text: '@bot hello' }),
          mentions: [{ id: 'bot' }],
          thread_id: 'thread_1'
        }
      }
    });

    expect(message).toEqual({
      eventId: 'evt_1',
      chatId: 'oc_1',
      messageId: 'om_1',
      senderOpenId: 'ou_1',
      chatType: 'group',
      text: '@bot hello',
      mentionsBot: true,
      threadId: 'thread_1'
    });
  });

  it('normalizes approval card actions', () => {
    const action = normalizeCardActionEvent({
      header: { event_id: 'evt_2' },
      event: {
        operator: { open_id: 'ou_1' },
        message: { message_id: 'om_card' },
        action: {
          value: {
            action: 'approval_approve',
            approval_id: 'approval_1'
          }
        }
      }
    });

    expect(action).toMatchObject({
      eventId: 'evt_2',
      action: 'approval_approve',
      approvalId: 'approval_1',
      operatorOpenId: 'ou_1',
      messageId: 'om_card'
    });
  });

  it('normalizes stop card actions with context key', () => {
    const action = normalizeCardActionEvent({
      header: { event_id: 'evt_3' },
      event: {
        operator: { open_id: 'ou_1' },
        action: {
          value: {
            action: 'stop_run',
            context_key: 'chat_1'
          }
        }
      }
    });

    expect(action.contextKey).toBe('chat_1');
    expect(action.approvalId).toBeUndefined();
  });

  it('normalizes command card actions', () => {
    const action = normalizeCardActionEvent({
      header: { event_id: 'evt_4' },
      event: {
        operator: { open_id: 'ou_1' },
        action: {
          value: {
            action: 'run_command',
            command: '/status',
            context_key: 'chat_1'
          }
        }
      }
    });

    expect(action.action).toBe('run_command');
    expect(action.command).toBe('/status');
    expect(action.contextKey).toBe('chat_1');
  });
});
