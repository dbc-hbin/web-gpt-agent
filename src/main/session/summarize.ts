/**
 * One tool call → one line a human can read.
 *
 * This is what replaces ChatGPT's wall of identical "Called tool" rows. It is a pure
 * function of the arguments we sent and the evidence the handler recorded, so it is
 * fully testable and never depends on scraping our own output back out of a page.
 *
 * Each tool gets the shape that suits it rather than one forced template: an edit
 * shows line counts, a search shows its query and hit count, a command shows how it
 * exited. When there is nothing worth saying, the tool name is still better than
 * "Called tool".
 */

import type { ActivitySummary, FileChange, ToolOutcome } from '../../shared/session.js';
import { formatDelta } from '../diffstat.js';
import type { CallEvidence } from '../mcp/call-context.js';

/** Drops the virtual root segment, which is the same on every line and adds nothing. */
export function shortPath(virtualPath: string): string {
  const parts = String(virtualPath ?? '').split('/').filter(Boolean);
  if (parts.length <= 1) return `/${parts.join('/')}`;
  return parts.slice(1).join('/');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Combined "+18 −4" across every file the call touched. */
function totalDelta(changes: readonly FileChange[]): string | null {
  if (changes.length === 0) return null;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const text = formatDelta({ added, removed });
  if (!text) return null;
  return changes.some((change) => change.approximate) ? `~${text}` : text;
}

/** "lines 200–420" -> "221 lines", for the glanceable right edge of a read row. */
function lineRangeMetric(detail: string | null): string | null {
  if (!detail) return null;
  const match = /^lines\s+(\d+)[–-](\d+)(?:\s+of\s+\d+)?$/i.exec(detail.trim());
  if (!match) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) return null;
  return plural(last - first + 1, 'line');
}

/**
 * A command or script as one readable line.
 *
 * This used to render as the literal words "PowerShell script", on the reasoning that a
 * script is multi-line and a title is not. The effect was that every PowerShell call in
 * a session — and on Windows that is most of them — looked identical, which is the exact
 * problem this whole file exists to solve. The first real line is nearly always the one
 * that says what the call was for.
 *
 * Bounded and single-line by construction. Live agent keys are scrubbed out of the
 * summary by the recorder before it is stored or sent anywhere, alongside arguments and
 * results, so no redaction is repeated here.
 */
function scriptLabel(script: string | null): string {
  if (!script) return 'a command';
  const lines = script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const first = (lines[0] ?? '').replace(/\s+/g, ' ');
  if (!first) return 'a command';
  const shown = first.slice(0, 70);
  return lines.length > 1 || shown.length < first.length ? `${shown} …` : shown;
}

function fileTitle(verb: string, changes: readonly FileChange[], fallback: string | null): string {
  if (changes.length === 1) return `${verb} ${shortPath(changes[0]!.path)}`;
  if (changes.length > 1) return `${verb} ${plural(changes.length, 'file')}`;
  return fallback ? `${verb} ${shortPath(fallback)}` : verb;
}

/**
 * Past tense → plain infinitive, for the titles of calls that did not happen.
 *
 * "Edited src/x.ts" with a red mark next to it still reads, at a glance, as an edit that
 * happened — and when reading a session back later that is exactly the wrong impression.
 * The subject has to stay (it is the useful part), so the verb is what changes.
 */
const UNDONE: Record<string, string> = {
  Edited: 'edit',
  Applied: 'apply',
  Rewrote: 'rewrite',
  Appended: 'append',
  Created: 'create',
  Saved: 'save',
  Interrupted: 'interrupt',
  Filled: 'fill',
  Wrote: 'write',
  Moved: 'move',
  Deleted: 'delete',
  Read: 'read',
  Viewed: 'view',
  Inspected: 'inspect',
  Listed: 'list',
  Searched: 'search',
  Checked: 'check',
  Ran: 'run',
  Launched: 'launch',
  Started: 'start',
  Stopped: 'stop',
  Opened: 'open',
  Looked: 'look',
  Waited: 'wait',
  Clicked: 'click',
  'Double-clicked': 'double-click',
  Dragged: 'drag',
  Scrolled: 'scroll',
  Typed: 'type',
  Pressed: 'press',
  Focused: 'focus',
  Acted: 'act',
  Replaced: 'replace',
  Loaded: 'load',
  Messaged: 'message',
  Reported: 'report',
  Requested: 'request'
};

