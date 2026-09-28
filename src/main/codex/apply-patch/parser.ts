/**
 * Port of `codex-rs/apply-patch/src/parser.rs`.
 *
 * The official Lark grammar for the apply-patch format is:
 *
 *     start: begin_patch environment_id? hunk+ end_patch
 *     begin_patch: "*** Begin Patch" LF
 *     environment_id: "*** Environment ID: " filename LF
 *     end_patch: "*** End Patch" LF?
 *
 *     hunk: add_hunk | delete_hunk | update_hunk
 *     add_hunk: "*** Add File: " filename LF add_line+
 *     delete_hunk: "*** Delete File: " filename LF
 *     update_hunk: "*** Update File: " filename LF change_move? change?
 *     filename: /(.+)/
 *     add_line: "+" /(.+)/ LF -> line
 *
 *     change_move: "*** Move to: " filename LF
 *     change: (change_context | change_line)+ eof_line?
 *     change_context: ("@@" | "@@ " /(.+)/) LF
 *     change_line: ("+" | "-" | " ") /(.+)/ LF
 *     eof_line: "*** End of File" LF
 *
 * The parser is a little more lenient than the explicit spec and allows for leading/trailing
 * whitespace around patch markers.
 */

import { PatchParseError } from './errors.js';
import { BEGIN_PATCH_MARKER, END_PATCH_MARKER, type Hunk } from './hunk.js';
import { StreamingPatchParser } from './streaming-parser.js';

/**
 * Currently, the only OpenAI model that knowingly requires lenient parsing is gpt-4.1. While we
 * could try to require everyone to pass in a strictness param when invoking apply_patch, it is a
 * pain to thread it through all of the call sites, so we resign ourselves to allowing lenient
 * parsing for all models.
 */
const PARSE_IN_STRICT_MODE = false;

type ParseMode = 'strict' | 'lenient';

/** `ApplyPatchArgs`: both the raw PATCH argument and the argument parsed into hunks. */
export interface ApplyPatchArgs {
  patch: string;
  hunks: Hunk[];
  workdir: string | null;
  environmentId: string | null;
}

/**
 * Rust's `str::lines`: splits on LF, treats a preceding CR as part of the terminator, and treats
 * the final terminator as optional. JavaScript's `split('\n')` alone gets both details wrong.
 */
function rustLines(value: string): string[] {
  const parts = value.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export function parsePatch(patch: string): ApplyPatchArgs {
  return parsePatchText(patch, PARSE_IN_STRICT_MODE ? 'strict' : 'lenient');
}

export function parsePatchText(patch: string, mode: ParseMode): ApplyPatchArgs {
  const lines = rustLines(patch.trim());
  const patchLines = mode === 'strict' ? checkPatchBoundariesStrict(lines) : checkPatchBoundariesLenient(lines);

  const joined = patchLines.join('\n');
  const parser = new StreamingPatchParser();
  parser.pushDelta(joined);
  const hunks = parser.finish();
  return {
    hunks,
    patch: joined,
    workdir: null,
    environmentId: parser.environmentId()
  };
}

/**
 * Checks the start and end lines of the patch text for `apply_patch`, throwing if they do not
 * match the expected markers.
 */
function checkPatchBoundariesStrict(lines: readonly string[]): readonly string[] {
  const first = lines.at(0);
  const last = lines.length === 1 ? first : lines.at(-1);
  checkStartAndEndLinesStrict(first, last);
  return lines;
}

/**
 * In lenient mode, accepts a heredoc wrapper around the patch.
 *
 * gpt-4.1 is known to pass `apply_patch` an argument like `<<'EOF'\n*** Begin Patch\n...\nEOF\n`,
 * because `local_shell` invokes the command with something akin to `execvpe(3)` rather than
 * through a shell, so the heredoc arrives as a literal string instead of on stdin. There must be
 * at least 4 lines total: the two markers plus at least two lines of patch.
 */
function checkPatchBoundariesLenient(originalLines: readonly string[]): readonly string[] {
  let originalParseError: PatchParseError;
  try {
    return checkPatchBoundariesStrict(originalLines);
  } catch (error) {
    if (!(error instanceof PatchParseError)) throw error;
    originalParseError = error;
  }

  const first = originalLines.at(0);
  const last = originalLines.at(-1);
  if (originalLines.length >= 2 && first !== undefined && last !== undefined) {
    if (
      (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') &&
      last.endsWith('EOF') &&
      originalLines.length >= 4
    ) {
      return checkPatchBoundariesStrict(originalLines.slice(1, originalLines.length - 1));
    }
  }
  throw originalParseError;
}

function checkStartAndEndLinesStrict(firstLine: string | undefined, lastLine: string | undefined): void {
  const first = firstLine?.trim();
  const last = lastLine?.trim();

  if (first !== undefined && last !== undefined && first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) {
    return;
  }
  if (first !== undefined && first !== BEGIN_PATCH_MARKER) {
    throw PatchParseError.invalidPatch("The first line of the patch must be '*** Begin Patch'");
  }
  throw PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'");
}
