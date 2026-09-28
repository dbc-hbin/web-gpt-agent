import { t, ui } from './i18n.js';
import { ago, clockTime, el, icon } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import type { WorkControllerBinding } from '../shared/work-continuity.js';
import type {
  WorkAction,
  WorkAgentSummary,
  WorkEvent,
  WorkOperationSummary,
  WorkProjectOption,
  WorkStatus,
  WorkSummary
} from '../shared/work.js';

/**
 * Durable-work projection for the desktop.
 *
 * This pane shows exactly what the work ledger recorded. It never decides that a work
 * succeeded: `completed` is a status the service writes, and every other value is displayed
 * verbatim — including `blocked` with its machine code and an `outcome_unknown` operation that
 * needs an explicit human decision. Browser silence, a missing Stop button and a quiet worker
 * chat are not completion signals, and nothing here infers one.
 *
 * The result location (integration branch and worktree) is rendered from the first receipt
 * onward, so where the work will land is visible before any file exists.
 *
 * The connection section is the same-conversation relay: it states whether the local chat this
 * window is displaying is connected to the selected work, and connects or disconnects it. The
 * chat is read from the window's own selection, never from the work's prime agent, so a window
 * with no chat open says so instead of offering a control for a conversation it cannot name.
 *
 * Reads and writes cross the fixed preload API only. No path, command or method name comes
 * from the renderer, and no control request waits for the browser or the tunnel.
 */

const STATE_TONE: Record<string, 'live' | 'bad' | 'wait' | ''> = {
  queued: 'wait',
  starting: 'wait',
  running: 'live',
  recovering: 'wait',
  paused: '',
  blocked: 'bad',
  completed: 'live',
  cancelled: ''
};

const AGENT_TONE: Record<string, 'live' | 'bad' | 'wait' | ''> = {
  pending: 'wait',
  active: 'live',
  blocked: 'bad',
  finished: '',
  failed: 'bad'
};

/** Bounded, ordered projection of an event payload; never a raw dump. */
const EVENT_KEYS = [
  'agent_id', 'role', 'operation_id', 'tool', 'state', 'decision', 'code', 'detail',
  'branch', 'worktree', 'commit', 'worker_commit', 'main_before', 'main_after',
  'delivery_state', 'attempts', 'reason', 'phase', 'episodes', 'remaining', 'artifact_id'
];

/**
 * How many of the newest events the pane retains, and the page size it reads them with.
 *
 * The ledger pages events forward from `after` and returns the OLDEST page that matches, so a
 * reader that stops at the first page shows the beginning of a work forever. The pane follows
 * `next_cursor` to the end and keeps the last window, which stays bounded however long the work
 * runs. The page size is the ledger's own maximum (`WORK_EVENTS_MAX_LIMIT`); the renderer cannot
 * import the schema module for it without pulling a validator into the bundle, so it is repeated.
 */
const EVENT_WINDOW = 50;
const EVENT_PAGE_LIMIT = 200;

/** The translated properties the pane's own retained controls carry. */
type CopyProperty = 'textContent' | 'placeholder' | 'aria-label' | 'title';

/** Keys of the retained groups; each names exactly one group and the kind of group it is. */
const START_FORM_KEY = 'start';

/**
 * One group of controls the user types into, kept across repaints.
 *
 * A draft, its caret and the focus belong to the user, not to the ledger read that repaints the
 * pane: a background push, the New work toggle and the explicit refresh all repaint, and building
 * a fresh control there is what used to discard a half-typed goal, an instruction and an audit
 * note. So the pane re-appends these exact nodes, and one group exists per work (and per unknown
 * operation) so switching works never mixes their drafts.
 *
 * `rebind` exists because a language change walks the document: a group the user has temporarily
 * left behind — a closed new-work form, another work's instruction box — would otherwise keep the
 * copy of the language it was created in.
 */
interface Retained {
  /** The node paint re-appends; it holds the draft, its caret and the focus. */
  root: HTMLElement;
  /** Re-applies this group's own translated copy. */
  rebind: () => void;
  /** What that status line says, re-read on a language change. */
  message: () => string;
}

/** A retained group whose controls also show ledger state, re-read on every paint. */
interface Synced extends Retained {
  sync: () => void;
}

/** One audit note, tied to the work and the unknown operation it was typed for. */
interface AuditNote extends Retained {
  input: HTMLInputElement;
}

/** Focus and caret of a retained control, read immediately before a repaint detaches it. */
interface HeldFocus {
  node: HTMLInputElement | HTMLTextAreaElement;
  start: number | null;
  end: number | null;
  direction: 'forward' | 'backward' | 'none' | null;
}

/** One page-following read of a work's events, with the cursor it reached. */
interface EventWindow {
  events: WorkEvent[];
  cursor: number;
}

/**
 * The host's last answer about one (chat, work) pair.
 *
 * The pair is part of the value, not only the request: a reply for a chat or a work the user has
 * already left must never be painted as the connection of the pair now on screen. `binding` is
 * the host's own record — `null` means the host reported no connection, which is different from
 * never having asked.
 */
interface ConnectionRead {
  sessionId: string;
  workId: string;
  binding: WorkControllerBinding | null;
  /**
   * The host's own refusal text when the read failed, or null.
   *
   * It is kept here rather than only on the pane-wide error line because that line is cleared by
   * the next successful call — and a repaint during startup does exactly that, which would leave a
   * refused connection read looking like an unanswered one.
   */
  error: string | null;
}

/** The identity of one chat/work pair, as one string the pane can compare cheaply. */
function pairKey(sessionId: string, workId: string): string {
  return `${sessionId}\u0000${workId}`;
}

/** The translated copy of one retained group, applied now and re-applied by `rebind`. */
function copyBindings(): { bind: (node: HTMLElement, property: CopyProperty, read: () => string) => void; rebind: () => void } {
  const applied: Array<() => void> = [];
  return {
    bind: (node, property, read) => {
      ui(node, property, read);
      applied.push(() => ui(node, property, read));
    },
    rebind: () => { for (const apply of applied) apply(); }
  };
}

/** A group's status line: announced, and separate from the pane-wide error. */
function statusLine(): HTMLElement {
  const line = el('span', 'work-status-line');
  line.setAttribute('role', 'status');
  return line;
}

/** Sets a retained group's status line, keeping its message translated on read. */
function say(group: Retained, message: () => string): void {
  group.message = message;
  group.rebind();
}

/** The ledger's own project list, as the new-work folder field's suggestions. */
function projectOptions(projects: readonly WorkProjectOption[]): HTMLOptionElement[] {
  return projects.map(project => {
    const option = document.createElement('option');
    option.value = project.path;
    option.label = project.name;
    return option;
  });
}

