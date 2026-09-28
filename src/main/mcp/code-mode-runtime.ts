import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { CODE_MODE_WORKER_SOURCE } from './code-mode-worker.js';
import type { ToolContent, ToolResult } from './kernel.js';
import { validateImageBytes, MAX_VIEW_IMAGE_BYTES } from '../codex/view-image.js';

export const CODE_MODE_LIMITS = Object.freeze({
  codeChars: 64_000, cpuMs: 2_000, wallMs: 60_000, memoryBytes: 32 * 1024 * 1024,
  calls: 32, concurrentCalls: 8, argumentBytes: 1024 * 1024, resultBytes: 12 * 1024 * 1024,
  totalResultBytes: 32 * 1024 * 1024, outputBytes: 12 * 1024 * 1024, outputItems: 32,
  textBytes: 4 * 1024 * 1024, images: 4, activeRuns: 4,
  /** Bounds for resumable cells and the owner-scoped `store`/`load` state map. */
  cells: 4, cellWallMs: 300_000, cellIdleMs: 60_000, timers: 64,
  storeKeys: 256, storeValueBytes: 65_536, storeBytes: 1024 * 1024,
  storeOwners: 64, totalStoreBytes: 8 * 1024 * 1024
});
export const codeModeSchema = z.object({ code: z.string().min(1).max(CODE_MODE_LIMITS.codeChars)
  .describe('Raw JavaScript source with top-level await. Emit results with text(...) or image(...).') }).strict();
export type CodeModeTool = { name: string; description: string };
/** What a nested tool call resolves to inside the isolate. The trusted facade adapter owns the
 * shape: a Core tool that fails throws a real Error, while an external MCP result (including the
 * Desktop/Plugins envelopes) is returned verbatim as data so `isError` stays a readable field. */
export type CodeModeNestedResult = unknown;
export type CodeModeInvoke = (name: string, args: unknown) => Promise<CodeModeNestedResult>;

/** Trusted facade-owned liveness hooks. The facade decides what "active" means (the chat is not
 * stopped, the caller epoch is still current); this runtime only refuses further work once it says no. */
export type CodeModeLifecycle = {
  isActive?: () => boolean | Promise<boolean>;
  track?: (work: Promise<unknown>) => void;
};
export type CodeModeOptions = {
  /** Core returns complete admitted output by default; an explicit token budget still clips text. */
  fullOutputByDefault?: boolean;
  /** Core skips emitted-byte ceilings; item, image and guest resource guards remain. */
  skipEmittedByteLimits?: boolean;
  /** Local recording of full output when an explicitly limited response is clipped. */
  onTruncatedOutput?: (content: ToolContent[]) => void;
  /** Trusted execution principal composed by the facade (surface namespace plus proven caller).
   * Never taken from model arguments. Absent means the call is anonymous and stateless. */
  owner?: string;
  /** Maps a facade-composed principal onto its canonical session identity. Re-applied at every
   * state access, so a request alias that later canonicalizes still reaches the same store. */
  resolveOwner?: (owner: string) => string | Promise<string>;
  /** Trusted access decision for observing an existing cell. It replaces literal owner equality, so a
   * proven request alias may observe the session cell it belongs to. Failures fail closed. */
  canAccessOwner?: (storedOwner: string, requestedOwner: string) => boolean | Promise<boolean>;
  /** Side channel for `notify(...)`. It never consumes the value: MCP notification success proves the
   * transport accepted it, not that the model saw a custom-tool message, so the text is always
   * buffered into the next exec/wait result as well. */
  onNotify?: (content: ToolContent) => void | Promise<void>;
  lifecycle?: CodeModeLifecycle;
  /** Proven source conversation of the calling request, read when a cell is created and again at
   * interruption for a cell that has no resolved source yet. */
  conversationId?: () => string | null;
};
export type CodeModeWaitRequest = {
  cell_id: string;
  yield_time_ms?: number;
  max_tokens?: number;
  terminate?: boolean;
};
export type CodeModeWaitOptions = Pick<CodeModeOptions,
  'owner' | 'resolveOwner' | 'canAccessOwner' | 'onNotify' | 'onTruncatedOutput' | 'lifecycle' | 'fullOutputByDefault'>;

export const CODE_MODE_PRAGMA_PREFIX = '// @exec:';
export const CODE_MODE_EXEC_YIELD_MS = 10_000;
export const CODE_MODE_WAIT_YIELD_MS = 10_000;
/** Default direct-result budget for Desktop and Plugins. Core returns admitted output in full. */
export const CODE_MODE_DEFAULT_OUTPUT_TOKENS = 262_144;
/** Hard ceiling a pragma or wait argument may request. */
export const CODE_MODE_MAX_OUTPUT_TOKENS = 1_048_576;
const BYTES_PER_TOKEN = 4;
const MAX_TIMER_DELAY_MS = 60_000;
const MAX_STATE_ERROR_CHARS = 200;
const requireRuntime = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
type CodeModeLimits = { [Key in keyof typeof CODE_MODE_LIMITS]: number };
type WorkerSlot = { worker: Worker; ready: Promise<void> };
type Emission = { kind: 'text' | 'image' | 'audio' | 'generatedImage' | 'notify'; value: unknown };
type CellOutcome = 'yielded' | 'done';
/** Host-owned synchronous state channel. The interpreter blocks in `Atomics.wait` while the host
 * answers; no state is mirrored inside the isolate, so two cells can never disagree. */
type StateChannel = { control: Int32Array; payload: Uint8Array };
type CodeModeCell = {
  id: string;
  owner: string | null;
  /** Resolved source conversations. Once non-empty it never changes, so a stopped chat cannot cancel
   * a successor that merely reused the same cell or request alias. */
  conversations: Set<string>;
  conversationId: (() => string | null) | undefined;
  worker: Worker;
  channel: StateChannel | undefined;
  limits: CodeModeLimits;
  options: CodeModeOptions;
  allowed: Set<string>;
  invoke: CodeModeInvoke;
  emissions: Emission[];
  drained: number;
  emittedItems: number;
  status: 'running' | 'done';
  terminal: string | null;
  /** Synchronous observation claim. Only the holder may drain output or settle this cell. */
  claiming: boolean;
  observeTimer: NodeJS.Timeout | undefined;
  settle: ((outcome: CellOutcome) => void) | undefined;
  timers: Map<number, NodeJS.Timeout>;
  pending: Set<Promise<void>>;
  inFlight: number;
  calls: number;
  resultBytes: number;
  emittedBytes: number;
  images: number;
  deadline: NodeJS.Timeout | undefined;
  idle: NodeJS.Timeout | undefined;
  /** Absolute time an ended, unclaimed cell must be removed. It outlives a claim that cancelled the
   * timer, so a delivery cannot restart the idle window nor lose output it still owes. */
  idleDeadline: number | undefined;
  holdsRun: boolean;
  registered: boolean;
  /** Serializes asynchronous worker-message handling so liveness gates cannot reorder output. */
  chain: Promise<void>;
};

