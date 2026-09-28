/**
 * The single ownership join between ChatGPT's page model and an inbound MCP request.
 *
 * ChatGPT puts one opaque request id in both places:
 *   - HTTP `x-request-id` on the MCP request (normalised at ingress), and
 *   - `message.metadata.request_id` on the connector request in the page model.
 *
 * Nothing else is ownership evidence. In particular, tool names, timestamps, rendered
 * connector rows, the active tab and "the only chat generating" never enter this registry.
 *
 * Once that exact join has been proved it is permanent. `request_id` names one ChatGPT
 * workflow, and the MCP side may keep issuing calls after the page that originally exposed the
 * id has been reloaded, compacted or closed. Expiring the join after ten minutes was the live
 * 1.8.1 bug: the same still-running request went from correctly attributed to Unattributed
 * solely because its browser evidence aged out. A proven owner therefore has no time TTL - and
 * no later observation can move or erase it either.
 *
 * A second conversation claiming a proven id is a page that is wrong about itself: a React tree
 * still mounted from the chat before it, a fresh chat whose client-side thread id has not yet
 * become the server's, an id the site reused. The answer to a page that is wrong is to refuse
 * the claimant, not to disown a request whose calls are still arriving. Disowning it was the
 * visible failure: one contradicting sighting nulled the owner for good, and from then on every
 * call under that id waited fifteen seconds for evidence that could no longer be accepted and
 * landed in Unattributed activity. First proof wins, and it keeps winning.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readDurable, durableStoreDirectory } from '../durable.js';
import { logWarn } from '../logger.js';
import { indexedSessions, readRecentEvents } from './store.js';
import { attachRequestPlan, reconcileRequestPlans } from './request-plans.js';
import { reconcileAgentRequestOwners } from '../agents.js';

export interface RequestCorrelation {
  requestId: string;
  conversationId: string;
  /** Durable local session epoch that owned this request when the page first proved it. */
  sessionId: string;
  messageId: string;
  tool: string;
  observedAt: number;
  /**
   * The native user message this request's turn answers, when the page proved the exact ancestor
   * of {@link messageId} in the provider graph.
   *
   * This is the authority a work change needs, and it is identity: a message id, carried on the
   * same request-metadata path as everything else here. Absent and `null` both mean the observer
   * did not prove it — never a guess — and a consumer that needs it must defer rather than infer it
   * from a clock, the newest turn, or a turn's frozen `questionId`.
   */
  questionId?: string | null;
  /**
   * Whether two sightings proved *different* user ancestors for one request id.
   *
   * A contradiction is not resolved here: conversation ownership is first-proof-wins and stays
   * untouched, but a consumer that needs the human authority behind the request refuses rather than
   * choosing between two proven answers.
   */
  questionConflict?: boolean;
}

const MAX_CORRELATIONS = 50_000;
const CORRELATIONS_STATE = 'request-correlations';
/**
 * 5 stores owners and nothing else, because an owner is now the only verdict there is.
 *
 * Versions 3 and 4 wrapped each row in a sticky `conflicted` flag, so a row could exist purely
 * to record that its id was unusable. Those rows say nothing this registry can act on any more:
 * read the owner out of the wrapper when one is there, and let a forgotten id be proved again
 * by exact evidence or by the recorded history reconciled below.
 */
const CORRELATIONS_STATE_VERSION = 5;

const byRequest = new Map<string, RequestCorrelation>();
const waiters = new Map<string, Set<() => void>>();
/**
 * Listeners woken when one request's *human* proof changes.
 *
 * Ownership and human authority arrive on different schedules: the conversation is proved by the
 * connector node the moment its call is seen, while the native user message behind it may only be
 * resolved later. A consumer that had to defer on an unproven question therefore needs a wake when
 * the proof lands, not a poll.
 */
const proofListeners = new Set<(owner: RequestCorrelation) => void>();
/**
 * Evidence grace belongs to the request, not each tool call in its workflow. All callers
 * measure their allowance from its first wait, so sequential and overlapping calls cannot
 * restart the clock. Keep the start rather than a spent flag: the recorder's longer grace
 * must remain available after a shorter identity lookup expires. This is only wait accounting,
 * never a negative ownership verdict; exact evidence always wins, even after every deadline.
 * Process-local and bounded: a restart or eviction may grant fresh grace, never an owner.
 */
const evidenceWindowStarts = new Map<string, number>();
const MAX_EVIDENCE_WINDOWS = 2_000;
let restored = false;
let restoring: Promise<void> | null = null;

interface PersistedCorrelations {
  version: number;
  entries: RequestCorrelation[];
}

function wake(requestId: string): void {
  const held = waiters.get(requestId);
  if (!held) return;
  waiters.delete(requestId);
  for (const resolve of held) resolve();
}