/** Whole titles that do not begin with a verb. */
const UNDONE_WHOLE: Record<string, string> = {};

/** Titles that already say they failed, and must not be prefixed twice. */
const ALREADY_NEGATIVE = /^(Could not|Refused|Failed|Command failed)\b/;

function undoTitle(title: string, refused: boolean): string {
  if (ALREADY_NEGATIVE.test(title)) return title;
  const lead = refused ? 'Refused to' : 'Could not';
  const whole = UNDONE_WHOLE[title];
  if (whole) return `${lead} ${whole}`;
  const space = title.indexOf(' ');
  const first = space === -1 ? title : title.slice(0, space);
  const verb = UNDONE[first];
  if (!verb) return `${refused ? 'Refused' : 'Failed'}: ${title}`;
  return `${lead} ${verb}${space === -1 ? '' : title.slice(space)}`;
}

export interface SummaryInput {
  tool: string;
  args: unknown;
  evidence: CallEvidence;
  outcome: ToolOutcome;
  durationMs: number;
  /** First line of the result, used only where nothing better exists. */
  resultHead?: string;
}

/**
 * Builds the compact entry.
 *
 * A failed or refused call keeps the same subject but says so, because "Edited x.ts"
 * next to a red mark is far more useful when reading back a session than a generic
 * "tool error".
 */