let activeRuns = 0;
let reserve: WorkerSlot | undefined;
let shuttingDown = false;
let totalStoreBytes = 0;
const cells = new Map<string, CodeModeCell>();
/** Every executing cell, including anonymous stateless ones, so shutdown always owns the worker. */
const liveCells = new Set<CodeModeCell>();
type StoreValue = { json: string; seq: number };
type Store = { values: Map<string, StoreValue>; bytes: number };
const stores = new Map<string, Store>();
/** Monotonic host write order. A collision between two identities is resolved by the later write,
 * never by whichever alias happened to be adopted last. */
let storeSequence = 0;
const withoutRequestContext = AsyncLocalStorage.snapshot();

/** Parses the optional first-line `// @exec:` pragma. The pragma line stays in the source (it is a
 * comment); only the two documented fields are accepted, exactly like the upstream exec spec. */
export function parseCodeModeExecSource(input: string): { code: string; yieldTimeMs?: number; maxOutputTokens?: number } | { error: string } {
  if (!input.trim()) return { error: 'exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with a first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}` pragma.' };
  const newline = input.indexOf('\n');
  const firstLine = (newline === -1 ? input : input.slice(0, newline)).trimStart();
  if (!firstLine.startsWith(CODE_MODE_PRAGMA_PREFIX)) return { code: input };
  const rest = newline === -1 ? '' : input.slice(newline + 1);
  if (!rest.trim()) return { error: 'exec pragma must be followed by JavaScript source on subsequent lines' };
  const directive = firstLine.slice(CODE_MODE_PRAGMA_PREFIX.length).trim();
  const shape = 'exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`';
  if (!directive) return { error: shape };
  let value: unknown;
  try { value = JSON.parse(directive); } catch (error) {
    return { error: `exec pragma must be valid JSON with supported fields \`yield_time_ms\` and \`max_output_tokens\`: ${error instanceof Error ? error.message : 'invalid JSON'}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: shape };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'yield_time_ms' && key !== 'max_output_tokens') return { error: `exec pragma only supports \`yield_time_ms\` and \`max_output_tokens\`; got \`${key}\`` };
  }
  const parsed: { code: string; yieldTimeMs?: number; maxOutputTokens?: number } = { code: input };
  for (const [key, cap] of [['yield_time_ms', CODE_MODE_LIMITS.cellWallMs], ['max_output_tokens', CODE_MODE_MAX_OUTPUT_TOKENS]] as const) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) return { error: `exec pragma \`${key}\` must be a non-negative integer` };
    const clamped = Math.min(field, cap);
    if (key === 'yield_time_ms') parsed.yieldTimeMs = clamped;
    else parsed.maxOutputTokens = clamped;
  }
  return parsed;
}

function createWorkerSlotWithoutContext(): WorkerSlot {
  const worker = new Worker(CODE_MODE_WORKER_SOURCE, {
    eval: true,
    workerData: {
      coreModule: requireRuntime.resolve('quickjs-emscripten-core'),
      wasmModule: requireRuntime.resolve('@jitl/quickjs-wasmfile-release-sync')
    },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
  });
  // A speculative idle reserve must never keep the host process alive. A checked-out worker
  // is ref'ed until its execution (or its background cell) terminates.
  worker.unref();
  const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
  const slot = { worker, ready };
  let started = false;
  const retire = (reason: string) => {
    if (!started) reject(new Error(reason));
    if (reserve === slot) reserve = undefined;
  };
  const onMessage = (message: { type?: string }) => {
    if (message.type !== 'ready') return;
    started = true;
    worker.off('message', onMessage);
    resolve();
  };
  // Keep retirement listeners after readiness. An idle reserve that fails is discarded, never
  // replenished in the background, instead of becoming a dead slot that consumes a call timeout.
  worker.on('message', onMessage);
  worker.once('error', () => retire('worker startup failed'));
  worker.once('exit', () => retire('worker exited'));
  void ready.catch(() => undefined);
  return slot;
}

function takeWorker(): WorkerSlot {
  if (shuttingDown) throw new Error('runtime shutting down');
  const slot = reserve ?? withoutRequestContext(createWorkerSlotWithoutContext);
  reserve = undefined;
  slot.worker.ref();
  if (!shuttingDown) {
    try { reserve = withoutRequestContext(createWorkerSlotWithoutContext); } catch { /* The current execution remains usable without a reserve. */ }
  }
  return slot;
}

/** Called after connector admission drains during final host shutdown. */
export async function shutdownCodeModeRuntime(): Promise<void> {
  shuttingDown = true;
  const idle = reserve;
  reserve = undefined;
  const live = [...liveCells];
  cells.clear();
  for (const cell of live) {
    cell.registered = false;
    endCell(cell, 'RUNTIME_ERROR');
    removeCell(cell);
  }
  stores.clear();
  totalStoreBytes = 0;
  storeSequence = 0;
  if (idle) await idle.worker.terminate();
}

/** Stops every background cell whose proven source conversation is this one. Store/load memory is
 * retained: a later cell of the same owner still reads what earlier cells stored. */
export function interruptCodeModeConversation(conversationId: string): void {
  if (typeof conversationId !== 'string' || !conversationId) return;
  for (const cell of [...cells.values()]) {
    if (!cellMatchesConversation(cell, conversationId)) continue;
    endCell(cell, 'INTERRUPTED');
  }
}

function cellMatchesConversation(cell: CodeModeCell, conversationId: string): boolean {
  if (cell.conversations.size) return cell.conversations.has(conversationId);
  // Never attributed: consult the proof again now, and capture it only if it matches. A cell that
  // already resolved a different source keeps it, so a successor cannot retarget this cell.
  let source: string | null = null;
  try { source = cell.conversationId?.() ?? null; } catch { source = null; }
  if (source !== conversationId) return false;
  cell.conversations.add(source);
  return true;
}

