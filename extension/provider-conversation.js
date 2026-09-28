/**
 * The authenticated provider read behind mobile continuity.
 *
 * A bound controller conversation is a chat the user may have written to from their phone while
 * this browser had no tab open on it. Nothing on the page can prove that: React only mounts what
 * is on screen, ChatGPT virtualises old turns, and a closed chat has no Fiber at all. So the only
 * complete evidence for the *active branch* is the provider's own conversation document, fetched
 * with the browser's authenticated session — `GET /backend-api/conversation/<id>`.
 *
 * Four things this file is deliberately strict about.
 *
 *  · **The access token never leaves this module.** It is read here, used here, and is never
 *    returned to a caller, put in a message, sent to the local app or written to a log. The one
 *    value the rest of the extension may ask for is the account id, which is not a credential.
 *
 *  · **The active branch is walked, never sampled.** The document names `current_node`; the branch
 *    is that node's real `parent` chain back to the root. A mounted or virtualised excerpt of the
 *    transcript is never complete-branch evidence, so no DOM or Fiber reading is used here at all.
 *
 *  · **Only ids the host named are ever read.** Watches come from the host's own binding ledger.
 *    There is no conversation listing and no account scan: a 404 under the proven account means
 *    "not there", and that is the end of it.
 *
 *  · **Nothing is guessed.** A missing `current_node`, a `parent` that is not in `mapping`, a
 *    cycle, or a chain longer than any real conversation fails closed: the caller posts no
 *    snapshot, so the host keeps its own state rather than learning something false.
 *
 * `providerAccountId` is the account the provider document was actually served under. When the
 * binding has no anchor yet, this read is what establishes it — refusing to read while unanchored
 * would be a bootstrap deadlock (no read, no anchor, never a read). Once the host has an anchor,
 * a *different* signed-in account refuses before the conversation is even requested: the same
 * conversation id under another account is a different chat.
 */

/** Where the browser's own ChatGPT session is described. The browser's cookies are attached. */
const AUTH_SESSION_URL = 'https://chatgpt.com/api/auth/session';

/** The exact conversation document. Only ever requested for an id the host named. */
const conversationUrl = (id) => `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`;

/** The host's own provider-account shape; an id outside it is not an account id. */
const PROVIDER_ACCOUNT = /^[A-Za-z0-9_-]{1,100}$/;

/** Every conversation id this file will accept from a watch, before any request is made. */
const CONVERSATION_ID = /^[0-9a-f-]{8,64}$/i;

/**
 * Longest parent chain accepted. Real conversations are far below this; the bound exists so a
 * corrupt document cannot spin, and reaching it is a refusal rather than a truncated walk.
 */
const MAX_BRANCH_NODES = 4000;

/**
 * Rows and characters one transport page may carry.
 *
 * The host charges each page a *character* budget and names any row that would exceed it, and the
 * bridge refuses a body over two mebibytes outright. Both are transport bounds, so this side pages
 * by size alone — there is no row count to stay under, and a branch of thousands of short messages
 * travels in as few pages as its text needs.
 *
 * Characters are counted the way the *host* counts them, so a page never asks for more text than it
 * can read. Bytes are counted on the **serialized row**, because that is what actually crosses the
 * wire: a control character in a message is one character here and six bytes as `\u0001` in JSON,
 * so measuring the raw string would understate a body by sixfold and hand the bridge something it
 * refuses to parse at all. The envelope and the commas between rows are budgeted too.
 */
const MAX_SNAPSHOT_CHARS = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
/** The flat envelope and separators, which are not part of any single row. */
const ENVELOPE_BYTES = 4 * 1024;

/** Reads running at once. A bound work's chat is read every maintenance pass, not in a burst. */
const DEFAULT_CONCURRENCY = 3;

const READ_TIMEOUT_MS = 15_000;
/** Inbound provider documents are untrusted bytes too; outbound snapshot paging is not a read cap. */
const SESSION_RESPONSE_BYTES = 256 * 1024;
const CONVERSATION_RESPONSE_BYTES = 32 * 1024 * 1024;

