import { z } from 'zod';
import { requiresApproval } from './approval.js';
import type { FeishuApiPort } from './feishu-api.js';
import { findTool, type ToolDefinition } from './permissions.js';
import { SessionService } from './session.js';
import { StateStore } from './storage.js';
import type { FeishuToolResult, SessionRecord } from './types.js';

export class FeishuToolExecutor {
  constructor(
    private readonly api: FeishuApiPort,
    private readonly store: StateStore,
    private readonly sessions: SessionService
  ) {}

  async call(tool: ToolDefinition, rawInput: unknown): Promise<FeishuToolResult> {
    const input = tool.inputSchema.parse(rawInput);
    const contextKey = readContextKey(input);
    const requestedByOpenId = readRequestedByOpenId(input);
    const session = this.sessions.getOrCreateByKey(contextKey);

    if (requiresApproval(session.approvalPolicy, tool.risk)) {
      const approval = this.store.createPendingApproval({
        contextKey,
        toolName: tool.name,
        risk: tool.risk,
        target: tool.target(input),
        argsJson: JSON.stringify(input),
        requestedByOpenId
      });
      await this.api.sendCard(session.chatId, {
        title: 'Grok 请求执行飞书操作',
        status: 'warning',
        body: [
          `工具: ${tool.name}`,
          `目标: ${approval.target}`,
          `来源: ${contextKey}`,
          '',
          '请确认是否执行。'
        ].join('\n'),
        actions: [
          {
            text: '确认执行',
            type: 'primary',
            value: { action: 'approval_approve', approval_id: approval.id }
          },
          {
            text: '拒绝',
            type: 'danger',
            value: { action: 'approval_reject', approval_id: approval.id }
          }
        ]
      });
      return this.waitForApprovalResult(approval.id);
    }

    return this.executeNow(tool.name, input, session);
  }