/** Resolves the cell's own original source conversation. Only the reader captured from the original
 * exec is consulted, so a waiter can never install its own conversation as the cell's source. */
function captureConversation(cell: CodeModeCell): void {
  if (cell.conversations.size) return;
  const read = cell.conversationId;
  if (!read) return;
  let source: string | null = null;
  try { source = read() ?? null; } catch { source = null; }
  if (typeof source === 'string' && source) cell.conversations.add(source);
}

async function resolveOwnerString(options: Pick<CodeModeOptions, 'owner' | 'resolveOwner'>): Promise<string | null> {
  const owner = options.owner;
  if (typeof owner !== 'string' || !owner) return null;
  if (!options.resolveOwner) return owner;
  try {
    const resolved = await options.resolveOwner(owner);
    return typeof resolved === 'string' && resolved ? resolved : null;
  } catch { return null; }
}

/** Canonical identity for state access, re-resolved per access so a request alias that later
 * canonicalizes still shares the session store. */
async function canonicalOwner(cell: CodeModeCell): Promise<string> {
  return await resolveOwnerString({ owner: cell.owner ?? undefined, resolveOwner: cell.options.resolveOwner }) ?? cell.owner!;
}

async function ownerActive(options: CodeModeOptions): Promise<boolean> {
  const check = options.lifecycle?.isActive;
  if (!check) return true;
  try { return (await check()) !== false; } catch { return false; }
}

/** Existing bucket only. A read or a refused write must not consume an owner slot, so buckets are
 * created by the accepted first write after every bound has passed. */
function findStore(owner: string): Store | undefined {
  return stores.get(owner);
}

function createStore(owner: string, limits: CodeModeLimits): Store | undefined {
  const existing = stores.get(owner);
  if (existing) return existing;
  if (stores.size >= limits.storeOwners) return undefined;
  const created: Store = { values: new Map(), bytes: 0 };
  stores.set(owner, created);
  return created;
}

/** Every bucket this caller's state may live in, canonical first.
 *
 * A bucket written before its session join was proved belongs to this caller exactly when the
 * facade's own resolver now maps its name here, so the bounded bucket list is scanned through
 * `resolveOwner`. That is what recovers state written by a cell that has already finished, with no
 * second alias ledger to keep in sync and nothing that can grow per request. */
async function stateSources(cell: CodeModeCell, owner: string): Promise<string[]> {
  const sources = [owner];
  const resolve = cell.options.resolveOwner;
  if (resolve) {
    for (const candidate of [...stores.keys()]) {
      if (candidate === owner || sources.includes(candidate)) continue;
      let mapped: string | null = null;
      try { mapped = await resolve(candidate); } catch { mapped = null; }
      if (mapped === owner) sources.push(candidate);
    }
  }
  // The identity this cell was created with, when the resolver has not (yet) moved it here.
  if (cell.owner && !sources.includes(cell.owner)) sources.push(cell.owner);
  return sources;
}

/**
 * Moves state written under an earlier, less-specific identity onto the canonical one once a request
 * alias proves its session.
 *
 * The move is atomic and lossless. Every bound is checked against the merged result first, and when
 * the merge cannot fit, nothing is changed and the source bucket stays readable under its own
 * identity — a partially merged or emptied store would silently lose the caller's data. On a key
 * collision the later host write wins, so adopting an alias can never resurrect a superseded value.
 * The source slot is released by the same step, so the owner cap never blocks a rename.
 */
function adoptStores(sources: string[], target: string, limits: CodeModeLimits): boolean {
  const aliases = [...new Set(sources)].filter(source => source !== target && stores.has(source));
  if (!aliases.length) return true;
  const existing = stores.get(target);
  const values = new Map(existing?.values);
  for (const source of aliases) {
    for (const [key, value] of stores.get(source)!.values) {
      const current = values.get(key);
      if (!current || current.seq < value.seq) values.set(key, value);
    }
  }
  let bytes = 0;
  for (const [key, value] of values) bytes += Buffer.byteLength(key) + Buffer.byteLength(value.json);
  const sourceBytes = aliases.reduce((sum, source) => sum + stores.get(source)!.bytes, 0);
  const nextTotalBytes = totalStoreBytes - sourceBytes - (existing?.bytes ?? 0) + bytes;
  const nextOwnerCount = stores.size - aliases.length + (existing ? 0 : 1);
  if (values.size > limits.storeKeys || bytes > limits.storeBytes ||
      nextTotalBytes > limits.totalStoreBytes || nextOwnerCount > limits.storeOwners) return false;
  // Commit only after the complete merge passes every bound. No source is deleted on refusal.
  stores.set(target, { values, bytes });
  for (const source of aliases) stores.delete(source);
  totalStoreBytes = nextTotalBytes;
  return true;
}

/** Decode before emitting through the same image authority as view_image. Never fetch a URL. */
async function emittedImage(value: unknown): Promise<ToolContent> {
  let data: unknown, mime: unknown;
  if (typeof value === 'string' || (value && typeof value === 'object' && 'image_url' in value)) {
    const url = typeof value === 'string' ? value : (value as { image_url: unknown }).image_url;
    if (typeof url !== 'string') throw new Error('IMAGE_INVALID');
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match) throw new Error('IMAGE_INVALID');
    [, mime, data] = match;
  } else if (value && typeof value === 'object' && 'type' in value && value.type === 'image') {
    ({ data, mimeType: mime } = value as { data?: unknown; mimeType?: unknown });
  }
  if (typeof data !== 'string' || typeof mime !== 'string' || data.length > Math.ceil(MAX_VIEW_IMAGE_BYTES / 3) * 4 ||
      data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('IMAGE_INVALID');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('IMAGE_INVALID');
  const actual = await validateImageBytes(bytes);
  if (mime !== actual && mime !== 'application/octet-stream') throw new Error('IMAGE_INVALID');
  return { type: 'image', data: bytes.toString('base64'), mimeType: actual };
}

