import type { GrokEvent } from '../types.js';

export type ToolStatus = 'running' | 'done' | 'error' | 'pending_approval';

export interface ToolEntry {
  id: string;
  name: string;
  inputSummary: string;
  status: ToolStatus;
  output?: string;
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
      // Best-effort tool start detection
      const name = event.name || 'tool';
      const summary = event.text ? summarizeInput(event.text) : name;

      const tool: ToolEntry = {
        id: `tool_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        inputSummary: summary,
        status: 'running'
      };

      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        footer: 'tool_running'
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

  for (const block of state.blocks) {
    if (block.kind === 'text') {
      lines.push(block.content);
    } else if (block.kind === 'status') {
      lines.push(`[status] ${block.content}`);
    } else {
      const t = block.tool;
      const statusIcon =
        t.status === 'done'
          ? '✓'
          : t.status === 'error'
            ? '✗'
            : t.status === 'pending_approval'
              ? '⏳'
              : '⟳';
      let line = `${statusIcon} ${t.name}`;
      if (t.inputSummary) line += ` — ${t.inputSummary}`;
      if (t.output) line += `\n  → ${t.output}`;
      lines.push(line);
    }
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
