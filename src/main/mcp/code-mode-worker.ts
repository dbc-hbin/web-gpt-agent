/** Trusted worker bootstrap. Model source runs only inside the bounded QuickJS WASM heap.
 * The Node worker owns scheduling, timers, the JSON bridge and the blocking state channel;
 * model code never reaches a Node global. */
export const CODE_MODE_WORKER_SOURCE = String.raw`
const { parentPort, workerData: startupData } = require('node:worker_threads');
const { newQuickJSWASMModuleFromVariant } = require(startupData.coreModule);
const variant = require(startupData.wasmModule).default;
let closed = false;
const send = message => { if (!closed) parentPort.postMessage(message); };
let releaseRejected = null;
function finish(error) {
  if (closed) return;
  if (releaseRejected) releaseRejected();
  send({ type: 'done', error });
  closed = true;
}
async function run(QuickJS, workerData) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(workerData.limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();
  let usedCpu = 0, sliceStart = null, fatal = null, nextCallId = 0, emitted = 0, outputBytes = 0;
  const pending = new Map(), timerHandles = new Map();
  const channel = workerData.stateBuffer
    ? { control: new Int32Array(workerData.stateBuffer, 0, 4), payload: new Uint8Array(workerData.stateBuffer, 16) }
    : null;
  // The budget meters CPU this interpreter thread spends, so a loaded machine preempting it does not
  // charge the guest. Windows advances thread times only on scheduler ticks (~15.6 ms), coarser than
  // the budget itself, so it keeps the monotonic clock there, as does a runtime without the API.
  const clock = process.platform === 'win32' || typeof process.threadCpuUsage !== 'function'
    ? () => performance.now()
    : () => { const { user, system } = process.threadCpuUsage(); return (user + system) / 1000; };
  // Only guest slices are metered. Trusted bootstrap and host bookkeeping run with no open slice, so
  // they can neither spend the guest budget nor be interrupted by it.
  runtime.setInterruptHandler(() => sliceStart !== null && usedCpu + clock() - sliceStart > workerData.limits.cpuMs);
  const enter = fn => { sliceStart = clock(); try { return fn(); } finally { usedCpu += clock() - sliceStart; sliceStart = null; } };
  // The interpreter thread blocks here while the host answers, so state access is atomic with respect
  // to every other cell and nothing is mirrored inside the isolate. The host returns a bounded JSON
  // envelope, so a refused or failed request comes back as data and never as a host-level throw.
  const stateCall = json => {
    if (!channel) return JSON.stringify({ ok: false, error: 'State is unavailable in this execution.' });
    const bytes = Buffer.from(json, 'utf8');
    if (bytes.length > channel.payload.length) return JSON.stringify({ ok: false, error: 'State request is too large.' });
    channel.payload.set(bytes);
    Atomics.store(channel.control, 1, bytes.length);
    Atomics.store(channel.control, 0, 1);
    const waitingStartedAt = clock();
    send({ type: 'state' });
    const waiting = Atomics.wait(channel.control, 0, 1, 30_000) === 'timed-out';
    // Time spent blocked on the host is not guest CPU time. The current slice simply started later,
    // so advancing sliceStart excludes the wait without touching the already-accumulated total.
    sliceStart += clock() - waitingStartedAt;
    if (waiting) {
      Atomics.store(channel.control, 0, 0);
      return JSON.stringify({ ok: false, error: 'State request timed out.' });
    }
    const length = Atomics.load(channel.control, 2);
    const answer = Buffer.from(channel.payload.subarray(0, length)).toString('utf8');
    Atomics.store(channel.control, 0, 0);
    return answer;
  };
  // Rejected nested calls are remembered by identity, not by a guest-visible marker a script could
  // forge. Only a value this host actually rejected can carry a child message to the model.
  const rejectedErrors = [];
  releaseRejected = () => { for (const entry of rejectedErrors) entry.handle.dispose(); rejectedErrors.length = 0; };
  const rejectCall = (promise, message) => {
    const error = vm.newError(message);
    rejectedErrors.push({ handle: error.dup(), message });
    promise.reject(error);
    error.dispose();
  };
  const bridge = vm.newFunction('__bridge', (operation, payload) => {
    const kind = vm.getString(operation), json = vm.getString(payload);
    if (fatal) return { error: vm.newError('Script limit reached') };
    if (kind === 'exit') { finish(null); return vm.undefined; }
    if (closed) return { error: vm.newError('Script closed') };
    if (kind === 'call') {
      if (++nextCallId > workerData.limits.calls || pending.size >= workerData.limits.concurrentCalls || Buffer.byteLength(json) > workerData.limits.argumentBytes) {
        fatal = 'CALL_LIMIT'; return { error: vm.newError('Call limit') };
      }
      const promise = vm.newPromise();
      pending.set(nextCallId, promise);
      send({ type: 'call', id: nextCallId, json });
      return promise.handle.dup();
    }
    if (kind === 'state') return vm.newString(stateCall(json));
    if (kind === 'setTimer' || kind === 'clearTimer' || kind === 'yield') { send({ type: kind, json }); return vm.undefined; }
    if (kind === 'text' || kind === 'image' || kind === 'audio' || kind === 'generatedImage' || kind === 'notify') {
      if (++emitted > workerData.limits.outputItems) {
        fatal = 'OUTPUT_LIMIT'; return { error: vm.newError('Output limit') };
      }
      if (!workerData.skipEmittedByteLimits) {
        const size = Buffer.byteLength(json);
        outputBytes += size;
        if (size > workerData.limits.resultBytes || outputBytes > workerData.limits.outputBytes) {
          fatal = 'OUTPUT_LIMIT'; return { error: vm.newError('Output limit') };
        }
      }
      send({ type: 'emit', kind, json });
      return vm.undefined;
    }
    fatal = 'BRIDGE_ERROR'; return { error: vm.newError('Invalid bridge operation') };
  });
  vm.setProp(vm.global, '__bridge', bridge); bridge.dispose();
  // A guest callback argument is only valid for the duration of the host call that received it, so a
  // scheduled timer keeps its own duplicate handle until the host fires or clears it.
  const timerRegistry = vm.newFunction('__timers', (operation, idHandle, callbackHandle) => {
    const kind = vm.getString(operation), id = vm.getNumber(idHandle);
    if (kind === 'set') { timerHandles.set(id, callbackHandle.dup()); return vm.undefined; }
    const handle = timerHandles.get(id);
    if (handle) { handle.dispose(); timerHandles.delete(id); }
    return vm.undefined;
  });
  vm.setProp(vm.global, '__timers', timerRegistry); timerRegistry.dispose();
  const setup = vm.evalCode('(() => { ' +
    'const bridge = globalThis.__bridge, timers = globalThis.__timers; delete globalThis.__bridge; delete globalThis.__timers; ' +
    'const stringify = JSON.stringify, parse = JSON.parse, String_ = String; ' +
    'const tools = Object.create(null), guestTimers = new Map(); let nextTimer = 0; ' +
    'const entries = ' + JSON.stringify(workerData.tools) + '; ' +
    'const scalar = value => typeof value === "string" ? value : (stringify(value) ?? String_(value)); ' +
    'for (const entry of entries) { Object.freeze(entry); tools[entry.name] = args => bridge("call", stringify({name:entry.name,args})).then(parse); } ' +
    'const needsOwner = () => { throw new Error("A trusted session owner is required for this helper"); }; ' +
    'const store_ = (key, value) => { if (!' + JSON.stringify(workerData.allowState) + ') needsOwner(); if (typeof key !== "string") throw new TypeError("store key must be a string"); const json = stringify(value); if (json === undefined) throw new TypeError("stored value must be JSON serializable"); const answer = parse(bridge("state", stringify({op:"store",key,json}))); if (!answer.ok) throw new Error(answer.error); }; ' +
    'const load_ = key => { if (!' + JSON.stringify(workerData.allowState) + ') needsOwner(); if (typeof key !== "string") throw new TypeError("load key must be a string"); const answer = parse(bridge("state", stringify({op:"load",key}))); if (!answer.ok) throw new Error(answer.error); return answer.found ? parse(answer.json) : undefined; }; ' +
    // clearTimeout(null) and clearTimeout(unknown) are harmless in normal JavaScript, so only an id
    // this execution actually armed is ever forwarded to the host.
    'const setTimeout_ = (callback, delay = 0) => { if (typeof callback !== "function") throw new TypeError("callback must be a function"); const id = ++nextTimer; guestTimers.set(id, callback); timers("set", id, callback); bridge("setTimer", stringify({id, delay})); return id; }; ' +
    'const clearTimeout_ = id => { if (typeof id !== "number" || !guestTimers.has(id)) return; guestTimers.delete(id); timers("clear", id, undefined); bridge("clearTimer", stringify({id})); }; ' +
    'Object.defineProperties(globalThis, {' +
      'tools:{value:Object.freeze(tools)}, ALL_TOOLS:{value:Object.freeze(entries)}, ' +
      'text:{value:value=>bridge("text",stringify(scalar(value)))}, image:{value:value=>bridge("image",stringify(value))}, ' +
      'audio:{value:value=>bridge("audio",stringify(value))}, generatedImage:{value:value=>bridge("generatedImage",stringify(value))}, ' +
      'notify:{value:value=>bridge("notify",stringify(scalar(value)))}, store:{value:store_}, load:{value:load_}, ' +
      'setTimeout:{value:setTimeout_}, clearTimeout:{value:clearTimeout_}, ' +
      'yield_control:{value:()=>{ if (!' + JSON.stringify(workerData.allowYield) + ') needsOwner(); bridge("yield","null"); }}, ' +
      'exit:{value:()=>{bridge("exit","null");throw undefined;}}' +
    '}); ' +
    'return id => { const callback = guestTimers.get(id); if (!callback) return; guestTimers.delete(id); callback(); }; })()');
  if (setup.error) { setup.error.dispose(); finish('RUNTIME_ERROR'); return; }
  const runTimer = setup.value;
  let execution;
  /** Reports the guest's own rejection. A marked nested failure contributes its child-visible text so
   * the model can act on it; any other script error stays generic and is never echoed. */
  const finishRejected = (error, duringEvaluation = false) => {
    if (fatal) { finish(fatal); return; }
    // A tight loop is stopped by the interrupt handler, which surfaces here as an abort error.
    if (usedCpu > workerData.limits.cpuMs) { finish('CPU_LIMIT'); return; }
    const dumped = vm.dump(error);
    const name = dumped && typeof dumped === 'object' && typeof dumped.name === 'string' ? dumped.name : '';
    if (duringEvaluation && name === 'SyntaxError') { finish('PARSE_ERROR'); return; }
    let reason = 'SCRIPT_ERROR';
    const known = rejectedErrors.find(entry => vm.eq(entry.handle, error));
    if (known) {
      const message = known.message.trim();
      if (message) reason = 'SCRIPT_ERROR: ' + message.slice(0, 400);
    }
    finish(reason);
  };
  const check = () => {
    if (closed) return;
    if (fatal) { finish(fatal); return; }
    if (usedCpu > workerData.limits.cpuMs) { finish('CPU_LIMIT'); return; }
    const jobs = enter(() => runtime.executePendingJobs(64));
    if (jobs.error) { jobs.error.dispose(); finish(usedCpu > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR'); return; }
    const state = enter(() => vm.getPromiseState(execution));
    if (state.type === 'rejected') { enter(() => finishRejected(state.error)); state.error.dispose(); return; }
    if (state.type === 'fulfilled') { state.value.dispose(); finish(fatal); return; }
    if (runtime.hasPendingJob()) setImmediate(check);
  };
  // Handles are released once the execution has ended, so a long-lived worker holds no guest values.
  const fireTimer = id => {
    const handle = timerHandles.get(id);
    if (handle) { timerHandles.delete(id); handle.dispose(); }
    enter(() => { const value = vm.newNumber(id); const called = vm.callFunction(runTimer, vm.undefined, value); value.dispose(); called.dispose(); });
    check();
  };
  parentPort.on('message', message => {
    if (closed) return;
    if (message.type === 'result' && typeof message.id === 'number') {
      const promise = pending.get(message.id);
      if (!promise) return;
      pending.delete(message.id);
      enter(() => {
        if (message.error === undefined) {
          const value = vm.newString(message.json);
          promise.resolve(value);
          value.dispose();
        } else rejectCall(promise, message.error);
        promise.dispose();
      });
      check();
      return;
    }
    if (message.type === 'timer' && typeof message.id === 'number') fireTimer(message.id);
  });
  const evaluated = enter(() => vm.evalCode(workerData.code, 'code-mode.mjs', { type: 'module' }));
  if (evaluated.error) {
    // Module evaluation runs during evalCode, so a top-level throw arrives here. Only a real syntax
    // error is a parse error; a thrown script error keeps its own classification and message.
    enter(() => finishRejected(evaluated.error, true));
    evaluated.error.dispose();
    return;
  }
  execution = evaluated.value;
  check();
}
(async () => {
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  if (closed) return;
  send({ type: 'ready' });
  parentPort.once('message', message => {
    if (closed || message.type !== 'start') { finish('BRIDGE_ERROR'); return; }
    void run(QuickJS, message.data).catch(() => finish('RUNTIME_ERROR'));
  });
})().catch(() => finish('RUNTIME_ERROR'));
`;
