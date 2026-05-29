import { describe, expect, it } from 'vitest';
import { parseAcpUpdate, parseStreamingLine } from '../src/grok.js';

describe('parseStreamingLine', () => {
  it('keeps plain text lines', () => {
    expect(parseStreamingLine('hello')).toEqual({ type: 'text', text: 'hello' });
  });

  it('extracts text from JSON events', () => {
    expect(
      parseStreamingLine(JSON.stringify({ type: 'message', content: { text: 'hi' } }))
    ).toEqual({
      type: 'text',
      text: 'hi'
    });
  });

  it('marks tool events', () => {
    expect(parseStreamingLine(JSON.stringify({ type: 'tool_call', text: 'calling' }))).toEqual({
      type: 'tool',
      name: 'tool_call',
      text: 'calling'
    });
  });
});

describe('parseAcpUpdate', () => {
  it('extracts ACP assistant chunks', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '你好' }
      })
    ).toEqual({ type: 'text', text: '你好' });
  });

  it('ignores ACP thought chunks', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'hidden' }
      })
    ).toBeUndefined();
  });

  it('extracts ACP tool updates', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolName: 'lark_doc_read',
        content: { type: 'text', text: 'reading document' }
      })
    ).toEqual({ type: 'tool', name: 'lark_doc_read', text: 'reading document' });
  });

  it('ignores generic ACP tool heartbeat updates', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        content: { type: 'text', text: 'tool_call_update' }
      })
    ).toBeUndefined();
  });
});
