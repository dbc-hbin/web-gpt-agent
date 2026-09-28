/**
 * The one place CLF decides whether a piece of text the model sent matches a file on disk.
 *
 * There used to be two implementations of that question. `apply_patch` matched logical
 * lines, and `edit_file` ran `indexOf` over raw bytes — so an `edit_file` call carrying a
 * multi-line snippet copied verbatim out of CLF's own `read_file` failed on every CRLF
 * file in the repository, because reads are joined with LF and Windows files are not.
 * The documented workaround became PowerShell string surgery, which rewrote the endings of
 * whatever it touched and left files mixed, which broke the next edit a little harder.
 *
 * Both entry points now live here. Whatever the shape of the request, matching is line-
 * ending agnostic, a candidate must be unique before it is used, and the bytes written back
 * for unchanged text are always the file's own.
 */

export class TextMatchError extends Error {}

export type Newline = '\n' | '\r\n' | '\r';

/** The terminator to give lines that have no origin, chosen by majority vote. */
export function preferredNewline(text: string): Newline {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const withoutCrlf = text.replace(/\r\n/g, '');
  const lf = (withoutCrlf.match(/\n/g) ?? []).length;
  const cr = (withoutCrlf.match(/\r/g) ?? []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return '\r\n';
  return cr > lf ? '\r' : '\n';
}

/** Rewrites every terminator in freshly authored text to one the target file already uses. */
export function adaptNewlines(text: string, newline: Newline): string {
  return text.replace(/\r\n|\r|\n/g, newline);
}

export function rstrip(value: string): string {
  return value.replace(/[\t ]+$/g, '');
}

/**
 * Typographic substitutions that do not change a string's length.
 *
 * Length preservation is what lets the offset-based entry point below map a match in folded
 * text back to a byte range in the original. Anything that changes length — an ellipsis
 * becoming three dots — is confined to the line-based ladder, where positions are line
 * indices and the length of a line does not matter.
 */
const SAME_LENGTH_FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‐-―−]/g, '-'],
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[  -   　]/g, ' ']
];

export function foldUnicodeSameLength(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SAME_LENGTH_FOLD) out = out.replace(pattern, replacement);
  return out;
}

export function foldUnicode(value: string): string {
  return foldUnicodeSameLength(value).replace(/…/g, '...');
}

export interface MatchTier {
  /** Reads as the tail of "matches ... (<label>)" in an ambiguity error. */
  readonly label: string;
  readonly normalize: (value: string) => string;
}

/**
 * The progressive relaxation ladder, strictest first — the same four rungs Codex's
 * seek_sequence walks, in the same order, so a patch that applies there applies here.
 *
 * The rungs decide only *whether* two lines are the same line. They never decide what gets
 * written: `apply_patch` keeps the file's own bytes for every context line it matched, which
 * is the difference between forgiving a model's indentation and adopting it.
 */
export const MATCH_TIERS: readonly MatchTier[] = [
  { label: 'exact match', normalize: (value) => value },
  { label: 'ignoring trailing whitespace', normalize: rstrip },
  { label: 'ignoring indentation', normalize: (value) => value.trim() },
  { label: 'ignoring unicode punctuation', normalize: (value) => foldUnicode(value).trim() }
];

/** The offset-based ladder. Every tier must preserve length; see SAME_LENGTH_FOLD. */
const SPAN_TIERS: readonly MatchTier[] = [
  { label: 'exact match', normalize: (value) => value },
  { label: 'ignoring unicode punctuation', normalize: foldUnicodeSameLength }
];

// ---------------------------------------------------------------- logical lines

export interface LogicalText {
  lines: string[];
  /**
   * The terminator that follows each line, kept per line rather than per file.
   *
   * Rejoining a whole file with one majority terminator turns a three-line edit to a
   * mixed-endings file into a whole-file diff. Only the final entry may be empty, and
   * only when the file itself does not end with a newline.
   */
  endings: string[];
  /** Majority terminator. Used only for lines an edit adds, which have no origin. */
  newline: Newline;
  finalNewline: boolean;
}

