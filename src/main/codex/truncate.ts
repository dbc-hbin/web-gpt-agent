/**
 * Codex output truncation, ported verbatim.
 *
 * Source: `codex-rs/utils/string/src/truncate.rs`, `codex-rs/utils/output-truncation/src/lib.rs`
 * and `TruncationPolicy` from `codex-rs/protocol/src/protocol.rs`.
 *
 * Every length here is a UTF-8 *byte* length, because the Rust original measures `str::len()`.
 * Using JavaScript's UTF-16 `String.length` instead would move the truncation point on any
 * output containing non-ASCII text and change the marker counts, so byte lengths are computed
 * explicitly throughout and code points are walked one at a time.
 */

const APPROX_BYTES_PER_TOKEN = 4;

/** UTF-8 byte length — the `s.len()` of the Rust source. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Rust `str::lines().count()`: a trailing newline does not open a further line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count++;
  }
  return text.endsWith('\n') ? count : count + 1;
}

export function approxTokenCount(text: string): number {
  const len = byteLength(text);
  return Math.floor((len + (APPROX_BYTES_PER_TOKEN - 1)) / APPROX_BYTES_PER_TOKEN);
}

export function approxBytesForTokens(tokens: number): number {
  return tokens * APPROX_BYTES_PER_TOKEN;
}

export function approxTokensFromByteCount(bytes: number): number {
  return Math.floor((bytes + (APPROX_BYTES_PER_TOKEN - 1)) / APPROX_BYTES_PER_TOKEN);
}

function splitBudget(budget: number): [number, number] {
  const left = Math.floor(budget / 2);
  return [left, budget - left];
}

function formatTruncationMarker(useTokens: boolean, removedCount: number): string {
  return useTokens ? `…${removedCount} tokens truncated…` : `…${removedCount} chars truncated…`;
}

function removedUnits(useTokens: boolean, removedBytes: number, removedChars: number): number {
  return useTokens ? approxTokensFromByteCount(removedBytes) : removedChars;
}

/** Number of Unicode scalar values, i.e. Rust's `chars().count()`. */
function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

interface SplitParts {
  removedChars: number;
  before: string;
  after: string;
}

/**
 * The `split_string` of the Rust source, in byte space.
 *
 * Byte offsets decide where the cut falls, but the slices must be taken with UTF-16 indices,
 * so both are tracked as the string is walked code point by code point.
 */
function splitString(text: string, beginningBytes: number, endBytes: number): SplitParts {
  if (text === '') return { removedChars: 0, before: '', after: '' };

  const len = byteLength(text);
  const tailStartTarget = Math.max(0, len - endBytes);
  let byteIndex = 0;
  let unitIndex = 0;
  let prefixEndUnits = 0;
  let suffixStartUnits = text.length;
  let suffixStarted = false;
  let removedChars = 0;

  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch, 'utf8');
    const charEnd = byteIndex + charBytes;
    if (charEnd <= beginningBytes) {
      prefixEndUnits = unitIndex + ch.length;
    } else if (byteIndex >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStartUnits = unitIndex;
        suffixStarted = true;
      }
    } else {
      removedChars++;
    }
    byteIndex = charEnd;
    unitIndex += ch.length;
  }

  if (suffixStartUnits < prefixEndUnits) suffixStartUnits = prefixEndUnits;
  return {
    removedChars,
    before: text.slice(0, prefixEndUnits),
    after: text.slice(suffixStartUnits)
  };
}

function truncateWithByteEstimate(text: string, maxBytes: number, useTokens: boolean): string {
  if (text === '') return '';

  const totalBytes = byteLength(text);
  if (maxBytes === 0) {
    return formatTruncationMarker(useTokens, removedUnits(useTokens, totalBytes, countCodePoints(text)));
  }
  if (totalBytes <= maxBytes) return text;

  const [leftBudget, rightBudget] = splitBudget(maxBytes);
  const { removedChars, before, after } = splitString(text, leftBudget, rightBudget);
  const marker = formatTruncationMarker(
    useTokens,
    removedUnits(useTokens, Math.max(0, totalBytes - maxBytes), removedChars)
  );
  return `${before}${marker}${after}`;
}

/** Truncate to `maxBytes`, reporting the cut in characters. */
export function truncateMiddleChars(text: string, maxBytes: number): string {
  return truncateWithByteEstimate(text, maxBytes, false);
}

/** Truncate to an approximate token budget, reporting the cut in tokens. */
export function truncateMiddleWithTokenBudget(
  text: string,
  maxTokens: number
): { text: string; originalTokenCount: number | null } {
  if (text === '') return { text: '', originalTokenCount: null };
  if (maxTokens > 0 && byteLength(text) <= approxBytesForTokens(maxTokens)) {
    return { text, originalTokenCount: null };
  }
  const truncated = truncateWithByteEstimate(text, approxBytesForTokens(maxTokens), true);
  if (truncated === text) return { text: truncated, originalTokenCount: null };
  return { text: truncated, originalTokenCount: approxTokenCount(text) };
}

export type TruncationPolicy = { kind: 'bytes'; bytes: number } | { kind: 'tokens'; tokens: number };

export function policyTokenBudget(policy: TruncationPolicy): number {
  return policy.kind === 'bytes' ? approxTokensFromByteCount(policy.bytes) : policy.tokens;
}

export function policyByteBudget(policy: TruncationPolicy): number {
  return policy.kind === 'bytes' ? policy.bytes : approxBytesForTokens(policy.tokens);
}

export function truncateText(content: string, policy: TruncationPolicy): string {
  return policy.kind === 'bytes'
    ? truncateMiddleChars(content, policy.bytes)
    : truncateMiddleWithTokenBudget(content, policy.tokens).text;
}

export function formattedTruncateText(content: string, policy: TruncationPolicy): string {
  if (byteLength(content) <= policyByteBudget(policy)) return content;
  const originalTokenCount = approxTokenCount(content);
  const totalLines = countLines(content);
  const result = truncateText(content, policy);
  return `Warning: truncated output (original token count: ${originalTokenCount})\nTotal output lines: ${totalLines}\n\n${result}`;
}
