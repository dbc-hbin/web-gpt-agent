import { z } from 'zod';
import { REASONING_EFFORTS } from './session.js';

/**
 * The durable work contract, shared by every interface.
 *
 * A "work" is a coding task with an identity that does not depend on any conversation or
 * window: the GUI, the CLI over the control socket, and the MCP tools all parse these same
 * schemas and call the same WorkService. Nothing in this module touches the filesystem or a
 * database, so the renderer can import it for its own types.
 *
 * Two vocabularies are deliberately different here:
 *
 * - `WorkState` is the factual lifecycle and is a closed set. Every interface switches on it.
 * - `WorkAgentState` and event `kind` are open machine-readable strings. The ledger stores
 *   whatever the runtime knows (an upstream broker state, a new recovery phase) without this
 *   module having to ship a new release to name it. The canonical values this app writes are
 *   exported as constants below.
 */

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The eight factual states. `blocked` is never success and always carries a reason. */
export const WORK_STATES = [
  'queued',
  'starting',
  'running',
  'recovering',
  'paused',
  'blocked',
  'completed',
  'cancelled'
] as const;
export const workStateSchema = z.enum(WORK_STATES);
export type WorkState = z.infer<typeof workStateSchema>;

/**
 * A committed intent that has not finished yet.
 *
 * Pause and cancel first fence admission and record the desired state, then drain; the
 * factual `status` stays true to what is happening on disk until the drain settles. `resume`
 * clears the field.
 */
export const WORK_DESIRED_STATES = ['paused', 'cancelled'] as const;
export const workDesiredStateSchema = z.enum(WORK_DESIRED_STATES);
export type WorkDesiredState = z.infer<typeof workDesiredStateSchema>;

export const WORK_ACTIONS = ['pause', 'resume', 'cancel'] as const;
export const workActionSchema = z.enum(WORK_ACTIONS);
export type WorkAction = z.infer<typeof workActionSchema>;

export const WORK_COMMAND_KINDS = ['start', 'instruct', 'control'] as const;
export type WorkCommandKind = (typeof WORK_COMMAND_KINDS)[number];

/**
 * Delivery states of a durably recorded command.
 *
 * `queued` and `unknown` are the two states a *send that is not an acknowledgement* produces,
 * and they are deliberately not `delivered`: the outbox holds the message but the conversation
 * has not taken it yet (`queued`), or the hand-off itself is ambiguous (`unknown`). Both stay in
 * the delivery pump's work list so the real outbox row can be reconciled on a later tick — a
 * `delivered` row is never sent again.
 */
export const WORK_DELIVERY_STATES = [
  'pending',
  'delivering',
  'queued',
  'unknown',
  'delivered',
  'failed',
  'cancelled'
] as const;
export type WorkDeliveryState = (typeof WORK_DELIVERY_STATES)[number];

/** Canonical agent lifecycle values. The column itself is an open string. */
export const WORK_AGENT_STATES = ['pending', 'active', 'blocked', 'finished', 'failed'] as const;

/** Agent roles inside one work. There is exactly one `prime` per work. */
export const WORK_AGENT_ROLES = ['prime', 'worker'] as const;
export const workAgentRoleSchema = z.enum(WORK_AGENT_ROLES);
export type WorkAgentRole = z.infer<typeof workAgentRoleSchema>;

/** Operation states, mirrored from the runtime's mutation ledger. */
export const WORK_OPERATION_STATES = ['prepared', 'running', 'completed', 'failed', 'outcome_unknown'] as const;
export type WorkOperationState = (typeof WORK_OPERATION_STATES)[number];

export const WORK_OPERATION_DECISIONS = ['accept_observed_effects', 'authorize_retry'] as const;
export type WorkOperationDecision = (typeof WORK_OPERATION_DECISIONS)[number];

