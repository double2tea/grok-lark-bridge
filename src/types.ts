export const approvalPolicies = ['confirm_write', 'confirm_all', 'auto'] as const;
export type ApprovalPolicy = (typeof approvalPolicies)[number];

export const toolRisks = ['read', 'write'] as const;
export type ToolRisk = (typeof toolRisks)[number];

export type RunStatus = 'idle' | 'running' | 'stopping';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface BridgeConfig {
  readonly feishuAppId: string;
  readonly feishuAppSecret: string;
  readonly feishuEncryptKey?: string;
  readonly feishuVerificationToken?: string;
  readonly grokBin: string;
  readonly dataDir: string;
  readonly defaultWorkspaceRoot: string;
  readonly access: AccessConfig;
  readonly permissionScopes: PermissionConfig;
}

export interface AccessConfig {
  readonly adminOpenIds: readonly string[];
  readonly allowedChatIds: readonly string[];
  readonly defaultApprovalPolicy: ApprovalPolicy;
  readonly approvalOverrides: readonly ApprovalOverride[];
  readonly enableAdvancedOpenApiTool: boolean;
}

export interface ApprovalOverride {
  readonly scope: 'chat' | 'user';
  readonly id: string;
  readonly policy: ApprovalPolicy;
}

export interface PermissionConfig {
  readonly scopes: {
    readonly tenant: readonly string[];
  };
}

export interface LocalConfig {
  readonly feishuAppId?: string;
  readonly feishuAppSecret?: string;
  readonly feishuEncryptKey?: string;
  readonly feishuVerificationToken?: string;
  readonly grokBin?: string;
  readonly dataDir?: string;
  readonly defaultWorkspaceRoot?: string;
}

export interface IncomingMessage {
  readonly eventId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly senderOpenId: string;
  readonly chatType: 'p2p' | 'group';
  readonly text: string;
  readonly mentionsBot: boolean;
  readonly rootId?: string;
  readonly threadId?: string;
  readonly parentId?: string;
  readonly replyToMessageId?: string;
}

export interface SessionKey {
  readonly chatId: string;
  readonly rootId?: string;
  readonly threadId?: string;
}

export interface SessionRecord {
  readonly key: string;
  readonly chatId: string;
  readonly rootId: string | null;
  readonly threadId: string | null;
  readonly grokSessionId: string;
  readonly nativeSessionId: string | null;
  readonly cwd: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly runStatus: RunStatus;
  readonly activeMessageId: string | null;
}

export interface GrokRunInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly contextKey: string;
  readonly requestedByOpenId: string;
}

export type GrokEvent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly text: string;
      readonly status?: 'running' | 'done' | 'error' | 'pending_approval';
      readonly kind?: 'command' | 'file_change' | 'web_search' | 'mcp' | 'generic';
      readonly inputSummary?: string;
      readonly outputSummary?: string;
      readonly durationMs?: number;
      readonly approvalId?: string;
    }
  | { readonly type: 'status'; readonly text: string };

export interface GrokBackend {
  run(
    input: GrokRunInput,
    onEvent: (event: GrokEvent) => Promise<void>,
    signal: AbortSignal
  ): Promise<number>;
}

export interface FeishuCardUpdate {
  readonly title: string;
  readonly body: string;
  readonly status: 'info' | 'success' | 'error' | 'warning';
  readonly actions?: readonly CardAction[];
}

export interface CardAction {
  readonly text: string;
  readonly value: Record<string, string>;
  readonly type?: 'primary' | 'danger' | 'default';
}

export interface PendingApproval {
  readonly id: string;
  readonly contextKey: string;
  readonly toolName: string;
  readonly risk: ToolRisk;
  readonly target: string;
  readonly argsJson: string;
  readonly requestedByOpenId: string;
  readonly createdAt: number;
  readonly status: ApprovalStatus;
  readonly resultText: string | null;
  readonly resolvedAt: number | null;
}

export interface FeishuToolResult {
  readonly text: string;
}

export interface IncomingCardAction {
  readonly eventId: string;
  readonly action: string;
  readonly approvalId?: string;
  readonly command?: string;
  readonly contextKey?: string;
  readonly operatorOpenId: string;
  readonly messageId?: string;
}
