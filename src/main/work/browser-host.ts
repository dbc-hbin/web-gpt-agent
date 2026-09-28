import { getSession } from '../session/store.js';
import { sessionInputPolicy } from '../session/input.js';
import { hasNativeExecution } from './runtime.js';
import { getWorkControllerBinding, initWorkContinuity, recoverWorkContinuity, setWorkContinuityOriginQuery } from './continuity.js';
import { cancelWorkInput, deliverWorkInput, onWorkInputChanged, readWorkInput, setWorkInputBindingQuery, setWorkInputInstructionQuery, workInputOrigin } from './input-outbox.js';
import type { WorkStore } from './store.js';
import type { WorkServiceHandle } from './service.js';

/** Installs the same browser delivery/continuity owners in Electron and Node hosts. */
export async function initWorkBrowserHost(store: WorkStore, service: () => WorkServiceHandle | null): Promise<void> {
  // Mobile continuity: a bound ChatGPT conversation can drive this work without a page of its
  // own, and durable work events are reported back into that same conversation. It is installed
  // after the ledger and the runtime (it routes through the same service) and before the control
  // endpoint, so no interface can admit a controller message before the manager exists.
  // The input owner's fence for generated results reads the controller's own binding, so it is
  // installed before anything can admit a report and before continuity starts. Ownership is the
  // controller's whole continuation chain: normal continuation moves a controller from a work to
  // its successor without changing the chat, and the predecessor's completion report still
  // belongs to it. The walk is bounded, mirroring the ledger's own chain limit.
  const workLedger = store;
  setWorkInputBindingQuery(sessionId => {
    const binding = getWorkControllerBinding(sessionId);
    if (!binding) return null;
    // Ownership is the controller's whole durable continuation chain, walked in both directions and
    // terminated by a visited set rather than a depth budget: a binding that lags a long chain still
    // owns its tail, and a chain longer than any fixed hop count must not lose its own report. The
    // visited set is also what makes a corrupt cycle stop instead of spinning.
    const workIds = new Set<string>([binding.work_id]);
    const pending = [binding.work_id];
    while (pending.length > 0) {
      const work = workLedger.getWork(pending.pop()!);
      if (!work) continue;
      for (const next of [work.successor_work_id, work.predecessor_work_id]) {
        if (!next || workIds.has(next)) continue;
        workIds.add(next);
        pending.push(next);
      }
    }
    return { workIds: [...workIds], conversationId: binding.conversation_id,
      providerAccountId: binding.provider_account_id, boundAt: binding.bound_at, enabled: binding.enabled };
  });
  // A managed instruction's Send authority is its own work, read from the same ledger the runtime
  // fences on: paused, cancelled or finished works stop owning the row, and the row must still be
  // addressed to the prime session that work is bound to now.
  setWorkInputInstructionQuery(workId => {
    const work = workLedger.getWork(workId);
    if (!work) return null;
    return { primeSessionId: work.prime_session_id, active: !work.desired_state && !['paused', 'cancelled', 'completed'].includes(work.status) };
  });
  setWorkContinuityOriginQuery(input => workInputOrigin(input.sessionId, input.messageId, input.text));
  await initWorkContinuity({
    store,
    service,
    // The input owner's own policy is the one settle authority: a report and a relayed
    // instruction both wait for a verified completion boundary in that exact conversation.
    conversationSettled: async ({ sessionId, conversationId }) => {
      const session = await getSession(sessionId).catch(() => null);
      if (!session || session.conversationId !== conversationId) return false;
      return sessionInputPolicy(sessionId).then(policy => policy.settled && policy.browserAllowed).catch(() => false);
    },
    messageOrigin: async ({ sessionId, messageId, text }) => workInputOrigin(sessionId, messageId, text),
    // The exact duplicate-prevention authority: whether one provider request really admitted
    // managed work under this work. The manager decides "already handled natively" from this
    // receipt, never from the work's status or a clock.
    nativeExecution: input => hasNativeExecution(input),
    deliverReport: async report => deliverWorkInput({
      id: report.id,
      sessionId: report.sessionId,
      text: report.text,
      model: report.model,
      reasoning: report.reasoning,
      dueAt: report.dueAt,
      kind: 'controller-report',
      workId: report.workId,
      // The report's own destination, account and binding epoch travel with it, so a binding that
      // moved between producing and sending this report refuses it instead of redirecting it.
      conversationId: report.conversationId,
      providerAccountId: report.providerAccountId,
      boundAt: report.boundAt
    }),
    // Read-only: an ambiguous report is reconciled from the outbox's own durable row and is never
    // sent again.
    reconcileReport: async ({ id }) => readWorkInput(id),
    cancelReport: async ({ id }) => cancelWorkInput(id),
    onDeliveryChange: listener => onWorkInputChanged(() => listener())
  });
  await recoverWorkContinuity();
}
