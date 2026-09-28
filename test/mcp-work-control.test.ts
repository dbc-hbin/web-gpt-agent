/**
 * The no-DOM control transport, exercised over the real loopback endpoint.
 *
 * Everything here is about properties that cannot be seen from the handler:
 *
 *  - a phone conversation with no page of its own can start, list, inspect and stop durable work
 *    on this Mac, with no browser, no attached conversation and no proven worker identity;
 *  - the caller's own conversation metadata is optional diagnostics — when the page has placed the
 *    call it dedups the message against the relay's inbox row, and its absence costs the dedup and
 *    nothing else;
 *  - a host-generated work report echoed back into its own conversation still cannot drive work,
 *    because the relay's own origin check refuses it rather than because the tool call is gated;
 *  - the ledger's constraints are the whole admission: request-id idempotency, read-only mode, the
 *    approved-project sandbox, and the service's own refusals for an unknown work;
 *  - the native call's own application request id survives the join with the automatic relay.
 *
 * The transport is real HTTP against `startMcpServer`, the ledger is real `node:sqlite` behind a
 * real `WorkService`, and the only thing stubbed is the browser half of the runtime port — which
 * is precisely the thing this transport must not depend on.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  rebindSession,
  resetSessionStoreForTests,
  upsertMessageEvent
} from '../src/main/session/store.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { setManagedToolGate } from '../src/main/mcp/kernel.js';
import { managedToolGate } from '../src/main/work/runtime.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { SURFACE_IDS } from '../src/main/mcp/surfaces.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { lastWorkControlAt } from '../src/main/mcp/connector-evidence.js';
import { createWorkService, type WorkRuntimePort, type WorkServiceHandle } from '../src/main/work/service.js';
import { createWorkStore, type WorkStore } from '../src/main/work/store.js';
import {
  claimWorkControllerTurn,
  controllerRequestId,
  drainWorkContinuity,
  getWorkControllerBinding,
  initWorkContinuity,
  recoverWorkContinuity,
  resetWorkContinuityForTests,
  setWorkContinuityOriginQuery
} from '../src/main/work/continuity.js';
import { resetWorkInputForTests, workInputOrigin } from '../src/main/work/input-outbox.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// --------------------------------------------------------------------------- transport

interface RawResponse {
  status: number;
  text: string;
}

function rawPost(urlStr: string, body: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Streamable HTTP may answer as JSON or as a one-shot SSE stream. Accept both. */
function decode(res: RawResponse): Record<string, unknown> {
  const text = res.text.trim();
  const candidate = text.startsWith('{') || text.startsWith('[')
    ? text
    : [...text.matchAll(/^data:\s*(.*)$/gm)].map((match) => match[1] ?? '').at(-1);
  if (candidate === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

let nextId = 1;

/**
 * One request to the Core connector.
 *
 * `headers` is where a case decides what the caller proves: an `x-request-id` is the join key a
 * real ChatGPT turn always carries, and omitting it is the shape of a caller this app cannot
 * place at all.
 */
async function coreCall(method: string, params: unknown = {}, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await rawPost(endpoint.url, JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }), headers);
  return decode(res);
}

function toolNames(reply: Record<string, unknown>): string[] {
  const result = reply.result as { tools?: Array<{ name?: string }> } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name ?? '').sort();
}

function resultOf(reply: Record<string, unknown>): { text: string; isError: boolean } {
  const result = reply.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  const text = (result?.content ?? []).map((part) => part.text ?? '').join('\n');
  return { text, isError: result?.isError === true };
}

/** The parsed JSON body a successful control returns, or a readable failure. */
function payload(reply: Record<string, unknown>): Record<string, unknown> {
  const { text, isError } = resultOf(reply);
  if (isError) throw new Error(`control refused: ${text}`);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error(`control returned ${text.slice(0, 200)}`);
  return parsed as Record<string, unknown>;
}

function workControl(body: Record<string, unknown>, requestId?: string): Promise<Record<string, unknown>> {
  return coreCall('tools/call', { name: 'work', arguments: body }, requestId ? { 'x-request-id': requestId } : {});
}

// --------------------------------------------------------------------------- fixture

let dir = '';
let endpoint: McpEndpoint;
let store: WorkStore;
let service: WorkServiceHandle;
let ctx: ToolContext;
/** Recorded so a case can prove the browser side was never consulted. */
let runtimeStarts: string[] = [];
let conversationSeq = 0;
/** A monotonic source clock, so ordering is explicit rather than wall-clock dependent. */
let clock = 1_000_000;