export interface WorkPanelOptions {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  onShow?: () => void;
  /** Reports pane visibility so navigation can reflect the pane the user actually has open. */
  onVisibility?: (open: boolean) => void;
  /** Opens a recorded conversation; the id comes from the work record, never the renderer. */
  openChat: (sessionId: string) => void;
  /**
   * The local chat this window is displaying, or null when it is not showing a recorded session.
   * Omit for a daemon client without a transcript selection; it has no connection section.
   *
   * The connection section is about the chat the user is looking at, so it is read here rather
   * than from the selected work's prime agent: a work whose original chat is gone must not have
   * this window offer a control for a conversation it cannot name.
   */
  currentSession?: () => string | null;
}

/**
 * The label for one machine state value, translated on read.
 *
 * The label is app copy derived from a ledger value, so it follows the interface language; the
 * value itself (`outcome_unknown`, `RECOVERY_EXHAUSTED`) is never translated and is rendered
 * beside it verbatim. Callers pass `() => stateName(value)` so a language change re-reads it.
 */
function stateName(state: string): string {
  return t(state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, ' '));
}

/** App copy translated on read; a plain string is a machine or user value and stays verbatim. */
type Label = string | (() => string);

function row(term: Label, value: Label | null | undefined, mono = false): HTMLElement | null {
  if (value === null || value === undefined || value === '') return null;
  const wrap = el('div', 'work-row');
  wrap.append(el('dt', '', term), el('dd', mono ? 'mono' : '', value));
  return wrap;
}

function rowsOf(children: Array<HTMLElement | null>): HTMLElement | null {
  const present = children.filter((child): child is HTMLElement => child !== null);
  if (!present.length) return null;
  const list = el('dl', 'work-rows');
  list.append(...present);
  return list;
}

function section(title: Label, ...children: Array<HTMLElement | null>): HTMLElement | null {
  const present = children.filter((child): child is HTMLElement => child !== null);
  if (!present.length) return null;
  const wrap = el('section', 'work-section');
  wrap.append(el('h3', '', title), ...present);
  return wrap;
}

function badge(text: Label, tone: 'live' | 'bad' | 'wait' | '' = ''): HTMLElement {
  const node = el('span', 'work-badge', text);
  if (tone) node.dataset.tone = tone;
  return node;
}

function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 12) : null;
}

