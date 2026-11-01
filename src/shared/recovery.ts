/** Read-only projection of an existing recovery deadline. Never authorizes an action. */
export type RecoveryCountdown = {
  kind: 'unattributed' | 'unattributed-wait' | 'assistant-error' | 'tab-recovery' | 'thinking-failed' | 'native-busy' | 'silence' | 'post-reload' | 'pickup' | 'provider-limit';
  deadline: number;
  /** The existing UI clock reveals this row without needing a new backend event. */
  visibleAt?: number;
  next?: 'queue' | 'goal' | 'loop' | 'continue';
  /** The original attribution retry conditions are currently satisfied. */
  reload?: true;
  /** The controller still holds the source turn open during the existing post-reload wait. */
  generating?: true;
};

export function recoveryMessage(): string {
  return 'Continue the requested work. Review the current state first so completed work is not repeated.';
}

/** The existing silence clock gets one half-window only when the native page is busy. */
export const recoveryBusyMs = (pro: boolean): number => (pro ? 5 : 1) * 60_000;

/**
 * The app's automatic continue that starts a fresh turn in a long one (#1402). Plain on purpose:
 * it is sent into a turn the model is still working in, and only has to carry the work on.
 */
export function rotationMessage(): string {
  return 'Continue the task from where you are. (The app starts a fresh turn every so often so long work stays reliable; nothing else changed.)';
}
