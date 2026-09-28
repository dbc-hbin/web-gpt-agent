/**
 * `wgpt` — the local command line for Web GPT Agent.
 *
 * This process is deliberately the dumbest client in the system. It does not open the work
 * ledger, does not start Electron, and does not keep a queue: it resolves the host's control
 * socket from `<dataDir>/runtime.json`, performs the hello handshake, and forwards the *same*
 * request shapes `src/shared/work.ts` defines — the ones the GUI and the unified MCP connector
 * use. Everything an agent sees through this command is therefore the host's own state, not a
 * CLI-side interpretation of it.
 *
 * Two consequences are load-bearing and easy to get wrong:
 *
 *   1. **`host start` must launch a real persistent-host process.** The packaged wrapper runs this file
 *      through the app's Electron binary with `ELECTRON_RUN_AS_NODE=1`, which is what makes a
 *      Node CLI possible without shipping Node. That variable is inherited by children, and a
 *      host launched with it set would exit the moment its script ended — so it is explicitly
 *      removed for the spawn below.
 *   2. **Work commands never start a host.** An agent that silently started a background app
 *      as a side effect of asking for a status would be very hard to reason about; the
 *      explicit `host start` exists so that is always a deliberate act.
 *
 * Exit codes are part of the contract, because a script has to branch on them:
 *   0 accepted/success · 2 invalid input · 3 host unavailable · 4 rejected operation
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ZodError } from 'zod';
import {
  WORK_ERROR_CODES,
  workControlSchema,
  workEventsRequestSchema,
  workInstructionSchema,
  workListSchema,
  workStartSchema,
  workStatusRequestSchema,
  type WorkEvent,
  type WorkEventPage,
  type WorkPage,
  type WorkReceipt,
  type WorkStatus
} from '../shared/work.js';
import { resolveDataDir } from '../main/identity.js';
import {
  ControlRejectedError,
  ControlUnavailableError,
  CONTROL_PROTOCOL_VERSION,
  createWorkControlDispatch,
  openControlClient,
  readRuntimeDescriptor,
  startControlSocket,
  type ControlClient,
  type ControlMethod,
  type ControlSocketHandle,
  type GuiControlPort,
  type HostStatusReport,
  type RuntimeDescriptor
} from '../main/work/control-socket.js';
import { APP_VERSION } from '../main/version.js';
import { DaemonUsageError, runDaemonCommand } from '../daemon/cli.js';
import type { WorkService } from '../shared/work.js';
import {
  workReconnectRequestSchema,
  workConnectionTargetSchema,
  type WorkConnectionPort,
  type WorkConnectionResult
} from '../shared/work-connection.js';

export const EXIT_OK = 0;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_HOST_UNAVAILABLE = 3;
export const EXIT_REJECTED = 4;

/** How long `host start` waits for a host that actually answers. */
export const HOST_START_TIMEOUT_MS = 15_000;
/** Follow polls at this interval. */
export const EVENTS_FOLLOW_INTERVAL_MS = 1_000;

export class CliUsageError extends Error {
  constructor(
    message: string,
    readonly code: string = WORK_ERROR_CODES.invalidInput
  ) {
    super(message);
    this.name = 'CliUsageError';
  }
}

// ---------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------

export interface ParsedCommandLine {
  /** Every `--flag` seen anywhere in argv. Repeated flags: last one wins. */
  flags: Map<string, string | true>;
  /** Non-flag words in order: the command and its positional arguments. */
  positionals: string[];
}

/** Flags that stand alone; every other known flag consumes the following token. */
const BOOLEAN_FLAGS = new Set(['json', 'help', 'version', 'follow', 'browser']);

/**
 * Splits argv into flags and positionals in one pass, so global flags work before *or* after
 * the subcommand (`wgpt work list --json` and `wgpt --json work list` are the same command).
 *
 * A value-taking flag consumes the following token unconditionally, which is what makes
 * `--goal "- fix the build"` work: the value is never re-examined for another flag. The
 * boolean flags are listed rather than inferred from the next token, because `--json work
 * list` and `--goal work` are the same shape and only the flag's own kind can tell them
 * apart.
 */
export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals !== -1) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags.set(body, true);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next);
        index += 1;
        continue;
      }
      flags.set(body, true);
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

