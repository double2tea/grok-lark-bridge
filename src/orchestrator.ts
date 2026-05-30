import { CommandRouter } from './commands.js';
import type { FeishuApiPort } from './feishu-api.js';
import { FeishuToolExecutor } from './feishu-tools.js';
import { GrokRunAbortedError } from './grok.js';
import type {
  BridgeConfig,
  FeishuCardUpdate,
  GrokBackend,
  GrokEvent,
  IncomingCardAction,
  IncomingMessage,
  SessionRecord
} from './types.js';
import { SessionService } from './session.js';
import { StateStore } from './storage.js';
import { describeError, toError, truncate } from './utils.js';
import {
  type RunState as AgentRunState,
  initialState as initialAgentState,
  reduce as reduceAgentState,
  toCardBody,
  markInterrupted,
  finalizeIfRunning,
  markIdleTimeout
} from './card/run-state.js';

interface RunState {
  readonly controller: AbortController;
  agentState: AgentRunState;
  cardMessageId: string | null;
}

interface PendingBatch {
  readonly messages: IncomingMessage[];
  timer: NodeJS.Timeout;
}

const messageBatchMs = 1200;
const grokIdleTimeoutMs = 10 * 60 * 1000;
const grokFirstOutputTimeoutMs = 30 * 1000;
const maxDiagnostics = 80;
const cardUpdateMinIntervalMs = 1500;
const textUpdateMinIntervalMs = 2000;

interface OutputTextState {
  messageId: string | undefined;
  text: string;
  deliveredText: string;
  announced: boolean;
  editFailed: boolean;
  chain: Promise<void>;
}

