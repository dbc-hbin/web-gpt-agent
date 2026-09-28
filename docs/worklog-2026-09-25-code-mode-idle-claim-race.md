# Code Mode claimed-output idle-expiry race

## Change

`src/main/mcp/code-mode-runtime.ts` only.

A completed cell arms a 60 s idle-removal timer (`scheduleIdleRemoval`) that calls
`removeCell`, which clears `cell.emissions`. `waitCodeMode` claims the cell synchronously —
before any `await` — but then awaits `resolveOwner`/`canAccessOwner` and the emission drain
(image decode). An idle timer that fired in that window freed the still-undelivered output
under the claimant, so a wait could silently lose admitted output for a cell that had just
completed.

The observation claim now owns the cell through delivery:

- `claimObservation` cancels an armed idle timer (`cell.idle`), so removal cannot run while a
  claimant is validating ownership or decoding output.
- The deadline itself moved to an absolute `cell.idleDeadline`, fixed the first time the cell
  goes idle — in `endCell` and in the worker `done` handler, claimed or not. A claim never
  restarts the idle window.
- `releaseObservation` re-arms whatever remains of that deadline, and removes the cell
  synchronously when the deadline already elapsed, so a forbidden or slow claimant cannot keep
  a dead cell alive by deferring a zero-length timer.
- `runCell` initializes the new field; `removeCell` clears it.

An unclaimed completed cell expires exactly as before, dropping its undelivered output.

## Regression

`test/code-mode-runtime.test.ts` — `delivers a claimed cell across idle expiry and still
expires an unclaimed one`, under fake timers with `cellIdleMs: 25`.

It seeds a cell that has ended (interrupted) while host-owned output is still undelivered, and
only reports that state after the guest's `notify("buffered")` — which the guest emits strictly
after `text("second")` — has been buffered. It then starts a wait whose `canAccessOwner` gate is
held by `Promise.withResolvers`, advances the fake clock past the idle window, releases the
gate, and asserts the exact content `INTERRUPTED` + `second` + `buffered`. The second half runs
the same end state with no claim and asserts the cell expired (`CODE_MODE_UNKNOWN_CELL`).

## Verification

- Failing-before: with the fix's cancellation removed (comment and `clearTimeout` of
  `cell.idle` deleted), the regression failed, receiving only the `CODE_MODE_INTERRUPTED`
  diagnostic with `second`/`buffered` already dropped by the idle removal.
- After the fix: `npx vitest run test/code-mode-runtime.test.ts` passed 46/46.
- On the final tree (after dropping a non-escaping clamp in `drainCell`), the touched suites
  passed together (`code-mode-runtime` + `code-mode-mcp`, 79 tests) and
  `npx vitest run --exclude test/mcp-shutdown.test.ts` passed 5,889 tests with 88 skips across
  217 files.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm run verify` passed ripgrep staging, privacy, notices, typecheck, the 5,889-test main
  suite (88 skipped) and the six shutdown tests.

Limitations: the changed path was exercised through the runtime's own QuickJS worker in Vitest
under fake timers only; no installed app, packaged bundle or live Desktop/Core client was
exercised, and no package, install or commit was performed.
