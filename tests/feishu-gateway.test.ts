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
          root_id: 'root_1',
          parent_id: 'parent_1',
          reply_to_message_id: 'reply_1',
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
      rootId: 'root_1',
      parentId: 'parent_1',
      replyToMessageId: 'reply_1',
      threadId: 'thread_1',
      attachments: []
    });
  });

  it('normalizes inbound media attachments', () => {
    const message = normalizeMessageEvent({
      header: { event_id: 'evt_image' },
      event: {
        sender: { sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'om_image',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_1' })
        }
      }
    });

    expect(message.text).toBe('');
    expect(message.attachments).toEqual([
      {
        kind: 'image',
        resourceType: 'image',
        fileKey: 'img_1'
      }
    ]);
  });

  it('normalizes inbound video resources', () => {
    const message = normalizeMessageEvent({
      header: { event_id: 'evt_media' },
      event: {
        sender: { sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'om_media',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'media',
          content: JSON.stringify({ file_key: 'file_1', file_name: 'clip.mp4' })
        }
      }
    });

    expect(message.attachments).toEqual([
      {
        kind: 'media',
        resourceType: 'media',
        fileKey: 'file_1',
        fileName: 'clip.mp4'
      }
    ]);
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
