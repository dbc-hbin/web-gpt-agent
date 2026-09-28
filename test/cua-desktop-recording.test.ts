import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { createSession, flushSessions, initSessionStore, readEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';
import { CUA_ALLOWED_TOOLS, CUA_READ_ONLY_TOOLS } from '../src/main/cua/catalog.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeAll(async () => {
  dir = await makeTempDir('cua-desktop-recording-');
  initConfigPath(dir); initSessionStore(dir);
  await saveConfig(defaultConfig());
});
afterAll(async () => {
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await removeTempDir(dir);
});

describe('CUA Desktop recording', () => {
  it('keeps private values out of CUA session summaries across accepted and rejected calls', () => {
    const secret = 'private-input-fixture-do-not-record-in-summary';
    for (const tool of CUA_ALLOWED_TOOLS) {
      const args = { text: secret, value: secret, key: secret, action: secret, app: secret, window: { id: 1, app: secret, title: secret } };
      const summary = summarizeToolCall({ tool, args, evidence: emptyEvidence(), outcome: 'ok', durationMs: 1 });
      const kind = tool.startsWith('clipboard_') ? 'clipboard' : CUA_READ_ONLY_TOOLS.includes(tool) ? 'screen' : 'input';
      expect(summary.kind, tool).toBe(kind);
      expect(JSON.stringify(summary), tool).not.toContain(secret);
      const refused = summarizeToolCall({ tool, args, evidence: emptyEvidence(), outcome: 'tool_rejected', durationMs: 1 });
      expect(JSON.stringify(refused), tool).not.toContain(secret);
    }
  });

  it('redacts standalone clipboard writes and both textual/structured reads in real stored session events', async () => {
    const conversationId = 'cua-recording-privacy';
    const session = await createSession({ title: 'CUA recording fixture', conversationId });
    const secret = 'clipboard-fixture-confidential-value';
    const common = { conversationId, sessionId: session.id, durationMs: 1, startedAt: Date.now(), outcome: 'ok' as const };
    const write = await recordToolCall({ ...common, tool: 'clipboard_write', args: { text: secret, value: secret }, content: [{ type: 'text', text: 'Clipboard updated.' }] });
    const read = await recordToolCall({ ...common, tool: 'clipboard_read', args: {}, content: [{ type: 'text', text: secret }], protocolResult: { structuredContent: { value: secret }, content: [{ type: 'text', text: secret }] } });
    const failedRead = await recordToolCall({ ...common, tool: 'clipboard_read', args: {}, outcome: 'tool_rejected', content: [{ type: 'text', text: secret }] });
    expect(write).not.toBeNull(); expect(read).not.toBeNull(); expect(failedRead).not.toBeNull();
    expect(JSON.stringify(write!.args)).toContain('characters not stored');
    expect(JSON.stringify(read!.result)).toContain('clipboard text not stored');
    expect(JSON.stringify(failedRead!.summary)).toContain('clipboard text not stored');
    await flushSessions();
    const events = await readEvents(session.id, { kinds: ['tool_call'] });
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(secret);
    // Inspect persisted shards too: hiding a value in the readback projection is insufficient.
    const sessionDir = path.join(dir, 'sessions', session.id);
    for (const entry of await fs.readdir(sessionDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await fs.readFile(path.join(entry.parentPath, entry.name));
      expect(bytes.includes(Buffer.from(secret)), entry.name).toBe(false);
    }
  });
});
