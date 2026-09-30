import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { closeCorrelationStore, observeRequestCorrelation } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { createRegistrar, dispatch, ok, setManagedToolGate } from '../src/main/mcp/kernel.js';
import { managedToolGate } from '../src/main/work/runtime.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * What the durable-work gate does with a call that names no work.
 *
 * The contract these cases defend is the one that was missing: a call is *managed* because it
 * names a work — explicitly, or through a conversation this ledger has bound to one — and a call
 * that names neither is ordinary coding. It runs under the caller's existing permissions and the
 * approved-root sandbox, and it is never refused for failing to be a worker. That is what makes
 * the connector usable from a phone, a fresh chat, a headless client, or a host whose work ledger
 * has not been restored yet.
 *
 * Nothing here initializes a work runtime, which is exactly the interesting case: no ledger means
 * no managed identity, and an ordinary read or command must still run.
 */

let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('wgpt-admission-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: false, allowUnattributedCalls: true } });
});
afterEach(() => setManagedToolGate(null));
afterAll(async () => {
  await flushRecorder();
  await flushDurable();
  resetSessionStoreForTests();
  resetDurableForTests();
  // The request-ownership ledger is a process-wide SQLite handle under this directory; Windows
  // refuses to delete a file a live connection still holds.
  closeCorrelationStore();
  await removeTempDir(directory);
});

it('runs an unbound absolute-path command as ordinary coding', async () => {
  const target = path.join(directory, 'unbound.txt');
  // The real gate, installed exactly as production installs it.
  setManagedToolGate(managedToolGate);
  const result = await dispatch('exec_command', { cmd: 'mutate', workdir: directory }, null, null, 'core', async () => {
    await fs.writeFile(target, 'unbound effect');
    return ok('written');
  });
  expect(result.isError).not.toBe(true);
  expect(await fs.readFile(target, 'utf8')).toBe('unbound effect');
});

it('refuses a call that names a work the ledger cannot resolve', async () => {
  const conversationId = randomUUID();
  const requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Unrestored host refusal' });
  observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() });
  setManagedToolGate(managedToolGate);
  let handlerRan = false;
  const refused = await dispatch('work_checkpoint', { work_id: randomUUID(), summary: 'x' }, null, requestId, 'core', async () => {
    handlerRan = true;
    return ok('checkpoint ran');
  });
  const text = refused.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  expect(refused.isError).toBe(true);
  // The runtime's own code leads the message, and it is never relabeled as a filesystem error.
  expect(text.startsWith('WORK_SERVICE_UNAVAILABLE:')).toBe(true);
  expect(text).not.toContain('Filesystem error');
  expect(handlerRan).toBe(false);
});

it('rechecks admission between nested actions and gates canonical defaulted arguments', async () => {
  const conversationId = randomUUID();
  const requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Managed nested admission' });
  observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() });
  const target = path.join(directory, 'nested.txt');
  let admitting = true;
  const argumentsSchema = z.object({ text: z.string().default('canonical') }).strict();
  // A nested call re-enters the gate on its own, so a fence that closed while the script was
  // running refuses the second child even though the first was admitted.
  setManagedToolGate(async (input, invoke) => {
    if (!admitting) return { content: [{ type: 'text', text: 'WORK_NOT_RUNNING: paused' }], isError: true };
    if (input.name === 'apply_patch') argumentsSchema.required().parse(input.args);
    return invoke();
  });
  const reg = createRegistrar(null, { roots: [{ name: 'fixture', path: directory }], caps: defaultConfig().capabilities, readOnly: false }, 'core');
  reg.register('apply_patch', { description: 'Admission fixture', inputSchema: argumentsSchema }, async input => {
    await fs.appendFile(target, `${input.text}\n`);
    return ok('written');
  });
  const result = await dispatch('exec', {}, null, requestId, 'core', async () => {
    const parent = currentCall();
    if (!parent) throw new Error('Missing active invocation');
    const first = await reg.invokeNested('apply_patch', {}, parent);
    expect(first.isError).not.toBe(true);
    admitting = false;
    return reg.invokeNested('apply_patch', { text: 'must-not-land' }, parent);
  });
  expect(result.isError).toBe(true);
  expect(await fs.readFile(target, 'utf8')).toBe('canonical\n');
});