export class RuntimeOrchestrator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly queueVersions = new Map<string, number>();
  private readonly runs = new Map<string, RunState>();
  private readonly pendingBatches = new Map<string, PendingBatch>();
  private readonly diagnostics: string[] = [];
  private readonly commands: CommandRouter;

  constructor(
    config: BridgeConfig,
    private readonly api: FeishuApiPort,
    private readonly store: StateStore,
    private readonly sessions: SessionService,
    private readonly grok: GrokBackend,
    private readonly tools: FeishuToolExecutor
  ) {
    this.commands = new CommandRouter(config, store, sessions, () => this.diagnostics.slice(-20));
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    this.record(
      'info',
      `Feishu message received chat=${message.chatId} type=${message.chatType} mentioned=${String(message.mentionsBot)} event=${message.eventId}`
    );
    if (this.store.hasProcessedEvent(message.eventId)) {
      this.record('info', `Feishu message ignored duplicate event=${message.eventId}`);
      return;
    }
    this.store.markProcessedEvent(message.eventId);

    if (!this.sessions.isAllowed(message)) {
      this.record('info', `Feishu message ignored by access config chat=${message.chatId}`);
      return;
    }
    if (message.chatType === 'group' && !message.mentionsBot) {
      this.record(
        'info',
        `Feishu group message ignored because bot was not mentioned chat=${message.chatId}`
      );
      return;
    }

    const session = this.sessions.getOrCreateFromMessage(message);
    if (message.text.trim() === '/stop') {
      this.clearPendingBatch(session.key);
      this.cancelQueuedWork(session.key);
      await this.executeCommand(message, session);
      return;
    }
    if (await this.executeCommand(message, session)) {
      return;
    }
    this.scheduleMessage(message, session);
  }

  async handleCardAction(action: IncomingCardAction): Promise<void> {
    if (this.store.hasProcessedEvent(action.eventId)) {
      return;
    }
    this.store.markProcessedEvent(action.eventId);

    if (action.action === 'stop_run' && action.contextKey) {
      this.stopRun(action.contextKey);
      return;
    }
    if (action.action === 'run_command' && action.command && action.contextKey) {
      const session = this.sessions.getOrCreateByKey(action.contextKey);
      await this.executeCommand(
        {
          eventId: action.eventId,
          chatId: session.chatId,
          messageId: action.messageId ?? action.eventId,
          senderOpenId: action.operatorOpenId,
          chatType: session.threadId ? 'group' : 'p2p',
          text: action.command,
          mentionsBot: true,
          threadId: session.threadId ?? undefined
        },
        session
      );
      return;
    }
    if (!action.approvalId) {
      return;
    }
    if (action.action === 'approval_reject') {
      this.tools.rejectPendingApproval(action.approvalId);
      if (action.messageId) {
        await this.safePatchCard(action.messageId, {
          title: '飞书操作已拒绝',
          status: 'warning',
          body: `approval: ${action.approvalId}`
        });
      }
      return;
    }
    if (action.action !== 'approval_approve') {
      return;
    }

    try {
      const result = await this.tools.executePendingApproval(action.approvalId);
      if (action.messageId) {
        await this.safePatchCard(action.messageId, {
          title: '飞书操作已执行',
          status: 'success',
          body: result.text
        });
      }

      // Link approval result back into any active main agent run card for this context (better continuity)
      const activeRun = action.contextKey ? this.runs.get(action.contextKey) : undefined;
      if (activeRun && action.approvalId && action.contextKey) {
        // We don't have the tool name here easily, but we can at least append a status
        activeRun.agentState = {
          ...activeRun.agentState,
          blocks: [
            ...activeRun.agentState.blocks,
            { kind: 'status', content: `飞书审批已通过并执行 (approval: ${action.approvalId})` }
          ],
          footer: null
        };
        if (activeRun.cardMessageId) {
          void this.safePatchCard(activeRun.cardMessageId, {
            title: 'Grok 正在处理',
            status: 'info',
            body: toCardBody(activeRun.agentState),
            actions: [
              {
                text: '停止',
                type: 'danger',
                value: { action: 'stop_run', context_key: action.contextKey ?? '' }
              }
            ]
          });
        }
      }
    } catch (error) {
      if (action.messageId) {
        await this.safePatchCard(action.messageId, {
          title: '飞书操作执行失败',
          status: 'error',
          body: toError(error).message
        });
      }
      throw error;
    }
  }

  private async executeCommand(message: IncomingMessage, session: SessionRecord): Promise<boolean> {
    let command: ReturnType<CommandRouter['handle']>;
    try {
      command = this.commands.handle(message, session);
    } catch (error) {
      await this.sendCardOrNotify(session.chatId, {
        title: '命令执行失败',
        status: 'error',
        body: toError(error).message,
        actions: commandActions(session.key)
      });
      return true;
    }
    if (!command.handled) {
      return false;
    }
    if (command.stopRequested) {
      this.stopRun(session.key);
    }
    const updatedSession = command.session ?? session;
    if (message.text.trim() === '/help') {
      await this.sendCardOrNotify(updatedSession.chatId, buildHelpCard(updatedSession.key));
      return true;
    }
    if (command.text) {
      await this.sendCardOrNotify(updatedSession.chatId, {
        title: commandTitle(message.text),
        status: command.stopRequested ? 'warning' : 'info',
        body: command.text,
        actions: commandActions(updatedSession.key)
      });
    }
    return true;
  }

  private async processMessage(message: IncomingMessage): Promise<void> {
    const session = this.sessions.getOrCreateFromMessage(message);
    const previousRun = this.runs.get(session.key);
    const reusePreviousCard = previousRun?.cardMessageId !== undefined;

    let cardMessageId: string | null = null;
    let isNewCardForThisRun = false;

    if (previousRun?.cardMessageId) {
      cardMessageId = previousRun.cardMessageId;
      isNewCardForThisRun = false;
    } else {
      const initialCard = {
        title: 'Grok 正在处理',
        status: 'info' as const,
        body: '已收到消息，正在发送到当前 Grok 会话。',
        actions: [
          {
            text: '停止',
            type: 'danger' as const,
            value: { action: 'stop_run', context_key: session.key }
          }
        ]
      };
      cardMessageId = (await this.sendCardOrNotify(session.chatId, initialCard)) ?? null;
      isNewCardForThisRun = true;
    }

    this.store.setSessionRun(session.key, 'running', cardMessageId ?? null);
    this.record(
      'info',
      `Grok run started context=${session.key} cwd=${session.cwd} card=${cardMessageId ?? 'none'} reuse=${String(reusePreviousCard)}`
    );

    const controller = new AbortController();

    // Structured state for rich incremental updates (text + tools + status)
    let agentState: AgentRunState = previousRun
      ? finalizeIfRunning(previousRun.agentState)
      : { ...initialAgentState };

    this.runs.set(session.key, {
      controller,
      agentState,
      cardMessageId: cardMessageId ?? null
    });

    // Streaming UX note:
    // We intentionally do NOT send any intermediate "收到新消息..." patch on follow-ups.
    // The very first GrokEvent from the new run will directly update the existing card via the RunState.
    // This avoids extra card flashes and gives a much smoother continuous streaming feel.

    const timeoutState = { timedOut: false };
    const outputState = { hasOutput: false };
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdleWatchdog = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        timeoutState.timedOut = true;
        controller.abort();
        const current = this.runs.get(session.key);
        if (current) {
          current.agentState = markIdleTimeout(
            current.agentState,
            Math.floor(grokIdleTimeoutMs / 60000)
          );
        }
        void this.reportRunUpdate(session.chatId, cardMessageId ?? undefined, {
          title: 'Grok 执行超时',
          status: 'error',
          body: toCardBody(
            current?.agentState ?? { blocks: [], footer: null, terminal: 'idle_timeout' as const }
          )
        });
      }, grokIdleTimeoutMs);
    };
    armIdleWatchdog();
    const firstOutputTimer = setTimeout(() => {
      if (outputState.hasOutput) {
        return;
      }
      timeoutState.timedOut = true;
      controller.abort();
      const current = this.runs.get(session.key);
      void this.reportRunUpdate(session.chatId, cardMessageId ?? undefined, {
        title: 'Grok 长时间无响应',
        status: 'error',
        body: 'Grok 已收到任务，但 30 秒内没有返回任何输出；已终止本轮并准备接收下一条消息。'
      });
      if (current) {
        current.agentState = markInterrupted(current.agentState);
      }
    }, grokFirstOutputTimeoutMs);

    const liveCardMessageId = cardMessageId ?? undefined;
    const liveCard = liveCardMessageId
      ? new ThrottledCardUpdater((update) =>
          this.safePatchCard(liveCardMessageId, update, session.chatId)
        )
      : undefined;
    const outputText: OutputTextState = {
      messageId: undefined,
      text: '',
      deliveredText: '',
      announced: false,
      editFailed: false,
      chain: Promise.resolve()
    };
    const liveText = new ThrottledTextUpdater(
      (text) => this.patchOutputText(outputText, text),
      textUpdateMinIntervalMs
    );

    const update = (event: GrokEvent): Promise<void> => {
      armIdleWatchdog();
      outputState.hasOutput = true;
      clearTimeout(firstOutputTimer);

      if (event.type === 'text') {
        outputText.text += event.text;
        outputText.chain = outputText.chain.then(() =>
          this.publishOutputText(outputText, liveText, session.chatId)
        );
        if (liveCard && !outputText.announced) {
          outputText.announced = true;
          liveCard.request({
            title: isNewCardForThisRun ? 'Grok 正在处理' : 'Grok 继续处理',
            status: 'info',
            body: '正在流式输出，详情见下方文本消息。',
            actions: [
              {
                text: '停止',
                type: 'danger',
                value: { action: 'stop_run', context_key: session.key }
              }
            ]
          });
        }
        return outputText.chain;
      }

      // Feed event into the structured state machine (big UX upgrade)
      agentState = reduceAgentState(agentState, event);

      if (liveCard) {
        const body = toCardBody(agentState);
        liveCard.request({
          title: isNewCardForThisRun ? 'Grok 正在处理' : 'Grok 继续处理',
          status: 'info',
          body,
          actions: [
            {
              text: '停止',
              type: 'danger',
              value: { action: 'stop_run', context_key: session.key }
            }
          ]
        });
      }
      return Promise.resolve();
    };

    try {
      const code = await this.grok.run(
        {
          prompt: message.text,
          cwd: session.cwd,
          sessionId: session.grokSessionId,
          contextKey: session.key,
          requestedByOpenId: message.senderOpenId
        },
        update,
        controller.signal
      );
      await outputText.chain;
      await liveText.flush();
      await this.sendFinalOutputFallback(outputText, session.chatId);
      await liveCard?.flush();

      // Finalize the structured state
      agentState = finalizeIfRunning(agentState);
      const finalBody = toHybridCardBody(agentState, outputText.text.length > 0);

      await this.reportRunUpdate(session.chatId, cardMessageId ?? undefined, {
        title: code === 0 ? 'Grok 执行完成' : 'Grok 执行失败',
        status: code === 0 ? 'success' : 'error',
        body: finalBody
      });
    } catch (error) {
      await outputText.chain;
      await liveText.flush();
      await this.sendFinalOutputFallback(outputText, session.chatId);
      await liveCard?.flush();
      if (!timeoutState.timedOut) {
        agentState = markInterrupted(agentState);
        if (error instanceof GrokRunAbortedError) {
          await this.reportRunUpdate(session.chatId, cardMessageId ?? undefined, {
            title: 'Grok 已停止',
            status: 'warning',
            body: '本轮运行已手动停止。'
          });
        } else {
          await this.reportRunUpdate(session.chatId, cardMessageId ?? undefined, {
            title: 'Grok 执行异常',
            status: 'error',
            body: toError(error).message
          });
        }
      }
    } finally {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      clearTimeout(firstOutputTimer);
      // Persist final structured agent state for potential follow-up card reuse
      const currentRun = this.runs.get(session.key);
      if (currentRun) {
        currentRun.agentState = agentState;
      }
      this.runs.delete(session.key);
      this.store.setSessionRun(session.key, 'idle', null);
    }
  }

  private enqueue(
    key: string,
    work: () => Promise<void>,
    onError: (error: unknown) => Promise<void>
  ): void {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch((error: unknown) => {
        this.record('error', `Previous queued work failed for ${key}: ${describeError(error)}`);
      })
      .then(work)
      .catch(async (error: unknown) => {
        this.record('error', `Queued work failed for ${key}: ${describeError(error)}`);
        await onError(error);
      })
      .finally(() => {
        if (this.queues.get(key) === next) {
          this.queues.delete(key);
        }
      });
    this.queues.set(key, next);
  }

  private scheduleMessage(message: IncomingMessage, session: SessionRecord): void {
    const existing = this.pendingBatches.get(session.key);
    if (existing) {
      existing.messages.push(message);
      clearTimeout(existing.timer);
      existing.timer = this.createBatchTimer(session.key);
      this.record(
        'info',
        `Feishu message batched context=${session.key} count=${String(existing.messages.length)}`
      );
      return;
    }
    this.pendingBatches.set(session.key, {
      messages: [message],
      timer: this.createBatchTimer(session.key)
    });
  }

  private createBatchTimer(key: string): NodeJS.Timeout {
    return setTimeout(() => {
      this.flushMessageBatch(key);
    }, messageBatchMs);
  }

  private flushMessageBatch(key: string): void {
    const batch = this.pendingBatches.get(key);
    if (!batch) {
      return;
    }
    this.pendingBatches.delete(key);
    const message = mergeMessages(batch.messages);
    const session = this.sessions.getOrCreateFromMessage(message);
    const version = this.queueVersions.get(key) ?? 0;
    if (this.queues.has(key) || this.runs.has(key)) {
      void this.notifyText(
        session.chatId,
        '已收到新消息，已加入当前 Grok 会话队列。',
        'queue notice'
      );
    }
    this.enqueue(
      key,
      async () => {
        if ((this.queueVersions.get(key) ?? 0) !== version) {
          this.record('info', `Grok queued work skipped after stop context=${key}`);
          return;
        }
        this.record(
          'info',
          `Grok run queued context=${session.key} messages=${String(batch.messages.length)} prompt=${truncate(message.text, 80)}`
        );
        await this.processMessage(message);
      },
      async (error) => {
        await this.notifyText(
          session.chatId,
          `Grok 队列任务失败: ${toError(error).message}`,
          'queued run failure'
        );
      }
    );
  }

  private clearPendingBatch(key: string): void {
    const batch = this.pendingBatches.get(key);
    if (!batch) {
      return;
    }
    clearTimeout(batch.timer);
    this.pendingBatches.delete(key);
  }

  private stopRun(key: string): void {
    const run = this.runs.get(key);
    if (!run) {
      return;
    }
    run.controller.abort();
    run.agentState = markInterrupted(run.agentState);
    this.store.setSessionRun(key, 'stopping', null);
  }

  private cancelQueuedWork(key: string): void {
    this.queueVersions.set(key, (this.queueVersions.get(key) ?? 0) + 1);
  }

  private async safePatchCard(
    messageId: string,
    update: Parameters<FeishuApiPort['patchCard']>[1],
    fallbackChatId?: string
  ): Promise<void> {
    try {
      await this.api.patchCard(messageId, update);
    } catch (error) {
      this.record('error', `Failed to patch Feishu card ${messageId}: ${describeError(error)}`);
      if (fallbackChatId) {
        await this.notifyText(fallbackChatId, formatCardUpdate(update), 'card patch failure');
      }
    }
  }

  private async patchOutputText(output: OutputTextState, text: string): Promise<void> {
    if (!output.messageId || output.editFailed) {
      return;
    }
    try {
      await this.api.patchText(output.messageId, text);
      output.deliveredText = text;
    } catch (error) {
      output.editFailed = true;
      this.record(
        'error',
        `Failed to patch Feishu text ${output.messageId}: ${describeError(error)}`
      );
    }
  }

  private async publishOutputText(
    output: OutputTextState,
    liveText: ThrottledTextUpdater,
    chatId: string
  ): Promise<void> {
    const text = truncate(output.text, 8000);
    if (!text) {
      return;
    }
    if (!output.messageId) {
      try {
        output.messageId = await this.api.sendText(chatId, text);
        output.deliveredText = text;
      } catch (error) {
        this.record(
          'error',
          `Failed to send Feishu output text to ${chatId}: ${describeError(error)}`
        );
      }
      return;
    }
    liveText.request(text);
  }

  private async sendFinalOutputFallback(output: OutputTextState, chatId: string): Promise<void> {
    if (!output.editFailed) {
      return;
    }
    const text = truncate(output.text, 8000);
    if (!text || text === output.deliveredText) {
      return;
    }
    await this.notifyText(chatId, text, 'final text fallback');
    output.deliveredText = text;
  }

  private async sendCardOrNotify(
    chatId: string,
    update: Parameters<FeishuApiPort['sendCard']>[1]
  ): Promise<string | undefined> {
    try {
      return await this.api.sendCard(chatId, update);
    } catch (error) {
      this.record('error', `Failed to send Feishu card to ${chatId}: ${describeError(error)}`);
      await this.notifyText(
        chatId,
        `Grok 卡片发送失败，改用文本回报。\n${toError(error).message}`,
        'card send failure'
      );
      return undefined;
    }
  }

  private async reportRunUpdate(
    chatId: string,
    messageId: string | undefined,
    update: Parameters<FeishuApiPort['patchCard']>[1]
  ): Promise<void> {
    if (messageId) {
      await this.safePatchCard(messageId, update, chatId);
      return;
    }
    await this.notifyText(chatId, formatCardUpdate(update), 'run text update');
  }

  private async notifyText(chatId: string, text: string, label: string): Promise<void> {
    try {
      await this.api.sendText(chatId, text);
    } catch (error) {
      this.record(
        'error',
        `Failed to send Feishu text fallback (${label}) to ${chatId}: ${describeError(error)}`
      );
    }
  }

  private record(level: 'info' | 'error', message: string): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
    this.diagnostics.push(line);
    if (this.diagnostics.length > maxDiagnostics) {
      this.diagnostics.splice(0, this.diagnostics.length - maxDiagnostics);
    }
    if (level === 'error') {
      console.error(message);
      return;
    }
    console.info(message);
  }
}

