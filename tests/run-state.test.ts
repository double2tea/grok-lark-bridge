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
    expect(body).toContain('✓ use_tool：grok-search__web_search: query: 今天科技新闻');
    expect(body).toContain('已发送图片：1.jpg');
    expect(body).not.toContain('search_tool');
    expect(body).not.toContain('[status]');
    expect(body).not.toContain('正在连接 Grok ACP');
    expect(body).not.toContain('{"results"');
  });
});
