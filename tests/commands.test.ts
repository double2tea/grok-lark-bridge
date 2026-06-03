import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandRouter } from '../src/commands.js';
import { SessionService } from '../src/session.js';
import { StateStore } from '../src/storage.js';
import type { BridgeConfig, IncomingMessage, SessionRecord } from '../src/types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CommandRouter', () => {
  it('reports zero bridge-local MCP tools', () => {
    const { router, message, session, store } = makeRouter();

    expect(router.handle({ ...message, text: '/mcp tools' }, session).text).toBe(
      'No MCP tools enabled.'
    );
    expect(router.handle({ ...message, text: '/mcp scopes' }, session).text).toBe(
      'No missing configured scopes.'
    );
    store.close();
  });

  it('reports lark-cli status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-lark-cli-'));
    dirs.push(dir);
    const fakeLarkCli = path.join(dir, 'lark-cli.mjs');
    fs.writeFileSync(fakeLarkCli, fakeLarkCliScript(), 'utf8');
    fs.chmodSync(fakeLarkCli, 0o755);
    const { router, message, session, store } = makeRouter(['ou_admin'], fakeLarkCli);

    const result = router.handle({ ...message, text: '/lark status' }, session);

    expect(result.text).toContain('lark-cli: available');
    expect(result.text).toContain('version: lark-cli version test');
    expect(result.text).toContain('auth: identity=user');
    store.close();
  });

  it('changes approval policy for admins', () => {
    const { router, message, session, store } = makeRouter();

    const result = router.handle({ ...message, text: '/approval auto' }, session);

    expect(result.text).toBe('Approval policy set to auto');
    expect(result.session?.approvalPolicy).toBe('auto');
    store.close();
  });

  it('rejects approval policy changes when admin list is empty', () => {
    const { router, message, session, store } = makeRouter([]);

    expect(() => router.handle({ ...message, text: '/approval auto' }, session)).toThrow(
      'Only admins can change approval policy.'
    );
    store.close();
  });

  it('parses natural topic seed requests with cwd', () => {
    const { router, message, session, store } = makeRouter();

    const result = router.handle(
      { ...message, text: '新话题：重构 storage，路径 /tmp/project' },
      session
    );

    expect(result.topicSeed).toEqual({ title: '重构 storage', cwdInput: '/tmp/project' });
    store.close();
  });

  it('parses slash topic seed requests', () => {
    const { router, message, session, store } = makeRouter();

    const result = router.handle({ ...message, text: '/topic 测试新任务 cwd ./work' }, session);

    expect(result.topicSeed).toEqual({ title: '测试新任务', cwdInput: './work' });
    store.close();
  });

  it('keeps path marker words in the title without an explicit cwd value', () => {
    const { router, message, session, store } = makeRouter();

    expect(router.handle({ ...message, text: '新话题：路径规划' }, session).topicSeed).toEqual({
      title: '路径规划'
    });
    expect(router.handle({ ...message, text: '新话题：项目路径梳理' }, session).topicSeed).toEqual({
      title: '项目路径梳理'
    });
    store.close();
  });

  it('parses natural topic seed requests with broader Chinese prefixes (新建一个话题 etc)', () => {
    const { router, message, session, store } = makeRouter();

    // User's exact message style from Feishu
    expect(
      router.handle({ ...message, text: '新建一个话题，飞书相关的' }, session).topicSeed
    ).toEqual({ title: '飞书相关的' });

    expect(
      router.handle({ ...message, text: '新建一个话题：飞书 OpenAPI 与 MCP' }, session).topicSeed
    ).toEqual({ title: '飞书 OpenAPI 与 MCP' });

    expect(router.handle({ ...message, text: '新建话题 集成测试' }, session).topicSeed).toEqual({
      title: '集成测试'
    });

    expect(
      router.handle({ ...message, text: '创建新话题：重构 bridge 飞书部分' }, session).topicSeed
    ).toEqual({ title: '重构 bridge 飞书部分' });

    // with path using Chinese comma separator
    expect(
      router.handle({ ...message, text: '新建一个话题，飞书相关，路径 /tmp/feishu-topic' }, session)
        .topicSeed
    ).toEqual({ title: '飞书相关', cwdInput: '/tmp/feishu-topic' });

    // leading punct after prefix should be stripped
    expect(
      router.handle({ ...message, text: '新话题，，飞书话题清理' }, session).topicSeed
    ).toEqual({ title: '飞书话题清理' });

    store.close();
  });

  it('adds quick switch actions to saved workspace listings', () => {
    const { router, message, session, store } = makeRouter();
    store.saveWorkspace('main', session.cwd);
    store.saveWorkspace('tmp', '/tmp');

    const result = router.handle({ ...message, text: '/workspace list' }, session);

    expect(result.text).toContain('**当前工作目录**');
    expect(result.text).toContain(`\`${session.cwd}\``);
    expect(result.text).toContain('**main**（当前）');
    expect(result.text).toContain('**tmp**');
    expect(result.actions).toContainEqual({
      text: '切换 tmp',
      type: 'primary',
      value: {
        action: 'run_command',
        command: '/workspace use tmp',
        context_key: session.key
      }
    });
    expect(result.actions?.some((action) => action.text === '切换 main')).toBe(false);
    store.close();
  });

  it('limits workspace switch actions in the listing card', () => {
    const { router, message, session, store } = makeRouter();
    for (let index = 0; index < 8; index += 1) {
      store.saveWorkspace(`w${String(index)}`, `/tmp/w${String(index)}`);
    }

    const result = router.handle({ ...message, text: '/workspace list' }, session);

    expect(result.actions).toHaveLength(6);
    expect(result.text).toContain('仅显示前 6 个切换按钮。');
    store.close();
  });

  it('uses workspace-specific actions after workspace mutations', () => {
    const { router, message, session, store } = makeRouter();
    store.saveWorkspace('tmp', '/tmp');

    const result = router.handle({ ...message, text: '/workspace use tmp' }, session);

    expect(result.actions).toEqual([
      {
        text: '工作目录列表',
        type: 'default',
        value: {
          action: 'run_command',
          command: '/workspace list',
          context_key: session.key
        }
      }
    ]);
    store.close();
  });
});

