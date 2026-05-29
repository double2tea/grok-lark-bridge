import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength - 3)}...`;
}

export function stripAnsi(input: string): string {
  return input.replace(new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, 'gu'), '');
}

export function sanitizeForCard(input: string): string {
  return stripAnsi(input)
    .replace(new RegExp(String.raw`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`, 'gu'), '')
    .trimEnd();
}

export function describeError(value: unknown): string {
  const base = toError(value).message;
  const response = getChildRecord(value, 'response');
  const data = response ? response.data : undefined;
  if (data === undefined) {
    return base;
  }
  return `${base}; response=${safeStringify(data)}`;
}

function getChildRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