export function splitLogicalText(text: string): LogicalText {
  const newline = preferredNewline(text);
  const lines: string[] = [];
  const endings: string[] = [];
  const breaks = /\r\n|\n|\r/g;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(text)) !== null) {
    lines.push(text.slice(at, match.index));
    endings.push(match[0]);
    at = match.index + match[0].length;
  }
  const finalNewline = text.length > 0 && at === text.length;
  if (!finalNewline) {
    lines.push(text.slice(at));
    endings.push('');
  }
  return { lines, endings, newline, finalNewline };
}

export function joinLogicalText(value: LogicalText): string {
  let out = '';
  for (let index = 0; index < value.lines.length; index++) out += value.lines[index]! + (value.endings[index] ?? '');
  return out;
}

/**
 * Restores the per-line terminator invariant after a splice.
 *
 * Inserted lines arrive without an origin, and removing the final line can leave the new
 * last line carrying a terminator the file never had. Only the last line may end bare, and
 * only when the file itself ends bare.
 */
export function settleEndings(value: LogicalText): void {
  const last = value.lines.length - 1;
  if (last < 0) return;
  for (let index = 0; index < last; index++) {
    if (!value.endings[index]) value.endings[index] = value.newline;
  }
  value.endings[last] = value.finalNewline ? value.endings[last] || value.newline : '';
}

export function patternMatches(
  lines: readonly string[],
  at: number,
  pattern: readonly string[],
  tier: MatchTier
): boolean {
  if (at < 0 || at + pattern.length > lines.length) return false;
  for (let offset = 0; offset < pattern.length; offset++) {
    if (tier.normalize(lines[at + offset]!) !== tier.normalize(pattern[offset]!)) return false;
  }
  return true;
}

export function matchingPositions(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endExclusive: number,
  tier: MatchTier
): number[] {
  const found: number[] = [];
  const last = Math.max(start, endExclusive - pattern.length);
  for (let at = start; at <= last; at++) {
    if (patternMatches(lines, at, pattern, tier)) found.push(at);
  }
  return found;
}

// ---------------------------------------------------------------- byte spans

export interface TextSpan {
  start: number;
  end: number;
}

/**
 * Rewrites every line terminator to LF while remembering where each character came from.
 *
 * `index[i]` is the offset in the original of the character that produced normalised
 * character `i`, and `index[length]` is the end of the original. A match over the
 * normalised text therefore maps straight back to a byte range in the untouched original,
 * which is what lets an edit splice a CRLF file using a snippet written with LF.
 */
function normaliseForSearch(text: string): { text: string; index: number[] } {
  const out: string[] = [];
  const index: number[] = [];
  let at = 0;
  while (at < text.length) {
    if (text[at] === '\r') {
      out.push('\n');
      index.push(at);
      at += text[at + 1] === '\n' ? 2 : 1;
      continue;
    }
    out.push(text[at]!);
    index.push(at);
    at++;
  }
  index.push(text.length);
  return { text: out.join(''), index };
}

export interface SpanMatch {
  spans: TextSpan[];
  tier: MatchTier;
}

/**
 * Every place `needle` occurs in `original`, ignoring how either one spells its newlines.
 *
 * Occurrences do not overlap, which is what makes a replace-all pass behave the same way a
 * split/join would. Returns null when no tier finds the needle at all.
 */
export function findSpans(original: string, needle: string): SpanMatch | null {
  if (!needle) return null;
  const base = normaliseForSearch(original);
  const wanted = needle.replace(/\r\n|\r/g, '\n');
  for (const tier of SPAN_TIERS) {
    const haystack = tier.normalize(base.text);
    const pin = tier.normalize(wanted);
    if (!pin) continue;
    const spans: TextSpan[] = [];
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(pin, from);
      if (at < 0) break;
      spans.push({ start: base.index[at]!, end: base.index[at + pin.length]! });
      from = at + pin.length;
    }
    if (spans.length > 0) return { spans, tier };
  }
  return null;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let at = 0; at < offset && at < text.length; at++) {
    const char = text[at];
    if (char === '\n') line++;
    else if (char === '\r') {
      if (text[at + 1] !== '\n') line++;
    }
  }
  return line;
}

