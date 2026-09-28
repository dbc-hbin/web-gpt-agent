/**
 * Mobile continuity, end to end through the three real modules.
 *
 * Every other continuity suite proves one side of the seam with a stub on the other. This one runs
 * the *shipped* provider collector, the *real* HTTP bridge and the *real* continuity manager over
 * one isolated temporary directory, and asserts what the user actually gets: a message the phone
 * wrote in a bound controller chat becomes a durable managed instruction in the outbox.
 *
 * Three modules are real, and only the two boundaries that genuinely need a browser or a network
 * are faked:
 *
 *  · `extension/provider-conversation.js` — the shipped collector, against a fake `fetch` that
 *    serves the same two endpoints the real one does (`/api/auth/session`, then
 *    `/backend-api/conversation/<id>`). No browser, no account, no live ChatGPT.
 *  · `src/main/bridge.ts` — started for real, over real loopback HTTP, paired and authenticated
 *    exactly as the extension pairs.
 *  · `src/main/work/continuity.ts` + `service.ts` + `input-outbox.ts` — the real manager, the real
 *    service and the real outbox, wired through the same queries `src/main/index.ts` installs.
 *
 * The two seams are the transport ones: `start-input` (which would open a real ChatGPT tab) and the
 * runtime port's `deliver` (which is the only thing the service calls to hand a message over).
 * Everything either side of them — admission, the inbox row, the instruction, the command and the
 * durable outbox row — is production code.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readControllerConversations } from '../extension/provider-conversation.js';
import type { ProviderWatch } from '../extension/provider-conversation.js';

/** The only transport seam: a real send would open a ChatGPT tab in the user's own browser. */
vi.mock('../src/main/session/start-input.js', async () => {
  const { enqueueInput } = await import('../src/main/session/input.js');
  return {
    sendDesktopInput: async (input: { id: string }, options?: { generatedBy?: unknown; workInput?: unknown }) =>
      await enqueueInput(input as never, undefined, options?.generatedBy as never, options?.workInput as never),
    retryQueuedInputBrowser: async () => null,
    cancelDesktopInput: async () => false,
    stopInputStartup: () => {},
    resetInputStartupForTests: () => {}
  };
});

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'unknown'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  clipboard: {},
  shell: {}
}));

const { initConfigPath, defaultConfig, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { useDataDir } = await import('../src/main/identity.js');
const { initDurableStore, flushDurable, resetDurableForTests } = await import('../src/main/durable.js');
const { initSessionStore, createSession, rebindSession, resetSessionStoreForTests, appendEvent } =
  await import('../src/main/session/store.js');
const {
  resetInputForTests, listInputs, configureInputDelivery, sessionInputPolicy,
  claimBrowserInput, authorizeBrowserInput, acknowledgeBrowserInput
} = await import('../src/main/session/input.js');
const { recordDeliveredInput } = await import('../src/main/session/input-history.js');
const { createWorkStore } = await import('../src/main/work/store.js');
const { createWorkService } = await import('../src/main/work/service.js');
const {
  deliverWorkInput, readWorkInput, setWorkInputBindingQuery, setWorkInputInstructionQuery,
  workInputAllowed, workInstructionAllowed, workInputOrigin, resetWorkInputForTests
} = await import('../src/main/work/input-outbox.js');
const {
  initWorkContinuity, drainWorkContinuity, resetWorkContinuityForTests, getWorkControllerBinding,
  setWorkContinuityOriginQuery
} = await import('../src/main/work/continuity.js');
const { startBridge, stopBridge, resetBridgeForTests } = await import('../src/main/bridge.js');
const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');

const CONTROLLER_CHAT = 'a1a1a1a1-2222-4333-8444-555555555555';
const ACCOUNT = 'account-e2e';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
/** The binding instant. Provider timestamps are seconds, this app's are milliseconds. */
const BOUND_AT = Date.parse('2026-09-05T12:00:00Z');

let directory = '';
let base = '';
let token: string | null = null;
let store: Awaited<ReturnType<typeof createWorkStore>>;
let sessionId = '';
let workId = '';

/** A response object with the two members the collector actually uses. */
function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
}

