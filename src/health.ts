import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  loadAccessConfig,
  loadLocalConfig,
  loadPermissionConfig,
  localConfigPath
} from './config.js';
import { enabledTools, missingToolScopes } from './permissions.js';
import { expandHome } from './utils.js';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function checkGrok(grokBin: string): string {
  const result = spawnSync(grokBin, ['--version'], {
    encoding: 'utf8',
    timeout: 2000
  });
  if (result.error) {
    return `unavailable (${result.error.message}); run grok login or configure GROK_BIN`;
  }
  if (result.status !== 0) {
    return `unavailable (exit ${String(result.status)}); run grok login or configure GROK_BIN`;
  }
  return 'available';
}

export function runDoctor(projectRoot = process.cwd()): readonly DoctorCheck[] {
  const envPath = path.join(projectRoot, '.env');
  const env = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const localPath = localConfigPath();
  const local = loadLocalConfig(localPath);
  const configDir = path.join(projectRoot, 'config');
  const accessPath = path.join(configDir, 'access.json');
  const permissionsPath = path.join(configDir, 'feishu-permissions.json');

  const checks: DoctorCheck[] = [];
  checks.push({
    name: '.env',
    ok: true,
    detail: fs.existsSync(envPath) ? 'found' : 'not set; using local config if available'
  });
  checks.push({
    name: 'local config',
    ok: true,
    detail: fs.existsSync(localPath)
      ? localPath
      : `not found; run npm run setup or copy .env.example`
  });

  checks.push(checkSetting(env, local.feishuAppId, 'FEISHU_APP_ID'));
  checks.push(checkSetting(env, local.feishuAppSecret, 'FEISHU_APP_SECRET'));
  checks.push(checkOptionalSetting(env, local.feishuEncryptKey, 'FEISHU_ENCRYPT_KEY'));
  checks.push(
    checkOptionalSetting(env, local.feishuVerificationToken, 'FEISHU_VERIFICATION_TOKEN')
  );

  const grokBin = readEnv(env, 'GROK_BIN') ?? process.env.GROK_BIN ?? local.grokBin ?? 'grok';
  const grokStatus = checkGrok(grokBin);
  checks.push({
    name: 'Grok CLI',
    ok: grokStatus === 'available',
    detail: grokStatus
  });

  const dataDir = expandHome(
    readEnv(env, 'DATA_DIR') ?? process.env.DATA_DIR ?? local.dataDir ?? '~/.grok-lark-bridge'
  );
  checks.push({
    name: 'DATA_DIR',
    ok: canCreateDir(dataDir),
    detail: dataDir
  });

  try {
    const access = loadAccessConfig(accessPath);
    checks.push({
      name: 'access.json',
      ok: true,
      detail: `admins=${String(access.adminOpenIds.length)}, chatAllowlist=${String(
        access.allowedChatIds.length
      )}, defaultApproval=${access.defaultApprovalPolicy}`
    });
  } catch (error) {
    checks.push({
      name: 'access.json',
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const permissions = loadPermissionConfig(permissionsPath);
    const access = loadAccessConfig(accessPath);
    const tools = enabledTools(permissions, access.enableAdvancedOpenApiTool);
    const missing = missingToolScopes(permissions);
    checks.push({
      name: 'feishu-permissions.json',
      ok: true,
      detail: `enabledTools=${String(tools.length)}, missingScopes=${String(missing.length)}`
    });
  } catch (error) {
    checks.push({
      name: 'feishu-permissions.json',
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  return checks;
}

function checkSetting(
  env: Record<string, string>,
  localValue: string | undefined,
  key: string
): DoctorCheck {
  const value = readEnv(env, key) ?? process.env[key] ?? localValue;
  return {
    name: key,
    ok: typeof value === 'string' && value.length > 0,
    detail: value ? 'set' : 'missing'
  };
}

function checkOptionalSetting(
  env: Record<string, string>,
  localValue: string | undefined,
  key: string
): DoctorCheck {
  const value = readEnv(env, key) ?? process.env[key] ?? localValue;
  return {
    name: key,
    ok: true,
    detail: value ? 'set' : 'not set'
  };
}

function readEnv(env: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
}

function canCreateDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
