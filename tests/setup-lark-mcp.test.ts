import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCombinedMcpConfig,
  buildGrokMcpAddArgs,
  buildLarkMcpLoginArgs,
  buildLarkMcpServerArgs,
  generatedMcpConfigPath
} from '../src/setup-lark-mcp.js';

const config = {
  feishuAppId: 'cli_test',
  feishuAppSecret: 'secret_test'
};

describe('setup-lark-mcp', () => {
  it('builds official lark-mcp login args from bridge credentials', () => {
    expect(buildLarkMcpLoginArgs(config)).toEqual([
      '-y',
      '@larksuiteoapi/lark-mcp',
      'login',
      '-a',
      'cli_test',
      '-s',
      'secret_test'
    ]);
  });

  it('forces official lark-mcp server to use user OAuth tokens', () => {
    expect(buildLarkMcpServerArgs(config)).toEqual([
      '-y',
      '@larksuiteoapi/lark-mcp',
      'mcp',
      '-a',
      'cli_test',
      '--oauth',
      '--token-mode',
      'user_access_token'
    ]);
  });

  it('builds Grok CLI args that register official lark-mcp', () => {
    expect(buildGrokMcpAddArgs(config)).toEqual([
      'mcp',
      'add',
      'lark-mcp',
      '--command',
      'npx',
      '--args=-y',
      '--args=@larksuiteoapi/lark-mcp',
      '--args=mcp',
      '--args=-a',
      '--args=cli_test',
      '--args=--oauth',
      '--args=--token-mode',
      '--args=user_access_token'
    ]);
    expect(buildGrokMcpAddArgs(config).join(' ')).not.toContain('secret_test');
  });

  it('builds an official-only MCP config', () => {
    expect(buildCombinedMcpConfig('/repo', config)).toEqual({
      mcpServers: {
        'lark-mcp': {
          command: 'npx',
          args: buildLarkMcpServerArgs(config),
          env: {
            FEISHU_APP_ID: 'cli_test',
            FEISHU_APP_SECRET: '${FEISHU_APP_SECRET}'
          }
        }
      }
    });
    expect(JSON.stringify(buildCombinedMcpConfig('/repo', config))).not.toContain('secret_test');
  });

  it('writes generated config under the bridge data directory', () => {
    expect(generatedMcpConfigPath('/data')).toBe(path.join('/data', 'grok-mcp.config.json'));
  });
});
