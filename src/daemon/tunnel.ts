import { getConfig } from '../main/config.js';
import { logInfo, logWarn } from '../main/logger.js';
import { getSecret } from '../main/secrets.js';
import { setupApiKeySlot } from '../shared/setup-profile.js';
import { startTunnel, TunnelError, type TunnelHandle, type TunnelReport } from '../main/tunnel/index.js';
import { tunnelProbeHeaders } from '../main/mcp/server.js';

/**
 * The daemon's one tunnel.
 *
 * A daemon has no window, so nothing about the transport can be "configured in Settings and
 * applied on the next connect": the daemon either publishes a tunnel now or it does not. This
 * owns exactly that decision, and it owns it as a *reconciliation* rather than a command, because
 * three things can change under it — the tunnel settings, the stored credential, and the local
 * endpoint the tunnel points at — and each of them has to leave the same invariant: a tunnel is
 * running exactly when the current configuration plus the current credential say it should be.
 *
 * What it deliberately reuses is the desktop's own transport: the same `startTunnel`, the same
 * per-surface secret path in the local URL, the same health/outage accounting, the same
 * supervision of the child process. A daemon that published through a second, daemon-specific
 * tunnel path would be a second thing to keep in step with `tunnel-client`'s behaviour, and the
 * desktop path is the one that is actually tested against the provider.
 *
 * Three rules are load-bearing, and each exists because the obvious cheaper version is wrong:
 *
 *   1. **The running transport has an identity, and an equal identity is left alone.** What is
 *      reconciled is not "is a handle present" but the *inputs* the handle was started from —
 *      kind, tunnel id, binary path, credential and local URL. A settings save that changed only
 *      the approved folders, or a credential write that stored the same key again, therefore does
 *      not drop a live connection; only a change that would produce a different transport
 *      restarts one.
 *   2. **A retired transport can never overwrite its successor.** `tunnel-client` reports on its
 *      own schedule, and a report from a handle that has already been stopped would otherwise
 *      republish `connected` over the new transport's state. Every start is stamped with a
 *      generation, and a report carrying a stale one is dropped.
 *   3. **The transport never blocks startup, and startup never leaks it.** `apply()` starts a
 *      tunnel in the background — the MCP endpoint and the control socket are what make the
 *      daemon usable, and a tunnel that takes a minute to reach the provider must not delay
 *      them — while `stop()` retires an in-flight child rather than leaving it behind.
 *
 * The one thing it does *not* do is invent a credential. Without one the tunnel is reported as
 * unconfigured and nothing is spawned, because a tunnel that failed silently would look like a
 * provider problem rather than a missing key.
 */
export interface DaemonTunnelState {
  /** What the daemon would do with the current configuration and credential. */
  state: 'off' | 'starting' | 'connected' | 'unavailable';
  detail: string;
  publicUrl: string | null;
  /** Epoch ms of the last proven round trip to the provider, when the transport knows one. */
  handshakeAt: number | null;
  /**
   * Whether a credential for the configured tunnel kind is stored.
   *
   * Reported as a fact about storage, not about the tunnel: a daemon with an id and no key is a
   * different problem from one whose key was refused by the provider, and the settings report has
   * to be able to say which one it is without reading the credential.
   */
  hasApiKey: boolean;
}

/**
 * The inputs one running tunnel was started from.
 *
 * Compared as a whole, and only ever in memory: a difference anywhere means the transport the
 * daemon *should* be running is not the one it is running, so the old child is retired and a new
 * one started. The credential participates because replacing a key with a different one is a
 * different transport; storing the same key again is not.
 */
interface RunningTransport {
  kind: string;
  tunnelId: string;
  binaryPath: string;
  apiKey: string | null;
  localUrl: string;
}

export class DaemonTunnel {
  private handle: TunnelHandle | null = null;
  /** What the live handle was started from, or null when nothing is running. */
  private running: RunningTransport | null = null;
  /**
   * Which transport generation owns the right to report.
   *
   * Bumped every time a handle is retired, so the closure `startTunnel` was given can tell whether
   * the state it is describing belongs to the transport that is still current. Without it, a
   * client that is slow to notice it was stopped would publish `connected` over its replacement.
   */
  private generation = 0;
  private localUrl: string | null = null;
  /** Serializes reconciliations: two overlapping applies would race on `handle`. */
  private queue: Promise<void> = Promise.resolve();
  private state: DaemonTunnelState = { state: 'off', detail: '', publicUrl: null, handshakeAt: null, hasApiKey: false };
  /** Whether a credential is stored for the configured kind. Owned by `reconcile`. */
  private hasApiKey = false;
  private stopped = false;

  constructor(private readonly onState: (state: DaemonTunnelState) => void) {}

  /** What the transport is doing right now, for `daemon.status`. */
  report(): DaemonTunnelState {
    return { ...this.state, hasApiKey: this.hasApiKey };
  }

  /** The loopback URL this daemon serves, including the Core surface's secret path. */
  setLocalUrl(url: string): void {
    this.localUrl = url;
  }

  /**
   * Brings the transport in line with the current configuration and credential.
   *
   * Called after startup, after any configuration change that can affect the transport, and after
   * a credential write. Idempotent: an already-correct tunnel is left running, so a settings save
   * that changed nothing about the transport does not drop a live connection.
   */
  apply(): Promise<void> {
    return this.enqueue(() => this.reconcile(false));
  }

  /**
   * Retires the running transport and starts one from the current configuration.
   *
   * This is the recovery path that a `connected`-looking tunnel with a dead provider route cannot
   * give itself: the supervision inside `startTunnel` restarts a client that died, but it will not
   * replace a live client whose *route* went stale, and nothing else about the daemon's own state
   * has changed. Forcing the reconciliation is exactly the operation that fixes it.
   */
  reconnect(): Promise<void> {
    return this.enqueue(() => this.reconcile(true));
  }