/** One string's size on the wire, which is what the bridge's own body bound measures. */
const utf8Bytes = (value) => (value ? new TextEncoder().encode(value).length : 0);

/**
 * One authenticated request, bounded from the first byte to the last.
 *
 * The deadline covers the **body read** as well as the headers. A provider that answers headers
 * and then stops sending would otherwise hold this request forever — and because every read in a
 * pass is awaited before the pass is over, one hung body would starve every other bound
 * conversation in the browser, not just its own.
 */
async function readJson(fetchImpl, url, init, timeoutMs, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('provider request timed out')), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (response.status === 204 || response.status === 205) return { response, body: null, parseError: false };
    try {
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error('provider response too large');
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
              await reader.cancel().catch(() => undefined);
              throw new Error('provider response too large');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const joined = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
        text = new TextDecoder('utf-8', { fatal: true }).decode(joined);
      } else if (typeof response.text === 'function') {
        text = await response.text();
        if (utf8Bytes(text) > maxBytes) throw new Error('provider response too large');
      } else {
        // Test doubles predating streamed responses; production Fetch responses always take a
        // byte-bounded branch above.
        return { response, body: await response.json(), parseError: false };
      }
      return { response, body: JSON.parse(text), parseError: false };
    } catch (error) {
      if (error?.message === 'provider response too large') throw error;
      // A JSON parser's own message quotes the offending text, and this body is the authenticated
      // session document — its fragments are exactly what must never reach a caller, a log or a
      // popup. Only the fact that parsing failed crosses back.
      return { response, body: null, parseError: true };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The authenticated account this browser is signed into, and the token that proves it.
 *
 * `credentials: 'include'` is what makes this the browser's real session rather than an anonymous
 * call: ChatGPT's cookies are `SameSite`, and because the extension holds host permission for the
 * origin Chrome treats the request as same-site and sends them.
 *
 * The token is returned only so this module's own conversation request can use it. Callers outside
 * this file get `readProviderAccountId()`, which drops it.
 */
async function readProviderSession(fetchImpl, timeoutMs) {
  let response, body, parseError;
  try {
    ({ response, body, parseError } = await readJson(fetchImpl, AUTH_SESSION_URL, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' }
    }, timeoutMs, SESSION_RESPONSE_BYTES));
  } catch (error) {
    return { ok: false, error: `provider session unreachable: ${String(error && error.message ? error.message : error)}`, retryable: true };
  }
  // Signed out is not transient: the browser has no provider session to read anything with.
  if (response.status === 401 || response.status === 403) return { ok: false, error: 'signed_out', retryable: false };
  if (!response.ok) return { ok: false, error: `provider session HTTP ${response.status}`, retryable: response.status >= 500 };
  if (parseError) return { ok: false, error: 'provider session was not JSON', retryable: true };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'provider session shape', retryable: true };
  const accessToken = typeof body.accessToken === 'string' && body.accessToken.length > 0 ? body.accessToken : null;
  const accountId = body.account && typeof body.account === 'object' && !Array.isArray(body.account)
    ? body.account.id : null;
  if (!accessToken) return { ok: false, error: 'provider session carried no access token', retryable: true };
  if (typeof accountId !== 'string' || !PROVIDER_ACCOUNT.test(accountId)) {
    return { ok: false, error: 'provider session carried no usable account id', retryable: true };
  }
  return { accountId, accessToken };
}

/**
 * The signed-in account id, and nothing else.
 *
 * This is the whole of what the Send fence needs: it compares the account a queued report was
 * pinned to against the account the browser is *actually* signed into at the moment of Send. No
 * token, no conversation and no transcript crosses this boundary.
 */
