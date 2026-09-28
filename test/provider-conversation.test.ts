/**
 * The authenticated provider read behind mobile continuity.
 *
 * This executes the shipped `extension/provider-conversation.js` against a fake `fetch`, which is
 * the only way to prove the things that matter here without a browser or a live account: that an
 * unanchored binding is read and *anchored* by the account the document was served under, that an
 * anchored binding is refused **before** the conversation is requested when the browser is signed
 * into somebody else, that a closed chat's branch is walked from `current_node` through real
 * `parent` links, and that every unusable shape fails closed instead of reporting a plausible
 * branch.
 */

import { describe, expect, it, vi } from 'vitest';
import { readControllerConversations, readProviderAccountId } from '../extension/provider-conversation.js';
import type { ProviderReadFailure, ProviderReadResult, ProviderSnapshotMessage, ProviderWatch } from '../extension/provider-conversation.js';

const CONVERSATION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_CONVERSATION = '99999999-8888-4777-8666-555555555555';
const ACCOUNT = 'account-one';
const OTHER_ACCOUNT = 'account-two';

/**
 * The binding instant, in the same clock the provider's own timestamps are converted into.
 *
 * The host's `boundAt` is a millisecond epoch and the provider's `create_time` is seconds, so a
 * fixture that mixes the two would pass for the wrong reason — every message would look newer than
 * the binding. These are the real units.
 */
const BOUND_AT = Date.parse('2026-09-05T12:00:00Z');
/** A provider timestamp, expressed in milliseconds the way the reader reports it. */
const at = (offsetMs: number) => BOUND_AT + offsetMs;

/** A real streamed response, so tests exercise the production byte-bounded parser. */
function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}


/** One provider message node, as the fixture builder takes it. */
interface NodeInput {
  id: string;
  parent: string | null;
  role: string;
  text?: string;
  /** A millisecond instant in this app's own clock. */
  created?: number;
  status?: string;
  endTurn?: boolean;
  requestId?: string;
  channel?: string;
}

/**
 * One conversation's read, through the same entry point the service worker uses.
 *
 * The module exposes exactly one read API — the batch the worker calls — so these cases drive the
 * real surface rather than a test-only single-watch wrapper.
 */
async function readOne(watch: ProviderWatch, options: Parameters<typeof readControllerConversations>[1] = {}): Promise<ProviderReadResult> {
  const [result] = await readControllerConversations([watch], options);
  return result!;
}

/**
 * The whole branch a read produced, reassembled from its pages.
 *
 * The reader never returns one body: it pages the branch so that a backlog larger than one
 * transport budget is still admitted whole, so these cases read the pages back in order exactly as
 * the host's assembler does.
 */
/** The branch a read proved, reassembled from its pages. */
interface Branch {
  conversationId: string;
  providerAccountId: string;
  messages: ProviderSnapshotMessage[];
  complete: boolean;
  settled: boolean;
}

function snapshotOf(result: ProviderReadResult): Branch {
  if (result.ok !== true) throw new Error(`expected a snapshot, got: ${result.error}`);
  const messages = result.pages.flat();
  return {
    conversationId: result.conversationId,
    providerAccountId: result.providerAccountId,
    messages,
    complete: result.exhaustive,
    settled: result.settled
  };
}

/** Whether the read proved no generation is live in that conversation. */
function settledOf(result: ProviderReadResult): boolean {
  if (result.ok !== true) throw new Error(`expected a snapshot, got: ${result.error}`);
  return result.settled;
}

/** The failure a read produced, or an error saying it unexpectedly produced a snapshot. */
function failureOf(result: ProviderReadResult): ProviderReadFailure {
  if (result.ok === true) throw new Error('expected a refusal, got a snapshot');
  return result;
}

/** A provider session document. */
function session(accountId: string, accessToken = 'secret-token') {
  return { accessToken, account: { id: accountId } };
}

/**
 * One message node in a conversation document's `mapping`.
 *
 * `created` is a millisecond instant like the rest of this app; it is converted to the provider's
 * own seconds here so the fixtures read in one clock and the reader is exercised on the other.
 */
function node({ id, parent, role, text, created, status = 'finished_successfully', endTurn, requestId, channel }: NodeInput) {
  return {
    id,
    parent,
    message: {
      id,
      author: { role },
      content: { content_type: 'text', parts: text === undefined ? [] : [text] },
      status,
      ...(channel === undefined ? {} : { channel }),
      ...(created === undefined ? {} : { create_time: created / 1000 }),
      ...(endTurn === undefined ? {} : { end_turn: endTurn }),
      ...(requestId === undefined ? {} : { metadata: { request_id: requestId } })
    }
  };
}