/** Event kinds this service writes. Other kinds may appear; they are open strings. */
export const WORK_EVENT_KINDS = {
  workQueued: 'work_queued',
  workStarting: 'work_starting',
  workStarted: 'work_started',
  workRunning: 'work_running',
  workRecovering: 'work_recovering',
  workBlocked: 'work_blocked',
  workUnblocked: 'work_unblocked',
  workCompleted: 'work_completed',
  pauseRequested: 'work_pause_requested',
  paused: 'work_paused',
  cancelRequested: 'work_cancel_requested',
  cancelled: 'work_cancelled',
  resumed: 'work_resumed',
  instructionQueued: 'instruction_queued',
  instructionDelivered: 'instruction_delivered',
  instructionDeliveryQueued: 'instruction_delivery_queued',
  instructionDeliveryUnknown: 'instruction_delivery_unknown',
  instructionDeliveryFailed: 'instruction_delivery_failed',
  /** A completed work was continued by a durable successor. Written on both ends of the link. */
  workContinued: 'work_continued',
  /** A controller binding was created, rebound or disabled. Session-scoped, not work-scoped. */
  controllerBindingChanged: 'controller_binding_changed',
  operationResolved: 'operation_resolved',
  checkpointUpdated: 'checkpoint_updated',
  agentRegistered: 'agent_registered',
  agentUpdated: 'agent_updated',
  worktreeAssigned: 'worktree_assigned',
  integrationIntent: 'integration_intent',
  artifactRecorded: 'artifact_recorded'
} as const;

/** Machine-readable blocker codes the ledger itself writes. */
export const WORK_BLOCKER_CODES = {
  operationOutcomeUnknown: 'OPERATION_OUTCOME_UNKNOWN',
  recoveryExhausted: 'RECOVERY_EXHAUSTED',
  authRequired: 'AUTH_REQUIRED',
  providerUnavailable: 'PROVIDER_UNAVAILABLE',
  hostStopped: 'HOST_STOPPED',
  primeLaunchFailed: 'PRIME_LAUNCH_FAILED',
  drainFailed: 'DRAIN_FAILED',
  resumeFailed: 'RESUME_FAILED',
  instructionDeliveryFailed: 'INSTRUCTION_DELIVERY_FAILED',
  instructionDeliveryUnknown: 'INSTRUCTION_DELIVERY_UNKNOWN',
  cuaBusy: 'CUA_BUSY'
} as const;

/** Machine-readable error codes this service and its store throw. */
export const WORK_ERROR_CODES = {
  invalidInput: 'INVALID_INPUT',
  requestIdConflict: 'REQUEST_ID_CONFLICT',
  workNotFound: 'WORK_NOT_FOUND',
  workNotResumable: 'WORK_NOT_RESUMABLE',
  workAlreadyCompleted: 'WORK_ALREADY_COMPLETED',
  workAlreadyCancelled: 'WORK_ALREADY_CANCELLED',
  workCursorInvalid: 'WORK_CURSOR_INVALID',
  projectNotFound: 'PROJECT_NOT_FOUND',
  projectPathInvalid: 'PROJECT_PATH_INVALID',
  projectNotGit: 'PROJECT_NOT_GIT',
  modelUnavailable: 'MODEL_UNAVAILABLE',
  operationNotFound: 'OPERATION_NOT_FOUND',
  operationResolutionConflict: 'OPERATION_RESOLUTION_CONFLICT',
  operationUnknownUnresolved: 'OPERATION_UNKNOWN_UNRESOLVED',
  continuationConflict: 'CONTINUATION_CONFLICT',
  stateUnavailable: 'STATE_UNAVAILABLE',
  checkpointTooLarge: 'CHECKPOINT_TOO_LARGE',
  hostUnavailable: 'HOST_UNAVAILABLE',
  controllerBindingConflict: 'CONTROLLER_BINDING_CONFLICT',
  controllerMessageConflict: 'CONTROLLER_MESSAGE_CONFLICT',
  controllerDeliveryConflict: 'CONTROLLER_DELIVERY_CONFLICT',
  controllerAccountConflict: 'CONTROLLER_ACCOUNT_CONFLICT',
  internalError: 'INTERNAL_ERROR'
} as const;

