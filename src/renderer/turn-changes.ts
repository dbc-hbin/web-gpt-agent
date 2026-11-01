import { isWorkerAgent, type SessionEvent } from '../shared/session.js';
import type { TurnFileChange } from '../main/session/turn-changes.js';
import { el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';
import { positionOf } from '../shared/chronology.js';

/**
 * The "Changed files" summary under a finished answer that edited files. Collapsed, always: one
 * line with the files the answer really changed and their net +/-. A file changed and put back in
 * the same answer is named apart ("1 put back"), never counted as changed. Open, each file once,
 * in the order it was first changed, with its net diff on demand; approximate counts and diffs the
 * recording did not keep say so. Open in Review hands over to the Review panel. The answer's tool
 * rows stay the step-by-step record.
 */

/** One of the chat's own successful calls in this turn that recorded edits; a worker's are not. */
export function ownTurnEdit(event: SessionEvent, turnId: string): event is Extract<SessionEvent, { kind: 'tool_call' }> {
  return event.kind === 'tool_call' && event.turnId === turnId && !isWorkerAgent(event.agent) &&
    event.call.outcome === 'ok' && (event.call.changes?.length ?? 0) > 0;
}

/** How many of the chat's own calls in this turn recorded a successful edit, as loaded; a worker's do not count. */
export function turnEditCount(events: readonly SessionEvent[], turnId: string): number {
  return events.filter(event => ownTurnEdit(event, turnId)).length;
}

/** The message id of a turn's last final answer as loaded: the one the card sits under. */
export function turnAnswerMessage(events: readonly SessionEvent[], turnId: string): string | null {
  let answer: SessionEvent | null = null;
  for (const event of events)
    if (event.kind === 'assistant_message' && event.turnId === turnId && event.messageId && (event.final || event.state === 'final') &&
        (!answer || positionOf(event) >= positionOf(answer))) answer = event;
  return answer?.kind === 'assistant_message' ? answer.messageId ?? null : null;
}

/**
 * Whether the turn is over: its latest boundary is its end, or another turn began after both its
 * answer and that boundary. A turn that started again after its answer runs until one does.
 */
export function turnFinished(events: readonly SessionEvent[], turnId: string, anchorSeq: number): boolean {
  let latest: SessionEvent | null = null;
  for (const event of events)
    if ((event.kind === 'turn_start' || event.kind === 'turn_end') && event.turnId === turnId && (!latest || event.seq > latest.seq)) latest = event;
  if (latest?.kind === 'turn_end') return true;
  const after = Math.max(anchorSeq, latest?.seq ?? anchorSeq);
  return events.some(event => event.seq > after && event.kind === 'turn_start' && event.turnId !== turnId);
}

/** The turn's own first start, if loaded; an app-authored reopening (with `detail`) never stands in for it. */
export function firstTurnStart(events: readonly SessionEvent[], turnId: string): SessionEvent | undefined {
  return events.find(event => event.kind === 'turn_start' && event.turnId === turnId && !event.detail);
}

/** Where a turn's edits are read from: its first start when that is loaded, else the chat's start. */
export function turnFrom(events: readonly SessionEvent[], turnId: string): number {
  return firstTurnStart(events, turnId)?.seq ?? 0;
}

const MAX_DIFF_CHARS = 512 * 1024;

function counts(change: Pick<TurnFileChange, 'added' | 'removed' | 'approximate' | 'state'>): string {
  const parts = [change.added || change.state === 'created' ? `+${change.added}` : '', change.removed || change.state === 'deleted' ? `\u2212${change.removed}` : '']
    .filter(Boolean).join(' ');
  return parts && change.approximate ? `${parts}${t(" (approx.)")}` : parts;
}

const STATE_WORDS: Record<TurnFileChange['state'], () => string> = {
  edited: () => t("edited"), created: () => t("created"), deleted: () => t("deleted"), unchanged: () => t("no net change")
};

function headline(changes: readonly TurnFileChange[], total: number): string {
  const changed = changes.filter(change => change.state !== 'unchanged');
  const putBack = changes.length - changed.length;
  const more = Math.max(0, total - changes.length);
  if (!changed.length && !more) return t("Touched {0} files, no net change", [putBack]);
  const sum = { added: changed.reduce((n, c) => n + c.added, 0), removed: changed.reduce((n, c) => n + c.removed, 0),
    approximate: changed.some(change => change.approximate) };
  return [t("Changed {0} files", [changed.length]), `+${sum.added} \u2212${sum.removed}${sum.approximate ? t(" (approx.)") : ''}`,
    ...(putBack ? [t("{0} put back", [putBack])] : []), ...(more ? [t("{0} more not listed", [more])] : [])].join(' \u00b7 ');
}

export function renderTurnChanges(options: {
  sessionId: string; turnId: string; from: number; current: () => boolean; openReview: (() => void) | null;
}): HTMLElement {
  const card = document.createElement('details');
  card.className = 'turn-changes';
  card.hidden = true;
  const head = el('summary', 'turn-changes-head');
  const list = el('div', 'turn-changes-list');
  card.append(head, list);
  void (async () => {
    const reply = await run(window.api.turnChanges(options.sessionId, options.turnId, options.from));
    if (!reply || !reply.changes.length || !options.current() || !card.isConnected) return;
    const { changes, total } = reply;
    head.replaceChildren(el('span', 'turn-changes-title', () => headline(changes, total)), icon('i-chev', 'ico turn-changes-chevron'));
    for (const change of changes) list.append(fileRow(change, options));
    if (total > changes.length) list.append(el('p', 'meta', () => t("and {0} more", [total - changes.length])));
    if (options.openReview) {
      const review = el('button', 'btn turn-changes-review', () => t("Open in Review")) as HTMLButtonElement;
      review.type = 'button';
      review.addEventListener('click', () => { if (options.current()) options.openReview?.(); });
      list.append(review);
    }
    card.hidden = false;
  })();
  return card;
}

function fileRow(change: TurnFileChange, options: { sessionId: string; turnId: string; from: number; current: () => boolean }): HTMLElement {
  const row = document.createElement('details');
  row.className = 'turn-change';
  row.dataset.state = change.state;
  const head = el('summary', 'turn-change-head');
  head.append(el('span', 'turn-change-path', change.path));
  const shown = counts(change);
  if (shown && change.state !== 'unchanged') head.append(el('span', 'turn-change-count', () => counts(change)));
  head.append(el('span', 'turn-change-state', STATE_WORDS[change.state]));
  ui(head, 'title', () => change.path);
  const viewport = el('div', 'turn-change-diff');
  row.append(head, viewport);
  let loaded = false;
  let viewer: { destroy(): void } | null = null;
  const say = (message: () => string) => { viewer?.destroy(); viewer = null; viewport.replaceChildren(el('p', 'meta', message)); };
  row.addEventListener('toggle', async () => {
    if (!row.open || loaded || !options.current()) return;
    loaded = true;
    if (change.state === 'unchanged') { say(() => t("Changed and put back in this answer: no net change.")); return; }
    if (change.diff !== 'kept') { say(() => t("Diff unavailable: this edit was not kept")); return; }
    say(() => t("Loading diff…"));
    const ends = await run(window.api.turnFileDiff(options.sessionId, options.turnId, options.from, change.path));
    if (!options.current() || !row.isConnected) return;
    if (!ends || ends.before.length + ends.after.length > MAX_DIFF_CHARS) { loaded = false; say(() => t("Recorded edit is unavailable.")); return; }
    const module = await import('./file-code-editor.js');
    if (!options.current() || !row.isConnected) return;
    const host = el('div', 'file-code-editor-host file-diff-viewer-host');
    viewport.replaceChildren(host);
    viewer = await module.createProjectDiffViewer({ parent: host, filename: change.path, baseText: ends.before, currentText: ends.after });
    if (!options.current() || !row.isConnected) { viewer.destroy(); viewer = null; }
  });
  return row;
}
