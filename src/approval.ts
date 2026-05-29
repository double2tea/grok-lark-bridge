import type { ApprovalPolicy, ToolRisk } from './types.js';

export function requiresApproval(policy: ApprovalPolicy, risk: ToolRisk): boolean {
  switch (policy) {
    case 'auto':
      return false;
    case 'confirm_all':
      return true;
    case 'confirm_write':
      return risk === 'write';
  }
}