export const WORK_GOAL_MAX_BYTES = 64 * 1024;
export const WORK_TITLE_MAX_CHARS = 200;
export const WORK_CHECKPOINT_MAX_BYTES = 24 * 1024;
export const WORK_LIST_DEFAULT_LIMIT = 20;
export const WORK_LIST_MAX_LIMIT = 100;
export const WORK_EVENTS_DEFAULT_LIMIT = 50;
export const WORK_EVENTS_MAX_LIMIT = 200;
export const WORK_MAX_WORKERS_DEFAULT = 2;
export const WORK_MAX_WORKERS_MIN = 1;
export const WORK_MAX_WORKERS_MAX = 8;
/** Control/status response bodies are capped; longer text is truncated with a reference. */
export const WORK_RESPONSE_MAX_BYTES = 64 * 1024;
/** Bounded preview lengths for text carried inside status/list rows. */
export const WORK_GOAL_PREVIEW_CHARS = 512;
export const WORK_INSTRUCTION_PREVIEW_CHARS = 256;

/**
 * A typed failure every interface can map to its own surface: the CLI to exit code 4, the
 * MCP tools to a tool error, the GUI to an inline message. `code` is the contract; `message`
 * is already human-readable and never contains a secret URL.
 */
export class WorkServiceError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'WorkServiceError';
    this.code = code;
    this.detail = detail;
  }
}

export function isWorkServiceError(value: unknown): value is WorkServiceError {
  return value instanceof WorkServiceError;
}

/** The bounded `{code,message}` shape adapters publish, for any thrown value. */
export function workErrorPayload(error: unknown): { code: string; message: string } {
  if (isWorkServiceError(error)) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return {
      code: WORK_ERROR_CODES.invalidInput,
      message: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'The request did not match the work schema.'
    };
  }
  if (error instanceof Error) return { code: WORK_ERROR_CODES.internalError, message: error.message };
  return { code: WORK_ERROR_CODES.internalError, message: 'The work service failed without a message.' };
}

const textSchema = z.string().min(1).max(WORK_GOAL_MAX_BYTES)
  .refine(value => utf8Bytes(value) <= WORK_GOAL_MAX_BYTES, { message: `Text must be at most ${WORK_GOAL_MAX_BYTES} bytes of UTF-8.` });

export const workStartSchema = z.object({
  request_id: z.uuid().describe('Idempotency key. Reuse the same UUID when retrying the identical request.'),
  project_path: z.string().min(1).max(4096).describe('Absolute path of an existing Git project.'),
  goal: textSchema.describe('The coding goal, 1–64KiB of UTF-8.'),
  title: z.string().trim().min(1).max(WORK_TITLE_MAX_CHARS).optional(),
  model: z.string().trim().min(1).max(120).optional().describe('ChatGPT model slug; must be one the account actually offers.'),
  reasoning: z.enum(REASONING_EFFORTS).optional(),
  max_workers: z.number().int().min(WORK_MAX_WORKERS_MIN).max(WORK_MAX_WORKERS_MAX).default(WORK_MAX_WORKERS_DEFAULT)
}).strict();
/**
 * Request types are the schemas' *input* types: fields with a default (`max_workers`, `limit`,
 * `after`) stay optional for the caller and the service fills them by parsing. Response types
 * are the parsed output types.
 */
export type WorkStart = z.input<typeof workStartSchema>;

export const workListSchema = z.object({
  cursor: z.uuid().optional().describe('The work_id returned as next_cursor by the previous page.'),
  limit: z.number().int().min(1).max(WORK_LIST_MAX_LIMIT).default(WORK_LIST_DEFAULT_LIMIT)
}).strict();
export type WorkList = z.input<typeof workListSchema>;

export const workStatusRequestSchema = z.object({ work_id: z.uuid() }).strict();
export type WorkStatusRequest = z.infer<typeof workStatusRequestSchema>;

export const workOperationResolutionSchema = z.object({
  operation_id: z.uuid(),
  decision: z.enum(WORK_OPERATION_DECISIONS),
  note: z.string().trim().min(1).max(2000)
}).strict();
export type WorkOperationResolution = z.infer<typeof workOperationResolutionSchema>;

export const workInstructionSchema = z.object({
  request_id: z.uuid(),
  work_id: z.uuid(),
  text: textSchema,
  resolve_operations: z.array(workOperationResolutionSchema).max(16).optional()
}).strict();
export type WorkInstruction = z.infer<typeof workInstructionSchema>;

