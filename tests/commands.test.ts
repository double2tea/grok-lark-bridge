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
  it('lists enabled MCP tools and missing scopes', () => {
    const { router, message, session, store } = makeRouter();

    expect(router.handle({ ...message, text: '/mcp tools' }, session).text).toContain(
      'lark_msg_send_image'
    );
    expect(router.handle({ ...message, text: '/mcp scopes' }, session).text).toContain(
      'lark_doc_create'
    );
    store.close();
  });

  it('changes approval policy for admins', () => {
    const { router, message, session, store } = makeRouter();

    const result = router.handle({ ...message, text: '/approval auto' }, session);

    expect(result.text).toBe('Approval policy set to auto');
    expect(result.session?.approvalPolicy).toBe('auto');
    store.close();
  });

  it('allows approval policy changes when admin list is empty', () => {
    const { router, message, session, store } = makeRouter([]);

    const result = router.handle({ ...message, text: '/approval auto' }, session);

    expect(result.text).toBe('Approval policy set to auto');
    store.close();
  });
});

function makeRouter(adminOpenIds: readonly string[] = ['ou_admin']): {
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
    dataDir: dir,
    defaultWorkspaceRoot: dir,
    access: {
      adminOpenIds,
      allowedChatIds: [],
      defaultApprovalPolicy: 'confirm_write',
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
    mentionsBot: false
  };
  const session = sessions.getOrCreateFromMessage(message);
  return {
    router: new CommandRouter(config, store, sessions),
    message,
    session,
    store
  };
}