/** A conversation document built from an ordered list of nodes. */
function conversation(nodes: Array<Record<string, unknown>>, { current, id = CONVERSATION }: { current?: string; id?: string } = {}) {
  const mapping = Object.fromEntries(nodes.map((entry) => [entry.id, entry]));
  return { conversation_id: id, current_node: current ?? nodes.at(-1)!.id, mapping };
}

/**
 * The standard branch: an answered question, then a second question the controller has not
 * answered — the shape a phone's backlog produces.
 */
function backlogBranch() {
  return [
    node({ id: 'root', parent: null, role: 'system', text: 'You are ChatGPT.' }),
    node({ id: 'u1', parent: 'root', role: 'user', text: 'First requirement', created: at(-500_000), requestId: 'wfr_first' }),
    node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'The first plan', created: at(-490_000), endTurn: true }),
    node({ id: 'u2', parent: 'a1', role: 'user', text: 'go with that plan', created: at(100_000), requestId: 'wfr_second' }),
    node({ id: 'a2', parent: 'u2', role: 'assistant', text: 'Working on it', created: at(110_000), status: 'in_progress', endTurn: false })
  ];
}

/** A fake fetch that answers by URL, and records every request. */
function provider({ accountId = ACCOUNT, document, conversationStatus = 200, sessionBody, onRequest }: {
  accountId?: string;
  document?: unknown;
  conversationStatus?: number;
  sessionBody?: unknown;
  onRequest?: (url: string, init: Record<string, unknown>) => void;
} = {}) {
  const requests: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    requests.push({ url: String(url), init });
    onRequest?.(String(url), init);
    if (String(url).includes('/api/auth/session')) {
      if (sessionBody !== undefined) return reply(200, sessionBody);
      return reply(200, session(accountId));
    }
    if (conversationStatus !== 200) return reply(conversationStatus, { error: 'no' });
    if (document === undefined) return reply(200, conversation(backlogBranch()));
    return reply(200, document);
  });
  return { fetchImpl, requests, conversationRequests: () => requests.filter((entry) => entry.url.includes('/backend-api/conversation/')) };
}