export const workControlSchema = z.object({
  request_id: z.uuid(),
  work_id: z.uuid(),
  action: workActionSchema
}).strict();
export type WorkControl = z.infer<typeof workControlSchema>;

export const workEventsRequestSchema = z.object({
  work_id: z.uuid(),
  after: z.number().int().nonnegative().default(0).describe('Return events with a sequence greater than this cursor.'),
  limit: z.number().int().min(1).max(WORK_EVENTS_MAX_LIMIT).default(WORK_EVENTS_DEFAULT_LIMIT)
}).strict();
export type WorkEventsRequest = z.input<typeof workEventsRequestSchema>;

export const workBlockerSchema = z.object({
  code: z.string().min(1).max(64),
  detail: z.string().max(4000),
  at: z.number().int().nonnegative(),
  operation_id: z.uuid().optional()
});
export type WorkBlocker = z.infer<typeof workBlockerSchema>;

export const workReceiptSchema = z.object({
  request_id: z.uuid(),
  work_id: z.uuid(),
  status: workStateSchema,
  revision: z.number().int().nonnegative(),
  /** Declared at admission so the result location is never an end-of-task surprise. */
  project_path: z.string().optional(),
  integration_branch: z.string().optional(),
  integration_worktree: z.string().optional(),
  /**
   * The work this one continues, when the request named a completed predecessor. Its presence
   * is what tells a caller that `work_id` is a durable successor rather than the work it asked
   * for, and every later instruction must be sent to `work_id`.
   */
  predecessor_work_id: z.uuid().optional()
});
export type WorkReceipt = z.infer<typeof workReceiptSchema>;

export const workRecoverySummarySchema = z.object({
  agent_id: z.uuid(),
  generation: z.number().int().nonnegative(),
  phase: z.string().min(1).max(32),
  episodes: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative()
});
export type WorkRecoverySummary = z.infer<typeof workRecoverySummarySchema>;

export const workOperationSummarySchema = z.object({
  operation_id: z.uuid(),
  agent_id: z.uuid(),
  tool: z.string().min(1).max(120),
  state: z.enum(WORK_OPERATION_STATES),
  result_ref: z.string().nullable(),
  /**
   * Present on an `outcome_unknown` row: the recorded decision, and the fresh operation id an
   * authorized retry may use once. Both null until the user decides, so the desktop offers the
   * two choices only for unresolved unknowns.
   */
  resolution: z.enum(WORK_OPERATION_DECISIONS).nullable(),
  retry_operation_id: z.uuid().nullable(),
  updated_at: z.number().int().nonnegative()
});
export type WorkOperationSummary = z.infer<typeof workOperationSummarySchema>;

export const workAgentSummarySchema = z.object({
  agent_id: z.uuid(),
  role: workAgentRoleSchema,
  label: z.string().max(WORK_TITLE_MAX_CHARS),
  state: z.string().min(1).max(32),
  session_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  worktree_path: z.string().nullable(),
  branch: z.string().nullable(),
  base_commit: z.string().nullable(),
  model: z.string().nullable(),
  reasoning: z.string().nullable(),
  result_ref: z.string().nullable(),
  checkpoint_ref: z.string().nullable(),
  /** Bounded preview of the agent's most recent durable operation, when one exists. */
  last_operation: workOperationSummarySchema.nullable(),
  recovery: workRecoverySummarySchema.nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative()
});
export type WorkAgentSummary = z.infer<typeof workAgentSummarySchema>;

export const workCheckpointSchema = z.object({
  revision: z.number().int().nonnegative(),
  summary: z.string().max(WORK_CHECKPOINT_MAX_BYTES),
  remaining: z.array(z.string().max(2000)).max(64),
  verification: z.array(z.object({ operation_id: z.uuid(), outcome: z.enum(['passed', 'failed']) })).max(256),
  /** True when the host wrote this from recorded facts, not the model. */
  host_generated: z.boolean(),
  updated_at: z.number().int().nonnegative()
});
export type WorkCheckpoint = z.infer<typeof workCheckpointSchema>;

