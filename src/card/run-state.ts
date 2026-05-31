import type { GrokEvent } from '../types.js';

export type ToolStatus = 'running' | 'done' | 'error' | 'pending_approval';

export interface ToolEntry {
  id: string;
  name: string;
  toolCallId?: string;
  kind: NonNullable<Extract<GrokEvent, { type: 'tool' }>['kind']>;
  inputSummary: string;
  status: ToolStatus;
  output?: string;
  durationMs?: number;
  approvalId?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry }
  | { kind: 'status'; content: string };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | 'waiting_approval' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  blocks: Block[];
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
}

export const initialState: RunState = {
  blocks: [],
  footer: 'thinking',
  terminal: 'running'
};

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) => (b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b));
}

function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 80);
  if (input && typeof input === 'object') {
    const keys = Object.keys(input).slice(0, 3).join(', ');
    return keys ? `{${keys}}` : '[object]';
  }
  return String(input).slice(0, 80);
}

export function reduce(state: RunState, event: GrokEvent): RunState {
  switch (event.type) {
    case 'text': {
      const text = event.text;
      if (!text) return state;

      const last: Block | undefined = state.blocks.at(-1);
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + text };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          footer: 'streaming'
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: text, streaming: true }],
        footer: 'streaming'
      };
    }

    case 'status': {
      const text = event.text || '';
      if (!text) return state;
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'status', content: text }],
        footer: 'thinking'
      };
    }

    case 'tool': {
      const name = event.name || 'tool';
      const status = event.status ?? 'running';
      const output =
        event.outputSummary ?? (status === 'done' || status === 'error' ? event.text : undefined);
      const existingIndex = findLastRunningToolIndex(state.blocks, name, event.toolCallId);

      if (existingIndex >= 0) {
        const block = state.blocks[existingIndex];
        if (block.kind !== 'tool') {
          return state;
        }
        const updated: Block = {
          kind: 'tool',
          tool: {
            ...block.tool,
            status,
            inputSummary: event.inputSummary ?? block.tool.inputSummary,
            output: output ? output.slice(0, 200) : block.tool.output,
            durationMs: event.durationMs ?? block.tool.durationMs,
            approvalId: event.approvalId ?? block.tool.approvalId
          }
        };
        return {
          ...state,
          blocks: [
            ...state.blocks.slice(0, existingIndex),
            updated,
            ...state.blocks.slice(existingIndex + 1)
          ],
          footer: footerForToolStatus(status)
        };
      }

      const summary = event.inputSummary ?? (event.text ? summarizeInput(event.text) : name);

      const tool: ToolEntry = {
        id:
          event.toolCallId ??
          `tool_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        toolCallId: event.toolCallId,
        kind: event.kind ?? 'generic',
        inputSummary: summary,
        status,
        output: output ? output.slice(0, 200) : undefined,
        durationMs: event.durationMs,
        approvalId: event.approvalId
      };

      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        footer: footerForToolStatus(status)
      };
    }

    default:
      return state;
  }
}

export function applyApprovalRequest(
  state: RunState,
  approvalId: string,
  toolName: string
): RunState {
  const tool: ToolEntry = {
    id: `approval_${approvalId}`,
    name: toolName,
    kind: 'mcp',
    inputSummary: '需要飞书审批',
    status: 'pending_approval',
    approvalId
  };

  return {
    ...state,
    blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
    footer: 'waiting_approval'
  };
}

export function applyToolResult(
  state: RunState,
  toolName: string,
  success: boolean,
  output?: string
): RunState {
  const blocks = state.blocks.map((b) => {
    if (b.kind !== 'tool') return b;
    if (b.tool.name !== toolName && !b.tool.approvalId) return b;

    return {
      ...b,
      tool: {
        ...b.tool,
        status: (success ? 'done' : 'error') as ToolStatus,
        output: output ? output.slice(0, 200) : undefined
      }
    };
  });

  return { ...state, blocks, footer: null };
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    footer: null,
    terminal: 'interrupted'
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: [
      ...closeStreamingText(state.blocks),
      { kind: 'status', content: `已因 ${String(minutes)} 分钟无输出而自动停止` }
    ],
    footer: null,
    terminal: 'idle_timeout',
    idleTimeoutMinutes: minutes
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    footer: null,
    terminal: 'done'
  };
}

export function toCardBody(state: RunState, maxLength = 8000): string {
  const lines: string[] = [];
  const toolLines: string[] = [];
  const statusLines: string[] = [];

  for (const block of state.blocks) {
    if (block.kind === 'text') {
      lines.push(block.content);
    } else if (block.kind === 'status') {
      if (!isLowSignalStatus(block.content)) {
        statusLines.push(block.content);
      }
    } else {
      toolLines.push(renderToolLine(block.tool));
    }
  }

  if (toolLines.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('执行摘要');
    lines.push(...compactLines(toolLines, 8, '还有工具调用已完成'));
  }

  if (statusLines.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      ...compactLines(
        statusLines.map((line) => `• ${line}`),
        4,
        '还有状态更新'
      )
    );
  }

  let body = lines.join('\n');

  if (state.footer === 'thinking') {
    body += body ? '\n\n_思考中..._' : '_思考中..._';
  } else if (state.footer === 'tool_running') {
    body += body ? '\n\n_正在执行工具..._' : '_正在执行工具..._';
  } else if (state.footer === 'waiting_approval') {
    body += body ? '\n\n_等待飞书审批..._' : '_等待飞书审批..._';
  }

  if (body.length > maxLength) {
    body = body.slice(0, maxLength - 3) + '...';
  }

  return body || '（无输出）';
}

function renderToolLine(tool: ToolEntry): string {
  const statusText = toolStatusText(tool.status);
  const summary = tool.inputSummary ? `：${tool.inputSummary}` : '';
  const duration = tool.durationMs !== undefined ? ` (${formatDuration(tool.durationMs)})` : '';
  const output = renderToolOutput(tool);
  return `${statusText} ${tool.name}${summary}${duration}${output}`;
}

function renderToolOutput(tool: ToolEntry): string {
  if (!tool.output) {
    return '';
  }
  if (tool.status === 'done') {
    return '';
  }
  return `\n  ${tool.output}`;
}

function toolStatusText(status: ToolStatus): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'error':
      return '✗';
    case 'pending_approval':
      return '待审批';
    case 'running':
      return '进行中';
  }
}

function compactLines(lines: readonly string[], limit: number, suffix: string): string[] {
  if (lines.length <= limit) {
    return [...lines];
  }
  return [...lines.slice(0, limit), `…${suffix} ${String(lines.length - limit)} 项`];
}

function isLowSignalStatus(content: string): boolean {
  return [
    '正在连接 Grok ACP。',
    'Grok ACP 已就绪。',
    '已发送 prompt，等待 Grok 输出或工具事件。'
  ].includes(content);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${String(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function footerForToolStatus(status: ToolStatus): FooterStatus {
  if (status === 'pending_approval') {
    return 'waiting_approval';
  }
  if (status === 'running') {
    return 'tool_running';
  }
  return null;
}

function findLastRunningToolIndex(
  blocks: readonly Block[],
  name: string,
  toolCallId: string | undefined
): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind !== 'tool' || block.tool.status !== 'running') {
      continue;
    }
    if (toolCallId && block.tool.toolCallId === toolCallId) {
      return index;
    }
    if (!toolCallId && block.tool.name === name) {
      return index;
    }
  }
  return -1;
}
