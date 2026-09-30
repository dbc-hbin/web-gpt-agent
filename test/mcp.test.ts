/**
 * End-to-end test of the real MCP endpoint over real HTTP.
 *
 * Nothing here is mocked: it starts the same server the app starts, and speaks the
 * same wire protocol ChatGPT speaks. It covers both protocol eras the SDK serves —
 * the 2025-era requests ChatGPT sends today, and the 2026-07-28 envelope form — so
 * that a change in which era the client uses cannot silently break the connector.
 *
 * The other thing it exists to prove is the surface split. This app publishes two
 * independently discoverable MCP servers, Core and Desktop, and the whole point of that
 * design is that the boundary is *real*: a no-query tools/list against Core must not
 * reveal a single Desktop schema, and a Core tools/call for a Desktop tool must fail as
 * an unknown tool rather than being quietly forwarded. Those assertions live in
 * "surface boundaries" below and are the ones to look at first if this file goes red.
 */

import http from 'node:http';
import { codeModeCall, codeModeResult } from './code-mode-helpers.js';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveCapabilities, defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore } from '../src/main/durable.js';
import { addProject, assignSessionProject } from '../src/main/projects.js';
import { lastRequestAt, selfTestHeaders, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from '../src/main/mcp/server.js';
import { lastToolCallAt, type ToolContext } from '../src/main/mcp/tools.js';
import { friendlyError } from '../src/main/mcp/kernel.js';
import { SURFACE_LIST, surfaceDefinition, type SurfaceId } from '../src/main/mcp/surfaces.js';
import {
  createSession,
  initSessionStore,
  rebindSession,
  readSessionPlan
} from '../src/main/session/store.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../src/shared/types.js';
import type { ToolOutcome } from '../src/shared/session.js';
import { emptyEvidence, noteExec, noteOutcome, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { closeCorrelationStore, observeRequestCorrelation } from '../src/main/session/correlation.js';
import { BROWSER_READ_TOOLS } from '../src/shared/browser-control.js';
import { resetBlockedChatsForTests, setChatBlocked } from '../src/main/session/blocked-chats.js';
import {
  abortContinuation,
  attachSummary,
  dispatchContinuationSourceSendNow,
  beginContinuationSourceSendNow,
  openContinuationNow,
  resetContinuationsForTests
} from '../src/main/session/continuation.js';
import {
  backgroundExecObligations,
  execOwner,
  MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION,
  noteExecOwner,
  forgetExecOwner,
  resetExecOwnershipForTests,
} from '../src/main/codex/ownership.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { locateRipgrep } from '../src/main/ripgrep.js';
import { IS_WINDOWS, makeTempDir, removeTempDir, writeTree } from './helpers.js';

// ---------------------------------------------------------------- transport

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function rawPost(
  urlStr: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function rawGet(urlStr: string): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Streamable HTTP may answer as JSON or as a one-shot SSE stream. Accept both. */
function decode(res: RawResponse): any {
  const text = res.text.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const datas = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? '');
  const last = datas.at(-1);
  if (last !== undefined) {
    try {
      return JSON.parse(last);
    } catch {
      return text;
    }
  }
  return text;
}

let nextId = 1;

/**
 * A 2025-era request to one surface: a plain JSON-RPC body with no _meta envelope.
 *
 * Every request names its surface, because "which server answered" is the property most
 * of this file is about. There is no default-surface helper on purpose.
 */
async function call(surface: SurfaceId, method: string, params: unknown = {}): Promise<any> {
  const res = await rawPost(
    endpoint.urls[surface],
    JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  );
  return { status: res.status, body: decode(res) };
}

const core = (method: string, params: unknown = {}): Promise<any> => call('core', method, params);
const desktop = (method: string, params: unknown = {}): Promise<any> => call('desktop', method, params);

async function backendCall(surface: SurfaceId, name: string, args: unknown) {
  const reply = await call(surface, 'tools/call', codeModeCall(name, args));
  if (reply.body.error) return reply;
  const decoded = codeModeResult(reply.body.result);
  return { ...reply, body: { ...reply.body, result: decoded.result }, notices: decoded.notices };
}

async function backendTools(surface: SurfaceId) {
  const listed = await call(surface, 'tools/call', { name: 'tools_search', arguments: { limit: 20 } });
  const summaries = JSON.parse(textOf(listed));
  const names: string[] = summaries.tools.map((tool: { name: string }) => tool.name);
  if (summaries.next_offset !== null) {
    const rest = await call(surface, 'tools/call', { name: 'tools_search', arguments: { offset: summaries.next_offset, limit: 20 } });
    names.push(...JSON.parse(textOf(rest)).tools.map((tool: { name: string }) => tool.name));
  }
  const declarations = [];
  for (let offset = 0; offset < names.length; offset += 5) {
    const found = await call(surface, 'tools/call', { name: 'tools_search', arguments: { names: names.slice(offset, offset + 5), limit: 5 } });
    declarations.push(...JSON.parse(textOf(found)).tools);
  }
  return declarations;
}

const { REASONING_EFFORTS } = await import('../src/shared/session.js');
const PROTOCOL_2026 = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/**
 * A 2026-07-28 request: the per-request _meta envelope plus the SEP-2243 standard
 * headers the spec requires the client to mirror the body with.
 */
async function modern(
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
): Promise<any> {
  const body = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: PROTOCOL_2026,
        [META_CAPABILITIES]: {}
      }
    }
  };
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': PROTOCOL_2026,
    'Mcp-Method': method,
    ...extraHeaders
  };
  if (method === 'tools/call' && typeof params['name'] === 'string' && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = params['name'];
  }
  const res = await rawPost(endpoint.urls.core, JSON.stringify(body), headers);
  return { status: res.status, headers: res.headers, body: decode(res) };
}

async function modernBackend(name: string, args: unknown, headers: Record<string, string> = {}) {
  const reply = await modern('tools/call', codeModeCall(name, args), headers);
  if (reply.body.error) return reply;
  const decoded = codeModeResult(reply.body.result);
  return { ...reply, body: { ...reply.body, result: decoded.result }, notices: decoded.notices };
}

const toolNames = (reply: any): string[] =>
  ((reply.body?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();

const toolList = (reply: any): Array<Record<string, any>> => (reply.body?.result?.tools ?? []) as Array<Record<string, any>>;

const textOf = (reply: any): string =>
  ([...(reply.body?.result?.content ?? []), ...(reply.notices ?? [])] as Array<{ text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');

const failed = (reply: any): boolean => reply.body?.error !== undefined || reply.body?.result?.isError === true;

/** The native value the script saw, read back through this connector's recorded envelope. */
const nativeOf = (reply: unknown): string => {
  const result = (reply as { body?: { result?: { content?: Array<{ type?: string; text?: string }> } } }).body?.result;
  return (result?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
};

/** A terminal tool's structured result, which is the native value code mode hands the script. */
const terminalOf = (reply: unknown): Record<string, unknown> =>
  ((reply as { body?: { result?: { structuredContent?: Record<string, unknown> } } }).body?.result?.structuredContent) ?? {};

/** The process id `exec_command`/`write_stdin` reports while its child is still running. */
const sessionIdOf = (reply: unknown): number => Number(terminalOf(reply)['session_id']);

/** How many images a native read result carried, counted by their data URLs. */
const imageCountOf = (reply: unknown): number => (nativeOf(reply).match(/data:image\/[a-z]+;base64,/g) ?? []).length;

/** A patch that only adds one file, which is the cheapest way to prove apply_patch ran. */
const addPatch = (virtualPath: string, lines: string[]): string =>
  ['*** Begin Patch', `*** Add File: ${virtualPath}`, ...lines.map((line) => `+${line}`), '*** End Patch'].join('\n');

// ------------------------------------------------------------------ fixture

let base: string;
let approved: string;
let outside: string;
let endpoint: McpEndpoint;
let ctx: ToolContext;

function withCaps(overrides: Partial<Capabilities>): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

/** Everything the user could possibly switch on, which is the worst case for discovery. */
function allCaps(): Capabilities {
  const caps = { ...DEFAULT_CAPABILITIES };
  for (const key of Object.keys(caps) as Array<keyof Capabilities>) caps[key] = true;
  return caps;
}

beforeAll(async () => {
  base = await makeTempDir('clf-mcp-');
  // This suite calls real tools, and calling a tool records it. Recording is on by
  // default now, so without a directory of its own the recorder wrote session folders
  // into the process's working directory — which for a test run is the repository.
  initConfigPath(base);
  initDurableStore(base);
  initSessionStore(base);
  approved = path.join(base, 'workspace');
  outside = path.join(base, 'private');
  await writeTree(approved, {
    'notes.txt': Array.from({ length: 50 }, (_, i) => `note line ${i + 1}`).join('\n') + '\n',
    'src/app.ts': 'export const name = "app";\n',
    'src/lib/util.ts': 'export const helper = 1;\n',
    'node_modules/pkg/noise.js': 'generated dependency noise\n'
  });
  await writeTree(outside, { 'passwords.txt': 'hunter2' });
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'workspace', path: approved }] });
  await fs.writeFile(
    path.join(approved, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );

  ctx = {
    roots: [{ name: 'workspace', path: approved }] as Root[],
    caps: withCaps({}),
    readOnly: true,
    // Stated rather than inherited from the saved config. These two are whole features
    // with their own defaults — recording now starts on — and a capability-gating test
    // that silently changes meaning when a product default moves is not testing gating.
    // The tools they add are covered by their own suites.
    sessionTools: false,
    agentTools: false
  };
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  // Every live exec test uses UnifiedExecProcessManager. The old teardown still stopped the
  // retired connector-native process manager, which meant it looked like this suite protected
  // the fixture from leaked shells while production sessions were completely untouched.
  await unifiedExecManager.terminateAllProcesses();
  await flushDurable();
  // The request-ownership ledger is a process-wide SQLite handle under this directory; Windows
  // refuses to delete a file a live connection still holds.
  closeCorrelationStore();
  await removeTempDir(base);
});

beforeEach(async () => {
  if (endpoint) await endpoint.stop();
  ctx.caps = withCaps({});
  ctx.readOnly = true;
  ctx.roots = [{ name: 'workspace', path: approved }];
  ctx.sessionTools = false;
  ctx.agentTools = false;
  // A fresh endpoint gives every test a fresh ChatGPT tool-surface snapshot. Tests
  // that change permissions mid-flight still exercise the real live-config path.
  endpoint = await startMcpServer(() => ctx);
});

// ------------------------------------------------------------------- tests

describe('endpoint hardening', () => {
  it('does not expose native paths from uncommon filesystem errors', () => {
    const error = Object.assign(new Error(`ELOOP: too many symbolic links, realpath '${approved}\\loop\\file.txt'`), {
      code: 'ELOOP',
      path: path.join(approved, 'loop', 'file.txt'),
      syscall: 'realpath'
    });
    const text = friendlyError(error);
    expect(text).toBe('Filesystem error (ELOOP)');
    expect(text).not.toContain(approved);
  });

  it('binds to loopback only, and gives every surface its own path', () => {
    for (const surface of SURFACE_LIST) {
      const url = endpoint.urls[surface.id];
      expect(url.startsWith('http://127.0.0.1:'), surface.id).toBe(true);
      expect(new URL(url).pathname.startsWith(`/mcp/${surface.id}/`), surface.id).toBe(true);
    }
    expect(endpoint.url).toBe(endpoint.urls.core);
    expect(endpoint.urls.core).not.toBe(endpoint.urls.desktop);
  });

  it('gives each surface its own token, so handing out one does not hand out the other', async () => {
    const coreUrl = new URL(endpoint.urls.core);
    const desktopUrl = new URL(endpoint.urls.desktop);
    const coreToken = coreUrl.pathname.split('/').pop() ?? '';
    const desktopToken = desktopUrl.pathname.split('/').pop() ?? '';
    expect(coreToken).not.toBe(desktopToken);

    // Knowing Core's token must not be enough to reach Desktop. This is the property that
    // makes "share the Desktop connector" and "share everything" different acts.
    const swapped = new URL(endpoint.urls.desktop);
    swapped.pathname = `/mcp/desktop/${coreToken}`;
    const res = await rawPost(swapped.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('serves nothing at a path without the secret token', async () => {
    const wrong = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/', '/mcp/core', '/mcp/core/', '/mcp/core/wrong-token', '/mcp/desktop/wrong']) {
      wrong.pathname = p;
      const res = await rawPost(wrong.toString(), '{}');
      expect(res.status, p).toBe(404);
    }
  });

  it('rejects a token of the right length but the wrong value', async () => {
    const url = new URL(endpoint.urls.core);
    const token = url.pathname.split('/').pop() ?? '';
    // Same length, so the comparison itself has to reject it.
    url.pathname = `/mcp/core/${'A'.repeat(token.length)}`;
    const res = await rawPost(url.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('rejects a non-loopback Host header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { host: 'files.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('rejects a cross-site Origin header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { origin: 'https://evil.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('never answers with a non-JSON body, whatever is asked for', async () => {
    // tunnel-client's OAuth discovery decodes these bodies as JSON regardless of the
    // status code. A plain-text "Not found" here is what broke discovery outright.
    const url = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/core', '/favicon.ico', '/.well-known/oauth-protected-resource']) {
      url.pathname = p;
      const res = await rawGet(url.toString());
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type'], p).toContain('application/json');
      expect(() => JSON.parse(res.text), p).not.toThrow();
    }
  });

  it('separates "ChatGPT arrived" from "ChatGPT was allowed to run a tool"', async () => {
    // The whole point of keeping two clocks: a connect that handshakes and lists
    // tools but never calls one is what Developer mode being off looks like here,
    // and it is indistinguishable from success on every other signal.
    expect(lastRequestAt()).toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    });
    await core('tools/list');
    expect(lastRequestAt()).not.toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await backendCall('core', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('counts a request to either surface as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await desktop('tools/list');
    expect(lastRequestAt()).not.toBeNull();
  });

  // With an optional second connector, one global clock cannot answer the question the
  // setup screen actually asks: did the user create THIS connector in ChatGPT? Core
  // traffic says nothing about Desktop, so each surface keeps its own pair.
  it('keeps a separate arrival and tool-call clock per surface', async () => {
    expect(lastRequestAt('core')).toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();

    await core('tools/list');
    expect(lastRequestAt('core')).not.toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();
    expect(lastToolCallAt('core')).toBeNull();

    await backendCall('core', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(lastToolCallAt('core')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();

    ctx.caps = withCaps({ screen: true });
    await desktop('tools/list');
    expect(lastRequestAt('desktop')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();
  });

  it('counts a refused tool call, because the question is whether we were called', async () => {
    // A disabled tool still proves ChatGPT is allowed to reach the tool layer, which
    // is the only thing this clock is asked about.
    await core('tools/list');
    ctx.caps = withCaps({ read: false, browse: false, metadata: false });
    const res = await backendCall('core', 'read', { paths: ['/workspace/notes.txt'] });
    expect(JSON.stringify(res.body)).toContain('TOOL_DISABLED');
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('does not let the app’s own self-test count as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      ...selfTestHeaders()
    });
    expect(lastRequestAt()).toBeNull();

    // Anyone else claiming the header without the per-session value is just a caller.
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), {
      'x-local-self-test': 'guessed'
    });
    expect(lastRequestAt()).not.toBeNull();
  });

  it('does not count tunnel-client discovery/startup probes as ChatGPT traffic', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(
      endpoint.urls.core,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }
      }),
      tunnelProbeHeaders()
    );
    expect(lastRequestAt()).toBeNull();
  });

  it('serves protected resource metadata per surface, naming that surface', async () => {
    for (const surface of SURFACE_LIST) {
      const url = new URL(endpoint.urls[surface.id]);
      url.pathname = `/.well-known/oauth-protected-resource${url.pathname}`;
      const res = await rawGet(url.toString());

      expect(res.status, surface.id).toBe(200);
      expect(res.headers['content-type'], surface.id).toContain('application/json');

      const metadata = JSON.parse(res.text);
      // RFC 9728 requires `resource`; it must name this exact endpoint.
      expect(metadata.resource, surface.id).toBe(endpoint.urls[surface.id]);
      expect(metadata.resource_name, surface.id).toBe(surface.connectorName);
      // No authorization server means "not OAuth protected", which is the truth here
      // and stops a client from starting a flow it can never complete.
      expect(metadata.authorization_servers, surface.id).toEqual([]);
    }
  });

  it('does not leak either secret token at the unauthenticated well-known root', async () => {
    const url = new URL(endpoint.urls.core);
    const tokens = SURFACE_LIST.map((surface) => new URL(endpoint.urls[surface.id]).pathname.split('/').pop() ?? '');
    url.pathname = '/.well-known/oauth-protected-resource';
    const res = await rawGet(url.toString());
    expect(res.status).toBe(404);
    for (const token of tokens) expect(res.text).not.toContain(token);
  });

  it('rejects a body that declares an oversized content-length', async () => {
    const url = new URL(endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(64 * 1024 * 1024)
          }
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        }
      );
      req.on('error', reject);
      // Deliberately never finished: the guard must answer on the headers alone.
      req.write('{"jsonrpc":"2.0"');
    });
    expect(status).toBe(413);
  });

  it('enforces the same body cap on chunked requests with no content-length', async () => {
    const url = new URL(endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      let answered = false;
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          answered = true;
          resolve(res.statusCode ?? 0);
          res.resume();
        }
      );
      req.on('error', (error) => {
        if (!answered) reject(error);
      });
      req.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","padding":"');
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      for (let index = 0; index < 129; index++) req.write(chunk);
      req.end('"}');
    });
    expect(status).toBe(413);
    expect((await backendTools('core')).map(tool => tool.name)).toContain('read');
  });

  it('survives a malformed body and keeps serving', async () => {
    const res = await rawPost(endpoint.urls.core, '{ this is not json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await backendTools('core')).map(tool => tool.name)).toContain('read');
  });

  it('survives a JSON body that is not a JSON-RPC message', async () => {
    const res = await rawPost(endpoint.urls.core, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await backendTools('core')).map(tool => tool.name)).toContain('read');
  });
});

