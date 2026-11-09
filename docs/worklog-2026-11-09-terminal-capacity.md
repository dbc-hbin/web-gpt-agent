# Terminal capacity and completed-result retention

The MCP terminal manager retained exited, unread commands in the same reservation set as live commands. A request-scoped launch without exact chat attribution could therefore leave output that later requests could not poll, eventually exhausting the shared 64-session limit. Repeating a launch could not release that debt.

The user explicitly approved finite retention of completed results, including unread results, and expiring older output. The initial limit was 64 results; a follow-up request increased it to 256. Cross-chat ownership remains enforced. This replaces indefinite unread retention; it does not grant another chat permission to read output or write stdin.

## Changes

- Once a yielded command has exited and its output streams have closed, the manager freezes its result and frees its live reservation. The process instance and interaction lock fence retirement against polling, initial response collection, shutdown and replacement.
- Completed results retain their unread suffix for the first explicit poll and bounded history for subsequent labelled rereads. The cache now bounds read and unread completed results together at 256 entries. Running commands keep the separate 64-reservation limit.
- Removed the four-unread-results launch refusal and its obsolete promise of automatic output delivery. Completed output is collected explicitly through `write_stdin`.
- Cache eviction and shutdown retire the corresponding ownership entry. Unavailable-session guidance explains finite completed-output retention and says not to rerun work solely because its output is unavailable.
- Both terminal tool descriptions require collecting every returned running session through completion and clearing unread output before retention expires. The product map documents the new policy and preserves cross-chat isolation.

## Verification

Before the runtime change, the revised capacity regression failed when attempting a launch alongside one completed unread command and 63 reservations. The failure was the reported 64-session admission error.

After the change:

```text
npm test -- --run test/unified-exec-mutex.test.ts test/exec-completed-results.test.ts test/codex-runtime-parity.test.ts test/mcp.test.ts
4 files passed; 181 tests passed; 10 existing conditional tests skipped.
```

The MCP suite uses the production registrar over isolated real HTTP with real child processes. It verifies launches despite unread completed results, explicit collection, cross-chat refusal and continuation custody. The manager regressions verify freeing unread completion capacity, preserving the live reservation limit, bounded replay output, and expiration of old unread results.

Independent review found that the first cached unread delivery lost its omission metadata. A focused regression reproduced `outputOmittedBytes: null` instead of the omitted byte count. The cache now preserves both the original token estimate and omitted-byte count, and the final focused run above includes that regression.

`npm run verify` passed the ripgrep checksum, public-history privacy, dependency notices, native-source inventory, typecheck and Electron resolution stages. The main test run reported 223 passing files and 5,140 passing tests, with 8 failing files caused by the pre-existing deletion of `extension/chatgpt-dom.js` (7 suite-loading errors and 4 test failures), plus 4 skipped files. The command consequently did not reach its final shutdown stage; running `npm test -- --run test/mcp-shutdown.test.ts` separately passed all 6 tests.

After the metadata correction, `npm run typecheck`, the four focused suites above, and `npm run build` all passed. The build reported existing dynamic/static import and dependency-comment warnings. The full suite was not rerun after this focused metadata correction; its unrelated missing-extension failures remain.

The optional skill TypeScript audit failed inside its own script because `ts.isParameter` is unavailable in the installed TypeScript API. The skill test-quality audit reported an existing fixed sleep at `test/unified-exec-mutex.test.ts:31`, outside the changed test. Neither audit was suppressed or changed.

No package, installation, production backend restart or live-session cleanup has been performed. Existing unrelated deletions in the shared tree were preserved.

## Follow-up: increase completed-result retention

The completed-result limit was increased from 64 to 256 entries. Per-result byte bounds and the separate 64 live/spawning-session limit remain unchanged. Tool descriptions and unavailable-session guidance derive the new number from the same constant. The eviction regression now fills the cache exactly, verifies that both the oldest read and unread results remain available at the bound, then verifies eviction only after exceeding it.

For this follow-up, `npm run typecheck` and `npm test -- --run test/exec-completed-results.test.ts test/unified-exec-mutex.test.ts test/mcp.test.ts` passed: 3 files, 164 passing tests and 7 existing conditional skips. `git diff --check` passed. The full verification and build results above precede this limit increase; neither was rerun for the follow-up. The running production app has not been replaced or restarted.
