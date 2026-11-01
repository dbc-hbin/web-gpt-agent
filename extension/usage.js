/**
 * Passive, bounded page-response projection.
 *
 * Never reads request headers, cookies, credentials or request bodies. Besides
 * quota metadata, it observes the two opaque identifiers ChatGPT itself puts in the live
 * conversation event stream: `conversation_id` and `metadata.request_id`. The latter can
 * reach the stream tens of seconds before React publishes it, which is the difference between
 * an exact Core caller and CALLER_IDENTITY_REQUIRED. Only that pair crosses worlds.
 */
(() => {
  'use strict';
  if (window.__cosUsageObserver) return;
  window.__cosUsageObserver = true;
  const post = window.postMessage.bind(window);
  let latest = null;
  let requestOrder = 0, latestOrder = 0;
  const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // @ehkogh/#318: the alternate shell also uses bare UUID workflow ids.
  const REQUEST = /^(?:wfr_[a-zA-Z0-9_-]{1,96}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
  const CONVERSATION_FIELD = /(?:^|[,{\s])\"conversation_id\"\s*:\s*\"([0-9a-f-]{36})\"/gi;
  // Passive evidence only: no polling, and no full response survives a scan. Retain a
  // small replay window for document_start -> content-script readiness and deduplicate
  // repeated provider observations across responses as well as inside one stream.
  const origins = new Map();
  const originReaders = new Set();
  const ORIGIN_LISTEN_MS = 15 * 60_000;
  function publishOrigin(conversationId, requestIds, observedAt) {
    const fresh = requestIds.filter(id => !origins.has(`${conversationId}:${id}`));
    if (!fresh.length) return;
    for (const requestId of fresh) {
      if (origins.size >= 64) origins.delete(origins.keys().next().value);
      origins.set(`${conversationId}:${requestId}`, { conversationId, requestId, observedAt });
    }
    post({ type: 'cos-request-origin', conversationId, requestIds: fresh, observedAt }, location.origin);
  }
  // Diagnostics: the tool calls of a turn can carry a request id the page never reported. Every
  // id-named field of this chat's stream is traced by its path, never its content, so the app can
  // log where the page did see an id it could not place. Evidence for a log line only: attribution
  // still trusts the exact fields readOrigin reads.
  const ID_KEY = /^[A-Za-z0-9_-]{0,40}ids?$/i;
  function namedConversation(frame, fallback) {
    const named = new Set();
    CONVERSATION_FIELD.lastIndex = 0;
    for (let match; (match = CONVERSATION_FIELD.exec(frame));) if (CONVERSATION.test(match[1])) named.add(match[1]);
    return named.size === 1 ? named.values().next().value : named.size ? null : fallback || null;
  }
  // Anywhere in a frame, also inside arrays and longer strings ("text" then names no field, and no content).
  // Whole tokens only: the start of a longer token is not an id the page saw.
  const ID_ANYWHERE = /(?<![A-Za-z0-9_-])(?:wfr_[A-Za-z0-9_-]{1,96}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?![A-Za-z0-9_-])/gi;
  // New ids one message reports at most: the content script takes as many per message.
  const TRACES_PER_FRAME = 16;
  function traceIds(frame, conversationId, traced, prefix = '', limit = 64) {
    if (!conversationId || traced.size >= limit || !frame || frame.length > 512 * 1024) return;
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n') || frame;
    let event = null;
    try { event = JSON.parse(data); } catch { /* Not JSON: only the text scan below applies. */ }
    const traces = [];
    const root = typeof event?.p === 'string' && /^[A-Za-z0-9_/-]{0,120}$/.test(event.p) ? `${event.p || '/'}:` : '';
    const text = `${prefix}${root}text`;
    const take = (id, path) => {
      if (traces.length >= TRACES_PER_FRAME || !REQUEST.test(id) || id === conversationId || traced.has(id) || origins.has(`${conversationId}:${id}`)) return;
      traced.add(id);
      traces.push({ requestId: id, path: path.slice(0, 160) });
    };
    // An array's strings are named by their path only under an id-named key, as a field is.
    const walk = (value, path, depth, idNamed = false) => {
      if (traces.length >= TRACES_PER_FRAME || depth > 8 || path.length > 160) return;
      if (Array.isArray(value)) {
        value.slice(0, 16).forEach((item, index) => typeof item === 'string' ? take(item, idNamed ? `${path}[${index}]` : text) : walk(item, `${path}[${index}]`, depth + 1));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value).slice(0, 64)) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) continue;
        const at = path.endsWith(':') || !path ? path + key : `${path}.${key}`;
        if (typeof item !== 'string') { walk(item, at, depth + 1, ID_KEY.test(key)); continue; }
        if (ID_KEY.test(key)) take(item, at);
      }
    };
    if (event && typeof event === 'object') walk(event, prefix + root, 0);
    for (const match of data.matchAll(ID_ANYWHERE)) { if (traces.length >= TRACES_PER_FRAME) break; take(match[0], text); }
    if (traces.length) post({ type: 'cos-request-trace', conversationId, traces }, location.origin);
  }
  /** The chat this page shows, for traces from streams that name no chat themselves. */
  function routeConversation() {
    const match = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(location.pathname);
    return match ? match[1] : null;
  }
  // Event streams from other ChatGPT backend routes, read for traces only (never for attribution).
  const otherTraceReaders = new Set();
  async function inspectOtherStreams(response) {
    if (otherTraceReaders.size >= 2) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !url.pathname.startsWith('/backend-api/') ||
        /^\/backend-api\/(?:conversation|f\/conversation(?:\/resume)?)$/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    // Cancelled on page hide, as the chat's own readers are.
    otherTraceReaders.add(reader);
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), ORIGIN_LISTEN_MS);
    // The route in characters the app's path check accepts: ids as *, anything else as _.
    const route = url.pathname.replace(/[0-9a-f-]{36}/gi, '*').replace(/[^A-Za-z0-9_./*-]/g, '_').slice(0, 60);
    const decoder = new TextDecoder(), traced = new Set(), prefix = `${route}>`;
    let bytes = 0, buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024 || traced.size >= 64) break;
        buffer += decoder.decode(value, { stream: true });
        for (let split; (split = buffer.search(/\r?\n\r?\n/)) >= 0;) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, '');
          traceIds(frame, namedConversation(frame, routeConversation()), traced, prefix);
        }
        if (buffer.length > 512 * 1024) break;
      }
    } catch { /* A trace is only ever a diagnostic. */ }
    finally { clearTimeout(timer); otherTraceReaders.delete(reader); void reader.cancel().catch(() => {}); }
  }
  const project = (data, observedAt, order) => {
    if (!data || typeof data !== 'object') return;
    const rows = [];
    const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_. /-]{1,100}$/.test(value) ? value : null;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const add = (value) => { if (rows.length < 80) rows.push(value); };
    const metadata = data.conversation_detail_metadata || data;
    const recognized = Array.isArray(metadata.model_limits) || Array.isArray(metadata.limits_progress) || !!data.rate_limit || Array.isArray(data.additional_rate_limits);
    if (!recognized || order < latestOrder) return;
    for (const row of (Array.isArray(metadata.model_limits) ? metadata.model_limits : []).slice(0, 40)) {
      const model = label(row?.model_slug);
      const reset = typeof row?.resets_after === 'string' ? Date.parse(row.resets_after) : NaN;
      // A reset timestamp alone is not a remaining-message count.
      const remaining = finite(row?.remaining), resetAt = Number.isFinite(reset) && reset > 0 ? reset : null;
      if (model && (remaining !== null || resetAt !== null)) add({ model, scope: 'model', remaining, remainingPercent: null, resetAt, windowSeconds: null });
    }
    for (const row of (Array.isArray(metadata.limits_progress) ? metadata.limits_progress : []).slice(0, 40)) {
      const model = label(row?.model_slug), feature = label(row?.feature_name), remaining = finite(row?.remaining);
      const reset = typeof row?.reset_after === 'string' ? Date.parse(row.reset_after) : NaN;
      if ((model || feature) && remaining !== null) add({ model: model || feature, scope: model ? 'model' : 'feature', remaining, remainingPercent: null, resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, windowSeconds: null });
    }
    const rates = [{ ...data, label: 'Shared usage' }, ...(Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.slice(0, 40) : [])];
    for (const rate of rates) {
      const model = label(rate?.model_slug), name = model || label(rate?.limit_name) || label(rate?.label);
      for (const window of [rate?.rate_limit?.primary_window, rate?.rate_limit?.secondary_window]) {
        const used = finite(window?.used_percent);
        if (!name || used === null || used > 100) continue;
        const reset = finite(window?.reset_at);
        add({ model: name, scope: model ? 'model' : 'shared', remaining: null, remainingPercent: 100 - used, resetAt: reset === null || reset === 0 ? null : reset * 1000, windowSeconds: finite(window?.limit_window_seconds) || null });
      }
    }
    latestOrder = order;
    latest = { type: 'cos-usage', rows, observedAt }; post(latest, location.origin);
  };
  async function inspect(response, observedAt, order) {
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:wham\/usage|conversation\/init|conversation\/prepare|models)(?:\?|$)/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 10000);
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 512 * 1024) return;
        text += decoder.decode(value, { stream: true });
      }
      project(JSON.parse(text + decoder.decode()), observedAt, order);
    } catch { /* Unsupported metadata is unavailable, never guessed. */ }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }
  /**
   * Reads bounded complete SSE events from a clone without changing the page's response.
   * Only a conversation id and server request metadata from the same event are projected.
   */
  function readOrigin(frame, stream = {}) {
      if (!frame || frame.length > 512 * 1024) { stream.header = null; return; }
      const lines = frame.split(/\r?\n/);
      const type = lines.filter(line => line.startsWith('event:')).at(-1)?.slice(6).trim() || 'message';
      let event;
      try {
        event = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
      } catch {
        if (type === 'delta' || type === 'delta_encoding') stream.header = null;
        if (type === 'delta_encoding') stream.encoding = false;
        return;
      }
      if (type === 'delta_encoding') {
        stream.encoding = event === 'v1';
        stream.header = stream.encoding ? { c: 0, p: '', o: 'add' } : null;
        return;
      }
      let body;
      if (type === 'delta' && stream.encoding === false) return;
      if (type === 'delta' && !stream.header && event?.p === '' && event?.o === 'add') {
        // A handoff may omit the prologue. Preserve the existing self-contained
        // root-add reader, without granting header inheritance to later values.
        body = event.v;
      } else if (type === 'delta') {
        // Native v1 omits repeated headers, including on complete root messages.
        // Keep only format state in this stream, never prior message values.
        if (!stream.header || !event || typeof event !== 'object' || Array.isArray(event)) { stream.header = null; return; }
        const field = key => Object.prototype.hasOwnProperty.call(event, key) ? event[key] : stream.header[key];
        const c = field('c'), p = field('p'), o = field('o');
        if (!Number.isInteger(c) || c < 0 || c > 1023 || typeof p !== 'string' || p.length > 1024 ||
            !['add', 'replace', 'append', 'patch', 'remove', 'truncate'].includes(o)) { stream.header = null; return; }
        stream.header = { c, p, o };
        if (p !== '' || (o !== 'add' && o !== 'replace')) return;
        body = event.v;
      } else {
        body = event?.o === 'add' && (event.p === '' || event.p === undefined) &&
          event.v && typeof event.v === 'object' && !Array.isArray(event.v) ? event.v : event;
      }
      const conversations = new Set();
      CONVERSATION_FIELD.lastIndex = 0;
      for (let match; (match = CONVERSATION_FIELD.exec(frame));) {
        if (CONVERSATION.test(match[1])) conversations.add(match[1]);
      }
      // One complete server event must carry both sides of the join. Retaining an id from a
      // prior frame would turn response order into authority; a contradictory frame abstains.
      if (conversations.size !== 1) return;
      const conversationId = conversations.values().next().value;
      // Only server metadata in a complete JSON event owns a request id. A key in
      // quoted model text, tool arguments or an unrelated nested object is not proof.
      if (body?.conversation_id !== conversationId) return;
      const requestIds = new Set([body.metadata?.request_id, body.message?.metadata?.request_id]
        .filter(id => typeof id === 'string' && REQUEST.test(id)));
      return requestIds.size ? { conversationId, requestIds: [...requestIds] } : null;
  }
  async function inspectRequestOrigins(response, observedAt) {
    let url;
    try { url = new URL(response.url); } catch { return; }
    // The shell resumes an interrupted turn on /f/conversation/resume, the same SSE format;
    // its own stream observer lists exactly these two paths.
    if (url.origin !== location.origin || !/^\/backend-api\/(?:conversation|f\/conversation(?:\/resume)?)$/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
    // At most two responses are read at once. The newest is the live turn: an older one a
    // background page keeps open is let go rather than blinding the reader to it.
    if (originReaders.size >= 2) {
      const oldest = originReaders.values().next().value;
      originReaders.delete(oldest);
      void oldest.cancel().catch(() => {});
    }
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    originReaders.add(reader);
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), ORIGIN_LISTEN_MS);
    const decoder = new TextDecoder(), emitted = new Set(), stream = {}, traced = new Set();
    let bytes = 0, buffer = '';
    const scan = (frame) => {
      const origin = readOrigin(frame, stream);
      if (!origin) return;
      const fresh = origin.requestIds.filter((id) => !emitted.has(id)).slice(0, 16 - emitted.size);
      if (fresh.length === 0) return;
      for (const id of fresh) emitted.add(id);
      publishOrigin(origin.conversationId, fresh, observedAt);
    };
    const scanAndTrace = (frame) => {
      scan(frame);
      traceIds(frame, namedConversation(frame, stream.conversationId), traced);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf('\n\n');
          const crlf = buffer.indexOf('\r\n\r\n');
          const split = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
          if (split < 0) break;
          const width = buffer.startsWith('\r\n\r\n', split) ? 4 : 2;
          scanAndTrace(buffer.slice(0, split));
          // Origins stop at 16; traces have their own bound and keep reading until it.
          if (emitted.size >= 16 && traced.size >= 64) return;
          buffer = buffer.slice(split + width);
        }
        if (buffer.length > 512 * 1024) return;
      }
      buffer += decoder.decode();
      scanAndTrace(buffer);
    } catch { /* A missing stream observation leaves the existing Fiber path in charge. */ }
    finally { clearTimeout(timer); originReaders.delete(reader); void reader.cancel().catch(() => {}); }
  }
  let observedFetch = null;
  let observedWebSocket = null;
  const observedSockets = new WeakSet();
  function inspectSocketMessage(event, streams) {
    // Every socket message is read for traces: the ids of a turn may travel outside its stream items.
    if (typeof event.data === 'string' && event.data.length <= 512 * 1024) {
      const traced = streams.traced ??= new Set();
      if (traced.size >= 256) traced.clear();
      traceIds(event.data, namedConversation(event.data, routeConversation()), traced, 'socket>', 256);
    }
    // Pro hands its HTTP stream to the native conversation-turn-stream socket.
    // Header-only events matter too. No subscriptions or message reconstruction.
    if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) { streams.clear(); return; }
    let rows;
    try { rows = JSON.parse(event.data); } catch { streams.clear(); return; }
    if (!Array.isArray(rows) || rows.length > 32) { streams.clear(); return; }
    for (const row of rows) {
      const payload = row?.payload?.payload;
      if (row?.type !== 'message' || row.payload?.type !== 'conversation-turn-stream' ||
          typeof payload?.conversation_id !== 'string' || !CONVERSATION.test(payload.conversation_id)) continue;
      const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
      const key = opaque(payload.turn_id) ? `${payload.conversation_id}\u0000${payload.turn_id}` : null;
      if (payload.type === 'done') { if (key) streams.delete(key); continue; }
      if (payload.type !== 'stream-item') continue;
      if (typeof payload.encoded_item !== 'string' || payload.encoded_item.length > 512 * 1024) { if (key) streams.delete(key); continue; }
      const frames = payload.encoded_item.split(/\r?\n\r?\n/);
      if (frames.length > 16) { if (key) streams.delete(key); continue; }
      let stream = {};
      if (key && opaque(payload.stream_item_id) && (payload.parent_stream_item_id === null || opaque(payload.parent_stream_item_id))) {
        const now = Date.now();
        let retained = streams.get(key);
        if (!retained || now < retained.at || now - retained.at > ORIGIN_LISTEN_MS) {
          if (!streams.has(key) && streams.size >= 8) streams.delete(streams.keys().next().value);
          retained = { at: now, header: null, last: null, seen: new Set() }; streams.set(key, retained);
        }
        if (retained.seen.has(payload.stream_item_id)) continue;
        // Only the exact preceding item can supply omitted format headers.
        if (payload.parent_stream_item_id !== retained.last) retained.header = null;
        retained.last = payload.stream_item_id;
        if (retained.seen.size >= 128) retained.seen.delete(retained.seen.values().next().value);
        retained.seen.add(payload.stream_item_id);
        stream = retained;
      } else if (key) streams.delete(key);
      for (const frame of frames) {
        if (!frame.trim()) continue;
        const origin = readOrigin(frame, stream);
        if (origin?.conversationId === payload.conversation_id)
          publishOrigin(origin.conversationId, origin.requestIds, Date.now());
        if (namedConversation(frame, payload.conversation_id) === payload.conversation_id) traceIds(frame, payload.conversation_id, stream.traced ??= new Set());
      }
    }
  }
  function installSocketObserver() {
    if (typeof window.WebSocket !== 'function' || window.WebSocket === observedWebSocket) return;
    observedWebSocket = new Proxy(window.WebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        try {
          const url = new URL(socket.url);
          if (url.protocol === 'wss:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) &&
              !observedSockets.has(socket)) {
            observedSockets.add(socket);
            const streams = new Map();
            socket.addEventListener('message', event => inspectSocketMessage(event, streams));
            socket.addEventListener('close', () => streams.clear());
          }
        } catch { /* Foreign/unsupported transport remains untouched. */ }
        return socket;
      }
    });
    window.WebSocket = observedWebSocket;
  }
  const inspectedResponses = new WeakSet();
  const installFetchObserver = () => {
    if (window.fetch === observedFetch || typeof window.fetch !== 'function') return;
    // A page wrapper may still call our earlier wrapper. Capture its downstream
    // function per installation; changing a shared pointer would create a cycle.
    const downstreamFetch = window.fetch;
    observedFetch = function (...args) {
      // Request order fences late responses, not accounts. No account identity is inferred.
      const observedAt = Date.now(), order = ++requestOrder;
      const result = downstreamFetch.apply(this, args);
      void result.then((response) => {
        if (inspectedResponses.has(response)) return;
        inspectedResponses.add(response);
        void inspect(response, observedAt, order).catch(() => {});
        let method = 'GET';
        try {
          const explicit = args[1] && typeof args[1].method === 'string' ? args[1].method : null;
          const inherited = args[0] && typeof args[0] === 'object' && typeof args[0].method === 'string' ? args[0].method : null;
          method = String(explicit || inherited || 'GET').toUpperCase();
        } catch { return; }
        if (method === 'POST') void inspectRequestOrigins(response, observedAt).catch(() => {});
        void inspectOtherStreams(response).catch(() => {});
      }).catch(() => {});
      return result;
    };
    // ChatGPT installs its own fetch instrumentation after document_start. Keep that owner in
    // the chain and reattach once at the page-ready boundary; otherwise our flag remains set
    // while the live response observer has silently been replaced.
    window.fetch = observedFetch;
  };
  installFetchObserver();
  installSocketObserver();
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installFetchObserver, { once: true });
    window.addEventListener('DOMContentLoaded', installSocketObserver, { once: true });
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'cos-usage-request') return;
    if (latest) post(latest, location.origin);
    // Newest first: old evidence must not fill content's 16-ID pending capacity
    // before the current workflow can enter it during document startup.
    for (const { conversationId, requestId, observedAt } of [...origins.values()].slice(-16).reverse())
      post({ type: 'cos-request-origin', conversationId, requestIds: [requestId], observedAt }, location.origin);
  });
  window.addEventListener('pagehide', () => {
    for (const reader of [...originReaders, ...otherTraceReaders]) void reader.cancel().catch(() => {});
    origins.clear();
  });
})();