/** Audio stays a native MCP content item; only the base64 envelope is validated, never a codec. */
function emittedAudio(value: unknown): ToolContent {
  let data: unknown, mime: unknown;
  if (typeof value === 'string' || (value && typeof value === 'object' && 'audio_url' in value)) {
    const url = typeof value === 'string' ? value : (value as { audio_url: unknown }).audio_url;
    if (typeof url !== 'string') throw new Error('AUDIO_INVALID');
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match) throw new Error('AUDIO_INVALID');
    [, mime, data] = match;
  } else if (value && typeof value === 'object' && 'type' in value && (value as { type?: unknown }).type === 'audio') {
    ({ data, mimeType: mime } = value as { data?: unknown; mimeType?: unknown });
  }
  if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      typeof mime !== 'string' || !/^audio\/[A-Za-z0-9.+-]+$/.test(mime)) throw new Error('AUDIO_INVALID');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.toString('base64') !== data) throw new Error('AUDIO_INVALID');
  return { type: 'audio', data, mimeType: mime };
}

function clipPreview(content: ToolContent[], previewBytes: number): { preview: ToolContent[]; omittedBytes: number } {
  let remaining = previewBytes, omittedBytes = 0;
  const preview: ToolContent[] = [];
  for (const part of content) {
    if (part.type !== 'text') { preview.push(part); continue; }
    const bytes = Buffer.byteLength(part.text);
    if (bytes <= remaining) {
      preview.push(part);
      remaining -= bytes;
    } else {
      let end = remaining;
      if (end > 0) {
        const buffer = Buffer.from(part.text, 'utf8');
        while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
        if (end) preview.push({ type: 'text', text: buffer.subarray(0, end).toString('utf8') });
      }
      omittedBytes += bytes - end;
      remaining = 0;
    }
  }
  return { preview, omittedBytes };
}

/** No preview ceiling on Core's default delivery; admission still bounds emitted bytes. */
function previewBudget(limits: CodeModeLimits, tokens: number | undefined, fullOutputByDefault?: boolean): number | undefined {
  if (tokens === undefined && fullOutputByDefault) return undefined;
  const budget = tokens === undefined ? CODE_MODE_DEFAULT_OUTPUT_TOKENS : Math.max(0, Math.min(tokens, CODE_MODE_MAX_OUTPUT_TOKENS));
  return Math.min(limits.textBytes, budget * BYTES_PER_TOKEN);
}

function errorResult(reason: string): ToolResult {
  return { content: [{ type: 'text', text: `CODE_MODE_${reason}` }], isError: true };
}

function failureDiagnostic(status: string, calls: number, limits: CodeModeLimits, skipEmittedByteLimits: boolean): ToolContent[] {
  const effects = calls
    ? `${calls} tool calls already dispatched; side effects were not rolled back. Inspect current state before retrying.`
    : 'No tool calls were dispatched.';
  const byteBounds = status === 'OUTPUT_LIMIT' && !skipEmittedByteLimits
    ? limits.resultBytes + ' bytes per emission, ' + limits.outputBytes + ' encoded output bytes, '
    : '';
  const hint = status === 'PARSE_ERROR'
    ? ' Source could not be parsed or initialized; check quoting, closing brackets, and unsupported imports.'
    : status === 'OUTPUT_LIMIT'
      ? ' Limits: ' + byteBounds + limits.images + ' images, ' + limits.outputItems + ' output items.'
      : status.startsWith('SCRIPT_ERROR')
        ? ' Check the JavaScript and available tool names; catch an expected error and explicitly text(...) only the details you need.'
        : '';
  return errorResult(`${status}: execution stopped. ${effects}${hint} Unemitted values remain private.`).content;
}

function clearCellTimers(cell: CodeModeCell): void {
  for (const handle of cell.timers.values()) clearTimeout(handle);
  cell.timers.clear();
}

/** Ends a cell logically: no new child work is admitted and the interpreter stops, while already
 * dispatched child operations keep their own lifetime under their dispatcher owner. */
function endCell(cell: CodeModeCell, reason: string | null): boolean {
  if (cell.status === 'done') return false;
  cell.status = 'done';
  cell.terminal = reason;
  if (cell.deadline) { clearTimeout(cell.deadline); cell.deadline = undefined; }
  clearCellTimers(cell);
  void cell.worker.terminate();
  const wasClaimed = cell.claiming;
  cell.settle?.('done');
  if (cell.registered && cell.idleDeadline === undefined) cell.idleDeadline = Date.now() + cell.limits.cellIdleMs;
  if (!wasClaimed) scheduleIdleRemoval(cell);
  return true;
}

function scheduleIdleRemoval(cell: CodeModeCell): void {
  if (!cell.registered || cell.idle) return;
  // The deadline is absolute and fixed when the cell first goes idle. A later claim cancels the
  // timer to deliver undelivered output, then arms whatever is left of this same deadline, so a
  // delivery can neither free output mid-flight nor restart the idle window.
  if (cell.idleDeadline === undefined) cell.idleDeadline = Date.now() + cell.limits.cellIdleMs;
  cell.idle = setTimeout(() => removeCell(cell), Math.max(0, cell.idleDeadline - Date.now()));
  cell.idle.unref?.();
}

function releaseRun(cell: CodeModeCell): void {
  if (!cell.holdsRun) return;
  cell.holdsRun = false;
  // Do not allow fire-and-forget scripts to evade the global host-work bound.
  if (cell.pending.size) void Promise.allSettled([...cell.pending]).then(() => { activeRuns--; });
  else activeRuns--;
}

function removeCell(cell: CodeModeCell): void {
  liveCells.delete(cell);
  cell.emissions.length = 0;
  if (cell.registered) { cells.delete(cell.id); cell.registered = false; }
  if (cell.deadline) { clearTimeout(cell.deadline); cell.deadline = undefined; }
  if (cell.idle) { clearTimeout(cell.idle); cell.idle = undefined; }
  cell.idleDeadline = undefined;
  clearCellTimers(cell);
  void cell.worker.terminate();
  releaseRun(cell);
}

/** Reads the terminal flag without narrowing `cell.status` in the enclosing scope, so a post-await
 * check stays meaningful to the compiler as well as at runtime. */
function cellEnded(cell: CodeModeCell): boolean {
  return cell.status === 'done';
}

function claimObservation(cell: CodeModeCell): boolean {
  if (cell.claiming) return false;
  cell.claiming = true;
  // A claimant owns undelivered output through delivery. Cancel a pending idle removal so it cannot
  // free the emissions (or delete the cell) while owner validation or an image decode is still in
  // flight; the absolute deadline survives and releaseObservation re-arms what is left of it.
  if (cell.idle) { clearTimeout(cell.idle); cell.idle = undefined; }
  return true;
}

