import { describe, expect, it } from 'vitest';
import { FeishuApi } from '../src/feishu-api.js';

class TestFeishuApi extends FeishuApi {
  requests: Array<{
    method: string;
    url: string;
    data?: unknown;
  }> = [];

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
    return Promise.resolve({ code: 0, msg: 'ok' });
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
});