/**
 * The browser half of the runtime port, which this transport must never need.
 *
 * It records admissions and does nothing else: there is no page, no tunnel and no model here,
 * which is exactly the situation a phone conversation is in.
 */
function browserlessRuntime(): WorkRuntimePort {
  return {
    async beginStart(input) { runtimeStarts.push(input.workId); },
    async deliver() { return { state: 'deferred', detail: 'no browser in this fixture' }; },
    async control(input) { return { status: input.action === 'cancel' ? 'cancelled' : 'paused' }; },
    async reconcile() { /* the ledger is already the source of truth */ }
  };
}

async function openLedger(): Promise<void> {
  store = createWorkStore({ dataDir: dir });
  service = createWorkService({
    store,
    runtime: browserlessRuntime(),
    projects: {
      async resolve(inputPath) { return { path: inputPath, name: path.basename(inputPath), exists: true, isGit: true }; },
      async list() { return [{ id: 'fixture', name: 'fixture', path: dir }]; }
    },
    models: { async resolve({ model, reasoning }) { return { model: model ?? 'gpt-5', reasoning: reasoning ?? null }; } },
    worktreesRoot: path.join(dir, 'worktrees')
  });
  if (ctx) ctx.workService = service;
  // The continuity manager holds the ledger it was opened with, exactly as the host does. A
  // reopened ledger is a new manager lifetime — the old one would keep writing to a closed
  // database — so it is dropped and re-pointed the same way a process restart does it.
  resetWorkContinuityForTests();
  await initWorkContinuity(continuityDeps(service));
}

/** The continuity port, bound to one ledger. Re-created whenever the ledger is reopened. */
function continuityDeps(handle: WorkServiceHandle) {
  return {
    store,
    service: () => handle,
    conversationSettled: async () => true,
    messageOrigin: async ({ sessionId, messageId, text }: { sessionId: string; messageId: string; text?: string }) =>
      workInputOrigin(sessionId, messageId, text),
    deliverReport: async () => ({ state: 'queued' } as const),
    cancelReport: async () => true,
    now: () => clock
  };
}

async function listen(): Promise<void> {
  endpoint = await startMcpServer(() => ctx);
}

/** A Git fixture: `work` refuses a project that is not one. */
async function initGitProject(root: string): Promise<void> {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: root, stdio: 'ignore' });
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
}

function startArgs(requestId: string, goal = 'Make the fixture suite pass.') {
  return {
    request_id: requestId,
    project_path: dir,
    goal
  };
}

// --------------------------------------------------------------------------- provenance

/**
 * One ChatGPT conversation with a durable local session, as the page would create it.
 *
 * This is the fixture's stand-in for a real browser: it writes the same durable facts the
 * extension's observations write, through the same store functions.
 */
async function chat(): Promise<{ sessionId: string; conversationId: string }> {
  const conversationId = `conversation-${++conversationSeq}`;
  const session = await createSession({ title: 'Phone chat' });
  await rebindSession(session.id, null, conversationId);
  return { sessionId: session.id, conversationId };
}

/**
 * One recorded ChatGPT turn: the native user message, the page's own turn boundary, and the
 * request-id sighting that proves which conversation issued it.
 *
 * `reportedAt` is the instant the page proved the request id. It is deliberately separate from
 * the turn's own times: it is a bound on which turn was open when the request existed, not
 * identity, and a case about a delayed call depends on the difference.
 */
async function recordTurn(input: {
  session: { sessionId: string; conversationId: string };
  requestId: string;
  messageId: string;
  text: string;
  startedAt: number;
  authoredAt: number;
  reportedAt: number;
  /** Set for a message the app itself delivered, exactly as `recordDeliveredInput` records it. */
  generated?: boolean;
  /** Set when the fixture must model a page that has not proved the user ancestor yet. */
  noQuestion?: boolean;
}): Promise<{ turnId: string }> {
  const turnId = `turn-${input.messageId}`;
  await upsertMessageEvent(input.session.sessionId, {
    time: input.authoredAt,
    source: 'extension',
    kind: 'user_message',
    messageId: input.messageId,
    ...(input.generated ? { generated: true as const } : {}),
    message: { text: input.text, truncated: false, chars: input.text.length }
  });
  await appendEvent(input.session.sessionId, {
    time: input.startedAt,
    source: 'extension',
    kind: 'turn_start',
    turnId
  });
  // The page's two identities: the connector node that issued the call, and the user message the
  // provider graph proved as its ancestor. Only the second is authority, so the fixture records
  // both exactly as the extension does.
  observeRequestCorrelation({
    requestId: input.requestId,
    conversationId: input.session.conversationId,
    sessionId: input.session.sessionId,
    messageId: `call-${input.messageId}`,
    tool: 'work',
    questionId: input.noQuestion === true ? null : input.messageId,
    observedAt: input.reportedAt
  });
  return { turnId };
}

