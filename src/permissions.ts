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

export const toolDefinitions = [] as const satisfies readonly ToolDefinition[];

export type FeishuToolName = never;

export function enabledTools(
  permissionConfig: PermissionConfig,
  enableAdvancedOpenApiTool: boolean
): readonly ToolDefinition[] {
  void permissionConfig;
  void enableAdvancedOpenApiTool;
  return [];
}

export function missingToolScopes(permissionConfig: PermissionConfig): readonly string[] {
  void permissionConfig;
  return [];
}

export function findTool(name: string): ToolDefinition | undefined {
  void name;
  return undefined;
}
