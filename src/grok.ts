import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { GrokBackend, GrokEvent, GrokRunInput } from './types.js';
import { isRecord, readString, sanitizeForCard } from './utils.js';

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class AcpRequestTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`Grok ACP request timed out: ${method}`);
  }
}

interface ActiveRun {
  readonly onEvent: (event: GrokEvent) => Promise<void>;
  readonly tasks: Promise<void>[];
}

interface AcpSession {
  readonly acpSessionId: string;
  readonly cwd: string;
}

interface AcpMcpServer {
  readonly name: string;
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly {
    readonly name: string;
    readonly value: string;
  }[];
}

export class GrokAcpBackend implements GrokBackend {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private rl: readline.Interface | undefined;
  private nextId = 1;
  private initialized: Promise<void> | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, AcpSession>();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(
    private readonly grokBin: string,
    private readonly projectRoot = process.cwd()
  ) {}

  close(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.initialized = undefined;
    this.rl?.close();
    this.rl = undefined;
    this.sessions.clear();
    this.activeRuns.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Grok ACP process closed'));
    }
    this.pending.clear();
    proc?.kill('SIGTERM');
  }

  async run(
    input: GrokRunInput,
    onEvent: (event: GrokEvent) => Promise<void>,
    signal: AbortSignal
  ): Promise<number> {
    await this.ensureInitialized();
    const session = await this.getOrCreateSession(input);
    const active: ActiveRun = { onEvent, tasks: [] };
    this.activeRuns.set(session.acpSessionId, active);

    let abort: (() => void) | undefined;
    const abortPromise = new Promise<Record<string, unknown>>((_, reject) => {
      abort = (): void => {
        void this.cancelSession(session.acpSessionId);
        reject(new Error('Grok run aborted'));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    });

    try {
      const result = await Promise.race([
        this.request(
          'session/prompt',
          {
            sessionId: session.acpSessionId,
            prompt: [{ type: 'text', text: buildPrompt(input) }]
          },
          180000
        ),
        abortPromise
      ]);
      await Promise.all(active.tasks);
      return readString(result, 'stopReason') === 'end_turn' ? 0 : 1;
    } catch (error) {
      if (error instanceof AcpRequestTimeoutError && error.method === 'session/prompt') {
        this.close();
      }
      throw error;
    } finally {
      if (abort) {
        signal.removeEventListener('abort', abort);
      }
      this.activeRuns.delete(session.acpSessionId);
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize();
    await this.initialized;
  }

  private async initialize(): Promise<void> {
    this.proc = spawn(this.grokBin, ['agent', 'stdio'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[grok stderr] ${String(chunk)}`);
    });
    this.proc.on('exit', () => {
      this.proc = undefined;
      this.initialized = undefined;
      this.sessions.clear();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Grok ACP process exited'));
      }
      this.pending.clear();
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      this.handleLine(line);
    });

    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true
      }
    });
    const methodId = chooseAuthMethod(init);
    await this.request('authenticate', { methodId, _meta: { headless: true } });
  }

  private async getOrCreateSession(input: GrokRunInput): Promise<AcpSession> {
    const existing = this.sessions.get(input.sessionId);
    if (existing && existing.cwd === input.cwd) {
      return existing;
    }
    const result = await this.request('session/new', {
      cwd: input.cwd,
      mcpServers: [this.bridgeMcpServer()]
    });
    const acpSessionId = readString(result, 'sessionId');
    if (!acpSessionId) {
      throw new Error('Grok ACP did not return sessionId');
    }
    const created = { acpSessionId, cwd: input.cwd };
    this.sessions.set(input.sessionId, created);
    return created;
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60000
  ): Promise<Record<string, unknown>> {
    if (!this.proc) {
      throw new Error('Grok ACP process is not running');
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpRequestTimeoutError(method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer
      });
      this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.request('session/cancel', { sessionId }, 5000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[grok stderr] session cancel failed: ${message}\n`);
    }
  }

  private bridgeMcpServer(): AcpMcpServer {
    const distServer = path.join(this.projectRoot, 'dist', 'mcp-server.js');
    if (fs.existsSync(distServer)) {
      return {
        name: 'grok-lark-bridge',
        type: 'stdio',
        command: process.execPath,
        args: [distServer],
        env: [{ name: 'GROK_LARK_BRIDGE_PROJECT_ROOT', value: this.projectRoot }]
      };
    }
    return {
      name: 'grok-lark-bridge',
      type: 'stdio',
      command: 'npx',
      args: ['tsx', path.join(this.projectRoot, 'src', 'mcp-server.ts')],
      env: [{ name: 'GROK_LARK_BRIDGE_PROJECT_ROOT', value: this.projectRoot }]
    };
  }

  private handleLine(line: string): void {
    const message = parseJson(line);
    if (!isRecord(message)) {
      return;
    }
    const method = readString(message, 'method');
    if (method === 'session/update') {
      this.handleSessionUpdate(message);
      return;
    }
    const id = readNumber(message, 'id');
    if (id === undefined) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = message.error;
    if (isRecord(error)) {
      pending.reject(new Error(readString(error, 'message') ?? JSON.stringify(error)));
      return;
    }
    const result = message.result;
    pending.resolve(isRecord(result) ? result : {});
  }

  private handleSessionUpdate(message: Record<string, unknown>): void {
    const params = message.params;
    if (!isRecord(params)) {
      return;
    }
    const sessionId = readString(params, 'sessionId');
    if (!sessionId) {
      return;
    }
    const active = this.activeRuns.get(sessionId);
    if (!active) {
      return;
    }
    const update = params.update;
    const event = parseAcpUpdate(update);
    if (event) {
      active.tasks.push(active.onEvent(event));
    }
  }
}

export class GrokCliBackend implements GrokBackend {
  constructor(private readonly grokBin: string) {}

  async run(
    input: GrokRunInput,
    onEvent: (event: GrokEvent) => Promise<void>,
    signal: AbortSignal
  ): Promise<number> {
    const prompt = buildPrompt(input);
    const child = spawn(
      this.grokBin,
      [
        '-p',
        prompt,
        '--output-format',
        'streaming-json',
        '--cwd',
        input.cwd,
        '-s',
        input.sessionId
      ],
      {
        cwd: input.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GROK_LARK_CONTEXT_KEY: input.contextKey
        }
      }
    );

    const abort = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2000).unref();
    };
    signal.addEventListener('abort', abort, { once: true });

    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    const tasks: Promise<void>[] = [];

    stdout.on('line', (line) => {
      const event = parseStreamingLine(line);
      if (event) {
        tasks.push(onEvent(event));
      }
    });
    stderr.on('line', (line) => {
      const text = sanitizeForCard(line);
      if (text) {
        console.error(`[grok stderr] ${text}`);
      }
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        resolve(code ?? 0);
      });
    });

    signal.removeEventListener('abort', abort);
    stdout.close();
    stderr.close();
    await Promise.all(tasks);
    return exitCode;
  }
}

