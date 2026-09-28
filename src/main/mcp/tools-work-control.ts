/**
 * Direct work control: the lifecycle of durable coding work, from any authenticated client.
 *
 * The connector's transport authentication is the authority here, and it is the whole of it. These
 * operations do not go through `exec`, do not need a managed-worker binding, and do not need a
 * browser page, a proven conversation or a session projection: `start` names the project it is
 * starting in, and `status`, `instruct` and `control` name the work they are about. A phone, a
 * scheduled run and a chat that has never run work can all drive work on this Mac.
 *
 * The caller's own conversation is *optional diagnostics*. When the page has said which conversation
 * issued this call and which user message it answers, that is used for two things and neither is
 * admission:
 *
 *  - **Dedup.** Where the relay could ever deliver that message — a conversation already bound to a
 *    work, or a `start`, which is about to bind the conversation that asked for the work — the
 *    message's inbox row is claimed, so the automatic relay joins this admission instead of
 *    delivering the same message a second time as its own instruction. A claim that cannot be
 *    established is not a refusal: the call runs, and the ledger's own request-id idempotency is
 *    what answers a later relay under the same bytes.
 *  - **Attribution.** The call is recorded against that conversation's turn, exactly as every other
 *    tool is.
 *
 * A `start` also makes the asking conversation the work's controller when it has no binding yet, so
 * the work's reports come back to the chat that asked for it. That is a convenience the metadata
 * enables, never a condition on the start.
 *
 * Everything durable stays durable: the service's `request_id` idempotency is unchanged, so a retry
 * of the same call returns the receipt the first attempt committed, and a reused id with different
 * bytes is `REQUEST_ID_CONFLICT`.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  WORK_RESPONSE_MAX_BYTES,
  workControlSchema,
  workErrorPayload,
  workEventsRequestSchema,
  workInstructionSchema,
  workListSchema,
  workStartSchema,
  workStatusRequestSchema
} from '../../shared/work.js';
import { getConfig } from '../config.js';
import { resolvePath, SandboxError } from '../sandbox.js';
import { logWarn } from '../logger.js';
import {
  bindWorkController,
  claimWorkControllerTurn,
  completeWorkControllerTurnClaim,
  controllerRequestId,
  getWorkControllerBinding,
  releaseWorkControllerTurnClaim,
  workCommandReceipt,
  workControllerReservation
} from '../work/continuity.js';
import type { WorkControllerMessage } from '../../shared/work-continuity.js';
import { requestCorrelation } from '../session/correlation.js';
import { getSession, readUserMessageByMessageId } from '../session/store.js';
import { recordToolCall } from '../session/recorder.js';
import { emptyEvidence, runInCallContext, type CallContext } from './call-context.js';
import { noteWorkControl } from './connector-evidence.js';
import { beginToolTiming, inboundPublication, inboundRequestId } from './inbound.js';
import { fail, guard, noteSurfaceToolCall, ok, type ToolAnnotations, type ToolContext, type ToolResult } from './kernel.js';
import { toolSchema } from './tool-declarations.js';

export const WORK_CONTROL_TOOL_NAMES = ['work'] as const;

// Reuse the service's contracts, including request-id idempotency and recovery decisions.
// No permissive action-dependent bag of optional arguments and no second service schema.
const workSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), input: workStartSchema }).strict(),
  z.object({ action: z.literal('list'), input: workListSchema }).strict(),
  z.object({ action: z.literal('status'), input: workStatusRequestSchema }).strict(),
  z.object({ action: z.literal('instruct'), input: workInstructionSchema }).strict(),
  z.object({ action: z.literal('control'), input: workControlSchema }).strict(),
  z.object({ action: z.literal('events'), input: workEventsRequestSchema }).strict()
]);

type WorkControlRequest = z.infer<typeof workSchema>;
/** The three work-changing actions, narrowed once so every admission below is exhaustive. */
type MutationRequest = Extract<WorkControlRequest, { action: 'start' | 'instruct' | 'control' }>;

