/**
 * The lazy external-tool gateway on the Core surface.
 *
 * A configured external MCP server or the app-owned native CUA runtime is not published as raw
 * tools here. It is reachable through exactly two tools, so a large server catalog costs the
 * Core connector two schemas instead of dozens, and the caller has to name the installation it
 * means. Two servers exporting the same raw tool name therefore stay unambiguous: routing is by
 * `server_id`, never by a name that only one of them happens to own.
 *
 * Both tools run inside the ordinary worker dispatch path, so they inherit exact worker
 * identity, the generation fence, live permissions and the runtime's mutation receipts. The
 * gateway adds only what is specific to external calls:
 *
 *  - `mcp_tools` reads the retained plugin catalog or current host-native catalog and never connects,
 *    reconnects, authenticates or retries anything.
 *  - `mcp_call` re-validates the server's current schema and the caller's `schema_hash`
 *    before dispatching. A changed hash means the caller is working from a superseded schema,
 *    so it fails before invocation rather than sending arguments shaped for a different contract.
 *
 * Discovery is read-only; the call wrapper is advertised as mutating. Only an exact
 * native server+tool pair on the host-owned reviewed read-only list may omit an operation
 * receipt, and that decision is exported as `isReadOnlyExternalCall` for the runtime's gate.
 */

import { canonicalSha256, externalSchemaHash } from '../plugins/external-declaration.js';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { fail, ok, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { currentCall } from './call-context.js';
import { getConfig } from '../config.js';
import { createHash } from 'node:crypto';
import { ExternalNotDispatched, pluginManager, type ExternalInstallation } from '../plugins/manager.js';
import { CUA_SERVER_ID, cuaCapabilityEnabled, cuaReservedRoutingField, cuaToolCapability, isCuaReadOnlyTool } from '../cua/catalog.js';
import { embeddedCuaCatalog, embeddedCuaStatus, invokeEmbeddedCua, validateEmbeddedCuaArguments } from '../cua/runtime.js';
import {
  acquireGuiLease,
  assertCuaSnapshot,
  consumeCuaObservation,
  holdGuiAction,
  isCuaObservationTool,
  isCuaMutatingTool,
  isCuaSnapshotBoundTool,
  managedCallerFor,
  noteCuaObservation,
  noteCuaTransportGeneration,
  noteCuaVerification,
  CuaBusyError,
  ManagedCallerUnavailable,
  type ManagedWorkerIdentity
} from '../work/cua.js';

export const EXTERNAL_TOOL_NAMES = ['mcp_tools', 'mcp_call'] as const;

/** Summary listing defaults, matching the plan's bounded discovery contract. */
export const MCP_TOOLS_DEFAULT_LIMIT = 20;
export const MCP_TOOLS_MAX_LIMIT = 50;
export const MCP_TOOLS_SUMMARY_MAX_BYTES = 32 * 1024;
/** Full exact schema responses may use the manager's own publication ceiling. */
export const MCP_TOOLS_SCHEMA_MAX_BYTES = 250000;


// ------------------------------------------------------------------- catalog projection

/**
 * The catalog revision a cursor is scoped to.
 *
 * Built from the retained catalogs of every enabled installation, so any install, uninstall,
 * disable or discovery refresh changes it and invalidates outstanding cursors. Cursors are
 * opaque offsets into this exact revision; a cursor from an older one is refused rather than
 * silently reinterpreted against a different list.
 */
export function catalogRevision(installations: readonly ExternalInstallation[]): string {
  return canonicalSha256(
    installations.map(installation => ({
      id: installation.id,
      enabled: installation.enabled,
      status: installation.status,
      gatewayOnly: installation.gatewayOnly,
      generation: installation.generation,
      schemas: installation.id === CUA_SERVER_ID ? embeddedCuaCatalog()?.tools.filter(tool => cuaCapabilityEnabled(tool.name)).map(tool => externalSchemaHash(tool)) : undefined,
      tools: installation.toolNames,
      disabledTools: installation.disabledToolNames
    }))
  );
}

interface CatalogEntrySummary {
  server_id: string;
  name: string;
  catalog_id?: string;
  enabled: boolean;
  status: string;
  gateway_only: boolean;
  tool_count: number;
  disabled_tool_count: number;
}

interface ToolSummary {
  name: string;
  description: string;
  read_only?: boolean;
  annotations?: Record<string, unknown>;
}

function toolSummary(tool: Tool): ToolSummary {
  return {
    name: tool.name,
    description: (tool.description ?? '').slice(0, 1024),
    ...(tool.annotations?.readOnlyHint === true ? { read_only: true } : {}),
    ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {})
  };
}

