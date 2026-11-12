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

## Deployment attempt and rollback

The terminal changes were committed as `69175204` before deployment, as requested. A separate worktree at that commit preserves the unrelated deletions in the user's working tree. Its complete `npm run verify` passed: 232 test files and 6,421 tests passed, with 4 files and 86 conditional tests skipped; the separate shutdown suite passed all 6 tests.

The macOS arm64 package was built and sealed with the existing local signing identity. Bundle metadata, executable modes, native resources, and the packaged plain-Node daemon start/stop checks passed. The package contains the 256-result limit and mandatory output-collection guidance. Its ASAR SHA-256 is `41332b2753d30ddc4c660cb8c2894da50e4c608b803f74de867289d714062f02`.

The GUI startup smoke failed: the backend answered `host.status`, but `state:get` did not complete and no GUI window appeared. A separate isolated launch reproduced it. A disposable inspector run directly observed `safeStorage.isAsyncEncryptionAvailable()` remain pending after Electron reported ready; the synchronous availability probe also failed to return within its observation bound. Both original and candidate packages use Electron 44.3.0 and the same designated signing requirement. These observations identify the native storage boundary but do not establish its underlying cause.

The candidate was then tested at the authorized original installation path, with the original bundle retained for rollback. The same state-readiness failure occurred. The candidate was shut down, its durable shutdown completion was observed, and the original bundle was restored. The original GUI launched successfully, its backend returned `state:get` with secure storage available, its bridge resumed, and the Core/Desktop tunnels connected. No live ledgers were edited.

At that point, the new terminal implementation was committed and packaged but was not the running installation. ChatGPT MCP plugin refresh had not been performed against the failed candidate. Native browser attachment was refused for lack of a host grant; no attachment permission was bypassed, and Chrome was inspected through its native accessibility interface.

## Relaunch after Keychain approval

At the user's request, the candidate was restored to the original installation path and launched again before asking for Keychain approval. After the user confirmed approval, the candidate backend returned `state:get` successfully with secure storage available, Core and Desktop live, and the bridge running. Its real GUI rendered and displayed the connected state. The installed ASAR matched the candidate SHA-256 above. A live Core `tools_search` read returned both terminal descriptions with the 256-result retention limit and mandatory `write_stdin` collection instructions.

This establishes successful startup after the user's Keychain action, without establishing why the earlier native availability calls had stalled. The original bundle remains retained for rollback. No live ledgers or browser attachment grants were changed.

In the signed-in Chrome profile, the Core and Desktop plugin management pages each received their native "Refresh tools" action. The Core control was observed disabled during its request and enabled again afterward; Desktop also returned to its enabled state. The running backend logged two successful HTTP 200 MCP requests for each surface at the corresponding action time, with no refresh error shown. This verifies the native refresh flow and successful provider discovery responses; the manual action did not populate the app's separate automatic-refresh ledger.

Chrome foreground activation was separately approved after its native dropdown refused background opening. No existing-profile debugging grant was added. The loaded companion still reports version 2.2.1, distinct from the new 2.3.0 app package; extension replacement was not part of this terminal deployment. Existing unrelated file deletions remain preserved.

## Requested backup cleanup and companion reload

On the user's subsequent request, the obsolete 2.2.1 rollback bundle and redundant deployment backup copy were removed. The current installed ASAR retained the verified hash above, and its backend still ran from the current release path. The prepared userData extension manifest and the packaged manifest both reported 2.3.0.

Chrome's native extension manager identified the Web GPT Agent companion, reported version 2.3.0 and returned "Reload completed" after its card's Reload action. The backend subsequently logged `bridge: browser extension 2.3.0 connected`, confirming the loaded companion reconnected. No browser security settings or live ledgers were changed.