// ---------------------------------------------------------------------------
// The design this whole redesign exists for.
// ---------------------------------------------------------------------------

describe('surface boundaries', () => {
  /** Turns everything on, so each surface advertises the most it ever can. */
  const everything = (): void => {
    ctx.caps = allCaps();
    ctx.readOnly = false;
    ctx.sessionTools = true;
    ctx.agentTools = true;
  };

  it('advertises exactly Core’s tools on Core, with nothing from Desktop', async () => { everything(); expect(toolNames(await core('tools/list'))).toEqual(['agents','exec','exec_read','tools_search','wait','work']); });;

  it('rejects the removed file-saving tool even when every permission is enabled', async () => {
    everything();
    const reply = await core('tools/call', { name: 'download_artifact', arguments: {} });
    expect(failed(reply)).toBe(true);
  });

  /**
   * The multi-agent field that no longer exists, everywhere it used to appear.
   *
   * Every tool once carried an optional `agent_key`, because a worker had to say who it was
   * on every call it made. A worker is now the chat it is in, so there is nothing for a model
   * to carry and nothing for one to invent — which is what this checks, since the prime
   * inventing a key for itself was a schema-reading failure, not a runtime one. The schema is
   * also the only thing ChatGPT caches per connector session, so a field absent here is a
   * field that cannot come back without a reconnect.
   */
  const keyFields = async (surface: 'core' | 'desktop'): Promise<string[]> => {
    return toolList(await call(surface, 'tools/list'))
      .filter((tool) => {
        const properties = Object.keys(tool.inputSchema?.properties ?? {});
        return properties.some((name) => name === 'agent_key' || name.endsWith('_key')) && tool.name !== 'agents';
      })
      .map((tool) => tool.name as string);
  };

  it('offers no key field on any tool, with multi-agent fully on', async () => {
    everything();
    expect(await keyFields('core')).toEqual([]);
    expect(await keyFields('desktop')).toEqual([]);

    // Not even on `agents`, which used to keep one for recovery. An agent is the ChatGPT
    // conversation it runs in, and there is now no argument anywhere that says otherwise.
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    for (const field of Object.keys(agentsTool.inputSchema.properties)) {
      expect(field, field).not.toMatch(/key|secret|token/i);
    }

    // And an ordinary read from a worker's chat carries nothing at all.
    const call1 = await backendCall('core', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(call1)).toBe(false);
  });

  /**
   * The prime has to be able to say which model each worker gets — issue #67.
   *
   * The broker has accepted per-worker `model` and `reasoning_effort` for a while, validates
   * both before creating anything, and has tests for the rejection path. What it did not have
   * was any way for a caller to send them: the `workers` object is `.strict()`, so a spawn
   * naming a model was rejected outright rather than honoured. This asserts the surface, since
   * that gate is the one seam the broker's own tests cannot see.
   */
  it('lets a spawn choose a model and reasoning level per worker', async () => {
    everything();
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    const worker = agentsTool.inputSchema.properties.workers.items;

    expect(Object.keys(worker.properties).sort()).toEqual(['label', 'model', 'reasoning_effort', 'task']);
    // Only `task` is required: omitting both keeps exactly the previous behaviour, which is
    // the account default, or whatever the user chose in settings.
    expect(worker.required).toEqual(['task']);
    expect(worker.additionalProperties).toBe(false);

    // Declared as an enum so the caller can discover the vocabulary instead of guessing at it
    // and having the spawn fail. `pro` belongs here: a worker is a real ChatGPT browser chat.
    expect(worker.properties.reasoning_effort.enum).toEqual([...REASONING_EFFORTS]);
    expect(worker.properties.model.type).toBe('string');

    // The task description used to tell the model the opposite — that model and reasoning were
    // fixed in app settings. A caller that believes that will never pass either field.
    expect(worker.properties.task.description).not.toMatch(/predefined by the user/i);
    for (const field of ['model', 'reasoning_effort']) {
      expect(worker.properties[field].description, field).toMatch(/app settings/i);
    }
  });

  it('removes the agents tool entirely once multi-agent is switched off', async () => {
    everything();
    expect(toolNames(await core('tools/list'))).toContain('agents');

    // The user switches the feature off and reconnects the connector, which is the one
    // reload the design is allowed to ask for. A fresh endpoint is what that reconnection
    // looks like from here.
    ctx.agentTools = false;
    await endpoint.stop();
    endpoint = await startMcpServer(() => ctx);

    expect(toolNames(await core('tools/list'))).not.toContain('agents');
    // And the multi-agent tool is absent from every server, so there is nothing left for a
    // model to aim a spawn or a handoff at.
    for (const surface of SURFACE_LIST) {
      expect(toolNames(await call(surface.id, 'tools/list')), surface.id).not.toContain('agents');
    }
  });

  it('advertises exactly Desktop’s tools on Desktop, with nothing from Core', async () => { everything(); expect(toolNames(await desktop('tools/list'))).toEqual(['exec','tools_search','wait']); });;

  it('does not let Desktop discovery freeze Core’s tool shape', async () => {
    // Core has not been queried yet. A Desktop request must not count as a cached Core
    // snapshot, because ChatGPT caches these two connectors independently.
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, screen: true });
    expect((await backendTools('desktop')).map(tool => tool.name)).toEqual([...BROWSER_READ_TOOLS].sort());

    // Before Core's first discovery the user enables command execution. Core should answer
    // from *this* state, not the state Desktop happened to observe earlier — and search
    // stays listed beside the exec pair, because they are one engine with two entry points.
    ctx.caps = withCaps({ search: true, command: true, screen: true });
    const names = (await backendTools('core')).map(tool => tool.name)
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
    expect(names).toContain('find');
  });

  it('never advertises a tool its surface does not declare', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const declared = new Set(surface.tools);
      for (const name of toolNames(await call(surface.id, 'tools/list'))) {
        expect(declared.has(name), `${surface.id} advertised ${name}`).toBe(true);
      }
    }
  });

  it('fails a cross-surface tools/call as an unknown tool rather than forwarding it', async () => {
    everything();
    const onDesktop = await backendCall('desktop', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(onDesktop)).toBe(true);
    expect(textOf(onDesktop)).not.toContain('export const name');
    expect(JSON.stringify(onDesktop.body)).not.toContain('export const name');
  });

  it('has retired every tool name the old surface published', async () => {
    everything();
    const retired = [
      'list_roots',
      'read_file',
      'read_files',
      'list_directory',
      'search_files',
      'file_info',
      'create_file',
      'write_file',
      'write_binary_file',
      'edit_file',
      'edit_files',
      'move_path',
      'delete_file',
      'delete_directory',
      'run_command',
      'run_powershell',
      'open_url',
      'process',
      'screenshot',
      'wait_for_window',
      'find_ui',
      'resume_session',
      'session_history',
      'session_status',
      'save_handoff',
      'spawn_agents',
      'join_agent',
      'agent_message',
      'agent_status',
      'agent_inbox',
      'finish_agent'
    ];
    const advertised = new Set([...toolNames(await core('tools/list')), ...toolNames(await desktop('tools/list'))]);
    for (const name of retired) expect(advertised.has(name), name).toBe(false);

    // No aliases either. A retired name must be unknown to both servers, not silently
    // accepted by the one that used to own it.
    for (const name of ['read_file', 'edit_file', 'screenshot', 'join_agent']) {
      expect(failed(await core('tools/call', { name, arguments: {} })), name).toBe(true);
      expect(failed(await desktop('tools/call', { name, arguments: {} })), name).toBe(true);
    }
  });

  it('keeps the worst-case no-query discovery of each surface small', async () => { everything(); const coreTools=toolList(await core('tools/list')); const desktopTools=toolList(await desktop('tools/list')); expect(desktopTools).toHaveLength(3); expect(Buffer.byteLength(JSON.stringify(coreTools))).toBeLessThan(14*1024); expect(Buffer.byteLength(JSON.stringify(desktopTools))).toBeLessThan(3*1024); });;

  it('describes both surfaces well enough for a user to set them up and a model to find them', () => {
    for (const surface of SURFACE_LIST) {
      expect(surface.serverName, surface.id).toMatch(/^web-gpt-agent-/);
      expect(surface.connectorName, surface.id).toContain('Web GPT Agent');
      expect(surface.cardSummary.length, surface.id).toBeGreaterThan(20);
      // The description is the only thing the model has before discovery, so it has to
      // carry real vocabulary rather than a label.
      expect(surface.description.length, surface.id).toBeGreaterThan(120);
      // External plugins declare their bounded schemas dynamically after installation.
      if (surface.id === 'plugins') expect(surface.tools).toEqual(['exec', 'wait', 'tools_search']);
      else expect(surface.tools.length, surface.id).toBeGreaterThan(0);
    }
    expect(surfaceDefinition('core').required).toBe(true);
    expect(surfaceDefinition('desktop').required).toBe(false);
    // The unified connector carries the brand exactly, because it is *the* connector; the
    // optional Desktop/Plugins connectors keep a suffix. Distinct names matter because the
    // connector name is also the retrieval handle.
    expect(surfaceDefinition('core').connectorName).toBe('Web GPT Agent');
    expect(surfaceDefinition('core').connectorName).not.toBe(surfaceDefinition('desktop').connectorName);
  });

  it('gives each surface its own server identity and instructions', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const reply = await call(surface.id, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      });
      expect(reply.body.result.serverInfo.name, surface.id).toBe(surface.serverName);
      expect(reply.body.result.instructions, surface.id).toBeTruthy();
    }
  });
});

