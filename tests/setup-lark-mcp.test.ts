import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCombinedMcpConfig,
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
      '-s',
      'secret_test',
      '--oauth',
      '--token-mode',
      'user_access_token'
    ]);
  });

  it('builds a combined bridge and official MCP config', () => {
    expect(buildCombinedMcpConfig('/repo', config)).toEqual({
      mcpServers: {
        'grok-lark-bridge': {
          command: 'node',
          args: [path.join('/repo', 'dist', 'mcp-server.js')]
        },
        'lark-mcp': {
          command: 'npx',
          args: buildLarkMcpServerArgs(config)
        }
      }
    });
  });

  it('writes generated config under the bridge data directory', () => {
    expect(generatedMcpConfigPath('/data')).toBe(path.join('/data', 'grok-mcp.config.json'));
  });
});