/** Cursor payloads are validated JSON, so a mangled cursor is refused, not guessed at. */
const cursorSchema = z.object({
  v: z.literal(1),
  revision: z.string().min(1),
  server_id: z.string().min(1),
  offset: z.number().int().min(0)
}).strict();

type CursorPayload = z.infer<typeof cursorSchema>;

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function boundSummary(payload: unknown, maxBytes = MCP_TOOLS_SUMMARY_MAX_BYTES): unknown {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) <= maxBytes) return payload;
  return {
    truncated: true,
    reason: 'The summary exceeded its size limit. Request one exact tool with {server_id, tool} for its complete schema.',
    preview: text.slice(0, maxBytes)
  };
}

// ------------------------------------------------------------------- installation lookup

/**
 * Resolves one enabled installation by its stable id.
 *
 * Plugins use installation UUIDs and the app-owned CUA server uses one reserved stable id;
 * neither is a raw tool name, so same-name tools remain unambiguous.
 */
function findInstallation(serverId: string): ExternalInstallation | null {
  if (serverId === CUA_SERVER_ID) return nativeInstallation();
  return pluginManager.externalInstallations().find(entry => entry.id === serverId) ?? null;
}

function nativeInstallation(): ExternalInstallation {
  const catalog = embeddedCuaCatalog();
  return { id: CUA_SERVER_ID, name: 'App-owned CUA Driver', enabled: true,
    status: catalog ? 'ready' : 'error', gatewayOnly: true,
    generation: catalog?.generation ?? embeddedCuaStatus().generation,
    toolNames: catalog?.tools.filter(tool => cuaCapabilityEnabled(tool.name)).map(tool => tool.name) ?? [], disabledToolNames: [] };
}

function retainedTool(installation: ExternalInstallation, name: string): Tool | null {
  if (installation.id !== CUA_SERVER_ID) return pluginManager.retainedTool(installation.id, name);
  return cuaCapabilityEnabled(name) ? embeddedCuaCatalog()?.tools.find(tool => tool.name === name) ?? null : null;
}

/** The retained tool declaration for one installation, or a refusal explaining why not. */
function declaredTool(installation: ExternalInstallation, name: string): { tool: Tool } | { refusal: string } {
  if (installation.id === CUA_SERVER_ID && !cuaCapabilityEnabled(name))
    return { refusal: `TOOL_DISABLED: ${name} requires live ${cuaToolCapability(name)} permission.` };
  if (installation.disabledToolNames.includes(name))
    return { refusal: `MCP_TOOL_DISABLED: ${installation.id}/${name} is disabled in Settings.` };
  if (!installation.enabled)
    return { refusal: `MCP_SERVER_DISABLED: installation ${installation.id} (${installation.name}) is disabled. Enable it in the app, then retry.` };
  if (installation.id === CUA_SERVER_ID && installation.status !== 'ready')
    return { refusal: `CUA_DRIVER_UNAVAILABLE: bundled native driver is not ready (${embeddedCuaStatus().error ?? 'starting'}).` };
  if (installation.status !== 'ready')
    return {
      refusal:
        `MCP_SERVER_UNAVAILABLE: installation ${installation.id} (${installation.name}) is ${installation.status}. ` +
        'Check the plugin in the app, then retry. Its tools are read from the retained catalog and are not refreshed by this call.'
    };
  const tool = retainedTool(installation, name);
  if (!tool)
    return {
      refusal:
        `MCP_UNKNOWN_TOOL: installation ${installation.id} (${installation.name}) does not declare "${name}". ` +
        'List its tools with mcp_tools first; a name from another server is never resolved here.'
    };
  return { tool };
}

// ------------------------------------------------------------------- read-only admission

