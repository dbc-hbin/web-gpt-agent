import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { flushRecorder, resetRecorderForTests, sessionForConversation } from '../src/main/session/recorder.js';
import * as store from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let root: string;
let endpoint: McpEndpoint;
let sessionId: string;
let requestId: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

beforeEach(async () => {
  root = await makeTempDir('clf-image-recording-');
  initConfigPath(root);
  store.initSessionStore(root);
  resetRecorderForTests();
  const config = defaultConfig();
  await saveConfig(config);
  await fs.writeFile(path.join(root, 'pixel.png'), png);
  const conversationId = randomUUID();
  sessionId = (await sessionForConversation(conversationId))!;
  requestId = randomUUID();
  observeRequestCorrelation({ requestId, conversationId, sessionId, messageId: randomUUID(), observedAt: Date.now(), tool: 'view_image' });
  endpoint = await startMcpServer(() => ({ roots: [{ name: 'workspace', path: root }],
    caps: config.capabilities, readOnly: false, sessionTools: false, agentTools: false }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await endpoint?.stop();
  await flushRecorder();
  await store.flushSessions();
  resetRecorderForTests();
  store.resetSessionStoreForTests();
  await removeTempDir(root);
});

async function callImage() {
  const response = await fetch(endpoint.urls.core, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': requestId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'exec', arguments: { code: 'image(await tools.view_image({path:"/workspace/pixel.png"}));' } } }) });
  expect(response.status).toBe(200);
  const body = (await response.text()).trim();
  const reply = JSON.parse(body.startsWith('{') ? body : [...body.matchAll(/^data:\s*(.*)$/gm)].at(-1)![1]!);
  expect(reply.error).toBeUndefined();
  expect(reply.result.isError).not.toBe(true);
  expect(reply.result.content).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
  const events = await store.readEvents(sessionId, { kinds: ['tool_call'] });
  const event = events.filter(event => event.kind === 'tool_call' && event.call.tool === 'view_image').at(-1)!;
  if (event.kind !== 'tool_call') throw new Error('missing recorded tool call');
  expect(event.call.outcome).toBe('ok');
  expect(event.call.result.text).toBe('');
  return event.call;
}

it('keeps exact image bytes on the wire when the recording quota rejects a preview, then records the next successful preview', async () => {
  // Inject failure at the disk-storage owner; run the real registrar, decoder,
  // dispatcher, recorder and HTTP serialization on both sides of that failure.
  const write = vi.spyOn(store, 'writeAsset').mockRejectedValueOnce(new Error('Global session asset quota exceeded'));
  const missing = await callImage();
  expect(missing.assets).toBeUndefined();
  expect(missing.summary).toMatchObject({ tone: 'warn' });
  write.mockRestore();
  const recorded = await callImage();
  expect(recorded.summary.detail).toBeUndefined();
  expect(recorded.assets).toHaveLength(1);
  expect(await store.readAsset(sessionId, recorded.assets![0]!.id)).toEqual(png);
});

it('exposes a recording write failure without leaking filesystem error text into history or changing the image result', async () => {
  vi.spyOn(store, 'writeAsset').mockRejectedValueOnce(new Error('EACCES: PRIVATE_LOCAL_PATH'));
  const call = await callImage();
  expect(call.summary.tone).toBe('warn');
  expect(JSON.stringify(call)).not.toContain('PRIVATE_LOCAL_PATH');
});

it('retains emitted audio bytes and preserves the MCP response when audio storage fails', async () => {
  const wav = Buffer.alloc(364);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const encoded = wav.toString('base64');
  for (const storageFails of [false, true]) {
    if (storageFails) vi.spyOn(store, 'writeAsset').mockRejectedValueOnce(new Error('Global session asset quota exceeded'));
    const response = await fetch(endpoint.urls.core, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': requestId },
      body: JSON.stringify({ jsonrpc: '2.0', id: storageFails ? 3 : 2, method: 'tools/call',
        params: { name: 'exec', arguments: { code: `audio("data:audio/wav;base64,${encoded}");` } } }) });
    expect(response.status).toBe(200);
    const body = (await response.text()).trim();
    const reply = JSON.parse(body.startsWith('{') ? body : [...body.matchAll(/^data:\s*(.*)$/gm)].at(-1)![1]!);
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).not.toBe(true);
    expect(reply.result.content).toContainEqual({ type: 'audio', mimeType: 'audio/wav', data: encoded });
    const events = await store.readEvents(sessionId, { kinds: ['tool_call'] });
    const event = events.filter(event => event.kind === 'tool_call' && event.call.tool === 'exec').at(-1);
    if (event?.kind !== 'tool_call') throw new Error('missing recorded audio call');
    expect(event.call.outcome).toBe('ok');
    expect(event.call.result.text).not.toContain(encoded);
    if (storageFails) {
      expect(event.call.assets).toBeUndefined();
      expect(event.call.summary.tone).toBe('warn');
    } else {
      expect(event.call.assets).toHaveLength(1);
      expect(event.call.assets![0]!.mimeType).toBe('audio/wav');
      expect(await store.readAsset(sessionId, event.call.assets![0]!.id)).toEqual(wav);
    }
  }
});
