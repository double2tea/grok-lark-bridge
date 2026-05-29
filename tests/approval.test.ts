import { describe, expect, it } from 'vitest';
import { requiresApproval } from '../src/approval.js';

describe('requiresApproval', () => {
  it('confirms write tools by default policy', () => {
    expect(requiresApproval('confirm_write', 'read')).toBe(false);
    expect(requiresApproval('confirm_write', 'write')).toBe(true);
  });

  it('supports all-confirm and auto policies', () => {
    expect(requiresApproval('confirm_all', 'read')).toBe(true);
    expect(requiresApproval('confirm_all', 'write')).toBe(true);
    expect(requiresApproval('auto', 'write')).toBe(false);
  });
});
