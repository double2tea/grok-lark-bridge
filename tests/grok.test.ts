import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GrokEvent } from '../src/types.js';
import {
  GrokAcpBackend,
  parseAcpUpdate,
  parseStreamingLine,
  readAcpTextFile
} from '../src/grok.js';

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

  it('keeps CLI tool events that only include structured args', () => {
    expect(
      parseStreamingLine(
        JSON.stringify({ type: 'tool_call', name: 'shell_command', args: { command: 'npm test' } })
      )
    ).toEqual({
      type: 'tool',
      name: 'shell_command',
      text: 'npm test',
      status: 'running',
      kind: 'command',
      inputSummary: 'npm test'
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
      text: 'npm test',
      status: 'done',
      kind: 'command',
      inputSummary: 'npm test',
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
      text: 'prompt: JARVIS portrait',
      toolCallId: 'call_1',
      status: 'running',
      kind: 'media',
      inputSummary: 'prompt: JARVIS portrait'
    });
  });

  it('keeps search tool summaries concise', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_search',
        title: 'search_tool',
        status: 'completed',
        rawInput: { variant: 'SearchTool', query: 'grok-lark-bridge lark feishu tools' },
        rawOutput: { results: [{ title: 'one' }, { title: 'two' }] }
      })
    ).toEqual({
      type: 'tool',
      name: 'search_tool',
      text: 'query: grok-lark-bridge lark feishu tools',
      toolCallId: 'call_search',
      status: 'done',
      kind: 'web_search',
      inputSummary: 'query: grok-lark-bridge lark feishu tools',
      outputSummary: '2 results'
    });
  });

  it('summarizes JSON text wrapped search results', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_search_text',
        title: 'search_tool',
        status: 'completed',
        content: {
          type: 'text',
          text: JSON.stringify({ results: [{ title: 'one' }, { title: 'two' }] })
        }
      })
    ).toEqual({
      type: 'tool',
      name: 'search_tool',
      text: '2 results',
      toolCallId: 'call_search_text',
      status: 'done',
      kind: 'web_search'
    });
  });

  it('summarizes MCP OkayOutput wrappers', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_mcp',
        title: 'use_tool',
        status: 'completed',
        content: {
          type: 'text',
          text: JSON.stringify({
            type: 'MCP',
            tool_name: 'lark_msg_send_image',
            output: { OkayOutput: JSON.stringify({ message_id: 'om_1' }) }
          })
        }
      })
    ).toEqual({
      type: 'tool',
      name: 'use_tool',
      text: 'message: om_1',
      toolCallId: 'call_mcp',
      status: 'done'
    });
  });

  it('summarizes generic UseTool inputs without raw JSON', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_use_tool',
        title: 'use_tool',
        status: 'completed',
        rawInput: {
          variant: 'UseTool',
          tool_name: 'grok-search__web_search',
          tool_input: { query: '今天科技新闻 头条 最新', extra_sources: 5 }
        }
      })
    ).toEqual({
      type: 'tool',
      name: 'use_tool',
      text: 'grok-search__web_search: query: 今天科技新闻 头条 最新',
      toolCallId: 'call_use_tool',
      status: 'done',
      inputSummary: 'grok-search__web_search: query: 今天科技新闻 头条 最新'
    });
  });

  it('keeps directory tool summaries concise', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_dir',
        title: 'list_dir',
        status: 'completed',
        rawInput: { variant: 'ListDir', target_directory: '.' },
        rawOutput: {
          type: 'ListDir',
          Content: { content: '- /tmp/project/\n - src/\n - package.json' }
        }
      })
    ).toEqual({
      type: 'tool',
      name: 'list_dir',
      text: 'dir: .',
      toolCallId: 'call_dir',
      status: 'done',
      inputSummary: 'dir: .',
      outputSummary: '3 entries'
    });
  });

  it('keeps file read tool summaries concise', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_file',
        title: 'read_file',
        status: 'completed',
        rawInput: { variant: 'ReadFile', target_file: 'README.md' },
        rawOutput: {
          type: 'ReadFile',
          Content: { content: 'hello world' }
        }
      })
    ).toEqual({
      type: 'tool',
      name: 'read_file',
      text: 'file: README.md',
      toolCallId: 'call_file',
      status: 'done',
      inputSummary: 'file: README.md',
      outputSummary: '11 chars'
    });
  });

  it('keeps Grok FileContent read summaries concise', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_file_content',
        title: 'read_file',
        status: 'completed',
        rawInput: { variant: 'ReadFile', target_file: 'README.md' },
        rawOutput: {
          type: 'ReadFile',
          FileContent: { content: '1→# Grok Lark Bridge\n2→README' }
        }
      })
    ).toEqual({
      type: 'tool',
      name: 'read_file',
      text: 'file: README.md',
      toolCallId: 'call_file_content',
      status: 'done',
      inputSummary: 'file: README.md',
      outputSummary: '29 chars'
    });
  });

  it('keeps grep byte output summaries concise', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_grep',
        title: 'grep',
        status: 'completed',
        rawInput: { variant: 'Grep', pattern: 'acp|ACP', path: '.' },
        rawOutput: {
          type: 'GrepSearch',
          stdout: Array.from(Buffer.from('grep search timed out after 60 seconds'))
        }
      })
    ).toEqual({
      type: 'tool',
      name: 'grep',
      text: 'grep: acp|ACP in .',
      toolCallId: 'call_grep',
      status: 'done',
      inputSummary: 'grep: acp|ACP in .',
      outputSummary: 'grep search timed out after 60 seconds'
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
      text: 'image: venus.png',
      toolCallId: 'call_1',
      status: 'done',
      kind: 'media',
      outputSummary: 'image: venus.png',
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
      text: 'image: https://example.com/venus.png',
      toolCallId: 'call_1',
      status: 'done',
      kind: 'media',
      outputSummary: 'image: https://example.com/venus.png',
      artifactUrl: 'https://example.com/venus.png'
    });
  });

  it('ignores generic ACP tool updates without useful tool details', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'tool_call_update',
        content: { type: 'text', text: 'tool_call_update' }
      })
    ).toBeUndefined();
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

  it('ignores ACP available command metadata updates', () => {
    expect(
      parseAcpUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
        _meta: {}
      })
    ).toBeUndefined();
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

