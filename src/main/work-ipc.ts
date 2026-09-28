import { shell } from 'electron';
import { z } from 'zod';
import {
  WORK_ERROR_CODES,
  WorkServiceError,
  workControlSchema,
  workEventsRequestSchema,
  workInstructionSchema,
  workListSchema,
  workStartSchema,
  workStatusRequestSchema
} from '../shared/work.js';
import { WORK_IPC, type WorkIpcChange } from '../shared/work-ipc.js';
import type { WorkControllerBinding } from '../shared/work-continuity.js';
import {
  bindWorkController,
  getWorkControllerBinding,
  setWorkControllerEnabled
} from './work/continuity.js';
import { getWorkServiceOrNull, subscribeWorkChanges } from './work/service.js';
import { getSession } from './session/store.js';

/**
 * The GUI's work channels.
 *
 * Every handler parses the same `src/shared/work.ts` schema the CLI and the MCP tools parse and
 * calls the same service, so the desktop cannot invent a second queue, a second state machine or
 * a second vocabulary. A handler that runs before the host has opened its ledger returns a
 * truthful `HOST_UNAVAILABLE` refusal instead of throwing something the renderer cannot explain.
 *
 * No channel takes a path. `work:reveal` names a work id, and the main process reads the result
 * worktree from the durable record — the renderer never supplies a filesystem location.
 */

type Register = <T>(channel: string, fn: (payload: unknown) => Promise<T>) => void;

/** A local session id, as the session store itself accepts it. */
const sessionIdSchema = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);

/**
 * The renderer names a session, never a provider conversation.
 *
 * The conversation is read here from the saved session (`getSession`), so a window cannot point
 * the relay at a thread this app has no recorded history for — and a chat that has no recorded
 * conversation yet is refused rather than connected to something inferred.
 */
const controllerGetSchema = z.object({ session_id: sessionIdSchema }).strict();
const controllerSetSchema = z.object({
  session_id: sessionIdSchema,
  work_id: z.uuid(),
  enabled: z.boolean()
}).strict();

function service() {
  const live = getWorkServiceOrNull();
  if (live) return live;
  throw new WorkServiceError(
    WORK_ERROR_CODES.hostUnavailable,
    'HOST_UNAVAILABLE: the host has not started its work ledger yet. Wait for the app to finish starting and try again.'
  );
}

