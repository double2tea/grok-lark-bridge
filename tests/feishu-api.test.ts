import { describe, expect, it } from 'vitest';
import { FeishuApi } from '../src/feishu-api.js';

class TestFeishuApi extends FeishuApi {
  requests: Array<{
    method: string;
    url: string;
    data?: unknown;
  }> = [];
  imageKey = 'img_1';
  fileKey = 'file_1';

  constructor() {
    super({ feishuAppId: 'app', feishuAppSecret: 'secret' });
  }

  override request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    input: {
      readonly params?: Record<string, string | number | boolean>;
      readonly data?: unknown;
    } = {}
  ): Promise<unknown> {
    this.requests.push({ method, url, data: input.data });
    return Promise.resolve({ code: 0, msg: 'ok', data: { message_id: 'om_1' } });
  }

  protected override uploadImage(sourcePath: string): Promise<string> {
    this.requests.push({ method: 'UPLOAD_IMAGE', url: sourcePath });
    return Promise.resolve(this.imageKey);
  }

  protected override uploadFile(
    sourcePath: string,
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream',
    fileName: string,
    duration?: number
  ): Promise<string> {
    this.requests.push({
      method: 'UPLOAD_FILE',
      url: sourcePath,
      data: { fileType, fileName, duration }
    });
    return Promise.resolve(this.fileKey);
  }
}

describe('FeishuApi', () => {
  it('edits text messages with the message update endpoint', async () => {
    const api = new TestFeishuApi();

    await api.patchText('om_1', '你好');

    expect(api.requests).toEqual([
      {
        method: 'PUT',
        url: '/open-apis/im/v1/messages/om_1',
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: '你好' })
        }
      }
    ]);
  });

  it('uploads and sends image messages', async () => {
    const api = new TestFeishuApi();

    await api.sendImage('chat_1', '/tmp/a.png');

    expect(api.requests).toEqual([
      { method: 'UPLOAD_IMAGE', url: '/tmp/a.png' },
      {
        method: 'POST',
        url: '/open-apis/im/v1/messages',
        data: {
          receive_id: 'chat_1',
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'img_1' })
        }
      }
    ]);
  });

  it('uploads and sends video messages', async () => {
    const api = new TestFeishuApi();

    await api.sendVideo('chat_1', '/tmp/a.mp4', { duration: 3000, coverImageKey: 'img_cover' });

    expect(api.requests).toEqual([
      {
        method: 'UPLOAD_FILE',
        url: '/tmp/a.mp4',
        data: { fileType: 'mp4', fileName: 'a.mp4', duration: 3000 }
      },
      {
        method: 'POST',
        url: '/open-apis/im/v1/messages',
        data: {
          receive_id: 'chat_1',
          msg_type: 'media',
          content: JSON.stringify({ file_key: 'file_1', image_key: 'img_cover' })
        }
      }
    ]);
  });

  it('sends final cards with a collapsed process log panel', async () => {
    const api = new TestFeishuApi();

    await api.sendCard('chat_1', {
      title: 'Grok 已回复',
      status: 'success',
      processLog: "<text_tag color='green'>完成</text_tag> **网页搜索**",
      body: '文本输出见下方消息。'
    });

    const data = asRecord(api.requests[0]?.data);
    const card = asRecord(JSON.parse(String(data.content)));
    const body = asRecord(card.body);
    const elements = body.elements;

    expect(card.schema).toBe('2.0');
    expect(Array.isArray(elements)).toBe(true);
    const panel = asRecord((elements as readonly unknown[])[0]);
    const header = asRecord(panel.header);
    const title = asRecord(header.title);

    expect(panel.tag).toBe('collapsible_panel');
    expect(title.content).toBe('本轮处理');
    expect(asRecord((elements as readonly unknown[])[1]).content).toBe('文本输出见下方消息。');
  });

  it('renders long markdown answers as structured card blocks', async () => {
    const api = new TestFeishuApi();

    await api.sendCard('chat_1', {
      title: 'Grok 已回复',
      status: 'success',
      body: [
        '权限检查结果###1.桥接自身权限',
        '- config/feishu-permissions.json：仅 tenant 基础权限',
        '- config/access.json：enableAdvancedOpenApiTool=false',
        '',
        '```',
        'npm run setup:lark-mcp',
        '```',
        '',
        '下一步继续授权。'
      ].join('\n')
    });

    const data = asRecord(api.requests[0]?.data);
    const card = asRecord(JSON.parse(String(data.content)));
    const elements = asArray(card.elements);

    expect(elements.map((element) => asRecord(element).content)).toEqual([
      '权限检查结果',
      '**1.桥接自身权限**',
      '- config/feishu-permissions.json：仅 tenant 基础权限\n- config/access.json：enableAdvancedOpenApiTool=false',
      '```\nnpm run setup:lark-mcp\n```',
      '下一步继续授权。'
    ]);
  });

  it('sends card replies in the source thread', async () => {
    const api = new TestFeishuApi();

    await api.sendCard(
      'chat_1',
      {
        title: 'Grok 已收到',
        status: 'info',
        body: '正在生成回复。'
      },
      { replyToMessageId: 'om_root', replyInThread: true }
    );

    const data = asRecord(api.requests[0]?.data);

    expect(api.requests[0]?.method).toBe('POST');
    expect(api.requests[0]?.url).toBe('/open-apis/im/v1/messages/om_root/reply');
    expect(data.msg_type).toBe('interactive');
    expect(data.reply_in_thread).toBe(true);
    expect(typeof data.content).toBe('string');
  });

  it('sends uploaded media as replies when a reply target is provided', async () => {
    const api = new TestFeishuApi();

    await api.sendImage('chat_1', '/tmp/a.png', {
      replyToMessageId: 'om_root',
      replyInThread: true
    });

    expect(api.requests).toEqual([
      { method: 'UPLOAD_IMAGE', url: '/tmp/a.png' },
      {
        method: 'POST',
        url: '/open-apis/im/v1/messages/om_root/reply',
        data: {
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'img_1' }),
          reply_in_thread: true
        }
      }
    ]);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected record');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('expected array');
  }
  return value;
}