/** Whether one request changes durable work. Reading status/list/events never does. */
function mutatesWork(request: WorkControlRequest): request is MutationRequest {
  return request.action === 'start' || request.action === 'instruct' || request.action === 'control';
}

/** Whether one request needs command execution and file editing to be permitted at all. */
function launchesWork(request: MutationRequest): boolean {
  return request.action === 'start' || request.action === 'instruct' ||
    (request.action === 'control' && request.input.action === 'resume');
}

/** The public work-command request id this call names, or null for a read that names none. */
function requestIdOf(request: WorkControlRequest): string | null {
  return request.action === 'list' || request.action === 'events' || request.action === 'status'
    ? null
    : request.input.request_id;
}

// --------------------------------------------------------------------------- caller metadata

/**
 * What the page has said about the conversation that issued one call, or null.
 *
 * Read from the same two places every other tool reads it from — the connector's own request id and
 * the page's evidence for that exact id — and used only for the dedup and attribution described at
 * the top of this file. An absent, unproven or contradictory sighting is simply `null`: it is not a
 * refusal, and it never leaves a call waiting for a projection to arrive.
 */
interface CallerMetadata {
  sessionId: string;
  conversationId: string;
  messageId: string;
  text: string;
  authoredAt: number;
}

async function callerMetadata(requestId: string | null): Promise<CallerMetadata | null> {
  if (!requestId) return null;
  const correlation = requestCorrelation(requestId);
  if (!correlation || correlation.questionConflict === true || !correlation.questionId) return null;
  const session = await getSession(correlation.sessionId).catch(() => null);
  // The session must still front the conversation the request was seen in. A chat that moved on
  // (Compact & Resume) is a different frontend, so its old metadata describes nothing useful.
  if (!session || session.conversationId !== correlation.conversationId) return null;
  const event = await readUserMessageByMessageId(session.id, correlation.questionId).catch(() => null);
  if (!event) return null;
  return {
    sessionId: session.id,
    conversationId: correlation.conversationId,
    messageId: correlation.questionId,
    text: event.message.text,
    authoredAt: event.authoredAt ?? event.time
  };
}

// --------------------------------------------------------------------------- handler

async function runControl(args: unknown, liveContext: () => ToolContext): Promise<ToolResult> {
  noteSurfaceToolCall('core');
  const markTiming = beginToolTiming();
  try {
    const parsed = workSchema.safeParse(args);
    if (!parsed.success) {
      const payload = workErrorPayload(parsed.error);
      return fail(`${payload.code}: ${payload.message}`);
    }
    const request = parsed.data;
    const live = liveContext();
    if (!live.workService) return fail('WORK_SERVICE_UNAVAILABLE: the durable work service is unavailable. No work was started or changed. Wait for the app to finish restoring its work database.');
    if (mutatesWork(request) && launchesWork(request)) {
      if (live.readOnly || getConfig().readOnly) return fail('TOOL_DISABLED: Read-only mode prevents starting, instructing or resuming coding work. Status, events, pause and cancel remain available.');
      if (!live.caps.command || !live.caps.edit) return fail('TOOL_DISABLED: starting, instructing or resuming coding work requires command execution and file editing permissions. No work was changed.');
    }
    // Optional, and read before the side effect because it is used for the inbox claim that dedups
    // this call against the automatic relay. Absence costs the dedup and nothing else.
    const metadata = mutatesWork(request) ? await callerMetadata(inboundRequestId()) : null;
    const result = await guard('work', () =>
      mutatesWork(request)
        ? runMutation(request, live, metadata, inboundRequestId())
        : runAction(request, live, null));
    if (!result.isError) noteWorkControl();
    return result;
  } finally {
    markTiming('handler');
  }
}