  async executePendingApproval(approvalId: string): Promise<FeishuToolResult> {
    const approval = this.store.getPendingApproval(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    if (approval.status === 'approved') {
      return { text: approval.resultText ?? '' };
    }
    if (approval.status === 'rejected') {
      throw new Error(approval.resultText ?? `Approval rejected: ${approvalId}`);
    }
    const tool = findTool(approval.toolName);
    if (!tool) {
      throw new Error(`Unknown approval tool: ${approval.toolName}`);
    }
    const input = tool.inputSchema.parse(JSON.parse(approval.argsJson));
    const session = this.sessions.getOrCreateByKey(approval.contextKey);
    const result = await this.executeNow(tool.name, input, session);
    this.store.resolvePendingApproval(approvalId, 'approved', result.text);
    return result;
  }

  rejectPendingApproval(approvalId: string): void {
    this.store.resolvePendingApproval(approvalId, 'rejected', `Approval rejected: ${approvalId}`);
  }

  private async waitForApprovalResult(approvalId: string): Promise<FeishuToolResult> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10 * 60 * 1000) {
      const approval = this.store.getPendingApproval(approvalId);
      if (!approval) {
        throw new Error(`Unknown approval: ${approvalId}`);
      }
      if (approval.status === 'approved') {
        return { text: approval.resultText ?? '' };
      }
      if (approval.status === 'rejected') {
        throw new Error(approval.resultText ?? `Approval rejected: ${approvalId}`);
      }
      await sleep(1000);
    }
    throw new Error(`Approval timed out: ${approvalId}`);
  }

  private async executeNow(
    toolName: string,
    input: Record<string, unknown>,
    session: SessionRecord
  ): Promise<FeishuToolResult> {
    switch (toolName) {
      case 'lark_msg_send':
        await this.api.sendText(
          readRequiredString(input, 'chat_id'),
          readRequiredString(input, 'text')
        );
        return { text: 'Message sent.' };
      case 'lark_msg_reply':
        await this.api.request(
          'POST',
          `/open-apis/im/v1/messages/${encodeURIComponent(readRequiredString(input, 'message_id'))}/reply`,
          {
            data: {
              msg_type: 'text',
              content: JSON.stringify({ text: readRequiredString(input, 'text') })
            }
          }
        );
        return { text: 'Message replied.' };
      case 'lark_msg_read_history':
        return {
          text: JSON.stringify(
            await this.api.request('GET', '/open-apis/im/v1/messages', {
              params: {
                container_id_type: 'chat',
                container_id: readRequiredString(input, 'container_id'),
                page_size: readRequiredNumber(input, 'limit')
              }
            })
          )
        };
      case 'lark_doc_create':
        return {
          text: JSON.stringify(
            await this.api.request('POST', '/open-apis/docx/v1/documents', {
              data: {
                title: readRequiredString(input, 'title'),
                folder_token: readOptionalString(input, 'folder_token')
              }
            })
          )
        };
      case 'lark_doc_read':
        return {
          text: JSON.stringify(
            await this.api.request(
              'GET',
              `/open-apis/docx/v1/documents/${encodeURIComponent(readRequiredString(input, 'document_id'))}/raw_content`
            )
          )
        };
      case 'lark_task_create':
        return {
          text: JSON.stringify(
            await this.api.request('POST', '/open-apis/task/v2/tasks', {
              data: {
                summary: readRequiredString(input, 'summary'),
                description: readOptionalString(input, 'description')
              }
            })
          )
        };
      case 'lark_calendar_create_event':
        return {
          text: JSON.stringify(
            await this.api.request(
              'POST',
              `/open-apis/calendar/v4/calendars/${encodeURIComponent(
                readRequiredString(input, 'calendar_id')
              )}/events`,
              {
                data: {
                  summary: readRequiredString(input, 'summary'),
                  start_time: { timestamp: readRequiredString(input, 'start_time') },
                  end_time: { timestamp: readRequiredString(input, 'end_time') }
                }
              }
            )
          )
        };
      case 'lark_bitable_query':
        return {
          text: JSON.stringify(
            await this.api.request(
              'GET',
              `/open-apis/bitable/v1/apps/${encodeURIComponent(
                readRequiredString(input, 'app_token')
              )}/tables/${encodeURIComponent(readRequiredString(input, 'table_id'))}/records`,
              { params: { page_size: readRequiredNumber(input, 'page_size') } }
            )
          )
        };
      case 'lark_bitable_create_record':
        return {
          text: JSON.stringify(
            await this.api.request(
              'POST',
              `/open-apis/bitable/v1/apps/${encodeURIComponent(
                readRequiredString(input, 'app_token')
              )}/tables/${encodeURIComponent(readRequiredString(input, 'table_id'))}/records`,
              { data: { fields: readRecord(input, 'fields') } }
            )
          )
        };
      case 'lark_contact_search':
        return {
          text: JSON.stringify(
            await this.api.request('GET', '/open-apis/contact/v3/users/find_by_department', {
              params: { department_id: '0', page_size: 50, user_id_type: 'open_id' }
            })
          )
        };
      case 'lark_get_approval_result': {
        const approval = this.store.getPendingApproval(readRequiredString(input, 'approval_id'));
        if (!approval) {
          return { text: JSON.stringify({ status: 'unknown', message: 'Approval not found' }) };
        }
        if (approval.status === 'pending') {
          return {
            text: JSON.stringify({
              status: 'pending',
              message: 'Still waiting for human decision in Feishu'
            })
          };
        }
        return {
          text: JSON.stringify({
            status: approval.status,
            result: approval.resultText,
            resolvedAt: approval.resolvedAt
          })
        };
      }
      case 'lark_raw_openapi':
        return {
          text: JSON.stringify(
            await this.api.rawOpenApi({
              method: readMethod(input),
              path: readRequiredString(input, 'path'),
              params: readOptionalParams(input),
              data: input.data
            })
          )
        };
      default:
        throw new Error(`Unhandled tool: ${toolName} for session ${session.key}`);
    }
  }
}

function readContextKey(input: unknown): string {
  return readRequiredString(toRecord(input), 'context_key');
}

function readRequestedByOpenId(input: unknown): string {
  return readRequiredString(toRecord(input), 'requested_by_open_id');
}

function readRequiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string: ${key}`);
  }
  return value;
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected string: ${key}`);
  }
  return value;
}

function readRequiredNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number') {
    throw new Error(`Expected number: ${key}`);
  }
  return value;
}

function readRecord(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  return toRecord(value);
}

function readOptionalParams(
  input: Record<string, unknown>
): Record<string, string | number | boolean> | undefined {
  const value = input.params;
  if (value === undefined) {
    return undefined;
  }
  const record = toRecord(value);
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`Invalid raw_openapi param: ${key}`);
    }
    output[key] = item;
  }
  return output;
}

function readMethod(input: Record<string, unknown>): 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' {
  return z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).parse(input.method);
}

function toRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Expected object input');
  }
  return input as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