/** A proven turn in a fresh conversation: the ordinary shape of a remote work call. */
async function provenCaller(text = 'Start the fixture work.'): Promise<{
  session: { sessionId: string; conversationId: string };
  requestId: string;
  messageId: string;
}> {
  const session = await chat();
  const requestId = `wfr_${randomUUID()}`;
  const messageId = `msg-${randomUUID()}`;
  const authoredAt = clock += 100;
  await recordTurn({
    session,
    requestId,
    messageId,
    text,
    authoredAt,
    startedAt: authoredAt + 50,
    reportedAt: authoredAt + 100
  });
  return { session, requestId, messageId };
}



beforeAll(async () => {
  dir = await makeTempDir('wgpt-mcp-work-');
  await initGitProject(dir);
  initConfigPath(dir);
  initDurableStore(dir);
  initSessionStore(dir);
  const config = defaultConfig();
  // Every capability a coding call could want, plus the legacy unattributed opt-in. The point of
  // the opt-in here is that it must NOT be enough for a managed coding call, and it is not
  // provenance for a work change either.
  await saveConfig({
    ...config,
    readOnly: false,
    multiAgent: { ...config.multiAgent, enabled: false, allowUnattributedCalls: true }
  });
  await openLedger();
  ctx = {
    roots: [{ name: 'fixture', path: dir }],
    caps: { ...config.capabilities, read: true, search: true, command: true, create: true, edit: true, move: true, deleteFile: true },
    readOnly: false,
    workService: service
  };
  // The real continuity manager and the real origin query, exactly as `index.ts` installs them:
  // the controller inbox and the generated-message verdict are both live in this fixture.
  setWorkContinuityOriginQuery(input => workInputOrigin(input.sessionId, input.messageId, input.text));
  await listen();
});

afterEach(async () => {
  setManagedToolGate(null);
  // The browser half is a per-case observation, not a running total: a case that says nothing was
  // started means nothing was started *by it*.
  runtimeStarts = [];
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  setManagedToolGate(null);
  await drainWorkContinuity();
  resetWorkContinuityForTests();
  setWorkContinuityOriginQuery(null);
  resetWorkInputForTests();
  resetCorrelationRegistryForTests();
  service?.close();
  store?.close();
  await flushRecorder();
  resetSessionStoreForTests();
  resetDurableForTests();
  await flushDurable();
  if (dir) await removeTempDir(dir);
});

// --------------------------------------------------------------------------- cases

it('keeps work lifecycle control direct and coding behind exec on Core only', async () => {
  // One connector is the design, not a coincidence: a second surface would be a second token, a
  // second tunnel id and a second setup card for the same single user.
  expect(SURFACE_IDS).toEqual(['core', 'desktop', 'plugins']);
  expect(Object.keys(endpoint.urls).sort()).toEqual(['core', 'desktop', 'plugins']);

  const names = toolNames(await coreCall('tools/list'));
  expect(names).toEqual(['exec', 'exec_read', 'tools_search', 'wait', 'work']);
  for (const retired of ['work_start', 'work_list', 'work_status', 'work_instruct', 'work_control', 'work_events', 'read', 'apply_patch', 'exec_command']) {
    const response = await coreCall('tools/call', { name: retired, arguments: {} });
    expect(Boolean(response.error || resultOf(response).isError), retired).toBe(true);
  }
  // The Desktop connector must not have inherited any of them.
  const desktopReply = decode(await rawPost(endpoint.urls.desktop, JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'tools/list', params: {} })));
  expect(toolNames(desktopReply)).toEqual(['exec', 'tools_search', 'wait']);
});