/** Flags this CLI understands at all; anything else is a usage error, never ignored. */
const KNOWN_FLAGS = new Set([
  'json',
  'data-dir',
  'help',
  'version',
  'project',
  'goal',
  'request-id',
  'title',
  'model',
  'reasoning',
  'max-workers',
  'text',
  'cursor',
  'limit',
  'after',
  'follow',
  'timeout',
  'agent-id',
  'conversation-id',
  /** `wgpt daemon config add-root <path> --name <virtual-name>` */
  'name',
  /** `wgpt daemon start|serve --browser` opts this daemon into the browser transport. */
  'browser'
]);

export function assertKnownFlags(flags: Map<string, string | true>, allowed: readonly string[]): void {
  const permitted = new Set([...allowed, 'json', 'data-dir', 'help']);
  for (const name of flags.keys()) {
    if (!KNOWN_FLAGS.has(name)) throw new CliUsageError(`unknown flag --${name}`);
    if (!permitted.has(name)) throw new CliUsageError(`--${name} is not valid for this command`);
  }
}

function stringFlag(flags: Map<string, string | true>, name: string, required: boolean): string | undefined {
  const value = flags.get(name);
  if (value === undefined) {
    if (required) throw new CliUsageError(`--${name} is required`);
    return undefined;
  }
  if (value === true) throw new CliUsageError(`--${name} requires a value`);
  return value;
}

function booleanFlag(flags: Map<string, string | true>, name: string): boolean {
  const value = flags.get(name);
  if (value === undefined) return false;
  if (value === true) return true;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new CliUsageError(`--${name} is a boolean flag`);
}

function integerFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = stringFlag(flags, name, false);
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw.trim())) throw new CliUsageError(`--${name} must be an integer`);
  return Number.parseInt(raw, 10);
}

/** A caller-supplied request id must be the UUID the ledger will store, or nothing. */
function requestIdFlag(flags: Map<string, string | true>): string {
  const raw = stringFlag(flags, 'request-id', false);
  if (raw === undefined) return randomUUID();
  const value = raw.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new CliUsageError('--request-id must be a UUID');
  }
  return value;
}

function workIdArgument(positionals: readonly string[], index: number, command: string): string {
  const value = positionals[index];
  if (value === undefined || value.trim().length === 0) {
    throw new CliUsageError(`${command} requires a <work_id>`);
  }
  return value.trim();
}

// ---------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------

interface Output {
  json: boolean;
}

function emit(output: Output, value: unknown): void {
  if (output.json) process.stdout.write(`${JSON.stringify(value)}\n`);
}

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

function diag(text: string): void {
  process.stderr.write(`${text}\n`);
}

function errorOutput(output: Output, code: string, message: string): void {
  if (output.json) process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
  diag(`wgpt: ${code}: ${message}`);
}

function timestamp(at: number): string {
  return new Date(at).toISOString();
}

function formatReceipt(receipt: WorkReceipt): string[] {
  const lines = [`work_id     ${receipt.work_id}`, `status      ${receipt.status}`, `revision    ${receipt.revision}`];
  if (receipt.project_path) lines.push(`project     ${receipt.project_path}`);
  if (receipt.integration_branch) lines.push(`branch      ${receipt.integration_branch}`);
  if (receipt.integration_worktree) lines.push(`worktree    ${receipt.integration_worktree}`);
  return lines;
}

function formatPage(page: WorkPage): string[] {
  const lines: string[] = [];
  if (page.works.length === 0) lines.push('no work');
  for (const work of page.works) {
    const blocker = work.blocker ? ` blocker=${work.blocker.code}` : '';
    lines.push(
      `${work.work_id}  ${work.status.padEnd(10)} rev=${work.revision} agents=${work.agent_count}${blocker}  ${work.title || work.goal_preview}`
    );
  }
  if (page.next_cursor) lines.push(`next_cursor ${page.next_cursor}`);
  if (page.projects.length > 0) {
    lines.push('projects:');
    for (const project of page.projects) lines.push(`  ${project.name}  ${project.path}`);
  }
  return lines;
}