  /** Stops the tunnel and refuses later applies. Used by the daemon's own shutdown. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue.catch(() => undefined);
    await this.stopHandle();
    this.publish({ state: 'off', detail: '', publicUrl: null, handshakeAt: null });
  }

  /** Serializes one reconciliation behind the last, whatever the caller asked for. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Records one transport state.
   *
   * The credential fact is *not* part of what the transport reports — it is read from storage by
   * `reconcile` — so it is merged here rather than repeated at every call site. A publish can
   * therefore never claim a credential state the transport did not observe.
   */
  private publish(state: Omit<DaemonTunnelState, 'hasApiKey'>): void {
    this.state = { ...state, hasApiKey: this.hasApiKey };
    this.onState({ ...this.state });
  }

  private async stopHandle(): Promise<void> {
    const held = this.handle;
    this.handle = null;
    this.running = null;
    // The generation moves even when there was no handle: an in-flight start that has not published
    // its handle yet is retired by the same bump, because it captured the old generation.
    this.generation += 1;
    if (!held) return;
    await held.stop().catch((error: unknown) => {
      logWarn(`daemon tunnel stop failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * The single decision point.
   *
   * The desired transport is computed first, from the configuration and the credential as they are
   * *now*, and only then is the running tunnel compared against it. Reading both before touching
   * the handle is what makes a credential written while a start is in flight land correctly: the
   * next apply sees the new value rather than the one this attempt started with.
   */
  private async reconcile(force: boolean): Promise<void> {
    if (this.stopped) return;
    const config = getConfig();
    const settings = config.tunnel;
    const apiKey = await getSecret(setupApiKeySlot(settings.profileId));
    // Recorded before any branch, so a caller that asks why nothing is published is answered with
    // the storage fact rather than an inference from the tunnel's state.
    this.hasApiKey = apiKey !== null;
    const wantsTunnel = settings.kind !== 'manual' && (settings.kind === 'cloudflared' || settings.tunnelId !== '');
    const localUrl = this.localUrl;

    if (!localUrl) {
      // The endpoint is not up yet; startup applies again once it is. Nothing is published here,
      // because a tunnel to a URL that does not exist would be a lie with a healthy child process.
      await this.stopHandle();
      return;
    }
    if (!wantsTunnel) {
      await this.stopHandle();
      this.publish({
        state: 'off',
        detail:
          settings.kind === 'manual'
            ? 'This daemon is not publishing a tunnel; clients reach it on its loopback endpoint.'
            : 'No tunnel id is configured for this daemon. Set one with `wgpt daemon config tunnel openai <tunnel_id>`.',
        publicUrl: null,
        handshakeAt: null
      });
      return;
    }
    if (settings.kind === 'openai' && !apiKey) {
      await this.stopHandle();
      this.publish({
        state: 'unavailable',
        detail:
          'A tunnel id is configured but no tunnel API key is stored, so nothing can be published. ' +
          'Store one with `wgpt daemon secret set openaiApiKey`.',
        publicUrl: null,
        handshakeAt: null
      });
      return;
    }

    const desired: RunningTransport = {
      kind: settings.kind,
      tunnelId: settings.tunnelId,
      binaryPath: settings.binaryPath ?? '',
      apiKey,
      localUrl
    };
    // The whole point of the identity: an unchanged transport is left running, so a settings save
    // that could not affect it never drops a live connection.
    if (!force && this.running?.kind === desired.kind &&
        this.running.tunnelId === desired.tunnelId && this.running.binaryPath === desired.binaryPath &&
        this.running.apiKey === desired.apiKey && this.running.localUrl === desired.localUrl) return;

    await this.stopHandle();
    this.publish({
      state: 'starting',
      detail: force ? 'Reconnecting the tunnel…' : 'Starting the tunnel…',
      publicUrl: null,
      handshakeAt: null
    });
    const generation = this.generation;
    try {
      const handle = await startTunnel({
        localUrl,
        settings,
        apiKey,
        discoveryHeaders: tunnelProbeHeaders(),
        label: 'daemon',
        report: (report: TunnelReport) => this.onReport(generation, report)
      });
      // A stop that landed while the child was starting owns the outcome: the handle it would
      // have replaced must not be published, or the tunnel would outlive the daemon's shutdown.
      if (this.stopped || generation !== this.generation) {
        await handle.stop().catch(() => undefined);
        return;
      }
      this.handle = handle;
      this.running = desired;
      logInfo(`daemon tunnel started (${settings.kind})`);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof TunnelError ? error.message : error instanceof Error ? error.message : String(error);
      logWarn(`daemon tunnel failed: ${message}`);
      this.publish({ state: 'unavailable', detail: message, publicUrl: null, handshakeAt: null });
    }
  }

  private onReport(generation: number, report: TunnelReport): void {
    if (this.stopped || generation !== this.generation) return;
    // The transport's own vocabulary is mapped onto the daemon's four states, and the mapping is
    // deliberately pessimistic: only a proven `connected` is connected, and only the states that
    // mean "still coming up" are `starting`. Everything else — an offline control plane, a refused
    // credential, a dead child — is `unavailable`, because from a client's point of view those are
    // one condition: it cannot reach this daemon over the tunnel right now.
    const state: DaemonTunnelState['state'] =
      report.state === 'connected'
        ? 'connected'
        : report.state === 'starting-server' || report.state === 'connecting-tunnel' || report.state === 'disconnecting'
          ? 'starting'
          : 'unavailable';
    this.publish({
      state,
      detail: report.detail,
      publicUrl: report.publicUrl ?? this.state.publicUrl,
      handshakeAt: report.handshakeAt ?? this.state.handshakeAt
    });
  }
}