function makeRouter(
  adminOpenIds: readonly string[] = ['ou_admin'],
  larkCliBin = process.execPath
): {
  readonly router: CommandRouter;
  readonly message: IncomingMessage;
  readonly session: SessionRecord;
  readonly store: StateStore;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lark-bridge-'));
  dirs.push(dir);
  const store = new StateStore(dir);
  const config: BridgeConfig = {
    feishuAppId: 'cli_x',
    feishuAppSecret: 'secret',
    grokBin: 'grok',
    larkCliBin,
    dataDir: dir,
    defaultWorkspaceRoot: dir,
    access: {
      adminOpenIds,
      allowedChatIds: ['chat_1'],
      defaultApprovalPolicy: 'auto',
      approvalOverrides: [],
      enableAdvancedOpenApiTool: false
    },
    permissionScopes: {
      scopes: { tenant: ['im:message:send_as_bot'] }
    }
  };
  const sessions = new SessionService(store, config.access, dir);
  const message: IncomingMessage = {
    eventId: 'evt_1',
    chatId: 'chat_1',
    messageId: 'msg_1',
    senderOpenId: 'ou_admin',
    chatType: 'p2p',
    text: '/help',
    mentionsBot: false,
    attachments: []
  };
  const session = sessions.getOrCreateFromMessage(message);
  return {
    router: new CommandRouter(config, store, sessions),
    message,
    session,
    store
  };
}

function fakeLarkCliScript(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'lark-cli version test\\n'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '{"identity":"user"}\\n'
  exit 0
fi
printf 'unexpected args: %s\\n' "$*" >&2
exit 1
`;
}
