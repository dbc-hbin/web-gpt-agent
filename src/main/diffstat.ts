/**
 * Line add/remove counts for an edit, for the "+18 −4" in the activity timeline.
 *
 * Two passes. Common leading and trailing lines are trimmed first, which alone gives
 * the exact answer for the single contiguous change that `edit_file` usually makes.
 * What remains is compared with a real LCS when it is small enough to be cheap, and
 * only falls back to the trimmed block sizes for very large rewrites — which is why
 * the result says whether it is exact.
 */

/** Above this many lines on either side, the LCS pass is skipped as too expensive. */
const LCS_LINE_LIMIT = 1500;
/**
 * Maximum edit distance the sparse Myers pass will chase on a large residual block.
 *
 * A pair of tiny edits thousands of lines apart has a tiny D and is cheap even when N is
 * huge. A true rewrite has a huge D, so this bound stops before the quadratic/worst-case
 * work becomes interesting and lets the existing approximate fallback take over.
 */
const MYERS_EDIT_LIMIT = 512;

export interface LineDelta {
  added: number;
  removed: number;
  /** False when the numbers came from a real diff, true when they were bounded. */
  approximate: boolean;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  // A trailing newline produces one empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Length of the longest common subsequence of two line arrays, in rolling rows so
 * memory stays at two rows rather than the full matrix.
 */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[b.length] ?? 0;
}

/**
 * Exact shortest insert/delete edit distance for sparse large changes, bounded by D.
 *
 * Myers is the right second pass here because its useful complexity is O((N+M)D): the
 * 4,000-line file with two distant replacements that broke the old counter has D=4, while
 * a 4,000-line rewrite quickly hits the cap and remains explicitly approximate. We only need
 * the distance, not an edit script. Together with the length difference it uniquely gives
 * added and removed line counts.
 */
function boundedMyersDistance(a: readonly string[], b: readonly string[]): number | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(MYERS_EDIT_LIMIT, n + m);
  const offset = maxD + 1;
  const frontier = new Int32Array(2 * maxD + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;

  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      const index = offset + k;
      let x: number;
      if (k === -d || (k !== d && frontier[index - 1]! < frontier[index + 1]!)) {
        x = frontier[index + 1]!;
      } else {
        x = frontier[index - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      frontier[index] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return null;
}

/** Added and removed line counts between two versions of the same text. */
export function lineDelta(before: string, after: string): LineDelta {
  if (before === after) return { added: 0, removed: 0, approximate: false };

  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
  ) {
    end++;
  }

  const oldBlock = oldLines.slice(start, oldLines.length - end);
  const newBlock = newLines.slice(start, newLines.length - end);

  // One side empty means a pure insertion or deletion, which needs no diff at all.
  if (oldBlock.length === 0 || newBlock.length === 0) {
    return { added: newBlock.length, removed: oldBlock.length, approximate: false };
  }
  if (oldBlock.length > LCS_LINE_LIMIT || newBlock.length > LCS_LINE_LIMIT) {
    const distance = boundedMyersDistance(oldBlock, newBlock);
    if (distance !== null) {
      const net = newBlock.length - oldBlock.length;
      const added = (distance + net) / 2;
      const removed = distance - added;
      return { added, removed, approximate: false };
    }
    return { added: newBlock.length, removed: oldBlock.length, approximate: true };
  }

  const common = lcsLength(oldBlock, newBlock);
  return {
    added: newBlock.length - common,
    removed: oldBlock.length - common,
    approximate: false
  };
}

/** "+18 −4", "+214", "−83", or null when nothing changed. */
export function formatDelta(delta: { added: number; removed: number }): string | null {
  const parts: string[] = [];
  if (delta.added > 0) parts.push(`+${delta.added}`);
  if (delta.removed > 0) parts.push(`−${delta.removed}`);
  return parts.length === 0 ? null : parts.join(' ');
}
