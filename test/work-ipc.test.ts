import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The GUI work channels, exercised through the registrar `src/main/ipc.ts` actually calls.
 *
 * These cases defend the two things a renderer depends on and cannot check for itself: that a
 * call made before the host opened its ledger fails with a truthful code instead of a crash,
 * and that every payload is parsed by the shared schema rather than trusted. The work service
 * itself is faked — its behavior is the ledger slice's own suite — but the registrar, the
 * channel names, the schema boundary and the `work:changed` push are the real ones.
 */

const showItemInFolder = vi.fn();
vi.mock('electron', () => ({ shell: { showItemInFolder } }));

/**
 * The continuity manager and the session store are the two things this registrar reads for the
 * connection channels, and both are faked here: the manager's own behavior (ownership, accounts,
 * report pumps) is its own suite's business, and what these cases defend is the boundary — that
 * the renderer names a session and the host resolves the conversation, that a disconnect never
 * becomes a work control, and that a chat with no recorded thread is refused rather than guessed.
 */
const continuity = vi.hoisted(() => ({
  getWorkControllerBinding: vi.fn(),
  setWorkControllerEnabled: vi.fn(),
  bindWorkController: vi.fn()
}));
vi.mock('../src/main/work/continuity.js', () => continuity);

const sessions = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('../src/main/session/store.js', () => sessions);

const { registerWorkIpc } = await import('../src/main/work-ipc.js');
const { WORK_IPC } = await import('../src/shared/work-ipc.js');
const { setWorkService } = await import('../src/main/work/service.js');
const { WORK_ERROR_CODES, WorkServiceError } = await import('../src/shared/work.js');

