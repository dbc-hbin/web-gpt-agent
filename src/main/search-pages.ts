/**
 * Retained, paged search for ordinary and managed calls.
 *
 * Managed agent work must be able to page through a large result set without the whole run
 * ever existing as one string: every page is a separately persisted artifact, and a cursor
 * names exactly one page *plus a position inside it*. That last part matters — a caller may
 * ask for 10 results from a page that retains 500, and the cursor has to come back for the
 * remaining 490 rather than jumping to the next page and silently dropping them.
 *
 * Page text lives in the session asset store (the same content-addressed storage commands
 * and images already use), and the metadata row lives in `work_artifacts`. Both are written
 * before the cursor is returned, so a cursor that was handed out always resolves.
 *
 * Durable managed cursors keep their deployed `<artifact_id>:<offset>` format and work/session
 * ownership. Ordinary cursors use unguessable run ids with an in-process bounded lifetime and
 * revalidate the live filesystem scope on each read.
 */

import { createHash, randomUUID } from 'node:crypto';
import { rawPromises as fs } from './rawfs.js';
import { resolvePath } from './sandbox.js';
import { getConfig } from './config.js';
import { executionPrincipal } from './codex/ownership.js';
import { requestCorrelation } from './session/correlation.js';
import type { Root } from '../shared/types.js';
import type { CallContext } from './mcp/call-context.js';
import { formatBytes } from './fsops.js';
import { readOverflowText } from './session/store.js';
import type { WorkArtifactRow } from './work/store.js';
import {
  DEFAULT_EXCLUDES,
  MAX_CONTENT_FILE_BYTES,
  SEARCH_MAX_HITS,
  SEARCH_PAGE_BYTES,
  SEARCH_PAGE_HITS,
  SEARCH_PAGE_RESERVE_BYTES,
  SEARCH_REQUIRED_ENGINE,
  SEARCH_TIME_BUDGET_MS,
  clipPreview,
  searchStream,
  type SearchStreamHit
} from './search.js';

/** The stable owner of a retained search: the work and session, never the conversation. */
export interface SearchOwner {
  workId: string;
  agentId: string | null;
  sessionId: string;
}

/** One page handed to the artifact store. The store writes the text and returns the row. */
export interface SearchArtifactRecord {
  workId: string;
  agentId: string | null;
  sessionId: string;
  kind: string;
  queryHash: string | null;
  pageIndex: number;
  pageCount: number;
  hitCount: number;
  totalHits: number;
  truncatedReason: string | null;
  text: string;
}

/** The artifact ledger, provided by the work runtime. */
export interface SearchArtifactStore {
  recordArtifact(input: SearchArtifactRecord): Promise<WorkArtifactRow>;
  getArtifact(cursor: string): Promise<WorkArtifactRow | null>;
  listArtifacts(input: { workId: string; kind?: string; queryHash?: string }): Promise<WorkArtifactRow[]>;
}

export interface ManagedSearchDeps {
  artifacts: SearchArtifactStore;
}

export interface ManagedSearchRequest {
  realDir: string;
  virtualDir: string;
  query: string;
  mode: 'name' | 'content';
  include?: string | undefined;
  exclude?: readonly string[];
  caseSensitive?: boolean;
  regex?: boolean;
  maxResults?: number;
  /** True when `realDir` names a file rather than a directory. Detected when omitted. */
  targetIsFile?: boolean;
}

export interface OrdinarySearchRequest {
  query?: string;
  cursor?: string;
  path?: string;
  mode?: 'name' | 'content';
  include?: string;
  exclude?: readonly string[];
  case_sensitive?: boolean;
  regex?: boolean;
  max_results?: number;
}

/** A paged hit. `clipped` means `text` is a preview; read the file at `path`/`line`. */
export interface SearchPageHit {
  path: string;
  line?: number;
  text?: string;
  clipped?: boolean;
  line_chars?: number;
}

export interface ManagedSearchPage {
  hits: SearchPageHit[];
  next_cursor: string | null;
  /** Why this response is not the whole retained run, if it is not. */
  truncated: 'page' | 'scan' | 'hits' | null;
  stopped_because: 'limit' | 'time' | 'files' | 'size' | 'hits' | null;
  elapsed_ms: number | null;
  files_scanned: number | null;
  engine: typeof SEARCH_REQUIRED_ENGINE;
  /**
   * The per-file size ceiling content search applies, or null for a filename search.
   *
   * Stated on every content response because files above it are skipped rather than read, and a
   * result set that silently excludes them would imply it covered the whole tree.
   */
  content_file_limit: number | null;
  page: {
    index: number;
    count: number;
    /** Hits retained on this stored page. */
    hit_count: number;
    /** Hits in this response; smaller than `hit_count` when max_results asked for fewer. */
    returned: number;
    total_hits: number;
  };
}

