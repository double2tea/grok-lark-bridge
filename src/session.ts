import path from 'node:path';
import type {
  AccessConfig,
  ApprovalPolicy,
  IncomingMessage,
  SessionKey,
  SessionRecord
} from './types.js';
import { StateStore } from './storage.js';

export function makeSessionKey(input: SessionKey): string {
  return input.threadId ? `${input.chatId}:${input.threadId}` : input.chatId;
}

export class SessionService {
  constructor(
    private readonly store: StateStore,
    private readonly access: AccessConfig,
    private readonly defaultWorkspaceRoot: string
  ) {}

  getOrCreateFromMessage(message: IncomingMessage): SessionRecord {
    const key = makeSessionKey({ chatId: message.chatId, threadId: message.threadId });
    const existing = this.store.getSession(key);
    if (existing) {
      return existing;
    }
    const policy = this.resolveDefaultPolicy(message.chatId, message.senderOpenId);
    this.store.upsertSession({
      key,
      chatId: message.chatId,
      threadId: message.threadId ?? null,
      grokSessionId: this.store.createGrokSessionId(),
      cwd: this.defaultWorkspaceRoot,
      approvalPolicy: policy,
      runStatus: 'idle',
      activeMessageId: null
    });
    const created = this.store.getSession(key);
    if (!created) {
      throw new Error(`Failed to create session: ${key}`);
    }
    return created;
  }

  getOrCreateByKey(contextKey: string): SessionRecord {
    const existing = this.store.getSession(contextKey);
    if (existing) {
      return existing;
    }
    throw new Error(`Unknown session context: ${contextKey}`);
  }

  isAllowed(message: IncomingMessage): boolean {
    return (
      this.access.allowedChatIds.length === 0 || this.access.allowedChatIds.includes(message.chatId)
    );
  }

  isAdmin(openId: string): boolean {
    return this.access.adminOpenIds.length === 0 || this.access.adminOpenIds.includes(openId);
  }

  changeCwd(session: SessionRecord, cwdInput: string): SessionRecord {
    const cwd = path.resolve(session.cwd, cwdInput);
    this.store.setSessionCwd(session.key, cwd, this.store.createGrokSessionId());
    const updated = this.store.getSession(session.key);
    if (!updated) {
      throw new Error(`Failed to update cwd for session: ${session.key}`);
    }
    return updated;
  }

  setApprovalPolicy(session: SessionRecord, policy: ApprovalPolicy): SessionRecord {
    this.store.setSessionApprovalPolicy(session.key, policy);
    const updated = this.store.getSession(session.key);
    if (!updated) {
      throw new Error(`Failed to update approval policy for session: ${session.key}`);
    }
    return updated;
  }

  reset(session: SessionRecord): SessionRecord {
    this.store.upsertSession({
      key: session.key,
      chatId: session.chatId,
      threadId: session.threadId,
      grokSessionId: this.store.createGrokSessionId(),
      cwd: session.cwd,
      approvalPolicy: session.approvalPolicy,
      runStatus: 'idle',
      activeMessageId: null
    });
    const updated = this.store.getSession(session.key);
    if (!updated) {
      throw new Error(`Failed to reset session: ${session.key}`);
    }
    return updated;
  }

  private resolveDefaultPolicy(chatId: string, openId: string): ApprovalPolicy {
    const chatOverride = this.access.approvalOverrides.find(
      (override) => override.scope === 'chat' && override.id === chatId
    );
    if (chatOverride) {
      return chatOverride.policy;
    }
    const userOverride = this.access.approvalOverrides.find(
      (override) => override.scope === 'user' && override.id === openId
    );
    return userOverride?.policy ?? this.access.defaultApprovalPolicy;
  }
}
