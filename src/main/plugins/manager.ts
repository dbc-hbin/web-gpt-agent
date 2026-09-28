import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolSchema } from '@modelcontextprotocol/core';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type Tool, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { getMcpConfigForManifest, vAny } from '@anthropic-ai/mcpb/browser';
import { getSecret, setSecret, clearSecret } from '../secrets.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { setEnvValue } from '../env.js';
import { redactCredentialText } from '../redaction.js';
import type { PluginCatalogEntry, PluginConfigPatch, PluginInstallRequest, PluginSnapshot, PluginView } from '../../shared/plugins.js';
import { installSource, pluginEnvironment, resolveGithub, stopInstallers, type InstalledLaunch } from './installer.js';
import { terminateProcessTree } from '../exec.js';
import { pluginCatalog, reviewedPluginLicense } from './catalog.js';
import sharp from 'sharp';
import { pluginExposure } from './exposure.js';
import { externalSchemaHash } from './external-declaration.js';
import { PluginOAuth, PluginNeedsAuth, PluginOAuthSetupError, clearPluginOAuth } from './oauth.js';
export { PLUGIN_MAX_TOOLS, PLUGIN_MAX_SCHEMA_BYTES } from './exposure.js';

/**
 * Every reviewed recipe the user can install.
 *
 * Native Desktop is app-owned and never appears as an installable external server.
 */
export function installableCatalog(): PluginCatalogEntry[] {
  return [...pluginCatalog];
}

/** One bounded page of a server's tools; the catalog itself is retained on the record. */
/**
 * Everything a caller needs to make one unambiguous external call.
 *
 * `id` is the installation UUID, which is what makes two servers declaring the same raw tool
 * name distinguishable; a name is never treated as an installation identity.
 */
export interface ExternalInstallation {
  id: string;
  name: string;
  catalogId?: string;
  enabled: boolean;
  /** Only `ready` installations have a live connection to dispatch through. */
  status: PluginView['status'];
  gatewayOnly: boolean;
  /** Restart count for this installation's connection; changes on every reconnect. */
  generation: number;
  /**
   * Declared names the caller may actually call: the retained catalog with per-tool policy applied.
   *
   * The full catalog stays on the manager's own records (`retainedToolNames`), because the Plugins
   * surface and its settings need every declaration including the switched-off ones. This
   * projection is the gateway's view of it: listing a name here is a promise that `mcp_call` will
   * admit it, and `disabledToolNames` carries the rest so a refusal can name the switch instead of
   * claiming the server never declared the tool.
   */
  toolNames: string[];
  /** Declared names the user turned off; retained and shown by Plugins, never callable. */
  disabledToolNames: string[];
}

/**
 * What admission discovery granted a caller for one external call.
 *
 * The gateway re-checks its own view before dispatch, but that view was read before the
 * installation's serial queue: a queued update, restart, disable or discovery refresh can replace
 * the declaration, the connection or the policy in between. Passing the expectation into dispatch
 * is what lets the manager refuse such a call instead of translating it onto whatever now exists.
 */
export interface ExternalCallExpectation {
  /** The declaration hash the caller read from `mcp_tools` and shaped its arguments for. */
  schemaHash: string;
  /** The transport generation the caller read that declaration on. */
  generation: number;
}

/** One validated external argument set, or the reason it cannot be dispatched. */
export type ExternalValidation = { ok: true } | { ok: false; detail: string };

/**
 * An external call that provably never reached the server.
 *
 * The distinction is the whole reason this type exists: a refusal raised before dispatch is a
 * completed, known-absent outcome, while a transport failure after dispatch may have produced the
 * effect anyway. The gateway must report those differently, and it can only do that if the
 * manager says which one happened instead of throwing one undifferentiated error.
 */
export class ExternalNotDispatched extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalNotDispatched';
  }
}

interface RecordEntry extends Omit<PluginView, 'tools'> {
  /** Validated discovery belongs to the installation, not a replaceable connection. */
  catalog: Tool[];
  directory: string;
  launch: InstalledLaunch;
  disabledTools: string[];
  /** Incremented on every successful connection; a reconnect mints new transport state. */
  generation: number;
}
interface Live {
  client: Client;
  tools: Tool[];
  transport?: StdioClientTransport;
  users: number;
  oauth?: PluginOAuth;
  /**
   * The transport generation this connection minted.
   *
   * The driver's own contract makes a reconnect a new transport: element tokens, snapshot ids and
   * screenshot frames from before it are unusable. Exposing the generation lets the gateway tell
   * "the proxy reconnected during my call" from "the connection I observed on is still the one
   * that answered", so it can require a fresh observation instead of translating an old target.
   */
  generation: number;
}
/**
 * One admitted dispatch, a pre-dispatch refusal, or "no connection was ever established".
 *
 * The refusal is a value rather than a throw so it can be produced inside the installation's
 * serial queue and reported by the one path that owns pre-dispatch refusals — every case here is
 * provably not dispatched, which the gateway reports differently from a lost call.
 */
type ExternalAcquisition = { live: Live; tool: Tool } | { refusal: string } | undefined;
/**
 * The SDK's own AJV provider, so an external server's published JSON Schema is the validation
 * authority here exactly as it is on the wire. One instance: schema compilation is cached inside
 * it, and compiling the same declaration per call would be pure waste.
 *
 * The provider's own schema type comes from its bundled `json-schema-typed` copy, which is not a
 * package this app depends on. The contract consumed here is declared structurally instead, so
 * the SDK stays the validator without leaking an internal type into this module.
 */
interface ExternalSchemaValidator {
  (input: unknown): { valid: boolean; errorMessage?: string };
}
interface ExternalValidatorProvider {
  getValidator(schema: Tool['inputSchema']): ExternalSchemaValidator;
}
const externalValidator = new AjvJsonSchemaValidator() as unknown as ExternalValidatorProvider;

