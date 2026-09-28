/** Offline Goal protocol. Only an exact last line is actionable; missing markers pause. */
export const GOAL_MARKER_INSTRUCTION = '\n\nEnd final replies with a last line: [[GOAL:COMPLETE]] if done, otherwise [[GOAL:CONTINUE]]. Omit when user input is needed.';
const GOAL_CONTINUATION = 'Continue the remaining requested work.';

export function templateGoalDecision(final: string): { action: 'stop' } | { action: 'continue'; reply: string } | { action: 'invalid'; error: string } {
  const last = final.trim().split(/\r?\n/).at(-1)?.trim();
  if (last === '[[GOAL:COMPLETE]]' || last === '[[COS_GOAL:COMPLETE]]') return { action: 'stop' };
  if (last !== '[[GOAL:CONTINUE]]' && last !== '[[COS_GOAL:CONTINUE]]') return { action: 'invalid', error: 'goal_marker_missing' };
  return { action: 'continue', reply: GOAL_CONTINUATION + GOAL_MARKER_INSTRUCTION };
}