describe('2025-era clients', () => {
  it('answers the initialize handshake', async () => {
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.result.serverInfo.name).toBe('web-gpt-agent-core');
    expect(reply.body.result.protocolVersion).toBeTruthy();
  });

  ;

  it('lists tools without an initialize handshake', async () => {
    const reply = await core('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('exec');
  });

  it('calls a tool', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('exposes Codex view_image separately and returns native MCP image content', async () => {
    const tool = (await backendTools('core')).find((entry) => entry.name === 'view_image');
    const schema = tool?.inputSchema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(['path']);
    expect(schema?.required).toEqual(['path']);
    expect(schema?.additionalProperties).toBe(false);
    expect(tool?.outputSchema).toBeUndefined();

    // Code mode sees the pinned upstream `{image_url}` object: the image travels as the data URL
    // upstream returns, not as this connector's MCP image block.
    const reply = await backendCall('core', 'view_image', { path: '/workspace/pixel.png' });
    expect(reply.status).toBe(200);
    const imageUrl = String(reply.body.result?.structuredContent?.image_url);
    const [header, data] = imageUrl.split(',');
    expect(header).toBe('data:image/png;base64');
    expect(Buffer.from(String(data), 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe('2026-07-28 clients', () => {
  it.each(['server/discover', 'tools/list'])('returns JSON for modern %s', async method => {
    const reply = await modern(method);
    expect(reply.status).toBe(200);
    expect(reply.body.error).toBeUndefined();
    expect(reply.headers['content-type']).toContain('application/json');
  });
  it('lists tools when the request carries the _meta envelope', async () => {
    const reply = await modern('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('exec');
  });

  it('calls a tool', async () => {
    const reply = await modernBackend('read', { paths: ['/workspace/src/app.ts'] });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('rejects a modern request whose headers disagree with its body', async () => {
    const reply = await modernBackend('read', { paths: ['/workspace/notes.txt'] }, {
      'Mcp-Name': 'apply_patch'
    });
    expect(reply.status).toBe(400);
  });
});

describe('capability gating', () => {
  it('hides every writing and running tool in read-only mode', async () => { const config={...defaultConfig(),capabilities:allCaps(),readOnly:true}; ctx.caps=effectiveCapabilities(config);ctx.readOnly=true; expect(toolNames(await core('tools/list'))).toEqual(['exec','exec_read','tools_search','wait','work']); const names=(await backendTools('core')).map(tool=>tool.name); expect(names).not.toContain('apply_patch');expect(names).not.toContain('exec_command');expect(names).toContain('read'); });;

  it('offers apply_patch only when a writing permission is on', async () => {
    expect((await backendTools('core')).map(tool => tool.name)).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect((await backendTools('core')).map(tool => tool.name)).toContain('apply_patch');
  });

  it('enforces the create/edit/move/delete split inside one apply_patch schema', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: false, move: false, deleteFile: false });

    const added = await backendCall('core', 'apply_patch', addPatch('/workspace/split.txt', ['one']));
    expect(added.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const addOverExisting = await backendCall('core', 'apply_patch', addPatch('/workspace/split.txt', ['overwritten through add']));
    expect(addOverExisting.body.result?.isError).toBe(true);
    expect(textOf(addOverExisting)).toContain('Edit files is disabled');
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const updated = await backendCall('core', 'apply_patch', ['*** Begin Patch', '*** Update File: /workspace/split.txt', '@@', '-one', '+two', '*** End Patch'].join('\n'));
    expect(updated.body.result?.isError).toBe(true);
    expect(textOf(updated)).toContain('Edit files is disabled');
    // Refused before anything was written, which is the whole promise of apply_patch.
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const deleted = await backendCall('core', 'apply_patch', ['*** Begin Patch', '*** Delete File: /workspace/split.txt', '*** End Patch'].join('\n'));
    expect(deleted.body.result?.isError).toBe(true);
    expect(textOf(deleted)).toContain('Delete files is disabled');
  });

  it('keeps command execution off unless it is explicitly enabled', async () => {
    ctx.readOnly = false;
    expect((await backendTools('core')).map(tool => tool.name)).not.toContain('exec_command');

    ctx.caps = withCaps({ command: true });
    const names = (await backendTools('core')).map(tool => tool.name)
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
  });

  it('keeps find available when exec_command can also search', async () => {
    // Search and the shell are one engine with two entry points, not competing designs.
    // Removing `find` under command execution only cost the model a shell round trip for a
    // search, so both are listed together.
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true, search: true });
    const names = (await backendTools('core')).map(tool => tool.name)
    expect(names).toContain('exec_command');
    expect(names).toContain('find');
  });

  it('offers find when there is no shell to search with', async () => {
    ctx.caps = withCaps({ search: true, command: false });
    expect((await backendTools('core')).map(tool => tool.name)).toContain('find');

    const reply = await backendCall('core', 'find', { query: 'helper', mode: 'content' });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(reply.body.result?.structuredContent).toMatchObject({
      hits: expect.arrayContaining([expect.objectContaining({ path: '/workspace/src/lib/util.ts' })]),
      page: expect.objectContaining({ returned: 1 }), next_cursor: null
    });
  });

  it('offers plans and agents only when enabled, without session lookup', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('session');
    expect((await backendTools('core')).map(tool => tool.name)).not.toContain('update_plan');
    expect(toolNames(await core('tools/list'))).not.toContain('agents');

    ctx.sessionTools = true;
    ctx.agentTools = true;
    const names = (await backendTools('core')).map(tool => tool.name)
    expect(names).not.toContain('session');
    expect(names).toContain('update_plan');
    expect(toolNames(await core('tools/list'))).toContain('agents');
  });

  it('rejects action-specific agent fields instead of silently ignoring them', async () => {
    ctx.agentTools = true;
    const reply = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'status', result: 'this field belongs to finish' }
    });
    expect(failed(reply)).toBe(true);
  });

  it('starts a fresh install with every capability effective', () => {
    // This assertion is about the product's fully-enabled fresh-install policy, not the
    // host running Vitest. Windows has no OS-version floor, so it is the deterministic
    // representative for a host with every declared capability.
    const config = defaultConfig('win32');
    expect(config.readOnly).toBe(false);
    expect(config.multiAgent.enabled).toBe(true);
    expect(Object.values(effectiveCapabilities(config, 'win32')).every(Boolean)).toBe(true);
  });

  it('refuses to call a tool that is not registered', async () => {
    const reply = await backendCall('core', 'apply_patch', ['*** Begin Patch', '*** Delete File: /workspace/notes.txt', '*** End Patch'].join('\n'));
    // Either a JSON-RPC error or a tool error, but never a deletion.
    expect(failed(reply)).toBe(true);
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toContain('note line 1');
  });

  it('answers metadata-only permission with metadata rather than refusing the path', async () => {
    ctx.caps = withCaps({ read: false, browse: false, metadata: true });
    const reply = await backendCall('core', 'read', { paths: ['/workspace/src/app.ts'] });
    const text = textOf(reply);
    expect(text).toContain('/workspace/src/app.ts');
    expect(text).toContain('need the Read files permission');
    expect(text).not.toContain('export const name');
  });

  it('picks up a permission change on the very next request', async () => {
    expect((await backendTools('core')).map(tool => tool.name)).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect((await backendTools('core')).map(tool => tool.name)).toContain('apply_patch');
  });

  it('keeps an already-exposed tool stable and returns TOOL_DISABLED after permission is revoked', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect((await backendTools('core')).map(tool => tool.name)).toContain('apply_patch');

    ctx.caps = withCaps({ create: false });
    expect((await backendTools('core')).map(tool => tool.name)).not.toContain('apply_patch');

    const reply = await backendCall('core', 'apply_patch', addPatch('/workspace/should-not-exist.txt', ['nope']));
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('TOOL_DISABLED');
    await expect(fs.stat(path.join(approved, 'should-not-exist.txt'))).rejects.toThrow();
  });

  // Search is offered whenever search is enabled, including alongside the exec pair, and the
  // publication is monotonic: `exposedCaps` only ever widens, so deriving find's registration
  // from the live capability would DELETE a tool from an already-cached ChatGPT snapshot — the
  // exact stale-snapshot failure the monotonic rule exists to prevent.
  it('keeps find listed after command execution is switched on mid-run', async () => {
    ctx.caps = withCaps({ search: true, read: true, browse: true });
    expect((await backendTools('core')).map(tool => tool.name)).toContain('find');

    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, browse: true, command: true });
    const names = (await backendTools('core')).map(tool => tool.name)
    expect(names).toContain('find');
    expect(names).toContain('exec_command');
  });

  it('lists find on a surface that started with command execution already on', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, command: true });
    expect((await backendTools('core')).map(tool => tool.name)).toContain('find');

    ctx.caps = withCaps({ search: true, read: true, command: false });
    expect((await backendTools('core')).map(tool => tool.name)).toContain('find');
  });

  it('still refuses search when the search permission itself is off', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: false, read: true, command: true });
    expect((await backendTools('core')).map(tool => tool.name)).not.toContain('find');
  });

  it('always offers the work controls, because they are what the app is for remotely', async () => { ctx.caps=withCaps({browse:false,search:false,read:false,metadata:false});expect(toolNames(await core('tools/list'))).toEqual(['exec','exec_read','tools_search','wait','work']); });;
});

describe('tool annotations', () => {
  it('keeps connector annotations off copied Codex ToolSpecs', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ read: true, create: true, edit: true, move: true, deleteFile: true, command: true });
    const tools = (await backendTools('core'));
    for (const name of ['view_image', 'apply_patch', 'exec_command', 'write_stdin']) {
      expect(tools.find((tool) => tool.name === name)?.annotations, name).toBeUndefined();
    }
  });

  it('retains annotations on connector-native tools', async () => {
    ctx.sessionTools = true;
    const read = (await backendTools('core')).find((tool) => tool.name === 'read');
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(read?.annotations?.destructiveHint).toBe(false);
  });
});

describe('sandbox enforcement through the tool layer', () => {
  const escapes = [
    '/workspace/../private/passwords.txt',
    '/workspace/../../private/passwords.txt',
    '\\workspace\\..\\private\\passwords.txt',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/private/passwords.txt',
    '/workspace/notes.txt:stream'
  ];

  it('refuses every escape attempt on read', async () => {
    for (const attempt of escapes) {
      const reply = await backendCall('core', 'read', { paths: [attempt] });
      const text = textOf(reply);
      // One bad path is a per-path failure rather than a failed call, so the assertion is
      // that the content never arrives — not that the call errored.
      expect(text, attempt).toContain('ERROR');
      expect(text, attempt).not.toContain('hunter2');
    }
  });

  it('accepts a native filesystem path when it is inside an approved root', async () => {
    const reply = await backendCall('core', 'read', { paths: [path.join(approved, 'notes.txt')] });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('note line 1');
    expect(textOf(reply)).toContain('/workspace/notes.txt');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts native filesystem globs through read', async () => {
    const reply = await backendCall('core', 'read', { paths: [path.join(approved, 'src', '**', '*.ts')] });
    expect(reply.body.result?.isError, textOf(reply)).not.toBe(true);
    expect(textOf(reply)).toContain('/workspace/src/app.ts');
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts a native filesystem search scope through find', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await backendCall('core', 'find', { query: 'helper', mode: 'content', path: path.join(approved, 'src') });
    expect(reply.body.result?.isError, textOf(reply)).not.toBe(true);
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts a native filesystem image path through view_image', async () => {
    ctx.caps = withCaps({ read: true });
    const reply = await backendCall('core', 'view_image', { path: path.join(approved, 'pixel.png') });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(String(reply.body.result?.structuredContent?.image_url)).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses escape attempts on find', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await backendCall('core', 'find', { query: 'hunter2', mode: 'content', path: '/workspace/../private' });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).not.toContain('hunter2\n');
  });

  it('refuses to write outside a root even with writes enabled', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await backendCall('core', 'apply_patch', addPatch('/workspace/../private/planted.txt', ['x']));
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses a relative patch path that climbs out of its base', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    // apply_patch used to join the base onto the path and `posix.normalize` the result
    // before the sandbox ever saw it, which erased the `..` that checkSegment exists to
    // refuse: `/workspace/../private/planted.txt` became a clean `/private/planted.txt`
    // and arrived looking like a path that had always been absolute. Patch paths now get
    // the same treatment as a path handed to read or exec.
    const reply = await backendCall('core', 'apply_patch', addPatch('../private/planted.txt', ['x']));
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('does not advertise the retired apply_patch cwd argument', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const tool = (await backendTools('core')).find((entry) => entry.name === 'apply_patch')!;
    // Published as the upstream freeform contract: patch text is the whole argument, so there is no
    // object for a caller-chosen base (`cwd`) to travel in — the retired field cannot come back.
    expect(tool.inputSchema.type).toBe('string');
    expect(tool.inputSchema).not.toHaveProperty('properties');
    expect(tool.inputSchema).not.toHaveProperty('cwd');
  });

  it('does not let a retired cwd field silently rebase relative patch paths', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    await fs.mkdir(path.join(approved, 'nested'), { recursive: true });
    // The published schema is a raw string, so the retired object shape (and the caller-chosen base
    // it carried) is refused before the handler runs rather than silently reinterpreted.
    const reply = await backendCall('core', 'apply_patch', { patch: addPatch('../escaped.txt', ['x']), cwd: '/workspace/nested' });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('raw patch string');
    await expect(fs.stat(path.join(approved, 'escaped.txt'))).rejects.toThrow();
  });

  it('still applies an ordinary relative patch path against its base', async () => {
    // The refusals above must not have been bought by breaking shorthand itself.
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await backendCall('core', 'apply_patch', addPatch('relative-landed.txt', ['x']));
    expect(reply.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'relative-landed.txt'), 'utf8')).toContain('x');
  });

  it('never reveals a real Windows path', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace'] });
    const text = textOf(reply);
    expect(text).toContain('/workspace');
    expect(text).not.toContain(approved);
  });

  it('publishes approved roots without spending a tool call', async () => {
    // list_roots is gone: the roots are one line of server instructions now, because a
    // round trip every conversation paid before it could do anything was pure overhead.
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
  });

  /**
   * Every worked example the model is shown must name a root that exists, and no error may send
   * it after a tool that does not. Both cost a refused call and a retry, and neither is visible
   * from inside the app.
   */
  it('names only live roots and live tools in what the model is shown', async () => {
    const read = (await backendTools('core')).find((tool) => tool.name === 'read')!;
    const paths = String(read.inputSchema.properties.paths.description);
    expect(paths).toContain('/workspace');
    // `/project` is nobody's root; it was a hardcoded example the model could not act on.
    expect(paths).not.toContain('/project');

    // Nor may anything be invented *after* the root. `/workspace/src/main.ts` named a live
    // root and was still a worked example the model could not act on, and a worse one than
    // `/project`: a project-shaped suffix reads as a promise that the root is the project.
    // An approved root is routinely a parent holding several, and reading it the other way
    // is what produced `/<root>/AGENTS.md` for a file one folder deeper — the most repeated
    // read failure in the recorded corpus. What replaces it is the relationship, not another
    // path, so there is nothing left here that can go stale.
    expect(paths).not.toMatch(/\/workspace\/\S+\.\w+/);
    expect(paths).toContain('parent of the project');
    expect(paths).toContain('workdir');

    // list_roots is retired, so no refusal may tell the model to call it. A native path outside
    // every root is the refusal that used to, and it must still name the roots that do exist.
    const refusal = textOf(
      await backendCall('core', 'read', { paths: [path.join(os.tmpdir(), 'nope.txt')] })
    );
    expect(refusal).toContain('Approved roots');
    expect(refusal).not.toContain('list_roots');
  });
});