function formatStatus(status: WorkStatus): string[] {
  const lines = [
    `work_id     ${status.work_id}`,
    `title       ${status.title}`,
    `status      ${status.status}${status.desired_state ? ` (desired: ${status.desired_state})` : ''}`,
    `revision    ${status.revision}`,
    `project     ${status.project_path}`,
    `branch      ${status.integration_branch ?? '-'}`,
    `worktree    ${status.integration_worktree ?? '-'}`,
    `base_commit ${status.base_commit ?? '-'}`,
    `model       ${status.model ?? '-'}${status.reasoning ? ` / ${status.reasoning}` : ''}`,
    `max_workers ${status.max_workers}`,
    `created     ${timestamp(status.created_at)}`,
    `updated     ${timestamp(status.updated_at)}`,
    `goal        ${status.goal}`
  ];
  if (status.blocker) lines.push(`blocker     ${status.blocker.code}: ${status.blocker.detail}`);
  if (status.checkpoint) {
    lines.push(`checkpoint  rev=${status.checkpoint.revision} host_generated=${status.checkpoint.host_generated}`);
    if (status.checkpoint.summary) lines.push(`  summary   ${status.checkpoint.summary}`);
    for (const remaining of status.checkpoint.remaining) lines.push(`  remaining ${remaining}`);
    for (const verification of status.checkpoint.verification) {
      lines.push(`  verified  ${verification.operation_id} ${verification.outcome}`);
    }
  }
  if (status.agents.length > 0) {
    lines.push('agents:');
    for (const agent of status.agents) {
      lines.push(
        `  ${agent.role.padEnd(6)} ${agent.agent_id} ${agent.state} gen=${agent.generation}` +
          `${agent.branch ? ` ${agent.branch}` : ''}${agent.worktree_path ? ` @ ${agent.worktree_path}` : ''}`
      );
    }
  }
  for (const operation of status.operations) {
    lines.push(`operation   ${operation.operation_id} ${operation.tool} ${operation.state}`);
  }
  for (const command of status.pending_commands) {
    lines.push(`pending     ${command.request_id} ${command.kind} ${command.delivery_state} attempts=${command.attempts}`);
  }
  return lines;
}

function formatEvent(event: WorkEvent): string {
  return `[${event.sequence}] ${timestamp(event.at)} ${event.kind} ${JSON.stringify(event.payload)}`;
}

// ---------------------------------------------------------------------------------------
// Host connection
// ---------------------------------------------------------------------------------------

async function descriptorFor(dataDir: string, output: Output): Promise<RuntimeDescriptor> {
  const descriptor = await readRuntimeDescriptor(dataDir).catch((error: unknown) => {
    throw new ControlUnavailableError(error instanceof Error ? error.message : String(error));
  });
  if (!descriptor) {
    throw new ControlUnavailableError(
      `no host is running for ${dataDir}; start it with 'wgpt host start${output.json ? ' --json' : ''} --data-dir ${dataDir}'`,
      WORK_ERROR_CODES.hostUnavailable
    );
  }
  return descriptor;
}

async function connect(dataDir: string, output: Output, timeoutMs?: number): Promise<ControlClient> {
  const descriptor = await descriptorFor(dataDir, output);
  return openControlClient(descriptor, timeoutMs === undefined ? {} : { timeoutMs });
}

async function callService(client: ControlClient, method: ControlMethod, params: unknown): Promise<unknown> {
  return client.call(method, params);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------
// host start
// ---------------------------------------------------------------------------------------

/**
 * The app binary to launch, and the app directory Electron should open in development.
 *
 * `bin/wgpt` publishes both: `WGPT_APP_EXECUTABLE` (packaged: the app's own binary; dev:
 * `node_modules/electron`) and `WGPT_REPO_ROOT` (dev only, because Electron needs the project
 * directory as its app path — a packaged binary already knows its own bundle). Nothing here
 * ever resolves Chat On Steroids.
 */
export function hostLaunchSpec(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1]
): { executable: string; args: string[] } {
  const executable = env.WGPT_APP_EXECUTABLE?.trim();
  if (!executable) {
    throw new ControlUnavailableError(
      'cannot locate this app to start: run wgpt through the packaged wrapper (bin/wgpt) or set WGPT_APP_EXECUTABLE',
      WORK_ERROR_CODES.hostUnavailable
    );
  }
  const entry = env.WGPT_CLI_ENTRY?.trim() ?? '';
  const packaged = entry.includes('app.asar');
  let appPath = env.WGPT_REPO_ROOT?.trim();
  if (!appPath && !packaged && argv1) {
    // Development layout: <repo>/out/cli/index.js — the app root is two levels up.
    appPath = path.resolve(path.dirname(argv1), '..', '..');
  }
  return { executable, args: !packaged && appPath ? [appPath] : [] };
}