export function registerWorkIpc(
  handle: Register,
  push: (channel: string, ...args: unknown[]) => void
): void {
  handle(WORK_IPC.start, async payload => service().start(workStartSchema.parse(payload)));
  handle(WORK_IPC.list, async payload => service().list(workListSchema.parse(payload ?? {})));
  handle(WORK_IPC.status, async payload => service().status(workStatusRequestSchema.parse(payload)));
  handle(WORK_IPC.instruct, async payload => service().instruct(workInstructionSchema.parse(payload)));
  handle(WORK_IPC.control, async payload => service().control(workControlSchema.parse(payload)));
  handle(WORK_IPC.events, async payload => service().events(workEventsRequestSchema.parse(payload ?? {})));

  /**
   * Reveals the integration worktree recorded for one work.
   *
   * The path comes from the ledger, not from the caller: a work whose worktree has not been
   * created yet says so rather than revealing the project folder as if it were the result.
   */
  handle(WORK_IPC.reveal, async payload => {
    const { work_id } = workStatusRequestSchema.parse(payload);
    const status = await service().status({ work_id });
    const worktree = status.integration_worktree;
    if (!worktree) {
      throw new WorkServiceError(
        WORK_ERROR_CODES.workNotFound,
        'The result worktree for this work has not been created yet, so there is nothing to open.'
      );
    }
    shell.showItemInFolder(worktree);
    return true;
  });

  /**
   * Reads whether one local session is connected to a work.
   *
   * `null` is the honest answer for "not connected" and for a host whose continuity manager has
   * not been restored yet: both mean the relay is not watching that chat, which is what the pane
   * displays. The ledger itself is read through `service()` first so a window that asks before
   * startup gets `HOST_UNAVAILABLE` rather than a false "not connected".
   */
  handle(WORK_IPC.controllerGet, async (payload): Promise<WorkControllerBinding | null> => {
    const { session_id } = controllerGetSchema.parse(payload);
    service();
    return getWorkControllerBinding(session_id);
  });

  /**
   * Connects or disconnects the displayed local chat.
   *
   * Enabling is what authorizes new messages in that saved thread to be relayed to the work from
   * now on; disabling stops new automatic relay and report delivery. Neither action controls the
   * work: there is no pause, cancel or resume here, so a user who disconnects keeps the work.
   *
   * The conversation is resolved from the session store, and the work must exist in the ledger —
   * a request that names a session with no recorded conversation, or a work the ledger does not
   * have, is refused instead of being bound to something approximate.
   */
  handle(WORK_IPC.controllerSet, async (payload): Promise<WorkControllerBinding | null> => {
    const { session_id, work_id, enabled } = controllerSetSchema.parse(payload);
    const live = service();
    // Validates the work against the ledger and fails with WORK_NOT_FOUND otherwise.
    await live.status({ work_id });

    const existing = getWorkControllerBinding(session_id);
    // A chat drives one work at a time, but only while it is actually driving it. A disabled row
    // is history, not ownership: disconnecting never deletes the durable row (the ledger has no
    // delete), so refusing to move a disabled chat would strand it on that work forever.
    if (existing && existing.enabled && existing.work_id !== work_id) {
      throw new WorkServiceError(
        WORK_ERROR_CODES.controllerBindingConflict,
        'CONTROLLER_BINDING_CONFLICT: this chat is already driving another work. Disconnect it there first; a chat is never the controller of two works at once.'
      );
    }

    if (!enabled) {
      // Disconnecting names the work the chat is actually driving. Anything else is a request to
      // release a connection that does not exist, which is refused rather than treated as success.
      if (!existing || existing.work_id !== work_id) {
        throw new WorkServiceError(
          WORK_ERROR_CODES.controllerBindingConflict,
          'CONTROLLER_BINDING_CONFLICT: this chat is not connected to this work, so there is nothing to disconnect.'
        );
      }
      const disabled = await setWorkControllerEnabled(session_id, false);
      if (!disabled) {
        throw new WorkServiceError(
          WORK_ERROR_CODES.stateUnavailable,
          'STATE_UNAVAILABLE: the connection could not be changed. The work ledger is open but its continuity state is not restored yet.'
        );
      }
      return disabled;
    }

    // The conversation is the host's own reading of the saved session. A chat with no recorded
    // conversation has no thread to relay into, so it is refused rather than connected to a guess.
    const session = await getSession(session_id);
    const conversationId = session?.conversationId ?? null;
    if (!conversationId) {
      throw new WorkServiceError(
        WORK_ERROR_CODES.stateUnavailable,
        'STATE_UNAVAILABLE: this chat has no recorded conversation yet, so it cannot be connected. Send a message in it first.'
      );
    }
    // Already connected and enabled for this exact saved thread: nothing to write, and no reason
    // to move `bound_at` for a press that changed nothing. An `automatic` row is the exception —
    // the prime fallback created it, and this press is a person adopting that chat, so it is
    // stamped `explicit` below rather than left replaceable by a later automatic handover.
    if (existing?.enabled && existing.conversation_id === conversationId && existing.origin === 'explicit') {
      return existing;
    }

    // This press is the explicit user act the ledger requires to move a work's controller: one
    // work has one controller at a time, and connecting a different chat takes it over. The
    // previous controller is disabled, not deleted — its work keeps running, its reports stop
    // there, and its own pane learns from the binding-change push.
    //
    // `origin: 'explicit'` is part of that act, not decoration: without it a binding the prime
    // fallback created stays `automatic`, and the next automatic handover could displace the
    // chat a person deliberately reconnected.
    const bound = bindWorkController({
      sessionId: session_id, conversationId, workId: work_id, takeover: true, origin: 'explicit'
    });
    if (!bound) {
      throw new WorkServiceError(
        WORK_ERROR_CODES.stateUnavailable,
        'STATE_UNAVAILABLE: the connection could not be created. The work ledger is open but its continuity state is not restored yet.'
      );
    }
    // Re-binding keeps the previous enabled flag on purpose; enabling is always this explicit
    // call, so a chat that was disconnected never becomes a controller again by accident.
    if (bound.enabled) return bound;
    const enabledBinding = await setWorkControllerEnabled(session_id, true);
    if (!enabledBinding) {
      throw new WorkServiceError(
        WORK_ERROR_CODES.stateUnavailable,
        'STATE_UNAVAILABLE: the connection was created but could not be enabled.'
      );
    }
    return enabledBinding;
  });

  // One subscription for the whole process. The renderer refetches on the push; nothing polls.
  subscribeWorkChanges((change: WorkIpcChange) => push(WORK_IPC.changed, change));
}
