import { describe, expect, it } from 'vitest';
import { enabledTools, missingToolScopes } from '../src/permissions.js';

describe('permissions', () => {
  it('exposes zero bridge-local MCP tools', () => {
    const tools = enabledTools(
      { scopes: { tenant: ['im:message:send_as_bot', 'im:message:readonly'] } },
      false
    ).map((tool) => tool.name);

    expect(tools).toEqual([]);
  });

  it('reports no missing scopes for bridge-local MCP tools', () => {
    const missing = missingToolScopes({ scopes: { tenant: ['im:message:send_as_bot'] } });

    expect(missing).toEqual([]);
  });
});
