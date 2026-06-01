import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock } from '../src/instance-lock.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('acquireInstanceLock', () => {
  it('rejects a second live bridge instance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-lock-'));
    dirs.push(dir);
    const lock = acquireInstanceLock(dir);

    expect(() => acquireInstanceLock(dir)).toThrow(/already running/u);
    expect(fs.statSync(lock.path).isDirectory()).toBe(true);

    lock.release();
    const reacquired = acquireInstanceLock(dir);
    expect(() => {
      reacquired.release();
    }).not.toThrow();
  });

  it('replaces a stale lock file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-lock-'));
    dirs.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bridge.lock'),
      `${JSON.stringify({ pid: 2_147_483_647, startedAt: new Date().toISOString() })}\n`
    );

    const lock = acquireInstanceLock(dir);

    expect(fs.readFileSync(path.join(lock.path, 'owner.json'), 'utf8')).toContain(
      `"pid":${String(process.pid)}`
    );
    lock.release();
  });

  it('replaces a stale lock directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-lock-'));
    dirs.push(dir);
    const lockDir = path.join(dir, 'bridge.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
        command: 'node dist/index.js',
        cwd: dir
      })}\n`
    );

    const lock = acquireInstanceLock(dir);

    expect(fs.readFileSync(path.join(lock.path, 'owner.json'), 'utf8')).toContain(
      `"pid":${String(process.pid)}`
    );
    lock.release();
  });

  it('does not remove a lock with unreadable metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-lock-'));
    dirs.push(dir);
    const lockDir = path.join(dir, 'bridge.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    expect(() => acquireInstanceLock(dir)).toThrow(/metadata is unreadable/u);
    expect(fs.existsSync(lockDir)).toBe(true);
  });
});
