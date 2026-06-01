import fs from 'node:fs';
import path from 'node:path';
import { CommandRouter } from './commands.js';
import type { FeishuApiPort, MessageReplyOptions } from './feishu-api.js';
import { FeishuToolExecutor } from './feishu-tools.js';
import { GrokRunAbortedError } from './grok.js';
import type {
  BridgeConfig,
  FeishuCardUpdate,
  GrokBackend,
  GrokEvent,
  IncomingCardAction,
  IncomingMessage,
  SessionRecord,
  TopicSeedRequest
} from './types.js';
import { SessionService } from './session.js';
import { StateStore } from './storage.js';
import { describeError, toError, truncate } from './utils.js';
import {
  type RunState as AgentRunState,
  initialState as initialAgentState,
  reduce as reduceAgentState,
  toCardBody,
  toProcessLog,
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

interface OutputTextState {
  text: string;
}

interface MessageDeliveryTarget {
  readonly chatId: string;
  readonly reply?: MessageReplyOptions;
}

export class RuntimeOrchestrator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly queueVersions = new Map<string, number>();
  private readonly runs = new Map<string, RunState>();
  private readonly pendingBatches = new Map<string, PendingBatch>();
  private readonly diagnostics: string[] = [];
  private readonly commands: CommandRouter;

  constructor(
    private readonly config: BridgeConfig,
    private readonly api: FeishuApiPort,
    private readonly store: StateStore,
    private readonly sessions: SessionService,
    private readonly grok: GrokBackend,
    private readonly tools: FeishuToolExecutor
  ) {
    this.commands = new CommandRouter(this.config, store, sessions, () =>
      this.diagnostics.slice(-20)
    );
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
          rootId: session.rootId ?? undefined,
          threadId: session.threadId ?? undefined,
          attachments: []
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
    const deliveryTarget = toDeliveryTarget(message);
    let command: ReturnType<CommandRouter['handle']>;
    try {
      command = this.commands.handle(message, session);
    } catch (error) {
      await this.sendCardOrNotify(deliveryTarget, {
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
    if (command.topicSeed) {
      try {
        await this.createTopicSeed(message, updatedSession, command.topicSeed);
      } catch (error) {
        await this.sendCardOrNotify(deliveryTarget, {
          title: '新话题创建失败',
          status: 'error',
          body: toError(error).message,
          actions: commandActions(updatedSession.key)
        });
      }
      return true;
    }
    if (message.text.trim() === '/help') {
      await this.sendCardOrNotify(deliveryTarget, buildHelpCard(updatedSession.key));
      return true;
    }
    if (command.text) {
      await this.sendCardOrNotify(deliveryTarget, {
        title: commandTitle(message.text),
        status: command.stopRequested ? 'warning' : 'info',
        body: command.text,
        actions: command.actions ?? commandActions(updatedSession.key)
      });
    }
    return true;
  }

  private async createTopicSeed(
    message: IncomingMessage,
    session: SessionRecord,
    seed: TopicSeedRequest
  ): Promise<void> {
    const cwd = seed.cwdInput ? path.resolve(session.cwd, seed.cwdInput) : session.cwd;
    assertDirectory(cwd, 'Topic workspace');
    const seedText = [
      `新话题：${truncate(seed.title, 120)}`,
      `工作目录：${cwd}`,
      '',
      '请回复这条消息继续；直接在底部输入会回到原会话。'
    ].join('\n');
    const seedMessageId = await this.api.sendText(session.chatId, seedText);
    if (!seedMessageId) {
      throw new Error('Feishu did not return message_id for topic seed');
    }
    const topicSession = this.sessions.createTopicSeedSession({
      chatId: session.chatId,
      rootMessageId: seedMessageId,
      cwd,
      approvalPolicy: session.approvalPolicy
    });
    this.record(
      'info',
      `Topic seed created chat=${message.chatId} seed=${seedMessageId} context=${topicSession.key} cwd=${cwd}`
    );
  }

  private async processMessage(message: IncomingMessage): Promise<void> {
    const session = this.sessions.getOrCreateFromMessage(message);
    const deliveryTarget = toDeliveryTarget(message);
    try {
      assertDirectory(session.cwd, 'Workspace');
    } catch (error) {
      await this.sendCardOrNotify(deliveryTarget, {
        title: '工作目录无效',
        status: 'error',
        body: toError(error).message,
        actions: commandActions(session.key)
      });
      return;
    }
    const previousRun = this.runs.get(session.key);
    const reusePreviousCard = previousRun?.cardMessageId !== undefined;

    let cardMessageId = previousRun?.cardMessageId ?? null;
    let isNewCardForThisRun = cardMessageId === null;
    let cardUnavailable = false;
    if (!cardMessageId) {
      cardMessageId =
        (await this.sendCardOrNotify(deliveryTarget, {
          title: 'Grok 已收到',
          status: 'info',
          body: '正在生成回复。',
          actions: [
            {
              text: '停止',
              type: 'danger',
              value: { action: 'stop_run', context_key: session.key }
            }
          ]
        })) ?? null;
      cardUnavailable = cardMessageId === null;
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

    const timeoutState = { timedOut: false };
    const outputState = { hasOutput: false };
    const deliveredArtifactPaths = new Set<string>();
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
        void this.reportRunUpdate(deliveryTarget, cardMessageId ?? undefined, {
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
      const notice: GrokEvent = {
        type: 'status',
        text: '30 秒内还没有收到助手文本或具名工具事件；继续等待 Grok。'
      };
      agentState = reduceAgentState(agentState, notice);
      const current = this.runs.get(session.key);
      if (current) {
        current.agentState = agentState;
      }
      void ensureRunCard().then(() => {
        const update = {
          title: 'Grok 仍在处理',
          status: 'warning' as const,
          body: toCardBody(agentState),
          actions: runActions(session.key)
        };
        if (liveCard) {
          liveCard.request(update);
          return;
        }
        void this.reportRunUpdate(deliveryTarget, cardMessageId ?? undefined, update);
      });
    }, grokFirstOutputTimeoutMs);

    const outputText: OutputTextState = {
      text: ''
    };
    let liveCard = cardMessageId
      ? new ThrottledCardUpdater((update) => this.safePatchCard(cardMessageId ?? '', update))
      : undefined;

    const ensureRunCard = async (): Promise<void> => {
      if (cardMessageId || cardUnavailable) {
        return;
      }
      const initialCard = {
        title: 'Grok 正在处理',
        status: 'info' as const,
        body: '正在处理需要展示的工具或状态。',
        actions: [
          {
            text: '停止',
            type: 'danger' as const,
            value: { action: 'stop_run', context_key: session.key }
          }
        ]
      };
      cardMessageId = (await this.sendCardOrNotify(deliveryTarget, initialCard)) ?? null;
      cardUnavailable = cardMessageId === null;
      if (cardUnavailable) {
        return;
      }
      isNewCardForThisRun = true;
      this.store.setSessionRun(session.key, 'running', cardMessageId);
      const current = this.runs.get(session.key);
      if (current) {
        current.cardMessageId = cardMessageId;
      }
      if (cardMessageId) {
        liveCard = new ThrottledCardUpdater((update) =>
          this.safePatchCard(cardMessageId ?? '', update)
        );
      }
    };

    const update = async (event: GrokEvent): Promise<void> => {
      armIdleWatchdog();
      if (event.type !== 'status') {
        outputState.hasOutput = true;
        clearTimeout(firstOutputTimer);
      }

      if (event.type === 'text') {
        outputText.text += event.text;
        agentState = reduceAgentState(agentState, event);
        await ensureRunCard();
        liveCard?.request({
          title: isNewCardForThisRun ? 'Grok 正在处理' : 'Grok 继续处理',
          status: 'info',
          body: toCardBody(agentState),
          actions: runActions(session.key)
        });
        return Promise.resolve();
      }

      // Feed event into the structured state machine (big UX upgrade)
      agentState = reduceAgentState(agentState, event);
      await ensureRunCard();

      if (liveCard) {
        const body = toCardBody(agentState);
        liveCard.request({
          title: isNewCardForThisRun ? 'Grok 正在处理' : 'Grok 继续处理',
          status: 'info',
          body,
          actions: runActions(session.key)
        });
      }
      if (event.type === 'tool' && event.artifactUrl && !event.artifactPath) {
        agentState = reduceAgentState(agentState, {
          type: 'status',
          text: `Grok 返回了媒体 URL，但当前只自动发送本地图片或 MP4 文件：${event.artifactUrl}`
        });
        liveCard?.request({
          title: 'Grok 继续处理',
          status: 'warning',
          body: toCardBody(agentState),
          actions: runActions(session.key)
        });
      }
      if (event.type === 'tool' && event.artifactPath) {
        const artifactPath = resolveArtifactPath(session.cwd, event.artifactPath);
        if (deliveredArtifactPaths.has(artifactPath)) {
          return Promise.resolve();
        }
        deliveredArtifactPaths.add(artifactPath);
        if (!fs.existsSync(artifactPath)) {
          agentState = reduceAgentState(agentState, {
            type: 'status',
            text: `Grok 返回了媒体路径，但文件不存在：${artifactPath}`
          });
          liveCard?.request({
            title: 'Grok 继续处理',
            status: 'warning',
            body: toCardBody(agentState),
            actions: runActions(session.key)
          });
          return Promise.resolve();
        }
        const artifactKind = localArtifactKind(artifactPath);
        if (!artifactKind) {
          agentState = reduceAgentState(agentState, {
            type: 'status',
            text: `Grok 返回了暂不支持自动发送的媒体路径：${artifactPath}`
          });
          liveCard?.request({
            title: 'Grok 继续处理',
            status: 'warning',
            body: toCardBody(agentState),
            actions: runActions(session.key)
          });
          return Promise.resolve();
        }
        try {
          if (artifactKind === 'image') {
            await this.api.sendImage(session.chatId, artifactPath, deliveryTarget.reply);
          } else {
            await this.api.sendVideo(session.chatId, artifactPath, undefined, deliveryTarget.reply);
          }
          agentState = reduceAgentState(agentState, {
            type: 'status',
            text: `已发送${artifactKind === 'image' ? '图片' : '视频'}：${path.basename(artifactPath)}`
          });
          liveCard?.request({
            title: 'Grok 继续处理',
            status: 'info',
            body: toCardBody(agentState),
            actions: runActions(session.key)
          });
        } catch (error) {
          agentState = reduceAgentState(agentState, {
            type: 'status',
            text: `媒体发送失败：${toError(error).message}`
          });
          liveCard?.request({
            title: 'Grok 继续处理',
            status: 'warning',
            body: toCardBody(agentState),
            actions: runActions(session.key)
          });
        }
      }
      return Promise.resolve();
    };

    try {
      const prompt = await this.preparePrompt(message);
      const code = await this.grok.run(
        {
          prompt,
          cwd: session.cwd,
          sessionId: session.grokSessionId,
          nativeSessionId: session.nativeSessionId,
          contextKey: session.key,
          requestedByOpenId: message.senderOpenId
        },
        update,
        controller.signal
      );
      await liveCard?.flush();

      // Finalize the structured state
      agentState = finalizeIfRunning(agentState);
      const finalContent = toHybridCardContent(agentState, outputText);

      await this.reportRunUpdate(deliveryTarget, cardMessageId ?? undefined, {
        title: code === 0 ? 'Grok 已回复' : 'Grok 执行失败',
        status: code === 0 ? 'success' : 'error',
        body: finalContent.body,
        processLog: finalContent.processLog
      });
    } catch (error) {
      await liveCard?.flush();
      if (!timeoutState.timedOut) {
        agentState = markInterrupted(agentState);
        if (error instanceof GrokRunAbortedError) {
          await this.reportRunUpdate(deliveryTarget, cardMessageId ?? undefined, {
            title: 'Grok 已停止',
            status: 'warning',
            body: '本轮运行已手动停止。'
          });
        } else {
          await this.reportRunUpdate(deliveryTarget, cardMessageId ?? undefined, {
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

  private async preparePrompt(message: IncomingMessage): Promise<string> {
    if (message.attachments.length === 0) {
      return message.text;
    }
    const targetDir = path.join(this.config.dataDir, 'inbound-media', message.messageId);
    const downloaded: string[] = [];
    for (const attachment of message.attachments) {
      const filePath = await this.api.downloadMessageResource({
        messageId: attachment.messageId,
        fileKey: attachment.fileKey,
        resourceType: attachment.resourceType,
        targetDir,
        fileName: attachment.fileName
      });
      downloaded.push(`${attachment.kind}: ${filePath}`);
    }
    const text = message.text.trim();
    return [
      text || '用户发送了附件。',
      '',
      '用户随消息上传了以下附件，已下载到本地。需要分析图片、视频、音频或文件内容时，直接读取这些本地路径：',
      ...downloaded.map((line) => `- ${line}`)
    ].join('\n');
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
      this.record('info', `Grok message queued silently context=${key}`);
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
          toDeliveryTarget(message),
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
    fallbackTarget?: MessageDeliveryTarget
  ): Promise<void> {
    try {
      await this.api.patchCard(messageId, update);
    } catch (error) {
      this.record('error', `Failed to patch Feishu card ${messageId}: ${describeError(error)}`);
      if (fallbackTarget) {
        await this.notifyText(fallbackTarget, formatCardUpdate(update), 'card patch failure');
      }
    }
  }

  private async sendCardOrNotify(
    target: MessageDeliveryTarget,
    update: Parameters<FeishuApiPort['sendCard']>[1]
  ): Promise<string | undefined> {
    try {
      return await this.api.sendCard(target.chatId, update, target.reply);
    } catch (error) {
      this.record(
        'error',
        `Failed to send Feishu card to ${target.chatId}: ${describeError(error)}`
      );
      await this.notifyText(
        target,
        `Grok 卡片发送失败，改用文本回报。\n${toError(error).message}`,
        'card send failure'
      );
      return undefined;
    }
  }

  private async reportRunUpdate(
    target: MessageDeliveryTarget,
    messageId: string | undefined,
    update: Parameters<FeishuApiPort['patchCard']>[1]
  ): Promise<void> {
    if (messageId) {
      await this.safePatchCard(messageId, update, target);
      return;
    }
    await this.notifyText(target, formatCardUpdate(update), 'run text update');
  }

  private async notifyText(
    target: MessageDeliveryTarget,
    text: string,
    label: string
  ): Promise<void> {
    try {
      await this.api.sendText(target.chatId, text, target.reply);
    } catch (error) {
      this.record(
        'error',
        `Failed to send Feishu text fallback (${label}) to ${target.chatId}: ${describeError(error)}`
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
      '新话题：标题，路径 /path',
      '/topic <title> [路径 <path>]',
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

function runActions(contextKey: string) {
  return [
    {
      text: '停止',
      type: 'danger' as const,
      value: { action: 'stop_run', context_key: contextKey }
    }
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
      if (subcommand === 'list') {
        return '工作目录';
      }
      if (subcommand === 'use') {
        return '工作目录已切换';
      }
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
  return [update.title, update.processLog, update.body].filter(Boolean).join('\n');
}

function toHybridCardContent(
  state: AgentRunState,
  output: OutputTextState
): { readonly body: string; readonly processLog?: string } {
  const body = toCardBody(state);
  const processLog = toProcessLog(state) || undefined;
  if (output.text.length === 0) {
    return { body };
  }
  return { body: output.text, processLog };
}

function resolveArtifactPath(cwd: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.resolve(cwd, artifactPath);
}

function toDeliveryTarget(message: IncomingMessage): MessageDeliveryTarget {
  const replyToMessageId =
    message.rootId ?? message.parentId ?? message.replyToMessageId ?? message.threadId;
  if (!replyToMessageId) {
    return { chatId: message.chatId };
  }
  return {
    chatId: message.chatId,
    reply: {
      replyToMessageId,
      replyInThread: true
    }
  };
}

function assertDirectory(cwd: string, label: string): void {
  if (!fs.existsSync(cwd)) {
    throw new Error(`${label} does not exist: ${cwd}`);
  }
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error(`${label} is not a directory: ${cwd}`);
  }
}

function localArtifactKind(filePath: string): 'image' | 'video' | undefined {
  if (/\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(filePath)) {
    return 'image';
  }
  if (/\.mp4$/iu.test(filePath)) {
    return 'video';
  }
  return undefined;
}

function mergeMessages(messages: readonly IncomingMessage[]): IncomingMessage {
  if (messages.length === 1) {
    return messages[0];
  }
  const latest = messages[messages.length - 1];
  return {
    ...latest,
    attachments: messages.flatMap((message) => message.attachments),
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