/**
 * The provider, as the collector sees it: a session and one conversation document.
 *
 * `current_node` is the branch tip and every node names its `parent`, which is exactly the shape
 * the collector walks — so the branch it reads is the provider's own active branch, not the
 * rendering order of any page.
 */
function providerFetch(nodes: Array<Record<string, unknown>>) {
  const mapping = Object.fromEntries(nodes.map(node => [node['id'], node]));
  const document = { conversation_id: CONTROLLER_CHAT, current_node: nodes.at(-1)!['id'], mapping };
  return vi.fn(async (url: string) => {
    if (String(url).includes('/api/auth/session')) {
      return reply(200, { accessToken: 'provider-token', account: { id: ACCOUNT } });
    }
    if (String(url).includes(`/backend-api/conversation/${CONTROLLER_CHAT}`)) return reply(200, document);
    return reply(404, { error: 'unexpected' });
  });
}

function providerNode(id: string, parent: string | null, role: string, text: string, seconds: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    parent,
    message: {
      id,
      author: { role },
      content: { content_type: 'text', parts: text ? [text] : [] },
      status: 'finished_successfully',
      create_time: seconds,
      ...extra
    }
  };
}

/** The bridge, over real loopback HTTP, authenticated the way the extension authenticates. */
function bridgeRequest(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = {
    origin: EXTENSION_ORIGIN,
    'x-extension-version': APP_VERSION,
    'x-extension-protocol': String(BRIDGE_PROTOCOL)
  };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = text;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is itself a finding */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** One work, its controller session and binding, and the real manager over them. */
async function host(): Promise<void> {
  // A scratch file per test, like every other ledger fixture: the agent table is unique on
  // conversation_id, so a shared file would collide with the previous test's prime row.
  store = createWorkStore({ dataDir: directory, fileName: `work-${randomUUID()}.sqlite` });
  workId = randomUUID();
  store.insertWork({
    work_id: workId, title: 'Continuity e2e', goal: 'Prove the whole path.', project_path: directory,
    project_name: 'continuity-e2e', base_commit: null, integration_branch: `wgpt/${workId}/main`,
    integration_worktree: path.join(directory, 'worktrees', workId), status: 'running', desired_state: null,
    prime_agent_id: null, prime_session_id: null, model: null, reasoning: null, max_workers: 2,
    revision: 0, blocker: null, checkpoint: null, integration_intent: null,
    predecessor_work_id: null, successor_work_id: null, created_at: Date.now(), updated_at: Date.now()
  });
  const session = await createSession({ title: 'Controller', origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  await rebindSession(session.id, null, CONTROLLER_CHAT);
  sessionId = session.id;
  // The prime's own conversation is this chat, so the manager's duplicate-execution check has a
  // real prime row to reason about rather than a missing one.
  const primeId = randomUUID();
  store.insertAgent({
    agent_id: primeId, work_id: workId, parent_id: null, role: 'prime', label: 'prime', state: 'active',
    session_id: session.id, conversation_id: CONTROLLER_CHAT, generation: 0,
    worktree_path: path.join(directory, 'worktrees', workId), branch: `wgpt/${workId}/main`, base_commit: null,
    model: null, reasoning: null, result_ref: null, checkpoint_ref: null, created_at: Date.now(), updated_at: Date.now()
  });
  store.updateWork(workId, { prime_agent_id: primeId, prime_session_id: session.id });
  store.putControllerBinding({
    session_id: session.id, conversation_id: CONTROLLER_CHAT, provider_account_id: ACCOUNT,
    work_id: workId, bound_at: BOUND_AT, enabled: true, event_cursor: 0, updated_at: Date.now()
  });
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-continuity-e2e-'));
  initConfigPath(directory);
  initSecretsPath(directory);
  useDataDir(directory);
  await saveConfig(defaultConfig());
  const port = await startBridge();
  expect(port, 'no loopback port was free').not.toBeNull();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await stopBridge();
  resetSessionStoreForTests();
  resetDurableForTests();
  await flushDurable();
  await fs.rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  // A fresh store directory per case. The durable session store outlives a process-local reset, and
  // one controller conversation cannot be bound to two sessions — so a shared directory would make
  // the second case's rebind fail and quietly leave it unbound.
  const scratch = await fs.mkdtemp(path.join(directory, 'case-'));
  initConfigPath(directory);
  initSecretsPath(directory);
  initDurableStore(scratch);
  initSessionStore(scratch);
  await saveConfig(defaultConfig());
  await setSecret('bridgeToken', '');
  token = null;
  resetBridgeForTests();
  resetInputForTests();
  resetWorkInputForTests();
  resetWorkContinuityForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await flushDurable();
  await host();
  // The exact wiring src/main/index.ts installs, so the fences the real host applies are the ones
  // under test: the binding query for generated reports, the work authority for instructions, and
  // the provenance query the manager asks about a page-reported message.
  setWorkInputBindingQuery(id => {
    const binding = getWorkControllerBinding(id);
    return binding ? { workIds: [binding.work_id], conversationId: binding.conversation_id,
      providerAccountId: binding.provider_account_id, boundAt: binding.bound_at, enabled: binding.enabled } : null;
  });
  setWorkInputInstructionQuery(id => {
    const work = store.getWork(id);
    if (!work) return null;
    return { primeSessionId: work.prime_session_id,
      active: !work.desired_state && !['paused', 'cancelled', 'completed'].includes(work.status) };
  });
  setWorkContinuityOriginQuery(input => workInputOrigin(input.sessionId, input.messageId, input.text));
  configureInputDelivery({
    applyAutomation: async () => {},
    changed: () => {},
    recordDelivered: (entry, anchor) => recordDeliveredInput(entry, anchor),
    generatedAllowed: workInputAllowed,
    instructionAllowed: workInstructionAllowed,
    messageOrigin: async ({ sessionId: id, messageId, text }) => workInputOrigin(id, messageId, text)
  });
  await initWorkContinuity({
    store,
    service: () => service,
    conversationSettled: async ({ sessionId: id }) => {
      const policy = await sessionInputPolicy(id).catch(() => null);
      return Boolean(policy && policy.settled && policy.browserAllowed);
    },
    messageOrigin: async ({ sessionId: id, messageId, text }) => workInputOrigin(id, messageId, text),
    deliverReport: async report => deliverWorkInput({
      id: report.id, sessionId: report.sessionId, text: report.text, model: report.model,
      reasoning: report.reasoning, dueAt: report.dueAt, kind: 'controller-report', workId: report.workId,
      conversationId: report.conversationId, providerAccountId: report.providerAccountId, boundAt: report.boundAt
    }),
    reconcileReport: async ({ id }) => readWorkInput(id),
    cancelReport: async ({ id }) => {
      const { cancelWorkInput } = await import('../src/main/work/input-outbox.js');
      return cancelWorkInput(id);
    }
  });
  // The real service, with the real outbox as its delivery path — exactly what index.ts wires.
  service = createWorkService({
    store,
    runtime: {
      async beginStart() { /* no worktree, no browser: this fixture is about the relay */ },
      async deliver(input) {
        const prime = input.workId ? store.getWork(input.workId) : null;
        const result = await deliverWorkInput({
          id: input.outboxInputId, sessionId: prime?.prime_session_id ?? sessionId, text: input.text ?? '',
          model: prime?.model ?? null, reasoning: prime?.reasoning ?? null, dueAt: input.commandCreatedAt,
          // A managed instruction: without `kind` a `workId` means a controller *report*, which
          // carries its own destination authority and is the other half of this contract.
          kind: 'instruction', workId: input.workId
        });
        return result.state === 'delivered' ? { state: 'delivered' as const }
          : result.state === 'unknown' ? { state: 'unknown' as const, error: result.error ?? 'unknown' }
          : result.state === 'failed' ? { state: 'failed' as const, error: result.error ?? 'failed' }
          : result.state === 'cancelled' ? { state: 'cancelled' as const }
          : { state: 'queued' as const };
      },
      async control(input) { return { status: input.action === 'cancel' ? 'cancelled' : 'paused' }; },
      async reconcile() { /* the ledger is already the source of truth */ }
    },
    projects: {
      async resolve(inputPath) { return { path: inputPath, name: path.basename(inputPath), exists: true, isGit: true }; },
      async list() { return []; }
    },
    models: { async resolve() { return { model: null, reasoning: null }; } },
    worktreesRoot: path.join(directory, 'worktrees')
  });
  await service.reconcile();
});

let service: Awaited<ReturnType<typeof createWorkService>>;

afterEach(async () => {
  await drainWorkContinuity();
  resetWorkContinuityForTests();
  service?.close();
  store?.close();
  resetInputForTests();
  resetWorkInputForTests();
  setWorkInputBindingInstructionQueryOff();
});

/** The three host queries are module-level; leaving them installed would leak into another suite. */
function setWorkInputBindingInstructionQueryOff(): void {
  setWorkInputBindingQuery(null);
  setWorkInputInstructionQuery(null);
  setWorkContinuityOriginQuery(null);
}

async function pair(): Promise<void> {
  const reply = await bridgeRequest('POST', '/pair', {});
  expect(reply.status).toBe(200);
  token = reply.body.token as string;
}

/**
 * Waits for the manager's routing to reach the outbox, then returns the admitted *instructions*.
 *
 * The same pump also reports durable work state back into the controller's chat, and those report
 * rows are a real part of this contract — they are just the other direction, so they are filtered
 * out here rather than confused with what the phone asked for.
 */
async function waitForInstruction(count = 1): Promise<Awaited<ReturnType<typeof listInputs>>> {
  const instructions = async () => (await listInputs()).filter(row => row.workInput);
  await vi.waitFor(async () => {
    await service.pumpNow();
    const rows = await instructions();
    expect(rows.map(row => `${row.state}:${row.text.slice(0, 40)}`)).toHaveLength(count);
  }, { timeout: 5_000 });
  return await instructions();
}

describe('mobile continuity, real collector through the real bridge into the real manager', () => {
  it('reads a bound chat from the provider and admits its message as a durable managed instruction', async () => {
    await pair();
    const status = await bridgeRequest('POST', '/status', { openConversations: [] });
    const watches = status.body.controllerWatches as ProviderWatch[];
    expect(watches).toHaveLength(1);
    const watch = watches[0]!;
    expect(watch).toMatchObject({ conversationId: CONTROLLER_CHAT, providerAccountId: ACCOUNT, boundAt: BOUND_AT });
    expect(typeof watch.observationToken).toBe('string');

    // The shipped collector, reading the provider's own branch through its own parent links. Only
    // the network is faked: `/api/auth/session` then the exact bound conversation id.
    const fetchImpl = providerFetch([
      providerNode('root', null, 'system', '', BOUND_AT / 1000 - 600),
      providerNode('u1', 'root', 'user', 'Add a --dry-run flag to the deploy script', BOUND_AT / 1000 + 60),
      providerNode('a1', 'u1', 'assistant', 'I will add the flag and a test.', BOUND_AT / 1000 + 70, { end_turn: true })
    ]);
    const [read] = await readControllerConversations(watches, { fetchImpl });
    expect(read?.ok, JSON.stringify(read)).toBe(true);
    if (read?.ok !== true) return;
    expect(read.providerAccountId).toBe(ACCOUNT);
    expect(read.pages.flat().map(message => message.messageId)).toEqual(['u1']);

    // One page per transport body, under the watch's own authority, exactly as the service worker
    // posts them. The bridge is the real one, over real HTTP, with its real parser and assembler.
    const snapshotId = `${CONTROLLER_CHAT}:${watch.observationToken}:1`;
    for (let index = 0; index < read.pages.length; index++) {
      const reply = await bridgeRequest('POST', '/controller/observe', {
        conversationId: read.conversationId,
        providerAccountId: read.providerAccountId,
        messages: read.pages[index],
        complete: read.exhaustive,
        settled: read.settled,
        sessionId: watch.sessionId,
        boundAt: watch.boundAt,
        observationToken: watch.observationToken,
        snapshotId,
        pageIndex: index,
        lastPage: index === read.pages.length - 1
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body.ok).toBe(true);
    }

    // The message reached the ledger as a durable inbox row...
    await vi.waitFor(() => {
      expect(store.getControllerMessage(sessionId, 'u1')).not.toBeNull();
    });
    // ...and the manager routed it through the real service into the real outbox.
    const rows = await waitForInstruction();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      state: 'queued',
      workInput: { workId }
    });
    // What the work will actually read is the user's own instruction, and nothing else: no role
    // preamble, no policy block, no tool-call demand and no repeated warning. Authority is carried
    // by the structured fields above (session, work, provenance), never by prose.
    expect(rows[0]!.text).toBe('Add a --dry-run flag to the deploy script');
    expect(rows[0]!.deliveryText ?? rows[0]!.text).toBe('Add a --dry-run flag to the deploy script');
    expect(rows[0]!.generatedBy).toBeUndefined();
  });

  it('admits a two-page branch whole, in provider order, and keeps pre-binding history out', async () => {
    await pair();
    const watches = (await bridgeRequest('POST', '/status', { openConversations: [] })).body.controllerWatches as ProviderWatch[];
    const watch = watches[0]!;

    // History before the binding, then the phone's own backlog. The collector reads the whole
    // branch and the host refuses only what predates the boundary — never by dropping it silently
    // in the reader, which would make the walk look exhaustive when it was not.
    const fetchImpl = providerFetch([
      providerNode('root', null, 'system', '', BOUND_AT / 1000 - 900),
      providerNode('old', 'root', 'user', 'Something the user said before binding', BOUND_AT / 1000 - 600),
      providerNode('old-a', 'old', 'assistant', 'Answered long ago.', BOUND_AT / 1000 - 500, { end_turn: true }),
      providerNode('r1', 'old-a', 'user', 'Requirements: parse the config, then validate it', BOUND_AT / 1000 + 10),
      providerNode('r1-a', 'r1', 'assistant', 'Plan: parse, validate, then report.', BOUND_AT / 1000 + 20, { end_turn: true }),
      providerNode('r2', 'r1-a', 'user', 'Correction: validate first', BOUND_AT / 1000 + 30),
      providerNode('r2-a', 'r2', 'assistant', 'Understood.', BOUND_AT / 1000 + 40, { end_turn: true })
    ]);
    const [read] = await readControllerConversations(watches, { fetchImpl });
    expect(read?.ok).toBe(true);
    if (read?.ok !== true) return;
    expect(read.pages.flat().map(message => message.messageId)).toEqual(['r1', 'r2']);

    const snapshotId = `${CONTROLLER_CHAT}:${watch.observationToken}:2`;
    for (let index = 0; index < read.pages.length; index++) {
      const reply = await bridgeRequest('POST', '/controller/observe', {
        conversationId: read.conversationId, providerAccountId: read.providerAccountId,
        messages: read.pages[index], complete: read.exhaustive, settled: read.settled,
        sessionId: watch.sessionId, boundAt: watch.boundAt, observationToken: watch.observationToken,
        snapshotId, pageIndex: index, lastPage: index === read.pages.length - 1
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    }

    // Both messages are admitted to the durable inbox in provider order...
    const rows = await waitForInstruction();
    expect(rows).toHaveLength(1);
    // The user's own words come first and this message's own predecessor closes it. Both are read
    // from the graph, so the assertions are about which message was quoted, not about the wording
    // of the line that introduces it.
    const relayed = rows[0]!.text;
    const user = 'Requirements: parse the config, then validate it';
    // r1's own predecessor on the provider's active branch — not the newest assistant message, and
    // not the sibling's answer.
    const quoted = 'Answered long ago.';
    expect(relayed.startsWith(user)).toBe(true);
    expect(relayed.endsWith(quoted)).toBe(true);
    expect(relayed).not.toContain('Plan: parse, validate, then report.');
    // ...and the second is not lost: the outbox admits one message per conversation at a time, so
    // the correction is already a durable command waiting for the first to go. Provider order is
    // what decides which one that is — a correction must never overtake the requirement it corrects.
    const commands = await vi.waitFor(() => {
      const all = store.listCommands(workId, 10);
      expect(all.map(c => `${c.delivery_state}/${c.attempts}/${(c.text ?? '').slice(0, 20)}/${c.last_error ?? ''}`)).toHaveLength(2);
      return all;
    }, { timeout: 5_000 });
    expect(commands.every(command => command.kind === 'instruct')).toBe(true);
    const waiting = commands.find(command => command.text?.includes('validate first'));
    expect(waiting, 'the correction must be a durable command, not a dropped message').toBeTruthy();
    // The correction carries *its* own predecessor — the plan that answered the requirements —
    // and not the answer attached to the first message.
    const corrected = waiting!.text!;
    expect(corrected.startsWith('Correction: validate first')).toBe(true);
    expect(corrected.endsWith('Plan: parse, validate, then report.')).toBe(true);
    expect(corrected).not.toContain('Answered long ago.');
    expect(store.getControllerMessage(sessionId, 'r1')!.state).toBe('accepted');
    expect(store.getControllerMessage(sessionId, 'r2')!.state).toBe('accepted');
    // The pre-binding message never became an instruction.
    expect(store.getControllerMessage(sessionId, 'old')).toBeNull();
  });

  it('never relays the app\'s own report back into the work, and never double-runs a message the prime handled', async () => {
    await pair();
    const watches = (await bridgeRequest('POST', '/status', { openConversations: [] })).body.controllerWatches as ProviderWatch[];
    const watch = watches[0]!;
    const snapshotId = `${CONTROLLER_CHAT}:${watch.observationToken}:3`;

    // A report this app generated into the controller chat is provider-authored as far as the page
    // can see, and it is on the branch — so the page reports it like any other user message. It must
    // never come back as a new instruction.
    const generated = await deliverWorkInput({
      id: randomUUID(), sessionId, text: 'Worker finished: deploy script updated.',
      model: null, reasoning: null, dueAt: Date.now(), kind: 'controller-report', workId,
      conversationId: CONTROLLER_CHAT, providerAccountId: ACCOUNT, boundAt: BOUND_AT
    });
    expect(generated.state).toBe('queued');
    const reportRow = (await listInputs()).find(row => row.generatedBy)!;
    const generatedId = reportRow.id;
    // The page claimed the report and authorized its Send, which is the only way this message can
    // appear in the conversation at all — an echo of a report that was never handed out is not a
    // shape the browser can produce.
    // A report is an after-turn message: it waits for the controller conversation to finish a
    // turn, which is the boundary the real host would observe before offering it.
    await appendEvent(sessionId, { kind: 'turn_end', time: Date.now(), turnId: 'controller-turn-1', outcome: 'completed', source: 'extension' });
    expect(await claimBrowserInput(reportRow.id, 'controller-page', CONTROLLER_CHAT, true)).toBeTruthy();
    expect(await authorizeBrowserInput(reportRow.id, 'controller-page', CONTROLLER_CHAT)).toBe(true);
    // The page submitted it, and the native ACK landed: the report now has a real provider message
    // id, which is what makes its later echo provably *this* app's output rather than a person's.
    expect(await acknowledgeBrowserInput(reportRow.id, 'controller-page', CONTROLLER_CHAT, 'app-echo')).toBe(true);

    const fetchImpl = providerFetch([
      providerNode('root', null, 'system', '', BOUND_AT / 1000 - 600),
      providerNode('app-echo', 'root', 'user', 'Worker finished: deploy script updated.', BOUND_AT / 1000 + 60)
    ]);
    const [read] = await readControllerConversations(watches, { fetchImpl });
    if (read?.ok !== true) throw new Error('expected a snapshot');

    const reply = await bridgeRequest('POST', '/controller/observe', {
      conversationId: read.conversationId, providerAccountId: read.providerAccountId,
      messages: read.pages[0], complete: read.exhaustive, settled: read.settled,
      sessionId: watch.sessionId, boundAt: watch.boundAt, observationToken: watch.observationToken,
      snapshotId, pageIndex: 0, lastPage: true
    });
    expect(reply.status).toBe(200);

    await vi.waitFor(() => {
      const row = store.getControllerMessage(sessionId, 'app-echo');
      expect(row).not.toBeNull();
      expect(row!.state).not.toBe('pending');
    }, { timeout: 5_000 });
    // Refused as app output rather than executed: no instruction was created from the echoed
    // message, and the report rows that do exist are the ones this app generated.
    const rows = await listInputs();
    expect(rows.filter(row => row.workInput)).toEqual([]);
    expect(rows.some(row => row.id === generatedId)).toBe(true);
    expect(rows.every(row => row.generatedBy !== undefined)).toBe(true);
    const refusal = store.getControllerMessage(sessionId, 'app-echo')!;
    expect(refusal.state).toBe('rejected');
    // The refusal names what it was, rather than leaving a message that silently never runs.
    expect(refusal.error).toContain('generated');
  });
});
