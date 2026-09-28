/** Each connector publishes a small code-mode API; its backend handlers remain private.
 * Core, Desktop and Plugins never forward names across connector boundaries. */
import { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { toolSchemaJson } from './tool-declarations.js';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { createRegistrar, type ToolAnnotations, type ToolContext } from './kernel.js';
import { registerCoreTools } from './tools-core.js';
import { desktopCuaCatalog, invokeDesktopCua, registerDesktopTools } from './tools-desktop.js';
import { CUA_DESKTOP_TOOLS } from '../cua/catalog.js';
import { registerPluginTools } from './tools-plugins.js';
import { registerExternalTools } from './tools-external.js';
import { registerWorkControlTools } from './tools-work-control.js';
import { registerCodeMode } from './code-mode-tool.js';
import { registerToolSearch } from './tool-search.js';
import { surfaceDefinition, type SurfaceId } from './surfaces.js';
import { serverInstructions } from './instructions.js';
import { APP_VERSION } from '../version.js';
import { toVirtualPath } from '../sandbox.js';
import { withManagedSkills } from '../skill-access.js';
import { APPLY_PATCH_ARGUMENT_DESCRIPTION } from '../codex/tool-specs.js';

export function buildServer(ctx: ToolContext, surface: SurfaceId, observe?: (connectorName: string, version: string, instructions: string, tools: PluginToolSchema[]) => void, liveContext: () => ToolContext = () => ctx): McpServer {
  if (surface === 'core') ctx = withManagedSkills(ctx);
  const definition = surfaceDefinition(surface);
  const instructions = serverInstructions(ctx, surface);
  const server = new McpServer({ name: definition.serverName, version: APP_VERSION }, { capabilities: { tools: {} }, instructions });
  if (surface === 'plugins') {
    const tools = registerPluginTools(server);
    observe?.(definition.connectorName, APP_VERSION, instructions, tools);
    return server;
  }
  const tools: PluginToolSchema[] = [];
  const noteDeclaration = (name: string, config: { title?: string; description: string; inputSchema: z.ZodType; outputSchema?: z.ZodType; annotations?: ToolAnnotations; _meta?: Record<string, unknown> }): void => {
    tools.push({ name, description: config.description, inputSchema: { type: 'object', ...toolSchemaJson(config.inputSchema) },
      ...(config.title ? { title: config.title } : {}),
      ...(config.outputSchema ? { outputSchema: toolSchemaJson(config.outputSchema, 'output') } : {}),
      ...(config.annotations ? { annotations: { ...config.annotations } } : {}),
      ...(config._meta ? { _meta: config._meta } : {}) });
  };
  const publicNames = new Set(surface === 'core' ? ['exec', 'exec_read', 'wait', 'agents', 'session_finish'] : ['exec', 'wait']);
  const registrar = createRegistrar(server, ctx, surface, noteDeclaration, publicNames);
  if (surface === 'core') {
    registerCoreTools(registrar);
    registerExternalTools(registrar);
    registerWorkControlTools(server, ctx, noteDeclaration, liveContext);
  } else registerDesktopTools(registrar);

  // Discovery reflects live permission state, while child dispatch retains previously known
  // handlers so revocation returns TOOL_DISABLED rather than accidentally bypassing a gate.
  const backend = (discovery: boolean) => {
    const live = liveContext();
    const current = discovery ? { ...live, exposedCaps: live.caps,
      exposedSessionTools: live.sessionTools, exposedAgentTools: live.agentTools,
      exposedFinishTool: false, exposedFind: live.caps.search } : live;
    const nested = createRegistrar(null, surface === 'core' ? withManagedSkills(current) : current, surface);
    if (surface === 'core') { registerCoreTools(nested); registerExternalTools(nested); }
    else registerDesktopTools(nested);
    return nested;
  };
  // `apply_patch` is published as raw patch text — the upstream freeform contract — rather than the
  // `{patch}` object its handler validates internally, so discovery and the nested call agree.
  const applyPatchAsString = (tool: PluginToolSchema): PluginToolSchema =>
    surface === 'core' && tool.name === 'apply_patch'
      ? { ...tool, inputSchema: { type: 'string', minLength: 1, description: APPLY_PATCH_ARGUMENT_DESCRIPTION } }
      : tool;
  const available = (discovery: boolean) => [
    ...backend(discovery).catalog().filter(tool => !publicNames.has(tool.name)).map(applyPatchAsString),
    ...(surface === 'desktop' ? desktopCuaCatalog() : [])
  ];
  tools.push(registerToolSearch(server, () => available(true)));
  const cuaNames = new Set<string>(CUA_DESKTOP_TOOLS);
  registerCodeMode(registrar, (name, args, parent) =>
    surface === 'desktop' && cuaNames.has(name) ? invokeDesktopCua(name, args, parent) : backend(false).invokeNested(name, args, parent),
    { surface },
    () => [
      ...backend(false).descriptions().filter(tool => !publicNames.has(tool.name)),
      ...(surface === 'desktop' ? desktopCuaCatalog().map(({ name, description }) => ({ name, description })) : [])
    ]);
  observe?.(definition.connectorName, APP_VERSION, instructions, tools);
  return server;
}

export { toVirtualPath };
export type { ToolContext };
export { chunkText, lastToolCallAt, resetToolClock, transportIdentityStatus } from './kernel.js';
export { lastDiscoveryAt, lastExecutionAt, lastWorkControlAt } from './connector-evidence.js';