/** A managed search failure with a code the model can act on. */
export class SearchPageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SearchPageError';
    this.code = code;
  }
}

const SEARCH_PAGE_KIND_PREFIX = 'search_page';

/**
 * The artifact kind records the mode, because it is the only durable place that can.
 *
 * `work_artifacts` is the ledger's table and has no mode column, and paging a retained page must
 * not re-derive anything from the live tree. Encoding the mode in the kind keeps a page
 * self-describing: a filename page and a content page are never mixed into one walk, and the
 * response can state the per-file size ceiling that only content search applies.
 */
function artifactKind(mode: 'name' | 'content'): string {
  return `${SEARCH_PAGE_KIND_PREFIX}:${mode}`;
}

function modeOfKind(kind: string): 'name' | 'content' | null {
  if (kind === `${SEARCH_PAGE_KIND_PREFIX}:content`) return 'content';
  if (kind === `${SEARCH_PAGE_KIND_PREFIX}:name`) return 'name';
  return null;
}

const DEFAULT_PAGE_RESULTS = 50;
const MAX_PAGE_RESULTS = SEARCH_PAGE_HITS;
/**
 * How much of an offending path a refusal message may quote.
 *
 * The path is exactly what did not fit, so quoting it in full would rebuild the over-budget
 * response in the error. A short preview still identifies which record it was.
 */
const REFUSAL_PATH_CHARS = 128;

function pageError(code: string, message: string): SearchPageError {
  return new SearchPageError(code, message);
}

/**
 * Identity of one retained run.
 *
 * The canonical query and a per-run nonce together, so pages written by two runs of the same
 * question can never be spliced into one another's walk. Paging is driven by the cursor, never
 * by re-running the query, so nothing needs the hash to be reproducible across runs — but the
 * artifact row still records which question produced the page.
 */
export function searchRunHash(owner: SearchOwner, req: ManagedSearchRequest, runId: string): string {
  const canonical = JSON.stringify({
    work: owner.workId,
    real: req.realDir,
    virtual: req.virtualDir,
    query: req.query,
    mode: req.mode,
    include: req.include ?? null,
    exclude: [...(req.exclude ?? DEFAULT_EXCLUDES)],
    caseSensitive: req.caseSensitive === true,
    regex: req.regex === true,
    run: runId
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function clampResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_RESULTS;
  return Math.min(MAX_PAGE_RESULTS, Math.max(1, Math.floor(value)));
}

/** Whether the scope names one regular file, which changes how the engine is invoked. */
async function isFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Cursors name an artifact and offset; ordinary artifact ids also carry a page index. */
function formatCursor(artifactId: string, offset: number): string {
  return `${artifactId}:${offset}`;
}

/** Deployed managed UUID cursors and in-process ordinary run/page cursors never overlap. */
export function parseSearchCursor(cursor: string): { artifactId: string; offset: number; storage: 'ordinary' | 'managed' } | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.(0|[1-9]\d*))?:(0|[1-9]\d*)$/i.exec(cursor);
  if (!match) return null;
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(offset) || (match[2] !== undefined && !Number.isSafeInteger(Number(match[2])))) return null;
  return { artifactId: match[1]! + (match[2] === undefined ? '' : `.${match[2]}`),
    offset, storage: match[2] === undefined ? 'managed' : 'ordinary' };
}

/**
 * One retained page, held as its own hits until the run ends.
 *
 * Pages are persisted once the whole run is known, because `page_count` is part of the row and
 * a provisional count would be a lie about how much of the run is retrievable. What is held is
 * exactly the retained set the hit ceiling already bounds — never one concatenated string.
 */
interface PendingPage {
  hits: SearchStreamHit[];
  bytes: number;
}