export function summarizeToolCall(input: SummaryInput): ActivitySummary {
  const args = record(input.args);
  const evidence = input.evidence;
  const changes = evidence.changes;
  const summary = build(input.tool, args, evidence, changes, input);

  // A child process reporting failure is still a successfully executed tool call.
  if (input.outcome === 'ok' || input.outcome === 'process_exit_nonzero') return summary;
  const refused = input.outcome === 'tool_rejected';
  const head = (input.resultHead ?? '').trim();
  // Only content-match verification failures get this wording. Permission, identity,
  // syntax and execution failures keep their own meaning (and any partial-change evidence).
  const patchMismatch = refused && input.tool === 'apply_patch' && changes.length === 0 &&
    /^apply_patch verification failed: Failed to find (?:expected lines in |context(?: in | '))/.test(head);
  const failed: ActivitySummary = {
    ...summary,
    tone: input.outcome === 'tool_internal_error' ? 'bad' : 'warn',
    // The verb carries the outcome, not just the colour. Tone and metric are easy to
    // miss and are gone entirely once a line is quoted or read back as text.
    title: patchMismatch ? 'Patch didn’t match' :
      input.outcome === 'tool_execution_error' ? `Tool ${input.tool} failed` : undoTitle(summary.title, refused)
  };
  if (patchMismatch) {
    failed.metric = 'not applied';
  } else if (refused) {
    failed.metric = 'refused';
  } else if (!failed.metric || !failed.metric.startsWith('✕')) {
    failed.metric = '✕ failed';
  }
  if (head && !failed.detail) failed.detail = head.slice(0, 120);
  return failed;
}

function build(
  tool: string,
  args: Record<string, unknown>,
  evidence: CallEvidence,
  changes: readonly FileChange[],
  input: SummaryInput
): ActivitySummary {
  const delta = totalDelta(changes);

  switch (tool) {
    // ------------------------------------------------------------- reads
    case 'read': {
      const paths = arr(args['paths']).map((p) => String(p));
      const first = paths[0];
      const start = num(args['start_line']);
      const end = num(args['end_line']);
      // The range only ever applies to a single path, so it is only offered there.
      const range =
        paths.length === 1
          ? (evidence.detail ?? (start && end ? `lines ${start}–${end}` : start ? `from line ${start}` : null))
          : null;
      const metric = lineRangeMetric(range);
      const multiDetail =
        paths.length > 1
          ? paths.length <= 3
            ? paths.map(shortPath).join(', ')
            : `${paths.slice(0, 2).map(shortPath).join(', ')} +${paths.length - 2} more`
          : null;
      return {
        kind: 'read',
        tone: 'neutral',
        title: paths.length === 1 && first ? `Read ${shortPath(first)}` : `Read ${plural(paths.length, 'path')}`,
        ...(range ? { detail: range } : multiDetail ? { detail: multiDetail } : {}),
        ...(metric ? { metric } : {})
      };
    }
    case 'find': {
      const query = str(args['query']) ?? '';
      const mode = str(args['mode']) ?? 'name';
      return {
        kind: 'search',
        tone: 'neutral',
        title: `Searched ${JSON.stringify(query.slice(0, 60))}`,
        detail:
          evidence.count !== null
            ? `${plural(evidence.count, 'match', 'matches')}${mode === 'content' ? ' in file contents' : ''}`
            : mode === 'content'
              ? 'in file contents'
              : 'by name'
      };
    }

    // ------------------------------------------------------------ writes
    //
    // One tool now covers create, edit, move and delete, so the title comes from what
    // the patch actually did rather than from which tool was called. The recorded
    // changes are the authority for that, and they are exact.
    case 'apply_patch': {
      // Read off the patch header rather than the recorded changes: the changes carry
      // line counts, not intent, and "Deleted" versus "Edited" is exactly the distinction
      // someone reading a timeline back is looking for.
      const patch = str(args['patch']) ?? '';
      const adds = /^\*\*\* Add File:/m.test(patch);
      const deletes = /^\*\*\* Delete File:/m.test(patch);
      const updates = /^\*\*\* Update File:/m.test(patch);
      const moves = /^\*\*\* Move to:/m.test(patch);
      const only =
        adds && !deletes && !updates
          ? 'create'
          : deletes && !adds && !updates
            ? 'delete'
            : moves && !adds && !deletes
              ? 'move'
              : 'edit';
      const verb =
        only === 'create' ? 'Created' : only === 'delete' ? 'Deleted' : only === 'move' ? 'Moved' : 'Edited';
      return {
        kind: only,
        tone: only === 'delete' ? 'warn' : 'good',
        title: changes.length === 0 ? 'Applied a patch' : fileTitle(verb, changes, null),
        ...(delta ? { metric: delta } : {})
      };
    }

    // ---------------------------------------------------------- commands
    case 'exec_command': {
      const commands = Array.isArray(args['cmds']) ? args['cmds'].filter((item): item is string => typeof item === 'string') : [];
      const command = commands.length ? `${commands.length} commands: ${scriptLabel(commands.join('; '))}` : scriptLabel(str(args['cmd']));
      const failed = evidence.timedOut || (!evidence.benignExit && evidence.exitCode !== null && evidence.exitCode !== 0);
      // `exec_command` deliberately returns after its yield window when the child is still
      // alive. New callers record that state explicitly. The second branch keeps older
      // in-memory/test evidence readable, but no new summary needs to infer process state
      // from a null exit code plus a duration.
      const running =
        evidence.running === true ||
        (evidence.running === null && !evidence.timedOut && evidence.exitCode === null && evidence.durationMs !== null);
      const took = evidence.durationMs ?? input.durationMs;
      return {
        kind: 'run',
        tone: failed ? 'bad' : running ? 'neutral' : 'good',
        title: failed ? `Command failed ${command}` : running ? `Started ${command}` : `Ran ${command}`,
        metric: running
          ? 'started'
          : evidence.timedOut
          ? '✕ timed out'
          : failed
            ? `✕ exit ${evidence.exitCode}`
            : `✓ ${formatDuration(took)}`
      };
    }
    case 'write_stdin': {
      const id = typeof args['session_id'] === 'number' ? String(args['session_id']) : str(args['session_id']) ?? '';
      const signal = str(args['signal']);
      const title =
        signal === 'kill'
          ? `Stopped session ${id}`.trim()
          : signal === 'int'
            ? `Interrupted session ${id}`.trim()
            : str(args['chars'])
              ? `Wrote to session ${id}`.trim()
              : `Waited on session ${id}`.trim();
      const failed = !evidence.benignExit && evidence.exitCode !== null && evidence.exitCode !== 0;
      return { kind: 'process', tone: signal === 'kill' ? 'warn' : failed ? 'bad' : 'neutral', title,
        ...(evidence.exitCode === null ? {} : { metric: failed ? `✕ exit ${evidence.exitCode}` : '✓ finished' }) };
    }

    // ------------------------------------------------------------ CUA Driver Desktop
    case 'list_apps':
      return { kind: 'screen', tone: 'neutral', title: 'Listed installed apps' };
    case 'list_windows':
      return { kind: 'screen', tone: 'neutral', title: 'Listed open windows' };
    case 'get_window_state':
    case 'get_accessibility_tree':
    case 'get_desktop_state':
      return { kind: 'screen', tone: 'neutral', title: 'Inspected desktop state' };
    case 'get_screen_size':
    case 'get_cursor_position':
    case 'get_agent_cursor_state':
    case 'check_permissions':
    case 'verify_state':
      return { kind: 'screen', tone: 'neutral', title: 'Checked desktop state' };
    case 'zoom':
      return { kind: 'screen', tone: 'neutral', title: 'Inspected desktop region' };
    case 'clipboard_read':
      return { kind: 'clipboard', tone: 'neutral', title: 'Read the clipboard' };
    case 'clipboard_write':
      return { kind: 'clipboard', tone: 'neutral', title: 'Replaced the clipboard text' };
    case 'launch_app':
      return { kind: 'input', tone: 'neutral', title: 'Requested an app launch' };
    case 'set_window_frame':
    case 'invoke_menu':
      return { kind: 'input', tone: 'neutral', title: 'Controlled the desktop' };
    case 'click':
    case 'double_click':
    case 'right_click':
      return { kind: 'input', tone: 'neutral', title: 'Clicked on the desktop' };
    case 'press_key':
    case 'hotkey':
      return { kind: 'input', tone: 'neutral', title: 'Pressed desktop keys' };
    case 'type_text':
    case 'set_value':
      return { kind: 'input', tone: 'neutral', title: 'Entered desktop text' };
    case 'scroll':
    case 'drag':
      return { kind: 'input', tone: 'neutral', title: 'Moved desktop input' };

    // ----------------------------------------------------------- session
    case 'update_plan': {
      const steps = arr(args['plan']);
      const completed = steps.filter(step => record(step)['status'] === 'completed').length;
      return { kind: 'session', tone: 'neutral', title: steps.length ? 'Updated the task plan' : 'Cleared the task plan',
        ...(steps.length ? { detail: `${completed} / ${steps.length} completed` } : {}) };
    }
    case 'session': {
      const action = str(args['action']) ?? 'search';
      const query = str(args['query']);
      if (action === 'search') {
        return {
          kind: 'session',
          tone: 'neutral',
          title: query ? `Searched recordings ${JSON.stringify(query.slice(0, 40))}` : 'Listed recent recordings',
          ...(evidence.count !== null ? { detail: plural(evidence.count, 'session') } : {})
        };
      }
      const toolCall = str(args['tool_call']);
      const cursor = str(args['cursor']);
      return {
        kind: 'session',
        tone: 'neutral',
        title: toolCall
          ? 'Opened one recorded tool call'
          : cursor
            ? 'Continued reading a recorded session'
            : 'Read a recorded session',
        ...(evidence.count !== null ? { detail: plural(evidence.count, 'entry', 'entries') } : {})
      };
    }

    // ------------------------------------------------------------ agents
    case 'agents': {
      const action = str(args['action']) ?? 'status';
      switch (action) {
        case 'spawn':
          return {
            kind: 'agent',
            tone: 'good',
            title: `Created ${plural(arr(args['workers']).length, 'worker agent')}`
          };
        case 'message': {
          // A batch names its recipients rather than reporting one of them; the count is
          // what the row is actually about once there is more than one.
          const batch = arr(args['messages']);
          if (batch.length > 1) {
            return { kind: 'agent', tone: 'neutral', title: `Messaged ${plural(batch.length, 'agent')}` };
          }
          const only = batch.length === 1 ? (batch[0] as Record<string, unknown>) : args;
          return { kind: 'agent', tone: 'neutral', title: `Messaged ${str(only['to']) ?? 'the prime agent'}` };
        }
        case 'finish':
          return { kind: 'agent', tone: 'good', title: 'Reported the finished task' };
        default:
          return {
            kind: 'agent',
            tone: 'neutral',
            title: 'Checked agent status',
            ...(evidence.count !== null ? { detail: plural(evidence.count, 'message') } : {})
          };
      }
    }

    default:
      return { kind: 'other', tone: 'neutral', title: `Ran ${tool}` };
  }
}