/**
 * Whether this exact external call is a reviewed read-only operation.
 *
 * Synchronous and fail-closed, because the runtime's mutation gate calls it before deciding
 * whether an operation receipt is required. Upstream annotations are deliberately not consulted:
 * they are third-party hints, and a server could mark a mutating tool read-only. Only an exact
 * native server on the host-owned reviewed list qualifies, and for the bundled CUA Driver
 * only the reviewed read subset of its allowlist does.
 */
export function isReadOnlyExternalCall(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const parsed = mcpCallSchema.safeParse(args);
  if (!parsed.success) return false;
  const installation = findInstallation(parsed.data.server_id);
  if (!installation || !installation.enabled || installation.status !== 'ready' || !installation.toolNames.includes(parsed.data.tool)) return false;
  if (installation.id !== CUA_SERVER_ID) {
    // A user-added external server carries no host-owned read-only review, so every call through
    // it needs a receipt. The reviewed list is enumerated in code, never derived from the
    // server's own annotations — a third-party server could mark a mutating tool read-only.
    return false;
  }
  return cuaCapabilityEnabled(parsed.data.tool) && isCuaReadOnlyTool(parsed.data.tool);
}

const outcomeUnknownMarker = Symbol.for('web-gpt-agent.external-outcome-unknown');

/**
 * Marks a result whose external side effect may have happened.
 *
 * A transport failure after dispatch cannot distinguish "the server never ran it" from "the
 * server ran it and the reply was lost". The runtime records that as `outcome_unknown` — never a
 * plain failure — and this marker is how the fact survives the result object without being
 * inferred from result text. It is a symbol, so it never appears in the MCP payload.
 */
export function markExternalOutcomeUnknown(result: ToolResult): ToolResult {
  // Enumerable on purpose: the dispatcher projects a result by spreading it (inbox, notices,
  // user input), and only enumerable own properties survive that. A symbol key is invisible to
  // JSON and to the SDK's result projection, so this marker cannot reach a caller's payload.
  Object.defineProperty(result, outcomeUnknownMarker, { value: true, enumerable: true });
  return result;
}

export function externalCallOutcome(result: ToolResult): 'completed' | 'outcome_unknown' {
  return (result as ToolResult & { [outcomeUnknownMarker]?: boolean })[outcomeUnknownMarker] === true
    ? 'outcome_unknown'
    : 'completed';
}

// ------------------------------------------------------------------- schemas

const mcpToolsSchema = z.object({
  server_id: z.string().min(1).max(80).optional(),
  tool: z.string().min(1).max(256).optional(),
  query: z.string().max(200).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(MCP_TOOLS_MAX_LIMIT).optional()
}).strict();

const mcpCallSchema = z.object({
  server_id: z.string().min(1).max(80),
  tool: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).default({}),
  schema_hash: z.string().min(1).max(128),
  operation_id: z.uuid().optional()
}).strict();

// ------------------------------------------------------------------- mcp_tools

function listInstallations(): { installations: CatalogEntrySummary[] } {
  return {
    installations: [...pluginManager.externalInstallations(), nativeInstallation()].map(installation => ({
      server_id: installation.id,
      name: installation.name,
      ...(installation.catalogId ? { catalog_id: installation.catalogId } : {}),
      enabled: installation.enabled,
      status: installation.status,
      gateway_only: installation.gatewayOnly,
      tool_count: installation.toolNames.length,
      disabled_tool_count: installation.disabledToolNames.length
    }))
  };
}