describe('provider session read', () => {
  it('reports only the account id, never the access token', async () => {
    const { fetchImpl } = provider({});
    const result = await readProviderAccountId({ fetchImpl });
    expect(result).toEqual({ ok: true, accountId: ACCOUNT });
    // The one fact the Send fence needs, and nothing else: no token, no conversation.
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('sends the browser session and never a credential of its own on the auth read', async () => {
    const { fetchImpl, requests } = provider({});
    await readProviderAccountId({ fetchImpl });
    const auth = requests[0]!;
    expect(auth.url).toBe('https://chatgpt.com/api/auth/session');
    // The browser's own cookies are what authenticate this read; nothing else may be assumed.
    expect(auth.init.credentials).toBe('include');
    expect(auth.init.headers).not.toHaveProperty('authorization');
  });

  it('refuses a session with no usable account instead of inventing one', async () => {
    const { fetchImpl } = provider({ sessionBody: { accessToken: 't' } });
    expect(await readProviderAccountId({ fetchImpl })).toEqual({
      ok: false, error: 'provider session carried no usable account id'
    });
    const tokenless = provider({ sessionBody: { account: { id: ACCOUNT } } });
    expect(await readProviderAccountId({ fetchImpl: tokenless.fetchImpl })).toEqual({
      ok: false, error: 'provider session carried no access token'
    });
  });

  it('treats a signed-out browser as a definite answer, not a transient failure', async () => {
    const fetchImpl = vi.fn(async () => reply(401, { error: 'unauthorized' }));
    const result = await readOne({ conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: null }, { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'signed_out', retryable: false });
    // Nothing was requested under an unproven session.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('unanchored bootstrap', () => {
  it('reads the exact bound conversation under the signed-in account and reports that account as the anchor', async () => {
    const { fetchImpl, conversationRequests } = provider({});
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: null },
      { fetchImpl }
    );
    expect(result.ok).toBe(true);
    // A successful exact lookup is what anchors the binding. Refusing to read while unanchored
    // would be a deadlock: no read, no anchor, and therefore never a read.
    expect(snapshotOf(result).providerAccountId).toBe(ACCOUNT);
    expect(snapshotOf(result).conversationId).toBe(CONVERSATION);
    expect(conversationRequests()).toHaveLength(1);
    expect(conversationRequests()[0]!.url).toBe(`https://chatgpt.com/backend-api/conversation/${CONVERSATION}`);
    // The exact id the host named, under the browser's own session.
    expect(conversationRequests()[0]!.init.credentials).toBe('include');
    const headers = conversationRequests()[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');
  });

  it('never enumerates or scans: only the id the host named is ever requested', async () => {
    const { fetchImpl, requests } = provider({});
    await readOne({ conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: null }, { fetchImpl });
    const conversationPaths = requests.filter((entry) => !entry.url.includes('/api/auth/session'));
    expect(conversationPaths.map((entry) => entry.url)).toEqual([
      `https://chatgpt.com/backend-api/conversation/${CONVERSATION}`
    ]);
  });
});

describe('anchored account fence', () => {
  it('refuses a different signed-in account before the conversation is requested', async () => {
    const { fetchImpl, requests, conversationRequests } = provider({ accountId: OTHER_ACCOUNT });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    expect(result).toMatchObject({ ok: false, error: 'account_mismatch', retryable: true });
    // The same conversation id under another account is a different chat, so the request is not
    // even made — and with no request there is nothing that could 404 into an account scan.
    expect(conversationRequests()).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  it('reads normally when the signed-in account is the anchored one', async () => {
    const { fetchImpl, conversationRequests } = provider({});
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    expect(result.ok).toBe(true);
    expect(snapshotOf(result).providerAccountId).toBe(ACCOUNT);
    expect(conversationRequests()).toHaveLength(1);
  });

  it('reports a 404 as a definite answer and looks nowhere else', async () => {
    const { fetchImpl, requests } = provider({ conversationStatus: 404 });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    expect(result).toMatchObject({ ok: false, error: 'conversation_not_found', retryable: false });
    // One session read and one exact conversation request. No other chat, no other account.
    expect(requests.map((entry) => entry.url)).toEqual([
      'https://chatgpt.com/api/auth/session',
      `https://chatgpt.com/backend-api/conversation/${CONVERSATION}`
    ]);
  });
});

describe('active branch walk', () => {
  it('walks current_node through real parent links and attaches each message its own predecessor', async () => {
    const { fetchImpl } = provider({});
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    expect(result.ok).toBe(true);
    const messages = snapshotOf(result).messages;
    // Provider order, oldest first, and only what may still execute: `u1` predates the binding.
    expect(messages.map((row) => row.messageId)).toEqual(['u2']);
    // The message's OWN preceding assistant message, with the id that proves which one it is.
    expect(messages[0]).toMatchObject({
      messageId: 'u2', text: 'go with that plan', authoredAt: at(100_000),
      nodeId: 'u2', context: 'The first plan', precedingAssistantId: 'a1'
    });
  });

  it('carries the provider request id the host correlates to a durable session', async () => {
    const { fetchImpl } = provider({});
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    // The id travels on the message that carries it; a message with no request id simply has no
    // field, which the host reads as unproven rather than as a suppressed instruction.
    const [only] = snapshotOf(result).messages;
    expect(only!.requestId).toBe('wfr_second');
  });

  it('ignores sibling branches that current_node does not descend from', async () => {
    // A regenerated answer and an edit both leave siblings behind in the mapping. Only the
    // branch under current_node is this conversation.
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'question', created: at(-500_000) }),
      node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'first answer', created: at(-490_000), endTurn: true }),
      node({ id: 'a1-other', parent: 'u1', role: 'assistant', text: 'regenerated answer', created: at(-480_000), endTurn: true }),
      node({ id: 'u2', parent: 'a1-other', role: 'user', text: 'go', created: at(100_000) }),
      node({ id: 'a2', parent: 'u2', role: 'assistant', text: 'done', created: at(110_000), endTurn: true })
    ];
    const { fetchImpl } = provider({ document: conversation(branch, { current: 'a2' }) });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    // The predecessor is the branch's own answer, not the sibling that was left behind.
    expect(snapshotOf(result).messages).toEqual([
      expect.objectContaining({ messageId: 'u2', context: 'regenerated answer', precedingAssistantId: 'a1-other' })
    ]);
  });

  it('drops history the binding already covers and keeps provider order', async () => {
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'old', created: at(-600_000) }),
      node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'old answer', created: at(-590_000), endTurn: true }),
      node({ id: 'u2', parent: 'a1', role: 'user', text: 'requirements', created: at(100_000) }),
      node({ id: 'u3', parent: 'u2', role: 'user', text: 'correction', created: at(101_000) }),
      node({ id: 'a2', parent: 'u3', role: 'assistant', text: 'ok', created: at(110_000), endTurn: true })
    ];
    const { fetchImpl } = provider({ document: conversation(branch, { current: 'a2' }) });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    // Timestamps here are one second apart and deliberately not used for ordering: the provider's
    // own branch order is what survives.
    expect(snapshotOf(result).messages.map((row) => row.messageId)).toEqual(['u2', 'u3']);
    expect(snapshotOf(result).complete).toBe(true);
  });

  it('reports a closed, settled conversation as complete and settled', async () => {
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'go', created: at(100_000) }),
      node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'finished answer', created: at(110_000), endTurn: true })
    ];
    const { fetchImpl } = provider({ document: conversation(branch, { current: 'a1' }) });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    expect(snapshotOf(result).complete).toBe(true);
    expect(settledOf(result)).toBe(true);
  });
});

