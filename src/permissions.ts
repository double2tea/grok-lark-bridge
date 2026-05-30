import { z } from 'zod';
import type { PermissionConfig, ToolRisk } from './types.js';

export interface ToolDefinition<
  TInput extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>
> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly scopes: readonly string[];
  readonly inputSchema: TInput;
  readonly target: (input: z.infer<TInput>) => string;
}

const contextSchema = {
  context_key: z
    .string()
    .min(1)
    .describe('Bridge context key from the current Feishu conversation'),
  requested_by_open_id: z.string().min(1).describe('Feishu open_id of the requesting user')
};

export const toolDefinitions = [
  {
    name: 'lark_msg_send_image',
    title: 'Send Feishu image',
    description:
      'Upload a local image file and send it as an image message. Supports JPEG, PNG, WEBP, GIF, TIFF, BMP and ICO within Feishu limits.',
    risk: 'write',
    scopes: ['im:message:send_as_bot'],
    inputSchema: z.object({
      ...contextSchema,
      chat_id: z.string().min(1),
      file_path: z.string().min(1)
    }),
    target: (input) => `image ${String(input.file_path)} to chat ${String(input.chat_id)}`
  },
  {
    name: 'lark_msg_send_file',
    title: 'Send Feishu file',
    description: 'Upload a local file and send it as a file message.',
    risk: 'write',
    scopes: ['im:message:send_as_bot'],
    inputSchema: z.object({
      ...contextSchema,
      chat_id: z.string().min(1),
      file_path: z.string().min(1),
      file_name: z.string().min(1).optional()
    }),
    target: (input) => `file ${String(input.file_path)} to chat ${String(input.chat_id)}`
  },
  {
    name: 'lark_msg_send_audio',
    title: 'Send Feishu audio',
    description: 'Upload a local OPUS audio file and send it as an audio message.',
    risk: 'write',
    scopes: ['im:message:send_as_bot'],
    inputSchema: z.object({
      ...contextSchema,
      chat_id: z.string().min(1),
      file_path: z.string().min(1),
      duration: z.number().positive().optional()
    }),
    target: (input) => `audio ${String(input.file_path)} to chat ${String(input.chat_id)}`
  },
  {
    name: 'lark_msg_send_video',
    title: 'Send Feishu video',
    description: 'Upload a local MP4 file and send it as a video/media message.',
    risk: 'write',
    scopes: ['im:message:send_as_bot'],
    inputSchema: z.object({
      ...contextSchema,
      chat_id: z.string().min(1),
      file_path: z.string().min(1),
      duration: z.number().positive().optional(),
      cover_image_key: z.string().min(1).optional()
    }),
    target: (input) => `video ${String(input.file_path)} to chat ${String(input.chat_id)}`
  },
  {
    name: 'lark_msg_read_history',
    title: 'Read Feishu message history',
    description: 'Read recent messages from a chat through the OpenAPI message list endpoint.',
    risk: 'read',
    scopes: ['im:message:readonly'],
    inputSchema: z.object({
      ...contextSchema,
      container_id: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10)
    }),
    target: (input) => `chat ${String(input.container_id)}`
  },
  {
    name: 'lark_doc_create',
    title: 'Create Feishu document',
    description: 'Create a Feishu document using the docx OpenAPI.',
    risk: 'write',
    scopes: ['docx:document'],
    inputSchema: z.object({
      ...contextSchema,
      title: z.string().min(1),
      folder_token: z.string().optional()
    }),
    target: (input) => `document ${String(input.title)}`
  },
  {
    name: 'lark_doc_read',
    title: 'Read Feishu document',
    description: 'Read raw content from a Feishu docx document.',
    risk: 'read',
    scopes: ['docx:document:readonly'],
    inputSchema: z.object({
      ...contextSchema,
      document_id: z.string().min(1)
    }),
    target: (input) => `document ${String(input.document_id)}`
  },
  {
    name: 'lark_task_create',
    title: 'Create Feishu task',
    description: 'Create a Feishu task.',
    risk: 'write',
    scopes: ['task:task'],
    inputSchema: z.object({
      ...contextSchema,
      summary: z.string().min(1),
      description: z.string().optional()
    }),
    target: (input) => `task ${String(input.summary)}`
  },
  {
    name: 'lark_calendar_create_event',
    title: 'Create Feishu calendar event',
    description: 'Create an event on a calendar.',
    risk: 'write',
    scopes: ['calendar:calendar.event:create'],
    inputSchema: z.object({
      ...contextSchema,
      calendar_id: z.string().min(1).default('primary'),
      summary: z.string().min(1),
      start_time: z.string().min(1),
      end_time: z.string().min(1)
    }),
    target: (input) => `calendar ${String(input.calendar_id)}`
  },
  {
    name: 'lark_bitable_query',
    title: 'Query Feishu bitable',
    description: 'Query records from a Feishu bitable table.',
    risk: 'read',
    scopes: ['bitable:app:readonly'],
    inputSchema: z.object({
      ...contextSchema,
      app_token: z.string().min(1),
      table_id: z.string().min(1),
      page_size: z.number().int().min(1).max(100).default(20)
    }),
    target: (input) => `bitable ${String(input.app_token)}/${String(input.table_id)}`
  },
  {
    name: 'lark_bitable_create_record',
    title: 'Create Feishu bitable record',
    description: 'Create a record in a Feishu bitable table.',
    risk: 'write',
    scopes: ['bitable:app'],
    inputSchema: z.object({
      ...contextSchema,
      app_token: z.string().min(1),
      table_id: z.string().min(1),
      fields: z.record(z.string(), z.unknown())
    }),
    target: (input) => `bitable ${String(input.app_token)}/${String(input.table_id)}`
  },
  {
    name: 'lark_contact_search',
    title: 'Search Feishu contact',
    description: 'Search contacts by query string.',
    risk: 'read',
    scopes: ['contact:contact.base:readonly'],
    inputSchema: z.object({
      ...contextSchema,
      query: z.string().min(1)
    }),
    target: (input) => `contact query ${String(input.query)}`
  },
  {
    name: 'lark_get_approval_result',
    title: 'Get result of a pending Feishu approval',
    description:
      'After a write tool returned "Approval requested: <id>", the agent can call this (with the same context_key) to retrieve the human decision and result once the approval is resolved in Feishu. This is the mechanism to "wait for the bridge approval result".',
    risk: 'read',
    scopes: [],
    inputSchema: z.object({
      ...contextSchema,
      approval_id: z.string().min(1)
    }),
    target: (input) => `approval ${String(input.approval_id)}`
  },
  {
    name: 'lark_raw_openapi',
    title: 'Advanced raw OpenAPI call',
    description: 'Admin-only raw call to Feishu OpenAPI. Disabled unless explicitly enabled.',
    risk: 'write',
    scopes: [],
    inputSchema: z.object({
      ...contextSchema,
      method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
      path: z.string().startsWith('/open-apis/'),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      data: z.unknown().optional()
    }),
    target: (input) => `${String(input.method)} ${String(input.path)}`
  }
] as const satisfies readonly ToolDefinition[];

export type FeishuToolName = (typeof toolDefinitions)[number]['name'];

export function enabledTools(
  permissionConfig: PermissionConfig,
  enableAdvancedOpenApiTool: boolean
): readonly ToolDefinition[] {
  const scopes = new Set(permissionConfig.scopes.tenant);
  return toolDefinitions.filter((tool) => {
    if (tool.name === 'lark_raw_openapi' && !enableAdvancedOpenApiTool) {
      return false;
    }
    return tool.scopes.every((scope) => scopes.has(scope));
  });
}

export function missingToolScopes(permissionConfig: PermissionConfig): readonly string[] {
  const scopes = new Set(permissionConfig.scopes.tenant);
  return Array.from(
    new Set(
      toolDefinitions.flatMap((tool) =>
        tool.scopes.filter((scope) => !scopes.has(scope)).map((scope) => `${tool.name}: ${scope}`)
      )
    )
  ).sort();
}

export function findTool(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((tool) => tool.name === name);
}