function releaseObservation(cell: CodeModeCell): void {
  cell.claiming = false;
  cell.settle = undefined;
  // Completion can race an asynchronous output decoder after observe() has already yielded. In that
  // case endCell saw an active claimant and deliberately deferred retention; the claimant owns arming
  // it now, against the deadline fixed when the cell ended. A claim that outlived that deadline (a
  // forbidden caller or a slow decode) removes the cell here instead of arming a timer a later claim
  // could defer again.
  if (!cell.registered || !cellEnded(cell)) return;
  if (cell.idleDeadline !== undefined && cell.idleDeadline <= Date.now()) removeCell(cell);
  else scheduleIdleRemoval(cell);
}

function settleObservation(cell: CodeModeCell, outcome: CellOutcome): void {
  const settle = cell.settle;
  cell.settle = undefined;
  settle?.(outcome);
}

/** `yield_control()` flushes accumulated output to the model without stopping the script: the cell
 * keeps running and the next wait observes whatever happens afterwards. */
function yieldCell(cell: CodeModeCell): void {
  if (cellEnded(cell)) { settleObservation(cell, 'done'); return; }
  settleObservation(cell, 'yielded');
}

/** Waits for the yield window, an explicit `yield_control()`, or cell completion. The caller must
 * already hold the observation claim, which is what makes concurrent waits impossible. */
function observe(cell: CodeModeCell, windowMs: number, onExpiry: 'yield' | 'limit'): Promise<CellOutcome> {
  return new Promise(resolve => {
    if (cellEnded(cell)) { resolve('done'); return; }
    let settled = false;
    const settle = (outcome: CellOutcome) => { if (settled) return; settled = true; resolve(outcome); };
    cell.settle = outcome => {
      if (cell.observeTimer) { clearTimeout(cell.observeTimer); cell.observeTimer = undefined; }
      settle(outcome);
    };
    cell.observeTimer = setTimeout(() => {
      cell.observeTimer = undefined;
      if (settled) return;
      if (onExpiry === 'yield') settleObservation(cell, 'yielded');
      else { endCell(cell, 'TIME_LIMIT'); settle('done'); }
    }, Math.max(0, windowMs));
  });
}

async function drainCell(cell: CodeModeCell, previewBytes: number | undefined): Promise<{ content: ToolContent[]; full: ToolContent[]; omittedBytes: number; invalid: boolean }> {
  const fresh: ToolContent[] = [];
  let invalid = false;
  while (cell.drained < cell.emissions.length) {
    const emission = cell.emissions[cell.drained++]!;
    try {
      if (emission.kind === 'text' || emission.kind === 'notify') {
        if (typeof emission.value !== 'string') { invalid = true; break; }
        fresh.push({ type: 'text', text: emission.value });
      } else if (emission.kind === 'audio') {
        fresh.push(emittedAudio(emission.value));
      } else if (emission.kind === 'generatedImage') {
        fresh.push(await emittedImage(emission.value));
        const hint = (emission.value as { output_hint?: unknown }).output_hint;
        if (typeof hint === 'string' && hint) fresh.push({ type: 'text', text: hint });
      } else {
        fresh.push(await emittedImage(emission.value));
      }
    } catch { invalid = true; break; }
  }
  // A yielded cell can stay live for minutes. Retain only emissions produced after this
  // observation; the result/recorder now owns those already delivered. The claim owns the cell for
  // this whole drain, so nothing can shrink the array underneath it.
  if (cell.drained === cell.emissions.length) cell.emissions.length = 0;
  else if (cell.drained) {
    cell.emissions.copyWithin(0, cell.drained);
    cell.emissions.length -= cell.drained;
  }
  cell.drained = 0;
  if (previewBytes === undefined) return { content: fresh, full: fresh, omittedBytes: 0, invalid };
  const { preview, omittedBytes } = clipPreview(fresh, previewBytes);
  return { content: preview, full: fresh, omittedBytes, invalid };
}

/** The truncation notice must name the budget this delivery actually applied: the direct-result
 * token budget can be well below the store's text preview ceiling. */
function reportTruncation(
  delivery: Pick<CodeModeOptions, 'onTruncatedOutput'>,
  diagnostics: ToolContent[], full: ToolContent[], omittedBytes: number, previewBytes: number | undefined
): void {
  if (!omittedBytes || previewBytes === undefined) return;
  diagnostics.push({ type: 'text', text: `[Output truncated: ${omittedBytes} UTF-8 bytes omitted from this response; text preview limit ${previewBytes} bytes.]` });
  delivery.onTruncatedOutput?.([...diagnostics, ...full]);
}

/** Final output is drained exactly once: `drained` advances past everything already delivered.
 * The recording callback comes from the delivery that actually carries the output, so a later wait
 * attaches its own full output instead of re-recording it against the original exec call. */
async function finalizeCell(
  cell: CodeModeCell, outcome: CellOutcome, previewBytes: number | undefined,
  delivery: Pick<CodeModeOptions, 'onTruncatedOutput'>
): Promise<ToolResult> {
  const drained = await drainCell(cell, previewBytes);
  const diagnostics: ToolContent[] = [];
  if (drained.invalid) diagnostics.push(...errorResult('OUTPUT_INVALID: an emitted value was rejected; nothing was returned for it.').content);
  if (outcome === 'yielded') {
    const notice: ToolContent[] = [{ type: 'text', text: `Script running with cell ID ${cell.id}. The script keeps running in the background; call wait with cell_id "${cell.id}" to collect the output it produces after this point, or to stop it.` }];
    reportTruncation(delivery, notice, drained.full, drained.omittedBytes, previewBytes);
    return {
      content: [...drained.content, ...diagnostics, ...notice],
      ...(drained.invalid ? { isError: true } : {})
    };
  }
  if (cell.terminal) diagnostics.push(...failureDiagnostic(cell.terminal, cell.calls, cell.limits, cell.options.skipEmittedByteLimits === true));
  if (cell.pending.size) diagnostics.push(...errorResult('UNAWAITED_CALLS: dispatched tool calls are still running and remain recorded. Side effects were not cancelled.').content);
  reportTruncation(delivery, diagnostics, drained.full, drained.omittedBytes, previewBytes);
  return {
    content: [...diagnostics, ...drained.content],
    ...(cell.terminal || cell.pending.size || drained.invalid ? { isError: true } : {})
  };
}

/** Answers one synchronous state request. The interpreter thread is blocked in `Atomics.wait` for the
 * duration, so the request is read, validated against quota, committed, and only then released. */