function buildHelpCard(contextKey: string): FeishuCardUpdate {
  return {
    title: 'Grok Lark Bridge',
    status: 'info',
    body: [
      '常用命令可以直接点击下方按钮。',
      '',
      '/cd <path>',
      '/workspace list|save|use|remove',
      '/approval confirm_write|confirm_all|auto'
    ].join('\n'),
    actions: commandActions(contextKey)
  };
}

function commandActions(contextKey: string) {
  return [
    commandAction('状态', '/status', contextKey),
    commandAction('新会话', '/new', contextKey),
    commandAction('停止', '/stop', contextKey, 'danger'),
    commandAction('MCP 工具', '/mcp tools', contextKey),
    commandAction('权限检查', '/mcp scopes', contextKey),
    commandAction('诊断', '/doctor', contextKey)
  ];
}

function commandAction(
  text: string,
  command: string,
  contextKey: string,
  type: 'primary' | 'danger' | 'default' = 'default'
) {
  return {
    text,
    type,
    value: { action: 'run_command', command, context_key: contextKey }
  };
}

function commandTitle(text: string): string {
  const [command, subcommand] = text.trim().split(/\s+/u);
  switch (command) {
    case '/status':
      return 'Grok 状态';
    case '/new':
    case '/reset':
      return 'Grok 新会话';
    case '/stop':
      return 'Grok 已停止';
    case '/cd':
      return '工作目录';
    case '/workspace':
      return subcommand ? `Workspace ${subcommand}` : 'Workspace';
    case '/approval':
      return '审批策略';
    case '/mcp':
      return subcommand ? `MCP ${subcommand}` : 'MCP';
    case '/doctor':
      return 'Bridge 诊断';
    default:
      return '命令结果';
  }
}