export const workPendingCommandSchema = z.object({
  request_id: z.uuid(),
  kind: z.enum(WORK_COMMAND_KINDS),
  text_preview: z.string().nullable(),
  delivery_state: z.enum(WORK_DELIVERY_STATES),
  attempts: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative()
});
export type WorkPendingCommand = z.infer<typeof workPendingCommandSchema>;

export const workSummarySchema = z.object({
  work_id: z.uuid(),
  title: z.string().max(WORK_TITLE_MAX_CHARS),
  status: workStateSchema,
  desired_state: workDesiredStateSchema.nullable(),
  /** Explicitly truncated preview; `status` carries the full goal. */
  goal_preview: z.string().max(WORK_GOAL_PREVIEW_CHARS),
  project_path: z.string(),
  project_name: z.string().nullable(),
  integration_branch: z.string().nullable(),
  integration_worktree: z.string().nullable(),
  base_commit: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  max_workers: z.number().int(),
  agent_count: z.number().int().nonnegative(),
  prime_agent_id: z.uuid().nullable(),
  /** Durable continuation chain. Both null for a work that was started on its own. */
  predecessor_work_id: z.uuid().nullable(),
  successor_work_id: z.uuid().nullable(),
  blocker: workBlockerSchema.nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative()
});
export type WorkSummary = z.infer<typeof workSummarySchema>;

export const workProjectOptionSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  path: z.string().min(1).max(32768)
});
export type WorkProjectOption = z.infer<typeof workProjectOptionSchema>;

export const workPageSchema = z.object({
  works: z.array(workSummarySchema),
  projects: z.array(workProjectOptionSchema),
  next_cursor: z.uuid().nullable()
});
export type WorkPage = z.infer<typeof workPageSchema>;

export const workStatusSchema = z.object({
  work_id: z.uuid(),
  title: z.string().max(WORK_TITLE_MAX_CHARS),
  goal: z.string(),
  status: workStateSchema,
  desired_state: workDesiredStateSchema.nullable(),
  project_path: z.string(),
  project_name: z.string().nullable(),
  integration_branch: z.string().nullable(),
  integration_worktree: z.string().nullable(),
  base_commit: z.string().nullable(),
  model: z.string().nullable(),
  reasoning: z.string().nullable(),
  max_workers: z.number().int(),
  revision: z.number().int().nonnegative(),
  prime: workAgentSummarySchema.nullable(),
  agents: z.array(workAgentSummarySchema),
  /** Durable continuation chain, so an interface can route to the active end of it. */
  predecessor_work_id: z.uuid().nullable(),
  successor_work_id: z.uuid().nullable(),
  blocker: workBlockerSchema.nullable(),
  checkpoint: workCheckpointSchema.nullable(),
  recovery: workRecoverySummarySchema.nullable(),
  /** Bounded: only the most recent operations, newest first. */
  operations: z.array(workOperationSummarySchema),
  pending_commands: z.array(workPendingCommandSchema),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative()
});
export type WorkStatus = z.infer<typeof workStatusSchema>;

export const workEventSchema = z.object({
  work_id: z.uuid(),
  sequence: z.number().int().nonnegative(),
  kind: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
  at: z.number().int().nonnegative()
});
export type WorkEvent = z.infer<typeof workEventSchema>;

export const workEventPageSchema = z.object({
  events: z.array(workEventSchema),
  /** Pass as `after` to continue; equals the newest returned sequence, or `after` when empty. */
  next_cursor: z.number().int().nonnegative(),
  has_more: z.boolean()
});
export type WorkEventPage = z.infer<typeof workEventPageSchema>;

/** One durable change notification for the GUI's `work:changed` push. */
export interface WorkChange {
  work_id: string;
  revision: number;
  status: WorkState;
  kind: string;
}

/**
 * The six operations every interface calls. Adapters never keep their own queue: they parse
 * with the schemas above and await this.
 */
export interface WorkService {
  start(input: WorkStart): Promise<WorkReceipt>;
  list(input: WorkList): Promise<WorkPage>;
  status(input: WorkStatusRequest): Promise<WorkStatus>;
  instruct(input: WorkInstruction): Promise<WorkReceipt>;
  control(input: WorkControl): Promise<WorkReceipt>;
  events(input: WorkEventsRequest): Promise<WorkEventPage>;
}