export async function startHost(dataDir: string): Promise<HostStatusReport> {
  const existing = await readRuntimeDescriptor(dataDir).catch(() => null);
  if (existing) {
    const running = await probeHost(dataDir);
    if (running) return running;
  }
  const spec = hostLaunchSpec();
  // The wrapper sets ELECTRON_RUN_AS_NODE for *this* process. A host launched with it would
  // behave as a script runner and exit immediately, so it is removed, not merely overridden.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  diag(`wgpt: starting host ${spec.executable}`);
  const child = spawn(spec.executable, [...spec.args, '--daemon-host', '--data-dir', dataDir], {
    env,
    detached: true,
    stdio: 'ignore'
  });
  child.on('error', (error) => diag(`wgpt: host launch failed: ${error.message}`));
  child.unref();

  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  for (;;) {
    const status = await probeHost(dataDir);
    if (status) return status;
    if (Date.now() >= deadline) {
      throw new ControlUnavailableError(
        `the host did not answer on its control socket within ${HOST_START_TIMEOUT_MS}ms`,
        WORK_ERROR_CODES.hostUnavailable
      );
    }
    await sleep(150);
  }
}

/** One handshake attempt: a live socket that completes the protocol is a running host. */
async function probeHost(dataDir: string): Promise<HostStatusReport | null> {
  const descriptor = await readRuntimeDescriptor(dataDir).catch(() => null);
  if (!descriptor) return null;
  let client: ControlClient | null = null;
  try {
    client = await openControlClient(descriptor, { timeoutMs: 5_000 });
    return (await client.call('host.status', {})) as HostStatusReport;
  } catch {
    return null;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------------------

export interface RunOptions {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
}

const USAGE = `wgpt — Web GPT Agent command line

Usage:
  wgpt host status [--json] [--data-dir <absolute-path>]
  wgpt host start  [--json] [--data-dir <absolute-path>]
  wgpt daemon serve|start|status|stop --data-dir <absolute-path> [--json]
  wgpt daemon serve|start --browser --data-dir <absolute-path> [--json]
  wgpt daemon config [get] --data-dir <absolute-path> [--json]
  wgpt daemon config add-root <absolute-path> [--name <virtual-name>] --data-dir <dir>
  wgpt daemon config remove-root <name> --data-dir <absolute-path>
  wgpt daemon config file-access approved-roots|all-files --data-dir <absolute-path>
  wgpt daemon config read-only on|off --data-dir <absolute-path>
  wgpt daemon config capability <permission> on|off --data-dir <absolute-path>
  wgpt daemon config tunnel openai|cloudflared|manual [<tunnel_id>] --data-dir <dir>
  wgpt daemon config reconnect --data-dir <absolute-path>
  wgpt daemon secret status --data-dir <absolute-path>
  wgpt daemon secret set openaiApiKey <value> --data-dir <absolute-path>
  wgpt daemon secret clear openaiApiKey --data-dir <absolute-path>
  wgpt work start --project <absolute-path> --goal <text> [--title <text>]
                  [--model <slug>] [--reasoning <effort>] [--max-workers <1-8>]
                  [--request-id <uuid>] [--json] [--data-dir <dir>]
  wgpt work list   [--cursor <work_id>] [--limit <1-100>] [--json] [--data-dir <dir>]
  wgpt work status <work_id> [--json] [--data-dir <dir>]
  wgpt work instruct <work_id> --text <text> [--request-id <uuid>] [--json] [--data-dir <dir>]
  wgpt work pause|resume|cancel <work_id> [--request-id <uuid>] [--json] [--data-dir <dir>]
  wgpt work events <work_id> [--after <cursor>] [--limit <1-200>] [--follow]
                  [--json] [--data-dir <dir>]
  wgpt work connection <work_id> [--agent-id <id>] [--conversation-id <cid>]
                  [--json] [--data-dir <dir>]
  wgpt work reconnect  <work_id> [--agent-id <id>] [--conversation-id <cid>]
                  [--timeout <milliseconds>] [--json] [--data-dir <dir>]

Global flags may appear before or after the subcommand.
--json emits one JSON response or event per stdout line; diagnostics go to stderr.

Exit codes: 0 accepted/success, 2 invalid input, 3 host unavailable, 4 rejected operation.`;

/** Runs one CLI invocation and returns the process exit code. Never throws. */
export async function run(options: RunOptions): Promise<number> {
  const env = options.env ?? process.env;
  let parsed: ParsedCommandLine;
  try {
    parsed = parseCommandLine(options.argv);
  } catch (error) {
    diag(`wgpt: ${message(error)}`);
    return EXIT_INVALID_INPUT;
  }
  const { flags, positionals } = parsed;

  if (booleanFlag(flags, 'version')) {
    line(APP_VERSION);
    return EXIT_OK;
  }
  if (booleanFlag(flags, 'help')) {
    line(USAGE);
    return EXIT_OK;
  }
  if (positionals.length === 0) {
    // No command is a usage error, not a silent no-op: a script that forgot the subcommand
    // must be able to tell that nothing happened.
    line(USAGE);
    return EXIT_INVALID_INPUT;
  }

  let dataDir: string;
  let output: Output;
  try {
    // `--data-dir` is resolved by the identity module so the CLI and the app can never
    // disagree about what "the data directory" means; a relative value is a usage error.
    dataDir = resolveDataDir(options.argv, env);
    output = { json: booleanFlag(flags, 'json') };
  } catch (error) {
    diag(`wgpt: ${message(error)}`);
    return EXIT_INVALID_INPUT;
  }

  try {
    return await dispatch(positionals, flags, dataDir, output, env);
  } catch (error) {
    return reportFailure(error, output);
  }
}

async function dispatch(
  positionals: readonly string[],
  flags: Map<string, string | true>,
  dataDir: string,
  output: Output,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const group = positionals[0]!;
  const command = positionals[1];

  if (group === 'host') {
    if (command === 'status') {
      assertKnownFlags(flags, ['timeout']);
      const status = await probeHostOrThrow(dataDir, flags);
      if (output.json) emit(output, status);
      else for (const text of formatHostStatus(status)) line(text);
      return EXIT_OK;
    }
    if (command === 'start') {
      assertKnownFlags(flags, []);
      const status = await startHost(dataDir);
      if (output.json) emit(output, status);
      else {
        line(`host running pid=${status.pid} protocol=${status.protocol_version}`);
        for (const text of formatHostStatus(status)) line(text);
      }
      return EXIT_OK;
    }
    throw new CliUsageError(`unknown host command: ${command ?? '(none)'} — expected 'status' or 'start'`);
  }

  if (group === 'daemon') {
    // `--data-dir` is required here, not defaulted. The daemon owns its data directory alone,
    // and the default is the desktop app's directory — the exact collision the daemon refuses.
    if (!flags.has('data-dir')) {
      throw new DaemonUsageError('--data-dir <absolute-path> is required for daemon commands');
    }
    // `--name` names the virtual folder `daemon config add-root` is approving, and `--browser`
    // opts `daemon start`/`serve` into the browser transport; no other daemon command takes a flag.
    assertKnownFlags(flags, positionals[1] === 'config' ? ['name'] : positionals[1] === 'start' || positionals[1] === 'serve' ? ['browser'] : []);
    return runDaemonCommand(
      positionals.slice(1),
      dataDir,
      {
        json: output.json,
        out: (text) => line(text),
        diag: (text) => diag(text)
      },
      env,
      flags
    );
  }

  if (group !== 'work') throw new CliUsageError(`unknown command: ${group} — expected 'host', 'daemon' or 'work'`);

  switch (command) {
    case 'start': {
      assertKnownFlags(flags, ['project', 'goal', 'request-id', 'title', 'model', 'reasoning', 'max-workers']);
      const input = workStartSchema.parse({
        request_id: requestIdFlag(flags),
        project_path: stringFlag(flags, 'project', true),
        goal: stringFlag(flags, 'goal', true),
        ...(stringFlag(flags, 'title', false) !== undefined ? { title: stringFlag(flags, 'title', false) } : {}),
        ...(stringFlag(flags, 'model', false) !== undefined ? { model: stringFlag(flags, 'model', false) } : {}),
        ...(stringFlag(flags, 'reasoning', false) !== undefined ? { reasoning: stringFlag(flags, 'reasoning', false) } : {}),
        ...(integerFlag(flags, 'max-workers') !== undefined ? { max_workers: integerFlag(flags, 'max-workers') } : {})
      });
      const client = await connect(dataDir, output);
      try {
        const receipt = (await callService(client, 'work.start', input)) as WorkReceipt;
        if (output.json) emit(output, receipt);
        else for (const text of formatReceipt(receipt)) line(text);
        return EXIT_OK;
      } finally {
        await client.close();
      }
    }
    case 'list': {
      assertKnownFlags(flags, ['cursor', 'limit']);
      const cursor = stringFlag(flags, 'cursor', false);
      const limit = integerFlag(flags, 'limit');
      const input = workListSchema.parse({
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {})
      });
      const client = await connect(dataDir, output);
      try {
        const page = (await callService(client, 'work.list', input)) as WorkPage;
        if (output.json) emit(output, page);
        else for (const text of formatPage(page)) line(text);
        return EXIT_OK;
      } finally {
        await client.close();
      }
    }
    case 'status': {
      assertKnownFlags(flags, []);
      const input = workStatusRequestSchema.parse({ work_id: workIdArgument(positionals, 2, 'work status') });
      const client = await connect(dataDir, output);
      try {
        const status = (await callService(client, 'work.status', input)) as WorkStatus;
        if (output.json) emit(output, status);
        else for (const text of formatStatus(status)) line(text);
        return EXIT_OK;
      } finally {
        await client.close();
      }
    }
    case 'instruct': {
      assertKnownFlags(flags, ['text', 'request-id']);
      const input = workInstructionSchema.parse({
        request_id: requestIdFlag(flags),
        work_id: workIdArgument(positionals, 2, 'work instruct'),
        text: stringFlag(flags, 'text', true)
      });
      const client = await connect(dataDir, output);
      try {
        const receipt = (await callService(client, 'work.instruct', input)) as WorkReceipt;
        if (output.json) emit(output, receipt);
        else for (const text of formatReceipt(receipt)) line(text);
        return EXIT_OK;
      } finally {
        await client.close();
      }
    }
    case 'pause':
    case 'resume':
    case 'cancel': {
      assertKnownFlags(flags, ['request-id']);
      const input = workControlSchema.parse({
        request_id: requestIdFlag(flags),
        work_id: workIdArgument(positionals, 2, `work ${command}`),
        action: command
      });
      const client = await connect(dataDir, output);
      try {
        const receipt = (await callService(client, 'work.control', input)) as WorkReceipt;
        if (output.json) emit(output, receipt);
        else for (const text of formatReceipt(receipt)) line(text);
        return EXIT_OK;
      } finally {
        await client.close();
      }
    }
    case 'events': {
      assertKnownFlags(flags, ['after', 'limit', 'follow', 'timeout']);
      const workId = workIdArgument(positionals, 2, 'work events');
      const after = integerFlag(flags, 'after');
      const limit = integerFlag(flags, 'limit');
      const follow = booleanFlag(flags, 'follow');
      const timeoutSeconds = integerFlag(flags, 'timeout');
      if (timeoutSeconds !== undefined && timeoutSeconds <= 0) throw new CliUsageError('--timeout must be a positive number of seconds');
      // `--timeout` is the deadline for the whole command, not for one poll: a follow that
      // reset its own deadline every second would never end, which is not a timeout.
      const deadline = timeoutSeconds === undefined ? null : Date.now() + timeoutSeconds * 1_000;
      const client = await connect(dataDir, output, timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000);
      // Ctrl-C during a follow must stop the *reader*, not the work: the host sees a socket
      // close and nothing else. Registering a handler also suppresses Node's default
      // immediate exit, so the poll below can finish its sleep and the client can close
      // cleanly instead of leaving a half-read reply behind.
      const interrupted = { requested: false };
      const onInterrupt = (): void => {
        interrupted.requested = true;
      };
      process.once('SIGINT', onInterrupt);
      try {
        let cursor = after ?? 0;
        for (;;) {
          const page = (await callService(
            client,
            'work.events',
            workEventsRequestSchema.parse({
              work_id: workId,
              after: cursor,
              ...(limit !== undefined ? { limit } : {})
            })
          )) as WorkEventPage;
          for (const event of page.events) {
            if (output.json) emit(output, event);
            else line(formatEvent(event));
          }
          cursor = page.next_cursor;
          if (!follow) return EXIT_OK;
          if (interrupted.requested) return EXIT_OK;
          if (deadline !== null && Date.now() >= deadline) return EXIT_OK;
          await sleep(EVENTS_FOLLOW_INTERVAL_MS);
        }
      } finally {
        process.off('SIGINT', onInterrupt);
        await client.close();
      }
    }
    case 'connection':
    case 'reconnect': {
      // The two local verbs. `--agent-id` narrows to one of this work's agents; omitting it
      // selects the current prime. `--conversation-id` is an exact expected-CID fence: it is
      // never a rebind target, so a caller that names the wrong chat is told so instead of being
      // pointed at whatever the registry holds.
      assertKnownFlags(flags, ['agent-id', 'conversation-id', ...(command === 'reconnect' ? ['timeout'] : [])]);
      const workId = workIdArgument(positionals, 2, `work ${command}`);
      const agentId = stringFlag(flags, 'agent-id', false);
      const expectedConversation = stringFlag(flags, 'conversation-id', false);
      const target = workConnectionTargetSchema.parse({
        work_id: workId,
        ...(agentId === undefined ? {} : { agent_id: agentId }),
        ...(expectedConversation === undefined ? {} : { conversation_id: expectedConversation })
      });
      const timeoutMs = command === 'reconnect' ? integerFlag(flags, 'timeout') : undefined;
      // The requested wait is the *backend's* budget; the socket deadline has to be longer than
      // it, or the transport would abandon a wait the caller explicitly asked for.
      const client = await connect(
        dataDir, output, timeoutMs === undefined ? undefined : timeoutMs + CLI_TIMEOUT_OVERHEAD_MS
      );
      try {
        const result = (await callService(
          client,
          command === 'reconnect' ? 'work.reconnect' : 'work.connection',
          command === 'reconnect'
            ? workReconnectRequestSchema.parse({ ...target, ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) })
            : target
        )) as WorkConnectionResult;
        if (output.json) emit(output, result);
        else for (const text of formatConnection(result)) line(text);
        // `ready` is the only success. `opening` is a truthful in-progress answer, not a failure
        // of the request — but it is also not the thing the caller asked for, so it exits like
        // one: a script must be able to branch on it.
        return result.state === 'ready' ? EXIT_OK : EXIT_REJECTED;
      } finally {
        await client.close();
      }
    }
    default:
      throw new CliUsageError(`unknown work command: ${command ?? '(none)'}`);
  }
}