describe('settle proof', () => {
  it.each([
    ['a live generation on the branch', { status: 'in_progress', endTurn: false }, false],
    ['an unfinished tip', { status: 'in_progress' }, false],
    ['a tip that has not ended its turn', { endTurn: false }, false]
  ])('never calls a branch settled with %s', async (_label, tip, expected) => {
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'go', created: at(100_000) }),
      node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'answer', created: at(110_000), ...tip })
    ];
    const { fetchImpl } = provider({ document: conversation(branch, { current: 'a1' }) });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    expect(settledOf(result)).toBe(expected);
  });

  it('does not call a branch settled when its tip is an unanswered user message', async () => {
    const { fetchImpl } = provider({});
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    // The last node is an in-progress assistant reply, so this is doubly unsettled.
    expect(settledOf(result)).toBe(false);

    const unanswered = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'go', created: at(100_000) })
    ];
    const second = provider({ document: conversation(unanswered, { current: 'u1' }) });
    const result2 = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl: second.fetchImpl }
    );
    expect(settledOf(result2)).toBe(false);
  });
});

describe('fail-closed shapes', () => {
  it.each([
    ['no mapping', { conversation_id: CONVERSATION, current_node: 'a1' }, 'provider document has no mapping'],
    ['no current node', { conversation_id: CONVERSATION, current_node: 'missing', mapping: { a1: node({ id: 'a1', parent: null, role: 'assistant', text: 'x', created: at(-500_000) }) } },
      'provider document has no current node'],
    ['a current node that is not a string', { conversation_id: CONVERSATION, current_node: 7, mapping: {} },
      'provider document has no current node']
  ])('refuses %s instead of reporting a plausible branch', async (_label, document, error) => {
    const { fetchImpl } = provider({ document });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    expect(failureOf(result).error).toBe(error);
    // Nothing is posted for a shape that cannot be trusted, so the host keeps its own state.
    expect(result).not.toHaveProperty('snapshot');
  });

  it('refuses a branch whose parent link points outside the mapping', async () => {
    const document = conversation([
      node({ id: 'a1', parent: 'nowhere', role: 'assistant', text: 'x', created: at(-500_000), endTurn: true })
    ], { current: 'a1' });
    const { fetchImpl } = provider({ document });
    expect(await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    )).toMatchObject({ ok: false, error: 'provider branch has a broken parent link', retryable: false });
  });

  it('refuses a cyclic branch rather than walking it forever', async () => {
    const document = {
      conversation_id: CONVERSATION,
      current_node: 'a',
      mapping: {
        a: node({ id: 'a', parent: 'b', role: 'assistant', text: 'x', created: at(-500_000) }),
        b: node({ id: 'b', parent: 'a', role: 'assistant', text: 'y', created: at(-400_000) })
      }
    };
    const { fetchImpl } = provider({ document });
    expect(await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    )).toMatchObject({ ok: false, error: 'provider branch is cyclic', retryable: false });
  });

  it('refuses a document served for a different conversation', async () => {
    const { fetchImpl } = provider({ document: conversation(backlogBranch(), { id: OTHER_CONVERSATION }) });
    expect(await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    )).toMatchObject({ ok: false, error: 'provider document was another conversation', retryable: false });
  });

  it('refuses a watch whose conversation id is not a provider id', async () => {
    const { fetchImpl } = provider({});
    const result = await readOne({ conversationId: '../../etc/passwd', boundAt: BOUND_AT, providerAccountId: null }, { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'bad_watch_conversation_id' });
    // A malformed id is refused before any request exists to send it in.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('bounded fan-out', () => {
  it('reads every watch, including an unanchored one, from a single session read', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/api/auth/session')) return reply(200, session(ACCOUNT));
      return reply(200, conversation(backlogBranch(), { id: String(url).split('/').at(-1) }));
    });
    const results = await readControllerConversations([
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { conversationId: OTHER_CONVERSATION, boundAt: BOUND_AT, providerAccountId: null }
    ], { fetchImpl });
    expect(results.map((entry) => entry.conversationId).sort()).toEqual([OTHER_CONVERSATION, CONVERSATION].sort());
    expect(results.every((entry) => snapshotOf(entry).providerAccountId === ACCOUNT)).toBe(true);
    // One session read for the whole pass, not one per bound work.
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/api/auth/session'))).toHaveLength(1);
  });

  it('does not let one watch\u2019s failure shorten the list', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/api/auth/session')) return reply(200, session(ACCOUNT));
      if (String(url).endsWith(CONVERSATION)) return reply(404, {});
      return reply(200, conversation(backlogBranch(), { id: OTHER_CONVERSATION }));
    });
    const results = await readControllerConversations([
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { conversationId: OTHER_CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }
    ], { fetchImpl });
    expect(results).toHaveLength(2);
    expect(failureOf(results.find((entry) => entry.conversationId === CONVERSATION)!).error).toBe('conversation_not_found');
    expect(snapshotOf(results.find((entry) => entry.conversationId === OTHER_CONVERSATION)!)).toBeDefined();
  });

  it('refuses every anchored watch under a different account without requesting any of them', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/api/auth/session')) return reply(200, session(OTHER_ACCOUNT));
      return reply(200, conversation(backlogBranch()));
    });
    const results = await readControllerConversations([
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { conversationId: OTHER_CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }
    ], { fetchImpl });
    expect(results.every((entry) => failureOf(entry).error === 'account_mismatch')).toBe(true);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/backend-api/conversation/'))).toHaveLength(0);
  });

  it('refuses a watch with no usable binding watermark rather than reading the whole history', async () => {
    const fetchImpl = vi.fn(async () => reply(200, session(ACCOUNT)));
    expect(await readControllerConversations([
      { conversationId: CONVERSATION, providerAccountId: ACCOUNT } as unknown as ProviderWatch,
      { conversationId: CONVERSATION, boundAt: 0, providerAccountId: ACCOUNT },
      { conversationId: 'not-an-id', boundAt: BOUND_AT, providerAccountId: ACCOUNT }
    ], { fetchImpl })).toEqual([
      expect.objectContaining({ error: 'bad_watch_boundary' }),
      expect.objectContaining({ error: 'bad_watch_boundary' }),
      expect.objectContaining({ error: 'bad_watch_conversation_id' })
    ]);
    // A missing boundary cannot be guessed: "read everything" would offer the user's whole
    // history to a work as instructions.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs at a bounded concurrency and still completes every read', async () => {
    let running = 0;
    let peak = 0;
    const conversations = Array.from({ length: 9 }, (_, index) => `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee0${index}`);
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/api/auth/session')) return reply(200, session(ACCOUNT));
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return reply(200, conversation(backlogBranch(), { id: String(url).split('/').at(-1) }));
    });
    const results = await readControllerConversations(
      conversations.map((conversationId) => ({ conversationId, boundAt: BOUND_AT, providerAccountId: ACCOUNT })),
      { fetchImpl, concurrency: 2 }
    );
    expect(results).toHaveLength(9);
    expect(results.every((entry) => entry.ok === true)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('refuses a provider response that exceeds the inbound byte bound', async () => {
    const oversizedSession = JSON.stringify({ accessToken: 'token', user: { id: ACCOUNT }, padding: 'x'.repeat(256 * 1024) });
    const fetchImpl = vi.fn(async () => new Response(oversizedSession, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    const result = await readProviderAccountId({ fetchImpl });

    expect(result).toEqual({ ok: false, error: 'provider session unreachable: provider response too large' });
  });

  it('reports an unreachable session as a transient failure for every watch', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const results = await readControllerConversations([
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }
    ], { fetchImpl });
    expect(failureOf(results[0]!).error).toContain('provider session unreachable');
    expect(failureOf(results[0]!).retryable).toBe(true);
  });
});

