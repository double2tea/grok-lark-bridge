import { spawn } from 'node:child_process';
import type { ChildProcessByStdio, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import type { GrokBackend, GrokEvent, GrokRunInput } from './types.js';
import { isRecord, readString, sanitizeForCard, stripAnsi } from './utils.js';

type ToolEvent = Extract<GrokEvent, { readonly type: 'tool' }>;
type ToolEventStatus = NonNullable<ToolEvent['status']>;
type ToolKind = NonNullable<ToolEvent['kind']>;

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

export class GrokRunAbortedError extends Error {
  constructor() {
    super('Grok run aborted');
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

interface NativeSessionBinding {
  readonly grokSessionId: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
}

type NativeSessionBinder = (binding: NativeSessionBinding) => void;

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

type JsonRpcId = number | string;

interface TerminalExitStatus {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface AcpTerminal {
  readonly proc: ChildProcessByStdio<null, Readable, Readable>;
  output: string;
  truncated: boolean;
  exitStatus: TerminalExitStatus | undefined;
  readonly outputByteLimit: number;
  readonly waiters: Array<(status: TerminalExitStatus) => void>;
}

export class GrokAcpBackend implements GrokBackend {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private rl: readline.Interface | undefined;
  private nextId = 1;
  private nextTerminalId = 1;
  private initialized: Promise<void> | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, AcpSession>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly terminals = new Map<string, AcpTerminal>();

  constructor(
    private readonly grokBin: string,
    private readonly projectRoot = process.cwd(),
    private readonly bindNativeSession?: NativeSessionBinder
  ) {}

  close(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.initialized = undefined;
    this.rl?.close();
    this.rl = undefined;
    this.sessions.clear();
    this.activeRuns.clear();
    this.releaseAllTerminals();
    this.rejectPending(new Error('Grok ACP process closed'));
    proc?.kill('SIGTERM');
  }

  async run(
    input: GrokRunInput,
    onEvent: (event: GrokEvent) => Promise<void>,
    signal: AbortSignal
  ): Promise<number> {
    let session: AcpSession | undefined;
    let abort: (() => void) | undefined;

    try {
      await onEvent({ type: 'status', text: '正在连接 Grok ACP。' });
      await this.ensureInitialized();
      await onEvent({ type: 'status', text: 'Grok ACP 已就绪。' });
      const cachedSession = this.sessions.get(input.sessionId);
      session = await this.getOrCreateSession(input);
      await onEvent({
        type: 'status',
        text:
          cachedSession && cachedSession.cwd === input.cwd
            ? `复用 Grok 原生会话 ${shortId(session.acpSessionId)}。`
            : `已绑定 Grok 原生会话 ${shortId(session.acpSessionId)}。`
      });
      const activeSession = session;
      const active: ActiveRun = { onEvent, tasks: [] };
      this.activeRuns.set(activeSession.acpSessionId, active);

      const abortPromise = new Promise<Record<string, unknown>>((_, reject) => {
        abort = (): void => {
          void this.cancelSession(activeSession.acpSessionId).then((cancelled) => {
            if (!cancelled) {
              this.close();
            }
          });
          reject(new GrokRunAbortedError());
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
      });

      const result = await Promise.race([
        onEvent({ type: 'status', text: '已发送 prompt，等待 Grok 输出或工具事件。' }).then(() =>
          this.request(
            'session/prompt',
            {
              sessionId: activeSession.acpSessionId,
              prompt: [{ type: 'text', text: buildPrompt(input) }]
            },
            180000
          )
        ),
        abortPromise
      ]);
      await Promise.all(active.tasks);
      return readString(result, 'stopReason') === 'end_turn' ? 0 : 1;
    } catch (error) {
      if (error instanceof AcpRequestTimeoutError) {
        this.close();
      }
      throw error;
    } finally {
      if (abort) {
        signal.removeEventListener('abort', abort);
      }
      if (session) {
        this.activeRuns.delete(session.acpSessionId);
      }
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize().catch((error: unknown) => {
      this.close();
      throw error;
    });
    await this.initialized;
  }

  private async initialize(): Promise<void> {
    const proc = spawn(this.grokBin, ['agent', 'stdio'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = proc;
    proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[grok stderr] ${String(chunk)}`);
    });
    proc.on('error', (error) => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.initialized = undefined;
        this.sessions.clear();
        this.activeRuns.clear();
        this.releaseAllTerminals();
      }
      this.rejectPending(error);
    });
    proc.on('exit', () => {
      this.proc = undefined;
      this.initialized = undefined;
      this.sessions.clear();
      this.activeRuns.clear();
      this.releaseAllTerminals();
      this.rejectPending(new Error('Grok ACP process exited'));
    });
    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => {
      this.handleLine(line);
    });

    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: true
      },
      clientInfo: {
        name: 'grok-lark-bridge',
        version: '0.1.0'
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
    this.bindNativeSession?.({
      grokSessionId: input.sessionId,
      nativeSessionId: acpSessionId,
      cwd: input.cwd
    });
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
      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      try {
        this.proc?.stdin.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async cancelSession(sessionId: string): Promise<boolean> {
    try {
      await this.request('session/cancel', { sessionId }, 5000);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[grok stderr] session cancel failed: ${message}\n`);
      return false;
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
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
    const id = readJsonRpcId(message, 'id');
    if (method && id !== undefined) {
      void this.handleClientRequest(id, method, message.params);
      return;
    }
    if (typeof id !== 'number') {
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

  private async handleClientRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.resolveClientRequest(method, params);
      this.sendJsonRpcResult(id, result);
    } catch (error) {
      this.sendJsonRpcError(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }

  private async resolveClientRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'fs/read_text_file') {
      return readAcpTextFile(params);
    }
    if (method === 'session/request_permission') {
      return { outcome: { outcome: 'cancelled' } };
    }
    if (method === 'terminal/create') {
      return this.createTerminal(params);
    }
    if (method === 'terminal/output') {
      return this.readTerminalOutput(params);
    }
    if (method === 'terminal/wait_for_exit') {
      return this.waitForTerminalExit(params);
    }
    if (method === 'terminal/kill') {
      this.killTerminal(params);
      return null;
    }
    if (method === 'terminal/release') {
      this.releaseTerminal(params);
      return null;
    }
    throw new Error(`Unsupported ACP client method: ${method}`);
  }

  private sendJsonRpcResult(id: JsonRpcId, result: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private sendJsonRpcError(id: JsonRpcId, code: number, message: string): void {
    this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  private createTerminal(params: unknown): { readonly terminalId: string } {
    const record = expectRecord(params, 'terminal params');
    const command = readString(record, 'command');
    if (!command) {
      throw new Error('terminal/create requires command');
    }
    const args = readStringArray(record.args) ?? [];
    const cwd = readString(record, 'cwd') ?? this.projectRoot;
    if (!path.isAbsolute(cwd)) {
      throw new Error('terminal/create cwd must be absolute');
    }
    const outputByteLimit = readPositiveInteger(record, 'outputByteLimit') ?? 1024 * 1024;
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...readEnv(record.env) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const terminalId = `term_${String(this.nextTerminalId)}`;
    this.nextTerminalId += 1;
    const terminal: AcpTerminal = {
      proc,
      output: '',
      truncated: false,
      exitStatus: undefined,
      outputByteLimit,
      waiters: []
    };
    this.terminals.set(terminalId, terminal);
    const append = (chunk: Buffer): void => {
      terminal.output += stripAnsi(String(chunk));
      const trimmed = trimToUtf8Bytes(terminal.output, terminal.outputByteLimit);
      if (trimmed !== terminal.output) {
        terminal.truncated = true;
        terminal.output = trimmed;
      }
    };
    proc.stdout.on('data', append);
    proc.stderr.on('data', append);
    proc.on('error', (error) => {
      terminal.output += `${error.message}\n`;
      this.finishTerminal(terminal, { exitCode: null, signal: null });
    });
    proc.on('close', (code, signal) => {
      this.finishTerminal(terminal, { exitCode: code, signal });
    });
    return { terminalId };
  }

  private readTerminalOutput(params: unknown): {
    readonly output: string;
    readonly truncated: boolean;
    readonly exitStatus?: TerminalExitStatus;
  } {
    const terminal = this.getTerminal(params);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {})
    };
  }

  private waitForTerminalExit(params: unknown): Promise<TerminalExitStatus> {
    const terminal = this.getTerminal(params);
    if (terminal.exitStatus) {
      return Promise.resolve(terminal.exitStatus);
    }
    return new Promise((resolve) => {
      terminal.waiters.push(resolve);
    });
  }

  private killTerminal(params: unknown): void {
    const terminal = this.getTerminal(params);
    if (!terminal.exitStatus) {
      terminal.proc.kill('SIGTERM');
    }
  }

  private releaseTerminal(params: unknown): void {
    const record = expectRecord(params, 'terminal params');
    const terminalId = readString(record, 'terminalId');
    if (!terminalId) {
      throw new Error('terminal request requires terminalId');
    }
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return;
    }
    if (!terminal.exitStatus) {
      terminal.proc.kill('SIGTERM');
    }
    this.terminals.delete(terminalId);
  }

  private releaseAllTerminals(): void {
    for (const terminal of this.terminals.values()) {
      if (!terminal.exitStatus) {
        terminal.proc.kill('SIGTERM');
      }
    }
    this.terminals.clear();
  }

  private getTerminal(params: unknown): AcpTerminal {
    const record = expectRecord(params, 'terminal params');
    const terminalId = readString(record, 'terminalId');
    if (!terminalId) {
      throw new Error('terminal request requires terminalId');
    }
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminalId: ${terminalId}`);
    }
    return terminal;
  }

  private finishTerminal(terminal: AcpTerminal, status: TerminalExitStatus): void {
    if (terminal.exitStatus) {
      return;
    }
    terminal.exitStatus = status;
    const waiters = terminal.waiters.splice(0);
    for (const resolve of waiters) {
      resolve(status);
    }
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
  const notice = parseAcpNoticeUpdate(sessionUpdate, update);
  const content = update.content;
  if (!isRecord(content)) {
    return notice;
  }
  const text = readString(content, 'text');
  if (!text) {
    return notice;
  }
  if (sessionUpdate === 'agent_message_chunk') {
    return { type: 'text', text: sanitizeForCard(text) };
  }
  if (notice) {
    return notice;
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
  const toolCall = toOptionalRecord(update.toolCall);
  const toolCallId = readString(update, 'toolCallId') ?? readString(toolCall, 'id');
  const title = readString(update, 'title') ?? readString(toolCall, 'title');
  const rawInput = update.rawInput ?? update.args ?? update.input ?? toolCall.arguments;
  const rawOutput = update.rawOutput ?? update.output ?? update.result;
  const kind = readString(update, 'kind');
  const name =
    title ??
    readString(update, 'toolName') ??
    readString(update, 'name') ??
    readString(toolCall, 'name') ??
    sessionUpdate;
  const text =
    readString(update, 'text') ??
    summarizeToolValue(update.content) ??
    summarizeToolValue(rawInput) ??
    summarizeToolValue(rawOutput) ??
    name;
  if (isGenericToolNoise(sessionUpdate, name, text, update)) {
    return undefined;
  }
  const outputSummary = summarizeToolValue(rawOutput);
  const inputSummary = summarizeToolValue(rawInput);
  return compactToolEvent({
    type: 'tool',
    name,
    text: sanitizeForCard(text),
    toolCallId,
    status: inferToolStatus(sessionUpdate, update, text, rawOutput),
    kind: inferToolKind(kind ?? name),
    inputSummary,
    outputSummary,
    durationMs: readDurationMs(update),
    approvalId: readApprovalId(text) ?? readString(update, 'approvalId'),
    artifactPath: extractImagePath(rawOutput) ?? extractImagePath(update.content),
    artifactUrl: extractImageUrl(rawOutput) ?? extractImageUrl(update.content)
  });
}

function parseAcpNoticeUpdate(
  sessionUpdate: string | undefined,
  update: Record<string, unknown>
): GrokEvent | undefined {
  if (!sessionUpdate) {
    return undefined;
  }
  if (sessionUpdate === 'available_commands_update') {
    return undefined;
  }
  if (sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'agent_thought_chunk') {
    return undefined;
  }
  if (isGenericToolNotice(sessionUpdate, update)) {
    return undefined;
  }
  return { type: 'status', text: formatAcpNotice(sessionUpdate, update) };
}

function isGenericToolNotice(sessionUpdate: string, update: Record<string, unknown>): boolean {
  if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') {
    return false;
  }
  if (
    readString(update, 'toolCallId') ||
    readString(update, 'title') ||
    readString(update, 'toolName') ||
    readString(update, 'name') ||
    update.rawInput !== undefined ||
    update.rawOutput !== undefined ||
    update.status !== undefined
  ) {
    return false;
  }
  const content = toOptionalRecord(update.content);
  const text = readString(content, 'text');
  return text === undefined || text === sessionUpdate;
}

function formatAcpNotice(sessionUpdate: string, update: Record<string, unknown>): string {
  const keys = Object.keys(update)
    .filter((key) => key !== 'sessionUpdate')
    .slice(0, 4);
  const suffix = keys.length > 0 ? ` (${keys.join(', ')})` : '';
  return `收到 Grok 运行事件：${sessionUpdate}${suffix}`;
}

function isGenericToolNoise(
  sessionUpdate: string,
  name: string,
  text: string,
  update: Record<string, unknown>
): boolean {
  const generic = new Set(['tool_call', 'tool_call_update']);
  if (!generic.has(sessionUpdate)) {
    return false;
  }
  if (
    readString(update, 'toolCallId') ||
    readString(update, 'title') ||
    update.rawInput !== undefined ||
    update.rawOutput !== undefined ||
    update.status !== undefined
  ) {
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
  const type = isRecord(parsed) ? readString(parsed, 'type') : undefined;
  if (type?.includes('tool')) {
    const name = isRecord(parsed) ? (readString(parsed, 'name') ?? type) : type;
    const text =
      findText(parsed) ??
      (isRecord(parsed)
        ? (summarizeToolValue(parsed.args) ??
          summarizeToolValue(parsed.input) ??
          summarizeToolValue(parsed.result) ??
          summarizeToolValue(parsed.output))
        : undefined) ??
      name;
    const inputSummary = isRecord(parsed)
      ? (summarizeToolValue(parsed.args) ?? summarizeToolValue(parsed.input))
      : undefined;
    const outputSummary = isRecord(parsed)
      ? (summarizeToolValue(parsed.result) ?? summarizeToolValue(parsed.output))
      : undefined;
    return compactToolEvent({
      type: 'tool',
      name,
      text: sanitizeForCard(text),
      status: isRecord(parsed) ? inferToolStatus(type, parsed, text, parsed.output) : 'running',
      kind: inferToolKind(name),
      inputSummary,
      outputSummary,
      durationMs: isRecord(parsed) ? readDurationMs(parsed) : undefined,
      approvalId: readApprovalId(text)
    });
  }
  const text = findText(parsed);
  if (!text) {
    return undefined;
  }
  return { type: 'text', text: sanitizeForCard(text) };
}

function compactToolEvent(event: ToolEvent): ToolEvent {
  const result: {
    type: 'tool';
    name: string;
    text: string;
    toolCallId?: string;
    status?: ToolEventStatus;
    kind?: ToolKind;
    inputSummary?: string;
    outputSummary?: string;
    durationMs?: number;
    approvalId?: string;
    artifactPath?: string;
    artifactUrl?: string;
  } = {
    type: 'tool',
    name: event.name,
    text: event.text
  };
  if (event.toolCallId !== undefined) result.toolCallId = event.toolCallId;
  if (event.status !== undefined) result.status = event.status;
  if (event.kind !== undefined && event.kind !== 'generic') result.kind = event.kind;
  if (event.inputSummary !== undefined) result.inputSummary = event.inputSummary;
  if (event.outputSummary !== undefined) result.outputSummary = event.outputSummary;
  if (event.durationMs !== undefined) result.durationMs = event.durationMs;
  if (event.approvalId !== undefined) result.approvalId = event.approvalId;
  if (event.artifactPath !== undefined) result.artifactPath = event.artifactPath;
  if (event.artifactUrl !== undefined) result.artifactUrl = event.artifactUrl;
  return result;
}

function inferToolStatus(
  eventType: string,
  payload: Record<string, unknown>,
  text: string,
  rawOutput?: unknown
): ToolEventStatus | undefined {
  const explicit = readString(payload, 'status');
  const haystack = `${eventType} ${explicit ?? ''} ${text}`.toLowerCase();
  if (haystack.includes('approval requested')) return 'pending_approval';
  if (haystack.includes('pending_approval')) return 'pending_approval';
  if (haystack.includes('failed') || haystack.includes('error')) return 'error';
  if (haystack.includes('completed') || haystack.includes('complete')) return 'done';
  if (haystack.includes('success') || haystack.includes('succeeded')) return 'done';
  if (haystack.includes('result') || payload.result !== undefined || rawOutput !== undefined) {
    return 'done';
  }
  if (haystack.includes('started') || haystack.includes('call')) return 'running';
  return undefined;
}

function inferToolKind(name: string): ToolKind | undefined {
  const lower = name.toLowerCase();
  if (lower.includes('search') || lower.includes('web')) return 'web_search';
  if (lower.includes('image') || lower.includes('media') || lower.includes('photo')) return 'media';
  if (lower.includes('write') || lower.includes('edit') || lower.includes('diff')) {
    return 'file_change';
  }
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('command')) {
    return 'command';
  }
  if (lower.startsWith('lark_') || lower.includes('mcp')) return 'mcp';
  return undefined;
}

function summarizeToolValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    if (isRecord(parsed) || Array.isArray(parsed)) {
      return summarizeToolValue(parsed);
    }
    const text = compactSummaryText(value);
    return text ? text.slice(0, 160) : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 0) {
      return `${String(value.length)} items`;
    }
    const json = JSON.stringify(value);
    return json.length > 0 ? compactSummaryText(json).slice(0, 160) : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (Object.keys(value).length === 0) {
    return undefined;
  }
  const query = readString(value, 'query');
  if (query) {
    return `query: ${compactSummaryText(query).slice(0, 140)}`;
  }
  const command = readString(value, 'command');
  if (command) {
    return compactSummaryText(command).slice(0, 160);
  }
  const targetDirectory =
    readString(value, 'target_directory') ?? readString(value, 'targetDirectory');
  if (targetDirectory) {
    return `dir: ${compactSummaryText(targetDirectory).slice(0, 150)}`;
  }
  const targetFile = readString(value, 'target_file') ?? readString(value, 'targetFile');
  if (targetFile) {
    return `file: ${compactSummaryText(targetFile).slice(0, 145)}`;
  }
  const variant = readString(value, 'variant');
  const pattern = readString(value, 'pattern');
  if (variant === 'Grep' && pattern) {
    const searchPath = readString(value, 'path') ?? '.';
    return `grep: ${compactSummaryText(pattern).slice(0, 80)} in ${compactSummaryText(searchPath).slice(0, 60)}`;
  }
  const prompt = readString(value, 'prompt');
  if (prompt) {
    return `prompt: ${compactSummaryText(prompt).slice(0, 140)}`;
  }
  const results = value.results;
  if (Array.isArray(results)) {
    return `${String(results.length)} results`;
  }
  const messageId = readString(value, 'message_id') ?? readString(value, 'messageId');
  if (messageId) {
    return `message: ${compactSummaryText(messageId).slice(0, 120)}`;
  }
  const outputRecord = toOptionalRecord(value.output);
  const mcpOutput =
    readString(outputRecord, 'OkayOutput') ??
    readString(outputRecord, 'ErrorOutput') ??
    readString(value, 'OkayOutput') ??
    readString(value, 'ErrorOutput');
  if (mcpOutput) {
    return summarizeToolValue(mcpOutput);
  }
  const contentRecord = firstRecord(value.Content, value.FileContent, value.content);
  const contentText = readString(contentRecord, 'content') ?? readString(value, 'content');
  if (readString(value, 'type') === 'ListDir' && contentText) {
    return `${String(countListEntries(contentText))} entries`;
  }
  if (readString(value, 'type') === 'ReadFile' && contentText) {
    return `${String(contentText.length)} chars`;
  }
  const stdoutText = decodeByteArray(value.stdout);
  if (readString(value, 'type') === 'GrepSearch' && stdoutText) {
    return compactSummaryText(stdoutText).slice(0, 160);
  }
  const imagePath = extractImagePath(value);
  if (imagePath) {
    return `image: ${path.basename(imagePath)}`;
  }
  const imageUrl = extractImageUrl(value);
  if (imageUrl) {
    return `image: ${compactSummaryText(imageUrl).slice(0, 150)}`;
  }
  const text = findText(value);
  if (text) {
    return summarizeToolValue(text);
  }
  const json = JSON.stringify(value);
  return json.length > 0 ? compactSummaryText(json).slice(0, 160) : undefined;
}

function compactSummaryText(value: string): string {
  return sanitizeForCard(value).replace(/\s+/gu, ' ').trim();
}

function countListEntries(value: string): number {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ')).length;
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (isRecord(value)) {
      return value;
    }
  }
  return {};
}

function decodeByteArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const bytes: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255) {
      return undefined;
    }
    bytes.push(item);
  }
  return Buffer.from(bytes).toString('utf8');
}

function extractImagePath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return isImagePath(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractImagePath(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ['file_path', 'filePath', 'image_path', 'imagePath', 'path', 'localPath']) {
    const item = readString(value, key);
    if (item && isImagePath(item)) {
      return item;
    }
  }
  for (const item of Object.values(value)) {
    const found = extractImagePath(item);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function extractImageUrl(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return isHttpUrl(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractImageUrl(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ['image_url', 'imageUrl', 'url']) {
    const item = readString(value, key);
    if (item && isHttpUrl(item)) {
      return item;
    }
  }
  for (const item of Object.values(value)) {
    const found = extractImageUrl(item);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function isImagePath(value: string): boolean {
  if (isHttpUrl(value)) {
    return false;
  }
  return /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(value);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//u.test(value);
}

function readDurationMs(record: Record<string, unknown>): number | undefined {
  for (const key of ['durationMs', 'duration_ms', 'elapsedMs', 'elapsed_ms']) {
    const value = record[key];
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function readApprovalId(text: string): string | undefined {
  return /Approval requested:\s*([A-Za-z0-9_-]+)/u.exec(text)?.[1];
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}...${id.slice(-4)}`;
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

function readJsonRpcId(record: Record<string, unknown>, key: string): JsonRpcId | undefined {
  const value = record[key];
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

export async function readAcpTextFile(params: unknown): Promise<{ readonly content: string }> {
  const record = expectRecord(params, 'fs/read_text_file params');
  const filePath = readString(record, 'path');
  if (!filePath) {
    throw new Error('fs/read_text_file requires path');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error('fs/read_text_file path must be absolute');
  }
  const content = await fs.promises.readFile(filePath, 'utf8');
  const startLine = readPositiveInteger(record, 'line') ?? readPositiveInteger(record, 'startLine');
  const lineLimit = readPositiveInteger(record, 'limit') ?? readPositiveInteger(record, 'numLines');
  if (startLine === undefined && lineLimit === undefined) {
    return { content };
  }
  const lines = content.split(/\r?\n/u);
  const startIndex = (startLine ?? 1) - 1;
  const endIndex = lineLimit === undefined ? undefined : startIndex + lineLimit;
  return { content: lines.slice(startIndex, endIndex).join('\n') };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error('terminal/create args must be strings');
    }
    result.push(item);
  }
  return result;
}

function readEnv(value: unknown): NodeJS.ProcessEnv {
  if (!Array.isArray(value)) {
    return {};
  }
  const env: NodeJS.ProcessEnv = {};
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error('terminal/create env entries must be objects');
    }
    const name = readString(item, 'name');
    const envValue = readString(item, 'value');
    if (!name || envValue === undefined) {
      throw new Error('terminal/create env entries require name and value');
    }
    env[name] = envValue;
  }
  return env;
}

function trimToUtf8Bytes(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= byteLimit) {
    return value;
  }
  const kept: string[] = [];
  let bytes = 0;
  const chars = Array.from(value);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > byteLimit) {
      break;
    }
    kept.push(char);
    bytes += charBytes;
  }
  return kept.reverse().join('');
}

function toOptionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function buildPrompt(input: GrokRunInput): string {
  return [
    'You are running behind Grok Lark Bridge.',
    `Feishu context_key: ${input.contextKey}`,
    `Feishu requested_by_open_id: ${input.requestedByOpenId}`,
    'For ordinary chat replies, do not call Feishu MCP tools. Return assistant text normally; the bridge will send it to Feishu.',
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