async function answerStateRequest(cell: CodeModeCell): Promise<void> {
  const channel = cell.channel;
  if (!channel) return;
  const { control, payload } = channel;
  if (Atomics.load(control, 0) !== 1) return;
  const respond = (text: string) => {
    let bytes = Buffer.from(text, 'utf8');
    if (bytes.length > payload.length) bytes = Buffer.from(JSON.stringify({ ok: false, error: 'STATE_LIMIT: state value exceeds the per-call limit.' }), 'utf8');
    payload.set(bytes);
    Atomics.store(control, 2, bytes.length);
    Atomics.store(control, 0, 2);
    Atomics.notify(control, 0);
  };
  let request: { op?: unknown; key?: unknown; json?: unknown };
  try {
    const length = Atomics.load(control, 1);
    request = JSON.parse(Buffer.from(payload.subarray(0, length)).toString('utf8')) as typeof request;
  } catch { respond(JSON.stringify({ ok: false, error: 'STATE_INVALID: malformed state request.' })); return; }
  try {
    if (typeof request.key !== 'string' || !request.key) throw new Error('STATE_INVALID: state keys are non-empty strings.');
    if (request.key.length > 1_024) throw new Error('STATE_INVALID: state key is too long.');
    // The same liveness gate as every other side effect: a superseded source cannot keep writing.
    if (!(await ownerActive(cell.options))) throw new Error('OWNER_INACTIVE: this cell no longer belongs to an active conversation.');
    if (cell.status === 'done' || cell.owner === null) throw new Error('CELL_CLOSED: this cell is no longer running.');
    const owner = await canonicalOwner(cell);
    const spellings = await stateSources(cell, owner);
    if (!adoptStores(spellings, owner, cell.limits)) {
      throw new Error('STATE_LIMIT: canonical state merge exceeds its quota; the original state was retained.');
    }
    const store = findStore(owner);
    if (request.op === 'store') {
      if (typeof request.json !== 'string') throw new Error('STATE_INVALID: stored values must be JSON serializable.');
      if (Buffer.byteLength(request.json) > cell.limits.storeValueBytes) throw new Error('STATE_LIMIT: stored value exceeds the per-value limit.');
      const previous = store?.values.get(request.key);
      const size = Buffer.byteLength(request.key) + Buffer.byteLength(request.json);
      const delta = size - (previous ? Buffer.byteLength(request.key) + Buffer.byteLength(previous.json) : 0);
      // Quota is validated before commit, so a refused write never corrupts the accounting and never
      // creates a bucket.
      if (!store && stores.size >= cell.limits.storeOwners) throw new Error('STATE_LIMIT: too many distinct owners hold stored state.');
      if (!previous && (store?.values.size ?? 0) >= cell.limits.storeKeys) throw new Error('STATE_LIMIT: too many stored keys for this owner.');
      if ((store?.bytes ?? 0) + delta > cell.limits.storeBytes) throw new Error('STATE_LIMIT: this owner\'s stored state is full.');
      if (totalStoreBytes + delta > cell.limits.totalStoreBytes) throw new Error('STATE_LIMIT: stored state is full across all owners.');
      const target = store ?? createStore(owner, cell.limits);
      if (!target) throw new Error('STATE_LIMIT: too many distinct owners hold stored state.');
      target.values.set(request.key, { json: request.json, seq: ++storeSequence });
      target.bytes += delta;
      totalStoreBytes += delta;
      respond(JSON.stringify({ ok: true }));
      return;
    }
    if (request.op === 'load') {
      const value = store?.values.get(request.key);
      respond(value === undefined
        ? JSON.stringify({ ok: true, found: false })
        : JSON.stringify({ ok: true, found: true, json: value.json }));
      return;
    }
    throw new Error('STATE_INVALID: unsupported state operation.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'STATE_ERROR';
    respond(JSON.stringify({ ok: false, error: message.slice(0, MAX_STATE_ERROR_CHARS) }));
  }
}

/** Every worker message is processed in arrival order. Liveness gates are asynchronous, so a serial
 * chain is what keeps an emission from being reordered behind a later `done` or tool result. */
function enqueueMessage(cell: CodeModeCell, message: { type?: string; id?: number; json?: string; kind?: string; error?: string | null }): void {
  cell.chain = cell.chain.then(() => handleMessage(cell, message)).catch(() => { endCell(cell, 'RUNTIME_ERROR'); });
}

async function handleMessage(cell: CodeModeCell, message: { type?: string; id?: number; json?: string; kind?: string; error?: string | null }): Promise<void> {
  if (cell.status === 'done' || message.type === 'ready') return;
  const limits = cell.limits;
  if (message.type === 'done') {
    cell.terminal = message.error ?? null;
    cell.status = 'done';
    if (cell.deadline) { clearTimeout(cell.deadline); cell.deadline = undefined; }
    clearCellTimers(cell);
    // The terminal state and every emission are already host-owned, so the interpreter is released
    // now instead of being kept alive until the next wait or expiry.
    void cell.worker.terminate();
    settleObservation(cell, 'done');
    if (cell.registered && cell.idleDeadline === undefined) cell.idleDeadline = Date.now() + cell.limits.cellIdleMs;
    if (!cell.claiming) scheduleIdleRemoval(cell);
    return;
  }
  if (message.type === 'state') { await answerStateRequest(cell); return; }
  if (typeof message.json !== 'string') { endCell(cell, 'BRIDGE_ERROR'); return; }
  const bytes = message.type === 'call' || (message.type === 'emit' && cell.options.skipEmittedByteLimits !== true)
    ? Buffer.byteLength(message.json) : 0;
  if (message.type === 'emit') {
    if (message.kind !== 'text' && message.kind !== 'image' && message.kind !== 'audio' && message.kind !== 'generatedImage' && message.kind !== 'notify') { endCell(cell, 'BRIDGE_ERROR'); return; }
    if (++cell.emittedItems > limits.outputItems ||
        (cell.options.skipEmittedByteLimits !== true && (bytes > limits.resultBytes || (cell.emittedBytes += bytes) > limits.outputBytes))) { endCell(cell, 'OUTPUT_LIMIT'); return; }
    let value: unknown;
    try { value = JSON.parse(message.json); } catch { endCell(cell, 'OUTPUT_INVALID'); return; }
    if (message.kind === 'text' || message.kind === 'notify') {
      if (typeof value !== 'string') { endCell(cell, 'OUTPUT_INVALID'); return; }
    } else if (message.kind === 'image' || message.kind === 'generatedImage') {
      // Only decoded images are counted against the image bound; audio stays bounded by the item
      // and encoded-output budgets, exactly like text.
      if (++cell.images > limits.images) { endCell(cell, 'OUTPUT_LIMIT'); return; }
    }
    // A stale cell must not emit after its chat stopped or a successor rebound the surface. The
    // side-channel notify below never consumes the value: MCP notification success proves transport,
    // not that the model saw a custom-tool message, so the payload is always buffered for the next result.
    if (!(await ownerActive(cell.options))) { endCell(cell, 'OWNER_INACTIVE'); return; }
    if (cellEnded(cell)) return;
    cell.emissions.push({ kind: message.kind as Emission['kind'], value });
    if (message.kind === 'notify' && cell.options.onNotify) {
      void Promise.resolve().then(() => cell.options.onNotify!({ type: 'text', text: value as string })).catch(() => undefined);
    }
    return;
  }
  if (message.type === 'yield') { yieldCell(cell); return; }
  if (message.type === 'setTimer' || message.type === 'clearTimer') {
    let request: { id?: unknown; delay?: unknown };
    try { request = JSON.parse(message.json) as { id?: unknown; delay?: unknown }; } catch { endCell(cell, 'BRIDGE_ERROR'); return; }
    const id = typeof request.id === 'number' && Number.isSafeInteger(request.id) ? request.id : undefined;
    if (id === undefined) { endCell(cell, 'BRIDGE_ERROR'); return; }
    const existing = cell.timers.get(id);
    if (existing) { clearTimeout(existing); cell.timers.delete(id); }
    if (message.type === 'clearTimer') return;
    if (cell.timers.size >= limits.timers) { endCell(cell, 'TIMER_LIMIT'); return; }
    const delay = typeof request.delay === 'number' && Number.isFinite(request.delay) ? Math.min(Math.max(request.delay, 0), MAX_TIMER_DELAY_MS) : 0;
    cell.timers.set(id, setTimeout(() => {
      cell.timers.delete(id);
      void (async () => {
        if (cellEnded(cell)) return;
        if (!(await ownerActive(cell.options))) { endCell(cell, 'OWNER_INACTIVE'); return; }
        if (cellEnded(cell)) return;
        cell.worker.postMessage({ type: 'timer', id });
      })();
    }, delay));
    return;
  }
  if (message.type !== 'call') { endCell(cell, 'BRIDGE_ERROR'); return; }
  const id = typeof message.id === 'number' && Number.isSafeInteger(message.id) ? message.id : undefined;
  if (id === undefined) { endCell(cell, 'BRIDGE_ERROR'); return; }
  // Admission is synchronous: the call slot and the concurrency reservation are taken before any
  // await, so a burst of worker calls cannot slip past the bounds while a liveness gate resolves.
  if (cell.calls >= limits.calls || cell.inFlight >= limits.concurrentCalls || bytes > limits.argumentBytes) { endCell(cell, 'CALL_LIMIT'); return; }
  let request: { name: string; args?: unknown };
  try { request = JSON.parse(message.json) as { name: string; args?: unknown }; } catch { endCell(cell, 'BRIDGE_ERROR'); return; }
  if (typeof request.name !== 'string' || !cell.allowed.has(request.name)) { endCell(cell, 'UNKNOWN_TOOL'); return; }
  cell.calls++;
  cell.inFlight++;
  void (async () => {
    const reply = (value: unknown) => {
      if (cellEnded(cell)) return;
      let json: string;
      try { json = JSON.stringify(value); } catch { endCell(cell, 'RESULT_INVALID'); return; }
      if (json === undefined) { endCell(cell, 'RESULT_INVALID'); return; }
      const size = Buffer.byteLength(json);
      if (size > limits.resultBytes || (cell.resultBytes += size) > limits.totalResultBytes) { endCell(cell, 'RESULT_LIMIT'); return; }
      cell.worker.postMessage({ type: 'result', id, json });
    };
    try {
      if (!(await ownerActive(cell.options))) { endCell(cell, 'OWNER_INACTIVE'); return; }
      if (cellEnded(cell)) return;
      let invocation: Promise<CodeModeNestedResult>;
      try { invocation = cell.invoke(request.name, request.args); }
      catch { rejectCall(cell, id, 'TOOL_ERROR'); return; }
      const work = invocation.then(value => {
        if (cellEnded(cell)) return;
        // The native value is forwarded verbatim; the trusted adapter decides what a failure is, and
        // only a real thrown Error (or an unstringifiable value) becomes a JS Error in the isolate.
        reply(value);
      }, (error: unknown) => rejectCall(cell, id, thrownErrorText(error)))
        .catch(() => { endCell(cell, 'RESULT_INVALID'); });
      cell.pending.add(work);
      void work.then(() => cell.pending.delete(work));
      cell.options.lifecycle?.track?.(work.catch(() => undefined));
    } finally { cell.inFlight--; }
  })();
}

/** Bounded text for a nested call that threw. The message is the child's own, never a replacement. */
function thrownErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Nested tool call failed.';
  const text = message.trim() || 'Nested tool call failed.';
  return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
}

