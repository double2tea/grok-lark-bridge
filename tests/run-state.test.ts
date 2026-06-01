import { describe, expect, it } from 'vitest';
import { initialState, reduce, toCardBody } from '../src/card/run-state.js';

describe('run state card body', () => {
  it('merges streamed text chunks into one natural line', () => {
    const state = ['你', '好', '！'].reduce(
      (current, text) => reduce(current, { type: 'text', text }),
      initialState
    );

    expect(toCardBody(state)).toContain('你好！');
  });

  it('keeps final tool cards compact and user-facing', () => {
    const state = [
      { type: 'status' as const, text: '正在连接 Grok ACP。' },
      { type: 'status' as const, text: 'Grok ACP 已就绪。' },
      {
        type: 'tool' as const,
        name: 'search_tool',
        text: 'query: grok-lark-bridge',
        status: 'done' as const,
        kind: 'web_search' as const,
        inputSummary: 'query: grok-lark-bridge',
        outputSummary: '{"results":[{"server":"grok-lark-bridge"}]}'
      },
      {
        type: 'tool' as const,
        name: 'use_tool',
        text: 'grok-search__web_search: query: 今天科技新闻',
        status: 'done' as const,
        kind: 'mcp' as const,
        inputSummary: 'grok-search__web_search: query: 今天科技新闻',
        outputSummary: '5 sources'
      },
      { type: 'status' as const, text: '已发送图片：1.jpg' }
    ].reduce((current, event) => reduce(current, event), initialState);

    const body = toCardBody(state);

    expect(body).toContain('执行摘要');
    expect(body).toContain("<text_tag color='green'>完成</text_tag> **网页搜索**");
    expect(body).toContain('└ `今天科技新闻`');
    expect(body).toContain('已发送图片：1.jpg');
    expect(body).not.toContain('search_tool');
    expect(body).not.toContain('[status]');
    expect(body).not.toContain('正在连接 Grok ACP');
    expect(body).not.toContain('{"results"');
  });

  it('summarizes media workflows without leaking paths, prompts, or mcp names', () => {
    const state = [
      {
        type: 'tool' as const,
        name: 'read_file',
        status: 'done' as const,
        kind: 'generic' as const,
        inputSummary:
          'file: /Users/chacha/.grok-lark-bridge/inbound-media/om_x100b6ee6491488b4b2e4a9eb4039c57/image-img_v3_02128_66f78c20-91ec-4da2-bb77-a6e73c2d8e5g.jpg'
      },
      {
        type: 'tool' as const,
        name: 'image_edit',
        status: 'done' as const,
        kind: 'generic' as const,
        inputSummary: 'prompt: Cinematic movie still of this exact woman'
      },
      {
        type: 'tool' as const,
        name: 'image_edit',
        status: 'done' as const,
        kind: 'generic' as const,
        inputSummary: 'prompt: Cinematic film still on a rainy neon-lit cyberpunk street'
      },
      {
        type: 'tool' as const,
        name: 'image_edit',
        status: 'done' as const,
        kind: 'generic' as const,
        inputSummary: 'prompt: Epic cinematic portrait on a rocky cliff'
      },
      {
        type: 'tool' as const,
        name: 'use_tool',
        status: 'done' as const,
        kind: 'mcp' as const,
        inputSummary: 'grok-lark-bridge__lark_msg_send_image: image: 5.jpg'
      },
      {
        type: 'tool' as const,
        name: 'use_tool',
        status: 'done' as const,
        kind: 'mcp' as const,
        inputSummary: 'grok-lark-bridge__lark_msg_send_image: image: 6.jpg'
      },
      {
        type: 'tool' as const,
        name: 'use_tool',
        status: 'done' as const,
        kind: 'mcp' as const,
        inputSummary: 'grok-lark-bridge__lark_msg_send_image: image: 4.jpg'
      }
    ].reduce((current, event) => reduce(current, event), initialState);

    const body = toCardBody(state);

    expect(body).toContain("<text_tag color='green'>完成</text_tag> **读取附件**");
    expect(body).toContain('└ `image-img_v3_02128_66f78c20-91ec-4da2-bb77-a6e73c2d8e5g.jpg`');
    expect(body).toContain("<text_tag color='green'>完成</text_tag> **图片编辑 ×3**");
    expect(body).toContain("<text_tag color='green'>完成</text_tag> **发送图片 ×3**");
    expect(body).toContain('└ `5.jpg、6.jpg、4.jpg`');
    expect(body).not.toContain('/Users/chacha/.grok-lark-bridge');
    expect(body).not.toContain('Cinematic movie still');
    expect(body).not.toContain('grok-lark-bridge__lark_msg_send_image');
  });
});
