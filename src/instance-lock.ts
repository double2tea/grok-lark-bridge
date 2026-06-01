import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface InstanceLock {
  readonly path: string;
  release(): void;
}

interface LockFile {
  readonly pid: number;
  readonly startedAt: string;
  readonly command?: string;
  readonly cwd?: string;
}

export function acquireInstanceLock(dataDir: string): InstanceLock {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, 'bridge.lock');
  const lock = tryCreateLock(lockPath);
  if (lock) {
    return lock;
  }

  const existing = readLockFile(lockPath);
  if (!existing) {
    throw new Error(`Grok Lark Bridge lock exists but metadata is unreadable: ${lockPath}`);
  }
  if (isBridgeProcessAlive(existing)) {
    throw new Error(`Grok Lark Bridge is already running (pid ${String(existing.pid)}).`);
  }

  fs.rmSync(lockPath, { recursive: true, force: true });
  const retry = tryCreateLock(lockPath);
  if (!retry) {
    throw new Error('Failed to acquire Grok Lark Bridge instance lock.');
  }
  return retry;
}

function tryCreateLock(lockPath: string): InstanceLock | undefined {
  try {
    fs.mkdirSync(lockPath);
    const payload: LockFile = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: process.argv.join(' '),
      cwd: process.cwd()
    };
    fs.writeFileSync(ownerPath(lockPath), `${JSON.stringify(payload)}\n`, 'utf8');
    return {
      path: lockPath,
      release: () => {
        const current = readLockFile(lockPath);
        if (current?.pid === process.pid) {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      }
    };
  } catch (error) {
    if (isFileExistsError(error)) {
      return undefined;
    }
    throw error;
  }
}

function readLockFile(lockPath: string): LockFile | undefined {
  try {
    const stats = fs.statSync(lockPath);
    const filePath = stats.isDirectory() ? ownerPath(lockPath) : lockPath;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!isLockFile(value)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function isBridgeProcessAlive(lock: LockFile): boolean {
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
  if (lock.pid === process.pid) {
    return true;
  }
  const command = readProcessCommand(lock.pid);
  if (command === undefined) {
    return true;
  }
  if (!lock.command) {
    return true;
  }
  return (
    command === lock.command || command.includes(lock.command) || lock.command.includes(command)
  );
}

function isLockFile(value: unknown): value is LockFile {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === 'number' &&
    typeof record.startedAt === 'string' &&
    (record.command === undefined || typeof record.command === 'string') &&
    (record.cwd === undefined || typeof record.cwd === 'string')
  );
}

function isFileExistsError(error: unknown): boolean {
  return isErrno(error, 'EEXIST');
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function ownerPath(lockPath: string): string {
  return path.join(lockPath, 'owner.json');
}

function readProcessCommand(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8'
    }).trim();
  } catch {
    return undefined;
  }
}