const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'error' });
  if (!response.body) return response;
  let size = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > 16 * 1024 * 1024) throw new Error('Plugin HTTP response exceeds 16 MiB');
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/** Installation policy owns connections; lifecycle mutations serialize per installation. */
export class PluginManager {
  constructor(private openAuthorization: (url: URL) => Promise<void> = async url => {
    const { shell } = await import('electron'); await shell.openExternal(url.href);
  }) {}
  private root = '';
  private records: RecordEntry[] = [];
  private live = new Map<string, Live>();
  private listeners = new Set<() => void>();
  private queues = new Map<string, Promise<unknown>>();
  private starting = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private secretValues = new Set<string>();
  private revision = 0;
  private exposureCache: ReturnType<typeof pluginExposure> | null = null;
  private closing = false;
  private connecting = new Map<Client, StdioClientTransport | undefined>();
  private authenticating = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    this.exposureCache = null;
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(fn);
    const settled = next.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.finally(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return next;
  }
  private async save(): Promise<void> {
    // Catalog/configuration mutations are observable while their durable write awaits.
    this.exposureCache = null;
    await writeDurableNow('plugins', this.records);
  }
  async initialize(userDataDir: string): Promise<void> {
    this.root = path.join(userDataDir, 'plugins');
    this.closing = false;
    await fs.mkdir(this.root, { recursive: true });
    const stored = await readDurable<RecordEntry[]>('plugins');
    this.records = Array.isArray(stored) && stored.length <= 24
      ? stored.filter(p => this.validRecord(p) && p.catalogId !== 'cua-driver').map(p => {
        const { tools: _legacyTools, ...record } = p as RecordEntry & { tools?: unknown };
        const catalog = this.validCatalog(record.catalog);
        return { ...record, catalog, generation: record.generation ?? 0, status: record.enabled ? 'connecting' : 'disabled' };
      })
      : [];
    if (Array.isArray(stored) && stored.some(p => p?.catalogId === 'cua-driver')) await this.save();
    this.changed();
    // Installation + enabled policy owns the runtime. Restore connections in the
    // background so slow external servers never delay the app's first window.
    void Promise.all(this.records.filter(row => row.enabled).map(row => this.connect(row))).catch(() => undefined);
  }
  private exposure() {
    return this.exposureCache ??= pluginExposure(this.records.map(row => ({
      id: row.id, name: row.name, enabled: row.enabled && !['error', 'needs-auth', 'authenticating'].includes(row.status) && (row.source.auth !== 'oauth' || this.live.has(row.id)),
      tools: row.catalog, disabledTools: row.disabledTools,
      gatewayOnly: this.gatewayOnly(row),
    })));
  }
  /** A recipe marked `gatewayOnly` publishes no raw tools on the Plugins connector. */
  private gatewayOnly(row: RecordEntry): boolean {
    return installableCatalog().find(recipe => recipe.id === row.catalogId)?.gatewayOnly === true;
  }
  snapshot(): PluginSnapshot {
    const exposure = this.exposure();
    return structuredClone({
      catalog: installableCatalog(),
      schemaRevision: this.revision,
      plugins: this.records.map(({ directory: _, launch: __, disabledTools, catalog, generation: ___, ...row }) => ({
        ...row,
        license: reviewedPluginLicense({ ...row.source, version: row.version }, row.license),
        tools: catalog.map(tool => ({
          name: tool.name, exposedName: tool.name, description: tool.description,
          enabled: !disabledTools.includes(tool.name),
          published: exposure.owners.get(tool.name) === row.id,
          ...(exposure.issues.get(row.id)?.get(tool.name) ? { exposureError: exposure.issues.get(row.id)!.get(tool.name) } : {}),
        })),
      })),
    });
  }
  private validCatalog(value: unknown): Tool[] {
    try {
      if (!Array.isArray(value) || value.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 1000000) return [];
      const tools = value.map(tool => ToolSchema.parse(tool));
      return new Set(tools.map(tool => tool.name)).size === tools.length ? tools : [];
    } catch { return []; }
  }
  redact(value: unknown): unknown {
    if (typeof value === 'string') {
      let out = redactCredentialText(value);
      for (const secret of this.secretValues) if (secret) out = out.split(secret).join('[redacted]');
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redact(v)]));
    return value;
  }
  /** Redact authored values without rewriting protocol tags or opaque binary encodings. */
  redactResult(result: CallToolResult): CallToolResult {
    return {
      ...result,
      ...(result.structuredContent === undefined ? {} : { structuredContent: this.redact(result.structuredContent) as Record<string, unknown> }),
      ...(result._meta === undefined ? {} : { _meta: this.redact(result._meta) as Record<string, unknown> }),
      content: result.content.map((block) => {
        const metadata = '_meta' in block ? { _meta: this.redact(block._meta) as Record<string, unknown> } : {};
        if (block.type === 'text') return { ...block, ...metadata, text: String(this.redact(block.text)) };
        if (block.type === 'resource') return {
          ...block, ...metadata,
          resource: {
            ...block.resource,
            ...('_meta' in block.resource ? { _meta: this.redact(block.resource._meta) as Record<string, unknown> } : {}),
            uri: String(this.redact(block.resource.uri)),
            ...('text' in block.resource ? { text: String(this.redact(block.resource.text)) } : {}),
          },
        };
        if (block.type === 'resource_link') return {
          ...block, ...metadata, name: String(this.redact(block.name)), uri: String(this.redact(block.uri)),
          ...(block.title === undefined ? {} : { title: String(this.redact(block.title)) }),
          ...(block.description === undefined ? {} : { description: String(this.redact(block.description)) }),
        };
        return { ...block, ...metadata };
      }),
    };
  }
  private row(id: string): RecordEntry {
    const p = this.records.find((p) => p.id === id);
    if (!p) throw new Error('Plugin not found');
    return p;
  }
  private validRecord(p: RecordEntry): boolean {
    try {
      if (
        !p ||
        typeof p.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(p.id) ||
        typeof p.name !== 'string' ||
        typeof p.directory !== 'string' ||
        typeof p.enabled !== 'boolean' ||
        !p.source ||
        (p.source.auth !== undefined && (p.source.auth !== 'oauth' || p.source.kind !== 'remote')) ||
        !['command', 'npm', 'python', 'mcpb', 'remote'].includes(p.source.kind) ||
        !p.launch ||
        typeof p.launch.command !== 'string' ||
        !Array.isArray(p.launch.args) ||
        p.launch.args.some((a) => typeof a !== 'string') ||
        !Array.isArray(p.disabledTools) ||
        p.disabledTools.some((t) => typeof t !== 'string') ||
        !Array.isArray(p.credentialKeys) ||
        p.credentialKeys.some((k) => typeof k !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(k))
      )
        return false;
      if (!path.resolve(p.directory).startsWith(path.resolve(this.root, p.id) + path.sep)) return false;
      this.validateConfig(p.config);
      if (p.launch.manifest) vAny.McpbManifestSchema.parse(p.launch.manifest);
      return true;
    } catch {
      return false;
    }
  }
  private async credentials(row: RecordEntry): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const key of row.credentialKeys) {
      const value = await getSecret(`plugin:${row.id}:${key}`);
      if (value) {
        result[key] = value;
        this.secretValues.add(value);
      }
    }
    return result;
  }
  private async storeCredentials(row: RecordEntry, values: Record<string, string> = {}): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(key) || typeof value !== 'string' || value.length > 16384)
        throw new Error('Invalid credential field');
      await setSecret(`plugin:${row.id}:${key}`, value);
      if (value) {
        this.secretValues.add(value);
        if (!row.credentialKeys.includes(key)) row.credentialKeys.push(key);
      } else row.credentialKeys = row.credentialKeys.filter((k) => k !== key);
    }
  }
  private validateConfig(config: Record<string, string>): void {
    if (
      Object.keys(config).length > 100 ||
      Object.entries(config).some(
        ([k, v]) => !/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(k) || typeof v !== 'string' || v.length > 8192,
      )
    )
      throw new Error('Invalid plugin configuration');
    if (Object.keys(config).some((k) => /token|password|secret|api.?key|authorization/i.test(k)))
      throw new Error('Put credentials in secure credential fields, not configuration');
  }
  /**
   * The preset's launch is the installed application plus an explicit daemon socket.
   *
   * No installation step runs: the user owns that application, and downloading, updating or
   * replacing it is explicitly out of scope. The version/license reported are the user's own
   * installation terms, not a reviewed pinned distribution.
   */
  private installationMetadata(launch: InstalledLaunch, catalogId?: string): Pick<PluginView, 'fields' | 'homepage'> {
    if (!launch.manifest) {
      const catalog = installableCatalog().find((p) => p.id === catalogId);
      return { fields: catalog?.fields, homepage: catalog?.homepage };
    }
    const manifest = vAny.McpbManifestSchema.parse(launch.manifest);
    return {
      homepage: manifest.homepage,
      fields: Object.entries(manifest.user_config ?? {}).map(([key, field]) => ({
        key, label: field.title, secret: field.sensitive, required: field.required, placeholder: field.description,
      })),
    };
  }
  private async createGeneration(id: string): Promise<string> {
    const parent = path.join(this.root, id);
    await fs.mkdir(parent, { recursive: true });
    // The plugin UUID owns identity; a generation only needs an exclusively created
    // directory. Another UUID consumes 28 avoidable characters of Windows MAX_PATH.
    return fs.mkdtemp(path.join(parent, 'g-'));
  }
  install(request: PluginInstallRequest): Promise<PluginSnapshot> {
    return this.serial('install', async () => {
      if (this.closing) throw new Error('Plugins are shutting down');
      if (this.records.length >= 24) throw new Error('At most 24 plugins may be installed');
      const catalog = installableCatalog().find((p) => p.id === request.catalogId);
      let source = structuredClone(request.source ?? catalog?.source);
      if (!source) throw new Error('Choose an integration or installation source');
      if (source.auth && source.kind !== 'remote') throw new Error('OAuth requires a remote source.');
      if (source.kind === 'github') source = resolveGithub(source);
      if (source.kind === 'remote') this.remoteUrl(source.url);
      const config = request.config ?? {};
      this.validateConfig(config);
      const id = randomUUID(),
        directory = await this.createGeneration(id);
      let row: RecordEntry | undefined;
      try {
        const launch = await installSource(source, directory);
        if (this.closing) throw new Error('Plugin installation cancelled by shutdown');
        row = {
          id,
          name: (request.name ?? catalog?.name ?? source.package ?? 'Custom MCP').slice(0, 100),
          catalogId: catalog?.id,
          source,
          config,
          credentialKeys: [],
          version: launch.version,
          license: launch.license,
          homepage: catalog?.homepage,
          enabled: true,
          status: 'installed',
          catalog: [],
          installedAt: Date.now(),
          directory,
          launch,
          disabledTools: [],
          generation: 0,
          ...this.installationMetadata(launch, catalog?.id),
        };
        if (launch.manifest) {
          const manifest = vAny.McpbManifestSchema.parse(launch.manifest);
          row.name = manifest.display_name ?? manifest.name;
        }
        if (row.fields?.some((f) => f.secret && f.key in row!.config))
          throw new Error('Store sensitive bundle fields in secure credentials');
        await this.storeCredentials(row, request.credentials);
        this.records.push(row);
        try {
          await this.save();
        } catch (e) {
          this.records = this.records.filter((p) => p !== row);
          this.exposureCache = null;
          throw e;
        }
        await this.connect(row);
        this.changed();
        return this.snapshot();
      } catch (e) {
        if (!row || !this.records.includes(row)) {
          await fs.rm(directory, { recursive: true, force: true });
          for (const key of row?.credentialKeys ?? []) await clearSecret(`plugin:${id}:${key}`);
        }
        throw new Error(String(this.redact((e as Error).message)));
      }
    });
  }
  configure(id: string, patch: PluginConfigPatch): Promise<PluginSnapshot> {
    this.authenticating.get(id)?.controller.abort();
    return this.serial(id, async () => {
      const row = this.row(id);
      this.validateConfig(patch.config ?? row.config);
      if (row.fields?.some((f) => f.secret && f.key in (patch.config ?? row.config)))
        throw new Error('Store sensitive bundle fields in secure credentials');
      const oldKeys = [...row.credentialKeys],
        oldConfig = row.config,
        oldName = row.name;
      const oldSecrets = await this.credentials(row);
      try {
        await this.storeCredentials(row, patch.credentials);
        if (patch.source) {
          await this.replace(row, patch.source, patch.config ?? row.config);
        } else {
          await this.disconnect(row);
          row.config = patch.config ?? row.config;
          if (patch.name) row.name = patch.name.slice(0, 100);
          await this.save();
          if (row.enabled) await this.connect(row);
        }
      } catch (e) {
        for (const key of new Set([...Object.keys(patch.credentials ?? {}), ...oldKeys]))
          await setSecret(`plugin:${id}:${key}`, oldSecrets[key] ?? '');
        row.credentialKeys = oldKeys;
        row.config = oldConfig;
        row.name = oldName;
        await this.disconnect(row);
        if (row.enabled) await this.connect(row);
        throw e;
      }
      this.changed();
      return this.snapshot();
    });
  }
  restart(id: string): Promise<PluginSnapshot> {
    this.authenticating.get(id)?.controller.abort();
    return this.serial(id, async () => {
      const row = this.row(id);
      await this.disconnect(row);
      if (row.enabled) await this.connect(row);
      this.changed();
      return this.snapshot();
    });
  }
  update(id: string): Promise<PluginSnapshot> {
    this.authenticating.get(id)?.controller.abort();
    return this.serial(id, async () => {
      const row = this.row(id);
      const catalog = installableCatalog().find((p) => p.id === row.catalogId);
      await this.replace(row, catalog?.source ?? row.source, row.config);
      this.changed();
      return this.snapshot();
    });
  }
  private async replace(
    row: RecordEntry,
    source: RecordEntry['source'],
    config: Record<string, string>,
  ): Promise<void> {
    if (this.closing) throw new Error('Plugins are shutting down');
    if (source.auth && source.kind !== 'remote') throw new Error('OAuth requires a remote source.');
    if (source.kind === 'github') source = resolveGithub(source);
    if (source.kind === 'remote') this.remoteUrl(source.url);
    const directory = await this.createGeneration(row.id);
    const old = { ...row };
    try {
      const launch = await installSource(source, directory);
      if (this.closing) throw new Error('Plugin update cancelled by shutdown');
      const catalogId = installableCatalog().find((p) => p.id === row.catalogId && JSON.stringify(p.source) === JSON.stringify(source))?.id;
      const metadata = this.installationMetadata(launch, catalogId);
      if (metadata.fields?.some((f) => f.secret && f.key in config))
        throw new Error('Store sensitive bundle fields in secure credentials');
      await this.disconnect(row);
      Object.assign(row, { source, directory, launch, version: launch.version, license: launch.license, config, catalogId, ...metadata });
      if (row.enabled) {
        await this.connect(row);
        if (row.status !== 'ready' && row.status !== 'needs-auth') throw new Error(row.error ?? 'New server did not become ready');
      }
      await this.save();
    } catch (e) {
      await this.disconnect(row);
      // Installation rollback must not undo a newer user policy request.
      Object.assign(row, old, { enabled: row.enabled, disabledTools: row.disabledTools });
      this.exposureCache = null;
      await fs.rm(directory, { recursive: true, force: true });
      if (row.enabled) await this.connect(row);
      throw new Error(`Update rolled back: ${String(this.redact((e as Error).message))}`);
    }
    // Cleanup after the commit is best-effort: an old-directory deletion failure must never undo durable publication.
    await fs.rm(old.directory, { recursive: true, force: true }).catch(() => undefined);
  }
  setEnabled(id: string, enabled: boolean): Promise<PluginSnapshot> {
    const row = this.row(id);
    // The record is the live policy authority, including while lifecycle work is queued.
    row.enabled = enabled;
    // Revocation retires the current identity now, even while an update downloads
    // a replacement. The queued transaction awaits this same retirement promise.
    const retirement = enabled ? Promise.resolve() : this.disconnect(row);
    void retirement.catch(() => undefined);
    this.changed();
    return this.serial(id, async () => {
      await retirement;
      await this.disconnect(row);
      await this.save();
      if (row.enabled && this.records.includes(row)) await this.connect(row);
      this.changed();
      return this.snapshot();
    });
  }
  setToolEnabled(id: string, name: string, enabled: boolean): Promise<PluginSnapshot> {
    const row = this.row(id);
    if (!row.catalog.some((t) => t.name === name)) throw new Error('Tool not found');
    row.disabledTools = row.disabledTools.filter((n) => n !== name);
    if (!enabled) row.disabledTools.push(name);
    this.changed();
    return this.serial(id, async () => {
      await this.save();
      this.changed();
      return this.snapshot();
    });
  }
  uninstall(id: string): Promise<PluginSnapshot> {
    const row = this.row(id);
    row.enabled = false;
    const retirement = this.disconnect(row);
    void retirement.catch(() => undefined);
    this.records = this.records.filter((p) => p !== row);
    this.changed();
    return this.serial(id, async () => {
      await retirement;
      await this.disconnect(row);
      try {
        await this.save();
      } catch (e) {
        this.records.push(row);
        this.exposureCache = null;
        throw e;
      }
      for (const key of row.credentialKeys) await clearSecret(`plugin:${id}:${key}`);
      await clearPluginOAuth(id);
      await fs.rm(path.join(this.root, id), { recursive: true, force: true });
      this.changed();
      return this.snapshot();
    });
  }
  private async disconnect(row: RecordEntry): Promise<void> {
    this.authenticating.get(row.id)?.controller.abort();
    this.starting.get(row.id)?.controller.abort();
    const live = this.live.get(row.id);
    this.live.delete(row.id);
    row.status = !row.enabled ? 'disabled' : ['error', 'needs-auth'].includes(row.status) ? row.status : 'installed';
    // Revocation happens before process/transport retirement can yield.
    this.exposureCache = null;
    if (live) {
      live.oauth?.dispose();
      if (live.transport?.pid) await terminateProcessTree(live.transport.pid, true);
      await live.client.close().catch(() => undefined);
    }
  }
  /** Explicit UI action, returning immediately; no other lifecycle path opens a browser. */
  async authenticate(id: string): Promise<PluginSnapshot> {
    const row = this.row(id);
    if (this.closing || !row.enabled || row.source.kind !== 'remote' || row.source.auth !== 'oauth') throw new Error('Enable an OAuth remote plugin before signing in.');
    if (this.authenticating.has(id)) return this.snapshot();
    const endpoint = this.remoteUrl(row.source.url);
    const retirement = this.disconnect(row);
    const operation = { controller: new AbortController(), promise: Promise.resolve() };
    this.authenticating.set(id, operation);
    row.status = 'authenticating'; row.error = undefined; this.changed();
    operation.promise = this.serial(id, async () => {
      let provider: PluginOAuth | undefined;
      try {
        await retirement; operation.controller.signal.throwIfAborted();
        if (this.closing || !row.enabled || !this.records.includes(row)) return;
        row.status = 'authenticating'; this.changed();
        provider = await PluginOAuth.load(id, endpoint, operation.controller.signal, boundedFetch, value => this.secretValues.add(value));
        await provider.signIn(this.openAuthorization);
        operation.controller.signal.throwIfAborted();
        if (this.authenticating.get(id) !== operation || !row.enabled || this.closing) return;
        this.authenticating.delete(id);
        provider.dispose();
        await this.connect(row);
      } catch (error) {
        if (this.authenticating.get(id) === operation && row.enabled && this.records.includes(row)) {
          row.status = error instanceof PluginOAuthSetupError ? 'error' : 'needs-auth';
          row.error = operation.controller.signal.aborted ? undefined : error instanceof PluginOAuthSetupError ? error.message : 'Sign-in was not completed. Check the service setup and try Sign in again.';
        }
      } finally {
        provider?.dispose();
        if (this.authenticating.get(id) === operation) this.authenticating.delete(id);
        this.changed();
      }
    });
    void operation.promise.catch(() => undefined);
    return this.snapshot();
  }
  async cancelAuthentication(id: string): Promise<PluginSnapshot> {
    const row = this.row(id);
    this.authenticating.get(id)?.controller.abort();
    this.authenticating.delete(id);
    if (row.status === 'authenticating') { row.status = row.enabled ? 'needs-auth' : 'disabled'; row.error = undefined; this.changed(); }
    return this.snapshot();
  }
  private remoteUrl(value: string | undefined): URL {
    const url = new URL(value ?? '');
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    )
      throw new Error(
        'Use HTTPS (or loopback HTTP), without URL credentials or query tokens; put tokens in credentials',
      );
    return url;
  }
  private async discover(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const deadline = Date.now() + 20000;
    let pages = 0;
    do {
      if (++pages > 16 || Date.now() >= deadline) throw new Error('Server discovery exceeded its page/time limit');
      // Read one protocol page so limits apply before another page is requested.
      // SDK listTools() without a cursor aggregates every page before returning.
      const page = await client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, { timeout: Math.max(1, Math.min(15000, deadline - Date.now())) });
      tools.push(...page.tools);
      if (tools.length > 256 || Buffer.byteLength(JSON.stringify(tools)) > 1000000)
        throw new Error('Server discovery exceeds 256 tools or 1 MB; configure a smaller server toolset');
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Server returned a repeated tool cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (new Set(tools.map((t) => t.name)).size !== tools.length)
      throw new Error('Server declares duplicate tool names');
    if (!tools.length) throw new Error('Server connected but discovered no tools');
    return tools;
  }
  private publishTools(row: RecordEntry, tools: Tool[]): void {
    row.catalog = tools;
    row.status = 'ready';
    this.exposureCache = null;
  }
  /**
   * Publishes a connection's tools and its new transport generation together.
   *
   * A reconnect is a new transport, so this is the single point where the generation advances;
   * the gateway reads the same field before and after a call to detect a mid-call reconnect.
   */
  private publishConnection(row: RecordEntry, live: Live): void {
    row.generation = live.generation;
    this.publishTools(row, live.tools);
  }
  private release(row: RecordEntry, live: Live): void {
    live.users--;
    if (this.live.get(row.id) !== live || live.users !== 0) return;
    if (row.status === 'error' || row.status === 'needs-auth') {
      void this.serial(row.id, async () => {
        if (this.live.get(row.id) === live && live.users === 0) await this.disconnect(row);
      });
      return;
    }
  }
  private connect(row: RecordEntry): Promise<void> {
    const pending = this.starting.get(row.id);
    if (pending && !pending.controller.signal.aborted) return pending.promise;
    const controller = new AbortController();
    const cancelled = new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    const operation = { controller, promise: Promise.resolve() };
    operation.promise = Promise.race([this.startConnection(row, controller.signal), cancelled]).finally(() => {
      if (this.starting.get(row.id) === operation) this.starting.delete(row.id);
    });
    this.starting.set(row.id, operation);
    return operation.promise;
  }
  private async startConnection(row: RecordEntry, signal: AbortSignal): Promise<void> {
    if (this.closing || !row.enabled) return;
    row.status = 'connecting';
    row.error = undefined;
    this.changed();
    const client = new Client({ name: 'Web GPT Agent Plugins', version: '1.0.0' });
    let transport: StdioClientTransport | undefined;
    let oauth: PluginOAuth | undefined;
    const retire = () => {
      void (async () => {
        if (transport?.pid) await terminateProcessTree(transport.pid, true);
        await client.close().catch(() => undefined);
      })().catch(() => undefined);
    };
    signal.addEventListener('abort', retire, { once: true });
    this.connecting.set(client, undefined);
    try {
      const secrets = await this.credentials(row);
      signal.throwIfAborted();
      if (this.closing || !row.enabled || !this.records.includes(row)) return;
      if (row.source.kind === 'remote') {
        const url = this.remoteUrl(row.source.url);
        if (row.source.auth === 'oauth') {
          if (row.credentialKeys.length) throw new Error('OAuth plugins use Sign in instead of static credential headers.');
          oauth = await PluginOAuth.load(row.id, url, signal, boundedFetch, value => this.secretValues.add(value));
          if (!oauth.tokens()) throw new PluginNeedsAuth();
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(secrets))
          headers[k === 'token' ? 'Authorization' : k] = k === 'token' ? `Bearer ${v}` : v;
        await client.connect(
          new StreamableHTTPClientTransport(url, {
            fetch: oauth?.fetch ?? boundedFetch,
            ...(oauth ? { authProvider: oauth } : {}),
            requestInit: { headers },
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          }),
          { timeout: 20000 },
        );
      } else {
        let launch = { command: row.launch.command, args: row.launch.args, env: {} as Record<string, string> };
        if (row.launch.manifest) {
          const manifest = vAny.McpbManifestSchema.parse(row.launch.manifest);
          const missing = Object.entries(manifest.user_config ?? {})
            .filter(
              ([key, field]) => field.required && !(row.config[key] ?? secrets[key]) && field.default === undefined,
            )
            .map(([key]) => key);
          if (missing.length) throw new Error(`Configure required bundle fields: ${missing.join(', ')}`);
          const cfg = await getMcpConfigForManifest({
            manifest,
            extensionPath: row.directory,
            systemDirs: {},
            userConfig: { ...row.config, ...secrets },
            pathSeparator: path.sep,
            logger: { log: () => {}, warn: () => {}, error: () => {} },
          });
          if (!cfg?.command) throw new Error('MCPB requires unsupported configuration/runtime setup');
          launch = { command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} };
          if (JSON.stringify(launch).includes('${'))
            throw new Error('MCPB configuration is incomplete; provide its required fields');
          // MCPB recipes also permit ordinary relative entry points. Resolve packaged assets
          // against the bundle before switching cwd to the stable per-plugin data directory.
          const packagedPath = async (value: string): Promise<string> => {
            if (path.isAbsolute(value) || value.startsWith('-')) return value;
            const candidate = path.resolve(row.directory, value);
            if (!candidate.startsWith(path.resolve(row.directory) + path.sep)) return value;
            try {
              await fs.access(candidate);
              return candidate;
            } catch {
              return value;
            }
          };
          launch.args = await Promise.all(launch.args.map(packagedPath));
          if (manifest.server.type === 'binary') launch.command = await packagedPath(launch.command);
        }
        const env = pluginEnvironment();
        // Use the upstream response policy, not markdown surgery after execution. Apply at
        // launch so existing official installations also stop echoing submitted/generated code.
        // Explicit user configuration/CLI options retain their normal precedence.
        if (row.source.kind === 'npm' && row.source.package === '@playwright/mcp')
          setEnvValue(env, 'PLAYWRIGHT_MCP_CODEGEN', 'none');
        for (const [k, v] of Object.entries({ ...row.config, ...secrets })) setEnvValue(env, k, v);
        const data = path.join(this.root, row.id, 'data');
        await fs.mkdir(data, { recursive: true });
        if (row.catalogId === 'memory') setEnvValue(env, 'MEMORY_FILE_PATH', path.join(data, 'memory.json'));
        // A generation directory contains immutable installed code. Servers write relative user data
        // into a stable cwd so replacing the installation cannot erase that data.
        signal.throwIfAborted();
        if (this.closing || !row.enabled || !this.records.includes(row)) return;
        transport = new StdioClientTransport({
          command: launch.command,
          args: launch.args,
          cwd: data,
          env,
          stderr: 'ignore',
          maxBufferSize: 16 * 1024 * 1024,
        });
        this.connecting.set(client, transport);
        await client.connect(transport, { timeout: 20000 });
      }
      const discovered = await this.discover(client);
      const tools = discovered;
      signal.throwIfAborted();
      if (row.catalogId === 'blender') {
        const probe = tools.find((t) => t.name === 'get_scene_info');
        if (!probe) throw new Error('Blender scene probe is unavailable');
        // The pinned Blender server requires user_prompt even for a read-only scene
        // probe. Empty arguments fail schema validation before contacting the addon.
        const result = await client.callTool({ name: probe.name, arguments: {
          user_prompt: 'Read-only connection check: inspect the current Blender scene without changing it.',
        } }, { timeout: 15000, toolDefinition: probe });
        if (result.isError || result.content.some((block) => block.type === 'text' &&
          /^(?:error\b|could not connect\b|connection refused\b)/i.test(block.text.trim())))
          throw new Error('Open Blender, enable its MCP addon, and click Start MCP Server in Blender. Then restart this plugin.');
      }
      if (signal.aborted || this.closing || !row.enabled) {
        if (transport?.pid) await terminateProcessTree(transport.pid, true);
        await client.close();
        return;
      }
      const live: Live = { client, tools, transport, users: 0, oauth, generation: row.generation + 1 };
      this.live.set(row.id, live);
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        // A current connection can invalidate its own listing, never resurrect a retired one.
        if (this.live.get(row.id) !== live || row.status === 'connecting') return;
        row.status = 'connecting';
        this.changed();
        void this.serial(row.id, async () => {
          if (this.live.get(row.id) !== live || !row.enabled) return;
          try {
            const refreshed = await this.discover(client);
            if (this.live.get(row.id) !== live) return;
            live.tools = refreshed;
            this.publishTools(row, refreshed);
            await this.save();
          } catch {
            if (this.live.get(row.id) !== live) return;
            if (live.users === 0) await this.disconnect(row);
            row.status = 'error';
            row.error = 'Tool discovery changed and could not be refreshed. Restart this plugin.';
          }
          this.changed();
        });
      });
      client.onclose = () => {
        oauth?.dispose();
        if (this.live.get(row.id) === live) {
          this.live.delete(row.id);
          row.status = 'error';
          row.error = 'Server disconnected. Restart it after checking its application and credentials.';
          this.changed();
        }
      };
      client.onerror = () => {
        /* Transport errors are deliberately not logged: they may contain headers or credentials. */
      };
      this.publishConnection(row, live);
      await this.save();
    } catch (e) {
      oauth?.dispose();
      if (this.live.get(row.id)?.client === client) this.live.delete(row.id);
      this.exposureCache = null;
      if (transport?.pid) await terminateProcessTree(transport.pid, true);
      await client.close().catch(() => undefined);
      if (!signal.aborted) {
        const needsAuth = e instanceof PluginNeedsAuth || e instanceof UnauthorizedError;
        row.status = needsAuth ? 'needs-auth' : 'error';
        row.error = row.source.auth === 'oauth' ? needsAuth ? 'Sign in to connect this plugin.' : 'The OAuth server could not connect. Check its setup and try again.' : String(this.redact((e as Error).message)).slice(0, 600);
      }
    } finally {
      signal.removeEventListener('abort', retire);
      this.connecting.delete(client);
    }
    this.changed();
  }
  tools(): Tool[] { return [...this.exposure().tools]; }
  /**
   * The configured installations, for the Core gateway's identity listing.
   *
   * Every installation is included — enabled or not — because a caller needs to be able to tell
   * "disabled" from "does not exist" without guessing, and the gateway refuses each case with its
   * own code. Names come from the retained catalog, so a listing never connects, reconnects or
   * authenticates anything; the names the user switched off are reported alongside it, so a
   * refusal can name that switch instead of claiming the server never declared the tool.
   */
  externalInstallations(): ExternalInstallation[] {
    return this.records.map(row => ({
      id: row.id,
      name: row.name,
      ...(row.catalogId ? { catalogId: row.catalogId } : {}),
      enabled: row.enabled,
      status: row.status,
      gatewayOnly: this.gatewayOnly(row),
      generation: row.generation,
      toolNames: row.catalog.filter(tool => !row.disabledTools.includes(tool.name)).map(tool => tool.name),
      disabledToolNames: row.catalog.filter(tool => row.disabledTools.includes(tool.name)).map(tool => tool.name),
    }));
  }
  /**
   * The retained declaration for one installation, ignoring per-tool policy. Never triggers
   * discovery, and never decides admission: a caller must check `disabledToolNames` too.
   */
  retainedTool(installationId: string, name: string): Tool | null {
    return this.records.find(row => row.id === installationId)?.catalog.find(tool => tool.name === name) ?? null;
  }
  /** Resolve through the same cached exposure authority used by Plugins publication. */
  exposedToolIdentity(name: string): { installationId: string; toolName: string; schemaHash: string; generation: number } | null {
    const owner = this.exposure().owners.get(name);
    const row = this.records.find(candidate => candidate.id === owner);
    const tool = row?.catalog.find(candidate => candidate.name === name);
    return row && tool ? { installationId: row.id, toolName: tool.name, schemaHash: externalSchemaHash(tool), generation: row.generation } : null;
  }
  /** Every retained name, enabled or not — the catalog the Plugins surface and settings show. */
  retainedToolNames(installationId: string): string[] {
    return this.records.find(row => row.id === installationId)?.catalog.map(tool => tool.name) ?? [];
  }
  /**
   * Validates arguments against one installation's current declaration.
   *
   * The server's own JSON Schema is the authority, not a re-derived shape: `$ref`, `oneOf`,
   * composed restrictions and `additionalProperties` all apply exactly as published. An
   * unsupported keyword is an explicit failure rather than a silently weaker check.
   */
  validateExternalArguments(installationId: string, tool: Tool, args: Record<string, unknown>): ExternalValidation {
    const row = this.records.find(candidate => candidate.id === installationId);
    if (!row || !row.enabled || row.disabledTools.includes(tool.name) || !row.catalog.some(candidate => candidate.name === tool.name && candidate === tool))
      return { ok: false, detail: 'this installation or tool is no longer current.' };
    return this.validateArguments(tool, args);
  }
  private validateArguments(tool: Tool, args: Record<string, unknown>): ExternalValidation {
    try {
      const validate = externalValidator.getValidator(tool.inputSchema);
      const result = validate(args);
      if (result.valid) return { ok: true };
      return { ok: false, detail: String(result.errorMessage ?? 'arguments do not match the current schema').slice(0, 600) };
    } catch (error) {
      return {
        ok: false,
        detail: `the published schema for this tool could not be validated (${(error as Error).message.slice(0, 200)}). No constraint was dropped to accept the call.`
      };
    }
  }
  private disabledToolRefusal(row: RecordEntry, name: string): string {
    return `MCP_TOOL_DISABLED: tool "${name}" is disabled for installation ${row.id} (${row.name}). Enable it in Plugins, then retry.`;
  }
  /**
   * Dispatches one external call by installation identity and exact tool name.
   *
   * This is the gateway's dispatch path, separate from the Plugins surface's name-owned routing:
   * the installation id is the authority, so two servers declaring the same raw tool name are
   * unambiguous and neither can claim the other's tool.
   *
   * `expected` is the admission discovery granted the caller, and every part of it is re-proved
   * inside the installation's serial queue — the same queue lifecycle mutations run on. The
   * caller's own checks necessarily ran before that queue, and a queued update, restart, disable
   * or discovery refresh can replace the declaration, the connection or the policy in between. A
   * call that no longer matches its expectation is refused before dispatch rather than translated
   * onto a changed declaration: its arguments were shaped for the one the caller read.
   * Callers may supply a live admission callback, rechecked after queue acquisition and
   * immediately before the upstream call.
   */
  async callExternal(
    installationId: string,
    toolName: string,
    args: Record<string, unknown>,
    expected: ExternalCallExpectation,
    admitted?: () => Promise<boolean>
  ): Promise<CallToolResult> {
    if (this.closing) throw new ExternalNotDispatched('PLUGIN_UNAVAILABLE: plugins are shutting down.');
    const row = this.records.find(candidate => candidate.id === installationId);
    if (!row) throw new ExternalNotDispatched(`MCP_UNKNOWN_SERVER: no installation has id ${installationId}.`);
    if (!row.enabled) throw new ExternalNotDispatched(`MCP_SERVER_DISABLED: installation ${installationId} is disabled.`);
    // The cheap path: a switched-off tool must not even wake its server.
    if (row.disabledTools.includes(toolName)) throw new ExternalNotDispatched(this.disabledToolRefusal(row, toolName));
    const acquired = await this.serial(row.id, async (): Promise<ExternalAcquisition> => {
      if (!this.records.includes(row)) return { refusal: `MCP_UNKNOWN_SERVER: no installation has id ${installationId}.` };
      if (!row.enabled) return { refusal: `MCP_SERVER_DISABLED: installation ${installationId} is disabled.` };
      if (row.disabledTools.includes(toolName)) return { refusal: this.disabledToolRefusal(row, toolName) };
      let live = this.live.get(row.id);
      if (!live) await this.connect(row);
      live = this.live.get(row.id);
      if (!live || this.closing) return undefined;
      if (!this.records.includes(row) || !row.enabled) return { refusal: `MCP_SERVER_DISABLED: installation ${installationId} is unavailable.` };
      if (row.disabledTools.includes(toolName)) return { refusal: this.disabledToolRefusal(row, toolName) };
      const tool = live.tools.find(candidate => candidate.name === toolName);
      if (!tool)
        return {
          refusal: `MCP_UNKNOWN_TOOL: installation ${installationId} no longer declares "${toolName}". Call mcp_tools for the current catalog, then retry.`
        };
      const current = externalSchemaHash(tool);
      if (current !== expected.schemaHash)
        return {
          refusal:
            `MCP_SCHEMA_CHANGED: the declaration for ${installationId}/${toolName} changed since this caller read it (expected ${expected.schemaHash}, current ${current}). ` +
            'Call mcp_tools for the current schema, then retry with arguments shaped for it.'
        };
      // The declaration that is about to be dispatched on is the one the arguments are checked
      // against, so no queued replacement can dispatch arguments validated for another schema.
      const validation = this.validateArguments(tool, args);
      if (!validation.ok) return { refusal: `MCP_INVALID_ARGUMENTS: ${validation.detail}` };
      live.users++;
      return { live, tool };
    });
    if (acquired && 'refusal' in acquired) throw new ExternalNotDispatched(acquired.refusal);
    // No connection was ever established for this call, so nothing was dispatched.
    if (!acquired)
      throw new ExternalNotDispatched(
        `MCP_SERVER_UNAVAILABLE: installation ${installationId} is ${row.status}${row.error ? ` (${row.error})` : ''}.`
      );
    const { live, tool } = acquired;
    try {
      if (!this.records.includes(row) || !row.enabled) throw new ExternalNotDispatched('MCP_SERVER_DISABLED: the installation was disabled before dispatch.');
      if (row.disabledTools.includes(toolName)) throw new ExternalNotDispatched(this.disabledToolRefusal(row, toolName));
      if (admitted) {
        let permitted = false;
        try { permitted = await admitted(); } catch { /* unavailable proof is not permission */ }
        if (!permitted) throw new ExternalNotDispatched('CUA_PERMISSION_OR_IDENTITY_CHANGED: live desktop permission or caller ownership changed while this call waited.');
        // Admission can await user/session proof while policy, discovery, or the transport changes.
        // Re-prove the acquired call synchronously before dispatch; never replay on a successor.
        if (this.closing || !this.records.includes(row) || !row.enabled)
          throw new ExternalNotDispatched('MCP_SERVER_DISABLED: the installation was disabled before dispatch.');
        if (row.disabledTools.includes(toolName)) throw new ExternalNotDispatched(this.disabledToolRefusal(row, toolName));
        if (this.live.get(row.id) !== live || row.status !== 'ready')
          throw new ExternalNotDispatched(`MCP_SERVER_UNAVAILABLE: installation ${installationId} changed connection before dispatch.`);
        const current = live.tools.find(candidate => candidate.name === toolName);
        if (!current) throw new ExternalNotDispatched(`MCP_UNKNOWN_TOOL: installation ${installationId} no longer declares "${toolName}". Call mcp_tools for the current catalog, then retry.`);
        if (externalSchemaHash(current) !== expected.schemaHash)
          throw new ExternalNotDispatched(`MCP_SCHEMA_CHANGED: the declaration for ${installationId}/${toolName} changed since this caller read it. Call mcp_tools for the current schema, then retry with arguments shaped for it.`);
      }
      const result = await live.client.callTool({ name: tool.name, arguments: args }, { timeout: 120000, toolDefinition: tool });
      if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
        return this.redactResult({ isError: true, content: [{ type: 'text', text: 'PLUGIN_RESULT_TOO_LARGE: Result exceeds 16 MiB. Request a smaller result.' }] });
      for (const block of result.content)
        if (block.type === 'image') {
          // Validation only: the manager never resizes or re-encodes an image, because pixel
          // coordinates the caller already computed against these bytes would no longer match.
          const data = Buffer.from(block.data, 'base64');
          const info = await sharp(data, { limitInputPixels: 36000000 }).metadata();
          if (!info.width || !info.height || info.width * info.height > 36000000)
            return this.redactResult({ isError: true, content: [{ type: 'text', text: 'PLUGIN_IMAGE_TOO_LARGE: Image exceeds the decoded-pixel limit.' }] });
          if (block.mimeType !== `image/${info.format === 'svg' ? 'svg+xml' : info.format}`)
            return this.redactResult({ isError: true, content: [{ type: 'text', text: 'PLUGIN_IMAGE_INVALID: Image MIME type does not match its decoded content.' }] });
        }
      return this.redactResult(result);
    } finally {
      this.release(row, live);
    }
  }
  async call(name: string, args: Record<string, unknown> = {},
    onOutcome?: (outcome: 'tool_rejected' | 'tool_execution_error', ambiguous?: boolean) => void,
    expected?: ExternalCallExpectation & { installationId: string }): Promise<CallToolResult> {
    // The invocation owner knows whether a tool failed or was never admitted.
    // Keep this internal evidence out of the upstream MCP result/content contract.
    const errorResult = (text: string, outcome: 'tool_rejected' | 'tool_execution_error' = 'tool_execution_error', ambiguous = false): CallToolResult => {
      if (ambiguous) onOutcome?.(outcome, true);
      else onOutcome?.(outcome);
      return this.redactResult({ isError: true, content: [{ type: 'text', text }] });
    };
    const refused = (reason: string) => errorResult(`${reason} This call was not dispatched.`, 'tool_rejected');
    let startupFailed = false;
    let admissionRefusal: string | null = null;
    let acquired: { row: RecordEntry; live: Live; tool: Tool } | undefined;
    try {
      acquired = await this.serial(this.exposure().owners.get(name) ?? name, async () => {
        if (this.closing) return;
        const owner = this.exposure().owners.get(name);
        const row = this.records.find(row => row.id === owner && row.enabled);
        if (!row) return;
        let live = this.live.get(row.id);
        if (!live) { await this.connect(row); live = this.live.get(row.id); startupFailed = !live && row.enabled && row.status === 'error'; }
        // Discovery/configuration may have changed the exact declaration during startup.
        if (!live || !row.enabled || this.closing || this.exposure().owners.get(name) !== row.id) {
          if (live && live.users === 0) await this.disconnect(row);
          return;
        }
        const tool = live.tools.find(tool => tool.name === name);
        if (!tool) { if (live.users === 0) await this.disconnect(row); return; }
        if (expected && (row.id !== expected.installationId || live.generation !== expected.generation || externalSchemaHash(tool) !== expected.schemaHash)) {
          admissionRefusal = 'MCP_SCHEMA_CHANGED: the Plugins name or declaration changed before dispatch. Read the current schema.';
          return;
        }
        const validation = this.validateArguments(tool, args);
        if (!validation.ok) { admissionRefusal = `MCP_INVALID_ARGUMENTS: ${validation.detail}`; return; }
        live.users++;
        return { row, live, tool };
      });
    } catch {
      const reason = this.closing
        ? 'PLUGIN_UNAVAILABLE: Plugins are shutting down.'
        : 'PLUGIN_START_FAILED: The plugin server could not start. Check its settings and application.';
      return refused(reason);
    }
    if (!acquired) {
      if (admissionRefusal) return refused(admissionRefusal);
      if (this.closing)
        return refused('PLUGIN_UNAVAILABLE: Plugins are shutting down.');
      if (startupFailed)
        return refused('PLUGIN_START_FAILED: The plugin server could not start. Check its settings and application.');
      // Explain refusal from the same retained catalog/exposure projection that owns
      // publication. Diagnostics never reconnect, authenticate, refresh, or choose a
      // claimant; they only describe why this exact call was not admitted.
      const candidates = this.records.filter(row => row.catalog.some(tool => tool.name === name));
      const exposure = this.exposure();
      const issue = candidates.map(row => exposure.issues.get(row.id)?.get(name)).find((value): value is string => !!value);
      const row = candidates.length === 1 ? candidates[0] : undefined;
      let reason: string;
      if (issue) reason = `PLUGIN_NOT_EXPOSED: ${issue}`;
      else if (!candidates.length)
        reason = 'UNKNOWN_TOOL: This tool name is not in the current Plugins catalog. It may be stale or belong to another connector. Check the current Plugins tool list.';
      else if (row) {
        if (!row.enabled || row.disabledTools.includes(name)) reason = 'PLUGIN_DISABLED: Enable this plugin and tool in Plugins before calling it.';
        else if (row.status === 'needs-auth') reason = 'PLUGIN_NEEDS_AUTH: Sign in to this plugin in Plugins before calling it.';
        else if (row.status === 'authenticating') reason = 'PLUGIN_AUTHENTICATING: Finish the current sign-in for this plugin before calling it.';
        else if (row.status === 'error') reason = 'PLUGIN_UNAVAILABLE: The plugin server is in an error state. Check its application and settings, then Restart this plugin in Plugins. Inspect any earlier failed operation before retrying; it may already have completed.';
        else reason = 'PLUGIN_UNAVAILABLE: This tool is not currently available from its plugin. Check its status in Plugins.';
      } else reason = 'PLUGIN_UNAVAILABLE: This tool is not currently available from its plugin. Check its status in Plugins.';
      return refused(reason);
    }
    const { row, live, tool } = acquired;
    try {
      if (!row.enabled || this.exposure().owners.get(name) !== row.id) return refused('PLUGIN_DISABLED: this tool is no longer exposed.');
      // Supply our bounded discovery result: SDK validates output against it without
      // rediscovery or the modern header-mismatch retry path for ambiguous mutations.
      const result = await live.client.callTool({ name: tool.name, arguments: args }, { timeout: 120000, toolDefinition: tool });
      if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
        return errorResult('PLUGIN_RESULT_TOO_LARGE: Result exceeds 16 MiB. Request a smaller result.');
      for (const block of result.content)
        if (block.type === 'image') {
          const data = Buffer.from(block.data, 'base64');
          const info = await sharp(data, { limitInputPixels: 36000000 }).metadata();
          if (!info.width || !info.height || info.width * info.height > 36000000)
            return errorResult('PLUGIN_IMAGE_TOO_LARGE: Image exceeds the decoded-pixel limit.');
          if (block.mimeType !== `image/${info.format === 'svg' ? 'svg+xml' : info.format}`)
            return errorResult('PLUGIN_IMAGE_INVALID: Image MIME type does not match its decoded content.');
        }
      if (result.isError) onOutcome?.('tool_execution_error');
      return this.redactResult(result);
    } catch (error) {
      // A failed/ambiguous call must not leave a broken process running idle.
      if (this.live.get(row.id) === live && this.records.includes(row)) {
        const needsAuth = error instanceof PluginNeedsAuth || error instanceof UnauthorizedError;
        row.status = row.enabled ? needsAuth ? 'needs-auth' : 'error' : 'disabled';
        row.error = needsAuth ? 'Sign in again to reconnect this plugin.' : 'Server call failed or disconnected. Restart after checking its application.';
        this.changed();
      }
      return errorResult(
        'PLUGIN_CALL_FAILED: The server failed or disconnected. The operation may have completed; inspect its state before retrying. Web GPT Agent did not retry.',
        'tool_execution_error', true
      );
    } finally { this.release(row, live); }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const operation of this.starting.values()) operation.controller.abort();
    await Promise.all(this.records.map(row => this.disconnect(row)));
    await stopInstallers();
    await Promise.all(
      [...this.connecting].map(async ([client, transport]) => {
        if (transport?.pid) await terminateProcessTree(transport.pid, true);
        await client.close().catch(() => undefined);
      }),
    );
    await Promise.all(this.queues.values());
    await Promise.all(this.records.map((row) => this.disconnect(row)));
    this.changed();
  }
}
export const pluginManager = new PluginManager();
