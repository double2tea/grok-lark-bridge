import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import {
  approvalPolicies,
  type AccessConfig,
  type BridgeConfig,
  type LocalConfig,
  type PermissionConfig
} from './types.js';
import { expandHome } from './utils.js';

const accessConfigSchema = z.object({
  adminOpenIds: z.array(z.string()).default([]),
  allowedChatIds: z.array(z.string()).default([]),
  defaultApprovalPolicy: z.enum(approvalPolicies).default('confirm_write'),
  approvalOverrides: z
    .array(
      z.object({
        scope: z.enum(['chat', 'user']),
        id: z.string(),
        policy: z.enum(approvalPolicies)
      })
    )
    .default([]),
  enableAdvancedOpenApiTool: z.boolean().default(false)
});

const permissionConfigSchema = z.object({
  scopes: z.object({
    tenant: z.array(z.string()).default([])
  })
});

const localConfigSchema = z.object({
  feishuAppId: z.string().optional(),
  feishuAppSecret: z.string().optional(),
  feishuEncryptKey: z.string().optional(),
  feishuVerificationToken: z.string().optional(),
  grokBin: z.string().optional(),
  dataDir: z.string().optional(),
  defaultWorkspaceRoot: z.string().optional()
});

export function loadConfig(projectRoot = process.cwd()): BridgeConfig {
  dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });
  const local = loadLocalConfig();

  const feishuAppId = readRequiredSetting('FEISHU_APP_ID', local.feishuAppId);
  const feishuAppSecret = readRequiredSetting('FEISHU_APP_SECRET', local.feishuAppSecret);
  const feishuEncryptKey = readOptionalSetting('FEISHU_ENCRYPT_KEY', local.feishuEncryptKey);
  const feishuVerificationToken = readOptionalSetting(
    'FEISHU_VERIFICATION_TOKEN',
    local.feishuVerificationToken
  );
  const grokBin = readOptionalSetting('GROK_BIN', local.grokBin) ?? 'grok';
  const dataDir = expandHome(readOptionalSetting('DATA_DIR', local.dataDir) ?? defaultDataDir());
  const defaultWorkspaceRoot = expandHome(
    readOptionalSetting('DEFAULT_WORKSPACE_ROOT', local.defaultWorkspaceRoot) ?? projectRoot
  );

  return {
    feishuAppId,
    feishuAppSecret,
    feishuEncryptKey,
    feishuVerificationToken,
    grokBin,
    dataDir,
    defaultWorkspaceRoot,
    access: loadAccessConfig(path.join(projectRoot, 'config', 'access.json')),
    permissionScopes: loadPermissionConfig(
      path.join(projectRoot, 'config', 'feishu-permissions.json')
    )
  };
}

export function defaultDataDir(): string {
  return '~/.grok-lark-bridge';
}

export function localConfigPath(): string {
  return path.join(expandHome(defaultDataDir()), 'config.json');
}

export function loadLocalConfig(filePath = localConfigPath()): LocalConfig {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return localConfigSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function saveLocalConfig(config: LocalConfig, filePath = localConfigPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function loadAccessConfig(filePath: string): AccessConfig {
  if (!fs.existsSync(filePath)) {
    return accessConfigSchema.parse({});
  }
  return accessConfigSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function loadPermissionConfig(filePath: string): PermissionConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing permission config: ${filePath}`);
  }
  return permissionConfigSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function readRequiredSetting(envName: string, localValue: string | undefined): string {
  const value = process.env[envName] || localValue;
  if (!value) {
    throw new Error(`Missing required setting: ${envName}`);
  }
  return value;
}

function readOptionalSetting(envName: string, localValue: string | undefined): string | undefined {
  return process.env[envName] || localValue;
}
