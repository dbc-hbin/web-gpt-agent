/** One completion policy for browser and tool delivery; authored user text stays unchanged. */
export function finishInstruction(leadMinutes?: number): string {
  return `Call session_finish only when the requested implementation is complete and about ${leadMinutes === 3 ? 3 : 5} minutes of final verification remain. It is not for progress updates or collecting queued tasks. Process new instructions before finishing; their arrival alone does not require another call.`;
}