describe('bounded output', () => {
  it('expands a leading relative glob from the approved root', async () => {
    // A relative glob used to expand from whatever folder the calling chat had learned. It now
    // expands from the approved root itself, which is the same answer for every caller.
    const reply = await backendCall('core', 'read', { paths: ['src/**/*.ts'], start_line: 1, end_line: 1 });
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('/workspace/src/app.ts');
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
  });

  it('returns only the requested line range', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 });
    const text = textOf(reply);
    expect(text).toContain('note line 3');
    expect(text).toContain('note line 5');
    expect(text).not.toContain('note line 6');
    expect(text).toContain('lines 3-5');
    // The total is unknown after a ranged read, so the model gets a resume point
    // instead of a misleading "of ?".
    expect(text).not.toContain('of ?');
    expect(text).toContain('continue from line 6');
  });

  it('honours a line range across every file it read, and says that it did', async () => {
    // The advertised contract has to match the runtime one, or the model learns the rule
    // from a failed call instead of from the tool list. Asserted as a contract (the schema
    // offers a range and a per-path spelling) rather than as a pinned sentence.
    const readTool = (await backendTools('core')).find((tool) => tool.name === 'read')!;
    expect(Object.keys(readTool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['paths', 'start_line', 'end_line', 'max_bytes'])
    );

    // Refusing this was the single largest source of rejected calls in the recorded
    // sessions, and every one of them was a caller that had already said what it wanted.
    // The original objection was to dropping the range *silently* — so it is applied and
    // announced. What must never come back is a reply that looks like a whole-file read.
    const many = await backendCall('core', 'read', { paths: ['/workspace/notes.txt', '/workspace/src/app.ts'], start_line: 10, end_line: 12 });
    expect(failed(many)).toBe(false);
    const text = textOf(many);
    expect(text).toContain('note line 10');
    expect(text).toContain('note line 12');
    expect(text).not.toContain('note line 9');
    expect(text).not.toContain('note line 13');
    // Announced in the body, and restated by the header of every section.
    expect(text).toMatch(/applied to each of the 2 files/i);
    expect(text).toMatch(/\/workspace\/notes\.txt — lines 10-12/);
    // The property the original refusal existed to protect: a file with nothing in that
    // range says so outright, so a short file can never read as a complete one.
    expect(text).toMatch(/\/workspace\/src\/app\.ts — no lines in that range/);

    // A glob is the usual way one path turns into several, so it must behave identically.
    const glob = await backendCall('core', 'read', { paths: ['/workspace/src/**/*.ts'], start_line: 1, end_line: 1 });
    expect(failed(glob)).toBe(false);
    expect(textOf(glob)).toMatch(/lines 1-1/);

    // One path is still one path: nothing is announced when there was nothing to spread.
    const single = await backendCall('core', 'read', { paths: ['/workspace/notes.txt'], start_line: 10, end_line: 12 });
    expect(textOf(single)).not.toMatch(/applied to each/i);
    expect(textOf(single)).toContain('note line 10');
  });

  it('reports the total when the whole file was read', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/src/app.ts'] });
    const text = textOf(reply);
    expect(text).toContain('lines 1-1 of 1');
    expect(text).not.toContain('continue from line');
  });

  it('returns a whole small file when it fits inside the default read budget', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/notes.txt'] });
    const text = textOf(reply);
    expect(text).toContain('lines 1-50 of 50');
    expect(text).toContain('note line 1');
    expect(text).toContain('note line 50');
    expect(text).not.toContain('truncated');
    expect(text).not.toContain('continue from line');
  });

  it('reads a typical 1,500-line source file whole by default', async () => {
    const lines = Array.from({ length: 1_500 }, (_, index) =>
      `${String(index + 1).padStart(4, '0')} export const measuredDefaultReadLine = '${'x'.repeat(64)}';`
    );
    await fs.writeFile(path.join(approved, 'long-default-read.ts'), `${lines.join('\n')}\n`, 'utf8');

    const reply = await core('tools/call', { name: 'exec', arguments: { code: 'const t=await tools.read({paths:["/workspace/long-default-read.ts"]}); text(t.slice(0,200));text(t.slice(-300));' } });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('lines 1-1500 of 1500');
    expect(text).toContain('1500 export const measuredDefaultReadLine');
    expect(text).not.toContain('continue from line');
  });

  /*
   * The line count is the header's answer to "how long is this file", and a range is exactly when
   * that matters: 3 lines with no denominator cannot be told apart from a whole file. The read
   * counts on past the range to fill it in.
   */
  it('states the file total on a ranged read, so a slice cannot read as the whole file', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 });
    const text = textOf(reply);
    expect(text).toContain('lines 3-5 of 50');
    expect(text).toContain('more lines follow — continue from line 6');
  });

  it('lists a folder one level deep, marking what each entry is', async () => {
    // A folder read is one level and nothing more. Dependency folders are shown here —
    // hiding a directory the user can see in Explorer would be a lie — but nothing
    // descends into them, which is where the cost would actually have been.
    const reply = await backendCall('core', 'read', { paths: ['/workspace'] });
    const text = textOf(reply);
    expect(text).toContain('one level');
    expect(text).toContain('d src');
    expect(text).toContain('f notes.txt');
    expect(text).not.toContain('noise.js');
    expect(text).not.toContain('app.ts');
  });

  it('validates tool arguments instead of trusting them', async () => {
    const reply = await backendCall('core', 'read', { paths: [12345] });
    expect(failed(reply)).toBe(true);
  });

  it('honours max_bytes instead of rejecting or silently ignoring the advertised read budget', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/notes.txt'], max_bytes: 60 });
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('continue from line');
    expect(textOf(reply)).not.toContain('note line 50');
  });

  it('rejects a whitespace-only find query instead of walking the workspace for everything', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await backendCall('core', 'find', { query: '   ', mode: 'content' });
    expect(failed(reply)).toBe(true);
  });

  it('marks an exact oversized content file as skipped rather than a complete no-match', async () => {
    ctx.caps = withCaps({ search: true });
    const oversized = path.join(approved, 'oversized-search.log');
    const handle = await fs.open(oversized, 'w');
    try {
      await handle.truncate(2 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    try {
      const reply = await backendCall('core', 'find', { query: 'needle', mode: 'content', path: '/workspace/oversized-search.log' });
      expect(failed(reply), textOf(reply)).toBe(false);
      expect(reply.body.result?.structuredContent).toMatchObject({
        hits: [], stopped_because: 'size', truncated: 'scan',
        content_file_limit: 2 * 1024 * 1024, page: { returned: 0, total_hits: 0 }
      });
    } finally {
      await fs.rm(oversized, { force: true });
    }
  });

  it('rejects find options that the selected mode would silently ignore', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await backendCall('core', 'find', { query: 'notes', mode: 'name', regex: true });
    expect(failed(reply)).toBe(true);
  });

  it('reports a missing file plainly without losing the reads that worked', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/src/app.ts', '/workspace/nope.txt', '/workspace/src/lib/util.ts'] });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('/workspace/nope.txt — ERROR');
    expect(text).toMatch(/Not found/i);
    expect(text).toContain('export const helper = 1;');
  });

  it('lists the nearest folder that does exist under a missing path', async () => {
    // A file guessed one folder too high was the most repeated read failure in the recorded
    // sessions, and every one of them was followed by a listing call. The listing now rides
    // along with the refusal, from the deepest ancestor that resolved.
    const reply = await backendCall('core', 'read', { paths: ['/workspace/src/lib/nested/util.ts'] });
    const text = textOf(reply);
    expect(failed(reply)).toBe(true);
    expect(text).toMatch(/Not found/i);
    expect(text).toContain('The nearest existing folder is /workspace/src/lib; it contains: f util.ts');
    const top = await backendCall('core', 'read', { paths: ['/workspace/lib/util.ts'] });
    expect(textOf(top)).toMatch(/The nearest existing folder is \/workspace; it contains: .*d src, .*f notes\.txt/);
  });

  it('reads a per-path line range spelled as path:start-end', async () => {
    // Four reads in the recorded sessions asked for several ranges of one file this way and
    // were refused for the colon; the spelling is now the range it was meant to be, and a
    // path without one keeps the call-wide start_line/end_line.
    const reply = await backendCall('core', 'read', {
      paths: ['/workspace/notes.txt:3-4', '/workspace/notes.txt:48', '/workspace/src/app.ts'],
      start_line: 1,
      end_line: 1
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('lines 3-4');
    expect(text).toContain('note line 3');
    expect(text).toContain('note line 4');
    expect(text).not.toMatch(/^5	note line 5$/m);
    expect(text).toContain('note line 48');
    expect(text).toContain('note line 50');
    expect(text).not.toContain('note line 47');
    expect(text).toContain('export const name = "app";');
    expect(text).not.toContain('applied to each of');
    const backwards = await backendCall('core', 'read', { paths: ['/workspace/notes.txt:9-3'] });
    expect(failed(backwards)).toBe(true);
  });

  it('fails when every explicit read target failed, while keeping partial multi-read useful', async () => {
    const allMissing = await backendCall('core', 'read', { paths: ['/workspace/nope-a.txt', '/workspace/nope-b.txt'] });
    expect(failed(allMissing)).toBe(true);
    expect(textOf(allMissing)).toContain('/workspace/nope-a.txt — ERROR');
    expect(textOf(allMissing)).toContain('/workspace/nope-b.txt — ERROR');

    const partial = await backendCall('core', 'read', { paths: ['/workspace/src/app.ts', '/workspace/nope.txt'] });
    expect(failed(partial)).toBe(false);
    expect(textOf(partial)).toContain('export const name = "app";');
    expect(textOf(partial)).toContain('/workspace/nope.txt — ERROR');
  });

  it('reads several files in one call', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/src/app.ts', '/workspace/src/lib/util.ts'] });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('export const name = "app";');
    expect(textOf(reply)).toContain('export const helper = 1;');
  });

  it('bounds line-number expansion inside the advertised read payload budget', async () => {
    const target = path.join(approved, 'many-empty-lines.txt');
    await fs.writeFile(target, '\n'.repeat(90_000));
    const reply = await backendCall('core', 'read', { paths: ['/workspace/many-empty-lines.txt'], max_bytes: 16 * 1024 });
    const text = textOf(reply);
    expect(failed(reply)).toBe(false);
    // Raw bytes are cheap here; decimal line-number prefixes are not. The old path enforced
    // max_bytes before numbering and could amplify a bounded slice past the emission limit.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(20 * 1024);
    expect(text).toContain('output cap reached');
  });

  it('renders an empty logical line instead of mistaking it for no line in the range', async () => {
    await fs.writeFile(path.join(approved, 'leading-empty-line.txt'), '\nsecond\n');
    const reply = await backendCall('core', 'read', { paths: ['/workspace/leading-empty-line.txt'], start_line: 1, end_line: 1 });
    const text = textOf(reply);
    expect(failed(reply)).toBe(false);
    expect(text).toMatch(/\n1\t(?:\n|$)/);
    expect(text).toContain('lines 1-1 of 2');
  });

  it('reports an exhausted glob scan instead of claiming there were no matches', async () => {
    const broad = path.join(approved, 'glob-scan-cap');
    await fs.mkdir(broad, { recursive: true });
    try {
      // `walkFiles` is capped at 5,000 examined entries. Put the only matching file after that
      // boundary lexically so the old adapter dropped walk.truncated and lied with "no matches".
      for (let start = 0; start < 5_000; start += 200) {
        await Promise.all(
          Array.from({ length: Math.min(200, 5_000 - start) }, (_, offset) =>
            fs.writeFile(path.join(broad, `${String(start + offset).padStart(5, '0')}.txt`), '')
          )
        );
      }
      await fs.writeFile(path.join(broad, 'zzzzz.needle.ts'), 'export const needle = true;\n');

      const reply = await backendCall('core', 'read', { paths: ['/workspace/glob-scan-cap/**/*.needle.ts'] });
      const text = textOf(reply);
      expect(failed(reply)).toBe(false);
      expect(text).toContain('glob scan stopped after 5000 entries');
      expect(text).not.toContain(': no matches');
    } finally {
      await fs.rm(broad, { recursive: true, force: true });
    }
  });

  it('does not call an exactly-full glob result truncated until a 21st match actually exists', async () => {
    const folder = path.join(approved, 'exact-glob-cap');
    await fs.mkdir(folder, { recursive: true });
    for (let index = 0; index < 20; index++) {
      await fs.writeFile(path.join(folder, `match-${String(index).padStart(2, '0')}.ts`), `export const n = ${index};\n`);
    }

    const exact = await backendCall('core', 'read', { paths: ['/workspace/exact-glob-cap/*.ts'] });
    expect(failed(exact)).toBe(false);
    expect(textOf(exact)).not.toContain('more than 20 matches');

    await fs.writeFile(path.join(folder, 'match-20.ts'), 'export const n = 20;\n');
    const overflow = await backendCall('core', 'read', { paths: ['/workspace/exact-glob-cap/*.ts'] });
    expect(failed(overflow)).toBe(false);
    expect(textOf(overflow)).toContain('more than 20 matches');
  });

  it('expands a glob rather than making the model list the files itself', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/src/**/*.ts'] });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('export const helper = 1;');
  });

  it('says so when a glob matches nothing instead of failing the call', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/**/*.nothing'] });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('no matches');
  });
});

