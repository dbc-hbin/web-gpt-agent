import { currentCall, type CallContext } from './call-context.js';
import { fail, guard, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import {
  codeModeSchema,
  runCodeMode,
  waitCodeMode,
  CODE_MODE_LIMITS,
  CODE_MODE_MAX_OUTPUT_TOKENS,
  type CodeModeOptions,
  type CodeModeTool,
  type CodeModeWaitRequest
} from './code-mode-runtime.js';
import { toolDeclaration } from './tool-declarations.js';
import { z } from 'zod';
import type { SurfaceId } from './surfaces.js';
import { executionPrincipal } from '../codex/ownership.js';
import { getSession, conversationAttachment } from '../session/store.js';
import { requestCorrelation } from '../session/correlation.js';
import { isChatBlocked } from '../session/blocked-chats.js';
import { compactingConversation } from '../session/continuation.js';

/**
 * The connector half of code mode: the model-facing declarations, the trusted principal a cell is
 * bound to, and the conversion from this app's recorded result envelope to the native value a
 * script sees.
 *
 * Adapted from Codex 94174e44cbc54cece45f6052328ca0c2cd7a8a2a (code-mode protocol, the freeform
 * `apply_patch` spec, and per-tool `code_mode_result` conversions) and OMP's direct-tool/JS-bridge
 * partition. MCP uses object arguments, not freeform JS, and schemas are fetched selectively rather
 * than inlined into the prompt.
 */

/** The one tool this app publishes with a raw-string schema, exactly like upstream's freeform spec:
 * `apply_patch` takes patch text and never a `{patch: …}` object. */
const STRING_SCHEMA_TOOLS = new Set(['apply_patch']);

// Fixed by the host, never inferred from model code or external tool annotations.
const CORE_READ_TOOLS = new Set(['read', 'find', 'view_image', 'work_resume', 'mcp_tools']);

/** Facade-composed options: the connector's own surface plus the runtime's trusted hooks. */
export type CodeModeFacadeOptions = CodeModeOptions & {
  /** The surface whose tools this cell may call. Required: it is part of the owner namespace, so a
   * cell can never be observed, resumed, or made to act as another connector's caller, and it also
   * decides which result contract the script sees. */
  surface: SurfaceId;
};

export const waitSchema = z.object({
  cell_id: z.string().min(1).max(200).describe('The cell ID an exec result reported as still running.'),
  yield_time_ms: z.number().int().min(0).max(CODE_MODE_LIMITS.cellWallMs).optional()
    .describe('How long this wait observes the cell before returning what it produced so far.'),
  max_tokens: z.number().int().min(0).max(CODE_MODE_MAX_OUTPUT_TOKENS).optional()
    .describe('Optional output token budget; Core returns full output when omitted.'),
  terminate: z.boolean().optional().describe('Stop the cell instead of resuming it; its emitted output is returned.')
}).strict();

/**
 * The argument a nested call reaches its handler with.
 *
 * `apply_patch` is published as raw patch text — the upstream freeform contract — while this app's
 * patch handler takes its validated `{patch}` argument object, so the string is adapted here, at the
 * single boundary where a script's value becomes a handler argument. An object is refused rather
 * than quietly accepted: a compatibility shape would leave the obsolete `{patch: …}` calling
 * convention alive in the very place the model is told it does not exist.
 */
function nestedArguments(surface: SurfaceId, name: string, args: unknown): unknown {
  if (surface !== 'core' || !STRING_SCHEMA_TOOLS.has(name)) return args;
  if (typeof args === 'string') return { patch: args };
  throw new Error(`INVALID_ARGUMENTS: ${name} takes the raw patch string, not ${Array.isArray(args) ? 'an array' : typeof args}.`);
}

function nestedFailure(result: ToolResult): Error {
  const message = result.content
    .map(part => part.type === 'text' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
  return new Error(message || 'TOOL_FAILED: the nested tool returned an error without text.');
}

/**
 * Convert this connector's recorded result envelope into the value a script receives.
 *
 * Core returns apply_patch's committed change receipt as text. The terminal tools return their
 * structured object, `view_image` returns the upstream
 * `{image_url}` shape, and every other tool uses the upstream default conversion — its non-empty
 * text and media as data URLs, joined by newlines, falling back to its structured object only when
 * it has neither. A failed Core tool is thrown as a real JavaScript `Error` carrying the child's own
 * text, so a refusal can never read as a silent success.
 *
 * External MCP results are returned unchanged on every surface, including Core's own gateway:
 * upstream hands code mode the raw `CallToolResult`, whose `isError` is data the script inspects
 * rather than an exception, and whose content may carry blocks this app's envelope does not model.
 * The Desktop and Plugins connectors likewise keep their raw envelope.
 */
export function codeModeNestedResult(surface: SurfaceId, name: string, result: ToolResult): unknown {
  if (surface !== 'core' || name === 'mcp_call') return result;
  if (result.isError) throw nestedFailure(result);
  if (name === 'find') {
    if (!result.structuredContent) throw new Error('FIND_INVALID_RESULT: search page was missing its structured result.');
    return result.structuredContent;
  }
  if (name === 'exec_command' || name === 'write_stdin') {
    // Return the terminal producer's structured result unchanged. Its output includes any
    // corrective notes the producer appended, so code mode does not need a second channel.
    if (!result.structuredContent) {
      throw new Error(`${name.toUpperCase()}_INVALID_RESULT: terminal output was missing its structured result.`);
    }
    return result.structuredContent;
  }
  if (name === 'view_image') {
    const image = result.content.find(part => part.type === 'image');
    if (!image || image.type !== 'image') throw new Error('VIEW_IMAGE_INVALID_RESULT: image output was missing.');
    return { image_url: `data:${image.mimeType};base64,${image.data}` };
  }
  const body = result.content
    .map(part => part.type === 'text' ? part.text : `data:${part.mimeType};base64,${part.data}`)
    .filter(value => value.trim().length > 0)
    .join('\n');
  return body || result.structuredContent || '';
}

/**
 * The durable session behind a principal, when one is proved.
 *
 * A request principal is the same caller as its session, but only once the page has reported that
 * exact join; before then it stays its own identity, so an unproved request can never be treated as
 * the session it merely claims to belong to.
 */
function sessionPrincipalOf(principal: string): string | null {
  const REQUEST_PREFIX = 'request:';
  if (!principal.startsWith(REQUEST_PREFIX)) return principal;
  const requestId = principal.slice(REQUEST_PREFIX.length);
  return requestId ? requestCorrelation(requestId)?.sessionId ?? null : null;
}

function splitOwner(owner: string): { surface: string; principal: string } | null {
  const separator = owner.indexOf(':');
  if (separator <= 0 || separator === owner.length - 1) return null;
  return { surface: owner.slice(0, separator), principal: owner.slice(separator + 1) };
}

/**
 * Whether a cell's recorded owner may be observed by this caller.
 *
 * Never a literal string comparison: the same chat proves itself as a request principal first and as
 * its durable session once the page reports the join, so both spellings of one caller must match,
 * while two different chats that merely share a session id never do. Different surfaces never match.
 */
function canAccessOwner(storedOwner: string, requestedOwner: string): boolean {
  const stored = splitOwner(storedOwner);
  const requested = splitOwner(requestedOwner);
  if (!stored || !requested || stored.surface !== requested.surface) return false;
  return (sessionPrincipalOf(stored.principal) ?? stored.principal) ===
    (sessionPrincipalOf(requested.principal) ?? requested.principal);
}

/** Promotes a request principal to its durable session once that join has been proved. */
function resolveOwner(owner: string): string {
  const parsed = splitOwner(owner);
  if (!parsed) return owner;
  const sessionId = sessionPrincipalOf(parsed.principal);
  return sessionId ? `${parsed.surface}:${sessionId}` : owner;
}

/**
 * What this call was proven to be, in the shape a cell is bound to.
 *
 * The source conversation and session are read from this invocation's own exact proof — the
 * correlation registry entry for the request id this call arrived with — and are frozen the moment
 * that proof lands. They are never re-derived from whichever chat later waits on the cell, and never
 * inferred from a session's current attachment: a successor that reuses the same durable session
 * must not be able to retarget a stale cell, and a chat that was stopped or replaced must stay that
 * way. Until proof lands the cell simply has no durable source, and is covered by the runtime's
 * per-conversation interruption hooks.
 *
 * `retiredAt` is the durable departure time this session recorded when the frontend was replaced.
 * A cell whose invocation began at or before that moment belongs to the chat that no longer exists,
 * so it cannot be revived merely because a later proof reports that same conversation id again.
 */
interface SourceAuthority {
  surface: SurfaceId;
  requestId: string | null;
  startedAt: number;
  /** Initial trusted principal; composed once and never re-derived from a successor chat. */
  principal: string | null;
  source: { sessionId: string | null; conversationId: string | null } | null;
}

function sourceAuthority(parent: CallContext, surface: SurfaceId): SourceAuthority {
  const requestId = parent.caller.requestId;
  const sessionId = parent.caller.sessionId ?? null;
  const conversationId = parent.caller.conversationId;
  return {
    surface,
    requestId,
    startedAt: parent.startedAt,
    principal: executionPrincipal(requestId, sessionId, parent.allowUnattributed === true),
    source: sessionId || conversationId ? { sessionId, conversationId } : null
  };
}

/** This call's own proof, resolved at most once and then frozen. */
function resolvedSource(authority: SourceAuthority): { sessionId: string | null; conversationId: string | null } | null {
  if (authority.source) return authority.source;
  const exact = authority.requestId ? requestCorrelation(authority.requestId) : null;
  if (!exact) return null;
  authority.source = { sessionId: exact.sessionId, conversationId: exact.conversationId };
  return authority.source;
}

/**
 * Whether the chat that started this cell may still act.
 *
 * This is the authority the kernel already enforces for direct calls, applied to a cell that can
 * outlive the request that created it: the user's block, an in-flight compaction, and a session
 * whose frontend has been replaced all end the cell's right to dispatch, store, or emit. The
 * attachment rule is deliberately the kernel's own — refused when superseded, not when merely
 * unproven — because an unplaceable caller, a phone and a headless client are all legitimate here,
 * and a stricter rule would refuse exactly the callers this connector exists to serve.
 *
 * The one case the attachment rule cannot see is a cell whose source was proved only after its chat
 * had already been replaced, because a later proof of that same conversation id would look current
 * again. `retiredAt` closes it from the durable record: a chat this session has already left cannot
 * authorize a cell whose invocation began while it was still there.
 */
function sourceIsActive(authority: SourceAuthority): () => Promise<boolean> {
  return async () => {
    const source = resolvedSource(authority);
    const conversation = source?.conversationId ?? null;
    if (!conversation) return true;
    if (isChatBlocked(conversation)) return false;
    if (compactingConversation(conversation)) return false;
    const session = source?.sessionId ? await getSession(source.sessionId) : null;
    const retiredAt = session?.retiredChatAt?.[conversation];
    if (typeof retiredAt === 'number' && authority.startedAt <= retiredAt) return false;
    return (await conversationAttachment(conversation, source?.sessionId ?? null)) !== 'superseded';
  };
}

function facadeOptions(parent: CallContext, options: CodeModeFacadeOptions): CodeModeFacadeOptions {
  const authority = sourceAuthority(parent, options.surface);
  return {
    ...options,
    fullOutputByDefault: options.surface === 'core',
    skipEmittedByteLimits: options.surface === 'core',
    owner: authority.principal ? `${authority.surface}:${authority.principal}` : undefined,
    resolveOwner,
    canAccessOwner,
    conversationId: () => resolvedSource(authority)?.conversationId ?? null,
    lifecycle: { isActive: sourceIsActive(authority) },
    onNotify: parent.notify,
    onTruncatedOutput: content => { parent.recordingContent = content; }
  };
}

/** The nested-result contract, which is per surface: Core returns native values, the other
 * connectors their raw MCP envelope. Everything a script must know about namespaces, output helpers,
 * limits and lifecycle beyond this is carried by the connector's own instructions, so the published
 * description stays the small per-tool contract discovery actually needs. */
function resultContract(surface: SurfaceId): string {
  return surface === 'core'
    ? 'Nested results are native values: apply_patch takes one raw patch string and returns a change receipt with bounded numbered post-edit previews when Read is enabled; exec_command and write_stdin return their structured object, view_image returns {image_url}, other tools return their text, and mcp_call returns the external server’s raw CallToolResult. A failed Core tool throws an Error carrying its own message.'
    : 'Nested results are this connector’s raw MCP CallToolResult objects: inspect content, structuredContent and isError yourself. isError is data, not a thrown error.';
}

const MCP_RETRY_GUIDANCE = "Read the actual MCP error before retrying: invalid arguments, identity or permission refusal, command failure, provider security rejection and uncertain delivery are different outcomes. For either OpenAI response — blocked by the safety check, or blocked because the request's security status could not be determined — recheck the discovered schema, narrow the request to one relevant tool and exact paths or selectors, or specify the exact command, workdir and arguments, then retry the corrected operation. A nonzero command exit alone does not prove a connector failure or an OpenAI security block.";

export const codeModeDeclaration = (options: CodeModeFacadeOptions) => toolDeclaration('exec', () => ({
  title: 'Run JavaScript',
  description: 'Run JavaScript with top-level await. Call this connector’s tools by name: await tools["name"](value)' +
    (options.surface === 'core' ? ', one argument object for an object schema or the raw string for a string schema' : '') + '. ' +
    resultContract(options.surface) +
    ' A script that exceeds one call’s window yields a cell; continue it with wait. ' + MCP_RETRY_GUIDANCE,
  inputSchema: codeModeSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}), options.surface);

export const codeModeReadDeclaration = (options: CodeModeFacadeOptions) => toolDeclaration('exec_read', () => ({
  title: 'Read with JavaScript',
  description: 'Run JavaScript with top-level await using only Core read, find, view_image, work_resume, and mcp_tools. No shell or mutation is available. Nested read results are text, view_image returns {image_url}, and failures throw Error. Emit text(), image(), audio() or notify(); a yielded cell continues through wait. ' + MCP_RETRY_GUIDANCE,
  inputSchema: codeModeSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}), options.surface);

export const waitDeclaration = (options: CodeModeFacadeOptions) => toolDeclaration('wait', () => ({
  title: 'Continue a running script',
  description: 'Observe or stop a running JavaScript cell. Pass the cell_id an exec or exec_read result reported; the result carries output produced since the last call and the cell’s current status. Only its own chat may wait on it; nested wait is refused.',
  inputSchema: waitSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}), options.surface);

export function codeModeHandler(
  getTools: () => CodeModeTool[],
  invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>,
  options: CodeModeFacadeOptions,
  readOnly = false
): (args: { code: string }) => Promise<ToolResult> {
  const wrapper = readOnly ? 'exec_read' : 'exec';
  return ({ code }) => guard(wrapper, async () => {
    const parent = currentCall();
    // Code mode is a way to call this connector's own tools, so it needs a call — not a *proven*
    // caller. Requiring exact chat/session proof here made the whole coding surface depend on the
    // browser bridge being connected and able to place the request; every child call still passes
    // through the same dispatch, permissions and sandbox as a direct call would.
    if (!parent) {
      return fail('EXEC_CONTEXT_UNAVAILABLE: this call did not arrive through the connector, so no JavaScript or nested tool ran.');
    }
    const facade = facadeOptions(parent, options);
    // The owning connector supplies only backend tools. A plugin named exec is a backend
    // function, not a recursive call to this wrapper, and must not be silently removed.
    return runCodeMode(
      code,
      getTools().filter(tool => !readOnly || CORE_READ_TOOLS.has(tool.name))
        .map(({ name, description }) => ({ name, description })),
      async (name, args) => {
        // The callback belongs to this cell, including after yield/wait or another writable exec.
        // Check again at dispatch, not just when exposing names to the worker.
        if (readOnly && !CORE_READ_TOOLS.has(name)) throw new Error('READ_ONLY_TOOL: this tool is not available in exec_read. No action was taken.');
        return codeModeNestedResult(facade.surface, name, await invoke(name, nestedArguments(facade.surface, name, args), parent));
      },
      CODE_MODE_LIMITS,
      facade
    );
  });
}

export function codeModeWaitHandler(options: CodeModeFacadeOptions): (args: CodeModeWaitRequest) => Promise<ToolResult> {
  return request => guard('wait', async () => {
    const parent = currentCall();
    if (!parent) {
      return fail('EXEC_CONTEXT_UNAVAILABLE: this call did not arrive through the connector, so no cell was observed.');
    }
    return waitCodeMode(request, facadeOptions(parent, options));
  });
}

export function registerCodeMode(
  reg: SurfaceRegistrar,
  invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>,
  options: CodeModeFacadeOptions,
  getTools: () => CodeModeTool[] = () => reg.descriptions()
    .filter(tool => tool.name !== 'exec' && tool.name !== 'exec_read' && tool.name !== 'wait' && tool.name !== 'session_finish')
): void {
  reg.register('exec', codeModeDeclaration(options), codeModeHandler(getTools, invoke, options));
  if (options.surface === 'core') {
    reg.register('exec_read', codeModeReadDeclaration(options), codeModeHandler(getTools, invoke, options, true));
  }
  reg.register('wait', waitDeclaration(options), codeModeWaitHandler(options));
}

export const CODE_MODE_INSTRUCTIONS = `Discover schemas with tools_search; on Core, prefer exec_read for read, find, view_image, work_resume and mcp_tools, and exec for everything else. Desktop and Plugins use exec. Call via the selected wrapper: await tools["name"](value). Pass apply_patch one raw patch string; other object-schema tools take objects. Continue a yielded cell only through outer wait; nested exec and wait refuse. Call agents, work and session_finish directly, never inside exec. Emit concise text(...), image(...), audio(...) or notify(...); notify is also delivered in the next exec/wait result. Use operation_id only where its discovered object schema includes it. A failed call may have acted: inspect state before retrying; never replay a script blindly.`;
