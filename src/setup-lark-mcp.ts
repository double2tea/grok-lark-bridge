#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import type { BridgeConfig } from './types.js';

const larkMcpPackage = '@larksuiteoapi/lark-mcp';
const generatedMcpConfigFile = 'grok-mcp.config.json';

export function buildLarkMcpLoginArgs(
  config: Pick<BridgeConfig, 'feishuAppId' | 'feishuAppSecret'>
): readonly string[] {
  return ['-y', larkMcpPackage, 'login', '-a', config.feishuAppId, '-s', config.feishuAppSecret];
}

export function buildLarkMcpServerArgs(
  config: Pick<BridgeConfig, 'feishuAppId'>
): readonly string[] {
  return [
    '-y',
    larkMcpPackage,
    'mcp',
    '-a',
    config.feishuAppId,
    '--oauth',
    '--token-mode',
    'user_access_token'
  ];
}

export function buildGrokMcpAddArgs(
  config: Pick<BridgeConfig, 'feishuAppId' | 'feishuAppSecret'>
): readonly string[] {
  return [
    'mcp',
    'add',
    'lark-mcp',
    '--command',
    'npx',
    ...buildLarkMcpServerArgs(config).map((arg) => `--args=${arg}`)
  ];
}

export function buildCombinedMcpConfig(
  projectRoot: string,
  config: Pick<BridgeConfig, 'feishuAppId' | 'feishuAppSecret'>
): Record<string, unknown> {
  void projectRoot;
  return {
    mcpServers: {
      'lark-mcp': {
        command: 'npx',
        args: buildLarkMcpServerArgs(config),
        env: {
          FEISHU_APP_ID: config.feishuAppId,
          FEISHU_APP_SECRET: '${FEISHU_APP_SECRET}'
        }
      }
    }
  };
}

export function generatedMcpConfigPath(dataDir: string): string {
  return path.join(dataDir, generatedMcpConfigFile);
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const configOnly = args.has('--config-only');
  const projectRoot = process.env.GROK_LARK_BRIDGE_PROJECT_ROOT ?? process.cwd();
  const config = loadConfig(projectRoot);
  const outputPath = generatedMcpConfigPath(config.dataDir);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(buildCombinedMcpConfig(projectRoot, config), null, 2)}\n`,
    { mode: 0o600 }
  );

  process.stdout.write(`Generated Grok MCP config: ${outputPath}\n`);
  process.stdout.write(
    [
      'Registering the official Lark MCP server in Grok config.',
      'The official lark-mcp server is configured with --oauth and --token-mode user_access_token.',
      'Grok Lark Bridge no longer exposes a bridge-local MCP server.',
      ''
    ].join('\n')
  );

  if (configOnly) {
    process.stdout.write(
      'Skipped Grok MCP registration and official lark-mcp login because --config-only was provided.\n'
    );
    return;
  }

  const addResult = spawnSync(config.grokBin, buildGrokMcpAddArgs(config), { stdio: 'inherit' });
  if (addResult.error) {
    throw addResult.error;
  }
  if (addResult.status !== 0) {
    process.exitCode = addResult.status ?? 1;
    return;
  }

  process.stdout.write('Starting official lark-mcp user OAuth login...\n');
  const result = spawnSync('npx', buildLarkMcpLoginArgs(config), { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  process.stdout.write('Official lark-mcp login finished.\n');
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return import.meta.url === pathToFileURL(entryPath).href;
}

if (isMainModule()) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Official lark-mcp setup failed: ${message}\n`);
    process.exitCode = 1;
  }
}