describe('apply_patch', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: true, move: true, deleteFile: true });
  });

  it.each([true, false])('returns mismatch guidance with source excerpts only under Read permission (%s)', async read => {
    ctx.caps = withCaps({ read, edit: true });
    const original = 'uniqueAnchor();\nactualSourceOnly();\n';
    await fs.writeFile(path.join(approved, 'diagnostic.txt'), original);
    await fs.writeFile(path.join(approved, 'unchanged.txt'), 'before\n');
    const reply = await backendCall('core', 'apply_patch', [
      '*** Begin Patch', '*** Update File: /workspace/unchanged.txt', '@@', '-before', '+after',
      '*** Update File: /workspace/diagnostic.txt', '@@', ' uniqueAnchor();', '-guessedSource();', '+replacement();',
      '*** End Patch'
    ].join('\n'));
    expect(reply.body.result?.isError).toBe(true);
    const text = textOf(reply);
    expect(text).toContain('Use the current file text as patch context');
    expect(text).toContain('/workspace/diagnostic.txt');
    expect(text).not.toContain(approved);
    expect(text.includes('actualSourceOnly();')).toBe(read);
    expect(text.includes('Source excerpt from the patch verification snapshot')).toBe(read);
    expect(await fs.readFile(path.join(approved, 'diagnostic.txt'), 'utf8')).toBe(original);
    expect(await fs.readFile(path.join(approved, 'unchanged.txt'), 'utf8')).toBe('before\n');
  });

  it('resolves later hunks against files created earlier in the same patch', async () => {
    const reply = await backendCall('core', 'apply_patch', [
        '*** Begin Patch',
        '*** Add File: /workspace/fresh-sequential.ts',
        '+const fresh = 1;',
        '*** Update File: /workspace/fresh-sequential.ts',
        '@@',
        '-const fresh = 1;',
        '+const fresh = 2;',
        '*** End Patch'
      ].join('\n'));
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'fresh-sequential.ts'), 'utf8')).toBe('const fresh = 2;\n');
  });

  it('adds, updates, moves and deletes through one tool', async () => {
    const added = await backendCall('core', 'apply_patch', addPatch('/workspace/scratch.txt', ['first', 'second']));
    expect(added.body.result?.isError).toBeFalsy();
    // A successful Core patch is the pinned upstream `{}`; the file itself is the evidence.
    expect(nativeOf(added)).toBe('{}');
    expect(await fs.readFile(path.join(approved, 'scratch.txt'), 'utf8')).toBe('first\nsecond\n');

    const edited = await backendCall('core', 'apply_patch', ['*** Begin Patch', '*** Update File: /workspace/scratch.txt', '@@', '-second', '+SECOND', '*** End Patch'].join('\n'));
    expect(edited.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'scratch.txt'), 'utf8')).toContain('SECOND');

    const moved = await backendCall('core', 'apply_patch', [
        '*** Begin Patch',
        '*** Update File: /workspace/scratch.txt',
        '*** Move to: /workspace/moved.txt',
        '@@',
        ' SECOND',
        '*** End Patch'
      ].join('\n'));
    expect(moved.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(approved, 'scratch.txt'))).rejects.toThrow();

    const deleted = await backendCall('core', 'apply_patch', ['*** Begin Patch', '*** Delete File: /workspace/moved.txt', '*** End Patch'].join('\n'));
    expect(deleted.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(approved, 'moved.txt'))).rejects.toThrow();
  });

  // Current Codex rejects an entirely empty Update hunk, so a pure rename carries one
  // context-only line. That line changes no content and must not quietly require Edit.
  it('renames without Edit, and still refuses to rewrite content', async () => {
    const source = path.join(approved, 'rename-me.txt');
    const occupied = path.join(approved, 'rename-occupied.txt');
    // A move-only permission must preserve bytes. The default Codex update mode normalizes
    // CRLF to LF, so this catches an implementation that performs a text rewrite just to rename.
    await fs.writeFile(source, 'keep this\r\n', 'utf8');
    await fs.writeFile(occupied, `do not replace${String.fromCharCode(10)}`, 'utf8');
    ctx.caps = withCaps({ move: true, edit: false });

    const overwrite = await backendCall('core', 'apply_patch', [
        '*** Begin Patch',
        '*** Update File: /workspace/rename-me.txt',
        '*** Move to: /workspace/rename-occupied.txt',
        '@@',
        ' keep this',
        '*** End Patch'
      ].join(String.fromCharCode(10)));
    expect(overwrite.body.result?.isError).toBe(true);
    expect(textOf(overwrite)).toContain('Edit files is disabled');
    expect(await fs.readFile(source, 'utf8')).toContain('keep this');
    expect(await fs.readFile(occupied, 'utf8')).toContain('do not replace');

    const moved = await backendCall('core', 'apply_patch', [
        '*** Begin Patch',
        '*** Update File: /workspace/rename-me.txt',
        '*** Move to: /workspace/renamed.txt',
        '@@',
        ' keep this',
        '*** End Patch'
      ].join(String.fromCharCode(10)));
    expect(moved.body.result?.isError, textOf(moved)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'renamed.txt'), 'utf8')).toBe('keep this\r\n');

    const rewritten = await backendCall('core', 'apply_patch', [
        '*** Begin Patch',
        '*** Update File: /workspace/renamed.txt',
        '*** Move to: /workspace/renamed-again.txt',
        '@@',
        '-keep this',
        '+changed',
        '*** End Patch'
      ].join(String.fromCharCode(10)));
    expect(rewritten.body.result?.isError).toBe(true);
    expect(textOf(rewritten)).toContain('TOOL_DISABLED');
    expect(await fs.readFile(path.join(approved, 'renamed.txt'), 'utf8')).toBe('keep this\r\n');
  });

  it('rejects an empty move-only Update hunk, matching current Codex', async () => {
    const source = path.join(approved, 'empty-move-source.txt');
    const target = path.join(approved, 'empty-move-target.txt');
    await fs.writeFile(source, 'keep this\n', 'utf8');

    const reply = await backendCall('core', 'apply_patch', [
        '*** Begin Patch',
        '*** Update File: /workspace/empty-move-source.txt',
        '*** Move to: /workspace/empty-move-target.txt',
        '*** End Patch'
      ].join('\n'));

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain("Update file hunk for path '/workspace/empty-move-source.txt' is empty");
    expect(await fs.readFile(source, 'utf8')).toBe('keep this\n');
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('changes several files in one atomic patch', async () => {
    const a = path.join(approved, 'batch-a.txt');
    const b = path.join(approved, 'batch-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await backendCall('core', 'apply_patch', [
        '*** Begin Patch',
        '*** Update File: /workspace/batch-a.txt',
        '@@',
        '-alpha',
        '+ALPHA',
        '*** Update File: /workspace/batch-b.txt',
        '@@',
        '-beta',
        '+BETA',
        '*** End Patch'
      ].join('\n'));
    expect(reply.body.result?.isError).toBeFalsy();
    expect(nativeOf(reply)).toBe('{}');
    expect(await fs.readFile(a, 'utf8')).toBe('ALPHA\n');
    expect(await fs.readFile(b, 'utf8')).toBe('BETA\n');
  });

  it.runIf(IS_WINDOWS)('rolls back earlier files when a later commit fails after verification', async () => {
    const a = path.join(approved, 'batch-runtime-fail-a.txt');
    const b = path.join(approved, 'batch-runtime-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');
    // Read-only is ideal here: verification and patch matching can still read B, so the failure
    // occurs only at the second runtime write, after A has already committed in raw Codex.
    await fs.chmod(b, 0o444);
    try {
      const reply = await backendCall('core', 'apply_patch', [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-runtime-fail-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-runtime-fail-b.txt',
          '@@',
          '-beta',
          '+BETA',
          '*** End Patch'
        ].join('\n'));
      expect(reply.body.result?.isError).toBe(true);
      expect(textOf(reply)).toContain('rolled back');
      expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
      expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
    } finally {
      await fs.chmod(b, 0o666).catch(() => undefined);
    }
  });

  it('leaves every target untouched when one hunk in the patch does not apply', async () => {
    const a = path.join(approved, 'batch-fail-a.txt');
    const b = path.join(approved, 'batch-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await backendCall('core', 'apply_patch', [
        '*** Begin Patch',
        '*** Update File: /workspace/batch-fail-a.txt',
        '@@',
        '-alpha',
        '+ALPHA',
        '*** Update File: /workspace/batch-fail-b.txt',
        '@@',
        '-missing',
        '+BETA',
        '*** End Patch'
      ].join('\n'));
    expect(reply.body.result?.isError).toBe(true);
    expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
  });

  it('matches Codex Add File semantics and overwrites an existing file', async () => {
    const reply = await backendCall('core', 'apply_patch', addPatch('/workspace/notes.txt', ['clobbered']));
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toBe('clobbered\n');
  });

  it('names the problem when the patch itself is malformed', async () => {
    const reply = await backendCall('core', 'apply_patch', 'just some text');
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain("invalid patch: The first line of the patch must be '*** Begin Patch'");
  });

  it('rejects hidden environment selection in this single-environment adapter like Codex', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Environment ID: other',
      '*** Add File: env-selected.txt',
      '+should-not-land',
      '*** End Patch'
    ].join('\n');
    const reply = await backendCall('core', 'apply_patch', patch);
    expect(reply.body.result?.isError).toBe(true);
    expect(reply.body.result.content[0]).toEqual({ type: 'text', text: 'apply_patch environment selection is unavailable for this turn' });
    await expect(fs.stat(path.join(approved, 'env-selected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps Codex apply_patch output shape for a huge rewrite', async () => {
    const before = Array.from({ length: 1600 }, (_, index) => `old-${index}`);
    await fs.writeFile(path.join(approved, 'rewrite.txt'), `${before.join('\n')}\n`, 'utf8');
    const hunk = [
      '*** Begin Patch',
      '*** Update File: /workspace/rewrite.txt',
      '@@',
      ...before.map((line) => `-${line}`),
      ...before.map((_, index) => `+new-${index}`),
      '*** End Patch'
    ].join('\n');

    const reply = await backendCall('core', 'apply_patch', hunk);
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(nativeOf(reply)).toBe('{}');
    expect(await fs.readFile(path.join(approved, 'rewrite.txt'), 'utf8')).toBe(`${before.map((_, index) => `new-${index}`).join('\n')}\n`);
  });

  it('returns a small image without applying the text-section byte default', async () => {
    const reply = await backendCall('core', 'read', { paths: ['/workspace/pixel.png'] });
    expect(nativeOf(reply)).not.toContain('image is too large to return');
    expect(imageCountOf(reply)).toBe(1);
  });

  it('uses a separate bounded image budget so ordinary screenshots work through read', async () => {
    const target = path.join(approved, 'large-noise.png');
    await sharp(randomBytes(512 * 512 * 4), { raw: { width: 512, height: 512, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toFile(target);

    // A script sees the read tool's own value; the assertion is computed inside the script and only
    // the small result is emitted, because a large image makes the *preview* unreadable while the
    // value the script holds is complete.
    const summarize = (paths: string[]) => `let r;try{r=await tools.read({paths:${JSON.stringify(paths)}});}catch(e){text("ERR "+e.message);throw e;}
      text(JSON.stringify({images:(r.match(/data:image\\/[a-z]+;base64,/g)||[]).length, bytes:(r.match(/base64,([A-Za-z0-9+/=]+)/g)||[]).reduce((n,m)=>n+m.length,0), capped:r.includes('image output cap')}));`;

    const readReply = await core('tools/call', { name: 'exec', arguments: { code: summarize(['/workspace/large-noise.png']) } });
    expect(readReply.body.result?.isError, textOf(readReply)).not.toBe(true);
    expect(JSON.parse(nativeOf(readReply))).toMatchObject({ images: 1, capped: false });

    const imageReply = await backendCall('core', 'view_image', { path: '/workspace/large-noise.png' });
    expect(imageReply.body.result?.isError, textOf(imageReply)).not.toBe(true);
    // The same bytes a script gets from `read` are the ones inside `view_image`'s data URL.
    const large = await core('tools/call', { name: 'exec', arguments: { code:
      `const r=await tools.read({paths:["/workspace/large-noise.png"]});
       const v=await tools.view_image({path:"/workspace/large-noise.png"});
       text(JSON.stringify({same:r.includes(v.image_url), kind:typeof v.image_url}));` } });
    expect(JSON.parse(nativeOf(large))).toEqual({ same: true, kind: 'string' });

    // The per-read image budget is enforced inside the handler, so the contract observable from a
    // script is the count it computed itself: five oversized screenshots admit four images and the
    // value says the cap was hit rather than silently returning fewer.
    const batch = await core('tools/call', { name: 'exec', arguments: { code: summarize([...Array(5).fill('/workspace/large-noise.png'), '/workspace/pixel.png']) } });
    expect(JSON.parse(nativeOf(batch))).toMatchObject({ images: 4, capped: true });
  });

  it('accepts a native filesystem path inside apply_patch', async () => {
    const target = path.join(approved, 'native-patch.txt');
    const patch = [
      '*** Begin Patch',
      `*** Add File: ${target}`,
      '+native-patch-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await backendCall('core', 'apply_patch', patch);
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(target, 'utf8')).toBe('native-patch-ok\n');
    expect(nativeOf(reply)).toBe('{}');
    expect(nativeOf(reply)).not.toContain(approved);
  });

  it('normalizes native filesystem update, move and delete paths inside apply_patch', async () => {
    const source = path.join(approved, 'native-patch-source.txt');
    const moved = path.join(approved, 'native-patch-moved.txt');
    await fs.writeFile(source, 'before\n', 'utf8');

    const movePatch = [
      '*** Begin Patch',
      `*** Update File: ${source}`,
      `*** Move to: ${moved}`,
      '@@',
      '-before',
      '+after',
      '*** End Patch'
    ].join('\n');
    const movedReply = await backendCall('core', 'apply_patch', movePatch);
    expect(movedReply.body.result?.isError, textOf(movedReply)).toBeFalsy();
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(moved, 'utf8')).toBe('after\n');
    expect(nativeOf(movedReply)).toBe('{}');
    expect(nativeOf(movedReply)).not.toContain(approved);

    const deletePatch = ['*** Begin Patch', `*** Delete File: ${moved}`, '*** End Patch'].join('\n');
    const deletedReply = await backendCall('core', 'apply_patch', deletePatch);
    expect(deletedReply.body.result?.isError, textOf(deletedReply)).toBeFalsy();
    await expect(fs.stat(moved)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(nativeOf(deletedReply)).toBe('{}');
    expect(nativeOf(deletedReply)).not.toContain(approved);
  });

  it('does not leak the resolved real path when apply_patch fails after validation', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: /workspace/notes.txt/child.txt',
      '+cannot-land-under-a-file',
      '*** End Patch'
    ].join('\n');
    const reply = await backendCall('core', 'apply_patch', patch);
    expect(reply.body.result?.isError).toBe(true);
    // The host errno text differs here: Windows can retain the safe virtual spelling while
    // POSIX reports ENOTDIR without a path. The invariant is that neither form leaks `approved`.
    expect(textOf(reply)).toMatch(/\/workspace\/notes\.txt\/child\.txt|Filesystem error \(ENOTDIR\)/);
    expect(textOf(reply)).not.toContain(approved);
  });
});

describe('exec_command and write_stdin', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
  });

  it('refuses an approved virtual path in opaque shell text instead of running against the drive root', async () => {
    const reply = await backendCall('core', 'exec_command', { cmd: 'type /workspace/notes.txt', workdir: '/workspace' });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('INVALID_COMMAND_PATH');
    expect(textOf(reply)).toContain('/workspace/notes.txt');
    expect(textOf(reply)).toMatch(/relative path|native filesystem path/i);
    expect(textOf(reply)).toContain('No command was run');
  });

  it('intercepts explicit apply_patch shell invocations through the Codex patch runtime', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: intercepted.txt',
      '+intercepted-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await backendCall('core', 'exec_command', {
      cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH`,
      workdir: '/workspace'
    });

    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'intercepted.txt'), 'utf8')).toBe('intercepted-ok\n');
    expect(terminalOf(reply)).toMatchObject({
      wall_time_seconds: 0,
      output: expect.stringContaining('Success. Updated the following files:')
    });
    expect(terminalOf(reply)).not.toHaveProperty('exit_code');
    expect(terminalOf(reply)).not.toHaveProperty('session_id');
  });

  it('applies intercepted cd workdir exactly once', async () => {
    await fs.mkdir(path.join(approved, 'nested'), { recursive: true });
    const patch = [
      '*** Begin Patch',
      '*** Add File: from-cd.txt',
      '+nested-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await backendCall('core', 'exec_command', {
      cmd: `cd nested && apply_patch <<'PATCH'\n${patch}\nPATCH`,
      workdir: '/workspace'
    });

    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'nested', 'from-cd.txt'), 'utf8')).toBe('nested-ok\n');
    await expect(fs.stat(path.join(approved, 'nested', 'nested', 'from-cd.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a raw patch body passed as command with Codex implicit-invocation wording', async () => {
    const patch = ['*** Begin Patch', '*** Add File: implicit.txt', '+nope', '*** End Patch'].join('\n');
    const reply = await backendCall('core', 'exec_command', { cmd: patch, workdir: '/workspace' });
    expect(reply.body.result?.isError).toBe(true);
    expect(reply.body.result.content[0]).toEqual({ type: 'text', text:
      'apply_patch verification failed: patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]'
    });
    await expect(fs.stat(path.join(approved, 'implicit.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not intercept through a missing cd target that the shell would have rejected', async () => {
    const missing = path.join(approved, 'missing-intercept-cwd');
    const patch = [
      '*** Begin Patch',
      '*** Add File: landed.txt',
      '+must-not-land',
      '*** End Patch'
    ].join('\n');
    const reply = await backendCall('core', 'exec_command', {
      cmd: `cd missing-intercept-cwd && apply_patch <<'PATCH'\n${patch}\nPATCH`,
      workdir: '/workspace'
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/not found/i);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a native filesystem workdir inside an approved root', async () => {
    const reply = await backendCall('core', 'exec_command', {
      cmd: IS_WINDOWS ? 'Write-Output native-workdir-ok' : "printf '%s\\n' native-workdir-ok",
      workdir: approved,
      yield_time_ms: 5_000
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('native-workdir-ok');
  });

  it('uses the shared scrubbed child environment and exposes bundled ripgrep', async () => {
    // Unified exec used to construct a second, almost-identical environment instead of using
    // childEnv(). That copy missed the secret scrubber and the bundled-rg PATH prefix. Both are
    // contract properties, not implementation details: model-run commands must never inherit a
    // connector credential, and `rg` is a runtime the app deliberately ships for those commands.
    const heldSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-must-never-reach-exec-command';
    try {
      const secret = await backendCall('core', 'exec_command', {
        cmd: IS_WINDOWS
          ? "if ($env:OPENAI_API_KEY) { Write-Output 'LEAKED' } else { Write-Output 'SCRUBBED' }"
          : "if [ -n \"${OPENAI_API_KEY:-}\" ]; then printf '%s\\n' LEAKED; else printf '%s\\n' SCRUBBED; fi",
        workdir: '/workspace',
        yield_time_ms: 5_000
      });
      expect(failed(secret), textOf(secret)).toBe(false);
      expect(textOf(secret)).toContain('SCRUBBED');
      expect(textOf(secret)).not.toContain('LEAKED');
    } finally {
      if (heldSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = heldSecret;
    }

    const bundled = locateRipgrep();
    if (!bundled) return;
    const rg = await backendCall('core', 'exec_command', {
      cmd: IS_WINDOWS
        ? "Get-Command rg -CommandType Application | Select-Object -First 1 -ExpandProperty Source"
        : 'command -v rg',
      workdir: '/workspace',
      // A login shell sources the user's own profile, which may legitimately put their
      // PATH ahead of the directory `childEnv()` prepends — that is the user's choice, not
      // this app's contract. `login: false` is what isolates the property under test: the
      // app's own child environment puts the bundled ripgrep first.
      login: false,
      yield_time_ms: 5_000
    });
    expect(failed(rg), textOf(rg)).toBe(false);
    // The process output itself, not its JSON text: a Windows path's backslashes are escaped there.
    expect(String(terminalOf(rg).output).toLowerCase()).toContain(bundled.toLowerCase());
  });

  it.runIf(IS_WINDOWS)('binds bare PowerShell rg to the bundled binary instead of a shadowing function', async () => {
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.writeFile(path.join(approved, 'rg-shadow-target.txt'), 'needle-from-real-ripgrep\n', 'utf8');

    const reply = await backendCall('core', 'exec_command', {
      // A profile function is the live failure mode; defining it inline makes the regression
      // deterministic without touching the user's real PowerShell profile. The app's `rg`
      // contract is the bundled runtime, so this function must never receive the invocation.
      cmd: "function rg { Write-Output 'SHADOWED-RG'; exit 17 }; rg -n needle-from-real-ripgrep rg-shadow-target.txt",
      workdir: '/workspace',
      yield_time_ms: 5_000
    });

    expect(failed(reply), textOf(reply)).toBe(false);
    expect(textOf(reply)).toContain('needle-from-real-ripgrep');
    expect(textOf(reply)).not.toContain('SHADOWED-RG');
    expect(reply.body.result?.structuredContent?.exit_code).toBe(0);
  });

  it.runIf(IS_WINDOWS)('expands a glob for the bundled ripgrep it just bound the command to', async () => {
    // Binding and expanding are two rewrites of the same command and they were composed in
    // the order that cancels one out: binding turns the leading `rg` into `& '<path>'`, which
    // the normalizer no longer recognises as ripgrep, so every ordinary `rg pattern *.txt`
    // went out with the asterisk still in it. Both halves had unit tests and both passed —
    // they were only ever called separately. This is the pair, through the real tool.
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.writeFile(path.join(approved, 'glob-one.rgtxt'), 'needle-through-the-glob\n', 'utf8');
    await fs.writeFile(path.join(approved, 'glob-two.rgtxt'), 'nothing here\n', 'utf8');

    const reply = await backendCall('core', 'exec_command', {
      cmd: 'rg -n needle-through-the-glob *.rgtxt',
      workdir: '/workspace',
      yield_time_ms: 5_000
    });

    expect(failed(reply), textOf(reply)).toBe(false);
    expect(textOf(reply)).toContain('needle-through-the-glob');
    expect(textOf(reply)).toContain('glob-one.rgtxt');
    // The literal asterisk reaching ripgrep is the failure: it reports `os error 123` and the
    // search silently answers nothing.
    expect(textOf(reply)).not.toContain('os error 123');
    expect(reply.body.result?.structuredContent?.exit_code).toBe(0);
  });

  it.runIf(IS_WINDOWS)('normalizes the recorded child-glob and balanced-quote failures through the real tool', async () => {
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.mkdir(path.join(approved, 'test'), { recursive: true });
    await fs.writeFile(path.join(approved, 'test', 'computer-one.test.ts'), 'from "fsops.js"\n', 'utf8');
    await fs.writeFile(path.join(approved, 'test', 'computer-two.test.ts'), 'nothing here\n', 'utf8');

    const glob = await backendCall('core', 'exec_command', {
      cmd: 'rg -n fsops test/computer*.test.ts',
      workdir: '/workspace',
      yield_time_ms: 5_000
    });
    expect(failed(glob), textOf(glob)).toBe(false);
    expect(textOf(glob)).toContain('computer-one.test.ts');
    expect(textOf(glob)).not.toContain('os error 123');

    const quote = await backendCall('core', 'exec_command', {
      cmd: String.raw`rg -n "from ['\"][^'\"]*fsops\.js['\"]" test/computer-one.test.ts`,
      workdir: '/workspace',
      yield_time_ms: 5_000
    });
    expect(failed(quote), textOf(quote)).toBe(false);
    // The process output itself, not its JSON text, where the matched quotes are escaped.
    expect(String(terminalOf(quote).output)).toContain('from "fsops.js"');
    expect(textOf(quote)).not.toContain('regex parse error');
  });

  it('fails closed when an explicit shell name is unknown instead of silently switching languages', async () => {
    const reply = await backendCall('core', 'exec_command', {
      cmd: 'echo must-not-run',
      workdir: '/workspace',
      shell: 'definitely-not-a-shell'
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('SHELL_NOT_FOUND');
    expect(textOf(reply)).toContain('No command was run');
  });

  it.runIf(IS_WINDOWS)('does not replace a missing explicit pwsh path with Windows PowerShell 5.1', async () => {
    const missingPwsh = path.join(approved, 'missing', 'pwsh.exe');
    const reply = await backendCall('core', 'exec_command', {
      cmd: 'Write-Output one && Write-Output two',
      workdir: '/workspace',
      shell: missingPwsh
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('SHELL_NOT_FOUND');
    expect(textOf(reply)).not.toContain('valid statement separator');
  });

  it('advertises the current Codex exec_command and write_stdin schemas', async () => {
    const tools = (await backendTools('core'));
    const exec = tools.find((tool) => tool.name === 'exec_command')!;
    const stdin = tools.find((tool) => tool.name === 'write_stdin')!;

    expect(Object.keys(exec.inputSchema.properties)).toEqual([
      'cmd',
      'operation_id',
      'cmds',
      'workdir',
      'tty',
      'yield_time_ms',
      'max_output_tokens',
      'shell',
      'login'
    ]);
    expect(exec.inputSchema.required ?? []).toEqual([]);
    expect(exec.inputSchema.additionalProperties).toBe(false);
    // The mutation receipt: required for managed work, reused only for an identical retry.
    expect(exec.inputSchema.properties.operation_id.type).toBe('string');
    expect(exec.inputSchema.properties.workdir.type).toBe('string');
    expect(exec.inputSchema.properties.cmds.type).toBe('array');
    expect(exec.inputSchema.properties.cmds.items.type).toBe('string');
    // The batch contract is the schema, not the sentence: `cmds` is an array of strings
    // that `cmd` cannot be combined with (asserted below through the real tool).
    expect(exec.inputSchema.properties.tty.type).toBe('boolean');
    expect(exec.inputSchema.properties.yield_time_ms.type).toBe('number');
    expect(exec.inputSchema.properties.max_output_tokens.type).toBe('number');
    expect(exec.inputSchema.properties.shell.type).toBe('string');
    expect(exec.inputSchema.properties.login.type).toBe('boolean');
    for (const retired of ['cwd', 'env', 'cols', 'rows', 'max_lines']) {
      expect(exec.inputSchema.properties).not.toHaveProperty(retired);
    }
    expect(exec.outputSchema).toMatchObject({
      type: 'object',
      required: ['wall_time_seconds', 'output'],
      additionalProperties: false
    });

    expect(Object.keys(stdin.inputSchema.properties)).toEqual([
      'session_id',
      'operation_id',
      'chars',
      'yield_time_ms',
      'max_output_tokens'
    ]);
    expect(stdin.inputSchema.required).toEqual(['session_id']);
    expect(stdin.inputSchema.additionalProperties).toBe(false);
    expect(stdin.inputSchema.properties.session_id.type).toBe('number');
    // Required for managed work only when this call actually sends input; an empty poll is
    // a status read and needs no receipt.
    expect(stdin.inputSchema.properties.operation_id.type).toBe('string');
    expect(stdin.inputSchema.properties.chars.type).toBe('string');
    expect(stdin.inputSchema.properties.yield_time_ms.type).toBe('number');
    expect(stdin.inputSchema.properties.max_output_tokens.type).toBe('number');
    for (const retired of ['cursor', 'close', 'signal', 'env', 'max_lines']) {
      expect(stdin.inputSchema.properties).not.toHaveProperty(retired);
    }
    expect(stdin.outputSchema).toEqual(exec.outputSchema);
  });

  it('runs cmds sequentially in one shell with labeled per-command exit codes', async () => {
    const commands = IS_WINDOWS
      ? [
          "$measuredBatchValue='same-shell'",
          'Write-Output "value=$measuredBatchValue"; cmd /c exit 7',
          'Write-Output "after=$measuredBatchValue"'
        ]
      : [
          "measuredBatchValue='same-shell'",
          "printf 'value=%s\\n' \"$measuredBatchValue\"; sh -c 'exit 7'",
          "printf 'after=%s\\n' \"$measuredBatchValue\""
        ];
    const reply = await backendCall('core', 'exec_command', {
      cmds: commands,
      workdir: '/workspace',
      yield_time_ms: 5_000
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('--- command 1/3 ---');
    expect(text).toContain('--- command 2/3 ---');
    expect(text).toContain('--- command 3/3 ---');
    expect(text).toContain('--- exit code 7 ---');
    expect(text).toContain('value=same-shell');
    expect(text).toContain('after=same-shell');
    expect(reply.body.result?.structuredContent).toMatchObject({ exit_code: 7 });

    for (const arguments_ of [{}, { cmd: 'echo one', cmds: ['echo two'] }]) {
      const invalid = await backendCall('core', 'exec_command', arguments_);
      expect(failed(invalid), textOf(invalid)).toBe(true);
      expect(textOf(invalid)).toMatch(/exactly one of cmd or cmds/i);
    }
  });

  it('reads a batch exit per command, so one search finding nothing is not a failure', async () => {
    // The batch that `cmds` exists for is several searches at once, and a search that finds
    // nothing exits 1. Handing the wrapper script to the single-command classifier would ask
    // whether a `for` loop is a search, so the batch used to report a plain failure and invite
    // the model to run all of it again — the exact round trip batching was meant to remove.
    const searches = await backendCall('core', 'exec_command', {
      // `notes.txt` is intentionally overwritten by an earlier apply_patch regression in
      // this same end-to-end suite. Search an immutable fixture so the test does not depend
      // on file-order side effects that happened to differ across hosts.
      cmds: ['rg -n "export const name" src/app.ts', 'rg -n "no-such-pattern-anywhere" src/app.ts'],
      workdir: '/workspace',
      yield_time_ms: 8_000
    });
    // A batch reports one exit code for the whole wrapper, and the per-command sections stay in the
    // output: the search that found nothing is visible as its own exit 1 beside the command that
    // matched, which is what lets the model see that only one of the two was empty.
    // The wrapper exits with its last command's code, and a search that found nothing is reported
    // as an expected result rather than a failure — which is the whole point of batching them.
    expect(terminalOf(searches)).toMatchObject({ exit_code: 1, benign_exit: true });
    const searchText = String(terminalOf(searches).output);
    expect(searchText).toContain('--- command 1/2 ---');
    expect(searchText).toContain('export const name');
    expect(searchText).toContain('--- command 2/2 ---');
    expect(searchText).toContain('--- exit code 1 ---');

    // A real failure inside a batch stays a failure and gets no exoneration.
    const broken = await backendCall('core', 'exec_command', {
      cmds: IS_WINDOWS ? ['Write-Output first', 'cmd /c exit 3'] : ["printf '%s\\n' first", "sh -c 'exit 3'"],
      workdir: '/workspace',
      yield_time_ms: 8_000
    });
    expect(terminalOf(broken)).toMatchObject({ exit_code: 3 });
    const brokenText = String(terminalOf(broken).output);
    expect(brokenText).toContain('--- exit code 3 ---');
    expect(brokenText).toContain('first');
  }, 60_000);

  it('returns partial search results without exonerating an unreadable batch path', async () => {
    const result = await backendCall('core', 'exec_command', {
      cmds: ['rg -n "export const name" src/app.ts missing-search-file.ts', 'rg -n "export const name" src/app.ts'],
      workdir: '/workspace', yield_time_ms: 8_000
    });
    // The unreadable path is reported by the tool that hit it, and the partial results from the
    // readable one are still in the same output rather than being discarded with it.
    expect(terminalOf(result)).toMatchObject({ exit_code: 2 });
    const batchText = String(terminalOf(result).output);
    expect(batchText).toContain('export const name');
    expect(batchText).toContain('missing-search-file.ts');
  });

  it.skipIf(!IS_WINDOWS)('scopes parser recovery to its failed batch command after an earlier mutation', async () => {
    const reply = await backendCall('core', 'exec_command', {
      cmds: [
        "Set-Content -LiteralPath batch-parser-proof.txt -Value saved; Write-Output 'ParserError: source text only'",
        "Write-Output 'unterminated"
      ],
      workdir: '/workspace',
      yield_time_ms: 8_000
    });
    const text = textOf(reply);
    expect(text).toContain('Batch: command 2 exited 1; the other command exited 0.');
    expect(text).toContain('Note: Command 2: PowerShell parsed none of the command');
    expect(text).not.toContain('Note: Command 1:');
    expect(text).not.toContain('Note: PowerShell parsed none');
    const proof = await backendCall('core', 'read', { paths: ['/workspace/batch-parser-proof.txt'] });
    expect(textOf(proof)).toContain('saved');
  });

  it('uses Codex response and session semantics for quick and interactive commands', async () => {
    const quick = await backendCall('core', 'exec_command', {
      cmd: IS_WINDOWS ? "Write-Output 'quick-ok'" : "printf '%s\\n' quick-ok",
      workdir: '/workspace',
      yield_time_ms: 5_000
    });
    expect(quick.body.result?.isError).not.toBe(true);
    expect(terminalOf(quick)).toMatchObject({
      exit_code: 0,
      output: expect.stringContaining('quick-ok')
    });
    expect(typeof terminalOf(quick).chunk_id).toBe('string');
    expect(typeof terminalOf(quick).wall_time_seconds).toBe('number');

    await fs.writeFile(
      path.join(approved, 'interactive-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); let n=0; rl.on('line',(line)=>{n++; console.log((n===1?'first=':'second=')+line); if(n===2) rl.close();});\n",
      'utf8'
    );
    const started = await backendCall('core', 'exec_command', {
      cmd: 'node interactive-stdin.cjs',
      workdir: '/workspace',
      tty: true,
      yield_time_ms: 25
    });
    expect(started.body.result?.isError).not.toBe(true);
    const sessionId = sessionIdOf(started);
    expect(Number.isInteger(sessionId)).toBe(true);

    // write_stdin sends bytes exactly as supplied. Without a newline ReadLine must keep waiting.
    const partial = await backendCall('core', 'write_stdin', {
      session_id: sessionId,
      chars: 'raw-no-newline',
      yield_time_ms: 250
    });
    expect(partial.body.result?.isError).not.toBe(true);
    expect(terminalOf(partial).session_id).toBe(sessionId);
    expect(terminalOf(partial)).not.toHaveProperty('exit_code');
    expect(String(terminalOf(partial).output)).not.toContain('first=');

    const first = await backendCall('core', 'write_stdin', { session_id: sessionId, chars: '\r', yield_time_ms: 5_000 });
    expect(first.body.result?.isError).not.toBe(true);
    expect(String(terminalOf(first).output)).toContain('first=raw-no-newline');
    expect(terminalOf(first).session_id).toBe(sessionId);

    const second = await backendCall('core', 'write_stdin', { session_id: sessionId, chars: 'done\r', yield_time_ms: 5_000 });
    expect(second.body.result?.isError).not.toBe(true);
    expect(String(terminalOf(second).output)).toContain('second=done');
    expect(terminalOf(second).exit_code).toBe(0);
    // The process buffer is drained per call; previously delivered output is not replayed.
    expect(String(terminalOf(second).output)).not.toContain('first=raw-no-newline');
  });

  it('runs in workdir and omits the old connector-specific cwd header', async () => {
    const readApp = IS_WINDOWS ? "Get-Content 'src/app.ts'" : "cat 'src/app.ts'";
    const named = await backendCall('core', 'exec_command', { cmd: readApp, workdir: '/workspace', yield_time_ms: 5_000 });
    expect(named.body.result?.isError).not.toBe(true);
    expect(String(terminalOf(named).output)).toContain('export const name = "app";');
    expect(String(terminalOf(named).output)).not.toContain('cwd: /workspace');

    const defaulted = await backendCall('core', 'exec_command', { cmd: readApp, yield_time_ms: 5_000 });
    expect(defaulted.body.result?.isError).not.toBe(true);
    expect(String(terminalOf(defaulted).output)).toContain('export const name = "app";');
    expect(String(terminalOf(defaulted).output)).not.toContain('default — no cwd was given');
  });

  it.runIf(IS_WINDOWS)('preserves Codex raw merged output instead of the retired connector CLIXML rewrite', async () => {
    const payload =
      '#< CLIXML<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">An empty pipe element is not allowed._x000D__x000A_</S></Objs>';
    const reply = await backendCall('core', 'exec_command', {
      cmd: `[Console]::Error.Write('${payload}')`,
      workdir: '/workspace',
      yield_time_ms: 8_000
    });
    expect(reply.body.result?.isError).not.toBe(true);
    // A code-mode caller receives the structured result, whose `output` is the raw merged stream:
    // the CLIXML envelope arrives byte for byte, never rewritten into prose.
    expect(String(terminalOf(reply).output)).toContain(payload);
  });
});

describe('agent-maintained plans over MCP', () => {
  it('uses exact request proof without workers, refuses foreign targets and retired chats', async () => {
    ctx.sessionTools = true;
    ctx.agentTools = false;
    const source = await createSession({ conversationId: 'plan-http-source' });
    const other = await createSession({ conversationId: 'plan-http-other' });
    const args = { plan: [{ step: 'Implement the fix', details: 'Validate session ownership.', status: 'in_progress' }] };
    const send = (requestId: string | null, arguments_: Record<string, unknown> = args) => modernBackend(
      'update_plan', arguments_, requestId ? { 'x-request-id': `${requestId}/att1` } : {});
    expect(failed(await send(null))).toBe(true);
    expect(await readSessionPlan(source.id)).toBeNull();
    const prove = (requestId: string, conversationId = 'plan-http-source') => observeRequestCorrelation({
      requestId, conversationId, sessionId: source.id, messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now()
    });
    expect(prove('wfr_plan_owned')).toBe('stored');
    expect(failed(await send('wfr_plan_owned', { ...args, session_id: other.id }))).toBe(true);
    expect(failed(await send('wfr_plan_owned'))).toBe(false);
    expect((await readSessionPlan(source.id))?.plan).toEqual(args.plan);
    expect(await readSessionPlan(other.id)).toBeNull();
    // The desktop view reads the same current document, without a second plan store.
    const { sessionControlsFor } = await import('../src/main/bridge.js');
    expect((await sessionControlsFor(source.id)).plan?.plan).toEqual(args.plan);
    expect(await rebindSession(source.id, 'plan-http-source', 'plan-http-destination')).toBe(true);
    expect(failed(await send('wfr_plan_owned', { plan: [] }))).toBe(true);
    expect(prove('wfr_plan_destination', 'plan-http-destination')).toBe('stored');
    expect(failed(await send('wfr_plan_destination', { plan: [] }))).toBe(false);
    expect((await readSessionPlan(source.id))?.plan).toEqual([]);
  });

  it('validates the Codex statuses and enforces recording disable after discovery', async () => {
    ctx.sessionTools = true;
    const declaration = (await backendTools('core')).find(tool => tool.name === 'update_plan');
    expect(declaration?.inputSchema.required).toEqual(['plan']);
    expect(declaration?.inputSchema.additionalProperties).toBe(false);
    expect(failed(await backendCall('core', 'update_plan', { plan: [
      { step: 'One', status: 'in_progress' }, { step: 'Two', status: 'in_progress' }
    ] }))).toBe(true);
    ctx.sessionTools = false;
    const disabled = await backendCall('core', 'update_plan', { plan: [] });
    expect(failed(disabled)).toBe(true);
    expect(textOf(disabled)).toContain('Session recording');
  });
});

describe('conversation-independent working directory', () => {
  it('keeps ordinary patch and command locations independent of a proved session project', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, command: true });
    const projectDir = path.join(approved, `project-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(projectDir);
    const project = await addProject(projectDir);
    const session = await createSession({ conversationId: 'project-cwd-chat' });
    await assignSessionProject(session.id, project.id);
    const prove = (requestId: string, tool: string) => observeRequestCorrelation({
      requestId,
      conversationId: 'project-cwd-chat',
      sessionId: session.id,
      messageId: `msg-${requestId}`,
      tool,
      observedAt: Date.now()
    });
    const asSession = (requestId: string, name: string, args: unknown) =>
      modernBackend(name, args, { 'x-request-id': `${requestId}/att1` });

    expect(prove('wfr_project_patch', 'apply_patch')).toBe('stored');
    const patched = await asSession('wfr_project_patch', 'apply_patch', addPatch('project-relative.txt', ['project']));
    expect(failed(patched), textOf(patched)).toBe(false);
    expect(await fs.readFile(path.join(approved, 'project-relative.txt'), 'utf8')).toBe('project\n');

    expect(prove('wfr_project_exec', 'exec_command')).toBe('stored');
    const defaulted = await asSession('wfr_project_exec', 'exec_command', {
      cmd: IS_WINDOWS ? '(Get-Location).Path' : 'pwd',
      yield_time_ms: 5_000
    });
    expect(failed(defaulted), textOf(defaulted)).toBe(false);
    // The process output itself, not its JSON text: a Windows path's backslashes are escaped there.
    expect(String(terminalOf(defaulted).output)).toContain(approved);
    expect(String(terminalOf(defaulted).output)).not.toContain(projectDir);

    expect(prove('wfr_project_explicit', 'exec_command')).toBe('stored');
    const explicit = await asSession('wfr_project_explicit', 'exec_command', {
      cmd: IS_WINDOWS ? '(Get-Location).Path' : 'pwd',
      workdir: projectDir,
      yield_time_ms: 5_000
    });
    expect(failed(explicit), textOf(explicit)).toBe(false);
    expect(String(terminalOf(explicit).output)).toContain(projectDir);
  });
});