/**
 * One work change: optional controller dedup, the action itself, and the bookkeeping it owes.
 *
 * The order is the contract. The inbox claim (when there is one) is taken before the side effect so
 * the relay sees the reservation and leaves the message alone; the action runs under the claim's own
 * request id when this call is the first owner of that message, so a native call and the relay name
 * one admission; and the claim is completed or released immediately after, because holding it would
 * make the user's own instruction wait for an admission that is not coming.
 */
async function runMutation(
  request: MutationRequest,
  live: ToolContext,
  metadata: CallerMetadata | null,
  ingressRequestId: string | null
): Promise<ToolResult> {
  const publicRequestId = requestIdOf(request);
  const claim = metadata ? claimControllerMessage(request, metadata, publicRequestId) : null;
  const owned = claim !== null && claim.request_id === publicRequestId;
  // A row the *relay* already took. The automatic relay names this message by its derived id, so a
  // row carrying that id was admitted by the relay rather than by a call like this one: this call
  // joins that receipt instead of admitting the same message a second time under a different
  // payload. The row is never released here; it belongs to the admission that owns it.
  if (metadata && claim && !owned && claim.request_id === controllerRequestId(metadata.sessionId, metadata.messageId)) {
    const receipt = workCommandReceipt(claim.request_id);
    recordWorkControlCall(request, metadata, ingressRequestId, receipt === null ? 'tool_rejected' : 'ok');
    return receipt
      ? ok(JSON.stringify(receipt))
      : fail('WORK_ADMISSION_PENDING: this exact message is already durably held by the automatic relay for this conversation and has not produced its receipt yet.');
  }
  const result = await runAction(request, live, owned && claim ? claim.request_id : null);
  if (owned && claim && metadata) {
    const workId = receiptWorkId(result);
    if (workId) completeWorkControllerTurnClaim({ sessionId: metadata.sessionId, messageId: metadata.messageId, workId });
    else releaseWorkControllerTurnClaim({
      sessionId: metadata.sessionId,
      messageId: metadata.messageId,
      error: 'the controller conversation could not admit this message; the relay may'
    });
  }
  if (metadata) recordWorkControlCall(request, metadata, ingressRequestId, result.isError ? 'tool_rejected' : 'ok');
  // A start the asking conversation is not bound to yet makes that conversation the work's
  // controller, so the work's reports come back to the chat that asked for it. `bindWorkController`
  // remains the one authority on whether that binding may exist.
  if (request.action === 'start' && metadata && !result.isError) await claimStartedWork(metadata, result);
  return result;
}

/**
 * Reserves one controller message for this call, or returns null.
 *
 * Deliberately not a precondition: the claim exists so the relay joins this admission rather than
 * duplicating the message. It is taken only where the relay could ever deliver that message — a
 * conversation already bound to a work, or a `start`, which is about to bind the conversation that
 * asked for the work. An instruction or control from a chat that drives nothing leaves no inbox row
 * behind, because nothing would ever consume one.
 *
 * A message the page has not placed, or an inbox row that cannot be written, therefore costs the
 * dedup and nothing else: the call proceeds, and the service's own request-id idempotency is what
 * answers a later relay under the same bytes.
 */
function claimControllerMessage(
  request: MutationRequest,
  metadata: CallerMetadata,
  publicRequestId: string | null
): WorkControllerMessage | null {
  if (request.action !== 'start' && getWorkControllerBinding(metadata.sessionId) === null) return null;
  return claimWorkControllerTurn({
    sessionId: metadata.sessionId,
    conversationId: metadata.conversationId,
    messageId: metadata.messageId,
    text: metadata.text,
    authoredAt: metadata.authoredAt,
    workId: request.action === 'start' ? null : request.input.work_id,
    // The caller's own application request id, kept when this call is the first to claim the
    // message. A later caller for the same message is told the id the row already owns, which is
    // what makes this call and the automatic relay one admission instead of two.
    requestId: publicRequestId
  });
}