function parsePageMetadata(line: string): { elapsed_ms: number; files_scanned: number; stopped_because: string | null } | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === 'object' && value !== null && 'search_page_meta' in value && value.search_page_meta === 1 &&
        'elapsed_ms' in value && typeof value.elapsed_ms === 'number' &&
        'files_scanned' in value && typeof value.files_scanned === 'number') {
      return { elapsed_ms: value.elapsed_ms, files_scanned: value.files_scanned,
        stopped_because: 'stopped_because' in value && typeof value.stopped_because === 'string' ? value.stopped_because : null };
    }
  } catch { /* Legacy hit line. */ }
  return null;
}

function parsePageLines(lines: string[]): SearchPageHit[] {
  return lines.filter(line => line.length > 0).map(line => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw pageError('SEARCH_CURSOR_CORRUPT', 'retained search page contains invalid JSON.'); }
    if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string' ||
      ('line' in value && typeof value.line !== 'number') || ('text' in value && typeof value.text !== 'string')) {
      throw pageError('SEARCH_CURSOR_CORRUPT', 'retained search page contains an invalid hit.');
    }
    return value as SearchPageHit;
  });
}

/** The reason a finished run stopped, mapped to the response's truncation vocabulary. */
function truncationOf(reason: string | null): ManagedSearchPage['truncated'] {
  if (reason === 'hits') return 'hits';
  if (reason === null) return null;
  return 'scan';
}

function stoppedOf(reason: string | null): ManagedSearchPage['stopped_because'] {
  if (reason === 'limit' || reason === 'time' || reason === 'files' || reason === 'size' || reason === 'hits') {
    return reason;
  }
  return null;
}


interface CollectedPages { pages: PendingPage[]; terminalReason: string | null; totalHits: number; elapsedMs: number; filesScanned: number }

async function collectPages(requests: ManagedSearchRequest[], deadline?: number): Promise<CollectedPages> {
  const pageBudget = SEARCH_PAGE_BYTES - SEARCH_PAGE_RESERVE_BYTES;
  const pages: PendingPage[] = [];
  let current: PendingPage = { hits: [], bytes: 0 };
  let retainedHits = 0;

  // The records the engine reported that could not fit any page. Checked before any success is
  // returned, because a result that silently omits one would be a lie about what matched.
  let tooLargeCount = 0;
  let firstTooLarge: SearchStreamHit | null = null;

  const push = (hit: SearchStreamHit): void => {
    const cost = Buffer.byteLength(JSON.stringify(hit), 'utf8');
    // A record that cannot fill an empty page can never be inlined at any page size — a virtual
    // path alone can carry thousands of escaped characters. Truncating it would hand back a path
    // that names nothing and omitting it would report fewer matches than exist, so the search
    // fails explicitly instead of returning either.
    if (cost > pageBudget) {
      tooLargeCount++;
      firstTooLarge ??= hit;
      return;
    }
    // Decide *before* adding, so a page never overshoots by a whole hit.
    if (current.hits.length > 0 && (current.bytes + cost > pageBudget || current.hits.length >= SEARCH_PAGE_HITS)) {
      pages.push(current);
      current = { hits: [], bytes: 0 };
    }
    current.hits.push(hit);
    current.bytes += cost;
    retainedHits++;
  };

  let elapsedMs = 0;
  let filesScanned = 0;
  let terminalReason: string | null = null;
  for (const req of requests) {
    if (deadline !== undefined && Date.now() >= deadline) { terminalReason = 'time'; break; }
    const outcome = await searchStream({
      realDir: req.realDir, virtualDir: req.virtualDir, query: req.query, mode: req.mode,
      include: req.include, exclude: req.exclude ?? DEFAULT_EXCLUDES,
      caseSensitive: req.caseSensitive === true, regex: req.regex === true,
      targetIsFile: req.targetIsFile ?? await isFile(req.realDir),
      maxHits: Math.max(1, SEARCH_MAX_HITS - retainedHits), deadline
    }, { onHit: push });
    elapsedMs += outcome.elapsedMs;
    filesScanned += outcome.filesScanned;
    terminalReason = outcome.stoppedBecause;
    if (terminalReason || retainedHits >= SEARCH_MAX_HITS) {
      terminalReason ??= 'hits';
      break;
    }
  }
  if (tooLargeCount > 0) {
    const first = firstTooLarge!;
    // The refusal is bounded like any other response. Naming the whole offending path would put
    // the very bytes that did not fit back into the reply — a path can carry tens of thousands of
    // escaped characters — so it is shown as a short preview and the exact size is reported as a
    // number instead.
    const preview = clipPreview(first.path, REFUSAL_PATH_CHARS, true).text;
    throw pageError(
      'SEARCH_RESULT_TOO_LARGE',
      `${tooLargeCount} match${tooLargeCount === 1 ? '' : 'es'} cannot fit a ${formatBytes(SEARCH_PAGE_BYTES)} search page, ` +
        `so no result was returned. The first begins ${JSON.stringify(preview)}` +
        `${first.line === undefined ? '' : ` (line ${first.line})`}, and needs ` +
        `${formatBytes(Buffer.byteLength(JSON.stringify(first), 'utf8'))} once its path and line are escaped. ` +
        'Narrow the search — a more specific query or a deeper path — so the matching record is smaller.'
    );
  }
  if (current.hits.length > 0) pages.push(current);

  return { pages, terminalReason, totalHits: retainedHits, elapsedMs, filesScanned };

}


