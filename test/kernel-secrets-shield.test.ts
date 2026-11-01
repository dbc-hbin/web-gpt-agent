import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
// What a tool returns reaches ChatGPT with credentials masked, unless the shield is off.
const state = vi.hoisted(() => ({ shield: true as boolean | undefined, projectOff: vi.fn(async (_sessionId: string) => false), log: vi.fn(), warn: vi.fn() }));
vi.mock('../src/main/config.js', async (original) => {
  const actual = await original<typeof import('../src/main/config.js')>();
  const base = actual.defaultConfig();
  return { ...actual, getConfig: () => ({ ...base, ui: { ...base.ui, secretsShield: state.shield } }) };
});
vi.mock('../src/main/projects.js', async (original) => ({
  ...await original<typeof import('../src/main/projects.js')>(), sessionSecretsShieldOff: state.projectOff
}));
vi.mock('../src/main/logger.js', async (original) => ({
  ...await original<typeof import('../src/main/logger.js')>(), logInfo: state.log, logWarn: state.warn
}));
vi.mock('../src/main/session/recorder.js', async (original) => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  freshCallOrigin: (_tool: string, _at: number, request: string | null) => request?.startsWith('req-') ? request.slice(4) : null,
  recordToolCall: async () => null
}));
vi.mock('../src/main/session/correlation.js', async (original) => ({
  ...await original<typeof import('../src/main/session/correlation.js')>(),
  requestCorrelation: (request: string | null) => request?.startsWith('req-') ? { conversationId: request.slice(4), sessionId: `session-${request.slice(4)}` } : null
}));
vi.mock('../src/main/codex/ownership.js', async (original) => ({
  ...await original<typeof import('../src/main/codex/ownership.js')>(),
  executionPrincipal: (request: string | null) => request ? { request } : null
}));
vi.mock('../src/main/session/store.js', async (original) => ({
  ...await original<typeof import('../src/main/session/store.js')>(), conversationAttachment: async () => 'current'
}));
vi.mock('../src/main/session/input.js', () => ({ offerToolInput: async () => ({ messages: [], reminder: '' }), acknowledgeToolInput: async () => undefined, TOOL_INPUT_HEADER: '\n--- New instructions from the user ---\n' }));
import { createRegistrar, dispatch, ok } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { defaultConfig } from '../src/main/config.js';

// Made up for this test; not a real credential.
const KEY = 'sk-proj-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z' + 'A7bC0dE3fG6hI9jK2lM5';
const output = `cat .env\nOPENAI_API_KEY=${KEY}\nPORT=3000`;

function tool(text: string) {
  let call!: (args: object) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  const server = { registerTool: (_name: string, _schema: unknown, callback: typeof call) => { call = callback; } };
  const registrar = createRegistrar(server as never, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'fixture', inputSchema: z.object({}) }, async () => ok(text));
  return (requestId: string | null) => withInboundRequestId(requestId, () => call({}));
}
const text = (result: { content: ReadonlyArray<object> }) => result.content.map(part => 'text' in part ? String(part.text) : '').join('');

beforeEach(() => {
  state.shield = true;
  state.projectOff.mockReset().mockResolvedValue(false);
  state.log.mockReset();
});

it('masks a key in what a tool returns and logs what it hid', async () => {
  const result = await tool(output)('req-chat-a');
  expect(text(result)).not.toContain(KEY);
  expect(text(result)).toContain('OPENAI_API_KEY=[OpenAI key hidden]');
  expect(text(result)).toContain('PORT=3000');
  expect(state.log).toHaveBeenCalledWith('secrets shield: hid 1 OpenAI key in the read result');
});

it('treats a missing setting as on (older settings files)', async () => {
  state.shield = undefined;
  expect(text(await tool(output)('req-chat-a'))).not.toContain(KEY);
});

it('sends the output unchanged when the shield is off in Settings, without asking the project', async () => {
  state.shield = false;
  expect(text(await tool(output)('req-chat-a'))).toContain(KEY);
  expect(state.projectOff).not.toHaveBeenCalled();
});

it('sends the output unchanged in a project whose shield is off, and says so in the log', async () => {
  state.projectOff.mockResolvedValue(true);
  expect(text(await tool(output)('req-chat-a'))).toContain(KEY);
  expect(state.projectOff).toHaveBeenCalledWith('session-chat-a');
  expect(state.log).toHaveBeenCalledWith('secrets shield: off for this chat\'s project; the read result went out with 1 OpenAI key unmasked');
});

it('keeps masking when the project cannot be read', async () => {
  state.projectOff.mockRejectedValue(new Error('The session project is unavailable'));
  expect(text(await tool(output)('req-chat-a'))).not.toContain(KEY);
  expect(state.warn).toHaveBeenCalledWith("secrets shield: could not read this chat's project (The session project is unavailable); masking anyway");
});

it('masks a call no chat could be proven for (no project to ask)', async () => {
  expect(text(await tool(output)(null))).not.toContain(KEY);
  expect(state.projectOff).not.toHaveBeenCalled();
});

it('asks nothing and changes nothing when the output holds no secret (the common case)', async () => {
  expect(text(await tool('all 12 tests passed')('req-chat-a'))).toContain('all 12 tests passed');
  expect(state.projectOff).not.toHaveBeenCalled();
  expect(state.log).not.toHaveBeenCalledWith(expect.stringContaining('secrets shield'));
});

it('masks once, on what the outer call returns, not inside nested calls', async () => {
  const registrar = createRegistrar(null, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'fixture', inputSchema: z.object({}) }, async () => ok(output));
  const result = await dispatch('exec', {}, null, 'req-chat-a', 'core', async () => {
    const child = await registrar.invokeNested('read', {}, currentCall()!);
    // The script inside exec works with the real value (it may need it locally).
    expect(text(child)).toContain(KEY);
    return ok(text(child));
  });
  expect(text(result)).not.toContain(KEY);
  expect(state.log.mock.calls.filter(([line]) => String(line).startsWith('secrets shield'))).toHaveLength(1);
});

it('masks a progress note sent to ChatGPT by the same decision, and keeps it unmasked when the shield is off', async () => {
  const sent: string[] = [];
  const mcpReq = { _meta: { progressToken: 'p-1' }, notify: async (message: { params: { message: string } }) => { sent.push(message.params.message); } };
  const run = () => withInboundRequestId('req-chat-a', () => dispatch('exec', {}, null, 'req-chat-a', 'core', async () => {
    await currentCall()!.notify!({ type: 'text', text: output });
    return ok('done');
  }, undefined, undefined, { sessionId: undefined, mcpReq } as never));
  await run();
  expect(sent.at(-1)).not.toContain(KEY);
  expect(sent.at(-1)).toContain('OPENAI_API_KEY=[OpenAI key hidden]');
  state.projectOff.mockResolvedValue(true);
  await run();
  expect(sent.at(-1)).toContain(KEY);
  expect(state.projectOff).toHaveBeenCalledWith('session-chat-a');
  state.shield = false;
  await run();
  expect(sent.at(-1)).toContain(KEY);
});