/**
 * Makes the conversation that asked for a new work its controller.
 *
 * A start is explicit new-start authority for the work it just created, and without this the only
 * binding would be the execution prime's — the chat that asked would never receive the work's
 * reports and could not continue it after completion.
 *
 * Who may be displaced is not decided here. `bindWorkController` is the one authority on binding
 * identity: it refuses a controller a person chose, and it performs the single automatic handover —
 * the prime fallback's own binding, for a work whose requesting session holds no enabled binding of
 * its own, which is the crash-recovery shape. A binding this conversation already has is left
 * exactly as it is, so a start never moves an existing controller onto the work it created.
 */
async function claimStartedWork(metadata: CallerMetadata, result: ToolResult): Promise<void> {
  const workId = receiptWorkId(result);
  if (!workId) return;
  if (getWorkControllerBinding(metadata.sessionId)) return;
  bindStartBinding({ sessionId: metadata.sessionId, conversationId: metadata.conversationId, workId });
}

/**
 * Attempts the one binding a start owes its own conversation.
 *
 * The check is synchronous and immediately before the call: a person can bind this conversation — or
 * another controller can appear for this work — while the action awaited, and a binding that exists
 * by then is a decision this start does not get to override. A failed write is reported, not retried
 * into existence: the binding is a convenience of the start, and the user can always connect the
 * chat from the app.
 */
function bindStartBinding(intent: { sessionId: string; conversationId: string; workId: string }): void {
  // Any binding this conversation already holds wins, enabled or not: a disabled row is a decision,
  // and a start must not answer it by creating a fresh enabled one.
  const existing = getWorkControllerBinding(intent.sessionId);
  if (existing) return;
  // The one recovery a start may perform, and the only reason it is allowed to move a binding at
  // all: the runtime's automatic prime fallback reached this work first — a crash between the
  // receipt and the fallback's own handover, or a prime conversation that was replaced — and the
  // conversation that asked for the work holds no binding of its own. It is an *explicit original
  // start*, never an implicit handover.
  const reservation = workControllerReservation(intent.workId);
  if (reservation && reservation.session_id !== intent.sessionId) {
    // The slot is taken by somebody else: a binding a person disabled, or another controller that
    // already stands. Either is a decision about this work, and a start does not answer it.
    if (!reservation.enabled || reservation.origin === 'explicit') return;
  }
  const recovering = !!reservation && reservation.session_id !== intent.sessionId &&
    reservation.origin === 'automatic' && reservation.enabled && reservation.work_id === intent.workId;
  try {
    bindWorkController({
      sessionId: intent.sessionId,
      conversationId: intent.conversationId,
      workId: intent.workId,
      // The controller is the *original* conversation, so its binding is an explicit one: `automatic`
      // is reserved for the prime fallback, and marking this the same way would let a later recovery
      // treat the real controller as a disposable prime.
      origin: 'explicit',
      ...(recovering ? { takeover: true } : {})
    });
  } catch (error) {
    logWarn(`work control: the started work's controller binding could not be written: ${(error as Error).message}`);
  }
}

/**
 * Runs one action against the service.
 *
 * `claimRequestId` is the durable id this admission must use when the message's own turn claimed
 * one — the first owner's id, so a native call and the relay name one admission. It is null for a
 * call that is not a claimed controller turn, which keeps the caller's own id exactly.
 */