/**
 * How much longer than the requested wait the socket deadline is.
 *
 * The backend's `timeout_ms` is a budget for the page to come back; the transport still has to
 * carry the request out and the answer back. Giving the socket exactly the same number would
 * make every wait end as a transport timeout instead of a truthful `opening`/`unavailable`.
 */
const CLI_TIMEOUT_OVERHEAD_MS = 5_000;

async function probeHostOrThrow(dataDir: string, flags: Map<string, string | true>): Promise<HostStatusReport> {
  const timeout = integerFlag(flags, 'timeout');
  const client = await connect(dataDir, { json: false }, timeout === undefined ? undefined : timeout * 1_000);
  try {
    return (await callService(client, 'host.status', {})) as HostStatusReport;
  } finally {
    await client.close();
  }
}

function formatHostStatus(status: HostStatusReport): string[] {
  return [
    `pid            ${status.pid}`,
    `protocol       ${status.protocol_version}`,
    `installation   ${status.installation_id}`,
    `data_dir       ${status.data_dir}`,
    `version        ${status.version}`,
    `started_at     ${status.started_at}`
  ];
}

/**
 * One connection result, as text.
 *
 * The two raw evidence fields are printed even when they are null, because "never observed" and
 * "observed but suppressed" are the two facts a caller cannot tell apart from the state alone.
 */