it('starts work from an authenticated call, with no browser of its own', async () => {
  const initialized = await coreCall('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wgpt-phone-fixture', version: '1.0.0' }
  });
  const serverInfo = (initialized.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
  expect(serverInfo?.name).toBe('web-gpt-agent-core');

  const { session, requestId: sourceRequestId } = await provenCaller('Start the phone fixture work.');
  const requestId = randomUUID();
  const receipt = payload(await workControl({ action: 'start', input: startArgs(requestId) }, sourceRequestId));

  expect(receipt.request_id).toBe(requestId);
  expect(receipt.status).toBe('queued');
  expect(receipt.work_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(receipt.project_path).toBe(dir);
  // The result location is declared at admission, never at the end of the task.
  expect(String(receipt.integration_branch)).toContain(String(receipt.work_id));
  expect(store.countWorks()).toBe(1);
  expect(runtimeStarts).toEqual([receipt.work_id]);

  // The conversation that asked for the work owns it, so its own reports come back to it and it
  // can continue the work after completion. Without this the only binding would be the execution
  // prime's, which is a chat the user never chose.
  const binding = getWorkControllerBinding(session.sessionId);
  expect(binding?.work_id).toBe(receipt.work_id);
  expect(binding?.conversation_id).toBe(session.conversationId);
  expect(binding?.enabled).toBe(true);
});
it('returns exactly one work and one outbox input for one request id, even concurrently', async () => {
  const { requestId: sourceRequestId } = await provenCaller('Concurrent admission fixture.');
  const requestId = randomUUID();
  const args = startArgs(requestId, 'Concurrent admission fixture.');
  const [first, second] = await Promise.all([
    workControl({ action: 'start', input: args }, sourceRequestId),
    workControl({ action: 'start', input: args }, sourceRequestId)
  ]);
  const receipts = [payload(first), payload(second)];
  expect(receipts[0]!.work_id).toBe(receipts[1]!.work_id);

  const workId = String(receipts[0]!.work_id);
  // One work, and one durable command carrying the caller's own request id as its outbox input
  // id. A second row would be a second delivery of the same instruction.
  expect(store.getCommand(requestId)?.outbox_input_id).toBe(requestId);
  expect(store.getCommand(requestId)?.work_id).toBe(workId);

  // A different payload under that same id is a conflict, and starts nothing.
  const conflict = resultOf(await workControl({ action: 'start', input: startArgs(requestId, 'A different goal under the same request id.') }, sourceRequestId));
  expect(conflict.isError).toBe(true);
  expect(conflict.text).toContain('REQUEST_ID_CONFLICT: request id');
  expect(conflict.text).not.toContain('Filesystem error');
});

it('replays the same work after the endpoint and ledger are reopened', async () => {
  const { requestId: sourceRequestId } = await provenCaller('Durable replay fixture.');
  const requestId = randomUUID();
  const args = startArgs(requestId, 'Durable replay fixture.');
  const before = payload(await workControl({ action: 'start', input: args }, sourceRequestId));
  const worksBefore = store.countWorks();

  // A real restart: the listener goes away and the ledger is reopened from the same file.
  await endpoint.stop();
  service.close();
  store.close();
  await openLedger();
  await listen();

  const after = payload(await workControl({ action: 'start', input: args }, sourceRequestId));
  expect(after.work_id).toBe(before.work_id);
  expect(after.revision).toBe(before.revision);
  expect(store.countWorks()).toBe(worksBefore);
});

it('lists, reports, instructs and controls that work from the same proven conversation', async () => {
  const { requestId: sourceRequestId } = await provenCaller('Cross-interface continuity fixture.');
  const receipt = payload(await workControl({ action: 'start', input: startArgs(randomUUID(), 'Cross-interface continuity fixture.') }, sourceRequestId));
  const workId = String(receipt.work_id);

  const page = payload(await workControl({ action: 'list', input: { limit: 5 } }));
  expect((page.works as Array<{ work_id: string }>).map((work) => work.work_id)).toContain(workId);
  // The project registry rides along, because a new phone conversation has no other way to learn
  // an absolute project path.
  expect((page.projects as Array<{ path: string }>).some((project) => project.path === dir)).toBe(true);

  const status = payload(await workControl({ action: 'status', input: { work_id: workId } }));
  expect(status.status).toBe('queued');
  expect(String(status.goal)).toContain('Cross-interface continuity');

  const instructed = payload(await workControl({ action: 'instruct', input: { request_id: randomUUID(), work_id: workId, text: 'Also update the changelog.' } }, sourceRequestId));
  expect(instructed.work_id).toBe(workId);
  // An instruction is not new-start authority: it never moves the controller to another work.
  expect(getWorkControllerBinding((await chat()).sessionId)).toBeNull();

  const events = payload(await workControl({ action: 'events', input: { work_id: workId } }));
  expect((events.events as unknown[]).length).toBeGreaterThan(0);
  expect(events.next_cursor).toBeGreaterThan(0);

  // Pause is admitted from the phone and the factual status is retained while it drains.
  const paused = payload(await workControl({ action: 'control', input: { request_id: randomUUID(), work_id: workId, action: 'pause' } }, sourceRequestId));
  expect(paused.work_id).toBe(workId);

  // An unknown id is refused by name rather than resolving to whatever is active, and the refusal
  // keeps the service's own sentence — a code alone would not tell the model what to do next, and
  // a generic mapper would have replaced it with an errno label.
  const missing = resultOf(await workControl({ action: 'status', input: { work_id: randomUUID() } }));
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain('WORK_NOT_FOUND: no work with that id exists');
  expect(missing.text).not.toContain('Filesystem error');
});