function listTools(input: z.infer<typeof mcpToolsSchema>): ToolResult {
  const installations = [...pluginManager.externalInstallations(), nativeInstallation()];
  const revision = catalogRevision(installations);
  const serverId = input.server_id;
  if (!serverId) {
    if (input.tool || input.cursor)
      return fail('INVALID_ARGUMENTS: {tool} and {cursor} require {server_id}.');
    return ok(JSON.stringify(boundSummary({ revision, ...listInstallations() }), null, 1));
  }
  const installation = findInstallation(serverId);
  if (!installation)
    return fail(
      `MCP_UNKNOWN_SERVER: no configured installation has id ${serverId}. ` +
        'Call mcp_tools without arguments to list the configured installations.'
    );
  if (!installation.enabled)
    return fail(`MCP_SERVER_DISABLED: installation ${serverId} (${installation.name}) is disabled. Enable it in the app, then retry.`);

  if (input.tool) {
    const resolved = declaredTool(installation, input.tool);
    if ('refusal' in resolved) return fail(resolved.refusal);
    const tool = resolved.tool;
    const schemaBytes = Buffer.byteLength(JSON.stringify(tool));
    if (schemaBytes > MCP_TOOLS_SCHEMA_MAX_BYTES)
      return fail(
        `MCP_SCHEMA_TOO_LARGE: the declaration for ${installation.id}/${tool.name} is ${schemaBytes} bytes, above the ${MCP_TOOLS_SCHEMA_MAX_BYTES}-byte publication ceiling. ` +
          'No schema constraints were removed to fit it.'
      );
    // The exact declaration, with $ref, output schema and annotations intact.
    return ok(JSON.stringify({
      revision,
      server_id: installation.id,
      name: installation.name,
      generation: installation.generation,
      schema_hash: externalSchemaHash(tool),
      tool
    }, null, 1));
  }

  const names = installation.toolNames;
  let offset = 0;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded || decoded.revision !== revision || decoded.server_id !== installation.id)
      return fail(
        'MCP_CURSOR_INVALID: this cursor does not belong to the current catalog revision for that installation. ' +
          'Call mcp_tools again without a cursor to start a fresh listing.'
      );
    offset = decoded.offset;
  }
  const limit = input.limit ?? MCP_TOOLS_DEFAULT_LIMIT;
  const query = input.query?.trim().toLowerCase();
  const matching = query
    ? names.filter(name => {
      const tool = retainedTool(installation, name);
      return `${name} ${tool?.description ?? ''}`.toLowerCase().includes(query);
    })
    : names;
  const page = matching.slice(offset, offset + limit);
  const next = offset + page.length < matching.length
    ? encodeCursor({ v: 1, revision, server_id: installation.id, offset: offset + page.length })
    : null;
  const tools = page.map(name => toolSummary(retainedTool(installation, name)!));
  return ok(JSON.stringify(boundSummary({
    revision,
    server_id: installation.id,
    name: installation.name,
    generation: installation.generation,
    total: matching.length,
    returned: tools.length,
    next_cursor: next,
    tools
  }), null, 1));
}

// ------------------------------------------------------------------- mcp_call

/** One refusal path for every pre-dispatch rejection: nothing was sent. */
function refuse(reason: string): ToolResult {
  return fail(`${reason} This call was not dispatched.`);
}

function cuaCall(args: Record<string, unknown>, installation: ExternalInstallation, identity: ManagedWorkerIdentity | null): ToolResult | null {
  if (installation.id !== CUA_SERVER_ID) return null;
  if (!identity)
    return refuse(
      'WORKER_CONNECTION_REQUIRED: native desktop control is available to a managed work\'s prime agent only. ' +
        'Use the direct work tool with action="start" for a new task, or ask the prime agent to perform UI work.'
    );
  if (identity.role !== 'prime')
    return refuse(
      'CUA_PRIME_ONLY: only the work\'s prime agent may drive the native desktop. Send your UI request to the prime agent; coding-only work continues normally.'
    );
  const reserved = cuaReservedRoutingField(args);
  if (reserved)
    return refuse(
      `CUA_RESERVED_FIELD: "${reserved}" is transport routing metadata owned by the app's proxy and cannot be supplied by a caller.`
    );
  if ('session' in args)
    return refuse('CUA_SESSION_OWNED: native session routing belongs to the proven work, not model input.');
  return null;
}

function nativeAuthority(name: string, identity: ManagedWorkerIdentity): boolean {
  if (getConfig().readOnly || !cuaCapabilityEnabled(name)) return false;
  const current = cuaIdentity();
  return 'identity' in current && current.identity.role === 'prime' &&
    current.identity.workId === identity.workId && current.identity.generation === identity.generation;
}

