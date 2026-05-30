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
      text: 'calling',
      status: 'running'
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
    ).toEqual({
      type: 'tool',
      name: 'lark_doc_read',
      text: 'reading document',
      status: 'running',
      kind: 'mcp'
    });
  });

  it('keeps structured ACP tool result details', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_result',
        toolName: 'shell_command',
        toolCall: { arguments: JSON.stringify({ command: 'npm test' }) },
        result: { text: 'passed' },
        durationMs: 1200
      })
    ).toEqual({
      type: 'tool',
      name: 'shell_command',
      text: '{"command":"npm test"}',
      status: 'done',
      kind: 'command',
      inputSummary: '{"command":"npm test"}',
      outputSummary: 'passed',
      durationMs: 1200
    });
  });

  it('extracts Grok ACP raw tool calls into timeline tool events', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Generate image',
        kind: 'image',
        rawInput: { prompt: 'JARVIS portrait' }
      })
    ).toEqual({
      type: 'tool',
      name: 'Generate image',
      text: '{"prompt":"JARVIS portrait"}',
      toolCallId: 'call_1',
      status: 'running',
      kind: 'media',
      inputSummary: '{"prompt":"JARVIS portrait"}'
    });
  });

  it('extracts local image artifacts from Grok ACP raw output', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        title: 'Generate image',
        status: 'completed',
        rawOutput: { imagePath: '/tmp/venus.png' }
      })
    ).toEqual({
      type: 'tool',
      name: 'Generate image',
      text: '{"imagePath":"/tmp/venus.png"}',
      toolCallId: 'call_1',
      status: 'done',
      kind: 'media',
      outputSummary: '{"imagePath":"/tmp/venus.png"}',
      artifactPath: '/tmp/venus.png'
    });
  });

  it('extracts image artifact URLs from Grok ACP raw output', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        title: 'Generate image',
        status: 'completed',
        rawOutput: { imageUrl: 'https://example.com/venus.png' }
      })
    ).toEqual({
      type: 'tool',
      name: 'Generate image',
      text: '{"imageUrl":"https://example.com/venus.png"}',
      toolCallId: 'call_1',
      status: 'done',
      kind: 'media',
      outputSummary: '{"imageUrl":"https://example.com/venus.png"}',
      artifactUrl: 'https://example.com/venus.png'
    });
  });

  it('keeps generic ACP tool updates as backend notices', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        content: { type: 'text', text: 'tool_call_update' }
      })
    ).toEqual({
      type: 'status',
      text: '收到 Grok 运行事件：tool_call_update (content)'
    });
  });

  it('keeps non-tool ACP updates as backend notices', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'session_started',
        content: { type: 'text', text: 'ready' }
      })
    ).toEqual({
      type: 'status',
      text: '收到 Grok 运行事件：session_started (content)'
    });
  });

  it('keeps non-tool ACP updates without content as backend notices', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'session_idle',
        status: 'idle'
      })
    ).toEqual({
      type: 'status',
      text: '收到 Grok 运行事件：session_idle (status)'
    });
  });
});