/** Subscribes to proof changes (a question newly proven, or proven differently). */
export function onRequestCorrelationProof(listener: (owner: RequestCorrelation) => void): () => void {
  proofListeners.add(listener);
  return () => {
    proofListeners.delete(listener);
  };
}

function notifyProof(owner: RequestCorrelation): void {
  for (const listener of proofListeners) {
    try {
      listener({ ...owner });
    } catch (error) {
      // A broken listener must not break attribution for everyone else.
      logWarn(`request proof listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function trim(): void {
  while (byRequest.size > MAX_CORRELATIONS) {
    const first = byRequest.keys().next().value as string | undefined;
    if (!first) break;
    byRequest.delete(first);
  }
}

let database: DatabaseSync | null = null;
let databasePath = '';
let selectOwner: StatementSync | null = null;
let saveOwner: StatementSync | null = null;

function ownershipDatabase(): DatabaseSync | null {
  const root = durableStoreDirectory();
  const filename = root ? path.join(root, 'request-correlations.sqlite') : '';
  if (filename === databasePath) return database;
  closeCorrelationStore();
  byRequest.clear();
  if (!filename) return null;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const opened = new DatabaseSync(filename);
  try {
    opened.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS request_owners (request_id TEXT PRIMARY KEY, payload TEXT NOT NULL) WITHOUT ROWID');
    selectOwner = opened.prepare('SELECT payload FROM request_owners WHERE request_id = ?');
    saveOwner = opened.prepare('INSERT INTO request_owners(request_id,payload) VALUES (?,?) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload');
    database = opened;
    databasePath = filename;
    return opened;
  } catch (error) {
    opened.close();
    throw error;
  }
}

/** Close after admission/recording drain; each observation already committed its transaction. */
export function closeCorrelationStore(): void {
  database?.close();
  database = null;
  databasePath = '';
  selectOwner = null;
  saveOwner = null;
}

function lookup(requestId: string): RequestCorrelation | null {
  ownershipDatabase();
  const cached = byRequest.get(requestId);
  if (cached) return cached;
  const row = selectOwner?.get(requestId);
  if (!row) return null;
  if (typeof row.payload !== 'string') throw new Error('Invalid request ownership row');
  const owner = storedOwner(JSON.parse(row.payload));
  if (!owner || owner.requestId !== requestId) throw new Error('Invalid request ownership proof');
  byRequest.set(requestId, owner);
  trim();
  return owner;
}

/**
 * Whether a persisted row still carries everything an owner needs to be restored.
 *
 * The bar is exactly what this registry answers with: a request id, the conversation that
 * proved it, the session epoch that owned it, and when. `tool` is a diagnostic label, kept so
 * a stored row can be read by a human; no caller reads it, and the header above says why it
 * could not be evidence even if one did. Demanding a nonempty one here was therefore a bar the
 * registry itself does not have - and it silently deleted the rows that need restoring most.
 *
 * A request id is published on `message.metadata.request_id` before the `api_tool` message
 * naming the tool exists, so the page proves ownership first and names the tool later. Those
 * early sightings are stored with an empty tool on purpose - the join does not use the name,
 * and waiting for it is what used to file the call under Unattributed activity. Every one of
 * them then failed this check on the next launch, so a workflow whose calls were still arriving
 * lost its proven owner to a restart: the same permanence bug the header describes, arriving
 * through the door marked valid.
 */
function validCorrelation(value: unknown): value is RequestCorrelation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RequestCorrelation>;
  return (
    typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 200 &&
    typeof item.conversationId === 'string' && item.conversationId.length > 0 && item.conversationId.length <= 200 &&
    typeof item.sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(item.sessionId) &&
    typeof item.messageId === 'string' && item.messageId.length > 0 && item.messageId.length <= 300 &&
    typeof item.tool === 'string' && item.tool.length <= 100 &&
    typeof item.observedAt === 'number' && Number.isFinite(item.observedAt) &&
    // The human proof is optional on disk: a row written before this field existed is a row whose
    // question was never observed, which is exactly `null` — not a row to drop.
    (item.questionId === undefined || item.questionId === null ||
      (typeof item.questionId === 'string' && item.questionId.length > 0 && item.questionId.length <= 300))
  );
}

/**
 * The owner in a persisted row, whatever shape the version that wrote it used.
 *
 * Versions 3 and 4 wrapped it as `{ requestId, value, conflicted }`, where a row with no value
 * was a sticky contradiction. Version 5 stores the owner itself. A wrapper with no usable value
 * carries no owner and is simply dropped, which is all that forgetting an old conflict takes.
 */
function storedOwner(raw: unknown): RequestCorrelation | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = 'value' in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
  if (!validCorrelation(value)) return null;
  const owner = value as RequestCorrelation;
  return {
    ...owner,
    // Absent means unobserved, never a guess, so an older row restores as explicitly unproven.
    questionId: typeof owner.questionId === 'string' && owner.questionId.length > 0 ? owner.questionId : null,
    ...(owner.questionConflict === true ? { questionConflict: true } : {})
  };
}

/**
 * Files one sighting against the permanent owner of its request id.
 *
 * Live ChatGPT gives every connector request in one turn the same request_id. messageId and
 * tool identify individual calls inside that turn, so differences there are expected and change
 * nothing. Only the conversation is ownership, and only the first proof of it counts.
 *
 * The session epoch is first-proof-wins for the same conversation as well. Compact & Resume can
 * leave the old page model mounted while a newer local session epoch exists for that same old
 * conversation id, and re-observing the request from that stale page must not drag an in-flight
 * request into the newer epoch.
 */
function merge(input: RequestCorrelation): 'stored' | 'same' | 'refused' {
  const previous = lookup(input.requestId);
  if (previous && previous.conversationId !== input.conversationId) return 'refused';
  const owner = previous ? { ...previous } : { ...input, questionId: input.questionId ?? null };
  const proofChanged = Boolean(input.questionId &&
    ((!owner.questionId) || (owner.questionId !== input.questionId && !owner.questionConflict)));
  if (!owner.questionId && input.questionId) owner.questionId = input.questionId;
  else if (owner.questionId && input.questionId && owner.questionId !== input.questionId) owner.questionConflict = true;
  owner.observedAt = Math.max(owner.observedAt, input.observedAt);
  if (!previous || proofChanged || owner.observedAt !== previous.observedAt) {
    saveOwner?.run(owner.requestId, JSON.stringify(owner));
    byRequest.delete(owner.requestId);
    byRequest.set(owner.requestId, owner);
    trim();
    if (!previous) evidenceWindowStarts.delete(owner.requestId);
    changedOwners.set(owner.requestId, { owner, proofChanged: proofChanged ||
      Boolean(!previous && owner.questionId) || changedOwners.get(owner.requestId)?.proofChanged === true });
  }
  return previous ? 'same' : 'stored';
}

const changedOwners = new Map<string, { owner: RequestCorrelation; proofChanged: boolean }>();

function mergeBatch(inputs: readonly RequestCorrelation[]): Array<'stored' | 'same' | 'refused'> {
  const db = ownershipDatabase();
  db?.exec('BEGIN IMMEDIATE');
  try {
    const results = inputs.map(merge);
    db?.exec('COMMIT');
    const changes = [...changedOwners.values()];
    changedOwners.clear();
    for (const { owner, proofChanged } of changes) {
      wake(owner.requestId);
      if (proofChanged) notifyProof(owner);
    }
    return results;
  } catch (error) {
    db?.exec('ROLLBACK');
    byRequest.clear();
    changedOwners.clear();
    throw error;
  }
}

/**
 * Restores request ownership before the bridge starts accepting page/MCP traffic.
 *
 * 1.8.2 persists this index directly. On the first 1.8.2 launch there is no index yet, so
 * rebuild it once from already-recorded request_id-attributed tool calls. Those records are
 * themselves the result of the exact page↔HTTP join, and let an old still-running workflow
 * remain owned across the upgrade even if its original tab is already gone.
 */
export async function restoreRequestCorrelations(): Promise<void> {
  if (restored) return;
  if (restoring) return restoring;
  restoring = restoreRequestCorrelationsOnce();
  try {
    await restoring;
    await reconcileRequestPlans(requestCorrelation).catch(error => {
      logWarn(`request plan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    restored = true;
  } finally {
    restoring = null;
  }
}

async function restoreRequestCorrelationsOnce(): Promise<void> {
  const db = ownershipDatabase();
  const saved = await readDurable<PersistedCorrelations>(CORRELATIONS_STATE);
  let loaded = Boolean(db?.prepare('SELECT 1 FROM request_owners LIMIT 1').get());
  if (saved && saved.version >= 3 && saved.version <= CORRELATIONS_STATE_VERSION && Array.isArray(saved.entries)) {
    const owners = saved.entries.map(storedOwner).filter(owner => owner !== null);
    mergeBatch(owners);
    loaded ||= owners.length > 0;
  }

  // The durable index is a debounced snapshot, while attributed tool-call JSONL is appended
  // independently. A crash can therefore leave a perfectly valid *nonempty* snapshot that is
  // merely behind the session history. Treat the snapshot as a fast baseline, not as proof that
  // history has nothing newer. Reconcile the durable request-id facts on every restore; merge()
  // is idempotent for the same conversation and still makes contradictions sticky.
  let sessions;
  try {
    sessions = await indexedSessions();
  } catch (error) {
    // A valid direct snapshot can be restored before the session store is initialized (some
    // tests and narrowly scoped consumers do exactly that). In the real app the store is ready
    // before this function runs, so stale-snapshot reconciliation still happens there. With no
    // usable snapshot, however, history is the only recovery source and the initialization
    // error must remain visible rather than silently losing ownership.
    if (loaded) return;
    throw error;
  }
  // Oldest first. History is the one source that can disagree with itself here, because it
  // replays proofs this process did not watch happen, and the owner is whichever proof came
  // first. Sessions arrive newest-first, which would have made it whichever one came last.
  for (const session of sessions.slice(0, 100).reverse()) {
    // The persisted index is the baseline. Reconcile only a bounded newest crash window;
    // parsing every historical JSONL on every launch made startup proportional to years of
    // recorded work and could freeze the main process for a minute before the UI appeared.
    const owners: RequestCorrelation[] = [];
    for (const event of await readRecentEvents(session.id, 1024, {
      kinds: ['tool_call'],
      maxBytes: 512 * 1024
    })) {
      if (event.kind !== 'tool_call') continue;
      const call = event.call;
      if (call.attributionMethod !== 'request_id' || !call.requestId || !call.conversationId) continue;
      owners.push({
        requestId: call.requestId,
        conversationId: call.conversationId,
        sessionId: session.id,
        messageId: `stored:${call.callId}`,
        tool: call.tool,
        observedAt: event.time,
        // History replays ownership only. The human ancestor is not part of the recorded call, and
        // borrowing one from anywhere else would be exactly the inference this field exists to
        // forbid — so a restored row is unproven until a live observation proves it.
        questionId: null
      });
    }
    mergeBatch(owners);
  }
}

/**
 * Adds page evidence. `request_id` is a turn/workflow ownership key, not a per-tool-call id:
 * one ChatGPT turn can legitimately report several message ids/tools under the same key.
 * Re-reporting that key from the same conversation is therefore idempotent, and reporting it
 * from a different one is refused: the owner an id already has is the owner it keeps.
 */
export function observeRequestCorrelation(input: RequestCorrelation): 'stored' | 'same' | 'refused' {
  return observeRequestCorrelations([input])[0]!;
}

/** Commit one observed batch before publishing proof or attaching its dependent work. */
export function observeRequestCorrelations(
  inputs: readonly RequestCorrelation[]
): Array<'stored' | 'same' | 'refused'> {
  const results = mergeBatch(inputs);
  const attaching = new Set<string>();
  for (let index = 0; index < inputs.length; index++) {
    if (results[index] === 'refused') continue;
    const requestId = inputs[index]!.requestId;
    if (attaching.has(requestId)) continue;
    attaching.add(requestId);
    const owner = lookup(requestId);
    if (!owner) continue;
    void attachRequestPlan(owner).catch(error => {
      logWarn(`request plan attachment failed for ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (attaching.size) void reconcileAgentRequestOwners().catch(error => {
    logWarn(`request worker ownership reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return results;
}

/** Exact request-id lookup. An id no page has proved yet resolves to null. */
export function requestCorrelation(requestId: string | null | undefined): RequestCorrelation | null {
  if (!requestId) return null;
  const held = lookup(requestId);
  return held ? { ...held } : null;
}

/**
 * Waits only for this exact id. Late Fiber evidence is allowed; no other request or page
 * state can wake this into a successful ownership decision.
 */
export async function awaitRequestCorrelation(requestId: string | null | undefined, timeoutMs: number): Promise<RequestCorrelation | null> {
  if (!requestId) return null;
  const immediate = requestCorrelation(requestId);
  if (immediate || timeoutMs <= 0) return immediate;

  const now = performance.now();
  const startedAt = evidenceWindowStarts.get(requestId) ?? now;
  if (!evidenceWindowStarts.has(requestId)) {
    evidenceWindowStarts.set(requestId, startedAt);
    if (evidenceWindowStarts.size > MAX_EVIDENCE_WINDOWS) {
      evidenceWindowStarts.delete(evidenceWindowStarts.keys().next().value!);
    }
  }
  const remainingMs = timeoutMs - (now - startedAt);
  if (remainingMs <= 0) return null;

  let timer: NodeJS.Timeout | null = null;
  await new Promise<void>((resolve) => {
    const set = waiters.get(requestId) ?? new Set<() => void>();
    set.add(resolve);
    waiters.set(requestId, set);
    timer = setTimeout(() => {
      set.delete(resolve);
      if (set.size === 0) waiters.delete(requestId);
      resolve();
    }, remainingMs);
    timer.unref?.();
  });
  if (timer) clearTimeout(timer);
  return requestCorrelation(requestId);
}

/** A conversation being closed cannot invalidate an already issued request. */
export function resetCorrelationRegistryForTests(): void {
  closeCorrelationStore();
  changedOwners.clear();
  byRequest.clear();
  evidenceWindowStarts.clear();
  restored = false;
  restoring = null;
  for (const requestId of [...waiters.keys()]) wake(requestId);
}