function eventSummary(event: WorkEvent): string {
  const parts: string[] = [];
  for (const key of EVENT_KEYS) {
    const value = event.payload[key];
    if (value === undefined || value === null) continue;
    const text = Array.isArray(value) ? value.map(String).join(', ') : String(value);
    if (!text) continue;
    parts.push(`${key}=${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ');
}

/** The newest durable operation across every agent, or the given agent's own. */
function latestOperation(status: WorkStatus, agent?: WorkAgentSummary | null): WorkOperationSummary | null {
  if (agent?.last_operation) return agent.last_operation;
  return status.operations[0] ?? null;
}

export function createWorkPanel(options: WorkPanelOptions) {
  const pane = el('aside', 'work-panel');
  pane.hidden = true;
  ui(pane, 'aria-label', () => t('Works'));
  attachWorkPanelResize(options.host, pane);

  const refresh = el('button', 'btn btn-icon work-panel-refresh') as HTMLButtonElement;
  refresh.type = 'button';
  refresh.append(icon('i-pulse'));
  ui(refresh, 'title', () => t('Refresh works'));
  ui(refresh, 'aria-label', () => t('Refresh works'));

  const newWork = el('button', 'btn', () => t('New work')) as HTMLButtonElement;
  newWork.type = 'button';
  newWork.setAttribute('aria-expanded', 'false');

  const toolbar = el('div', 'work-panel-toolbar');
  toolbar.append(newWork, refresh);

  const body = el('div', 'work-panel-body');
  // Errors sit beside the controls they belong to, not only in a transient toast: a refused
  // control and the reason it was refused have to be readable at the same time.
  const error = el('p', 'work-panel-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;

  pane.append(toolbar, body);
  options.host.append(pane);

  // The list and the selected detail own separate generations. Sharing one counter let a
  // detail read started by an earlier push discard the list read of a later one, which left the
  // list row showing a revision the ledger had already moved past.
  let listGeneration = 0;
  let statusGeneration = 0;
  let works: WorkSummary[] = [];
  let projects: WorkProjectOption[] = [];
  /** False until a list call succeeded; an unavailable ledger must not read as "no work". */
  let listLoaded = false;
  let selected: string | null = null;
  let status: WorkStatus | null = null;
  let events: WorkEvent[] = [];
  let formOpen = false;
  let busy = false;
  let admitting = false;
  /** This window's own last accepted control, scoped to the work it was accepted for. */
  let lastControl: { workId: string; at: number; note: () => string } | null = null;
  /** The newest events of the selected work, and the cursor that read reached. */
  let eventsCursor = 0;
  /** What the host last reported about the displayed chat's connection, and for which pair. */
  let connection: ConnectionRead | null = null;
  let connectionGeneration = 0;
  /** The pair the pane has already asked about, so a repaint does not re-ask the same question. */
  let connectionPair: string | null = null;
  let connectionBusy = false;
  /** The outcome of this window's own connect/disconnect press, scoped to the pair it was sent for. */
  let connectionNote: { sessionId: string; workId: string; note: () => string } | null = null;

  /**
   * The control groups the user types into, by identity key.
   *
   * A draft, its caret and the focus belong to the user, not to the ledger read that repaints the
   * pane: a background push, the New work toggle and the explicit refresh all repaint, and building
   * a fresh control there is what used to discard a half-typed goal, an instruction and an audit
   * note. So the pane re-appends these exact nodes instead, and keys them by work (and by unknown
   * operation within that work) so two works' drafts are never the same draft.
   */
  const retained = new Map<string, Retained>();

  /**
   * The retained group for one key, created once.
   *
   * Every key is namespaced by the kind of group it names — the new-work form, one work's
   * instruction box, one unknown operation's audit note — so a key always yields the same shape.
   */
  function group<T extends Retained>(key: string, create: () => T): T {
    const existing = retained.get(key);
    if (existing) return existing as T;
    const created = create();
    retained.set(key, created);
    return created;
  }

  /**
   * Drops the groups whose reason to exist is gone: an instruction box for a work the ledger no
   * longer lists, and an audit note for a work that is gone or an operation already decided.
   *
   * Nothing is dropped merely for being off screen: a draft the user typed into another work is
   * still their work, and it is keyed by that work, so it cannot leak into the one on screen.
   */
  function pruneGroups(): void {
    for (const key of retained.keys()) {
      if (key === START_FORM_KEY) continue;
      const note = key.startsWith('note:');
      const [, workId, operationId] = note ? key.split(':') : ['', key.slice('instruction:'.length), ''];
      if (!works.some(work => work.work_id === workId)) { retained.delete(key); continue; }
      if (!note) continue;
      // Only the selected work's status is in hand; without it there is no evidence the operation
      // was decided, so the note stays rather than being dropped on a guess.
      const decisions = status && status.work_id === workId ? status.operations : null;
      if (decisions?.some(operation => operation.operation_id === operationId && operation.resolution !== null)) {
        retained.delete(key);
      }
    }
  }

  /** The control the user is typing in, with its caret, read before a repaint detaches it. */
  function captureFocus(): HeldFocus | null {
    const active: Element | null = document.activeElement;
    if (!(active instanceof window.HTMLInputElement || active instanceof window.HTMLTextAreaElement)) return null;
    if (!body.contains(active)) return null;
    return { node: active, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
  }

  /** Puts the caret and the focus back on the control a repaint re-appended. */
  function restoreFocus(held: HeldFocus | null): void {
    if (!held || !body.contains(held.node)) return;
    held.node.focus({ preventScroll: true });
    if (held.start !== null && held.end !== null) {
      held.node.setSelectionRange(held.start, held.end, held.direction ?? undefined);
    }
  }

  function fail(message: string | null): void {
    error.hidden = message === null;
    error.textContent = message ?? '';
  }

  /**
   * Unwraps one IPC reply, showing the main process's own error text instead of swallowing it.
   *
   * `current` decides whether the reply may touch the pane's shared error line. A reply for a work
   * the user has already navigated away from is still unwrapped — the caller has to clear its own
   * busy flag — but it must never report its failure over the work now on screen.
   */
  async function call<T>(
    promise: Promise<{ ok: true; data: T } | { ok: false; error: string }>,
    current: () => boolean = () => true
  ): Promise<T | null> {
    const reply = await promise;
    if (reply.ok) { if (current()) fail(null); return reply.data; }
    if (current()) fail(reply.error);
    return null;
  }

  function control(action: WorkAction, workId: string): void {
    if (selected !== workId || busy) return;
    // A reply is only allowed to speak for the work it was sent for. The user can select another
    // work while this request is in flight, and a note or an error about the first one would then
    // be read as a statement about the second.
    const current = (): boolean => selected === workId;
    busy = true;
    paint();
    void call(window.api.workControl({ request_id: crypto.randomUUID(), work_id: workId, action }), current).then(receipt => {
      busy = false;
      if (receipt === null || !current()) { paint(); return; }
      lastControl = {
        workId,
        at: Date.now(),
        note: () => t('{0} accepted · revision {1}', [stateName(receipt.status), receipt.revision])
      };
      void load(workId);
    });
  }

  function resolve(workId: string, operation: WorkOperationSummary, decision: 'accept_observed_effects' | 'authorize_retry', note: string): void {
    if (selected !== workId || busy) return;
    const current = (): boolean => selected === workId;
    // The ledger requires a nonempty audit note, so an empty field gets the same sentence the
    // instruction carries rather than a rejected request the user cannot explain.
    const audit = note.trim() || (decision === 'authorize_retry'
      ? t('Authorize one retry of {0} after an unknown outcome.', [operation.tool])
      : t('Accept the observed effects of {0} after an unknown outcome.', [operation.tool]));
    busy = true;
    paint();
    void call(window.api.workInstruct({
      request_id: crypto.randomUUID(),
      work_id: workId,
      text: audit,
      resolve_operations: [{ operation_id: operation.operation_id, decision, note: audit }]
    }), current).then(receipt => {
      busy = false;
      if (receipt === null || !current()) { paint(); return; }
      lastControl = {
        workId,
        at: Date.now(),
        note: decision === 'authorize_retry'
          ? () => t('Retry authorized for {0}', [operation.tool])
          : () => t('Observed effects accepted for {0}', [operation.tool])
      };
      // The decision is recorded, so its note is done; a second one for the same operation would
      // be refused. Dropping it here is what keeps a decided note out of the next unknown.
      retained.delete(`note:${workId}:${operation.operation_id}`);
      // A resolution can be routed to a durable successor of a completed work, exactly like a
      // plain instruction, and the receipt names it. Follow it only while the user is still on the
      // work they were looking at.
      if (receipt.predecessor_work_id !== undefined && receipt.work_id !== workId) {
        if (selected === workId) selectWork(receipt.work_id);
        else void reload();
        return;
      }
      void load(workId);
    });
  }

  /**
   * Reads the newest events of one work.
   *
   * The ledger pages events forward from `after`, oldest page first, so the newest events are only
   * reachable by following `next_cursor` to the end. The cursor is kept per selected work, so the
   * full walk happens once and every later refresh asks only for what was recorded since; the
   * retained list is always the newest window.
   */
  async function readEvents(id: string, current: () => boolean): Promise<EventWindow | null> {
    let cursor = eventsCursor;
    let held = events;
    for (;;) {
      if (!current()) return null;
      const page = await call(window.api.workEvents({ work_id: id, after: cursor, limit: EVENT_PAGE_LIMIT }), current);
      if (page === null || !current()) return null;
      if (page.events.length) {
        const merged = [...held, ...page.events];
        held = merged.slice(-EVENT_WINDOW);
      }
      cursor = page.next_cursor;
      if (!page.has_more) return { events: held, cursor };
    }
  }

  async function load(id: string): Promise<void> {
    if (selected !== id || pane.hidden) return;
    const request = ++statusGeneration;
    // The selection is part of the identity, not only the generation: a reply for a work the user
    // has already left must not paint that work's detail, controls and revisions over the one now
    // on screen.
    const current = (): boolean => request === statusGeneration && selected === id;
    const [nextStatus, nextEvents] = await Promise.all([
      call(window.api.workStatus({ work_id: id }), current),
      readEvents(id, current)
    ]);
    if (!current()) return;
    if (nextStatus === null) { status = null; events = []; eventsCursor = 0; paint(); return; }
    status = nextStatus;
    events = nextEvents?.events ?? [];
    eventsCursor = nextEvents?.cursor ?? 0;
    paint();
  }

  async function reload(): Promise<void> {
    const request = ++listGeneration;
    const page = await call(window.api.workList({ limit: 50 }), () => request === listGeneration);
    if (request !== listGeneration) return;
    if (page === null) { listLoaded = false; paint(); return; }
    listLoaded = true;
    works = page.works;
    projects = page.projects;
    if (selected && !works.some(work => work.work_id === selected)) {
      selected = null; status = null; events = []; eventsCursor = 0;
    }
    // A work that left the ledger takes its drafts with it: its instruction box and its audit
    // notes are keyed by an id nothing can select any more.
    pruneGroups();
    // Opening the pane shows the newest work rather than an empty detail area. This is a
    // presentation default, not identity: an id the user names is still resolved by the ledger
    // alone, and a work that disappears from the page clears the selection instead of retargeting.
    if (!selected && works.length) selected = works[0]!.work_id;
    paint();
    if (selected) void load(selected);
  }

  function selectWork(id: string): void {
    selected = id;
    status = null;
    events = [];
    eventsCursor = 0;
    paint();
    void load(id);
  }

  /** The local chat this window is displaying, as the chat screen reports its own selection. */
  function currentChat(): string | null {
    const id = options.currentSession?.();
    return typeof id === 'string' && id ? id : null;
  }

  /**
   * Reads the host's record for the displayed chat and one work.
   *
   * The answer is filed under the exact pair it was asked for, and the pair is remembered before
   * the request starts, so a repaint while the read is in flight cannot start a second read of the
   * same question and a late answer for a chat or work the user has left cannot be painted as the
   * connection of the pair now on screen. Re-asking the same pair keeps the host's previous answer
   * for it on screen while the new read is in flight: it is still the host's own statement about
   * this exact chat and work.
   */
  function readConnection(workId: string, sessionId: string): void {
    const key = pairKey(sessionId, workId);
    // A different pair has no answer yet, so the section says it does not know.
    if (connectionPair !== key) {
      connectionPair = key;
      connection = null;
    }
    const request = ++connectionGeneration;
    const current = (): boolean =>
      request === connectionGeneration && connectionPair === key &&
      selected === workId && currentChat() === sessionId;
    void window.api.workControllerGet({ session_id: sessionId }).then(reply => {
      if (!current()) return;
      // A refused read is not an answer of "not connected". The refusal is kept with the read and
      // shown in this section rather than on the pane-wide error line: that line is cleared by the
      // next successful call, and a repaint during startup is exactly that, so a connection that
      // could not be read would end up looking like one that was never asked about.
      connection = reply.ok
        ? { sessionId, workId, binding: reply.data, error: null }
        : { sessionId, workId, binding: null, error: reply.error };
      paint();
    });
  }

  /**
   * Asks about the displayed chat and the selected work when that pair is not already in hand.
   *
   * With no chat open there is no pair to ask about: the section says so instead of showing the
   * connection of some other conversation. `force` re-asks a pair already in hand — an explicit
   * refresh, or a binding change the ledger reported — which is the only way to recover from a
   * read the host refused.
   */
  function syncConnection(force = false): void {
    if (pane.hidden || !selected) return;
    const sessionId = currentChat();
    if (!sessionId) {
      if (connectionPair !== null) { connectionPair = null; connection = null; connectionGeneration++; }
      connectionNote = null;
      return;
    }
    const key = pairKey(sessionId, selected);
    if (!force && key === connectionPair) return;
    // This window's own press note belongs to the pair it was sent for. Moving to another chat or
    // another work ends it, exactly like the read it was reported beside.
    if (key !== connectionPair) connectionNote = null;
    readConnection(selected, sessionId);
  }

  /**
   * Connects or disconnects one chat for one work.
   *
   * `targetWorkId` is the work whose binding is being changed, which is not always the work on
   * screen: the "connected to another work" state releases the chat from the work it actually
   * drives. The reply is still judged against the *displayed* pair — the chat and the selected
   * work at the moment of the press — because that is what the user is looking at; the user can
   * select another work or another chat while this is in flight, and a note about the first pair
   * would then be read as a statement about the second. Neither direction touches the work itself.
   */
  function setConnection(sessionId: string, targetWorkId: string, enabled: boolean): void {
    if (connectionBusy) return;
    const displayedWork = selected;
    if (!displayedWork) return;
    const key = pairKey(sessionId, displayedWork);
    const current = (): boolean =>
      connectionPair === key && selected === displayedWork && currentChat() === sessionId;
    connectionBusy = true;
    // The previous press's outcome is about the previous press: keeping it beside a new request
    // would read as the answer to this one.
    connectionNote = null;
    paint();
    void call(window.api.workControllerSet({ session_id: sessionId, work_id: targetWorkId, enabled }), current)
      .then(binding => {
        connectionBusy = false;
        if (binding === null || !current()) { paint(); return; }
        // Filed under the displayed pair: the host's answer is what this chat is bound to, which
        // may be another work when this press released it from one.
        connection = { sessionId, workId: displayedWork, binding, error: null };
        connectionNote = {
          sessionId,
          workId: displayedWork,
          note: () => binding.enabled
            ? t('Connected. New messages in this chat are relayed to this work.')
            : t('Disconnected. Automatic relay and report delivery are stopped for this chat.')
        };
        paint();
        void load(displayedWork);
      });
  }

  /**
   * The new-work form, created once and re-appended by every paint.
   *
   * The toggle and every background push repaint the pane, so the fields have to be the same nodes
   * for a half-typed goal to survive. `sync` re-reads the parts that are ledger state: the project
   * suggestions, and whether this form is currently admitting a work.
   */
  function startForm(): Synced {
    return group(START_FORM_KEY, () => {
      const copy = copyBindings();
      const form = el('form', 'work-form') as HTMLFormElement;
      const path = document.createElement('input');
      path.type = 'text';
      path.required = true;
      path.autocomplete = 'off';
      path.spellcheck = false;
      path.placeholder = '/Users/you/code/project';
      const options = document.createElement('datalist');
      options.id = 'workProjectOptions';
      path.setAttribute('list', options.id);

      const goal = document.createElement('textarea');
      goal.required = true;
      goal.rows = 4;
      copy.bind(goal, 'placeholder', () => t('Describe the coding goal. The main agent splits it and integrates the result.'));

      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 200;
      title.autocomplete = 'off';

      const workers = document.createElement('input');
      workers.type = 'number';
      workers.min = '1';
      workers.max = '8';
      workers.value = '2';

      const submit = el('button', 'btn btn-solid', () => t('Start work')) as HTMLButtonElement;
      submit.type = 'submit';
      copy.bind(submit, 'textContent', () => t('Start work'));
      const line = statusLine();

      const field = (label: () => string, control: HTMLElement): HTMLElement => {
        const wrap = el('label', 'work-field');
        const text = el('span');
        copy.bind(text, 'textContent', label);
        wrap.append(text, control);
        return wrap;
      };
      form.append(
        field(() => t('Project folder'), path),
        field(() => t('Goal'), goal),
        field(() => t('Title (optional)'), title),
        field(() => t('Max workers'), workers),
        options
      );
      const actions = el('div', 'work-form-actions');
      actions.append(submit, line);
      form.append(actions);

      const box: Synced = {
        root: form,
        rebind: copy.rebind,
        message: () => '',
        sync: () => {
          options.replaceChildren(...projectOptions(projects));
          submit.disabled = admitting;
        }
      };
      copy.bind(line, 'textContent', () => box.message());
      if (projects[0]) path.value = projects[0].path;

      form.addEventListener('submit', event => {
        event.preventDefault();
        const submittedGoal = goal.value;
        const submittedTitle = title.value;
        const projectPath = path.value.trim();
        const goalText = goal.value.trim();
        if (!projectPath || !goalText) { say(box, () => t('A project folder and a goal are required.')); return; }
        const maxWorkers = Math.min(8, Math.max(1, Number.parseInt(workers.value, 10) || 2));
        if (admitting) return;
        admitting = true;
        box.sync();
        say(box, () => t('Admitting…'));
        void call(window.api.workStart({
          request_id: crypto.randomUUID(),
          project_path: projectPath,
          goal: goalText,
          ...(title.value.trim() ? { title: title.value.trim() } : {}),
          max_workers: maxWorkers
        })).then(receipt => {
          admitting = false;
          box.sync();
          // A refused admission is retryable input, not a reason to throw the goal away.
          if (receipt === null) { say(box, () => ''); return; }
          // Accepted: the draft is now the ledger's work, so this form's own copy is done.
          if (goal.value === submittedGoal) goal.value = '';
          if (title.value === submittedTitle) title.value = '';
          say(box, () => '');
          formOpen = false;
          selectWork(receipt.work_id);
          void reload();
        });
      });
      return box;
    });
  }

  function auditNote(workId: string, operationId: string): AuditNote {
    const audit = group(`note:${workId}:${operationId}`, () => {
      const input = document.createElement('input');
      input.type = 'text';
      const copy = copyBindings();
      copy.bind(input, 'placeholder', () => t('Note for the audit record'));
      return { root: input, input, rebind: copy.rebind, message: () => '' };
    });
    audit.rebind();
    return audit;
  }

  function instructionBox(workId: string): Synced {
    const box = group(`instruction:${workId}`, () => {
      const copy = copyBindings();
      const form = el('form', 'work-form') as HTMLFormElement;
      const text = document.createElement('textarea');
      text.rows = 3;
      text.required = true;
      copy.bind(text, 'placeholder', () => t('Add an instruction for this work'));
      const send = el('button', 'btn btn-solid') as HTMLButtonElement;
      send.type = 'submit';
      copy.bind(send, 'textContent', () => t('Send instruction'));
      const note = statusLine();
      const actions = el('div', 'work-form-actions');
      actions.append(send, note);
      form.append(text, actions);
      let sending = false;
      const entry: Synced = { root: form, rebind: copy.rebind, message: () => '',
        sync: () => { send.disabled = sending; } };
      copy.bind(note, 'textContent', () => entry.message());
      form.addEventListener('submit', event => {
        event.preventDefault();
        const submitted = text.value;
        const message = submitted.trim();
        if (!message || sending || selected !== workId) return;
        sending = true;
        entry.sync();
        say(entry, () => t('Recording…'));
        void call(window.api.workInstruct({ request_id: crypto.randomUUID(), work_id: workId, text: message }),
          () => selected === workId).then(receipt => {
          sending = false;
          entry.sync();
          if (receipt === null) { say(entry, () => ''); return; }
          // Whether the box still holds what was submitted is read BEFORE the accepted draft is
          // cleared, because clearing is itself a change to the field.
          const unchanged = text.value === submitted;
          if (unchanged) text.value = '';
          // The ledger routes an instruction for a completed work to its durable successor, so the
          // receipt can name a different work than the one this box was typed into. `predecessor_work_id`
          // is what says so, and the honest response is to follow it rather than report the
          // instruction against a work that is no longer the one being driven. The receipt is a
          // durable admission, not a delivery: "queued for" is what actually happened, and the
          // pending-instructions section reports whatever the outbox did with it afterwards.
          const routed = receipt.predecessor_work_id !== undefined && receipt.work_id !== workId;
          say(entry, () => routed
            ? t('Queued for the continuation of this work · revision {0}', [receipt.revision])
            : t('Queued · revision {0}', [receipt.revision]));
          // Follow only while this box still belongs to the selection the user has AND held nothing
          // but what was submitted. A repaint, a push or a click can have moved them to another
          // work while the request was in flight, and a half-typed follow-up in this box is theirs:
          // the successor is offered as an explicit jump in the controls instead of being forced.
          if (routed) {
            if (selected === workId && unchanged) selectWork(receipt.work_id);
            else { void load(workId); void reload(); }
            return;
          }
          if (selected === workId) void load(workId);
        });
      });
      return entry;
    });
    box.rebind();
    box.sync();
    return box;
  }

  function listView(): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    nodes.push(el('h3', '', () => t('Works · {0}', [works.length])));
    if (!works.length) {
      if (listLoaded) {
        nodes.push(el('p', 'work-panel-empty', () => t('No work yet. Start one with a project folder and a goal.')));
      }
      return nodes;
    }
    const list = el('ul', 'work-list');
    for (const work of works) {
      const item = el('li');
      const button = el('button', 'work-list-row') as HTMLButtonElement;
      button.type = 'button';
      if (work.work_id === selected) button.classList.add('is-selected');
      const head = el('div', 'work-list-head');
      head.append(el('strong', '', work.title || work.goal_preview), badge(() => stateName(work.status), STATE_TONE[work.status] ?? ''));
      button.append(head, el('span', 'work-list-path', work.project_path));
      button.append(el('span', 'work-list-meta', () => t('updated {0} · revision {1}', [ago(work.updated_at), work.revision])));
      button.addEventListener('click', () => selectWork(work.work_id));
      item.append(button);
      list.append(item);
    }
    nodes.push(list);
    return nodes;
  }

  function agentRow(agent: WorkAgentSummary): HTMLElement {
    const wrap = el('li', agent.role === 'prime' ? 'work-tree-row' : 'work-tree-row is-worker');
    const head = el('div', 'work-tree-head');
    // The role/state words are app copy derived from ledger values; a recorded agent label is
    // the runtime's own name and stays verbatim.
    head.append(
      el('span', 'work-tree-role', agent.label || (() => stateName(agent.role))),
      badge(() => stateName(agent.state), AGENT_TONE[agent.state] ?? ''),
      badge(() => stateName(agent.role), '')
    );
    if (agent.generation > 1) head.append(badge(() => t('generation {0}', [agent.generation]), 'wait'));
    wrap.append(head);
    const meta = [
      agent.branch,
      agent.worktree_path,
      agent.model,
      agent.reasoning
    ].filter((value): value is string => Boolean(value)).join(' · ');
    if (meta) wrap.append(el('span', 'work-list-meta', meta));
    const operation = agent.last_operation;
    if (operation) {
      wrap.append(el('span', 'work-list-meta', () => t('last operation {0} · {1}', [operation.tool, stateName(operation.state)])));
      const recorded = el('time', 'work-list-meta', () => t('Last recorded work: {0}', [clockTime(operation.updated_at)]));
      recorded.setAttribute('datetime', new Date(operation.updated_at).toISOString());
      recorded.title = new Date(operation.updated_at).toLocaleString();
      wrap.append(recorded);
      if (operation.state === 'outcome_unknown' && operation.resolution === null) {
        wrap.append(el('span', 'work-panel-error', () => t('Outcome unknown — inspect existing work before retrying.')));
      }
    } else {
      wrap.append(el('span', 'work-list-meta', () => t('No local operation recorded yet.')));
    }
    if (agent.checkpoint_ref) wrap.append(badge(() => t('Checkpoint recorded'), ''));
    if (agent.recovery) {
      const recovery = agent.recovery;
      wrap.append(el('span', 'work-list-meta', () => t('recovery {0} · attempt {1} of {2}', [
        stateName(recovery.phase), recovery.attempts, recovery.episodes
      ])));
      if (recovery.next_attempt_at > 0) wrap.append(el('span', 'work-list-meta', () => t('Next recovery attempt: {0}', [clockTime(recovery.next_attempt_at)])));
    }
    if (agent.conversation_id) {
      const open = el('button', 'btn', () => t('Open chat')) as HTMLButtonElement;
      open.type = 'button';
      const sessionId = agent.session_id;
      open.disabled = !sessionId;
      if (sessionId) open.addEventListener('click', () => options.openChat(sessionId));
      wrap.append(open);
    }
    return wrap;
  }

  /**
   * The same-conversation connection of the chat this window is displaying to one work.
   *
   * Three facts are kept apart on purpose, because collapsing them would each be a different lie:
   * which chat this window is showing (the chat screen's own selection), whether the host reports
   * a binding for it at all (`null` is a real answer: no connection), and whether that binding is
   * enabled and points at the selected work. A disabled binding is history — the ledger never
   * deletes one — so it reads as "not connected", not as connected-but-quiet.
   *
   * The buttons say exactly what the connection does. Connecting authorizes new messages in this
   * saved thread to be relayed to the work from now on; disconnecting stops new automatic relay
   * and report delivery. Neither one cancels the work, and the copy says so rather than leaving a
   * user to fear that disconnecting stops the run.
   */
  function connectionView(workId: string): HTMLElement | null {
    const sessionId = currentChat();
    const wrap = el('div', 'work-connection');

    if (!sessionId) {
      // No chat is open, so there is no thread this window could connect — and nothing here knows
      // whether some other chat drives this work. Claiming "not connected" would be a statement
      // about a conversation this window cannot see, so the pane says only what it knows.
      wrap.append(
        el('p', 'work-status-line', () => t('No chat is open in this window. Open the chat this work should be driven from, then connect it here.'))
      );
      return section(() => t('Chat connection'), wrap);
    }

    const read = connection;
    const mine = read && read.sessionId === sessionId && read.workId === workId ? read.binding : null;
    const known = read !== null && read.sessionId === sessionId && read.workId === workId && read.error === null;
    const connected = known && mine !== null && mine.enabled && mine.work_id === workId;
    const elsewhere = known && mine !== null && mine.enabled && mine.work_id !== workId;

    const badges = el('div', 'work-badges');
    if (!known) {
      // The host has not answered for this exact pair yet — or refused to. That is not "not
      // connected", so the pane says what it actually knows: nothing yet.
      badges.append(badge(() => t('Checking…'), 'wait'));
    } else if (connected) {
      badges.append(badge(() => t('Connected'), 'live'));
    } else if (elsewhere) {
      badges.append(badge(() => t('Connected to another work'), 'wait'));
    } else {
      badges.append(badge(() => t('Not connected')));
    }
    wrap.append(badges);

    if (read && read.sessionId === sessionId && read.workId === workId && read.error !== null) {
      // The host refused this read, so the pane does not know whether this chat is connected. It
      // says that in the host's own words and offers no control, because a connect or disconnect
      // sent from here would be acting on an answer nobody has.
      wrap.append(el('p', 'work-panel-error', read.error));
    }

    if (known && mine && mine.enabled) {
      const details = rowsOf([
        row(() => t('Conversation'), mine.conversation_id, true),
        row(() => t('Connected at'), ago(mine.bound_at)),
        row(() => t('Connected work'), mine.work_id, true)
      ]);
      if (details) wrap.append(details);
    }

    // The copy states the connection that actually exists. When this chat drives another work, the
    // sentence about *this* work being relayed would be false, so it names the state instead.
    wrap.append(el('p', 'work-status-line', () => elsewhere
      ? t('This chat is connected to another work, so its messages are not relayed here. Disconnect it there to connect it to this work.')
      : t('New messages in this chat are relayed to this work while it is connected. Disconnecting stops new automatic relay and report delivery; it does not cancel the work.')));

    const actions = el('div', 'work-actions');
    if (elsewhere && mine) {
      // This chat drives another work. Disconnecting never deletes the durable row, so the way out
      // is to release it from the work it actually drives — named here, not guessed.
      const release = el('button', 'btn', () => t('Disconnect this chat')) as HTMLButtonElement;
      release.type = 'button';
      release.disabled = connectionBusy;
      const owner = mine.work_id;
      release.addEventListener('click', () => setConnection(sessionId, owner, false));
      actions.append(release);
    } else if (connected) {
      const off = el('button', 'btn', () => t('Disconnect this chat')) as HTMLButtonElement;
      off.type = 'button';
      off.disabled = connectionBusy;
      off.addEventListener('click', () => setConnection(sessionId, workId, false));
      actions.append(off);
    } else if (known) {
      const on = el('button', 'btn btn-solid', () => t('Connect this chat')) as HTMLButtonElement;
      on.type = 'button';
      on.disabled = connectionBusy;
      on.addEventListener('click', () => setConnection(sessionId, workId, true));
      actions.append(on);
    }
    if (actions.childElementCount) wrap.append(actions);

    // The relay's transport, stated plainly: it drives the saved ChatGPT thread, so the desktop
    // browser has to stay reachable, and a native mobile MCP client is not a supported transport.
    wrap.append(el('p', 'work-status-line', () =>
      t('The relay uses this chat’s synced thread, so the desktop browser must stay available. A native mobile custom MCP client is not supported.')));

    if (connectionNote && connectionNote.sessionId === sessionId && connectionNote.workId === workId) {
      const note = connectionNote;
      const line = statusLine();
      ui(line, 'textContent', () => note.note());
      wrap.append(line);
    }

    return section(() => t('Chat connection'), wrap);
  }

  function statusView(current: WorkStatus): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const head = el('div', 'work-panel-head');
    head.append(el('h2', '', current.title || current.goal));
    const badges = el('div', 'work-badges');
    badges.append(badge(() => stateName(current.status), STATE_TONE[current.status] ?? ''));
    if (current.desired_state) {
      const desired = current.desired_state;
      badges.append(badge(() => t('requested: {0}', [stateName(desired)]), 'wait'));
    }
    if (current.model) badges.append(badge(current.model));
    if (current.reasoning) badges.append(badge(current.reasoning));
    head.append(badges);
    head.append(el('p', 'work-panel-goal', current.goal));
    nodes.push(head);

    const connectionSection = options.currentSession ? connectionView(current.work_id) : null;
    if (connectionSection) nodes.push(connectionSection);

    const location = rowsOf([
      row(() => t('Project'), current.project_path, true),
      row(() => t('Result branch'), current.integration_branch, true),
      row(() => t('Result worktree'), current.integration_worktree, true),
      row(() => t('Base commit'), shortCommit(current.base_commit), true),
      row(() => t('Max workers'), String(current.max_workers)),
      row(() => t('Revision'), String(current.revision)),
      row(() => t('Updated'), ago(current.updated_at)),
      // The durable continuation chain, verbatim ids: a completed work that was continued names
      // the successor, and a successor names what it continues.
      row(() => t('Continues work'), current.predecessor_work_id, true),
      row(() => t('Continued by'), current.successor_work_id, true)
    ]);
    const locationSection = section(() => t('Result location'), location);
    if (locationSection) nodes.push(locationSection);

    if (current.blocker) {
      const blocker = current.blocker;
      const wrap = el('div', 'work-blocker');
      // The machine code is the contract: it is shown verbatim beside its readable label.
      wrap.append(
        el('strong', '', () => stateName(blocker.code)),
        el('span', 'work-blocker-code', blocker.code),
        el('p', '', blocker.detail)
      );
      if (blocker.operation_id) {
        wrap.append(el('span', 'work-blocker-code', blocker.operation_id));
      }
      const blockerSection = section(() => t('Blocker'), wrap);
      if (blockerSection) nodes.push(blockerSection);
    }

    const agents = el('ul', 'work-tree');
    if (current.prime) agents.append(agentRow(current.prime));
    for (const agent of current.agents) {
      if (agent.agent_id === current.prime?.agent_id) continue;
      agents.append(agentRow(agent));
    }
    const agentSection = agents.childElementCount ? section(() => t('Prime and workers'), agents) : null;
    if (agentSection) nodes.push(agentSection);

    const operation = latestOperation(current, current.prime);
    const progress = rowsOf([
      row(() => t('Last operation'), operation ? () => `${operation.tool} · ${stateName(operation.state)}` : null),
      row(() => t('Result reference'), operation?.result_ref ?? null, true),
      row(() => t('Checkpoint revision'), current.checkpoint ? String(current.checkpoint.revision) : null)
    ]);
    const progressSection = progress ? section(() => t('Progress'), progress) : null;
    if (progressSection) nodes.push(progressSection);

    if (current.recovery) {
      const recovery = current.recovery;
      const recoveryRows = rowsOf([
        row(() => t('Recovery'), () => stateName(recovery.phase)),
        row(() => t('Attempts'), String(recovery.attempts)),
        row(() => t('Episodes'), String(recovery.episodes)),
        row(() => t('Next attempt'), ago(recovery.next_attempt_at))
      ]);
      const recoverySection = recoveryRows ? section(() => t('Recovery'), recoveryRows) : null;
      if (recoverySection) nodes.push(recoverySection);
    }

    if (current.checkpoint) {
      const checkpoint = current.checkpoint;
      const wrap = el('div');
      wrap.append(el('p', 'work-panel-goal', checkpoint.summary));
      if (checkpoint.host_generated) {
        wrap.append(el('span', 'work-list-meta', () => t('Written by the host from recorded facts, not the model.')));
      }
      if (checkpoint.remaining.length) {
        const remaining = el('ul', 'work-pending');
        for (const item of checkpoint.remaining) remaining.append(el('li', '', item));
        wrap.append(el('h3', '', () => t('Remaining')), remaining);
      }
      wrap.append(el('span', 'work-list-meta', () => t('checkpoint revision {0} · {1}', [
        checkpoint.revision, ago(checkpoint.updated_at)
      ])));
      const checkpointSection = section(() => t('Checkpoint'), wrap);
      if (checkpointSection) nodes.push(checkpointSection);
    }

    if (current.checkpoint?.verification.length) {
      const checks = el('ul', 'work-checks');
      for (const check of current.checkpoint.verification) {
        const item = el('li', 'work-check');
        item.dataset.outcome = check.outcome;
        item.append(el('b', '', check.outcome), el('span', '', check.operation_id));
        checks.append(item);
      }
      const checkSection = section(() => t('Verified checks'), checks);
      if (checkSection) nodes.push(checkSection);
    }

    if (current.pending_commands.length) {
      const pending = el('ul', 'work-pending');
      for (const command of current.pending_commands) {
        const item = el('li');
        item.append(el('span', '', () => t('{0} · {1} · attempt {2}', [
          command.text_preview || t('{0} request', [command.kind]),
          stateName(command.delivery_state),
          command.attempts
        ])));
        // `queued` and `unknown` are the two states that are *not* an acknowledgement, and they
        // mean different things to the user: one is held by the outbox, the other had an ambiguous
        // hand-off that is still being reconciled. Neither is a failure, and saying so is the
        // difference between a truthful pane and one that reads as a lost instruction.
        if (command.delivery_state === 'queued') {
          item.append(el('span', 'work-list-meta', () => t('Held by the outbox; the chat has not taken this instruction yet.')));
        } else if (command.delivery_state === 'unknown') {
          item.append(el('span', 'work-list-meta', () => t('The hand-off is unconfirmed and still being reconciled. It is not a failure.')));
        }
        pending.append(item);
      }
      const pendingSection = section(() => t('Pending instructions'), pending);
      if (pendingSection) nodes.push(pendingSection);
    }

    const unknown = current.operations.filter(operation => operation.state === 'outcome_unknown');
    if (unknown.length) {
      const wrap = el('div');
      for (const item of unknown) {
        const card = el('div', item.resolution ? 'work-blocker' : 'work-blocker is-open');
        const tool = item.tool;
        card.append(
          el('strong', '', () => t('Unknown outcome · {0}', [tool])),
          el('span', 'work-blocker-code', item.operation_id)
        );
        if (item.result_ref) card.append(el('span', 'work-blocker-code', item.result_ref));
        if (item.resolution) {
          // Already decided. Show the recorded decision instead of offering it again; the
          // service would reject a second one, and the user should see why.
          const retryAuthorized = item.resolution === 'authorize_retry';
          card.append(el('p', '', () => retryAuthorized
            ? t('One retry was authorized for this operation.')
            : t('The observed effects of this operation were accepted.')));
          if (item.retry_operation_id) card.append(el('span', 'work-blocker-code', item.retry_operation_id));
          wrap.append(card);
          continue;
        }
        // The note is the user's own text and is keyed by this work and this exact operation, so
        // it survives every repaint but can never follow the user to another work or another
        // unknown operation.
        const audit = auditNote(current.work_id, item.operation_id);
        const actions = el('div', 'work-actions');
        const accept = el('button', 'btn', () => t('Accept observed effects')) as HTMLButtonElement;
        accept.type = 'button';
        accept.disabled = busy;
        accept.addEventListener('click', () => resolve(current.work_id, item, 'accept_observed_effects', audit.input.value.trim()));
        const retry = el('button', 'btn is-danger', () => t('Authorize one retry')) as HTMLButtonElement;
        retry.type = 'button';
        retry.disabled = busy;
        retry.addEventListener('click', () => resolve(current.work_id, item, 'authorize_retry', audit.input.value.trim()));
        actions.append(accept, retry);
        card.append(audit.root, actions);
        wrap.append(card);
      }
      const unknownSection = section(() => t('Unknown operations'), wrap);
      if (unknownSection) nodes.push(unknownSection);
    }

    const actions = el('div', 'work-actions');
    const settled = current.status === 'cancelled' || current.status === 'completed';
    const pause = el('button', 'btn', () => t('Pause')) as HTMLButtonElement;
    pause.type = 'button';
    pause.disabled = busy || settled || current.desired_state === 'paused';
    pause.addEventListener('click', () => control('pause', current.work_id));
    const resume = el('button', 'btn', () => t('Resume')) as HTMLButtonElement;
    resume.type = 'button';
    resume.disabled = busy || settled || current.desired_state !== 'paused';
    resume.addEventListener('click', () => control('resume', current.work_id));
    const cancel = el('button', 'btn is-danger', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    cancel.disabled = busy || settled || current.desired_state === 'cancelled';
    cancel.addEventListener('click', () => control('cancel', current.work_id));
    actions.append(pause, resume, cancel);
    if (current.integration_worktree) {
      const reveal = el('button', 'btn', () => t('Open result folder')) as HTMLButtonElement;
      reveal.type = 'button';
      reveal.addEventListener('click', () => {
        void call(window.api.workReveal({ work_id: current.work_id }), () => selected === current.work_id);
      });
      actions.append(reveal);
    }
    const sessionId = current.prime?.session_id;
    if (sessionId) {
      const chat = el('button', 'btn', () => t('Open main chat')) as HTMLButtonElement;
      chat.type = 'button';
      chat.addEventListener('click', () => options.openChat(sessionId));
      actions.append(chat);
    }
    const actionSection = section(() => t('Controls'), actions);
    if (actionSection) nodes.push(actionSection);

    nodes.push(instructionBox(current.work_id).root);

    const clock = el('p', 'work-status-line');
    if (lastControl?.workId !== current.work_id) {
      ui(clock, 'textContent', () => t('No work control from this window yet.'));
    } else {
      // This window's own last accepted control, re-read on a language change like any other
      // app copy. The clock time belongs to the moment the control was accepted, not to the
      // repaint.
      const accepted = lastControl;
      ui(clock, 'textContent', () => `${accepted.note()} · ${clockTime(accepted.at)}`);
    }
    nodes.push(clock);

    if (events.length) {
      const feed = el('ul', 'work-events');
      for (const event of [...events].reverse()) {
        const item = el('li', 'work-event');
        const summary = eventSummary(event);
        item.append(el('time', '', clockTime(event.at)), el('span', '', summary ? `${event.kind} · ${summary}` : event.kind));
        feed.append(item);
      }
      const feedSection = section(() => t('Activity'), feed);
      if (feedSection) nodes.push(feedSection);
    }
    return nodes;
  }

  function paint(): void {
    const focus = captureFocus();
    const nodes: HTMLElement[] = [error];
    if (formOpen) {
      const form = startForm();
      form.rebind();
      form.sync();
      nodes.push(form.root);
    }
    nodes.push(...listView());
    if (selected && status) nodes.push(...statusView(status));
    else if (selected) nodes.push(el('p', 'work-panel-empty', () => t('Loading work…')));
    body.replaceChildren(...nodes);
    restoreFocus(focus);
    // The connection section paints from whatever the host last said; this asks only when the
    // displayed chat or the selected work changed, so a repaint is never a new request.
    syncConnection();
  }

  function show(): void {
    options.onShow?.();
    pane.hidden = false;
    options.host.classList.add('has-work-panel');
    options.toggle.setAttribute('aria-expanded', 'true');
    options.onVisibility?.(true);
    paint();
    void reload();
  }

  function hide(): void {
    // Retire every in-flight read so a late reply cannot repaint a closed pane, and forget the
    // pair that was asked about: a reply discarded here must not make the next open believe the
    // same question was already answered.
    listGeneration++;
    statusGeneration++;
    connectionGeneration++;
    connectionPair = null;
    connection = null;
    pane.hidden = true;
    options.host.classList.remove('has-work-panel');
    options.toggle.setAttribute('aria-expanded', 'false');
    options.onVisibility?.(false);
  }

  newWork.addEventListener('click', () => {
    formOpen = !formOpen;
    newWork.setAttribute('aria-expanded', String(formOpen));
    paint();
  });
  refresh.addEventListener('click', () => {
    fail(null);
    void reload();
    // The explicit refresh is the user's own retry, including for a connection read that was
    // refused: without this the pane would keep showing "Checking…" until the displayed pair
    // changed on its own.
    syncConnection(true);
  });
  options.toggle.addEventListener('click', () => { if (pane.hidden) show(); else hide(); });
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    hide();
    options.toggle.focus();
  });

  /**
   * The ledger's own change bus is the only refresh trigger. The panel never polls: a push
   * carries the revision the ledger allocated with the change, so a repeat notification of the
   * same state does not cause a second read.
   */
  window.api.onWorkChanged(change => {
    if (pane.hidden) return;
    void reload();
    // A binding change is written against the work the binding now names, which is not
    // necessarily the selected one: connecting this chat to another work moves it there. The
    // kind is compared as the ledger's own string, because importing the constant would pull the
    // work schema's validator into the renderer bundle.
    if (change.kind === 'controller_binding_changed') syncConnection(true);
    if (change.work_id === selected) void load(change.work_id);
  });

  return {
    show,
    hide,
    fail,
    /**
     * Re-reads the connection for the chat this window is now displaying.
     *
     * The chat screen owns the selection, so the pane cannot learn about a switch from the ledger
     * bus: it is told. The read itself is skipped when the displayed chat and the selected work are
     * the same pair already in hand, so calling this on every session repaint costs nothing.
     */
    sync: (): void => { syncConnection(); },
    isOpen: (): boolean => !pane.hidden
  };
}