describe('exec sessions belong to the chat that opened them', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
    // `session status` lists the running commands, which is the other place one chat could
    // learn another's session ids.
    ctx.sessionTools = true;
    // Ownership is process-global with no natural lifetime boundary, and clearing it can only
    // make the guard more permissive — never the other way round.
    resetExecOwnershipForTests();
  });

  /** What the page reports once it has seen this connector request leave a given chat. */
  const prove = (
    requestId: string,
    conversationId: string,
    sessionId = `session-${conversationId}`
  ) =>
    observeRequestCorrelation({
      requestId,
      conversationId,
      sessionId,
      messageId: `msg-${requestId}`,
      tool: 'exec_command',
      observedAt: Date.now()
    });

  /** A tools/call carrying the `x-request-id` ChatGPT sends, so the caller is identifiable. */
  const asChat = (requestId: string | null, name: string, args: Record<string, unknown>) =>
    modernBackend(
      name, args,
      requestId ? { 'x-request-id': `${requestId}/att1` } : {}
    );

  it('refuses write_stdin from a chat that does not own the session, and keeps serving the one that does', async () => {
    expect(prove('wfr_execown_opener', 'conv-execown-opener')).toBe('stored');
    expect(prove('wfr_execown_stranger', 'conv-execown-stranger')).toBe('stored');

    await fs.writeFile(
      path.join(approved, 'owned-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>{ console.log('echo='+line); if(line==='bye') rl.close(); });\n",
      'utf8'
    );

    const started = await asChat('wfr_execown_opener', 'exec_command', {
      cmd: 'node owned-stdin.cjs',
      workdir: '/workspace',
      tty: true,
      yield_time_ms: 25
    });
    expect(started.body.result?.isError).not.toBe(true);
    const sessionId = Number(terminalOf(started).session_id);
    expect(Number.isInteger(sessionId)).toBe(true);

    // The other chat can name that small integer just as easily as its owner can. Codex never
    // has to think about this because its manager hangs off one conversation's services.
    const stranger = await asChat('wfr_execown_stranger', 'write_stdin', {
      session_id: sessionId,
      chars: 'stolen\r',
      yield_time_ms: 250
    });
    expect(stranger.body.result?.isError).toBe(true);
    expect(textOf(stranger)).toContain(`write_stdin failed for session ${sessionId}`);
    expect(textOf(stranger)).not.toContain('echo=stolen');
    expect(textOf(stranger)).toContain('This refusal concerns this process id, not Read-only mode');
    expect(textOf(stranger)).toContain('EXEC_SESSION_OWNER_MISMATCH');
    expect(textOf(stranger)).not.toContain('may already have delivered');

    // An unresolved request can continue processes it opened itself, but a bare numeric id
    // does not grant custody over a process that belongs to another request/session.
    const unproven = await asChat('wfr_execown_unattributed', 'write_stdin', {
      session_id: sessionId,
      chars: 'anon\r',
      yield_time_ms: 1_000
    });
    expect(unproven.body.result?.isError).toBe(true);
    expect(textOf(unproven)).not.toContain('echo=anon');
    expect(textOf(unproven)).toContain('EXEC_CALLER_UNIDENTIFIED');
    expect(textOf(unproven)).toContain('not Read-only mode');

    expect(prove('wfr_execown_unattributed', 'conv-execown-opener')).toBe('stored');
    const recovered = await asChat('wfr_execown_unattributed', 'write_stdin', {
      session_id: sessionId,
      chars: 'anon\r',
      yield_time_ms: 1_000
    });
    expect(recovered.body.result?.isError).not.toBe(true);
    expect(textOf(recovered)).toContain('echo=anon');


    const owner = await asChat('wfr_execown_opener', 'write_stdin', {
      session_id: sessionId,
      chars: 'bye\r',
      yield_time_ms: 5_000
    });
    expect(owner.body.result?.isError).not.toBe(true);
    expect(textOf(owner)).toContain('echo=bye');
    expect(terminalOf(owner).exit_code).toBe(0);
  });

  it('distinguishes unresolved, anonymous and unavailable process custody and reports identity recovery', async () => {
    const source = await createSession({ conversationId: 'exec-return-owner' });
    expect(prove('wfr_exec_return_owner', 'exec-return-owner', source.id)).toBe('stored');
    noteExecOwner(987001, source.id);
    noteExecOwner(987002, null);
    try {
      const unknown = await asChat('wfr_exec_return_late', 'write_stdin', { session_id: 987001, chars: '' });
      expect(unknown.body.result?.isError).toBe(true);
      expect(textOf(unknown)).toContain('EXEC_CALLER_UNIDENTIFIED');
      expect(prove('wfr_exec_return_late', 'exec-return-owner', source.id)).toBe('stored');
      const recovered = await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(recovered)).toContain('Earlier write_stdin calls were refused');
      expect(textOf(await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] })))
        .not.toContain('Identity recovered');
      const anonymous = await asChat('wfr_exec_return_owner', 'write_stdin', { session_id: 987002, chars: '' });
      expect(textOf(anonymous)).toContain('EXEC_SESSION_ANONYMOUS');
      expect(textOf(anonymous)).toContain('cannot adopt');
      expect(textOf(anonymous)).not.toContain('retry this same');
      const absent = await asChat('wfr_exec_return_owner', 'write_stdin', { session_id: 987003, chars: '' });
      expect(textOf(absent)).toContain('EXEC_SESSION_UNAVAILABLE');
      expect(textOf(absent)).not.toContain('retry this same');
      expect(textOf(await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] })))
        .not.toContain('Identity recovered');
    } finally {
      forgetExecOwner(987001);
      forgetExecOwner(987002);
    }
  });

  it('keeps a live process with the durable session across Compact & Resume and retires A', async () => {
    const chatA = 'f0f00005-1111-4111-8111-111111111111';
    const chatB = 'f0f00006-1111-4111-8111-111111111111';
    const summary = await createSession({ title: 'exec continuation owner', conversationId: chatA });
    expect(prove('wfr_exec_resume_a', chatA, summary.id)).toBe('stored');

    await fs.writeFile(
      path.join(approved, 'resume-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>{ console.log('continued='+line); if(line==='done') rl.close(); });\n",
      'utf8'
    );
    const started = await asChat('wfr_exec_resume_a', 'exec_command', {
      cmd: 'node resume-stdin.cjs',
      workdir: '/workspace',
      tty: true,
      yield_time_ms: 25
    });
    const processId = Number(terminalOf(started).session_id);
    expect(Number.isInteger(processId), textOf(started)).toBe(true);
    expect(execOwner(processId)).toBe(summary.id);

    expect(await rebindSession(summary.id, chatA, chatB)).toBe(true);
    expect(prove('wfr_exec_resume_b', chatB, summary.id)).toBe('stored');

    const continued = await asChat('wfr_exec_resume_b', 'write_stdin', {
      session_id: processId,
      chars: 'done\r',
      yield_time_ms: 5_000
    });
    expect(failed(continued), textOf(continued)).toBe(false);
    expect(textOf(continued)).toContain('continued=done');

    const stale = await asChat('wfr_exec_resume_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(stale)).toBe(true);
    expect(textOf(stale)).toContain('CONVERSATION_SUPERSEDED');
    expect(textOf(stale)).toContain('no local tool was run');
  });

  it('refuses every tool from a chat whose handoff brief has been asked for, until the move is over', async () => {
    resetContinuationsForTests();
    const chatA = 'f0f00007-1111-4111-8111-111111111111';
    const chatB = 'f0f00008-1111-4111-8111-111111111111';
    const summary = await createSession({ title: 'compacting owner', conversationId: chatA });
    expect(prove('wfr_compact_a', chatA, summary.id)).toBe('stored');

    // A filed ticket alone changes nothing: the page may still be stopping the turn.
    const opened = await openContinuationNow(summary.id, chatA, true);
    const beforePrompt = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(beforePrompt), textOf(beforePrompt)).toBe(false);

    // The marked prompt is submitted. From here on the chat's calls are refused — whether the
    // turn Stop was clicked on really ended or, as on 2026-09-01, went on calling tools.
    expect((await beginContinuationSourceSendNow(opened.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(opened.token)).toBe(true);
    const duringHandoff = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(duringHandoff)).toBe(true);
    expect(textOf(duringHandoff)).toContain('COMPACTION_IN_PROGRESS');
    expect(textOf(duringHandoff)).toMatch(/no local tool was run/i);
    expect(textOf(duringHandoff)).toMatch(/write that brief now/i);

    // Still refused once the brief is stored and the replacement chat is on its way.
    await attachSummary(opened.token, 'SUMMARY\n'.repeat(40));
    const afterBrief = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(afterBrief)).toContain('COMPACTION_IN_PROGRESS');

    // The commit hands the refusal over to the superseded attachment for good.
    expect(await rebindSession(summary.id, chatA, chatB)).toBe(true);
    expect(prove('wfr_compact_b', chatB, summary.id)).toBe('stored');
    abortContinuation(opened.token, 'the test moved the session by hand');
    const stale = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(stale)).toBe(true);
    expect(textOf(stale)).toContain('CONVERSATION_SUPERSEDED');
    const fresh = await asChat('wfr_compact_b', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(fresh), textOf(fresh)).toBe(false);
  });

  it('does not let a stale owner inherit a recycled process id during the new exec yield', async () => {
    // Model the real lifetime split directly: the manager has released an exited process id,
    // but the separate ownership registry still carries the chat that used to own it. Force
    // the next allocator pick to reuse that number so the race is deterministic instead of a
    // 1-in-99k lottery.
    await unifiedExecManager.terminateAllProcesses();
    const recycledId = 1_000;
    noteExecOwner(recycledId, 'session-conv-execown-old');
    expect(execOwner(recycledId)).toBe('session-conv-execown-old');
    expect(prove('wfr_execown_old_recycled', 'conv-execown-old')).toBe('stored');
    expect(prove('wfr_execown_new_recycled', 'conv-execown-new')).toBe('stored');

    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // Block in the shell process itself. Spawning a second cold `node` here made this
      // ownership regression depend on hosted-runner process startup rather than on the
      // authority window it is meant to test. The shell is already the exec process and can
      // wait for one line of input without another child at all.
      const holdOpen = IS_WINDOWS
        ? "$line = [Console]::In.ReadLine(); Write-Output ('got=' + $line)"
        : "IFS= read -r line; printf 'got=%s\\n' \"$line\"";

      // Do not await. The process is registered while exec_command spends its initial yield
      // collecting output, which is the exact old authority window.
      const starting = asChat('wfr_execown_new_recycled', 'exec_command', {
        cmd: holdOpen,
        workdir: '/workspace',
        tty: true,
        yield_time_ms: 1_000
      });
      await vi.waitFor(
        () => {
          expect(unifiedExecManager.listProcesses().some((entry) => entry.processId === recycledId)).toBe(true);
        },
        { timeout: 5_000, interval: 10 }
      );

      // Allocation must have removed the stale principal before the new process became
      // writable. The old chat knows this integer from its own previous session, but it no
      // longer has authority over what now happens to occupy that slot.
      expect(execOwner(recycledId)).toBeNull();
      const stolen = await asChat('wfr_execown_old_recycled', 'write_stdin', {
        session_id: recycledId,
        chars: 'stolen\r',
        yield_time_ms: 50
      });
      expect(stolen.body.result?.isError).toBe(true);
      expect(textOf(stolen)).toContain('EXEC_SESSION_UNAVAILABLE');

      const started = await starting;
      expect(started.body.result?.isError, textOf(started)).not.toBe(true);
      expect(Number(terminalOf(started).session_id)).toBe(recycledId);
      expect(execOwner(recycledId)).toBe('session-conv-execown-new');
      expect(textOf(started)).not.toContain('got=');

      // Let the real owner release the shell normally. Besides proving the new principal did
      // receive authority, this keeps cleanup deterministic instead of spending the process
      // manager's kill grace period on an intentionally blocked test process.
      const owner = await asChat('wfr_execown_new_recycled', 'write_stdin', {
        session_id: recycledId,
        chars: 'owner\r',
        yield_time_ms: 5_000
      });
      expect(owner.body.result?.isError, textOf(owner)).not.toBe(true);
      expect(textOf(owner)).toContain('got=owner');
      expect(terminalOf(owner).exit_code).toBe(0);
    } finally {
      random.mockRestore();
      await unifiedExecManager.terminateAllProcesses();
      resetExecOwnershipForTests();
    }
  });

  it('keeps completed output out of unrelated results and serves it only by explicit poll', async () => {
    expect(prove('wfr_background_owner', 'conv-background-owner')).toBe('stored');
    expect(prove('wfr_background_other', 'conv-background-other')).toBe('stored');
    const started = await asChat('wfr_background_owner', 'exec_command', {
      cmd: IS_WINDOWS
        ? "Start-Sleep -Milliseconds 650; Write-Output 'background-e2e-once'; exit 7"
        : "sleep 0.65; printf '%s\\n' background-e2e-once; exit 7",
      workdir: '/workspace',
      yield_time_ms: 250
    });
    expect(failed(started), textOf(started)).toBe(false);
    const sessionId = Number(terminalOf(started).session_id);
    expect(Number.isInteger(sessionId)).toBe(true);

    const owned = new Set([sessionId]);
    await vi.waitFor(() => expect(unifiedExecManager.exitedUnread(owned)).toHaveLength(1), {
      timeout: 5_000,
      interval: 20
    });
    const exitCode = unifiedExecManager.exitedUnread(owned)[0]!.exitCode;
    expect(exitCode).toBe(7);
    expect(unifiedExecManager.exitedUnread(new Set())).toEqual([]);

    const stranger = await asChat('wfr_background_other', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(stranger)).not.toContain(`Background session ${sessionId}`);

    // Nothing pushes that output onto an unrelated read — not even for its own chat. The poll of
    // that exact process id is the only place it appears, and that poll also retires the row.
    const later = await asChat('wfr_background_owner', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(later)).not.toContain('background-e2e-once');
    expect(textOf(later)).not.toContain(`Background session ${sessionId}`);
    expect(unifiedExecManager.exitedUnread(owned)).toHaveLength(1);
    const reread = await asChat('wfr_background_owner', 'write_stdin', { session_id: sessionId, chars: '' });
    expect(failed(reread), textOf(reread)).toBe(false);
    expect(textOf(reread)).toContain('background-e2e-once');
    expect(terminalOf(reread).exit_code).toBe(7);
    expect(unifiedExecManager.exitedUnread(owned)).toEqual([]);
    // The row is retired now, so the same poll replays the retained history instead of draining it.
    const replay = await asChat('wfr_background_owner', 'write_stdin', { session_id: sessionId, chars: '' });
    expect(failed(replay), textOf(replay)).toBe(false);
    expect(terminalOf(replay).output_replayed).toBe(true);
    expect(textOf(replay)).toContain('background-e2e-once');
    const forbidden = await asChat('wfr_background_other', 'write_stdin', { session_id: sessionId, chars: '' });
    expect(failed(forbidden)).toBe(true);
    expect(textOf(forbidden)).not.toContain('background-e2e-once');
    const direct = await asChat('wfr_background_owner', 'exec_command', {
      cmd: IS_WINDOWS ? "Write-Output 'direct-result'; exit 0" : "printf '%s\\n' direct-result",
      workdir: '/workspace', yield_time_ms: 10000
    });
    expect(failed(direct), textOf(direct)).toBe(false);
    const completedId = Number(terminalOf(direct).completed_session_id);
    expect(Number.isInteger(completedId)).toBe(true);
    const directRead = await asChat('wfr_background_owner', 'write_stdin', { session_id: completedId, chars: '' });
    expect(failed(directRead), textOf(directRead)).toBe(false);
    expect(textOf(directRead)).toContain('direct-result');
  });

  it('refuses new commands at the unread-result bound until each one is polled', async () => {
    const conversationId = 'conv-background-admission';
    const sessionIds: number[] = [];

    for (let index = 0; index < MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION; index++) {
      const requestId = `wfr_background_admission_${index}`;
      expect(prove(requestId, conversationId)).toBe('stored');
      const started = await asChat(requestId, 'exec_command', {
        cmd: IS_WINDOWS
          ? `while (!(Test-Path './delivery-release')) { Start-Sleep -Milliseconds 30 }; Write-Output 'owed-${index}'; exit ${index + 1}`
          : `while [ ! -f ./delivery-release ]; do sleep 0.03; done; printf '%s\\n' owed-${index}; exit ${index + 1}`,
        workdir: '/workspace',
        yield_time_ms: 100
      });
      const sessionId = Number(terminalOf(started).session_id);
      expect(Number.isInteger(sessionId), textOf(started)).toBe(true);
      sessionIds.push(sessionId);
    }

    await fs.writeFile(path.join(approved, 'delivery-release'), 'ready');
    await vi.waitFor(
      () => expect(backgroundExecObligations(`session-${conversationId}`).exitedUnread.map((row) => row.processId)).toEqual(
        [...sessionIds].sort((left, right) => left - right)
      ),
      { timeout: 8_000, interval: 25 }
    );

    // The bound is a refusal at the next launch, never automatic output on some unrelated
    // response: nothing is delivered until the owner polls the exact process ids it was given.
    const blockedRequest = 'wfr_background_admission_blocked';
    expect(prove(blockedRequest, conversationId)).toBe('stored');
    const blocked = await asChat(blockedRequest, 'exec_command', {
      cmd: IS_WINDOWS ? "Write-Output 'must-not-run'" : "printf '%s\\n' must-not-run",
      workdir: '/workspace'
    });
    expect(failed(blocked)).toBe(true);
    expect(textOf(blocked)).toContain('EXEC_RESULTS_UNREAD');
    for (const sessionId of sessionIds) expect(textOf(blocked)).toContain(String(sessionId));

    // Polling each one is the lookup path, and it is also what releases the budget.
    for (const sessionId of sessionIds) {
      const polled = await asChat(blockedRequest, 'write_stdin', { session_id: sessionId, chars: '' });
      expect(failed(polled), textOf(polled)).toBe(false);
      expect(textOf(polled)).toContain('owed-');
    }

    const admitted = await asChat(blockedRequest, 'exec_command', {
      cmd: IS_WINDOWS ? "Write-Output 'admitted-after-drain'" : "printf '%s\\n' admitted-after-drain",
      workdir: '/workspace',
      yield_time_ms: 5_000
    });
    expect(failed(admitted), textOf(admitted)).toBe(false);
    expect(textOf(admitted)).toContain('admitted-after-drain');
    await fs.unlink(path.join(approved, 'delivery-release'));
  });

});

