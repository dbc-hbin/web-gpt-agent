import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { pluginManager } from '../plugins/manager.js';
import { getConfig } from '../config.js';
import { noteOutcome } from './call-context.js';
import { inboundRequestId } from './inbound.js';
import { dispatch, fail, type ManagedToolInvocation, type ToolResult } from './kernel.js';
import { markExternalOutcomeUnknown } from './tools-external.js';
import { codeModeDeclaration, codeModeHandler, codeModeWaitHandler, waitDeclaration, waitSchema } from './code-mode-tool.js';
import { toolSchema, toolSchemaJson } from './tool-declarations.js';
import { codeModeSchema } from './code-mode-runtime.js';
import { registerToolSearch } from './tool-search.js';

const envelope = z.object({
  arguments: z.record(z.string(), z.unknown()),
  operation_id: z.uuid().optional()
}).strict();

/** Receipt metadata never enters the upstream server's argument namespace. */
async function runPluginTool(name: string, args: unknown, identity: NonNullable<ManagedToolInvocation['external']>): Promise<ToolResult> {
  if (getConfig().readOnly) return pluginManager.redactResult(fail('TOOL_DISABLED: external plugins are unavailable while Web GPT Agent read-only mode is on.')) as ToolResult;
  const parsed = envelope.safeParse(args);
  if (!parsed.success) return fail('INVALID_ARGUMENTS: pass {arguments: {...}, operation_id?: UUID}; receipt metadata is outside upstream arguments.');
  let ambiguous = false;
  const result = await pluginManager.call(name, parsed.data.arguments, (outcome, unknown) => {
    noteOutcome(outcome);
    ambiguous = unknown === true;
  }, identity) as ToolResult;
  return ambiguous ? markExternalOutcomeUnknown(result) : result;
}

/** Backend names never become wire handlers, even when a plugin calls itself exec. */
export function registerPluginTools(server: McpServer): PluginToolSchema[] {
  const catalog = (): PluginToolSchema[] => pluginManager.tools().map(tool => ({
    ...tool,
    description: `${tool.description ?? ''}\nPass upstream inputs in arguments; managed calls also require operation_id.`,
    inputSchema: {
      type: 'object',
      properties: {
        arguments: { ...tool.inputSchema,
          // A nested schema resource keeps its original local $ref pointers meaningful.
          $id: typeof tool.inputSchema['$id'] === 'string' ? tool.inputSchema['$id'] : `urn:wgpt:plugin:${encodeURIComponent(tool.name)}` },
        operation_id: { type: 'string', format: 'uuid' }
      },
      required: ['arguments'],
      additionalProperties: false
    }
  }));
  const search = registerToolSearch(server, catalog);
  const options = { surface: 'plugins' as const };
  const declaration = codeModeDeclaration(options);
  const wait = waitDeclaration(options);
  const runCode = codeModeHandler(catalog, async (name, args, parent) => {
    const identity = pluginManager.exposedToolIdentity(name);
    if (!identity) return fail('PLUGIN_NOT_EXPOSED: this name has no current enabled installation. Read the current Plugins catalog.');
    return dispatch(name, args, parent.caller.transportKey, parent.caller.requestId, 'plugins',
      () => runPluginTool(name, args, identity), parent, identity);
  }, options);
  const runWait = codeModeWaitHandler(options);
  server.registerTool('exec', { ...declaration, inputSchema: toolSchema(codeModeSchema) }, (args, context) =>
    dispatch('exec', args, context.sessionId ?? null, inboundRequestId(), 'plugins', async () =>
      pluginManager.redactResult(await runCode(codeModeSchema.parse(args))) as ToolResult));
  // A plugin's script can yield too, so its cell must be resumable through the same redacted path.
  server.registerTool('wait', { ...wait, inputSchema: toolSchema(waitSchema) }, (args, context) =>
    dispatch('wait', args, context.sessionId ?? null, inboundRequestId(), 'plugins', async () =>
      pluginManager.redactResult(await runWait(waitSchema.parse(args))) as ToolResult));
  return [search,
    { name: 'exec', title: declaration.title, description: declaration.description,
      inputSchema: toolSchemaJson(codeModeSchema), annotations: declaration.annotations },
    { name: 'wait', title: wait.title, description: wait.description,
      inputSchema: toolSchemaJson(waitSchema), annotations: wait.annotations }];
}