async function runCall(input: z.infer<typeof mcpCallSchema>): Promise<ToolResult> {
  if (getConfig().readOnly)
    return refuse('TOOL_DISABLED: external plugins are unavailable while Web GPT Agent read-only mode is on.');
  const installation = findInstallation(input.server_id);
  if (!installation)
    return refuse(
      `MCP_UNKNOWN_SERVER: no configured installation has id ${input.server_id}. Call mcp_tools to list the configured installations.`
    );
  const resolved = declaredTool(installation, input.tool);
  if ('refusal' in resolved) return refuse(resolved.refusal);
  const tool = resolved.tool;

  const current = externalSchemaHash(tool);
  if (current !== input.schema_hash)
    return refuse(
      `MCP_SCHEMA_CHANGED: the declaration for ${installation.id}/${tool.name} changed since this caller read it (expected ${input.schema_hash}, current ${current}). ` +
        'Call mcp_tools for the current schema, then retry with arguments shaped for it.'
    );

  const cua = installation.id === CUA_SERVER_ID;

  // A generated external schema is validated before dispatch against that exact installation's
  // current declaration, so a caller cannot reach the server with arguments the server would
  // have rejected — or with constraints this connector deliberately composed in.
  const validation = cua ? validateEmbeddedCuaArguments(tool, input.arguments)
    : pluginManager.validateExternalArguments(installation.id, tool, input.arguments);
  if (!validation.ok) return refuse(`MCP_INVALID_ARGUMENTS: ${validation.detail}`);

  let identity: ManagedWorkerIdentity | null = null;
  if (cua) {
    const resolved = cuaIdentity();
    if ('refusal' in resolved) return resolved.refusal;
    identity = resolved.identity;
    const refusal = cuaCall(input.arguments, installation, identity);
    if (refusal) return refusal;
  }

  const generation = installation.generation;
  if (cua && identity) {
    try {
      acquireGuiLease(identity.workId);
    } catch (error) {
      if (error instanceof CuaBusyError)
        return refuse(
          `CUA_BUSY: work ${error.holderWorkId} currently holds the native desktop. Coding-only work can continue; retry desktop work after that work pauses, finishes or is cancelled.`
        );
      return refuse(`CUA_LEASE_FAILED: ${(error as Error).message}`);
    }
    if (isCuaSnapshotBoundTool(tool.name)) {
      const stale = assertCuaSnapshot(identity.workId, installation.id, generation, input.arguments);
      if (stale) return refuse(stale);
    }
  }

  // One in-flight count for the duration of the action, so a pause/cancel release waits for it.
  // The lease itself is NOT released here: it is held across observation → action → verification
  // and freed by the runtime on pause, cancel, completion or host shutdown. Releasing per call
  // would let a second work observe mid-sequence and invalidate this work's snapshot.
  const settled = cua && identity ? holdGuiAction(identity.workId) : null;
  try {
    // An external server's reply can carry resource and resource_link blocks, which the Core
    // result shape does not model. The manager already redacted it; only the delivered protocol
    // value keeps its full block set, exactly as the Plugins surface does.
    const wireArgs = cua && identity && 'session' in (tool.inputSchema.properties ?? {})
      ? { ...input.arguments, session: 'wga-' + createHash('sha256').update(identity.workId).digest('hex').slice(0, 24) }
      : input.arguments;
    if (cua && identity && !nativeAuthority(tool.name, identity))
      return refuse(`TOOL_DISABLED: ${tool.name} no longer has live native authority.`);
    const result = (cua
      ? await invokeEmbeddedCua(tool.name, wireArgs, { schemaHash: input.schema_hash, generation },
        async () => !!identity && nativeAuthority(tool.name, identity))
      : await pluginManager.callExternal(installation.id, tool.name, wireArgs,
        { schemaHash: input.schema_hash, generation })) as CallToolResult & ToolResult;
    if (cua && identity) {
      if (!nativeAuthority(tool.name, identity)) {
        consumeCuaObservation(identity.workId, installation.id);
        const withheld = fail('CUA_AUTHORITY_CHANGED: work identity or policy changed during native dispatch; result withheld.');
        return isCuaMutatingTool(tool.name) ? markExternalOutcomeUnknown(withheld) : withheld;
      }
      if (!result.isError) {
        if (isCuaObservationTool(tool.name)) noteCuaObservation(identity.workId, installation.id, generation, tool.name, result);
        else if (tool.name === 'verify_state') noteCuaVerification(identity.workId, installation.id, generation, input.arguments);
        else if (isCuaMutatingTool(tool.name)) consumeCuaObservation(identity.workId, installation.id);
      }
      // A reconnect mints a new transport, so every token and pixel frame from before it is
      // unusable. Detected by re-reading the installation, because the connection may have been
      // replaced while this call was in flight — the reply itself is real, but the provenance it
      // seemed to establish is not.
      const after = findInstallation(installation.id);
      if (after && after.generation !== generation) {
        noteCuaTransportGeneration(installation.id, after.generation);
        return {
          ...result,
          content: [...result.content, {
            type: 'text' as const,
            text: '\n--- Driver transport reconnected ---\nThe cua-driver proxy reconnected during this call, so element tokens and screenshot coordinates from before it are unusable. Take a fresh observation before the next action. Nothing was retried.'
          }]
        } as unknown as ToolResult;
      }
    }
    return result as unknown as ToolResult;
  } catch (error) {
    // A refusal raised before dispatch is a known-absent outcome; anything else was dispatched and
    // then lost, so the effect may have happened. Never reported as a plain failure in that case,
    // and never retried here.
    if (error instanceof ExternalNotDispatched) return refuse((error as Error).message);
    if (cua && identity && !nativeAuthority(tool.name, identity)) {
      consumeCuaObservation(identity.workId, installation.id);
      const withheld = fail('CUA_AUTHORITY_CHANGED: native authority changed after dispatch; driver error withheld. Inspect current state before another action.');
      return isCuaMutatingTool(tool.name) ? markExternalOutcomeUnknown(withheld) : withheld;
    }
    return markExternalOutcomeUnknown(fail(`MCP_CALL_FAILED: ${(error as Error).message}`));
  } finally {
    settled?.();
  }
}

