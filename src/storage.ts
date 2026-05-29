import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  ApprovalPolicy,
  ApprovalStatus,
  PendingApproval,
  RunStatus,
  SessionRecord
} from './types.js';
import { randomId } from './utils.js';

interface SessionRow {
  readonly key: string;
  readonly chat_id: string;
  readonly thread_id: string | null;
  readonly grok_session_id: string;
  readonly cwd: string;
  readonly approval_policy: ApprovalPolicy;
  readonly run_status: RunStatus;
  readonly active_message_id: string | null;
}

interface PendingApprovalRow {
  readonly id: string;
  readonly context_key: string;
  readonly tool_name: string;
  readonly risk: 'read' | 'write';
  readonly target: string;
  readonly args_json: string;
  readonly requested_by_open_id: string;
  readonly created_at: number;
  readonly status: ApprovalStatus;
  readonly result_text: string | null;
  readonly resolved_at: number | null;
}

interface WorkspaceRow {
  readonly name: string;
  readonly cwd: string;
}

export class StateStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'grok-lark-bridge.sqlite3'));
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  hasProcessedEvent(eventId: string): boolean {
    const row = this.db
      .prepare('select event_id from processed_events where event_id = ?')
      .get(eventId) as { readonly event_id: string } | undefined;
    return row !== undefined;
  }

  markProcessedEvent(eventId: string): void {
    this.db
      .prepare('insert or ignore into processed_events(event_id, created_at) values (?, ?)')
      .run(eventId, Date.now());
  }

  pruneProcessedEvents(olderThanMs: number): void {
    this.db
      .prepare('delete from processed_events where created_at < ?')
      .run(Date.now() - olderThanMs);
  }

  getSession(key: string): SessionRecord | undefined {
    const row = this.db.prepare('select * from sessions where key = ?').get(key) as
      | SessionRow
      | undefined;
    return row ? mapSession(row) : undefined;
  }

  upsertSession(input: {
    readonly key: string;
    readonly chatId: string;
    readonly threadId: string | null;
    readonly grokSessionId: string;
    readonly cwd: string;
    readonly approvalPolicy: ApprovalPolicy;
    readonly runStatus: RunStatus;
    readonly activeMessageId: string | null;
  }): void {
    this.db
      .prepare(
        `insert into sessions(
          key, chat_id, thread_id, grok_session_id, cwd, approval_policy, run_status, active_message_id, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(key) do update set
          grok_session_id = excluded.grok_session_id,
          cwd = excluded.cwd,
          approval_policy = excluded.approval_policy,
          run_status = excluded.run_status,
          active_message_id = excluded.active_message_id,
          updated_at = excluded.updated_at`
      )
      .run(
        input.key,
        input.chatId,
        input.threadId,
        input.grokSessionId,
        input.cwd,
        input.approvalPolicy,
        input.runStatus,
        input.activeMessageId,
        Date.now()
      );
  }

  setSessionRun(key: string, runStatus: RunStatus, activeMessageId: string | null): void {
    this.db
      .prepare(
        'update sessions set run_status = ?, active_message_id = ?, updated_at = ? where key = ?'
      )
      .run(runStatus, activeMessageId, Date.now(), key);
  }

  setSessionCwd(key: string, cwd: string, grokSessionId: string): void {
    this.db
      .prepare(
        'update sessions set cwd = ?, grok_session_id = ?, run_status = ?, active_message_id = null, updated_at = ? where key = ?'
      )
      .run(cwd, grokSessionId, 'idle', Date.now(), key);
  }

  setSessionApprovalPolicy(key: string, approvalPolicy: ApprovalPolicy): void {
    this.db
      .prepare('update sessions set approval_policy = ?, updated_at = ? where key = ?')
      .run(approvalPolicy, Date.now(), key);
  }

  createGrokSessionId(): string {
    return randomId('grok_lark');
  }

  saveWorkspace(name: string, cwd: string): void {
    this.db
      .prepare(
        'insert into workspaces(name, cwd, updated_at) values (?, ?, ?) on conflict(name) do update set cwd = excluded.cwd, updated_at = excluded.updated_at'
      )
      .run(name, cwd, Date.now());
  }

  removeWorkspace(name: string): boolean {
    const result = this.db.prepare('delete from workspaces where name = ?').run(name);
    return result.changes > 0;
  }

  listWorkspaces(): readonly WorkspaceRow[] {
    return this.db
      .prepare('select name, cwd from workspaces order by name asc')
      .all() as WorkspaceRow[];
  }

  getWorkspace(name: string): string | undefined {
    const row = this.db.prepare('select cwd from workspaces where name = ?').get(name) as
      | { readonly cwd: string }
      | undefined;
    return row?.cwd;
  }

  createPendingApproval(
    input: Omit<PendingApproval, 'id' | 'createdAt' | 'status' | 'resultText' | 'resolvedAt'>
  ): PendingApproval {
    const approval: PendingApproval = {
      ...input,
      id: randomId('approval'),
      createdAt: Date.now(),
      status: 'pending',
      resultText: null,
      resolvedAt: null
    };
    this.db
      .prepare(
        `insert into pending_approvals(
          id, context_key, tool_name, risk, target, args_json, requested_by_open_id, created_at, status
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        approval.id,
        approval.contextKey,
        approval.toolName,
        approval.risk,
        approval.target,
        approval.argsJson,
        approval.requestedByOpenId,
        approval.createdAt,
        approval.status
      );
    return approval;
  }

  getPendingApproval(id: string): PendingApproval | undefined {
    const row = this.db.prepare('select * from pending_approvals where id = ?').get(id) as
      | PendingApprovalRow
      | undefined;
    return row ? mapPendingApproval(row) : undefined;
  }

  resolvePendingApproval(id: string, status: ApprovalStatus, resultText: string): void {
    this.db
      .prepare(
        'update pending_approvals set status = ?, result_text = ?, resolved_at = ? where id = ?'
      )
      .run(status, resultText, Date.now(), id);
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists processed_events (
        event_id text primary key,
        created_at integer not null
      );

      create table if not exists sessions (
        key text primary key,
        chat_id text not null,
        thread_id text,
        grok_session_id text not null,
        cwd text not null,
        approval_policy text not null,
        run_status text not null,
        active_message_id text,
        updated_at integer not null
      );

      create table if not exists workspaces (
        name text primary key,
        cwd text not null,
        updated_at integer not null
      );

      create table if not exists pending_approvals (
        id text primary key,
        context_key text not null,
        tool_name text not null,
        risk text not null,
        target text not null,
        args_json text not null,
        requested_by_open_id text not null,
        created_at integer not null,
        status text not null default 'pending',
        result_text text,
        resolved_at integer
      );
    `);
    this.addColumnIfMissing('pending_approvals', 'status', "text not null default 'pending'");
    this.addColumnIfMissing('pending_approvals', 'result_text', 'text');
    this.addColumnIfMissing('pending_approvals', 'resolved_at', 'integer');
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`pragma table_info(${table})`).all() as readonly {
      readonly name: string;
    }[];
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${definition}`);
    }
  }
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    key: row.key,
    chatId: row.chat_id,
    threadId: row.thread_id,
    grokSessionId: row.grok_session_id,
    cwd: row.cwd,
    approvalPolicy: row.approval_policy,
    runStatus: row.run_status,
    activeMessageId: row.active_message_id
  };
}

function mapPendingApproval(row: PendingApprovalRow): PendingApproval {
  return {
    id: row.id,
    contextKey: row.context_key,
    toolName: row.tool_name,
    risk: row.risk,
    target: row.target,
    argsJson: row.args_json,
    requestedByOpenId: row.requested_by_open_id,
    createdAt: row.created_at,
    status: row.status,
    resultText: row.result_text,
    resolvedAt: row.resolved_at
  };
}