export type SearchPage = ManagedSearchPage;

interface OrdinaryRun {
  owner: string | null;
  createdAt: number;
  scopes: Array<{ virtual: string; real: string; rootPath: string | null }>;
  pages: PendingPage[];
  rows: Array<{ artifact_id: string; truncated_reason: string | null }>;
  mode: 'name' | 'content';
  totalHits: number;
  elapsedMs: number;
  filesScanned: number;
  bytes: number;
}

const ordinaryRuns = new Map<string, OrdinaryRun>();
const ORDINARY_TTL_MS = 15 * 60_000;
const ORDINARY_MAX_BYTES = 64 * 1024 * 1024;
let ordinaryBytes = 0;
let ordinaryEpoch = 0;

/** Called when the MCP endpoint's security epoch ends. */
export function clearOrdinarySearchSnapshots(): void { ordinaryEpoch++; ordinaryRuns.clear(); ordinaryBytes = 0; }

function expireOrdinaryRuns(): void {
  const now = Date.now();
  for (const [id, run] of ordinaryRuns) {
    if (now - run.createdAt >= ORDINARY_TTL_MS) { ordinaryRuns.delete(id); ordinaryBytes -= run.bytes; }
  }
}

function ordinaryPrincipal(caller: CallContext | null): string | null {
  const requestId = caller?.caller.requestId ?? null;
  const exact = requestCorrelation(requestId);
  const session = exact?.sessionId ?? caller?.caller.sessionId ?? null;
  // A request id is a known principal even before exact session proof arrives.
  return executionPrincipal(requestId, session, true);
}

function sameOrdinaryPrincipal(owner: string | null, caller: string | null): boolean {
  if (owner === null || caller === null) return owner === caller;
  const canonical = (value: string): string => value.startsWith('request:')
    ? requestCorrelation(value.slice('request:'.length))?.sessionId ?? value : value;
  return canonical(owner) === canonical(caller);
}

async function validateOrdinaryScopes(roots: Root[], scopes: OrdinaryRun['scopes']): Promise<void> {
  for (const scope of scopes) {
    try {
      const resolved = await resolvePath(roots, scope.virtual, { allowMissing: true, fileAccessMode: getConfig().fileAccessMode });
      if (resolved.real !== scope.real || (resolved.root?.path ?? null) !== scope.rootPath ||
          (scope.rootPath === null && getConfig().fileAccessMode !== 'all-files')) {
        throw pageError('SEARCH_CURSOR_INVALID', 'search scope changed. Start a new search.');
      }
    } catch {
      throw pageError('SEARCH_CURSOR_INVALID', 'search scope is no longer available. Start a new search.');
    }
  }
}

function ordinaryPage(run: OrdinaryRun, index: number, offset: number, requested: number): SearchPage {
  const retained = run.pages[index];
  const row = run.rows[index];
  if (!retained || !row || offset >= retained.hits.length) throw pageError('SEARCH_CURSOR_INVALID', 'cursor offset is not in the retained page.');
  const page: SearchPage = {
    hits: retained.hits, next_cursor: null, truncated: null,
    stopped_because: stoppedOf(run.rows.at(-1)?.truncated_reason ?? null),
    elapsed_ms: run.elapsedMs, files_scanned: run.filesScanned, engine: SEARCH_REQUIRED_ENGINE,
    content_file_limit: run.mode === 'content' ? MAX_CONTENT_FILE_BYTES : null,
    page: { index, count: run.pages.length, hit_count: retained.hits.length, returned: 0, total_hits: run.totalHits }
  };
  return slicePage(page, row, run.rows, offset, requested);
}