export async function readProviderAccountId({ fetchImpl = fetch, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const session = await readProviderSession(fetchImpl, timeoutMs);
  if (session.error) return { ok: false, error: session.error };
  return { ok: true, accountId: session.accountId };
}

/** The visible text of one provider message: string parts only, joined at their boundaries. */
function messageText(message) {
  const content = message && typeof message.content === 'object' && message.content !== null ? message.content : null;
  const parts = content && Array.isArray(content.parts) ? content.parts : null;
  if (!parts) return '';
  return parts
    .filter((part) => typeof part === 'string')
    .join('\n')
    .trim();
}

/**
 * The provider's own request id for one message, or null.
 *
 * This is the same opaque value the page-side reader reads out of React's query cache, and it is
 * what the host correlates to a durable local session. Shape-checked rather than trimmed: an id
 * that fails the check is not an id, and a shortened one would name a different request.
 */
function providerRequestId(message) {
  const metadata = message && typeof message.metadata === 'object' && message.metadata !== null ? message.metadata : null;
  const value = metadata ? metadata.request_id : null;
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

/**
 * The provider's own name for what an assistant message is *for*.
 *
 * The page model routes assistant prose down three named channels and they are not
 * interchangeable: `final` is the answer, `commentary` is running narration between tool calls,
 * and `analysis` is the model's private scratch — which this extension never records and never
 * shows. A quotation is only meaningful if it is something the user actually read.
 */
function channelOf(message) {
  return typeof message.channel === 'string' ? message.channel : '';
}

/** ChatGPT's own mark for a message it never put in the conversation. */
function hiddenMessage(message) {
  const metadata = message && typeof message.metadata === 'object' && message.metadata !== null ? message.metadata : null;
  return Boolean(metadata &&
    (metadata.is_visually_hidden_from_conversation === true || metadata.is_visually_hidden === true));
}

/**
 * Whether this message is something the user could have read as the assistant's answer.
 *
 * Everything else is refused as a quotation: private reasoning (`analysis`), narration
 * (`commentary`), a message routed to a tool rather than to the conversation, a thought object,
 * and anything the provider itself marked hidden. Quoting any of those would put text the user
 * never saw — or chain-of-thought — into a work instruction as if it were the plan they meant.
 */
function visibleAssistant(message) {
  const author = message && typeof message.author === 'object' && message.author !== null ? message.author : null;
  if (!author || author.role !== 'assistant') return false;
  if (hiddenMessage(message)) return false;
  const channel = channelOf(message);
  if (channel === 'analysis' || channel === 'commentary') return false;
  // A message addressed to a tool or a function is a call, not prose. Only `all` reaches the
  // conversation.
  if (typeof message.recipient === 'string' && message.recipient !== 'all') return false;
  const content = message.content;
  if (!content || typeof content !== 'object') return false;
  return content.content_type === 'text' || content.content_type === 'multimodal_text';
}

/**
 * Whether the branch ends on a proven, finished assistant turn.
 *
 * The provider's own `end_turn: true` on a `finished_successfully` assistant message is the only
 * proof this extension accepts, exactly as the page-side reader does: an actively generating turn
 * can already expose `isFinalTurn`, and interim messages can already be
 * `finished_successfully`, so neither of those — nor a missing `end_turn` — is completion.
 */
function branchSettled(chain, mapping) {
  for (let index = chain.length - 1; index >= 0; index--) {
    const message = mapping[chain[index]].message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    if (hiddenMessage(message)) continue;
    const channel = channelOf(message);
    if (channel === 'analysis' || channel === 'commentary') continue;
    const author = message.author;
    const role = author && typeof author.role === 'string' ? author.role : null;
    // A user message at the end is a turn still owed or still running: either way, not settled.
    if (role === 'user') return false;
    if (role !== 'assistant') continue;
    return message.status === 'finished_successfully' && message.end_turn === true;
  }
  return false;
}
/** One message's id: the provider's own, falling back to the branch node key it lives under. */
function messageIdOf(message, nodeId) {
  return typeof message.id === 'string' && message.id.length > 0 ? message.id : nodeId;
}

/** The provider's own timestamp in milliseconds, or null when it is not a usable one. */
function createdMsOf(message) {
  const seconds = message.create_time;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/**
 * The request id a connector node proves belongs to one user question, per user message.
 *
 * A connector node carries `metadata.request_id`; the *human* question it answers is not that node
 * and is never guessed from time, turn order or "the newest user message". The only proof is the
 * provider's own graph: walk that node's `parent` chain until a user message is reached, and that
 * exact message is the question this request belongs to. Without that proof there is no
 * association at all — an unproven question is left unproven rather than approximated.
 */
function questionRequestsByUser(chain, mapping) {
  const byUser = new Map();
  const conflicts = new Set();
  for (const nodeId of chain) {
    const message = mapping[nodeId].message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const requestId = providerRequestId(message);
    if (requestId === null) continue;
    const author = message.author;
    const role = author && typeof author.role === 'string' ? author.role : null;
    // A request id carried by a *user* message is that message's own request, proven by itself —
    // never by walking upward, which would hand it to whichever user message happens to be its
    // ancestor. Only a node that is not itself a question is resolved through its parents.
    if (role === 'user') {
      const userId = messageIdOf(message, nodeId);
      const held = byUser.get(userId);
      if (held !== undefined && held !== requestId) conflicts.add(userId);
      else byUser.set(userId, requestId);
      continue;
    }
    for (let at = mapping[nodeId].parent, hops = 0; at !== null && at !== undefined && hops < MAX_BRANCH_NODES; hops++) {
      const node = mapping[at];
      if (!node || typeof node !== 'object') break;
      const ancestor = node.message;
      const role = ancestor && ancestor.author && typeof ancestor.author.role === 'string' ? ancestor.author.role : null;
      if (role === 'user') {
        const userId = messageIdOf(ancestor, at);
        const held = byUser.get(userId);
        // Two different requests claiming the same question is an ambiguity, not a second answer:
        // neither is reported, so the manager sees `unproven` rather than one arbitrary choice.
        if (held !== undefined && held !== requestId) conflicts.add(userId);
        else byUser.set(userId, requestId);
        break;
      }
      at = node.parent;
    }
  }
  for (const userId of conflicts) byUser.delete(userId);
  return byUser;
}

/**
 * One conversation's active branch, from an already-authenticated session.
 *
 * Never called with an id the host did not name, and never with a session whose account the
 * binding's anchor already contradicted.
 */
async function readConversation(session, watch, fetchImpl, timeoutMs) {
  const conversationId = watch.conversationId;
  let response, document, parseError;
  try {
    ({ response, body: document, parseError } = await readJson(fetchImpl, conversationUrl(conversationId), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json', authorization: `Bearer ${session.accessToken}` }
    }, timeoutMs, CONVERSATION_RESPONSE_BYTES));
  } catch (error) {
    return { ok: false, error: `provider read failed: ${String(error && error.message ? error.message : error)}`, retryable: true };
  }
  // 404 under the proven account means this exact chat is not there. That is the end of it: no
  // other account and no other conversation is looked at, and nothing is reported.
  if (response.status === 404) return { ok: false, error: 'conversation_not_found', retryable: false };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: `provider refused the read (HTTP ${response.status})`, retryable: false };
  }
  if (!response.ok) return { ok: false, error: `provider read HTTP ${response.status}`, retryable: response.status >= 500 };
  if (parseError) return { ok: false, error: 'provider document was not JSON', retryable: true };

  if (!document || typeof document !== 'object' || Array.isArray(document)) return { ok: false, error: 'provider document shape', retryable: true };
  // A document that names a different conversation is refused outright. One that names none is
  // tolerated: the request was for one exact id under a proven account, and a provider revision
  // that stopped echoing the id would otherwise make every read fail closed for no reason.
  const served = document.conversation_id;
  if (typeof served === 'string' && served !== conversationId) return { ok: false, error: 'provider document was another conversation', retryable: false };
  const mapping = document.mapping;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return { ok: false, error: 'provider document has no mapping', retryable: false };
  const currentNode = document.current_node;
  if (typeof currentNode !== 'string' || !Object.prototype.hasOwnProperty.call(mapping, currentNode)) {
    return { ok: false, error: 'provider document has no current node', retryable: false };
  }

  // The real branch: `current_node`'s own parent chain back to the root, in order.
  const chain = [];
  const seen = new Set();
  for (let nodeId = currentNode; ; ) {
    if (seen.has(nodeId)) return { ok: false, error: 'provider branch is cyclic', retryable: false };
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!node || typeof node !== 'object' || Array.isArray(node)) return { ok: false, error: 'provider branch has a missing node', retryable: false };
    chain.push(nodeId);
    if (chain.length > MAX_BRANCH_NODES) return { ok: false, error: 'provider branch is longer than any real conversation', retryable: false };
    const parent = node.parent;
    if (parent === null || parent === undefined) break;
    if (typeof parent !== 'string' || !Object.prototype.hasOwnProperty.call(mapping, parent)) {
      return { ok: false, error: 'provider branch has a broken parent link', retryable: false };
    }
    nodeId = parent;
  }
  chain.reverse();

  // Oldest first, so each message's own predecessor is the nearest earlier assistant message on
  // this exact branch — never a snapshot-wide quotation and never a sibling branch's answer.
  const candidates = [];
  const questionRequests = questionRequestsByUser(chain, mapping);
  // Whether this walk carried every executable message the branch holds. Only an exhaustive read
  // may be reported `complete`, and only a complete read may reject a pending message as gone.
  let exhaustive = true;
  let preceding = null;
  for (const nodeId of chain) {
    const message = mapping[nodeId].message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const role = message.author && typeof message.author.role === 'string' ? message.author.role : null;
    if (role === 'assistant') {
      // Only a message the user could have read may travel as context, and only when it has text:
      // an empty one is not a quotation, it is a gap.
      if (visibleAssistant(message)) {
        const text = messageText(message);
        if (text) preceding = { id: messageIdOf(message, nodeId), text };
      }
      continue;
    }
    if (role !== 'user') continue;
    // A user message with no provider timestamp cannot be ordered against the binding's own
    // boundary, and the host refuses such a row rather than guessing. It is omitted — and the
    // snapshot is reported partial, so the omission is never read as "this was edited away".
    const created = createdMsOf(message);
    // A user message with no provider timestamp cannot be ordered against the binding's own
    // boundary, and the host refuses such a row rather than guessing. It is omitted — but the read
    // is then *not* exhaustive, because a row that may be executable was left unread. Saying
    // `complete: true` here would let the host reject a still-pending message as off-branch on the
    // strength of a walk that never carried it.
    if (created === null) {
      exhaustive = false;
      continue;
    }
    // History the binding already covers can never execute: the host refuses any message authored
    // at or before `boundAt` as stale. Carrying it would spend the whole body budget on rows that
    // cannot change a decision, so the snapshot starts at the boundary.
    if (created <= watch.boundAt) continue;
    const messageId = messageIdOf(message, nodeId);
    // Only the request a connector node's own ancestor chain proves for THIS question travels.
    // A user message that carries `metadata.request_id` itself is reported as its own, which is the
    // same shape the page-side reader already sends.
    const requestId = providerRequestId(message) ?? questionRequests.get(messageId) ?? null;
    const row = {
      messageId,
      text: messageText(message),
      authoredAt: created,
      nodeId,
      ...(preceding ? { context: preceding.text, precedingAssistantId: preceding.id } : {}),
      ...(requestId !== null ? { requestId } : {}),
      cost: messageText(message).length + (preceding ? preceding.text.length : 0)
    };
    // What this row costs on the wire, measured on its own JSON — escaping, ids and separators
    // included — rather than on the text it happens to contain.
    const { cost, ...dto } = row;
    candidates.push({ row, cost, wire: utf8Bytes(JSON.stringify(dto)) + 1 });
  }

  // Nothing is dropped. Every executable message is posted, in order, across as many pages as the
  // host's transport bounds require — a snapshot that silently omitted the oldest requirement would
  // hand the work a plan with its own prerequisites missing, and `partial` cannot admit what was
  // never sent.
  const pages = [];
  for (const entry of candidates) {
    const last = pages.at(-1);
    if (last && last.chars + entry.cost <= MAX_SNAPSHOT_CHARS &&
        ENVELOPE_BYTES + last.wire + entry.wire <= MAX_SNAPSHOT_BYTES) {
      last.push(entry.row);
      last.chars += entry.cost;
      last.wire += entry.wire;
      continue;
    }
    pages.push(Object.assign([entry.row], { chars: entry.cost, wire: entry.wire }));
  }
  if (pages.length === 0) pages.push(Object.assign([], { chars: 0, wire: 0 }));

  return {
    ok: true,
    // The read is exhaustive when every executable row was actually read. Nothing is discarded to
    // fit — an oversized branch is paged — but a row that could not be dated is still an unread
    // row, and saying otherwise would let the host treat it as edited away.
    exhaustive,
    settled: branchSettled(chain, mapping),
    pages: pages.map((rows) => rows.map(({ cost: _cost, ...row }) => row))
  };
}

