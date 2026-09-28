/**
 * What a handoff brief has to contain, in one place.
 *
 * One caller, now. These rules used to be shared with an external writer — a second model
 * that was handed a packed recording of the session and asked for the same document — and
 * keeping the two prompts from drifting was the reason this file exists. That path is gone:
 * the brief is written by the ChatGPT conversation that *is* the recording, and the answer it
 * writes is the brief. What survives is the specification of the document itself, which is
 * worth having in one named place whatever ends up reading it.
 */

/** Facts the next agent needs, without a prescribed layout or target length. */
export const HANDOFF_BRIEF_RULES = `Preserve the full user goal, requirements, corrections, constraints and unfinished requests; distinguish final decisions from superseded plans. User instructions outrank assistant guesses.
Include the current state, changed files/symbols, exact identifiers, relevant commands/errors and verification receipts. Distinguish observed results from claims, hypotheses and unverified work. Preserve failures, causes and attempted fixes so they are not repeated.
Record active work and where it stopped, worker assignments/results, pending approvals, uncertain operation outcomes, and repository/process/install state that the next agent must preserve. Finish with concrete next actions and what must not be redone or undone.
Use compact headings or bullets as needed, without repetition or an arbitrary length target. Keep every fact needed to continue without rediscovery; identify missing context rather than inventing it.`;

/**
 * The instruction typed into the ChatGPT conversation being compacted.
 *
 * The model is already the participant rather than a reader of a transcript, so there is no
 * recording to hand it and "the tool evidence" is its own call history.
 *
 * The brief leaves as the answer, deliberately. A tool call is a thing the model can retry,
 * skip, or make three different versions of, and every one of those was a way for a
 * compaction to end with the wrong brief or none. An answer cannot be retried: the page
 * watches this exact generation, and whatever it finally wrote is what gets carried across.
 * So there is nothing here to call, and nothing to get right except the writing.
 */
const marker = (kind: 'HANDOFF' | 'RESUME', token: string): string =>
  token ? `[[CLF-${kind}:${token}]]` : '';

export const sourceContinuationMarker = (token: string): string => marker('HANDOFF', token);
export const destinationContinuationMarker = (token: string): string => marker('RESUME', token);

export function nativeHandoffPrompt(token = '', includeToolCalls = true): string {
  const identity = sourceContinuationMarker(token);
  return (identity ? identity + '\n\n' : '') +
    'Write only a handoff brief for the next agent. Do not call tools. Use the conversation' +
    (includeToolCalls ? ' and tool evidence.\n\n' : '; omit raw tool arguments and results.\n\n') +
    HANDOFF_BRIEF_RULES;
}
