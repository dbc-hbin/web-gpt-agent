/**
 * Durable mutation receipts.
 *
 * Every case here is a boundary a caller cannot see from the happy path: a retried call that
 * must not execute twice, a reused id that must not become a second command, a host that died
 * between an external side effect and its result, and a patch that landed only halfway.
 *
 * The ledger is the real one over an in-memory port; patch hashes are computed against a real
 * temporary filesystem, because the whole point of the hash verdicts is that they describe real
 * bytes.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  canonicalOperationHash,
  capturePatchAfterHashes,
  capturePatchBeforeHashes,
  createMemoryOperationPort,
  createOperationLedger,
  hashPathBlob,
  hashTextBlob,
  type OperationAdmissionInput,
  type OperationLedger,
  type OperationLedgerPort
} from '../src/main/work/operations.js';

let directory: string;
let port: OperationLedgerPort;
let ledger: OperationLedger;

const WORK = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const SESSION = '2026-01-01-abcdef01';

beforeEach(async () => {
  directory = await makeTempDir('wgpt-operations-');
  port = createMemoryOperationPort([{
    work_id: WORK,
    work_status: 'running',
    agent_id: AGENT,
    agent_generation: 3,
    agent_state: 'active'
  }]);
  ledger = createOperationLedger({ port });
});

afterEach(async () => {
  await removeTempDir(directory);
});

function admission(overrides: Partial<OperationAdmissionInput> = {}): OperationAdmissionInput {
  return {
    operationId: randomUUID(),
    workId: WORK,
    agentId: AGENT,
    generation: 3,
    tool: 'exec_command',
    args: { cmd: 'echo hi', workdir: '/tmp' },
    sessionId: SESSION,
    ...overrides
  };
}

describe('admission', () => {
  it('admits a new operation as prepared and records it durably before any side effect', async () => {
    const input = admission();
    const result = await ledger.admit(input);
    expect(result.kind).toBe('admitted');
    const stored = ledger.get(input.operationId);
    expect(stored?.state).toBe('prepared');
    expect(stored?.args_hash).toBe(canonicalOperationHash('exec_command', input.args));
    expect(stored?.session_id).toBe(SESSION);
  });

  it('refuses a stale generation before looking up any receipt', async () => {
    const result = await ledger.admit(admission({ generation: 2 }));
    expect(result).toMatchObject({ kind: 'rejected', code: 'STALE_AGENT_GENERATION' });
  });

  it('refuses a mutation for a work that is not running', async () => {
    const paused = createOperationLedger({
      port: createMemoryOperationPort([{
        work_id: WORK, work_status: 'paused', agent_id: AGENT, agent_generation: 3, agent_state: 'active'
      }])
    });
    const result = await paused.admit(admission());
    expect(result).toMatchObject({ kind: 'rejected', code: 'WORK_NOT_RUNNING' });
  });

  it('refuses an unknown agent with a state-unavailable refusal, never an implicit admit', async () => {
    const empty = createOperationLedger({ port: createMemoryOperationPort() });
    const result = await empty.admit(admission());
    expect(result).toMatchObject({ kind: 'rejected', code: 'STATE_UNAVAILABLE' });
  });
});

describe('replay', () => {
  it('joins a completed operation with the same id and arguments instead of running again', async () => {
    const input = admission();
    const first = await ledger.admit(input);
    expect(first.kind).toBe('admitted');
    ledger.markRunning(input.operationId);
    await ledger.complete({ operationId: input.operationId, result: { content: [{ type: 'text', text: 'marker-1' }] }, sessionId: SESSION });
    // A persisted receipt from before raw-plugin scope was introduced must still replay.
    port.updateOperation(input.operationId, { args_hash: createHash('sha256')
      .update('{"tool":"exec_command","args":{"cmd":"echo hi","workdir":"/tmp"}}').digest('hex') });

    const second = await ledger.admit(input);
    expect(second.kind).toBe('joined');
    if (second.kind !== 'joined') throw new Error('expected join');
    expect(second.replay?.content[0]).toMatchObject({ type: 'text', text: 'marker-1' });
  });

  it('rejects the same id with different arguments rather than executing a second command', async () => {
    const input = admission();
    await ledger.admit(input);
    const conflict = await ledger.admit({ ...input, args: { cmd: 'echo different', workdir: '/tmp' } });
    expect(conflict).toMatchObject({ kind: 'rejected', code: 'OPERATION_ID_CONFLICT' });
  });

  it('treats a different operation id as a genuinely new operation', async () => {
    const first = await ledger.admit(admission());
    const second = await ledger.admit(admission());
    expect(first.kind).toBe('admitted');
    expect(second.kind).toBe('admitted');
    expect(first.kind === 'admitted' && second.kind === 'admitted' && first.operationId !== second.operationId).toBe(true);
  });

  it('joins an in-flight operation to the original promise while it is still running', async () => {
    const input = admission();
    const first = await ledger.admit(input);
    expect(first.kind).toBe('admitted');
    ledger.markRunning(input.operationId);
    let release!: () => void;
    const pending = new Promise<{ content: Array<{ type: 'text'; text: string }> }>(resolve => {
      release = () => resolve({ content: [{ type: 'text', text: 'original-result' }] });
    });
    ledger.track(input.operationId, pending as never);

    const second = await ledger.admit(input);
    expect(second.kind).toBe('joined');
    if (second.kind !== 'joined') throw new Error('expected join');
    expect(second.pending).toBe(pending);
    release();
  });
});

describe('outcome_unknown', () => {
  it('refuses to replay an unknown operation until a decision is recorded', async () => {
    const input = admission();
    await ledger.admit(input);
    ledger.markRunning(input.operationId);
    ledger.markUnknown(input.operationId, 'the host died after dispatch');

    const retry = await ledger.admit(input);
    expect(retry).toMatchObject({ kind: 'rejected', code: 'OPERATION_UNKNOWN_UNRESOLVED' });
    expect(ledger.get(input.operationId)?.state).toBe('outcome_unknown');
  });

  it('accepts observed effects without fabricating a result and never runs it again', async () => {
    const input = admission();
    await ledger.admit(input);
    ledger.markRunning(input.operationId);
    ledger.markUnknown(input.operationId, 'ambiguous');
    const resolved = ledger.resolveUnknown({
      operationId: input.operationId,
      decision: 'accept_observed_effects',
      note: 'the marker file exists',
      byCommand: randomUUID()
    });
    expect(resolved).toMatchObject({ ok: true });

    const again = await ledger.admit(input);
    expect(again.kind).toBe('joined');
    if (again.kind !== 'joined') throw new Error('expected join');
    expect(again.replay?.isError).toBe(true);
    expect(again.replay?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('OPERATION_EFFECTS_ACCEPTED') });
  });

  it('authorizes exactly one retry under a fresh operation id linked to the unknown row', async () => {
    const input = admission();
    await ledger.admit(input);
    ledger.markRunning(input.operationId);
    ledger.markUnknown(input.operationId, 'ambiguous');
    const retryId = randomUUID();
    const resolved = ledger.resolveUnknown({
      operationId: input.operationId,
      decision: 'authorize_retry',
      note: 'the user confirmed nothing landed',
      byCommand: randomUUID(),
      retryOperationId: retryId
    });
    expect(resolved).toMatchObject({ ok: true, retryOperationId: retryId });

    const retry = await ledger.admit(input);
    expect(retry).toMatchObject({ kind: 'retry', retryOperationId: retryId });

    // The fresh id is a real operation; the old row keeps its unknown state and audit.
    const fresh = await ledger.admit({ ...input, operationId: retryId });
    expect(fresh.kind).toBe('admitted');
    expect(ledger.get(input.operationId)?.state).toBe('outcome_unknown');
    expect(ledger.get(input.operationId)?.resolution?.decision).toBe('authorize_retry');
  });

  it('rejects a second resolution of the same unknown operation', async () => {
    const input = admission();
    await ledger.admit(input);
    ledger.markUnknown(input.operationId, 'ambiguous');
    const first = ledger.resolveUnknown({
      operationId: input.operationId,
      decision: 'accept_observed_effects',
      note: 'ok',
      byCommand: randomUUID()
    });
    const second = ledger.resolveUnknown({
      operationId: input.operationId,
      decision: 'authorize_retry',
      note: 'again',
      byCommand: randomUUID(),
      retryOperationId: randomUUID()
    });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: 'OPERATION_ID_CONFLICT' });
  });
});

describe('patch recovery', () => {
  it('distinguishes a patch that fully landed from one that did not land at all', async () => {
    const file = path.join(directory, 'target.txt');
    await fs.writeFile(file, 'before\n');
    const before = await capturePatchBeforeHashes(['target.txt'], directory);

    // Nothing written yet: the verdict is all_before.
    const untouched = await capturePatchAfterHashes(before, directory);
    expect(untouched.summary).toBe('all_before');

    await fs.writeFile(file, 'after\n');
    const landed = await capturePatchAfterHashes(before, directory);
    expect(landed.summary).toBe('all_after');
    expect(landed.after['target.txt']).toBe(hashTextBlob('after\n'));
  });

  it('reports mixed when only some of the patch landed', async () => {
    await fs.writeFile(path.join(directory, 'a.txt'), 'a-before\n');
    await fs.writeFile(path.join(directory, 'b.txt'), 'b-before\n');
    const before = await capturePatchBeforeHashes(['a.txt', 'b.txt'], directory);
    await fs.writeFile(path.join(directory, 'a.txt'), 'a-after\n');
    const after = await capturePatchAfterHashes(before, directory);
    expect(after.summary).toBe('mixed');
  });

  it('hashes a deletion as an absent path and a symlink by its link text', async () => {
    const file = path.join(directory, 'gone.txt');
    await fs.writeFile(file, 'x\n');
    expect(await hashPathBlob(file)).toBe(hashTextBlob('x\n'));
    await fs.rm(file);
    expect(await hashPathBlob(file)).toBeNull();

    const link = path.join(directory, 'link.txt');
    await fs.symlink('gone.txt', link);
    expect(await hashPathBlob(link)).toBe(hashTextBlob('gone.txt'));
  });
});

describe('canonical hash', () => {
  it('ignores operation_id and key order but not argument values', () => {
    const a = canonicalOperationHash('apply_patch', { operation_id: 'x', patch: 'p', workdir: null });
    const b = canonicalOperationHash('apply_patch', { workdir: null, patch: 'p', operation_id: 'y' });
    const c = canonicalOperationHash('apply_patch', { patch: 'q', workdir: null });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