function preview(value: string): string {
  const firstLine = value.split(/\r\n|\n|\r/)[0] ?? '';
  const compact = firstLine.replace(/\t/g, '→').trimEnd();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

export interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface AppliedTextEdit {
  text: string;
  replacements: number;
  tier: string;
}

/**
 * Spells the replacement's line terminators the way the span it is replacing spelled them.
 *
 * The line *structure* is the caller's: how many lines there are, and whether the last one
 * ends with a break, comes from `newText`. Only the choice of `\n` / `\r\n` / `\r` for each
 * break is taken positionally from the original span, so a multi-line edit to a file with
 * mixed endings leaves the terminators of every line it did not mean to change byte for
 * byte as they were. Lines beyond the end of the original span are genuinely new and get
 * the file's majority terminator, because there is nothing to inherit from.
 */
function alignTerminators(spanText: string, newText: string, fallback: Newline): string {
  const origin = splitLogicalText(spanText);
  const next = splitLogicalText(newText);
  let out = '';
  for (let index = 0; index < next.lines.length; index++) {
    out += next.lines[index]!;
    if (next.endings[index]) out += origin.endings[index] || fallback;
  }
  return out;
}

/**
 * Replaces one identified snippet, or every occurrence of it.
 *
 * Splicing is done with slices rather than `String.prototype.replace`, and that is not a
 * style choice. `replace` expands `$&`, `` $` ``, `$'`, `$1` and `$$` inside the
 * replacement *even when the pattern is a plain string*, so an edit inserting a regular
 * expression, a shell variable or a template literal used to write different bytes than the
 * caller asked for, with no error and no way to notice short of re-reading the file.
 *
 * Tolerance here is narrower than `apply_patch`'s, on purpose. This path matches over byte
 * offsets so that a snippet may start and end mid-line, and an offset can only be mapped
 * back through a normalisation that preserves length — so SPAN_TIERS covers line endings
 * and same-width typography and stops there. Indentation drift and trailing whitespace are
 * not forgiven; that needs the line-based ladder, which is what `apply_patch` runs.
 */
export function applyTextEdit(original: string, edit: TextEdit): AppliedTextEdit {
  if (!edit.oldText) throw new TextMatchError('oldText must not be empty');

  const found = findSpans(original, edit.oldText);
  if (!found) {
    throw new TextMatchError(
      `oldText was not found. First line looked for: ${JSON.stringify(preview(edit.oldText))}. ` +
        `Read the file around the target and copy the snippet from that output, without the line-number prefix. ` +
        `Line endings are already handled; if the indentation or trailing whitespace may differ, use apply_patch instead.`
    );
  }
  if (!edit.replaceAll && found.spans.length > 1) {
    const lines = found.spans.slice(0, 8).map((span) => lineNumberAt(original, span.start));
    throw new TextMatchError(
      `oldText is ambiguous (${found.tier.label}): it occurs ${found.spans.length} times, at lines ` +
        `${lines.join(', ')}${found.spans.length > lines.length ? ', ...' : ''}. ` +
        `Include more surrounding context, or pass replaceAll to change every occurrence.`
    );
  }

  const spans = edit.replaceAll ? found.spans : [found.spans[0]!];
  const fallback = preferredNewline(original);

  let out = '';
  let at = 0;
  for (const span of spans) {
    // Each occurrence inherits its own terminators. Under replaceAll the same snippet can
    // sit in a CRLF region and an LF region of one mixed file, so a single pre-rendered
    // replacement string would be wrong for at least one of them.
    out += original.slice(at, span.start) + alignTerminators(original.slice(span.start, span.end), edit.newText, fallback);
    at = span.end;
  }
  out += original.slice(at);
  return { text: out, replacements: spans.length, tier: found.tier.label };
}
