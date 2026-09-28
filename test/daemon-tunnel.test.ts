/**
 * The daemon's tunnel reconciliation, against a fake transport.
 *
 * `DaemonTunnel` is where three things meet — the stored tunnel settings, the stored credential
 * and the local endpoint — and every rule it enforces is a rule that a real remote client depends
 * on. The provider itself is not involved: what is being defended here is the *decision*, and each
 * case below is a way the obvious implementation gets that decision wrong:
 *
 *   - an unchanged transport must not be restarted (a settings save for folders would otherwise
 *     drop a live connection to ChatGPT),
 *   - a changed one must be (otherwise a new tunnel id is stored and never published),
 *   - a retired child's late report must not be able to describe the transport that replaced it,
 *   - `reconnect` must rebuild even when nothing changed, because a stale provider route is
 *     exactly the failure no other input can express,
 *   - a failed start must be reported by name rather than leaving a `starting` that never lands,
 *   - and a stop during startup must own the child that startup was about to publish.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  interface FakeHandle {
    stop: () => Promise<void>;
    /** The report callback the transport was given, so a test can drive state transitions. */
    report: (value: { state: string; detail: string; publicUrl?: string | null; handshakeAt?: number | null }) => void;
    stopped: boolean;
  }
  const state = {
    config: {
      tunnel: { kind: 'openai' as string, tunnelId: '', binaryPath: '', profileId: undefined as string | undefined }
    },
    apiKey: 'sk-stored' as string | null,
    /** Every credential slot read, in order, so the profile rule can be asserted. */
    slots: [] as string[],
    /** Every transport the tunnel asked for, in order. */
    starts: [] as Array<{ kind: string; tunnelId: string; apiKey: string | null; localUrl: string }>,
    handles: [] as FakeHandle[],
    /** Makes the next start hang until released, for the stop-during-startup case. */
    hold: null as null | (() => Promise<void>),
    failWith: null as null | Error
  };
  const startTunnel = vi.fn(
    async (options: {
      localUrl: string;
      settings: { kind: string; tunnelId: string };
      apiKey: string | null;
      report: FakeHandle['report'];
    }): Promise<{ stop: () => Promise<void> }> => {
      state.starts.push({
        kind: options.settings.kind,
        tunnelId: options.settings.tunnelId,
        apiKey: options.apiKey,
        localUrl: options.localUrl
      });
      if (state.failWith) throw state.failWith;
      const handle: FakeHandle = {
        stopped: false,
        report: options.report,
        stop: async () => {
          handle.stopped = true;
        }
      };
      state.handles.push(handle);
      if (state.hold) await state.hold();
      return { stop: handle.stop };
    }
  );
  return { state, startTunnel };
});

vi.mock('../src/main/tunnel/index.js', () => ({
  startTunnel: fixture.startTunnel,
  TunnelError: class TunnelError extends Error {}
}));
vi.mock('../src/main/mcp/server.js', () => ({ tunnelProbeHeaders: () => ({ 'x-local-tunnel-probe': 't' }) }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => fixture.state.config }));
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (slot: string) => {
    fixture.state.slots.push(slot);
    return fixture.state.apiKey;
  }
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: () => undefined, logWarn: () => undefined }));

const { DaemonTunnel } = await import('../src/daemon/tunnel.js');

const TUNNEL_ID = `tunnel_${'a'.repeat(32)}`;

function build(): { tunnel: InstanceType<typeof DaemonTunnel>; states: string[] } {
  const states: string[] = [];
  const tunnel = new DaemonTunnel((state) => states.push(state.state));
  tunnel.setLocalUrl('http://127.0.0.1:5555/mcp/core/secret');
  return { tunnel, states };
}

beforeEach(() => {
  fixture.state.config.tunnel = { kind: 'openai', tunnelId: TUNNEL_ID, binaryPath: '', profileId: undefined };
  fixture.state.apiKey = 'sk-stored';
  fixture.state.slots.length = 0;
  fixture.state.starts.length = 0;
  fixture.state.handles.length = 0;
  fixture.state.hold = null;
  fixture.state.failWith = null;
  fixture.startTunnel.mockClear();
});