/**
 * Identity for a native-CUA call, or the refusal that must be returned instead.
 *
 * The runtime's typed refusals (`STALE_AGENT_GENERATION`, `WORK_NOT_RUNNING`,
 * `WORKER_CONNECTION_REQUIRED`, `STATE_UNAVAILABLE`) are the answer here, not something to
 * translate: they name exactly why this caller may not touch the desktop, and the model can act
 * on them. Only the absence of a restored ledger becomes the gateway's own wording.
 */
function cuaIdentity(): { identity: ManagedWorkerIdentity } | { refusal: ToolResult } {
  try {
    return { identity: managedCallerFor(currentCall()) };
  } catch (error) {
    if (error instanceof ManagedCallerUnavailable) return { refusal: refuse(error.message) };
    const code = (error as { code?: unknown }).code;
    const message = (error as Error).message;
    return { refusal: refuse(typeof code === 'string' && code ? `${code}: ${message}` : message) };
  }
}

// ------------------------------------------------------------------- registration

export function registerExternalTools(reg: SurfaceRegistrar): void {
  reg.register('mcp_tools', {
    title: 'List external MCP servers and tools',
    description:
      'List the external MCP servers configured in this app, or one server\'s tools. ' +
      'With no arguments it returns each installation\'s stable server_id, status and tool count. ' +
      'With {server_id} it returns a paginated list of tool names, descriptions and annotations; ' +
      'pass the returned next_cursor to continue. With {server_id, tool} it returns that tool\'s ' +
      'complete input and output schema plus the schema_hash required by mcp_call. ' +
      'A tool name alone is never resolved to a server: two installations may declare the same name.',
    inputSchema: mcpToolsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async args => {
    try {
      return listTools(args);
    } catch (error) {
      return fail(`MCP_TOOLS_FAILED: ${(error as Error).message}`);
    }
  });

  reg.register('mcp_call', {
    title: 'Call an external MCP tool',
    description:
      'Call one tool on one configured external MCP server. Requires the installation\'s server_id, ' +
      'the exact tool name, its arguments, and the schema_hash from mcp_tools for that same tool. ' +
      'The call fails before dispatch if the installation is unknown or disabled, the tool is not ' +
      'declared, or the declaration changed since you read it. Bundled native desktop tools are ' +
      'available to a managed work\'s prime agent only, and its snapshot-bound actions require a fresh ' +
      'observation of the same target. This wrapper mutates; a failure after dispatch means the ' +
      'operation may already have taken effect, so inspect state before retrying.',
    inputSchema: mcpCallSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async args => runCall(args));
}
