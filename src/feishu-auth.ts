import type { BridgeConfig } from './types.js';

interface TenantTokenResponse {
  readonly code: number;
  readonly msg?: string;
  readonly tenant_access_token?: string;
  readonly expire?: number;
}

export interface FeishuCredentialCheck {
  readonly ok: boolean;
  readonly message: string;
  readonly expireSeconds?: number;
}

export async function checkFeishuCredentials(
  config: Pick<BridgeConfig, 'feishuAppId' | 'feishuAppSecret'>
): Promise<FeishuCredentialCheck> {
  const response = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: config.feishuAppId,
        app_secret: config.feishuAppSecret
      })
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      message: `HTTP ${String(response.status)} ${response.statusText}`
    };
  }

  const body = parseTenantTokenResponse(await response.json());
  if (body.code !== 0 || !body.tenant_access_token) {
    return {
      ok: false,
      message: body.msg
        ? `Feishu code ${String(body.code)}: ${body.msg}`
        : `Feishu code ${String(body.code)}`
    };
  }

  return {
    ok: true,
    message: 'tenant_access_token acquired',
    expireSeconds: body.expire
  };
}

function parseTenantTokenResponse(value: unknown): TenantTokenResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Feishu token response');
  }
  const record = value as Record<string, unknown>;
  const code = record.code;
  if (typeof code !== 'number') {
    throw new Error('Invalid Feishu token response: missing code');
  }
  return {
    code,
    msg: typeof record.msg === 'string' ? record.msg : undefined,
    tenant_access_token:
      typeof record.tenant_access_token === 'string' ? record.tenant_access_token : undefined,
    expire: typeof record.expire === 'number' ? record.expire : undefined
  };
}
