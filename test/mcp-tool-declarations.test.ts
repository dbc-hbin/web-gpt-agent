import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toolSchema, toolSchemaJson } from '../src/main/mcp/tool-declarations.js';
import { registerToolSearch } from '../src/main/mcp/tool-search.js';
import { buildServer, type ToolContext } from '../src/main/mcp/tools.js';
import { createRegistrar, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';


async function rpc(handler: { fetch(request: Request): Promise<Response> }, method: string, params: Record<string, unknown> = {}) {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
    } })
  }));
  const text = await response.text();
  return JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}

it('serves a complete structured find page through direct MCP and discovers its schema', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'find-mcp-page-')));
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'find fixture', version: '1' });
    const ctx: ToolContext = { roots: [{ name: 'workspace', path: root }],
      caps: { ...DEFAULT_CAPABILITIES, search: true }, readOnly: false,
      sessionTools: false, agentTools: false, exposedFinishTool: false };
    const registrar = createRegistrar(server, ctx, 'core');
    registerCoreTools(registrar);
    registerToolSearch(server, () => registrar.catalog());
    return server;
  });
  try {
    await fs.writeFile(path.join(root, 'sample.txt'), 'needle one\nneedle two\n');
    const discovered = await rpc(handler, 'tools/call', { name: 'tools_search', arguments: { names: ['find'] } });
    const schema = JSON.parse(discovered.result.content[0].text).tools[0].outputSchema;
    expect(schema.properties).toHaveProperty('hits');
    expect(schema.properties).toHaveProperty('next_cursor');
    const reply = await rpc(handler, 'tools/call', { name: 'find', arguments: {
      query: 'needle', mode: 'content', path: '/workspace/sample.txt', max_results: 1
    } });
    expect(reply.result.isError, JSON.stringify(reply.result)).not.toBe(true);
    const page = JSON.parse(reply.result.content[0].text);
    expect(page).toEqual(reply.result.structuredContent);
    expect(page).toMatchObject({ hits: [{ path: '/workspace/sample.txt', line: 1 }],
      next_cursor: expect.any(String), page: { returned: 1, total_hits: 2 }, truncated: 'page',
      stopped_because: null, content_file_limit: expect.any(Number) });
  } finally {
    await handler.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('enforces Zod input and output refinements through fresh SDK servers', async () => {
  const input = z.object({ left: z.string().optional(), right: z.string().optional() })
    .refine(value => (value.left === undefined) !== (value.right === undefined), 'choose exactly one');
  const output = z.object({ value: z.string() }).refine(value => value.value !== 'invalid', 'invalid output');
  let calls = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'schema fixture', version: '1' });
    server.registerTool('choose', { inputSchema: toolSchema(input), outputSchema: toolSchema(output) }, async args => {
      calls++;
      const value = (args as { left?: string; right?: string }).left ?? (args as { right: string }).right;
      return { content: [{ type: 'text', text: value }], structuredContent: { value } };
    });
    return server;
  });
  try {
    const first = await rpc(handler, 'tools/list');
    const json = toolSchemaJson(input);
    expect(first.result.tools[0].inputSchema).toEqual({ type: 'object', ...json });
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'yes' } })).result.structuredContent).toEqual({ value: 'yes' });
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'a', right: 'b' } })).result.isError).toBe(true);
    expect(calls).toBe(1);
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'invalid' } })).result.isError).toBe(true);
    expect(calls).toBe(2);
  } finally { await handler.close(); }
});

