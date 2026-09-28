import { z } from 'zod';
import { CAPABILITIES, MAX_APPROVED_ROOTS } from './types.js';

/**
 * The standalone daemon's own configuration verbs.
 *
 * A daemon owns a data directory and therefore owns that directory's `config.json`, but it has
 * no window: approved folders, read-only mode, tool permissions and the tunnel it publishes
 * through are otherwise only editable through the desktop UI. These verbs are the missing
 * non-UI path, and they are deliberately a *closed* set rather than a generic "write this
 * settings key" channel — a daemon must not become a way to rewrite appearance, continuation
 * prompts or another connector's identity over a socket.
 *
 * Every verb is answered by the running daemon over its authenticated control socket, so a
 * command can never write the config file behind the owner's back: the live host applies the
 * change through the same serialized `updateConfig` transaction the UI uses, and the change is
 * on disk before the receipt is returned.
 */

/** The same spelling rule the stored config enforces for a virtual root name. */
const rootName = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Root names are lowercase letters, digits, dot, dash, underscore');

/** The tunnel ids the app already validates elsewhere; repeated here so a typo fails at the socket. */
const tunnelId = z
  .string()
  .regex(/^tunnel_[0-9a-f]{32}$/, 'A tunnel id looks like tunnel_ followed by 32 hex characters')
  .or(z.literal(''));

export const daemonConfigRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  /**
   * Approves one folder. `path` is canonicalised and refused unless it is an existing directory
   * outside every already-approved root, exactly as the UI's folder picker does; `name` is an
   * optional explicit virtual name, and the folder's own basename is used when it is omitted.
   */
  z.object({ action: z.literal('add-root'), path: z.string().min(2).max(4096), name: rootName.optional() }).strict(),
  z.object({ action: z.literal('remove-root'), name: rootName }).strict(),
  z.object({ action: z.literal('read-only'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('file-access'), mode: z.enum(['approved-roots', 'all-files']) }).strict(),
  z.object({ action: z.literal('capability'), name: z.enum(CAPABILITIES), enabled: z.boolean() }).strict(),
  /**
   * Selects the tunnel this daemon publishes through.
   *
   * Only the two fields that decide *which* tunnel — never its credential, which travels on the
   * separate `daemon.secret` verb so it is not echoed back in a settings report. The Desktop and
   * Plugins tunnel ids are deliberately absent: this host serves neither surface.
   */
  z
    .object({
      action: z.literal('tunnel'),
      kind: z.enum(['openai', 'cloudflared', 'manual']),
      tunnelId: tunnelId.optional()
    })
    .strict(),
  /**
   * Retires the running transport and starts one from the current configuration.
   *
   * Not a settings change — it is the *recovery* verb, and it is here rather than as a bare
   * `daemon.reconnect` method because the answer a caller needs afterwards is the same settings
   * report (which carries the transport's state), and because a daemon that has no transport
   * authority must refuse it exactly as it refuses every other daemon verb.
   *
   * It exists because supervision inside the transport cannot fix one case: a client that is alive
   * and locally ready while its provider route has gone stale is *not* restarted by the supervisor,
   * and nothing in the daemon's own state has changed to trigger a reconciliation. Forcing one is
   * the only honest recovery.
   */
  z.object({ action: z.literal('reconnect') }).strict()
]);
export type DaemonConfigRequest = z.infer<typeof daemonConfigRequestSchema>;

/** A complete capability map, never a partial patch: a missing key would read as "off". */
const capabilities = z.record(z.enum(CAPABILITIES), z.boolean());

/**
 * What the daemon answers for `daemon.config`.
 *
 * Two capability maps rather than one, because they are different facts and a daemon is exactly
 * where they diverge. `capabilities` is what the stored configuration requests;
 * `effectiveCapabilities` is what this process will actually enforce right now, with read-only
 * mode applied and the Desktop group masked. Reporting only the requested map would show
 * `screen`/`control` as usable on a host that has no browser or native backend to serve them.
 */
export const daemonConfigReportSchema = z
  .object({
    roots: z.array(z.object({ name: rootName, path: z.string().min(1) })).max(MAX_APPROVED_ROOTS),
    readOnly: z.boolean(),
    fileAccessMode: z.enum(['approved-roots', 'all-files']),
    capabilities,
    effectiveCapabilities: capabilities,
    /** The tunnel this daemon was told to publish through, and whether it has a credential yet. */
    tunnel: z
      .object({
        kind: z.enum(['openai', 'cloudflared', 'manual']),
        tunnelId: z.string(),
        hasApiKey: z.boolean()
      })
      .strict()
  })
  .strict();
export type DaemonConfigReport = z.infer<typeof daemonConfigReportSchema>;

/**
 * The credentials a daemon may hold.
 *
 * A closed list for the same reason the configuration verbs are closed: `openaiApiKey` is the
 * only one a headless host needs to publish a tunnel, and the daemon deliberately cannot reach
 * the browser bridge token or a plugin's stored authorization.
 */
export const DAEMON_SECRET_KEYS = ['openaiApiKey'] as const;
export type DaemonSecretKey = (typeof DAEMON_SECRET_KEYS)[number];

export const daemonSecretRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  /** The value travels on the request and is never echoed back in any report. */
  z.object({ action: z.literal('set'), key: z.enum(DAEMON_SECRET_KEYS), value: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('clear'), key: z.enum(DAEMON_SECRET_KEYS) }).strict()
]);
export type DaemonSecretRequest = z.infer<typeof daemonSecretRequestSchema>;

/**
 * What `daemon.secret` answers.
 *
 * Presence only. `value` is never returned: a credential that can be read back over the control
 * socket is a credential that leaks through any process able to read the descriptor, and the
 * caller that set it already knows it.
 */
export const daemonSecretReportSchema = z
  .object({
    keys: z.array(
      z.object({ key: z.enum(DAEMON_SECRET_KEYS), present: z.boolean() }).strict()
    ),
    /** Whether this host can protect a credential at all, and why not when it cannot. */
    storage: z.object({ available: z.boolean(), detail: z.string().nullable() }).strict()
  })
  .strict();
export type DaemonSecretReport = z.infer<typeof daemonSecretReportSchema>;