export function parseAcpUpdate(update: unknown): GrokEvent | undefined {
  if (!isRecord(update)) {
    return undefined;
  }
  const sessionUpdate = readString(update, 'sessionUpdate');
  const toolEvent = parseAcpToolUpdate(sessionUpdate, update);
  if (toolEvent) {
    return toolEvent;
  }
  const content = update.content;
  if (!isRecord(content)) {
    return undefined;
  }
  const text = readString(content, 'text');
  if (!text) {
    return undefined;
  }
  if (sessionUpdate === 'agent_message_chunk') {
    return { type: 'text', text: sanitizeForCard(text) };
  }
  return undefined;
}

function parseAcpToolUpdate(
  sessionUpdate: string | undefined,
  update: Record<string, unknown>
): GrokEvent | undefined {
  if (!sessionUpdate) {
    return undefined;
  }
  if (!sessionUpdate.includes('tool')) {
    return undefined;
  }
  const name =
    readString(update, 'toolName') ??
    readString(update, 'name') ??
    readString(toOptionalRecord(update.toolCall), 'name') ??
    sessionUpdate;
  const text =
    readString(update, 'text') ??
    readString(toOptionalRecord(update.content), 'text') ??
    readString(toOptionalRecord(update.toolCall), 'arguments') ??
    readString(toOptionalRecord(update.result), 'text') ??
    name;
  if (isGenericToolNoise(sessionUpdate, name, text)) {
    return undefined;
  }
  return { type: 'tool', name, text: sanitizeForCard(text) };
}

function isGenericToolNoise(sessionUpdate: string, name: string, text: string): boolean {
  const generic = new Set(['tool_call', 'tool_call_update']);
  if (!generic.has(sessionUpdate)) {
    return false;
  }
  return generic.has(name) || text === sessionUpdate;
}

export function parseStreamingLine(line: string): GrokEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = parseJson(trimmed);
  if (parsed === undefined) {
    return { type: 'text', text: sanitizeForCard(trimmed) };
  }
  const text = findText(parsed);
  if (!text) {
    return undefined;
  }
  const type = isRecord(parsed) ? readString(parsed, 'type') : undefined;
  if (type?.includes('tool')) {
    return { type: 'tool', name: type, text: sanitizeForCard(text) };
  }
  return { type: 'text', text: sanitizeForCard(text) };
}

function chooseAuthMethod(init: Record<string, unknown>): string {
  const methods = init.authMethods;
  if (!Array.isArray(methods)) {
    throw new Error('Grok ACP did not return auth methods');
  }
  const ids = methods
    .map((method) => (isRecord(method) ? readString(method, 'id') : undefined))
    .filter((id): id is string => id !== undefined);
  if (process.env.XAI_API_KEY && ids.includes('xai.api_key')) {
    return 'xai.api_key';
  }
  if (ids.includes('cached_token')) {
    return 'cached_token';
  }
  throw new Error('Run `grok login` first, or set XAI_API_KEY.');
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function toOptionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function buildPrompt(input: GrokRunInput): string {
  return [
    'You are running behind Grok Lark Bridge.',
    `Feishu context_key: ${input.contextKey}`,
    `Feishu requested_by_open_id: ${input.requestedByOpenId}`,
    'When calling any Feishu MCP tool, pass context_key exactly as shown above.',
    'When calling any Feishu MCP tool, pass requested_by_open_id exactly as shown above.',
    'If a Feishu write tool returns "Approval requested: <id>", call lark_get_approval_result with that id until it is approved or rejected.',
    'Treat the user prompt below as the latest message in an ongoing Feishu conversation.',
    '',
    input.prompt
  ].join('\n');
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function findText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const pieces = value.map(findText).filter((item): item is string => item !== undefined);
    return pieces.length > 0 ? pieces.join('') : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ['text', 'content', 'message', 'delta', 'output']) {
    const item = value[key];
    const text = findText(item);
    if (text) {
      return text;
    }
  }
  return undefined;
}