describe('the outcome a shell command is recorded with', () => {
  /** Runs `noteExec` the way a tool does, and reports what the recorder would store. */
  const outcomeOf = (
    result: { exitCode: number | null; timedOut?: boolean },
    preset: ToolOutcome | null = null
  ) => {
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: preset,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => noteExec(result));
    // Nothing set means the dispatcher's fallback applies, and for a non-error tool result
    // that fallback is `ok` — which is exactly the bug this covers.
    return context.outcome ?? 'ok';
  };

  it('calls a completed non-zero exit the child’s own failure, not a success', () => {
    expect(outcomeOf({ exitCode: 1 })).toBe('process_exit_nonzero');
    expect(outcomeOf({ exitCode: 3 })).toBe('process_exit_nonzero');
  });

  it('leaves a clean exit and a still-running process alone', () => {
    expect(outcomeOf({ exitCode: 0 })).toBe('ok');
    // Still running: it has not failed yet, and saying it did would be a lie about a
    // dev server that is doing exactly what was asked of it.
    expect(outcomeOf({ exitCode: null })).toBe('ok');
  });

  it('blames this connector for a timeout, not the child', () => {
    expect(outcomeOf({ exitCode: null, timedOut: true })).toBe('tool_internal_error');
    expect(outcomeOf({ exitCode: 1, timedOut: true })).toBe('tool_internal_error');
  });

  it('never overwrites an outcome the tool layer set deliberately', () => {
    expect(outcomeOf({ exitCode: 1 }, 'tool_rejected')).toBe('tool_rejected');
  });

  it('does not let the guard downgrade a command error back to ok', () => {
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: null,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => {
      noteExec({ exitCode: 7 });
      // This is what guard() does when the tool returns a normal ToolResult whose text says
      // the child exited non-zero. The more specific process outcome must survive it.
      noteOutcome('ok');
    });
    expect(context.outcome).toBe('process_exit_nonzero');
  });
});