type Handler = (payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const pushes: unknown[][] = [];
const service = {
  start: vi.fn(async (input: { request_id: string; work_id?: string }) => ({ request_id: input.request_id, work_id: '11111111-1111-4111-8111-111111111111', status: 'queued' as const, revision: 1 })),
  list: vi.fn(async () => ({ works: [], projects: [], next_cursor: null })),
  status: vi.fn(async () => ({ work_id: '11111111-1111-4111-8111-111111111111', integration_worktree: '/tmp/worktrees/11111111/main' })),
  instruct: vi.fn(async (input: { request_id: string }) => ({ request_id: input.request_id, work_id: '11111111-1111-4111-8111-111111111111', status: 'running' as const, revision: 2 })),
  control: vi.fn(async (input: { request_id: string }) => ({ request_id: input.request_id, work_id: '11111111-1111-4111-8111-111111111111', status: 'paused' as const, revision: 3 })),
  events: vi.fn(async () => ({ events: [], next_cursor: 0, has_more: false }))
};

beforeEach(() => {
  handlers.clear();
  pushes.length = 0;
  showItemInFolder.mockReset();
  for (const fn of Object.values(service)) (fn as ReturnType<typeof vi.fn>).mockClear();
  for (const fn of Object.values(continuity)) fn.mockReset();
  sessions.getSession.mockReset();
  setWorkService(null);
  registerWorkIpc(
    ((channel: string, fn: Handler) => handlers.set(channel, fn)) as never,
    (channel: string, ...args: unknown[]) => { pushes.push([channel, ...args]); }
  );
});

describe('GUI work channels', () => {
  it('registers exactly the declared channels, so a rename cannot silently drop one', () => {
    expect([...handlers.keys()].sort()).toEqual([
      WORK_IPC.control, WORK_IPC.controllerGet, WORK_IPC.controllerSet, WORK_IPC.events,
      WORK_IPC.instruct, WORK_IPC.list, WORK_IPC.reveal, WORK_IPC.start, WORK_IPC.status
    ].sort());
  });

  it('fails closed with HOST_UNAVAILABLE before the host opens its ledger', async () => {
    await expect(handlers.get(WORK_IPC.list)!({})).rejects.toMatchObject({
      code: WORK_ERROR_CODES.hostUnavailable
    });
    await expect(handlers.get(WORK_IPC.status)!({ work_id: '11111111-1111-4111-8111-111111111111' }))
      .rejects.toBeInstanceOf(WorkServiceError);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('parses every payload with the shared schema and forwards it unchanged when valid', async () => {
    setWorkService(service as never);
    const request = { request_id: '22222222-2222-4222-8222-222222222222', project_path: '/tmp/fixture', goal: 'Refactor the parser.', max_workers: 3 };
    const receipt = await handlers.get(WORK_IPC.start)!(request);
    expect(receipt).toMatchObject({ work_id: '11111111-1111-4111-8111-111111111111', revision: 1 });
    expect(service.start).toHaveBeenCalledWith(request);

    // A payload that is not the work schema never reaches the service.
    await expect(handlers.get(WORK_IPC.start)!({ request_id: 'not-a-uuid', project_path: '/tmp/fixture', goal: 'x' }))
      .rejects.toThrow();
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown control action instead of reaching the service', async () => {
    setWorkService(service as never);
    await expect(handlers.get(WORK_IPC.control)!({
      request_id: '22222222-2222-4222-8222-222222222222',
      work_id: '11111111-1111-4111-8111-111111111111',
      action: 'restart'
    })).rejects.toThrow();
    expect(service.control).not.toHaveBeenCalled();
  });

  it('reveals only the worktree the ledger recorded for that work', async () => {
    setWorkService(service as never);
    await handlers.get(WORK_IPC.reveal)!({ work_id: '11111111-1111-4111-8111-111111111111' });
    expect(showItemInFolder).toHaveBeenCalledWith('/tmp/worktrees/11111111/main');

    // A work whose worktree has not been created yet must not reveal the project folder.
    (service.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      work_id: '11111111-1111-4111-8111-111111111111', integration_worktree: null
    });
    await expect(handlers.get(WORK_IPC.reveal)!({ work_id: '11111111-1111-4111-8111-111111111111' }))
      .rejects.toMatchObject({ code: WORK_ERROR_CODES.workNotFound });
    expect(showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it('pushes the durable change the ledger committed, revision included', async () => {
    const change = { work_id: '11111111-1111-4111-8111-111111111111', revision: 12, status: 'running' as const, kind: 'work_running' };
    const before = pushes.length;
    // The registrar subscribes once; the store's change bus is bridged by the host, so emitting
    // through the real bridge is what proves the channel and its payload.
    const { attachWorkChanges } = await import('../src/main/work/service.js');
    const store = { onChanged: (listener: (value: typeof change) => void) => { listener(change); return () => undefined; } };
    attachWorkChanges(store as never)();
    const emitted = pushes.slice(before);
    expect(emitted.length).toBeGreaterThan(0);
    for (const entry of emitted) expect(entry).toEqual([WORK_IPC.changed, change]);
  });

  it('resolves the conversation from the saved session instead of accepting one from the renderer', async () => {
    setWorkService(service as never);
    sessions.getSession.mockResolvedValue({ id: 'session-a', conversationId: 'conversation-saved' });
    const binding = {
      session_id: 'session-a', conversation_id: 'conversation-saved', provider_account_id: null,
      work_id: '11111111-1111-4111-8111-111111111111', bound_at: 5, enabled: true, event_cursor: 0, updated_at: 5
    };
    continuity.bindWorkController.mockReturnValue(binding);

    const reply = await handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '11111111-1111-4111-8111-111111111111', enabled: true
    });
    expect(reply).toEqual(binding);
    // The saved conversation is what is bound; a provider conversation id in the payload is not
    // part of the schema at all, so it can never reach the ledger. `origin: 'explicit'` is what
    // makes this press a person's decision rather than a replaceable prime fallback.
    expect(continuity.bindWorkController).toHaveBeenCalledWith({
      sessionId: 'session-a', conversationId: 'conversation-saved',
      workId: '11111111-1111-4111-8111-111111111111', takeover: true, origin: 'explicit'
    });
    await expect(handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '11111111-1111-4111-8111-111111111111', enabled: true,
      conversation_id: 'conversation-invented'
    })).rejects.toThrow();
  });

  it('adopts an automatic binding when a person connects that same chat', async () => {
    setWorkService(service as never);
    sessions.getSession.mockResolvedValue({ id: 'session-a', conversationId: 'conversation-saved' });
    // The prime fallback already bound this exact chat, so nothing about the pair changed — but the
    // row is replaceable by a later automatic handover, and this press is a person claiming it.
    // Returning the row unchanged would leave their deliberate reconnection stealable.
    const automatic = {
      session_id: 'session-a', conversation_id: 'conversation-saved', provider_account_id: null,
      work_id: '11111111-1111-4111-8111-111111111111', bound_at: 5, enabled: true, event_cursor: 0, updated_at: 5,
      origin: 'automatic' as const
    };
    continuity.getWorkControllerBinding.mockReturnValue(automatic);
    const adopted = { ...automatic, origin: 'explicit' as const };
    continuity.bindWorkController.mockReturnValue(adopted);

    expect(await handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '11111111-1111-4111-8111-111111111111', enabled: true
    })).toEqual(adopted);
    expect(continuity.bindWorkController).toHaveBeenCalledWith({
      sessionId: 'session-a', conversationId: 'conversation-saved',
      workId: '11111111-1111-4111-8111-111111111111', takeover: true, origin: 'explicit'
    });

    // A row that is already this person's own, on the same saved thread, is a press that changed
    // nothing: no write, and no moved boundary.
    continuity.getWorkControllerBinding.mockReturnValue(adopted);
    continuity.bindWorkController.mockClear();
    expect(await handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '11111111-1111-4111-8111-111111111111', enabled: true
    })).toEqual(adopted);
    expect(continuity.bindWorkController).not.toHaveBeenCalled();
  });

  it('refuses a chat with no recorded conversation rather than connecting a guess', async () => {
    setWorkService(service as never);
    sessions.getSession.mockResolvedValue({ id: 'session-a', conversationId: null });
    await expect(handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '11111111-1111-4111-8111-111111111111', enabled: true
    })).rejects.toMatchObject({ code: WORK_ERROR_CODES.stateUnavailable });
    expect(continuity.bindWorkController).not.toHaveBeenCalled();

    // A session the store does not have is refused for the same reason, not bound to nothing.
    sessions.getSession.mockResolvedValue(null);
    await expect(handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-missing', work_id: '11111111-1111-4111-8111-111111111111', enabled: true
    })).rejects.toMatchObject({ code: WORK_ERROR_CODES.stateUnavailable });
    expect(continuity.bindWorkController).not.toHaveBeenCalled();
  });

  it('validates the work against the ledger before any binding is written', async () => {
    setWorkService(service as never);
    sessions.getSession.mockResolvedValue({ id: 'session-a', conversationId: 'conversation-saved' });
    (service.status as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new WorkServiceError(WORK_ERROR_CODES.workNotFound, 'WORK_NOT_FOUND: no work with that id exists.')
    );
    await expect(handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '22222222-2222-4222-8222-222222222222', enabled: true
    })).rejects.toMatchObject({ code: WORK_ERROR_CODES.workNotFound });
    expect(continuity.bindWorkController).not.toHaveBeenCalled();
  });

  it('disconnects by disabling only, never by cancelling the work', async () => {
    setWorkService(service as never);
    continuity.getWorkControllerBinding.mockReturnValue({
      session_id: 'session-a', conversation_id: 'conversation-saved', provider_account_id: null,
      work_id: '11111111-1111-4111-8111-111111111111', bound_at: 5, enabled: true, event_cursor: 3, updated_at: 5
    });
    continuity.setWorkControllerEnabled.mockResolvedValue({
      session_id: 'session-a', conversation_id: 'conversation-saved', provider_account_id: null,
      work_id: '11111111-1111-4111-8111-111111111111', bound_at: 5, enabled: false, event_cursor: 3, updated_at: 9
    });
    const reply = await handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '11111111-1111-4111-8111-111111111111', enabled: false
    });
    expect(reply).toMatchObject({ enabled: false });
    expect(continuity.setWorkControllerEnabled).toHaveBeenCalledWith('session-a', false);
    // The work itself is untouched: no control action, no instruct, no cancel.
    expect(service.control).not.toHaveBeenCalled();
    expect(service.instruct).not.toHaveBeenCalled();
  });

  it('refuses a disconnect that names a work the chat is not driving', async () => {
    setWorkService(service as never);
    // The chat is connected to another work; releasing "this" work would be a no-op reported as
    // success, so it is refused instead.
    continuity.getWorkControllerBinding.mockReturnValue({
      session_id: 'session-a', conversation_id: 'conversation-saved', provider_account_id: null,
      work_id: '22222222-2222-4222-8222-222222222222', bound_at: 5, enabled: true, event_cursor: 3, updated_at: 5
    });
    await expect(handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '11111111-1111-4111-8111-111111111111', enabled: false
    })).rejects.toMatchObject({ code: WORK_ERROR_CODES.controllerBindingConflict });
    expect(continuity.setWorkControllerEnabled).not.toHaveBeenCalled();
  });

  it('reads a connection for a session without ever naming a work', async () => {
    setWorkService(service as never);
    continuity.getWorkControllerBinding.mockReturnValue(null);
    expect(await handlers.get(WORK_IPC.controllerGet)!({ session_id: 'session-a' })).toBeNull();
    expect(continuity.getWorkControllerBinding).toHaveBeenCalledWith('session-a');
    // Not connected is `null`, and a payload carrying anything but the session is refused.
    await expect(handlers.get(WORK_IPC.controllerGet)!({ session_id: 'session-a', work_id: 'x' })).rejects.toThrow();
  });

  it('fails closed with HOST_UNAVAILABLE on the connection channels before the ledger opens', async () => {
    await expect(handlers.get(WORK_IPC.controllerGet)!({ session_id: 'session-a' }))
      .rejects.toMatchObject({ code: WORK_ERROR_CODES.hostUnavailable });
    await expect(handlers.get(WORK_IPC.controllerSet)!({
      session_id: 'session-a', work_id: '11111111-1111-4111-8111-111111111111', enabled: true
    })).rejects.toMatchObject({ code: WORK_ERROR_CODES.hostUnavailable });
    expect(continuity.bindWorkController).not.toHaveBeenCalled();
    expect(continuity.setWorkControllerEnabled).not.toHaveBeenCalled();
  });
});