it('starts work with no page and no conversation metadata at all', async () => {
  // The whole point of the transport: a client this app cannot place — a scheduled run, a phone
  // whose page has said nothing, a curl — is authenticated by the connector's own token and by
  // nothing else, and the call runs. What it does not get is the dedup or the attribution, both of
  // which are conveniences of the metadata rather than conditions on the call.
  const before = store.countWorks();
  const requestId = randomUUID();
  const receipt = payload(await workControl({ action: 'start', input: startArgs(requestId, 'Unattributed start.') }));
  expect(receipt.request_id).toBe(requestId);
  expect(receipt.status).toBe('queued');
  expect(store.countWorks()).toBe(before + 1);
  expect(runtimeStarts).toEqual([receipt.work_id]);

  // An id no conversation has ever seen behaves identically: no hold, no deferral, no waiting.
  const secondId = randomUUID();
  const second = payload(await workControl(
    { action: 'start', input: startArgs(secondId, 'Uncorrelated start.') },
    `wfr_${randomUUID()}`
  ));
  expect(second.request_id).toBe(secondId);
  expect(store.countWorks()).toBe(before + 2);
});
it('runs a bound controller change even when its inbox row cannot be written, exactly once', async () => {
  // The inbox row is the dedup against the automatic relay, not a condition on the call. A row that
  // cannot be written costs the dedup: the change still runs under the caller's own request id, and
  // the relay's later claim of the same message is answered by the service's own idempotency.
  const first = await provenCaller('Inbox write failure fixture.');
  const started = payload(await workControl({ action: 'start', input: startArgs(randomUUID(), 'Inbox write failure fixture.') }, first.requestId));
  const workId = String(started.work_id);
  const requestId = randomUUID();
  // A fresh turn, so this call's own inbox row is the one that cannot be written.
  const nextAt = clock += 1_000;
  const sourceRequestId = `wfr_${randomUUID()}`;
  await recordTurn({
    session: first.session,
    requestId: sourceRequestId,
    messageId: `msg-${randomUUID()}`,
    text: 'Runs without its inbox row.',
    authoredAt: nextAt,
    startedAt: nextAt + 50,
    reportedAt: nextAt + 100
  });
  const commandsBefore = store.listCommands(workId, 20).length;

  const original = store.putControllerMessage;
  let failures = 1;
  store.putControllerMessage = function failing(row) {
    if (failures > 0) {
      failures -= 1;
      throw new Error('simulated inbox write failure');
    }
    return original.call(this, row);
  };
  try {
    const admitted = payload(await workControl({ action: 'instruct', input: { request_id: requestId, work_id: workId, text: 'Runs without its inbox row.' } }, sourceRequestId));
    expect(admitted.work_id).toBe(workId);
  } finally {
    store.putControllerMessage = original;
  }
  // One durable instruction, and the retry is answered by the ledger rather than executed again.
  expect(store.listCommands(workId, 20).length).toBe(commandsBefore + 1);
  const replay = payload(await workControl({ action: 'instruct', input: { request_id: requestId, work_id: workId, text: 'Runs without its inbox row.' } }, sourceRequestId));
  expect(replay.work_id).toBe(workId);
  expect(store.listCommands(workId, 20).length).toBe(commandsBefore + 1);
});
it('joins the relay receipt when the relay took the message first, without a second admission', async () => {
  // Relay-first: the automatic relay reached the message before the model's own call did, so the
  // row is owned by the relay's derived id. The later native call must answer from that receipt
  // rather than invoke the service under its own id with a model-rewritten payload.
  const { session, requestId: sourceRequestId, messageId } = await provenCaller('Relay-first fixture.');
  const worksBefore = store.countWorks();
  const relayRequestId = controllerRequestId(session.sessionId, messageId);
  const relayRow = claimWorkControllerTurn({
    sessionId: session.sessionId,
    conversationId: session.conversationId,
    messageId,
    text: 'Relay-first fixture.',
    authoredAt: clock,
    workId: null
  });
  expect(relayRow!.request_id).toBe(relayRequestId);
  // The relay's own admission, under the id it owns.
  const relayed = payload(await workControl({ action: 'start', input: startArgs(relayRequestId, 'Relay-first fixture.') }, sourceRequestId));

  const nativeId = randomUUID();
  const joined = payload(await workControl({ action: 'start', input: startArgs(nativeId, 'A different payload under a new id.') }, sourceRequestId));
  expect(joined.work_id).toBe(relayed.work_id);
  // The answer is the receipt the relay's own admission committed — its request id, not this
  // caller's, and not a revision recomputed from whatever the work happens to be now.
  expect(joined.request_id).toBe(relayRequestId);
  expect(joined).toEqual(relayed);
  // One work and one command: the joined answer reuses the receipt that already exists, and this
  // caller's own id never enters the ledger.
  expect(store.countWorks()).toBe(worksBefore + 1);
  expect(store.getCommand(nativeId)).toBeNull();
});

