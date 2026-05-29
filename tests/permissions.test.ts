import { describe, expect, it } from 'vitest';
import { enabledTools, missingToolScopes } from '../src/permissions.js';

describe('permissions', () => {
  it('registers only tools whose scopes are present', () => {
    const tools = enabledTools(
      { scopes: { tenant: ['im:message:send_as_bot', 'im:message:readonly'] } },
      false
    ).map((tool) => tool.name);

    expect(tools).toContain('lark_msg_send');
    expect(tools).toContain('lark_msg_read_history');
    expect(tools).not.toContain('lark_doc_create');
    expect(tools).not.toContain('lark_raw_openapi');
  });

  it('reports missing scopes per tool', () => {
    const missing = missingToolScopes({ scopes: { tenant: ['im:message:send_as_bot'] } });

    expect(missing.some((item) => item.includes('lark_msg_read_history'))).toBe(true);
  });
});