function formatCardUpdate(update: Parameters<FeishuApiPort['patchCard']>[1]): string {
  return `${update.title}\n${update.body}`;
}

function toHybridCardBody(state: AgentRunState, hasTextOutput: boolean): string {
  const body = toCardBody(state);
  if (!hasTextOutput) {
    return body;
  }
  if (body === '（无输出）') {
    return '文本输出见下方消息。';
  }
  return `文本输出见下方消息。\n\n${body}`;
}

function mergeMessages(messages: readonly IncomingMessage[]): IncomingMessage {
  if (messages.length === 1) {
    return messages[0];
  }
  const latest = messages[messages.length - 1];
  return {
    ...latest,
    text: [
      `用户连续发送了 ${String(messages.length)} 条消息，请作为同一轮请求处理：`,
      '',
      ...messages.map((message, index) => `${String(index + 1)}. ${message.text}`)
    ].join('\n')
  };
}

class ThrottledCardUpdater {
  private timer: NodeJS.Timeout | undefined;
  private pending: Parameters<FeishuApiPort['patchCard']>[1] | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private lastPatchAt = 0;

  constructor(
    private readonly patch: (update: Parameters<FeishuApiPort['patchCard']>[1]) => Promise<void>,
    private readonly minIntervalMs = cardUpdateMinIntervalMs
  ) {}