describe('snapshot budget', () => {
  it('pages a long branch by size instead of dropping the oldest executable messages', async () => {
    // Thousands of short messages: no row cap exists, so these must travel as few pages as their
    // *text* needs — a branch that produced a page per fifty rows would hit the host's page-count
    // guard for a conversation that is merely long.
    const rows = [node({ id: 'root', parent: null, role: 'system', text: 'sys' })];
    let parent = 'root';
    for (let index = 0; index < 3137; index++) {
      const userId = `u${index}`;
      rows.push(node({ id: userId, parent, role: 'user', text: `instruction ${index}`, created: at(100_000 + index) }));
      parent = userId;
    }
    rows.push(node({ id: 'tip', parent, role: 'assistant', text: 'ok', created: at(200_000), endTurn: true }));
    const { fetchImpl } = provider({ document: conversation(rows, { current: 'tip' }) });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    const messages = snapshotOf(result).messages;
    // Nothing is dropped: a backlog larger than one body travels as consecutive pages, oldest
    // first, so the requirement the work was given first cannot be lost behind the newest one.
    expect(messages).toHaveLength(3137);
    expect(messages[0]!.messageId).toBe('u0');
    expect(messages.at(-1)!.messageId).toBe('u3136');
    if (result.ok !== true) throw new Error('expected pages');
    // Few enough pages that the host's own page-count guard is never reached for a long chat.
    expect(result.pages.length).toBeLessThan(64);
    expect(result.pages.flat().length).toBe(3137);
    expect(result.pages.at(-1)!.at(-1)!.messageId).toBe('u3136');
  });

  it('does not report a user message the provider gave no usable timestamp for', async () => {
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'run it' }),
      node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'ok', created: at(101_000), endTurn: true })
    ];
    const { fetchImpl } = provider({ document: conversation(branch, { current: 'a1' }) });
    const result = await readOne({ conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }, { fetchImpl });
    const snapshot = snapshotOf(result);
    // The row is not invented and not ordered by guesswork — and the read declares itself
    // incomplete, so the host cannot read its absence as the user having edited it away.
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.complete).toBe(false);
  });

  it('reports an exhaustive read as complete', async () => {
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'run it', created: at(100_000) }),
      node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'ok', created: at(101_000), endTurn: true })
    ];
    const { fetchImpl } = provider({ document: conversation(branch, { current: 'a1' }) });
    const result = await readOne({ conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }, { fetchImpl });
    expect(snapshotOf(result).complete).toBe(true);
  });
});