it('recovers a crash between command admission and inbox acceptance under the same public id', async () => {
  const { session, requestId: sourceRequestId, messageId } = await provenCaller('Crash replay fixture.');
  const requestId = randomUUID();
  const receipt = payload(await workControl({ action: 'start', input: startArgs(requestId, 'Crash replay fixture.') }, sourceRequestId));
  const worksBefore = store.countWorks();

  // The process died after the durable admission and before the inbox row recorded it.
  store.updateControllerMessage(session.sessionId, messageId, {
    state: 'pending',
    error: 'simulated crash before the receipt was recorded'
  });
  resetWorkContinuityForTests();
  await initWorkContinuity(continuityDeps(service));
  await recoverWorkContinuity();

  // Recovered from the persisted receipt: same public id, same work, and nothing started twice.
  const row = store.getControllerMessage(session.sessionId, messageId);
  expect(row!.state).toBe('accepted');
  expect(row!.request_id).toBe(requestId);
  expect(row!.work_id).toBe(receipt.work_id);
  expect(store.countWorks()).toBe(worksBefore);
});

it('never moves an existing controller onto a work the same conversation starts later', async () => {
  // A start creates a work. It does not take the user's chat off the work that chat is already
  // driving and onto an unrelated one — not even when the chat is the one that asked for the new
  // work, and not even when its binding is enabled. The new work's receipt is returned unchanged;
  // only the binding is left alone.
  const { session, requestId: sourceRequestId } = await provenCaller('Controller A fixture.');
  const first = payload(await workControl({ action: 'start', input: startArgs(randomUUID(), 'Work A.') }, sourceRequestId));
  const bound = getWorkControllerBinding(session.sessionId)!;
  expect(bound.work_id).toBe(first.work_id);
  expect(bound.enabled).toBe(true);

  // A later, genuinely distinct turn of the same conversation starts work B.
  const nextAt = clock += 1_000;
  const nextRequest = `wfr_${randomUUID()}`;
  await recordTurn({
    session,
    requestId: nextRequest,
    messageId: `msg-${randomUUID()}`,
    text: 'Now start something unrelated.',
    authoredAt: nextAt,
    startedAt: nextAt + 50,
    reportedAt: nextAt + 100
  });
  const second = payload(await workControl({ action: 'start', input: startArgs(randomUUID(), 'Work B.') }, nextRequest));
  expect(second.work_id).not.toBe(first.work_id);
  // The receipt is real; the binding is not touched.
  const after = getWorkControllerBinding(session.sessionId)!;
  expect(after.work_id).toBe(first.work_id);
  expect(after.enabled).toBe(true);
});