function rejectCall(cell: CodeModeCell, id: number, error: string): void {
  if (cellEnded(cell)) return;
  cell.worker.postMessage({ type: 'result', id, error });
}

async function runCell(params: {
  code: string; tools: CodeModeTool[]; invoke: CodeModeInvoke;
  limits: CodeModeLimits; options: CodeModeOptions; owner: string | null;
  register: boolean; yieldWindowMs: number; previewBytes: number | undefined;
}): Promise<ToolResult> {
  const { code, tools, invoke, limits, options, owner, register, yieldWindowMs, previewBytes } = params;
  let slot: WorkerSlot;
  try { slot = takeWorker(); } catch { return errorResult('RUNTIME_ERROR'); }
  const allowState = owner !== null;
  const payloadBytes = limits.storeValueBytes * 2 + 4_096;
  const buffer = new SharedArrayBuffer(16 + payloadBytes);
  const channel: StateChannel = { control: new Int32Array(buffer, 0, 4), payload: new Uint8Array(buffer, 16) };
  const cell: CodeModeCell = {
    id: randomUUID(), owner, conversations: new Set(), conversationId: options.conversationId,
    worker: slot.worker, channel, limits, options, allowed: new Set(tools.map(tool => tool.name)), invoke,
    emissions: [], drained: 0, emittedItems: 0, status: 'running', terminal: null, claiming: true, observeTimer: undefined, settle: undefined,
    timers: new Map(), pending: new Set(), inFlight: 0, calls: 0, resultBytes: 0, emittedBytes: 0,
    images: 0, deadline: undefined, idle: undefined, idleDeadline: undefined, holdsRun: true, registered: false, chain: Promise.resolve()
  };
  liveCells.add(cell);
  activeRuns++;
  if (register) {
    cells.set(cell.id, cell);
    cell.registered = true;
    cell.deadline = setTimeout(() => endCell(cell, 'TIME_LIMIT'), limits.cellWallMs);
    cell.deadline.unref?.();
  }
  // A caller that can only name a request alias may still be promoted to its session identity here;
  // state it wrote under the alias moves with it, so a later exact-proof call sees the same store.
  if (owner !== null && options.owner && options.owner !== owner && !adoptStores([options.owner], owner, limits)) {
    endCell(cell, 'STATE_LIMIT');
  }
  captureConversation(cell);
  const dispatch = AsyncLocalStorage.bind((message: { type?: string }) => enqueueMessage(cell, message));
  cell.worker.on('message', dispatch);
  cell.worker.on('error', AsyncLocalStorage.bind(() => endCell(cell, 'RUNTIME_ERROR')));
  cell.worker.on('exit', AsyncLocalStorage.bind(() => { if (cell.status === 'running') endCell(cell, 'RUNTIME_ERROR'); }));
  let started = true;
  try { await slot.ready; } catch { started = false; }
  if (!started) endCell(cell, 'RUNTIME_ERROR');
  else if (cell.status === 'running') {
    cell.worker.postMessage({
      type: 'start',
      data: {
        code, tools, limits, skipEmittedByteLimits: options.skipEmittedByteLimits === true,
        allowState, allowYield: allowState, stateBuffer: buffer
      }
    });
  }
  try {
    const outcome = await observe(cell, yieldWindowMs, register ? 'yield' : 'limit');
    const result = await finalizeCell(cell, outcome, previewBytes, options);
    if (outcome === 'done') removeCell(cell);
    return result;
  } finally { releaseObservation(cell); }
}