/**
 * The user's own stop for a ChatGPT turn the page will not stop.
 *
 * The property under test is not "a flag is read" but the whole join: a block is stored against
 * a *conversation*, and the thing arriving over HTTP is a *request id*, so every assertion here
 * goes through the same exact ownership proof the connector uses in production. The two failure
 * directions matter equally — a block that does not reach the rogue chat is useless, and a block
 * that reaches anyone else is worse than useless.
 */
describe('blocked chats', () => {
  const ROGUE = 'conv-blocked-rogue';
  const BYSTANDER = 'conv-innocent-bystander';
  let proofSeq = 0;

  /** Proves one request id belongs to a chat, exactly as the page evidence path would. */
  const owned = (conversationId: string): string => {
    const requestId = `wfr_block_${++proofSeq}`;
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-blocked-chats',
        messageId: `message-block-${proofSeq}`,
        tool: 'read',
        observedAt: Date.now()
      })
    ).toBe('stored');
    return requestId;
  };

  /**
   * The same proof, deliberately late: the page reporting *after* the call has already landed.
   *
   * This is the ordinary order, not an exotic one. A turn's first call races its own evidence,
   * and the wedged page this feature exists for is the slowest reporter there is. The recorder
   * has always waited for exactly this and filed the call under the chat it proves, which is why
   * a blocked chat could be seen running tools in its own timeline.
   */
  const provenLate = (conversationId: string, afterMs: number): string => {
    const seq = ++proofSeq;
    const requestId = `wfr_block_late_${seq}`;
    setTimeout(() => {
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-blocked-chats',
        messageId: `message-block-${seq}`,
        tool: 'read',
        observedAt: Date.now()
      });
    }, afterMs).unref?.();
    return requestId;
  };

  const readAs = (requestId: string | null, virtualPath = '/workspace/notes.txt'): Promise<any> =>
    modernBackend('read', { paths: [virtualPath] }, requestId ? { 'x-request-id': `${requestId}/att1` } : {});

  beforeEach(() => resetBlockedChatsForTests());
  afterAll(() => resetBlockedChatsForTests());

  it('refuses a blocked chat’s call and tells the model to stop instead of retrying', async () => {
    setChatBlocked(ROGUE, true);
    const reply = await readAs(owned(ROGUE));
    const text = textOf(reply);

    expect(failed(reply)).toBe(true);
    expect(text).toContain('CHAT_BLOCKED');
    // The refusal has to end the turn, so it must forbid the retry loop a bare error invites
    // and name the one action that finishes.
    expect(text).toMatch(/no further tool calls/i);
    expect(text).toMatch(/final answer/i);
    // And no work may have happened behind it: the refusal is the whole result.
    expect(text).not.toContain('/workspace/notes.txt');
  });

  it('blocks every tool the chat has, not only the one it was blocked during', async () => {
    ctx.caps = withCaps({ command: true, create: true, edit: true });
    ctx.readOnly = false;
    setChatBlocked(ROGUE, true);

    for (const call of [
      { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } },
      { name: 'exec_command', arguments: { cmd: 'echo rogue', workdir: '/workspace' } },
      { name: 'apply_patch', arguments: { patch: addPatch('/workspace/blocked.txt', ['nope']) } }
    ]) {
      const reply = await modernBackend(call.name, call.arguments, { 'x-request-id': `${owned(ROGUE)}/att1` });
      expect(textOf(reply), call.name).toContain('CHAT_BLOCKED');
    }
    // apply_patch was refused before it ran, not after it wrote.
    await expect(fs.access(path.join(approved, 'blocked.txt'))).rejects.toThrow();
  });

  it('never touches another chat, or a call it cannot place at all', async () => {
    setChatBlocked(ROGUE, true);

    const other = await readAs(owned(BYSTANDER));
    expect(failed(other), textOf(other)).toBe(false);
    expect(textOf(other)).toContain('/workspace/notes.txt');

    // No proof, no conversation, no block. Refusing here would punish an unrelated chat — or
    // a phone — for a turn this app cannot even show was theirs.
    const unproven = await readAs(null);
    expect(failed(unproven)).toBe(false);
    expect(textOf(unproven)).toContain('/workspace/notes.txt');
  });

  it('refuses the call whose page evidence proves the blocked chat only after it arrives', async () => {
    setChatBlocked(ROGUE, true);

    const reply = await readAs(provenLate(ROGUE, 40));

    expect(failed(reply)).toBe(true);
    expect(textOf(reply)).toContain('CHAT_BLOCKED');
    // The point of the whole gate: the file was never read, so there is nothing to file under
    // the blocked chat's timeline afterwards.
    expect(textOf(reply)).not.toContain('/workspace/notes.txt');
  });

  it('still lets a call through when the page never proves it at all', async () => {
    setChatBlocked(ROGUE, true);

    // The wait is bounded by the same window attribution uses, and it ends the same way:
    // unproven is unproven. A phone, or a chat with no extension behind it, is not the rogue
    // turn and is not refused for failing to prove it is not.
    const reply = await readAs('wfr_block_never_proven');

    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('/workspace/notes.txt');
  });

  it('gives the chat its tools back the moment it is released, same request id and all', async () => {
    const requestId = owned(ROGUE);
    setChatBlocked(ROGUE, true);
    expect(textOf(await readAs(requestId))).toContain('CHAT_BLOCKED');

    setChatBlocked(ROGUE, false);
    const after = await readAs(requestId);
    expect(failed(after)).toBe(false);
    expect(textOf(after)).toContain('/workspace/notes.txt');
  });
});