/** Ordinary calls retain the same engine result/page shape without requiring managed work. */
export async function ordinarySearch(roots: Root[], caller: CallContext | null, input: OrdinarySearchRequest): Promise<SearchPage> {
  expireOrdinaryRuns();
  const epoch = ordinaryEpoch;
  const principal = ordinaryPrincipal(caller);
  if (input.cursor !== undefined) {
    const parsed = parseSearchCursor(input.cursor);
    const run = parsed?.storage === 'ordinary' ? ordinaryRuns.get(parsed.artifactId.split('.')[0]!) : null;
    if (!parsed || !run || !sameOrdinaryPrincipal(run.owner, principal)) {
      throw pageError('SEARCH_CURSOR_INVALID', 'cursor is unavailable to this caller. Start a new search.');
    }
    await validateOrdinaryScopes(roots, run.scopes);
    if (epoch !== ordinaryEpoch) throw pageError('SEARCH_CURSOR_EXPIRED', 'search endpoint restarted while reading snapshot.');
    const index = run.rows.findIndex(row => row.artifact_id === parsed.artifactId);
    if (index < 0) throw pageError('SEARCH_CURSOR_INVALID', 'cursor is not in this run.');
    return ordinaryPage(run, index, parsed.offset, clampResults(input.max_results));
  }
  if (!input.query) throw pageError('SEARCH_QUERY_REQUIRED', 'provide query or cursor.');
  const paths = input.path ? [input.path] : roots.map(root => '/' + root.name);
  if (paths.length === 0) throw pageError('SEARCH_SCOPE_REQUIRED', 'provide a path or approve a search root. No search ran.');
  const started = Date.now();
  const deadline = started + SEARCH_TIME_BUDGET_MS;
  const scopes: OrdinaryRun['scopes'] = [];
  const requests: ManagedSearchRequest[] = [];
  for (const scope of paths) {
    const resolved = await resolvePath(roots, scope, { fileAccessMode: getConfig().fileAccessMode });
    scopes.push({ virtual: scope, real: resolved.real, rootPath: resolved.root?.path ?? null });
    requests.push({ realDir: resolved.real, virtualDir: resolved.virtual, query: input.query,
      mode: input.mode ?? 'name', include: input.include, exclude: input.exclude,
      caseSensitive: input.case_sensitive, regex: input.regex, maxResults: input.max_results });
  }
  const result = await collectPages(requests, deadline);
  result.elapsedMs = Date.now() - started;
  if (epoch !== ordinaryEpoch) throw pageError('SEARCH_CURSOR_EXPIRED', 'search endpoint restarted before snapshot retention.');
  await validateOrdinaryScopes(roots, scopes);
  if (epoch !== ordinaryEpoch) throw pageError('SEARCH_CURSOR_EXPIRED', 'search endpoint restarted before snapshot retention.');
  const mode = input.mode ?? 'name';
  if (!result.pages.length) return { hits: [], next_cursor: null, truncated: truncationOf(result.terminalReason),
    stopped_because: stoppedOf(result.terminalReason), elapsed_ms: result.elapsedMs, files_scanned: result.filesScanned,
    engine: SEARCH_REQUIRED_ENGINE, content_file_limit: mode === 'content' ? MAX_CONTENT_FILE_BYTES : null,
    page: { index: 0, count: 0, hit_count: 0, returned: 0, total_hits: 0 } };
  const bytes = result.pages.reduce((sum, page) => sum + page.bytes + page.hits.length + 256, 0);
  const runId = randomUUID();
  const rows = result.pages.map((_, index) => ({ artifact_id: `${runId}.${index}`,
    truncated_reason: index === result.pages.length - 1 ? result.terminalReason : null }));
  const run: OrdinaryRun = { owner: principal, createdAt: Date.now(), scopes, pages: result.pages, rows, mode,
    totalHits: result.totalHits, elapsedMs: result.elapsedMs, filesScanned: result.filesScanned, bytes };
  const first = ordinaryPage(run, 0, 0, clampResults(input.max_results));
  if (first.next_cursor === null) return first;
  if (ordinaryRuns.size >= 128 || ordinaryBytes + bytes > ORDINARY_MAX_BYTES ||
      [...ordinaryRuns.values()].filter(candidate => sameOrdinaryPrincipal(candidate.owner, principal)).length >= 8) {
    throw pageError('SEARCH_SNAPSHOT_CAPACITY', 'retained search capacity is full; read existing cursors or wait for expiration.');
  }
  ordinaryRuns.set(runId, run);
  ordinaryBytes += bytes;
  return first;
}