describe('credential boundary', () => {
  it('never lets a JSON parse error carry provider body text out of the module', async () => {
    // A JSON parser's own message quotes the offending text, and this document is the signed-in
    // session: a leak here is a credential leak into a popup, a log, or a message.
    const leak = 'ACCESS_TOKEN_SHOULD_NOT_ESCAPE';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError(`Unexpected token 'A', "${leak}"... is not valid JSON`);
      }
    }));
    const result = await readProviderAccountId({ fetchImpl });
    expect(result).toEqual({ ok: false, error: 'provider session was not JSON' });
    expect(JSON.stringify(result)).not.toContain(leak);
  });

  it('reports an unparseable conversation document as a retryable read failure', async () => {
    const leak = 'ACCESS_TOKEN_SHOULD_NOT_ESCAPE';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/auth/session')) return reply(200, { accessToken: 'tok', account: { id: ACCOUNT } });
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token 'A', "${leak}"... is not valid JSON`);
        }
      };
    });
    const result = await readOne({ conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }, { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'provider document was not JSON', retryable: true });
    expect(JSON.stringify(result)).not.toContain(leak);
  });
});

describe('a user message that carries its own request id', () => {
  it('is attributed to itself, never to the user message above it', async () => {
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'first question', created: at(100_000) }),
      node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'ok', created: at(101_000), endTurn: true }),
      // The provider attaches the request to the human's own message here. Walking *upward* from it
      // would hand this request to `u1` — the wrong question entirely, and one whose text would then
      // be treated as already executed.
      node({ id: 'u2', parent: 'a1', role: 'user', text: 'second question', created: at(102_000),
        requestId: 'wfr_second' }),
      node({ id: 'a2', parent: 'u2', role: 'assistant', text: 'answer', created: at(103_000), endTurn: true })
    ];
    const { fetchImpl } = provider({ document: conversation(branch, { current: 'a2' }) });
    const result = await readOne({ conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }, { fetchImpl });
    const messages = snapshotOf(result).messages;
    expect(messages.find((row) => row.messageId === 'u2')).toMatchObject({ requestId: 'wfr_second' });
    expect(messages.find((row) => row.messageId === 'u1')).not.toHaveProperty('requestId');
  });
});

describe('lineage across a branch that is not the newest one', () => {
  it('proves the question on the walked branch, not the newest node in the mapping', async () => {
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'the question on this branch', created: at(100_000) }),
      node({ id: 'call', parent: 'u1', role: 'assistant', text: '', created: at(101_000), requestId: 'wfr_branch' }),
      node({ id: 'a1', parent: 'call', role: 'assistant', text: 'done', created: at(102_000), endTurn: true })
    ];
    // `current_node` is `a1`, but the mapping also holds a *newer* abandoned node that hangs off a
    // different question. The walk follows `current_node`, so lineage must too — a producer that
    // scanned the whole mapping would prove the abandoned branch's question instead.
    const document = conversation(branch, { current: 'a1' });
    document.mapping['abandoned'] = {
      id: 'abandoned', parent: 'u9',
      message: { id: 'abandoned', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['stale'] },
        status: 'finished_successfully', create_time: at(200_000) / 1000, end_turn: true, metadata: { request_id: 'wfr_abandoned' } }
    };
    document.mapping['u9'] = {
      id: 'u9', parent: 'root',
      message: { id: 'u9', author: { role: 'user' }, content: { content_type: 'text', parts: ['other question'] },
        status: 'finished_successfully', create_time: at(199_000) / 1000 }
    };
    const { fetchImpl } = provider({ document });
    const result = await readOne({ conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }, { fetchImpl });
    const messages = snapshotOf(result).messages;
    expect(messages.map((row) => row.messageId)).toEqual(['u1']);
    expect(messages[0]).toMatchObject({ requestId: 'wfr_branch' });
  });

  it('fails closed when an ancestor link leaves the mapping', async () => {
    const branch = [
      node({ id: 'root', parent: null, role: 'system', text: 'sys' }),
      node({ id: 'u1', parent: 'root', role: 'user', text: 'run it', created: at(100_000) }),
      node({ id: 'a1', parent: 'u1', role: 'assistant', text: 'ok', created: at(101_000), endTurn: true })
    ];
    const document = conversation(branch, { current: 'a1' });
    document.mapping['a1'].parent = 'gone';
    const { fetchImpl } = provider({ document });
    const result = await readOne({ conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT }, { fetchImpl });
    // A branch that cannot be walked proves nothing about membership, so nothing is reported at all.
    expect(result).toMatchObject({ ok: false, error: 'provider branch has a broken parent link' });
  });
});

describe('page size is measured on the wire, not on the text', () => {
  it('keeps a page of escape-heavy text inside the bridge body bound', async () => {
    // One control character is one character here and six bytes as `\u0001` in JSON. A page sized
    // on the raw text would understate this body sixfold and hand the bridge something it refuses
    // to parse at all — a read that failed for no reason the work can act on.
    const heavy = '\u0001'.repeat(65_536);
    const rows = [node({ id: 'root', parent: null, role: 'system', text: 'sys' })];
    let parent = 'root';
    for (let index = 0; index < 8; index++) {
      const userId = `u${index}`;
      rows.push(node({ id: userId, parent, role: 'user', text: heavy, created: at(100_000 + index) }));
      parent = userId;
    }
    rows.push(node({ id: 'tip', parent, role: 'assistant', text: 'ok', created: at(200_000), endTurn: true }));
    const { fetchImpl } = provider({ document: conversation(rows, { current: 'tip' }) });
    const result = await readOne(
      { conversationId: CONVERSATION, boundAt: BOUND_AT, providerAccountId: ACCOUNT },
      { fetchImpl }
    );
    if (result.ok !== true) throw new Error('expected pages');
    expect(result.pages.flat()).toHaveLength(8);
    // Every page, serialized exactly as the worker posts it, fits the bridge's own two-mebibyte body.
    for (const page of result.pages) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024);
    }
  });
});
