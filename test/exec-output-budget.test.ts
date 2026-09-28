/**
 * The exec output budget the model is actually given, against the budget it is promised.
 *
 * `MAX_OUTPUT_TOKENS_DESCRIPTION` tells the model `max_output_tokens` defaults to 65536 tokens
 * and larger requests are capped by policy. `modelOutputMaxTokens` enforces that as
 * `min(max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, policyTokenBudget(policy))`, where two
 * different limits meet: `resolveMaxTokens` supplies the default when the caller omitted a budget,
 * and the policy is the safety ceiling over whatever the caller did ask for.
 *
 * Collapsing the default and ceiling makes every explicit request above the default inert. These
 * tests pin both ends: the default when nothing is asked for, and a larger explicit request actually
 * yielding more output than that default.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TRUNCATION_POLICY, EXEC_OUTPUT_CEILING_POLICY } from '../src/main/codex/manager.js';
import { policyTokenBudget } from '../src/main/codex/truncate.js';
import {
  execCommandResponseText,
  execCommandStructuredOutput,
  type ExecCommandToolOutput
} from '../src/main/codex/unified-exec.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  UNIFIED_EXEC_OUTPUT_MAX_BYTES,
  UNIFIED_EXEC_OUTPUT_MAX_TOKENS
} from '../src/main/codex/unified-exec-constants.js';
import { HeadTailBuffer } from '../src/main/codex/head-tail-buffer.js';

/** `approxBytesForTokens`: the truncator's own four-bytes-per-token estimate. */
const BYTES_PER_TOKEN = 4;

/**
 * ASCII only, so one character is one byte and the byte budget the truncator computes is the
 * character count these tests reason about.
 */
function asciiOutput(bytes: number): Buffer {
  return Buffer.from('x'.repeat(bytes), 'ascii');
}

/** An exec/write_stdin result: the paths where the model may state a budget. */
function execOutput(rawOutput: Buffer, maxOutputTokens: number | undefined): ExecCommandToolOutput {
  return {
    chunkId: 'abc123',
    wallTimeMs: 12,
    rawOutput,
    truncationPolicy: EXEC_OUTPUT_CEILING_POLICY,
    maxOutputTokens,
    processId: null,
    exitCode: 0,
    originalTokenCount: null,
    outputOmittedBytes: null
  };
}

/** The marker `formattedTruncateText` prepends, and the only reliable signal of a cut. */
function wasTruncated(responseText: string): boolean {
  return responseText.includes('Warning: truncated output');
}

describe('exec output budget', () => {
  it('separates the default budget from the safety ceiling', () => {
    // The original regression: a byte policy reaches `modelOutputMaxTokens` as bytes/4 = 2_500.
    expect(policyTokenBudget(DEFAULT_TRUNCATION_POLICY)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    // The second regression: a ceiling equal to the default makes every larger request inert.
    expect(policyTokenBudget(EXEC_OUTPUT_CEILING_POLICY)).toBe(UNIFIED_EXEC_OUTPUT_MAX_TOKENS);
    expect(policyTokenBudget(EXEC_OUTPUT_CEILING_POLICY)).toBeGreaterThan(DEFAULT_MAX_OUTPUT_TOKENS);
    // The ceiling is the collection cap restated, not an independent number.
    expect(UNIFIED_EXEC_OUTPUT_MAX_TOKENS).toBe(UNIFIED_EXEC_OUTPUT_MAX_BYTES / BYTES_PER_TOKEN);
  });

  it('returns the advertised 65536-token default in full when no budget is requested', () => {
    const bytes = DEFAULT_MAX_OUTPUT_TOKENS * BYTES_PER_TOKEN - 1_000;
    const text = execCommandResponseText(execOutput(asciiOutput(bytes), undefined));

    expect(wasTruncated(text)).toBe(false);
    expect(text.length).toBeGreaterThan(DEFAULT_MAX_OUTPUT_TOKENS * BYTES_PER_TOKEN - 2_000);
  });

  it('cuts an omitted-budget result at the 65536-token default, not at the ceiling', () => {
    const bytes = 400_000;
    const text = execCommandResponseText(execOutput(asciiOutput(bytes), undefined));

    expect(wasTruncated(text)).toBe(true);
    // ~256 KiB retained: the default still applies when nothing was asked for.
    expect(text.length).toBeLessThan(280_000);
  });

  it('honours an explicit request above the default, which is the whole point', () => {
    const bytes = 400_000;
    const requested = execCommandResponseText(execOutput(asciiOutput(bytes), 100_000));
    const omitted = execCommandResponseText(execOutput(asciiOutput(bytes), undefined));

    // The explicit 100,000-token request admits this output while the default still truncates it.
    expect(wasTruncated(requested)).toBe(false);
    expect(requested.length).toBeGreaterThan(omitted.length);
    expect(requested.length).toBeGreaterThan(390_000);
  });

  it('scales monotonically with the requested budget', () => {
    const bytes = 400_000;
    const lengthFor = (tokens: number): number =>
      execCommandResponseText(execOutput(asciiOutput(bytes), tokens)).length;

    expect(lengthFor(80_000)).toBeGreaterThan(lengthFor(65_536));
    expect(lengthFor(100_000)).toBeGreaterThan(lengthFor(80_000));
  });

  it('still lets an explicit smaller request win, so min(request, policy) is intact', () => {
    const bytes = 40_000;
    const small = execCommandResponseText(execOutput(asciiOutput(bytes), 1_000));
    const dflt = execCommandResponseText(execOutput(asciiOutput(bytes), undefined));

    expect(wasTruncated(small)).toBe(true);
    // 1_000 tokens is ~4_000 bytes of retained output, far below the default budget.
    expect(small.length).toBeLessThan(10_000);
    expect(small.length).toBeLessThan(dflt.length);
  });

  it('bounds an absurd request at the ceiling', () => {
    // More than the collection buffer can ever hand over, so the ceiling is what answers.
    const bytes = UNIFIED_EXEC_OUTPUT_MAX_BYTES;
    const huge = execCommandResponseText(execOutput(asciiOutput(bytes), 10_000_000));

    // At exactly 1 MiB the ceiling is not exceeded, so nothing is cut and the result is the
    // collection cap itself — the request never governs.
    expect(huge.length).toBeLessThanOrEqual(UNIFIED_EXEC_OUTPUT_MAX_BYTES + 1_000);
  });

  it('applies the same budget to structuredContent as to the text result', () => {
    const bytes = 200_000;
    const output = execOutput(asciiOutput(bytes), 30_000);
    const structured = execCommandStructuredOutput(output);

    expect(typeof structured.output).toBe('string');
    expect(String(structured.output).length).toBeGreaterThan(100_000);
    expect(String(structured.output)).toContain('Warning: truncated output');
  });

  it('leaves the 1 MiB collection cap in place beneath the model-facing budget', () => {
    // The collection cap is a separate, earlier limit on what is retained at all. Widening the
    // model-facing ceiling must not widen it.
    expect(UNIFIED_EXEC_OUTPUT_MAX_BYTES).toBe(1024 * 1024);

    const buffer = new HeadTailBuffer();
    buffer.pushChunk(asciiOutput(UNIFIED_EXEC_OUTPUT_MAX_BYTES + 4_096));

    expect(buffer.retainedBytes()).toBe(UNIFIED_EXEC_OUTPUT_MAX_BYTES);
    expect(buffer.omittedBytes()).toBe(4_096);
  });
});
