import type { WorkControllerBinding } from './work-continuity.js';
import type {
  WorkControl,
  WorkEventPage,
  WorkEventsRequest,
  WorkInstruction,
  WorkList,
  WorkPage,
  WorkReceipt,
  WorkStart,
  WorkStatus,
  WorkStatusRequest,
  WorkChange
} from './work.js';

/**
 * The GUI work channels, declared once.
 *
 * The preload and the main process both read these names, so a channel cannot be renamed on
 * one side and silently stop answering on the other. Each entry is one named operation with
 * its own schema; there is no generic "invoke this work method" channel, so the renderer can
 * only reach the six operations the ledger already exposes to the CLI and MCP, plus the two
 * conversation-continuity reads and writes below.
 */
export const WORK_IPC = {
  start: 'work:start',
  list: 'work:list',
  status: 'work:status',
  instruct: 'work:instruct',
  control: 'work:control',
  events: 'work:events',
  reveal: 'work:reveal',
  /** Reads the displayed local chat's durable connection to a work, or `null` for none. */
  controllerGet: 'work:controller:get',
  /** Connects or disconnects the displayed local chat; the host resolves its conversation. */
  controllerSet: 'work:controller:set',
  changed: 'work:changed'
} as const;

/**
 * The renderer names a local session, never a provider conversation.
 *
 * A conversation id is the host's own reading of the saved session (`getSession`), so a window
 * cannot point the relay at a thread the app has no recorded history for.
 */
export interface WorkControllerGet {
  session_id: string;
}

/**
 * One explicit connection change for the displayed chat.
 *
 * `enabled` is the whole intent: enabling authorizes new messages in that saved thread from now
 * on, and disabling stops new automatic relay and report delivery without cancelling the work.
 * There is deliberately no way to ask for "disable and cancel" through this channel.
 */
export interface WorkControllerSet {
  session_id: string;
  work_id: string;
  enabled: boolean;
}

/** Payload and result of each request channel, so both sides type the same contract. */
export interface WorkIpcRequests {
  [WORK_IPC.start]: { request: WorkStart; reply: WorkReceipt };
  [WORK_IPC.list]: { request: WorkList; reply: WorkPage };
  [WORK_IPC.status]: { request: WorkStatusRequest; reply: WorkStatus };
  [WORK_IPC.instruct]: { request: WorkInstruction; reply: WorkReceipt };
  [WORK_IPC.control]: { request: WorkControl; reply: WorkReceipt };
  [WORK_IPC.events]: { request: WorkEventsRequest; reply: WorkEventPage };
  [WORK_IPC.reveal]: { request: WorkStatusRequest; reply: boolean };
  [WORK_IPC.controllerGet]: { request: WorkControllerGet; reply: WorkControllerBinding | null };
  [WORK_IPC.controllerSet]: { request: WorkControllerSet; reply: WorkControllerBinding | null };
}

/**
 * The push the renderer receives when the ledger commits a change.
 *
 * It carries the revision the ledger allocated in the same transaction as the change, so a
 * repaint is never triggered by a repeat notification of the same state.
 */
export type WorkIpcChange = WorkChange;