/** A fresh interpreter per call. Accepted child operations retain their dispatcher lifetime
 * after interpreter termination; this owner never pretends a filesystem/process action rolled back. */
export async function runCodeMode(
  code: string, tools: CodeModeTool[], invoke: CodeModeInvoke,
  limits: CodeModeLimits = CODE_MODE_LIMITS,
  options: CodeModeOptions = {}
): Promise<ToolResult> {
  if (!code.trim() || code.length > limits.codeChars) return errorResult('CODE_LIMIT');
  const parsed = parseCodeModeExecSource(code);
  if ('error' in parsed) return errorResult(`PRAGMA: ${parsed.error}`);
  const owner = await resolveOwnerString(options);
  if (parsed.yieldTimeMs !== undefined && owner === null) {
    return errorResult('OWNER_REQUIRED: a resumable exec cell needs a trusted caller identity; this call has none, so `yield_time_ms` was refused.');
  }
  if (activeRuns >= limits.activeRuns) return errorResult('BUSY: too many code executions or unsettled nested calls.');
  if (owner !== null && cells.size >= limits.cells) {
    return errorResult('BUSY: too many running cells; wait for or terminate one before starting another.');
  }
  // An embedding host may start a new endpoint after a complete stop. Only an explicit new
  // execution reopens the lazy reserve; shutdown itself never schedules replenishment.
  shuttingDown = false;
  return runCell({
    code: parsed.code, tools, invoke, limits, options, owner,
    register: owner !== null,
    // Anonymous calls stay one bounded call. An owned call yields early and becomes a resumable cell.
    yieldWindowMs: owner === null
      ? limits.wallMs
      : Math.min(parsed.yieldTimeMs ?? CODE_MODE_EXEC_YIELD_MS, limits.wallMs, limits.cellWallMs),
    previewBytes: previewBudget(limits, parsed.maxOutputTokens, options.fullOutputByDefault)
  });
}

/** Resumes, observes, or terminates one background cell. Ownership is decided by the trusted facade
 * (`canAccessOwner`), never by string comparison alone, and unknown cells fail closed. */
export async function waitCodeMode(request: CodeModeWaitRequest, options: CodeModeWaitOptions = {}): Promise<ToolResult> {
  if (!request || typeof request.cell_id !== 'string' || !request.cell_id) {
    return errorResult('WAIT_INVALID: wait needs the `cell_id` an exec result reported.');
  }
  const cell = cells.get(request.cell_id);
  if (!cell) return errorResult('UNKNOWN_CELL: no running or undelivered cell has that id; it may have completed, been terminated, or been expired.');
  // The observation claim is taken synchronously, before any await, so two waits can never race for
  // the same cell and strand the first one's promise.
  if (!claimObservation(cell)) return errorResult('CELL_BUSY: that cell is already being observed; wait for the call that is already waiting on it.');
  try {
    const requestedOwner = await resolveOwnerString(options);
    if (requestedOwner === null || cell.owner === null) {
      return errorResult('FORBIDDEN: this call has no trusted caller identity for that cell.');
    }
    let allowed = false;
    if (options.canAccessOwner) {
      try { allowed = (await options.canAccessOwner(cell.owner, requestedOwner)) === true; } catch { allowed = false; }
    } else allowed = cell.owner === requestedOwner;
    if (!allowed) return errorResult('FORBIDDEN: this caller may not observe that cell.');
    // A wait may collect output under its own callbacks, but never re-identify the cell's source.
    captureConversation(cell);
    const previewBytes = previewBudget(cell.limits, request.max_tokens, options.fullOutputByDefault);
    if (request.terminate === true) {
      endCell(cell, 'TERMINATED');
      const result = await finalizeCell(cell, 'done', previewBytes, options);
      removeCell(cell);
      return result;
    }
    if (cell.status === 'running' && !(await ownerActive(cell.options))) endCell(cell, 'OWNER_INACTIVE');
    const outcome = await observe(cell, Math.min(request.yield_time_ms ?? CODE_MODE_WAIT_YIELD_MS, cell.limits.cellWallMs), 'yield');
    const result = await finalizeCell(cell, outcome, previewBytes, options);
    if (outcome === 'done') removeCell(cell);
    return result;
  } finally { releaseObservation(cell); }
}