it('takes over the automatic prime binding so a crash-recovered start still binds its own chat', async () => {
  // The recovery shape, built the way a crash leaves it: the admission is durable, the runtime's
  // automatic prime fallback bound the prime chat, and the requesting conversation was never bound
  // at all. Replaying the start must hand the work to the chat that asked for it — the binding is
  // recorded as automatic, so it may be taken over. A binding a person chose never is.
  const { session, requestId: sourceRequestId } = await provenCaller('Prime fallback recovery fixture.');
  const primeSession = await chat();
  const requestId = randomUUID();
  const args = startArgs(requestId, 'Prime fallback recovery fixture.');
  const receipt = await service.start({ ...args, project_path: dir });
  store.putControllerBinding({
    session_id: primeSession.sessionId,
    conversation_id: primeSession.conversationId,
    work_id: receipt.work_id,
    bound_at: clock,
    enabled: true,
    event_cursor: 0,
    updated_at: clock,
    origin: 'automatic'
  });

  // The caller retries its own start under the id it already owns: the service replays the receipt,
  // and the work is bound to the conversation that asked for it.
  const replayed = payload(await workControl({ action: 'start', input: args }, sourceRequestId));
  expect(replayed.work_id).toBe(receipt.work_id);
  const after = getWorkControllerBinding(session.sessionId)!;
  expect(after.work_id).toBe(receipt.work_id);
  expect(after.enabled).toBe(true);
  // The displaced automatic binding is disabled rather than deleted, so its history stays honest.
  expect(getWorkControllerBinding(primeSession.sessionId)!.enabled).toBe(false);
});

it('never takes over a binding a person chose, even on a replay of the start', async () => {
  // The same replay shape, with the prime chat's binding recorded as explicit. Nothing a start does
  // may move a controller a person chose.
  const { session, requestId: sourceRequestId } = await provenCaller('Explicit controller fixture.');
  const other = await chat();
  const requestId = randomUUID();
  const args = startArgs(requestId, 'Explicit controller fixture.');
  const receipt = payload(await workControl({ action: 'start', input: args }, sourceRequestId));
  const workId = String(receipt.work_id);

  const own = getWorkControllerBinding(session.sessionId)!;
  store.putControllerBinding({ ...own, enabled: false, updated_at: clock });
  store.putControllerBinding({
    session_id: other.sessionId,
    conversation_id: other.conversationId,
    work_id: workId,
    bound_at: clock,
    enabled: true,
    event_cursor: 0,
    updated_at: clock,
    origin: 'explicit'
  });

  const replayed = payload(await workControl({ action: 'start', input: args }, sourceRequestId));
  expect(replayed.work_id).toBe(workId);
  expect(getWorkControllerBinding(session.sessionId)!.enabled).toBe(false);
  expect(getWorkControllerBinding(other.sessionId)!.enabled).toBe(true);
});

it('never reactivates a controller the user disabled', async () => {
  // Disabling the feature is a decision. A later start from that same conversation does not
  // silently reverse it, and it does not steal the binding for the new work either.
  const { session, requestId: sourceRequestId } = await provenCaller('Disabled binding fixture.');
  const first = payload(await workControl({ action: 'start', input: startArgs(randomUUID(), 'First work.') }, sourceRequestId));
  const before = getWorkControllerBinding(session.sessionId)!;
  expect(before.work_id).toBe(first.work_id);

  store.putControllerBinding({ ...before, enabled: false, updated_at: clock });

  // A later, genuinely distinct turn of the same conversation asks for a new work.
  const nextAt = clock += 1_000;
  const nextRequest = `wfr_${randomUUID()}`;
  await recordTurn({
    session,
    requestId: nextRequest,
    messageId: `msg-${randomUUID()}`,
    text: 'Now start a second work.',
    authoredAt: nextAt,
    startedAt: nextAt + 50,
    reportedAt: nextAt + 100
  });
  const second = payload(await workControl({ action: 'start', input: startArgs(randomUUID(), 'Second work.') }, nextRequest));
  const after = getWorkControllerBinding(session.sessionId)!;
  expect(after.enabled).toBe(false);
  expect(after.work_id).toBe(before.work_id);
  expect(second.work_id).not.toBe(before.work_id);
});

