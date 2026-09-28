/**
 * Port of `codex-rs/apply-patch/src/seek_sequence.rs`.
 *
 * `String::trim`/`trim_end` trim the Unicode `White_Space` set; JavaScript's `trim`/`trimEnd`
 * trim that set plus U+FEFF. A byte-order mark in a context line is the only input that could
 * tell the two apart.
 */

import type { ApplyPatchFileUpdateMode } from './mode.js';

/**
 * Attempt to find the sequence of `pattern` lines within `lines` beginning at or after `start`.
 * Returns the starting index of the match or `null` if not found. Matches are attempted with
 * decreasing strictness: exact match, then ignoring trailing whitespace, then ignoring leading
 * and trailing whitespace. When `eof` is true, we first try starting at the end-of-file (so that
 * patterns intended to match file endings are applied at the end), and fall back to searching
 * from `start` if needed.
 *
 * Special cases handled defensively:
 *  - Empty `pattern` -> returns `start` (no-op match)
 *  - `pattern.length > lines.length` -> returns `null` (cannot match)
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
  updateFileMode: ApplyPatchFileUpdateMode
): number | null {
  if (pattern.length === 0) return start;

  // When the pattern is longer than the available input there is no possible match.
  if (pattern.length > lines.length) return null;

  let searchStart: number;
  if (eof && lines.length >= pattern.length) {
    const eofStart = lines.length - pattern.length;
    searchStart = updateFileMode === 'normalize_to_lf' ? eofStart : Math.max(eofStart, start);
  } else {
    searchStart = start;
  }

  const last = lines.length - pattern.length;
  const scan = (matches: (line: string, patternLine: string) => boolean): number | null => {
    for (let index = searchStart; index <= last; index++) {
      let ok = true;
      for (let offset = 0; offset < pattern.length; offset++) {
        if (!matches(lines[index + offset] as string, pattern[offset] as string)) {
          ok = false;
          break;
        }
      }
      if (ok) return index;
    }
    return null;
  };

  // Exact match first.
  const exact = scan((line, patternLine) => line === patternLine);
  if (exact !== null) return exact;

  // Then rstrip match.
  const rstripped = scan((line, patternLine) => line.trimEnd() === patternLine.trimEnd());
  if (rstripped !== null) return rstripped;

  // Finally, trim both sides to allow more lenience.
  const trimmed = scan((line, patternLine) => line.trim() === patternLine.trim());
  if (trimmed !== null) return trimmed;

  // Final, most permissive pass: match after normalising common Unicode punctuation to its ASCII
  // equivalent, so a diff authored in plain ASCII still applies to a file containing typographic
  // dashes or quotes. This mirrors the fuzzy behaviour of `git apply`.
  return scan((line, patternLine) => normalise(line) === normalise(patternLine));
}

/** The substitutions Codex applies before its final, most permissive comparison. */
const NORMALISED_CHARACTERS = new Map<string, string>([
  // Various dash / hyphen code-points -> ASCII '-'
  ['‐', '-'],
  ['‑', '-'],
  ['‒', '-'],
  ['–', '-'],
  ['—', '-'],
  ['―', '-'],
  ['−', '-'],
  // Fancy single quotes -> '
  ['‘', "'"],
  ['’', "'"],
  ['‚', "'"],
  ['‛', "'"],
  // Fancy double quotes -> "
  ['“', '"'],
  ['”', '"'],
  ['„', '"'],
  ['‟', '"'],
  // Non-breaking space and other odd spaces -> normal space
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  ['　', ' ']
]);

function normalise(value: string): string {
  let out = '';
  for (const character of value.trim()) out += NORMALISED_CHARACTERS.get(character) ?? character;
  return out;
}