async function runAction(
  request: WorkControlRequest,
  live: ToolContext,
  claimRequestId: string | null
): Promise<ToolResult> {
  const service = live.workService;
  if (!service) return fail('WORK_SERVICE_UNAVAILABLE: the durable work service is unavailable. No work was started or changed.');
  try {
    const withClaim = <T extends { request_id: string }>(input: T): T =>
      claimRequestId ? { ...input, request_id: claimRequestId } : input;
    let payload: unknown;
    switch (request.action) {
      case 'start': {
        // Do not swallow sandbox rejection and fall back to an unapproved native path.
        // Enforce this at the remote MCP boundary; local CLI/service authority is unchanged.
        const project = await resolvePath(live.roots, request.input.project_path, { fileAccessMode: getConfig().fileAccessMode });
        payload = await service.start({ ...withClaim(request.input), project_path: project.real });
        break;
      }
      case 'list': payload = await service.list(request.input); break;
      case 'status': payload = await service.status(request.input); break;
      case 'instruct': payload = await service.instruct(withClaim(request.input)); break;
      case 'control': payload = await service.control(withClaim(request.input)); break;
      case 'events': payload = await service.events(request.input); break;
    }
    const text = JSON.stringify(payload) ?? 'null';
    if (Buffer.byteLength(text, 'utf8') > WORK_RESPONSE_MAX_BYTES) {
      // An action may already have committed. Never return malformed, silently clipped JSON or
      // suggest replaying a mutation just to recover its response.
      return fail('WORK_RESPONSE_TOO_LARGE: the result exceeded the response limit. The action may already have completed; inspect work status or request fewer list/events entries.');
    }
    return ok(text);
  } catch (error) {
    if (error instanceof SandboxError) return fail(`PROJECT_PATH_INVALID: ${error.message} No work was started.`);
    const payload = workErrorPayload(error);
    return fail(`${payload.code}: ${payload.message}`);
  }
}

/** The work id a successful action's own receipt names, or null. */
function receiptWorkId(result: ToolResult): string | null {
  if (result.isError) return null;
  const text = result.content.find((part): part is Extract<ToolResult['content'][number], { type: 'text' }> => part.type === 'text')?.text;
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && typeof (parsed as { work_id?: unknown }).work_id === 'string'
      ? (parsed as { work_id: string }).work_id
      : null;
  } catch {
    return null;
  }
}

/**
 * Records one work-control call against its conversation's turn lifecycle.
 *
 * This is not bookkeeping for its own sake: it is what keeps a late call attributable after the page
 * has reported the turn over, and it is the same recorder every other tool goes through, so nothing
 * here invents a second attribution path. A call whose conversation the page has not placed has
 * nothing to record against, and simply is not recorded.
 */
function recordWorkControlCall(
  request: MutationRequest,
  metadata: CallerMetadata,
  ingressRequestId: string | null,
  outcome: 'ok' | 'tool_rejected'
): void {
  if (!ingressRequestId) return;
  const context: CallContext = {
    publication: inboundPublication() ?? { completedAt: null, failed: false },
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: ingressRequestId, conversationId: metadata.conversationId, sessionId: metadata.sessionId },
    outcome: null,
    evidence: emptyEvidence()
  };
  void runInCallContext(context, () => recordToolCall({
    tool: 'work',
    args: request.input,
    content: [{ type: 'text', text: `work ${request.action}` }],
    outcome,
    durationMs: 0,
    startedAt: context.startedAt,
    evidence: context.evidence,
    requestId: ingressRequestId,
    conversationId: metadata.conversationId,
    sessionId: metadata.sessionId
  })).catch(() => undefined);
}

export function registerWorkControlTools(
  server: McpServer,
  ctx: ToolContext,
  observe?: (name: string, config: { title?: string; description: string; inputSchema: z.ZodType; annotations?: ToolAnnotations }) => void,
  liveContext: () => ToolContext = () => ctx
): string[] {
  const declaration = {
    title: 'Manage coding work',
    description: 'Start, list, inspect, instruct or control durable coding work, or read its events. Use {action,input}; input follows the selected action schema. No worker, browser page or attached conversation is needed: start names the project, and status/instruct/control/events name the work_id they are about. Mutations reuse request_id only for an identical retry. control input.action is pause, resume or cancel.',
    inputSchema: workSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  };
  server.registerTool('work', { ...declaration, inputSchema: toolSchema(workSchema) }, args => runControl(args, liveContext));
  observe?.('work', declaration);
  return [...WORK_CONTROL_TOOL_NAMES];
}
