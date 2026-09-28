import { beforeEach, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { externalSchemaHash } from '../src/main/plugins/external-declaration.js';

type Connection = { generation: string; mcp: { command: string; args: string[]; environment: Array<{ name: string; value: string }> } };
type HostFixture = { stopCount: number; destroyed: boolean; exit: PromiseWithResolvers<void> };
type ClientFixture = { onclose?: () => void; closeCount: number };
const state = vi.hoisted(() => ({
  hosts: [] as HostFixture[], clients: [] as ClientFixture[],
  startGate: null as PromiseWithResolvers<void> | null,
  startEntered: null as PromiseWithResolvers<void> | null,
  actionGate: null as PromiseWithResolvers<void> | null,
  actionEntered: null as PromiseWithResolvers<void> | null,
  actionCalls: 0,
  failStart: false
}));

const location = { binaryPath: '/bundled/cua-driver', sdkModule: '@trycua/cua-driver/embedded' };
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal(), access: vi.fn(async () => undefined) }));
vi.mock('@trycua/cua-driver/embedded', () => ({
  EmbeddedCuaDriverHost: class {
    stopCount = 0;
    destroyed = false;
    exit = Promise.withResolvers<void>();
    constructor(_binary: string, _bundleId: string) { state.hosts.push(this); }
    async start(): Promise<Connection> {
      state.startEntered?.resolve();
      await state.startGate?.promise;
      if (state.failStart) throw new Error('child could not start');
      return { generation: 'child-1', mcp: { command: 'fake-proxy', args: [], environment: [] } };
    }
    async stop(): Promise<void> { this.stopCount++; this.exit.resolve(); }
    waitForExit(_generation: string): Promise<void> { return this.exit.promise; }
    uniffiDestroy(): void { this.destroyed = true; }
  }
}));
vi.mock('@modelcontextprotocol/client/stdio', () => ({ StdioClientTransport: class {} }));
const tools: Tool[] = [
  { name: 'list_windows', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'check_permissions', inputSchema: { type: 'object', properties: { prompt: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'health_report', inputSchema: { type: 'object', properties: { include: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } }
];
vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    onclose?: () => void;
    closeCount = 0;
    constructor() { state.clients.push(this); }
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: Tool[] }> { return { tools }; }
    async callTool({ name }: { name: string }): Promise<{
      content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>
    }> {
      if (name === 'health_report') return { content: [], structuredContent: { checks: [{ name: 'bundle_identity', status: 'pass',
        data: { configured_bundle_identifier: 'com.webgptagent.app', identity_source: 'parent_application' } }] } };
      if (name === 'check_permissions') return { content: [], structuredContent: { screen_recording: true, accessibility: true,
        source: { attribution: 'host', host_bundle_id: 'com.webgptagent.app' } } };
      state.actionCalls++;
      state.actionEntered?.resolve();
      await state.actionGate?.promise;
      return { content: [{ type: 'text', text: 'window details' }] };
    }
    async close(): Promise<void> { this.closeCount++; }
  }
}));

beforeEach(() => {
  // The production runtime is a process singleton. A fresh module models a new backend for each
  // lifecycle transition without adding a test-only reset hook to production code.
  vi.resetModules();
  state.hosts.length = 0; state.clients.length = 0;
  state.startGate = null; state.startEntered = null;
  state.actionGate = null; state.actionEntered = null; state.failStart = false;
  state.actionCalls = 0;
});

it('stops an app-owned child that finishes startup only after shutdown begins', async () => {
  state.startGate = Promise.withResolvers<void>();
  state.startEntered = Promise.withResolvers<void>();
  const runtime = await import('../src/main/cua/runtime.js');
  const starting = runtime.startEmbeddedCua(location);
  await state.startEntered.promise;
  const stopping = runtime.stopEmbeddedCua();
  state.startGate.resolve();
  await Promise.all([starting, stopping]);
  expect(runtime.embeddedCuaCatalog()).toBeNull();
  expect(runtime.embeddedCuaStatus().ready).toBe(false);
  expect(state.hosts).toHaveLength(1);
  expect(state.hosts[0]).toMatchObject({ stopCount: 1, destroyed: true });
});

it('drains a dispatched call before restart and refuses old-generation dispatch', async () => {
  const runtime = await import('../src/main/cua/runtime.js');
  await runtime.startEmbeddedCua(location);
  const catalog = runtime.embeddedCuaCatalog()!;
  state.actionGate = Promise.withResolvers<void>();
  state.actionEntered = Promise.withResolvers<void>();
  const expected = { generation: catalog.generation, schemaHash: externalSchemaHash(catalog.tools.find(tool => tool.name === 'list_windows')!) };
  const inFlight = runtime.invokeEmbeddedCua('list_windows', {}, expected);
  await state.actionEntered.promise;
  const restart = runtime.restartEmbeddedCua();
  await Promise.resolve();
  expect(runtime.embeddedCuaCatalog()).toBeNull();
  let completed = false;
  void restart.then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(state.hosts[0]?.stopCount).toBe(0);
  state.actionGate.resolve();
  await expect(inFlight).rejects.toThrow('generation changed after dispatch');
  await restart;
  expect(state.hosts[0]).toMatchObject({ stopCount: 1, destroyed: true });
  expect(runtime.embeddedCuaCatalog()?.generation).not.toBe(catalog.generation);
  await expect(runtime.invokeEmbeddedCua('list_windows', {}, expected)).rejects.toThrow('MCP_CONNECTION_REPLACED');
  expect(state.actionCalls).toBe(1);
  await runtime.stopEmbeddedCua();
});

it('publishes unknown/error on failure or child exit, then recovers on explicit restart', async () => {
  const runtime = await import('../src/main/cua/runtime.js');
  state.failStart = true;
  await runtime.startEmbeddedCua(location);
  expect(runtime.embeddedCuaCatalog()).toBeNull();
  expect(runtime.getEmbeddedCuaPermissions()).toMatchObject({ screen: 'unknown', accessibility: 'unknown', error: expect.stringContaining('child could not start') });
  state.failStart = false;
  await runtime.restartEmbeddedCua();
  expect(runtime.getEmbeddedCuaPermissions()).toMatchObject({ screen: 'granted', accessibility: 'granted', error: null });
  const crashed = Promise.withResolvers<void>();
  const unsubscribe = runtime.onEmbeddedCuaChanged(() => {
    if (runtime.embeddedCuaStatus().error?.includes('exited unexpectedly')) crashed.resolve();
  });
  state.hosts.at(-1)!.exit.resolve();
  await crashed.promise;
  unsubscribe();
  expect(runtime.embeddedCuaCatalog()).toBeNull();
  expect(runtime.getEmbeddedCuaPermissions()).toMatchObject({ screen: 'unknown', accessibility: 'unknown', error: expect.stringContaining('exited unexpectedly') });
  await runtime.restartEmbeddedCua();
  expect(runtime.embeddedCuaCatalog()).not.toBeNull();
  expect(runtime.getEmbeddedCuaPermissions()).toMatchObject({ screen: 'granted', accessibility: 'granted', error: null });
  await runtime.stopEmbeddedCua();
});