/**
 * Every watched conversation's branch, from one authenticated session read.
 *
 * The session is read once per pass rather than once per conversation: it is the same browser and
 * the same account, and a bound work per conversation would otherwise multiply that read for no
 * new information.
 *
 * An unanchored watch (`providerAccountId: null`) is read and the account it was served under is
 * reported back, which is what lets the host establish the anchor. An anchored watch whose account
 * no longer matches is refused *before* any conversation request: the same conversation id under
 * another account is a different chat, and fetching it to then throw the answer away would be a
 * request the host never authorised.
 *
 * Reads run at a bounded concurrency, and every watch in the list is attempted — a long list is
 * slower, never silently shorter.
 */
export async function readControllerConversations(watches, {
  fetchImpl = fetch,
  timeoutMs = READ_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY
} = {}) {
  const accepted = [];
  const results = [];
  for (const watch of Array.isArray(watches) ? watches : []) {
    const conversationId = watch && typeof watch.conversationId === 'string' ? watch.conversationId : '';
    // A watch this module cannot read is reported by name rather than dropped: silence here would
    // look identical to "this conversation had nothing to say", which is exactly the failure the
    // host cannot detect on its own.
    if (!CONVERSATION_ID.test(conversationId)) {
      results.push({ conversationId, ok: false, error: 'bad_watch_conversation_id', retryable: false });
      continue;
    }
    // The binding's own boundary decides which provider messages may ever execute. Without it the
    // read would have to guess, and the guess that looks harmless — "no boundary, so read
    // everything" — would offer the user's whole history to a work as instructions.
    if (typeof watch.boundAt !== 'number' || !Number.isFinite(watch.boundAt) || watch.boundAt <= 0) {
      results.push({ conversationId, ok: false, error: 'bad_watch_boundary', retryable: false });
      continue;
    }
    const anchor = typeof watch.providerAccountId === 'string' && PROVIDER_ACCOUNT.test(watch.providerAccountId)
      ? watch.providerAccountId : null;
    // The host's per-binding observation token travels with the read and is echoed on every page.
    // It is opaque here — this module never inspects it — and it is what lets the host refuse a
    // snapshot whose binding was disabled, rebound or restarted while the read was in flight.
    const observationToken = typeof watch.observationToken === 'string' && watch.observationToken.length > 0
      ? watch.observationToken : null;
    accepted.push({ conversationId, boundAt: watch.boundAt, anchor, observationToken, index: results.length });
    results.push(null);
  }
  if (accepted.length === 0) return results;

  const session = await readProviderSession(fetchImpl, timeoutMs);
  if (session.error) {
    for (const watch of accepted) {
      results[watch.index] = { conversationId: watch.conversationId, ok: false, error: session.error, retryable: session.retryable };
    }
    return results;
  }

  let next = 0;
  const lane = async () => {
    for (let at = next++; at < accepted.length; at = next++) {
      const watch = accepted[at];
      // An anchored binding is only readable under the account it was anchored to, and this is
      // checked *before* the conversation is requested: the same conversation id under another
      // account is a different chat, and a request made to then discard the answer is a request
      // the host never authorised.
      results[watch.index] = watch.anchor !== null && watch.anchor !== session.accountId
        ? { conversationId: watch.conversationId, ok: false, error: 'account_mismatch', retryable: true }
        : {
            conversationId: watch.conversationId,
            providerAccountId: session.accountId,
            boundAt: watch.boundAt,
            observationToken: watch.observationToken,
            ...await readConversation(session, watch, fetchImpl, timeoutMs)
          };
    }
  };
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, accepted.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}