describe('the daemon tunnel reconciles its transport', () => {
  it('leaves an unchanged transport running, and restarts it when its identity changes', async () => {
    const { tunnel } = build();
    await tunnel.apply();
    expect(fixture.state.starts).toHaveLength(1);
    expect(tunnel.report().state).toBe('starting');

    // The same settings again, and a credential written with the value already stored: neither is
    // a different transport, so neither may drop the live one.
    await tunnel.apply();
    fixture.state.apiKey = 'sk-stored';
    await tunnel.apply();
    expect(fixture.state.starts).toHaveLength(1);
    expect(fixture.state.handles[0]!.stopped).toBe(false);

    // A different tunnel id is a different transport: the old child is retired and a new one
    // started, or a newly configured tunnel would never be published.
    fixture.state.config.tunnel.tunnelId = `tunnel_${'b'.repeat(32)}`;
    await tunnel.apply();
    expect(fixture.state.starts).toHaveLength(2);
    expect(fixture.state.starts[1]!.tunnelId).toBe(`tunnel_${'b'.repeat(32)}`);
    expect(fixture.state.handles[0]!.stopped).toBe(true);
  });

  it('rebuilds on reconnect even when nothing about the transport changed', async () => {
    const { tunnel } = build();
    await tunnel.apply();
    await tunnel.apply();
    expect(fixture.state.starts).toHaveLength(1);

    // This is the recovery verb's whole meaning: a client that is alive and locally ready while
    // its provider route went stale is not restarted by anything else.
    await tunnel.reconnect();
    expect(fixture.state.starts).toHaveLength(2);
    expect(fixture.state.handles[0]!.stopped).toBe(true);
  });

  it('refuses a late report from a transport it has already retired', async () => {
    const { tunnel } = build();
    await tunnel.apply();
    const retired = fixture.state.handles[0]!;
    await tunnel.reconnect();

    // The child that was replaced reports on its own schedule. Its `connected` describes a
    // transport that is gone, and publishing it would show a remote address nothing serves.
    retired.report({ state: 'connected', detail: 'connected', publicUrl: 'https://old.example' });
    expect(tunnel.report().state).toBe('starting');
    expect(tunnel.report().publicUrl).toBeNull();

    // The live transport's own report still lands, with its own address.
    fixture.state.handles[1]!.report({ state: 'connected', detail: 'connected', publicUrl: 'https://new.example' });
    expect(tunnel.report()).toMatchObject({ state: 'connected', publicUrl: 'https://new.example' });
  });

  it('reports a failed start by name instead of leaving a start that never lands', async () => {
    fixture.state.failWith = new Error('tunnel-client was not found.');
    const { tunnel } = build();
    await tunnel.apply();
    expect(tunnel.report()).toMatchObject({ state: 'unavailable', detail: 'tunnel-client was not found.', publicUrl: null });
  });

  it('reports the storage fact rather than inferring it, and reads the active profile’s slot', async () => {
    fixture.state.apiKey = null;
    fixture.state.config.tunnel.profileId = 'work';
    const { tunnel } = build();
    await tunnel.apply();
    // No credential: nothing is spawned, and the state says which of the two problems this is.
    expect(fixture.state.starts).toHaveLength(0);
    expect(tunnel.report()).toMatchObject({ state: 'unavailable', hasApiKey: false });
    expect(tunnel.report().detail).toContain('daemon secret set openaiApiKey');
    // The slot is the one the transport actually reads: a non-default profile stores its key under
    // `setup:<id>`, and reporting the default slot would claim a key the tunnel cannot see.
    expect(fixture.state.slots).toEqual(['setup:work']);
  });

  it('stops the child a start was about to publish, and refuses later applies', async () => {
    const { tunnel, states } = build();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.state.hold = () => gate;
    const applying = tunnel.apply();
    // Wait until the child exists but has not been published: this is the exact window in which a
    // shutdown can land, and the handle it would replace must not survive it.
    while (fixture.state.handles.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const stopping = tunnel.stop();
    release();
    await Promise.all([applying, stopping]);
    expect(fixture.state.handles[0]!.stopped).toBe(true);
    expect(tunnel.report()).toMatchObject({ state: 'off', publicUrl: null });
    // A stop is final: a later apply from a settings write must not start a new child.
    await tunnel.apply();
    expect(fixture.state.starts).toHaveLength(1);
    expect(states.at(-1)).toBe('off');
  });
});
