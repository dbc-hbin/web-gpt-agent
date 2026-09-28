/** Read-only projection of an existing recovery deadline. Never authorizes an action. */
export type RecoveryCountdown = {
  kind: 'unattributed' | 'unattributed-wait' | 'assistant-error' | 'tab-recovery' | 'thinking-failed' | 'native-busy' | 'silence' | 'post-reload' | 'pickup';
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