describe('ACP client methods', () => {
  it('reads requested file ranges', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-acp-read-'));
    const file = path.join(dir, 'sample.txt');
    await fs.writeFile(file, 'one\ntwo\nthree\n', 'utf8');

    await expect(readAcpTextFile({ path: file, line: 2, limit: 1 })).resolves.toEqual({
      content: 'two'
    });
  });

  it('responds to agent-initiated file and terminal requests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-acp-backend-'));
    const file = path.join(dir, 'README.md');
    const fakeGrok = path.join(dir, 'fake-grok.mjs');
    await fs.writeFile(file, 'alpha', 'utf8');
    await fs.writeFile(fakeGrok, fakeGrokScript(), 'utf8');
    await fs.chmod(fakeGrok, 0o755);

    const previousFile = process.env.FAKE_ACP_FILE;
    process.env.FAKE_ACP_FILE = file;
    const backend = new GrokAcpBackend(fakeGrok, dir);
    const events: GrokEvent[] = [];
    try {
      const code = await backend.run(
        {
          prompt: 'read and run',
          cwd: dir,
          sessionId: 'bridge_session',
          contextKey: 'context',
          requestedByOpenId: 'user'
        },
        (event) => {
          events.push(event);
          return Promise.resolve();
        },
        new AbortController().signal
      );

      expect(code).toBe(0);
      expect(events).toContainEqual({ type: 'text', text: 'read:alpha; term:term-ok' });
    } finally {
      backend.close();
      if (previousFile === undefined) {
        delete process.env.FAKE_ACP_FILE;
      } else {
        process.env.FAKE_ACP_FILE = previousFile;
      }
    }
  });
});

function fakeGrokScript(): string {
  return `#!/usr/bin/env node
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
let promptId;
let fileContent = '';
let terminalId = '';

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
}

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] } });
    return;
  }
  if (message.method === 'authenticate') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/new') {
    send({ id: message.id, result: { sessionId: 'sess_test' } });
    return;
  }
  if (message.method === 'session/prompt') {
    promptId = message.id;
    send({
      id: 101,
      method: 'fs/read_text_file',
      params: { sessionId: 'sess_test', path: process.env.FAKE_ACP_FILE }
    });
    return;
  }
  if (message.id === 101) {
    fileContent = message.result.content;
    send({
      id: 102,
      method: 'terminal/create',
      params: {
        sessionId: 'sess_test',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("term-ok")'],
        cwd: process.cwd()
      }
    });
    return;
  }
  if (message.id === 102) {
    terminalId = message.result.terminalId;
    send({
      id: 103,
      method: 'terminal/wait_for_exit',
      params: { sessionId: 'sess_test', terminalId }
    });
    return;
  }
  if (message.id === 103) {
    send({
      id: 104,
      method: 'terminal/output',
      params: { sessionId: 'sess_test', terminalId }
    });
    return;
  }
  if (message.id === 104) {
    send({
      method: 'session/update',
      params: {
        sessionId: 'sess_test',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'read:' + fileContent + '; term:' + message.result.output }
        }
      }
    });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
});
`;
}
