import { z } from 'zod';
import { checkGrok, runDoctor } from './health.js';
import { missingToolScopes, enabledTools } from './permissions.js';
import { SessionService } from './session.js';
import { StateStore } from './storage.js';
import type { BridgeConfig, IncomingMessage, SessionRecord } from './types.js';

export interface CommandResult {
  readonly handled: boolean;
  readonly text?: string;
  readonly session?: SessionRecord;
  readonly stopRequested?: boolean;
}

export class CommandRouter {
  constructor(
    private readonly config: BridgeConfig,
    private readonly store: StateStore,
    private readonly sessions: SessionService,
    private readonly recentDiagnostics: () => readonly string[] = () => []
  ) {}

  handle(message: IncomingMessage, session: SessionRecord): CommandResult {
    if (!message.text.startsWith('/')) {
      return { handled: false };
    }

    const [command, ...args] = message.text.trim().split(/\s+/u);
    switch (command) {
      case '/help':
        return {
          handled: true,
          text: [
            'Grok Lark Bridge',
            '',
            '/status',
            '/new',
            '/stop',
            '/cd <path>',
            '/workspace list|save|use|remove',
            '/approval confirm_write|confirm_all|auto',
            '/mcp tools',
            '/mcp scopes',
            '/doctor'
          ].join('\n')
        };
      case '/status':
        return {
          handled: true,
          text: [
            `cwd: ${session.cwd}`,
            `grok session: ${session.grokSessionId}`,
            `run: ${session.runStatus}`,
            `approval: ${session.approvalPolicy}`,
            `sender open_id: ${message.senderOpenId}`,
            `grok: ${checkGrok(this.config.grokBin)}`
          ].join('\n')
        };
      case '/new':
      case '/reset':
        return {
          handled: true,
          text: 'New Grok session created.',
          session: this.sessions.reset(session)
        };
      case '/stop':
        return { handled: true, text: 'Stopping current run.', stopRequested: true };
      case '/cd':
        return this.handleCd(session, args);
      case '/workspace':
        return this.handleWorkspace(session, args);
      case '/approval':
        return this.handleApproval(message, session, args);
      case '/mcp':
        return this.handleMcp(args);
      case '/doctor':
        return {
          handled: true,
          text: formatDoctorOutput(this.recentDiagnostics())
        };
      default:
        return { handled: false };
    }
  }

  private handleCd(session: SessionRecord, args: readonly string[]): CommandResult {
    const target = args.join(' ');
    if (!target) {
      throw new Error('/cd requires a path');
    }
    const updated = this.sessions.changeCwd(session, target);
    return { handled: true, text: `cwd switched to ${updated.cwd}`, session: updated };
  }

  private handleWorkspace(session: SessionRecord, args: readonly string[]): CommandResult {
    const [action, name] = args;
    switch (action) {
      case 'list': {
        const rows = this.store.listWorkspaces();
        return {
          handled: true,
          text:
            rows.length === 0
              ? 'No workspaces saved.'
              : rows.map((row) => `${row.name}: ${row.cwd}`).join('\n')
        };
      }
      case 'save': {
        if (!name) {
          throw new Error('/workspace save requires a name');
        }
        this.store.saveWorkspace(name, session.cwd);
        return { handled: true, text: `Workspace saved: ${name}` };
      }
      case 'use': {
        if (!name) {
          throw new Error('/workspace use requires a name');
        }
        const cwd = this.store.getWorkspace(name);
        if (!cwd) {
          throw new Error(`Unknown workspace: ${name}`);
        }
        const updated = this.sessions.changeCwd(session, cwd);
        return { handled: true, text: `Workspace selected: ${name}`, session: updated };
      }
      case 'remove': {
        if (!name) {
          throw new Error('/workspace remove requires a name');
        }
        const removed = this.store.removeWorkspace(name);
        return {
          handled: true,
          text: removed ? `Workspace removed: ${name}` : `Unknown workspace: ${name}`
        };
      }
      default:
        throw new Error('/workspace requires list|save|use|remove');
    }
  }

  private handleApproval(
    message: IncomingMessage,
    session: SessionRecord,
    args: readonly string[]
  ): CommandResult {
    if (!this.sessions.isAdmin(message.senderOpenId)) {
      throw new Error('Only admins can change approval policy.');
    }
    const policy = z.enum(['confirm_write', 'confirm_all', 'auto']).parse(args[0]);
    const updated = this.sessions.setApprovalPolicy(session, policy);
    return { handled: true, text: `Approval policy set to ${policy}`, session: updated };
  }

  private handleMcp(args: readonly string[]): CommandResult {
    const [action] = args;
    if (action === 'tools') {
      const tools = enabledTools(
        this.config.permissionScopes,
        this.config.access.enableAdvancedOpenApiTool
      ).map((tool) => `${tool.name} (${tool.risk})`);
      return {
        handled: true,
        text: tools.length === 0 ? 'No MCP tools enabled.' : tools.join('\n')
      };
    }
    if (action === 'scopes') {
      const missing = missingToolScopes(this.config.permissionScopes);
      return {
        handled: true,
        text: missing.length === 0 ? 'No missing configured scopes.' : missing.join('\n')
      };
    }
    throw new Error('/mcp requires tools|scopes');
  }
}

function formatDoctorCheck(check: ReturnType<typeof runDoctor>[number]): string {
  return `[${check.ok ? 'ok' : 'fail'}] ${check.name}: ${check.detail}`;
}

function formatDoctorOutput(recentDiagnostics: readonly string[]): string {
  const checks = runDoctor().map(formatDoctorCheck);
  if (recentDiagnostics.length === 0) {
    return checks.join('\n');
  }
  return [...checks, '', 'Recent bridge events:', ...recentDiagnostics].join('\n');
}
