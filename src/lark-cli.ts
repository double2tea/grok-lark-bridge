import { spawnSync } from 'node:child_process';
import { stripAnsi } from './utils.js';

export interface LarkCliStatus {
  readonly available: boolean;
  readonly version: string;
  readonly auth: string;
}

export function checkLarkCli(larkCliBin: string): LarkCliStatus {
  const version = runLarkCli(larkCliBin, ['--version'], 2000);
  if (!version.ok) {
    return {
      available: false,
      version: version.detail,
      auth: 'not checked'
    };
  }

  const auth = runLarkCli(larkCliBin, ['auth', 'status'], 5000);
  return {
    available: auth.ok,
    version: version.detail,
    auth: summarizeAuthStatus(auth.detail)
  };
}

function runLarkCli(
  larkCliBin: string,
  args: readonly string[],
  timeoutMs: number
): { readonly ok: boolean; readonly detail: string } {
  const result = spawnSync(larkCliBin, args, {
    encoding: 'utf8',
    timeout: timeoutMs
  });
  if (result.error) {
    return { ok: false, detail: result.error.message };
  }
  const output = stripAnsi([result.stdout, result.stderr].filter(Boolean).join('\n')).trim();
  if (result.status !== 0) {
    return { ok: false, detail: output || `exit ${String(result.status)}` };
  }
  return { ok: true, detail: output };
}

function summarizeAuthStatus(output: string): string {
  const parsed = parseJson(output);
  if (!isRecord(parsed)) {
    return output;
  }

  const identity = readString(parsed, 'identity') ?? 'unknown';
  const identities = parsed.identities;
  if (!isRecord(identities)) {
    return `identity=${identity}`;
  }

  const bot = readIdentityStatus(identities.bot);
  const user = readIdentityStatus(identities.user);
  return [`identity=${identity}`, bot ? `bot=${bot}` : undefined, user ? `user=${user}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(', ');
}

function readIdentityStatus(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = readString(value, 'status') ?? 'unknown';
  const userName = readString(value, 'userName');
  const tokenStatus = readString(value, 'tokenStatus');
  return [userName, status, tokenStatus && tokenStatus !== status ? tokenStatus : undefined]
    .filter((part): part is string => part !== undefined)
    .join('/');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