function formatConnection(result: WorkConnectionResult): string[] {
  const lines = [
    `work_id        ${result.work_id}`,
    `work_state     ${result.work_state}`,
    `agent_id       ${result.agent_id ?? '-'}`,
    `generation     ${result.generation ?? '-'}`,
    `session_id     ${result.session_id ?? '-'}`,
    `conversation   ${result.conversation_id ?? '-'}`,
    `state          ${result.state}`,
    `page_seen_at   ${result.page_observed_at === null ? '-' : timestamp(result.page_observed_at)}`,
    `recovery_at    ${result.browser_recovery_dismissed_at === null ? '-' : timestamp(result.browser_recovery_dismissed_at)}`
  ];
  if (result.reason) lines.push(`reason         ${result.reason}`);
  return lines;
}

function message(error: unknown): string {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'input did not match the work schema';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns any failure into the CLI's exit-code contract.
 *
 * The distinction that matters is *who refused*: a host that could not be reached (or that
 * would not complete the handshake) is exit 3 and a caller should try `host start`; a host
 * that answered and rejected the operation is exit 4 and retrying the same thing will not
 * help. Local input mistakes are exit 2 and are reported before any connection is attempted.
 */
export function reportFailure(error: unknown, output: Output): number {
  if (error instanceof CliUsageError) {
    errorOutput(output, error.code, error.message);
    return EXIT_INVALID_INPUT;
  }
  // A malformed `daemon` command is the same class of failure as a malformed `work` one: the
  // command never reached a peer. It is a distinct type only so `src/daemon/cli.ts` does not
  // have to import the CLI's parser.
  if (error instanceof DaemonUsageError) {
    errorOutput(output, error.code, error.message);
    return EXIT_INVALID_INPUT;
  }
  if (error instanceof ZodError) {
    errorOutput(output, WORK_ERROR_CODES.invalidInput, message(error));
    return EXIT_INVALID_INPUT;
  }
  if (error instanceof ControlRejectedError) {
    const code = error.code;
    errorOutput(output, code, error.message);
    return code === WORK_ERROR_CODES.hostUnavailable ? EXIT_HOST_UNAVAILABLE : EXIT_REJECTED;
  }
  if (error instanceof ControlUnavailableError) {
    errorOutput(output, error.code, error.message);
    return EXIT_HOST_UNAVAILABLE;
  }
  errorOutput(output, WORK_ERROR_CODES.internalError, message(error));
  return EXIT_HOST_UNAVAILABLE;
}

// ---------------------------------------------------------------------------------------
// Host-side integration
// ---------------------------------------------------------------------------------------

export interface CliHostControlOptions {
  dataDir: string;
  installationId: string;
  /** The one WorkService, already constructed by the runtime. */
  service: WorkService;
  /**
   * The local connection/reconnect backend, built by the runtime.
   *
   * Omitted by a host that has none: the socket then refuses both verbs with
   * `HOST_UNAVAILABLE` instead of reporting a connection nobody looked at.
   */
  connection?: WorkConnectionPort;
  /** The persistent desktop backend's renderer RPC surface. */
  gui?: GuiControlPort;
  /** Descriptor-backed credential required by the GUI wrapper. */
  authToken?: string;
  /** Explicit GUI lifecycle stop, invoked only after the socket receipt is sent. */
  onHostStopRequested?: () => void;
  version?: string;
  startedAt?: number;
  /** Test seams: the platform's transport, a fixed endpoint, and the pipe ACL step. */
  platform?: NodeJS.Platform;
  socketPath?: string;
  restrictPipe?: (pipeName: string) => Promise<string>;
}

/**
 * Starts the control socket for the host process, with `host.status` answered from local
 * facts and every other method forwarded to the shared WorkService.
 *
 * Exported here (rather than assembled in `index.ts`) so the runtime's startup and shutdown
 * seams only have to call one function, and so the socket's exact protocol is defined next to
 * the CLI that speaks it.
 */
export async function startCliControlSocket(options: CliHostControlOptions): Promise<ControlSocketHandle> {
  const startedAt = options.startedAt ?? Date.now();
  const version = options.version ?? APP_VERSION;
  return startControlSocket({
    dataDir: options.dataDir,
    installationId: options.installationId,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    ...(options.restrictPipe === undefined ? {} : { restrictPipe: options.restrictPipe }),
    ...(options.gui === undefined ? {} : { gui: options.gui }),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    ...(options.onHostStopRequested === undefined ? {} : { onHostStopRequested: options.onHostStopRequested }),
    dispatch: createWorkControlDispatch({
      service: options.service,
      ...(options.connection === undefined ? {} : { connection: options.connection }),
      hostStatus: () => ({
        pid: process.pid,
        installation_id: options.installationId,
        protocol_version: CONTROL_PROTOCOL_VERSION,
        data_dir: options.dataDir,
        version,
        started_at: new Date(startedAt).toISOString()
      })
    })
  });
}

async function main(): Promise<void> {
  // A reader that closes its end of the pipe is normal termination for a CLI, not a crash:
  // Node reports a write to a closed pipe as an `EPIPE` error event, which is unhandled by
  // default and would abort with a stack trace and a nonzero code. The host is a separate
  // process, so exiting here ends only this client.
  const onStreamError = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  };
  process.stdout.on('error', onStreamError);
  process.stderr.on('error', onStreamError);
  const code = await run({ argv: process.argv.slice(2) });
  process.exitCode = code;
}

// Only run when executed as a program. `import.meta` is unavailable in the CJS bundle the
// Electron build produces, so the check is on the resolved script path instead.
const entry = process.argv[1] ?? '';
if (entry.endsWith(`${path.sep}cli${path.sep}index.js`) || entry.endsWith('/cli/index.js')) {
  void main();
}
