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
});