  request(update: Parameters<FeishuApiPort['patchCard']>[1]): void {
    this.pending = update;
    if (this.timer) {
      return;
    }
    const delay = Math.max(0, this.minIntervalMs - (Date.now() - this.lastPatchAt));
    this.timer = setTimeout(() => {
      void this.flush();
    }, delay);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const update = this.pending;
    if (!update) {
      return;
    }
    this.pending = undefined;
    await this.inFlight;
    this.inFlight = this.patch(update);
    await this.inFlight;
    this.lastPatchAt = Date.now();
  }
}

class ThrottledTextUpdater {
  private timer: NodeJS.Timeout | undefined;
  private pending: string | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private lastPatchAt = 0;

  constructor(
    private readonly patch: (text: string) => Promise<void>,
    private readonly minIntervalMs: number
  ) {}

  request(text: string): void {
    this.pending = text;
    if (this.timer) {
      return;
    }
    const delay = Math.max(0, this.minIntervalMs - (Date.now() - this.lastPatchAt));
    this.timer = setTimeout(() => {
      void this.flush();
    }, delay);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const text = this.pending;
    if (text === undefined) {
      return;
    }
    this.pending = undefined;
    await this.inFlight;
    this.inFlight = this.patch(text);
    await this.inFlight;
    this.lastPatchAt = Date.now();
  }
}