/**
 * Runs one managed search and retains its result as bounded, separately persisted pages.
 *
 * Only the first page is returned; later pages are reached through `readSearchPage` with the
 * returned cursor. The engine is ripgrep or the call fails — a managed search never quietly
 * becomes a slower walker with different ordering and coverage.
 */
export async function managedSearch(
  deps: ManagedSearchDeps,
  owner: SearchOwner,
  req: ManagedSearchRequest
): Promise<ManagedSearchPage> {
  if (owner.sessionId.length === 0) {
    throw pageError('SEARCH_ARTIFACT_UNAVAILABLE', 'this worker has no stable session to retain search pages against. No search ran.');
  }
  const queryHash = searchRunHash(owner, req, randomUUID());
  const requested = clampResults(req.maxResults);
  // A single explicit file is a different engine invocation (no directory walk, no glob
  // filters applied by ripgrep), so the caller's explicit hint wins and the filesystem
  // decides otherwise.
  const { pages, terminalReason, totalHits, elapsedMs, filesScanned } = await collectPages([req]);
  const rows: WorkArtifactRow[] = [];
  for (const [index, page] of pages.entries()) {
    rows.push(
      await deps.artifacts.recordArtifact({
        workId: owner.workId,
        agentId: owner.agentId,
        sessionId: owner.sessionId,
        kind: artifactKind(req.mode),
        queryHash,
        pageIndex: index,
        pageCount: pages.length,
        hitCount: page.hits.length,
        totalHits,
        truncatedReason: index === pages.length - 1 ? terminalReason : null,
        text: JSON.stringify({ search_page_meta: 1, elapsed_ms: elapsedMs, files_scanned: filesScanned, stopped_because: terminalReason }) + '\n' + page.hits.map((hit) => JSON.stringify(hit)).join('\n')
      })
    );
  }

  const first = rows[0];
  if (!first) {
    return {
      hits: [],
      next_cursor: null,
      truncated: truncationOf(terminalReason),
      stopped_because: stoppedOf(terminalReason),
      elapsed_ms: elapsedMs,
      files_scanned: filesScanned,
      content_file_limit: req.mode === 'content' ? MAX_CONTENT_FILE_BYTES : null,
      engine: SEARCH_REQUIRED_ENGINE,
      page: { index: 0, count: 0, hit_count: 0, returned: 0, total_hits: 0 }
    };
  }
  // The first page is answered from what was just streamed rather than read back from the
  // asset it was written to: same bytes, one less filesystem round trip on the hot path.
  const firstPage: ManagedSearchPage = {
    hits: pages[0]!.hits.map((hit) => ({ ...hit })),
    next_cursor: null,
    truncated: null,
    stopped_because: stoppedOf(terminalReason),
    elapsed_ms: elapsedMs,
    files_scanned: filesScanned,
    content_file_limit: req.mode === 'content' ? MAX_CONTENT_FILE_BYTES : null,
    engine: SEARCH_REQUIRED_ENGINE,
    page: { index: first.page_index, count: rows.length, hit_count: first.hit_count, returned: 0, total_hits: first.total_hits }
  };
  return slicePage(firstPage, first, rows, 0, requested);
}

/**
 * Reads one retained page.
 *
 * Nothing is re-run: the cursor selects the stored artifact and the position inside it, so the
 * caller sees exactly the retained snapshot even if the tree changed since.
 */