it('discovers current root-sensitive schemas without publishing internal tools', async () => {
  const ctx: ToolContext = { roots: [{ name: 'first', path: '/unused' }], caps: { ...DEFAULT_CAPABILITIES, read: true }, readOnly: false, sessionTools: false, agentTools: false, exposedFinishTool: false };
  const handler = createMcpHandler(() => buildServer(ctx, 'core'));
  try {
    const listed = await rpc(handler, 'tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('read');
    const first = await rpc(handler, 'tools/call', { name: 'tools_search', arguments: { names: ['read'] } });
    expect(first.result.isError).not.toBe(true);
    expect(JSON.parse(first.result.content[0].text).tools[0].inputSchema.required).toContain('paths');
    expect(first.result.content[0].text).toContain('/first');
    ctx.roots = [{ name: 'second', path: '/unused' }];
    const second = await rpc(handler, 'tools/call', { name: 'tools_search', arguments: { names: ['read'] } });
    expect(second.result.content[0].text).toContain('/second');
    expect(second.result.content[0].text).not.toContain('/first');
  } finally { await handler.close(); }
});

it('shares schemas without capturing the preceding request permission snapshot in handlers', async () => {
  const register = async (read: boolean) => {
    const ctx: ToolContext = { roots: [], caps: { ...DEFAULT_CAPABILITIES, read }, exposedCaps: { ...DEFAULT_CAPABILITIES, read: true }, readOnly: false, sessionTools: false, agentTools: false, exposedFinishTool: false };
    const server = new McpServer({ name: 'permission fixture', version: '1' });
    const registrar = createRegistrar(server, ctx, 'core');
    let invoke!: (args: never) => Promise<ToolResult>;
    registrar.register = (name, _config, handler) => { if (name === 'view_image') invoke = handler; };
    registerCoreTools(registrar);
    await server.close();
    // Empty approved roots refuse before filesystem access when permission is on.
    return invoke({ path: '/unapproved/image.png' } as never);
  };
  expect(JSON.stringify(await register(false))).toContain('TOOL_DISABLED');
  expect(JSON.stringify(await register(true))).not.toContain('TOOL_DISABLED');
  expect(JSON.stringify(await register(false))).toContain('TOOL_DISABLED');
});

it('paginates summaries without schemas and returns exact referenced schemas by quoted name', async () => {
  const catalog = ['a-quoted"tool', 'b-tool'].map(name => ({ name, description: 'Inspect retained records',
    inputSchema: { type: 'object', properties: { value: { $ref: '#/$defs/value' } }, $defs: { value: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', properties: { found: { type: 'boolean' } } }, _meta: { fixture: 'exact' } }));
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'discovery', version: '1' });
    registerToolSearch(server, () => catalog);
    return server;
  });
  try {
    const search = async (args: Record<string, unknown>) => (await rpc(handler, 'tools/call', { name: 'tools_search', arguments: args })).result;
    const summary = JSON.parse((await search({ limit: 1 })).content[0].text);
    expect(summary).toMatchObject({ total: 2, next_offset: 1, tools: [{ name: catalog[0]!.name }] });
    expect(summary.tools[0].inputSchema).toBeUndefined();
    expect(summary.tools[0].call).toBe(`tools[${JSON.stringify(catalog[0]!.name)}]`);
    const next = JSON.parse((await search({ limit: 1, offset: summary.next_offset })).content[0].text);
    expect(next).toMatchObject({ next_offset: null, tools: [{ name: 'b-tool' }] });
    const exact = JSON.parse((await search({ names: [catalog[0]!.name] })).content[0].text);
    expect(exact.tools[0]).toEqual({ ...catalog[0], call: summary.tools[0].call });
    expect((await search({ names: ['missing'] })).isError).toBe(true);
    expect((await search({ names: ['b-tool'], query: 'Inspect' })).isError).toBe(true);
    expect((await search({ limit: 21 })).isError).toBe(true);
  } finally { await handler.close(); }
});

it('refreshes cached discovery after in-place metadata changes and permission removal', async () => {
  const catalog = [
    { name: 'z-tool', description: 'Inspect alpha records', inputSchema: { type: 'object' } },
    { name: 'a-tool', description: 'Inspect beta records', inputSchema: { type: 'object' } }
  ];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'changing-discovery', version: '1' });
    registerToolSearch(server, () => catalog);
    return server;
  });
  try {
    const search = async (args: Record<string, unknown>) => (await rpc(handler, 'tools/call', { name: 'tools_search', arguments: args })).result;
    expect(JSON.parse((await search({ query: 'alpha' })).content[0].text).tools.map((tool: { name: string }) => tool.name)).toEqual(['z-tool']);
    catalog[0]!.description = 'Inspect gamma records';
    catalog.reverse();
    expect(JSON.parse((await search({ query: 'alpha' })).content[0].text).tools).toEqual([]);
    expect(JSON.parse((await search({ query: 'gamma' })).content[0].text).tools.map((tool: { name: string }) => tool.name)).toEqual(['z-tool']);
    expect(JSON.parse((await search({})).content[0].text).tools.map((tool: { name: string }) => tool.name)).toEqual(['a-tool', 'z-tool']);
    catalog.pop();
    expect((await search({ names: ['z-tool'] })).isError).toBe(true);
    expect(JSON.parse((await search({})).content[0].text).tools.map((tool: { name: string }) => tool.name)).toEqual(['a-tool']);
  } finally { await handler.close(); }
});

it('bounds schema pages without ever clipping a schema and refuses an oversized single declaration', async () => {
  const catalog = ['a', 'b'].map(name => ({ name, description: 'Large exact schema', inputSchema: { type: 'object', description: '한"'.repeat(7_000) } }));
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'bounded-discovery', version: '1' });
    registerToolSearch(server, () => catalog);
    return server;
  });
  try {
    const search = async (args: Record<string, unknown>) => (await rpc(handler, 'tools/call', { name: 'tools_search', arguments: args })).result;
    const first = await search({ query: 'exact' });
    expect(Buffer.byteLength(first.content[0].text)).toBeLessThanOrEqual(64 * 1024);
    const page = JSON.parse(first.content[0].text);
    expect(page).toMatchObject({ total: 2, next_offset: 1 });
    expect(page.tools).toEqual([{ ...catalog[0], call: 'tools["a"]' }]);
    const next = JSON.parse((await search({ query: 'exact', offset: page.next_offset })).content[0].text);
    expect(next).toMatchObject({ next_offset: null, tools: [{ name: 'b' }] });
    catalog[0]!.inputSchema.description = 'x'.repeat(70_000);
    const oversized = await search({ names: ['a'] });
    expect(oversized.isError).toBe(true);
    expect(oversized.content[0].text).toContain('TOOL_SEARCH_TOO_LARGE');
  } finally { await handler.close(); }
});