it('leaves coding tools to their own permissions while the work controls run', async () => {
  // The real admission gate and its real validator, installed exactly as production does. A call
  // that is not a managed work's own is ordinary coding: the sandbox, the capability set and
  // Read-only decide it, not a missing worker identity.
  setManagedToolGate(managedToolGate);

  // An unapproved absolute path is still refused by the sandbox, and nothing is written. The
  // refusal is the inner tool's, so it is read from the script's own output rather than from
  // `exec`'s status: `exec` itself is not the tool that refused.
  const outside = await makeTempDir('wgpt-unmanaged-');
  const target = path.join(outside, 'must-not-exist.txt');
  try {
    const patch = ['*** Begin Patch', `*** Add File: ${target}`, '+unmanaged', '*** End Patch'].join('\n');
    const patched = resultOf(await coreCall('tools/call', { name: 'exec', arguments: { code: `text(await tools.apply_patch(${JSON.stringify(patch)}));` } }));
    expect(patched.text).toContain('Approved roots');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await removeTempDir(outside);
  }

  // The work controls need no worker identity and no proven turn: a start from a caller this app
  // cannot place is admitted by the connector's authentication alone.
  const receipt = payload(await workControl({ action: 'start', input: startArgs(randomUUID(), 'Controls stay open while coding is gated.') }));
  expect(receipt.status).toBe('queued');
});
it('starts nothing on a wrong token, a non-loopback Host or a cross-site Origin', async () => {
  const { requestId: sourceRequestId } = await provenCaller('Must never be admitted.');
  const before = store.countWorks();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7001, method: 'tools/call', params: { name: 'work', arguments: { action: 'start', input: startArgs(randomUUID(), 'Must never be admitted.') } } });
  const headers = { 'x-request-id': sourceRequestId };

  const wrongToken = new URL(endpoint.url);
  wrongToken.pathname = `${wrongToken.pathname}-wrong`;
  expect((await rawPost(wrongToken.toString(), body, headers)).status).toBe(404);

  const badHost = await rawPost(endpoint.url, body, { ...headers, host: 'evil.example.com' });
  expect(badHost.status).toBe(403);

  const badOrigin = await rawPost(endpoint.url, body, { ...headers, origin: 'https://evil.example.com' });
  expect(badOrigin.status).toBe(403);

  expect(store.countWorks()).toBe(before);
});

it('reports the last work-control call separately from a refused one', async () => {
  const succeeded = payload(await workControl({ action: 'list', input: { limit: 1 } }));
  expect(succeeded.works).toBeDefined();
  const afterSuccess = lastWorkControlAt();
  expect(afterSuccess).not.toBeNull();

  // A refusal is evidence that the connector was reached, which the tool clock already records —
  // but it is not evidence that a conversation drove work, so this clock must not move for it.
  const refused = resultOf(await workControl({ action: 'status', input: { work_id: randomUUID() } }));
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain('WORK_NOT_FOUND');
  expect(lastWorkControlAt()).toBe(afterSuccess);
});

it('refuses unapproved projects before durable admission', async () => {
  const outside = await makeTempDir('wgpt-unapproved-work-');
  try {
    await initGitProject(outside);
    const { requestId: sourceRequestId } = await provenCaller('Unapproved project.');
    const before = store.countWorks();
    const refused = resultOf(await workControl({
      action: 'start',
      input: { ...startArgs(randomUUID()), project_path: outside }
    }, sourceRequestId));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('PROJECT_PATH_INVALID');
    expect(store.countWorks()).toBe(before);
  } finally {
    await removeTempDir(outside);
  }
});

it('read-only blocks execution controls but still permits status and cancellation', async () => {
  const { requestId: sourceRequestId } = await provenCaller('Read-only fixture.');
  const receipt = payload(await workControl({ action: 'start', input: startArgs(randomUUID()) }, sourceRequestId));
  const workId = String(receipt.work_id);
  const before = store.countWorks();
  ctx.readOnly = true;
  try {
    for (const request of [
      { action: 'start', input: startArgs(randomUUID()) },
      { action: 'instruct', input: { request_id: randomUUID(), work_id: workId, text: 'Do not run' } },
      { action: 'control', input: { request_id: randomUUID(), work_id: workId, action: 'resume' } }
    ]) {
      const refused = resultOf(await workControl(request, sourceRequestId));
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('TOOL_DISABLED');
    }
    expect(store.countWorks()).toBe(before);
    const status = payload(await workControl({ action: 'status', input: { work_id: workId } }));
    expect(status.work_id).toBe(workId);
    const cancelled = payload(await workControl({ action: 'control', input: { request_id: randomUUID(), work_id: workId, action: 'cancel' } }, sourceRequestId));
    expect(cancelled.status).toBe('cancelled');
  } finally {
    ctx.readOnly = false;
  }
});