export async function readSearchPage(
  deps: ManagedSearchDeps,
  owner: SearchOwner,
  cursor: string,
  maxResults?: number
): Promise<ManagedSearchPage> {
  const parsed = parseSearchCursor(cursor);
  if (parsed?.storage !== 'managed') {
    throw pageError('SEARCH_CURSOR_INVALID', 'that cursor was not issued by this app. Start a new search with query.');
  }
  const row = await deps.artifacts.getArtifact(parsed.artifactId);
  if (!row) {
    throw pageError('SEARCH_CURSOR_INVALID', 'no retained page matches that cursor. Start a new search with query.');
  }
  const mode = modeOfKind(row.kind);
  if (mode === null || row.work_id !== owner.workId || row.session_id !== owner.sessionId) {
    throw pageError('SEARCH_CURSOR_INVALID', 'that cursor belongs to a different work or worker. Start a new search with query.');
  }
  const text = await readOverflowText(row.session_id, row.asset_id);
  if (text === null) {
    throw pageError('SEARCH_CURSOR_EXPIRED', 'the retained page is no longer stored. Start a new search with query.');
  }

  const siblings = await pagesOfRun(deps, row, owner);
  const rowIndex = siblings.findIndex((candidate) => candidate.artifact_id === row.artifact_id);
  const pageIndex = rowIndex >= 0 ? rowIndex : row.page_index;
  const lines = text.split('\n');
  const metadata = parsePageMetadata(lines[0] ?? '');
  if (metadata) lines.shift();
  const hits = parsePageLines(lines);
  if (hits.length !== row.hit_count) throw pageError('SEARCH_CURSOR_CORRUPT', 'retained page does not match its recorded hit count.');
  const page: ManagedSearchPage = {
    hits,
    next_cursor: null,
    truncated: null,
    stopped_because: stoppedOf(metadata?.stopped_because ?? row.truncated_reason),
    elapsed_ms: metadata?.elapsed_ms ?? null,
    files_scanned: metadata?.files_scanned ?? null,
    content_file_limit: mode === 'content' ? MAX_CONTENT_FILE_BYTES : null,
    engine: SEARCH_REQUIRED_ENGINE,
    page: { index: pageIndex, count: siblings.length, hit_count: row.hit_count, returned: 0, total_hits: row.total_hits }
  };
  return slicePage(page, row, siblings, parsed.offset, clampResults(maxResults));
}

/** The run's pages in order, so a cursor can name the page that follows this one. */
async function pagesOfRun(
  deps: ManagedSearchDeps,
  row: WorkArtifactRow,
  owner: SearchOwner
): Promise<WorkArtifactRow[]> {
  // A row without a run hash cannot be grouped with anything: guessing would splice two runs'
  // pages into one walk, which is exactly the skip/duplicate this paging exists to prevent.
  if (row.query_hash === null || modeOfKind(row.kind) === null) return [row];
  const rows = await deps.artifacts.listArtifacts({ workId: owner.workId, kind: row.kind, queryHash: row.query_hash });
  const matching = rows.filter((candidate) => candidate.session_id === owner.sessionId && candidate.query_hash === row.query_hash);
  return matching.sort((a, b) => a.page_index - b.page_index);
}

/**
 * Applies the requested size to a page and computes the cursor for whatever remains.
 *
 * A cursor is issued while *any* retained hit is still unread — either later in this page or on
 * a later page of the same run. Only when both are exhausted does the page report the run's own
 * terminal truncation, which is the difference between "there is more, ask again" and "the scan
 * itself was bounded".
 */
function slicePage(
  page: ManagedSearchPage,
  row: Pick<WorkArtifactRow, 'artifact_id' | 'truncated_reason'>,
  siblings: Array<Pick<WorkArtifactRow, 'artifact_id'>>,
  offset: number,
  requested: number
): ManagedSearchPage {
  const all = page.hits;
  if (offset >= all.length) throw pageError('SEARCH_CURSOR_INVALID', 'cursor offset is not in the retained page.');
  const start = offset;
  const selected = all.slice(start, start + requested);
  const consumed = start + selected.length;
  let next: string | null = null;
  if (consumed < all.length) {
    next = formatCursor(row.artifact_id, consumed);
  } else {
    const index = siblings.findIndex((candidate) => candidate.artifact_id === row.artifact_id);
    const following = index >= 0 ? siblings[index + 1] : undefined;
    if (following) next = formatCursor(following.artifact_id, 0);
  }
  page.hits = selected;
  page.next_cursor = next;
  page.truncated = next !== null ? 'page' : truncationOf(row.truncated_reason);
  page.page = { ...page.page, returned: selected.length };
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') >= SEARCH_PAGE_BYTES) {
    if (selected.length <= 1) throw pageError('SEARCH_RESULT_TOO_LARGE', 'one complete search hit cannot fit a search response page.');
    return slicePage({ ...page, hits: all }, row, siblings, offset, selected.length - 1);
  }
  return page;
}
