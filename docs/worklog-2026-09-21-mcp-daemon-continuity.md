# MCP daemon and conversation continuity

Implementation and verification notes for `feat/mobile-conversation-continuity`.
The branch has two goals: relay messages written in the same ChatGPT conversation
on mobile to a desktop-managed work, and provide an independent Node MCP daemon
that does not require the desktop application. This document separates implemented
behavior, observed verification results, and remaining work.

## Implemented architecture

### Resident backend activation (2026-09-28)

- A resident macOS backend had no activation handler after its GUI exited. It now routes
  native activation and ordinary second-instance launches through the existing GUI entry,
  retaining the data directory. Host-only launches remain headless; early relaunches coalesce
  until control readiness, and quit revokes pending activation. Notification session targeting
  keeps its existing path.
- The 12 lifecycle tests passed, followed by the production build. An isolated Electron
  backend started with no window or GUI profile. Inspector-injected host-only relaunches
  retained that state; activation created a visible GUI, verified through native accessibility.
  A second ordinary relaunch retained the same GUI window and backend process. This exercised
  real Electron event handlers, not a physical Dock/LaunchServices click. Temporary processes
  and data were removed; the installed app and its data were not replaced.

### Sidebar input dependency and recovery investigation (2026-09-28)

- `sessions:list` used the full serialized `listInputs()` on every refresh, solely to recover
  initial helper origins. It now waits on `restoreInputs()` instead. Actual completed initial
  loading satisfies that barrier even before the first sidebar request. Ongoing input
  preparation cannot hold a newly recorded session out of the sidebar; claims and native
  Send authorization retain their existing serialized owner.
- Focused regressions preserve initial helper hiding and show a newly created session while
  another input's preparation is held. This removes a proved display dependency; it does not
  establish that browser observation itself was slow.
- The earlier automatic Continue wait remains unconfirmed at its originating operation.
  Before an external backend restart, controls/outbox reads exceeded their 15/30-second
  probe bounds. The restart erased the pending operation. Matching production input code and
  a valid 599,406-byte recovery-history fixture completed ticket creation, outbox reading and
  browser-offer lookup in 23–49 ms. Inspected input/store paths yielded no reproduced cycle.
  No timeout override, forced resend or speculative recovery-policy change was added.
- `npm run verify` passed: 213 test files, 5,878 tests, and six separate shutdown tests;
  83 tests were skipped. Privacy, notices and typecheck passed. The production Electron,
  CLI and daemon builds passed. After hardening failed initial restoration to discard its
  partial cache and retry, ten input suites passed all 668 tests and typecheck passed again.
  The final production build passed.
- The isolated API smoke exercised production IPC handlers, input and real session storage:
  a held preparation did not delay the new-session list, and release preserved one durable
  claim owner and exact Send authorization. Its headless native Electron harness did not
  reach readiness, so this smoke used a throwaway Electron transport stub; it does not prove
  cross-process GUI transport or signed-in ChatGPT delivery. Temporary fixtures were removed.

### Automatic Continue survives delivered-input history replay (2026-09-28)

- Restart reprojects wrapped outbox receipts into canonical history. When the native page
  had reserialized that same message, restoring its frozen delivery text advanced the old
  question's work stamp and cancelled an otherwise eligible Continue as new work.
- `recordDeliveredInput` now publishes both text and later image enrichment as non-working
  revisions. The store preserves an existing message's work stamp while a new message identity
  still advances work. Recovery eligibility, source comparisons and Send custody are unchanged.
- The integration regression failed before the fix because the restored Continue was cancelled.
  A separate-process smoke using production history/storage modules and temporary disk state
  preserved question work sequence 1 and current work sequence 4 after cold replay, restored
  the frozen text and chronology, then advanced a genuinely new delivered input to sequence 6.
  It used no browser or Electron mocks; it did not replace the installed runtime or exercise
  signed-in provider recovery after the fix.
- Adjacent input-history, retention, session-input, session-store and managed-outbox suites
  passed all 389 tests.
- The two new integration cases pass after the fix: replay remains send-authorizable,
  while a new native question revokes the old claim before Send. The complete input-delivery
  integration suite passed all 257 tests.
- `npm run verify` passed privacy, license/native-source notices, typecheck, 5,880 tests
  in 213 passing files and six separate shutdown tests; 83 tests were skipped. No package
  installation or live-ledger repair was performed.

### Packaged runtime replacement (2026-09-23)

- The prior detached host was stopped through its authenticated control socket and its GUI
  quit before the arm64 package was replaced. A stopped historical managed work with an
  unreadable session no longer prevents startup; its binding stays untouched, and explicit
  resume refuses to lift the fence without session proof. The isolated regression failed
  before this repair and passed afterward, including a valid prime rebind beside the orphan.
- `npm run verify` passed (231 files / 5,998 tests, then six socket-drain tests), as did
  `dist:dir:mac:arm64` and both packaged-runtime and macOS-bundle smokes. The new
  packaged GUI and backend PIDs ran from `release/mac-arm64/Web GPT Agent.app`;
  authenticated `host.status` and the bridge startup log proved backend readiness.
- Initial GUI presentation waited on a macOS Keychain request: `gui.invoke state:get`
  did not return in 90 seconds, and a process sample showed `SecItemCopyMatching` waiting
  on SecurityAgent. After the user approved it, the packaged GUI displayed the live workspace
  with New Chat and Settings controls and a Connected status. Cua's AX snapshot and screenshot
  proved the renderer was visible; no signed-in ChatGPT send was exercised.

### Explicit file access mode (2026-09-23)

- `fileAccessMode` defaults and migrates to `approved-roots`; malformed values fail closed.
  Workspace Settings requires a confirmation to enable `all-files`. The plain-Node daemon
  accepts the deliberate `wgpt daemon config file-access` command. Both publish the same
  saved choice, without auto-approving a project folder merely because All files was on.
- The local filesystem resolver admits native absolute local paths outside approved roots only
  in that mode. Virtual approved aliases, capability/Read-only guards, per-call path checks,
  search cursor scope and managed-work identity still apply. No-root relative ordinary paths
  start at home; unscoped search still needs an explicit directory. Revocation refuses further
  outside-root access, including a selected project's AGENTS.md injection.
- Source checks: focused sandbox, search, config, IPC, daemon and prompt suites; a temporary
  native file read exercised restricted refusal, enabled access, rootless access and revocation.
  An isolated Electron renderer fixture showed the selector, two options and warning in bounds.
  Neither fixture proves a signed-in ChatGPT conversation or an installed package.
- The installed GUI showed the new File access row and warning flush against the folder card
  while its heading and existing root row had an inset. The row and warning now use that
  20px horizontal inset. An isolated Electron render of the production markup/CSS was
  visually inspected at normal and narrow widths; measured label/warning starts matched
  the root icon, with the selector inside the right edge. `npm run verify` passed (231 files,
  5,998 tests, then six socket-drain tests), as did `npm run build`. An arm64 bundle was built
  in a separate staging directory with the packaging script's native/resource preparation and
  output override; packaged-runtime and macOS-bundle smokes passed before publication. The old
  GUI and host exited through their normal/native and authenticated control paths. The replacement
  GUI (PID 34461) and host (PID 34465) ran from the published bundle, and a fresh Cua screenshot
  showed File access, its warning and the selector inset with the existing folder row. No ChatGPT
  message was sent during this GUI verification.
- `npm run verify` passed: 231 test files / 5,997 tests in its main run, plus the six
  socket-drain tests; privacy, notices and TypeScript checks passed. `npm run build` passed
  for Electron main/preload/renderer, CLI and plain-Node daemon bundles. The Settings focus
  pixel fixture stopped on its existing language dropdown's 29-pixel repaint difference;
  it did not exercise this new selector, which was checked with the isolated Electron fixture.

### Native failure recovery and stale compaction ownership (2026-09-23)

- Native disclosure recognition now accepts the exact English/Korean Thinking failed and
  Stopped thinking labels on the owned assistant turn, retaining distinct `thinking_failed`
  and `thinking_stopped` reasons. Quoted/hidden content and a transient interruption marker
  alone do not qualify. A provider interruption never becomes trusted human Stop intent.
- Generated Continue can use a recorded exact native failure before the first MCP call,
  under the existing Auto Continue or effective Goal/Loop policy. Ordinary silence still
  requires exact current-turn MCP execution. Authored pending input keeps priority and its
  existing MCP admission; workers/helpers retain their separate recovery ownership.
  The same source verdict controls the reload, outbox admission and countdown projection.
- Recovery keeps the existing actual-work deadline, one reload and confirmed-reload listening
  ownership. Native failure/interruption uses two minutes normally and five for Pro. Manual
  Stop, new work/question, a final, drafts and ambiguous Send custody retain their vetoes.
  A late canonical user message may prove its question through its exact turn id rather than
  incidental journal arrival order; a foreign turn cannot supply that proof. Before a durable
  Continue ticket exists, host restart does not reconstruct process-memory reload authority
  from an old failure alone.
- Session metadata now owns a monotonic `bindingEpoch`. Continuations freeze that epoch,
  refuse obsolete sources, and durably retire stale never-attempted WAL entries. A same-clock
  A-to-B-to-A cycle cannot revive old work. Attempted/dispatched sends retain uncertain custody.
- Managed prime bindings follow the durable session rebind before commit completion; failure
  leaves B current and the WAL committing/retryable, never rolled back to A. Common host startup
  reconciles the ledger before recovery, replacing the old polling-based projection. Failed
  host checkpoint/queue preparation retires only its own newly created unsent transaction.
  Unreadable or unproven legacy bindings fail closed. The brief-size guard, 400k threshold and
  ordinary Pro auto-compaction exclusion were not weakened.
- New stale-source and localized/native-only recovery regressions failed against the prior
  implementation. Scoped compaction/runtime/recovery suites passed 103 tests; content/DOM
  suites passed 798. The first full run exposed invalid unbound bootstrap fixtures and input
  priority regressions. The fixtures were made production-valid and the actual input guards
  repaired; input-delivery/completion integration then passed 263 tests. The final countdown
  assertions passed all 20 targeted admission cases, including Goal/Loop with Auto Continue off.
- Full `npm run verify` passed: 5,988 tests passed, 134 skipped, then all six separate shutdown
  tests. Privacy, notices and typecheck passed. Final typecheck and desktop/preload/renderer,
  CLI and Node daemon production builds passed after the last projection edit.
- A throwaway real Electron/storage smoke independently passed durable A-to-B commit, old-A
  refusal, stale never-sent WAL retirement, uncertain dispatched receipt preservation and a
  same-millisecond A-to-B-to-A epoch check. Its script, bundle and temporary data were removed.
- The patched read-only DOM adapter ran in an isolated world on signed-in Korean ChatGPT:
  native turns/composer were readable, no false failure was returned, and provider DOM was
  unchanged. Separate real Chromium fixtures accepted the five supported labels and rejected
  quoted/hidden headers, a normal finished-thinking label and interruption-marker-only input.
  No live native failure button was present; no provider generation, Stop, reload or Send was
  triggered. The verification browser space was closed.
- Updated the owning contracts in `AGENTS.md`. Preserved `exec_read` and unrelated existing
  edits. No package, installation, commit or live-ledger repair was performed; the running
  installed application remains unchanged.

### Wrapper restoration retaining exec_read (2026-09-23)

- The user chose to undo the uncommitted direct-tool experiment and explicitly retain
  `exec_read`. HEAD `47fff57` already contains its declaration, Core registration and
  trusted read-tool allowlist; no pre-`exec_read` baseline was selected. Restored the
  wrapper implementation, dependencies, lifecycle wiring and tests, while preserving
  the pre-existing `src/main/work/runtime.ts` change and the experiment evidence below.
- Core again publishes `exec_read`, `exec`, `wait`, `tools_search` and eligible lifecycle
  tools. README and Plugins documentation were corrected to include the existing
  `exec_read`/`wait` contracts instead of restoring their stale shortened catalog lists.
- Typecheck and the production build passed. Six relevant wrapper/MCP suites passed
  275 tests with 12 skipped. A separate built daemon accepted `exec_read` over real MCP:
  fixture reading succeeded, while `exec_command` and `apply_patch` were unavailable
  inside that wrapper and created no mutation files. The daemon and fixture were removed.
- The full `npm run verify` then passed: 5,971 tests passed and 134 skipped across
  231 passing and 13 skipped files, followed by all six separate shutdown tests.
  Privacy, dependency/native-source notices, typecheck and Electron resolution passed too.
- Rebuilt and installed the arm64 wrapper app. Packaged runtime/signature checks and
  the 624-entry installed payload comparison passed. After the user approved macOS
  credential access, the GUI and backend were healthy; config/secrets/installation
  hashes and the existing 17 work identities/statuses were preserved. Native ChatGPT
  Core Refresh returned HTTP 200 and displayed exactly `agents`, `exec`, `exec_read`,
  `session_finish`, `tools_search`, `wait` and `work`. Removed staging/rollback backups
  and closed the verification browser space. One final app remains; no commit was made.

### Direct MCP experiment — superseded by wrapper restoration

- Temporarily replaced app-owned `exec_read`, `exec`, `wait` and `tools_search` publication
  with each enabled Core, Desktop and Plugins operation directly. This experiment was
  subsequently reverted as described above; its verification evidence remains below.
- Removed the interpreter, cells, scratch state, runtime lifecycle hooks and QuickJS
  dependencies instead of retaining a compatibility execution path. Existing terminal,
  search, patch, permission, attribution, recording and managed-operation implementations
  remain. Historical nested recordings and native ChatGPT Code Mode observation stay intact.
- Core patches use the normal MCP `{patch}` object. Structured search pages and terminal
  results reach the caller directly alongside MCP text. Plugins retain original names,
  full schemas/results and their existing `{arguments, operation_id?}` receipt envelope.
- Connection status and refresh publication use the actual registration catalog. Retired
  wrapper names are recognized only in cached provider declarations for refresh migration;
  they are not callable aliases. Installed ChatGPT connectors still need Refresh.
- Built the production CLI/Node daemon and launched a separate process with fresh temporary
  data. Approved a fixture folder through the real CLI, then verified direct discovery,
  absence of app wrappers, unavailable Desktop's empty catalog, read, Unicode patch bytes,
  structured search pagination, terminal execution and retained output rereading without
  repeating the command's file side effect. An outside-root read was refused. The daemon
  exited zero and its temporary state was removed.
- Affected connection, IPC, platform and instruction suites passed. Refresh migration and
  real-HTTP daemon suites passed 35 tests after correcting their direct-call fixtures and
  recognizing JSON-RPC errors in the daemon test client.
- The full `npm run verify` passed privacy, dependency/native-source notices, typecheck and
  Electron resolution. Its main suite had 5,890 passed, 132 skipped and 16 failures in six
  remaining tests files that still invoked the retired wrapper or expected its tool list.
  Those callers were migrated; the interpreter-only audio emission case was removed.
  All six affected files then passed together (32 tests), and final typecheck passed.
  No production source changed after the broad run; the unchanged broad suite was not rerun.
- The separate shutdown suite passed all six tests. `npm run build` built the desktop,
  preload, renderer, CLI and standalone daemon; the isolated direct-call smoke passed again
  against that final bundle. Its temporary script and fixture state were removed.
- At that source-validation checkpoint, no packaging, installation, live app data or
  signed-in ChatGPT conversation changed. Later authorized installed acceptance follows.

### Installed direct MCP acceptance (2026-09-23)

- At the user’s explicit request, rebuilt the arm64 app, checked its packaged runtime and
  strict bundle signature, and replaced the installed `release/mac-arm64/Web GPT Agent.app`.
  All 584 installed payload entries matched the verified staged manifest. The exact GUI
  and backend restarted successfully after the user personally approved macOS credential
  access. Config, encrypted secrets and installation-identity hashes remained unchanged;
  all 17 existing work identities/statuses were preserved. One existing work revision
  advanced during the interval. The rollback backup and staging directory were removed,
  leaving one final app.
- Native signed-in Core Refresh returned HTTP 200. Its settings catalog showed 14 direct
  tools, including `read`, `find`, `exec_command` and `write_stdin`, without the retired app
  wrappers. Desktop Refresh returned HTTP 424: its saved screen/control/clipboard
  permissions were all Off, so the optional Desktop surface/tunnel was not published.
  No permission or configuration was enabled to make that check pass.
- Repeated the earlier 18-case matrix using GPT-5.6 Sol High, confirmed by native selection
  and generation metadata (`gpt-5-6-thinking`, selected effort `extended`). GPT-6 Pro was
  not used. The initial prompt incorrectly prohibited ChatGPT’s own `functions.exec`
  gateway as well; no cases ran until this was clarified. Subsequent calls used that
  provider gateway to invoke the app’s individual MCP operations, never the removed app
  interpreter. Current schema types/bounds were honored for `include` and terminal yield.
- Thirteen cases reached their expected result, including intentional local refusals:
  R1–R4 (batched reads, partial failure, path equivalence and traversal denial), F1–F5
  (stable cursor replay, invalid/mixed cursor rejection, empty results and invalid regex),
  T1 (shared shell state and section exits 0/1/0), T2 (no-match exit 1 with `benign_exit`),
  T5 (outside-root cwd refusal), and O1 (exact Unicode output).
- Five cases were refused by OpenAI’s safety check before local execution: T3 missing rg
  input, T4 missing command, T6 missing shell, T7 asynchronous launch, and O2 bounded large
  output. They were not retried or reformulated. T7 yielded no process ID, so its poll,
  completed reread and post-completion input checks were not exercised in this live run.
  The prior run had three provider-blocked cases (T2/O1/O2); this run does not establish
  a safety-decision improvement or regression attributable to the cutover.
- Native tool responses and the exact native request ID were compared with the local
  journal: 14 recorded calls (4 read, 6 find, 4 exec_command). The mixed-query/cursor case
  failed schema validation before the kernel; the five provider refusals had no local
  execution rows. These records remained Unattributed, so request-level corroboration
  does not establish extension-backed conversation ownership. No live ledger was edited.

### Codex code-mode execution contract (2026-09-22)

- Pinned the comparison to `openai/codex@94174e44cbc54cece45f6052328ca0c2cd7a8a2a`.
  Core nested patch calls now take raw strings and return `{}`; terminal calls return their
  structured object, image reads return `{image_url}`, and ordinary Core output is native
  text. Core failures throw. External MCP, Desktop and Plugins retain raw envelopes,
  including upstream errors as data. Existing direct app lifecycle controls are unchanged.
- Added background `exec`/`wait`, first-line yield/output pragmas, bounded timers,
  `exit`, `yield_control`, JSON-cloning `store`/`load`, explicit audio/generated images and
  buffered notifications. Yield does not pause execution. Session/surface identity owns
  state and exclusive output collection; anonymous calls remain stateless. The subsequent
  user-requested output-budget correction below deliberately enlarges the Codex default.
- Retire cells at accepted Stop, Block and successful durable frontend rebind. A failed
  metadata commit preserves the original execution; A→B→A cannot revive it. Already
  dispatched child effects retain their existing execution and recording custody. Wait
  records its own full truncated output rather than modifying a completed exec record.
- Kept one host-owned JSON store, with canonical request/session proof, host write order
  and atomic quota checks. No guest state mirror, extra alias authority, retry loop or
  persistent interpreter was introduced. Audio assets use the existing recorder and quota.
- An isolated real HTTP MCP smoke passed raw patch creation and native shell output;
  background timer completion before wait; single output collection and foreign-owner
  refusal; completed request state adopting late exact session proof without overwriting
  newer values; Block/native Stop preventing a later real file write while another chat
  continues; image/generatedImage/audio/notify output and exact recorded WAV bytes. The
  generated-image hint did not create a file. All fixture state was temporary and isolated.
- Initial parity verification: the 43 runtime and 36 recorder-identity regressions passed. `npm run build`
  built main/backend/client, preload, renderer, CLI and Node daemon. `npm run verify` passed
  its resource checksum, privacy, notices, native-source, typecheck and Electron checks;
  its broad Vitest run had 5,942 passed, 134 skipped and three stale-contract failures.
  Those failures were migrated in `exec-output-budget-mcp`, `feature-parity` and
  `plugin-refresh`; all three files passed in affected reruns. The real output-budget test
  then checked retained head/tail data and equal bounded results instead of formatter prose.
  The separate shutdown suite then passed all six tests, and the final typecheck passed.
  The full verify command was not rerun after these test-only corrections. Throwaway smoke
  sources, generated smoke bundles and scratch tests were removed; normal build outputs remain.
- Output-budget correction: exec/wait previews now default to 1 MiB (262,144 estimated
  tokens), with a 4 MiB maximum (1,048,576 tokens). `textBytes` is the preview ceiling,
  not emission admission; the 12 MiB encoded emission and 12/32 MiB nested-result limits
  are unchanged. Terminal calls now honor `max_output_tokens`, with a 256 KiB default
  and existing 1 MiB ceiling. Raw collection and completed-result retention are unchanged.
  The outer preview leaves room for ordinary terminal envelopes instead of imposing
  another 40 KB cutoff. MCP/managed-gate response serialization adds no hidden text clip.
- The new real-HTTP regressions parse the complete large JSON instead of replacing it
  with a small in-script summary. Runtime/MCP checks passed 62 tests (3 skipped); terminal
  budget/completed-result checks passed 15 tests; typecheck passed. Explicit small budgets
  still clip honestly and preserve full admitted recording. A clipped JSON prefix is not
  a complete JSON value, and wait does not replay its omitted suffix.

- A separate isolated HTTP smoke passed complete 300 KB UTF-8 JSON with the default
  outer budget, complete 200 KB JSON from a real shell with default budgets, requested
  300 KB terminal JSON and 1.2 MB outer JSON, a 300 KB yielded-cell wait result, and
  explicit small-budget UTF-8-safe clipping. A real patch after the clipped emission
  proved execution continued. Temporary state, smoke source and bundle were removed.
- The output-budget full verify passed resource/privacy/notices/native-source/type checks
  and Electron resolution, then 5,946 tests passed and 134 skipped. Its one failure was
  the identity-recovery budget test still using a literal 40,000-byte saturated result.
  That fixture now fills the current shared budget, preserving the deferred-notice
  contract rather than pinning the old default. Its full 12-test file passed; the separate
  six-test shutdown suite, final typecheck and all app/CLI/daemon builds passed. The full
  verify command was not repeated after this test-only correction.
- Intercepted-patch output review fix: `runParsedPatch` now receives the terminal's
  requested budget, clamped to its existing ceiling, before formatting. The standalone
  patch default is unchanged. A real-MCP regression failed before the fix and passed
  after it, retaining every receipt from a 4,000-file patch at 100,000 tokens while
  preserving bounded head/tail output at 1,024 tokens. Three focused suites passed
  175 tests (9 skipped), and typecheck passed. A separate isolated server smoke returned
  all 4,000 receipts in 360,082 bytes within the requested 400,000-byte allowance.
  Full `npm run verify` passed privacy, notices, native-source, type and Electron checks,
  5,948 tests (134 skipped), and the separate six-test shutdown suite. Smoke state and
  source were removed. No installed app or signed-in provider was changed or tested.
- This is an MCP adaptation using QuickJS and `{code}`, not Codex V8/freeform Responses
  execution. Notify does not claim custom model-message injection. Cells/state are process
  memory, not restart-durable storage. No app packaging, installation, production extension
  reload or signed-in provider acceptance is claimed by this source-level change.

### Review corrections and project instruction initialization (2026-09-22)

- Common executor instructions now use supplied AGENTS content or check directory contents
  before reading. A missing root AGENTS.md in a confirmed task project is initialized by
  the executor from observed project facts through apply_patch, not by the app while
  preparing a message. Existing files, explicit read-only tasks and creation permissions
  remain authoritative. No project files were created in the real workspace by this change.
- The Skills popup checks the actionable add/import request and `/skills` destination
  while retaining per-draft text preservation, without pinning the whole English sentence.
- Managed workers are now reserved before their worktree assignment is persisted. A
  preparation failure retires the exact broker invitation and releases only its untouched
  reservation; assigned worktree custody is retained as failed. Failed batch entries and
  rejected transforms never dispatch raw tasks. Real Git/SQLite assembly checks passed
  11 tests, including partial failure, released capacity and preservation of a colliding
  user-owned directory. The broker transform-rejection regression passed separately.
- Focused session-prompt, renderer-skills and MCP suites passed: 180 passed, 9 skipped.
  An isolated real Node/store/project smoke prepared missing-file and existing-file
  openings successfully, retained the authored task and left existing instructions intact.
- Recorder frame deferral now uses the existing app send receipt and exact input/bootstrap
  payload. It does not parse the editor textContent for provenance: native BR nodes omit
  their newlines there. Payload custody survives native click/submit receipt refresh and
  retires through the existing send lifetime. Malformed neutral and legacy literal text
  is recorded normally; app-owned damaged projections wait for canonical source. The
  full content-script suite passed 711 tests, including desktop and worker receipts.
- A signed-in Temporary Chat accepted a literal malformed CONTEXT example. The production
  DOM reader returned its exact text and stable native message identity, while the strict
  frame parser rejected it as a frame. The temporary browser space was closed. This proves
  the native DOM boundary, not recorder publication through an installed extension.
  No app installation, packaging or production extension reload was performed.
- Final verification: privacy, notices/native-source inventory and typecheck passed. The
  broad suite passed 230 files / 5,889 tests with 134 skipped; its only failing file was
  agents.test.ts because the new rejection fixture left its transform installed. The
  fixture now clears that test-owned transform in finally; the complete affected suite
  passed 163 tests. Final typecheck and the separately gated shutdown suite (6 tests)
  passed. The broad aggregate was not rerun after this fixture-only isolation fix; these
  overlapping runs are not summed into a fabricated all-green full-suite count.

### Revival ownership boundary (2026-09-22)

The investigation distinguished extension receipt from document redemption and native
Send. Two deferred revival commands can expire without any document receiving their
payload; those expiries do not prove the worker conversation is unusable. Such an
expiry releases the waking slot, preserves the same worker and inbox, and does not
spend or reset the terminal failure budget. Document-owned failures retain their
existing budget. The three-minute deadline, safe native readiness gate and prohibition
on automatic replay remain unchanged. No timer or browser recovery loop was added.

Verification: `npm run typecheck` passed. After the user lifted the static-only
restriction for investigation/reproduction, five targeted broker/bridge regressions
passed: repeated unclaimed expiry (timer and sweep), an unclaimed expiry between
two document-owned failures, and the unchanged absolute claimed-revival deadline
(timer and sweep). Other tests were not run. No build or installation was performed.
The same authorization covered the live browser investigation below.

The separate unattributed-request investigation found six request IDs present at MCP
ingress but absent from both durable correlation stores; other workers had exact
owners. After live-browser authorization, bounded provider reads in an isolated
authenticated page recovered exact conversation metadata for five IDs. The unchanged
production Fiber helper extracted the latest missing ID on that real native page.
Opening the two known conversations in extension-bearing Chrome then exercised the
installed page-to-bridge path: the latest missing ID and the earlier conversation
main request were committed to SQLite through normal correlation observation. No
model message, regeneration or tool replay was issued, and no ledger was edited.

This proves the current extraction, handshake and durable publication path works
when the relevant conversation is observed. It does not establish why observation
was absent at the original incident. Three older IDs remain outside the recovered
observer window; the remaining prime request has no exact pair in the inspected
provider metadata. Native history scrolling did not establish further recovery.
No identity was guessed, warning suppressed or attribution source changed.

### Conversation continuity: controller relay

A work's controller is the conversation that supplies its instructions and receives
its reports. Binding requires an identified source: **Connect this chat** in the
Works panel, the work's first managed prime, or the identified `work` call that
started it. Merely observing a message does not create a binding.

The relay targets the same stored ChatGPT conversation. Mobile input may have no
corresponding desktop tab, so the companion reads the provider's conversation data
directly. It reconstructs the active branch by following parent links from
`current_node`; missing nodes, parents outside the mapping, and cycles cause the
observation to be rejected. Access tokens stay inside the provider module; the
host receives the account ID, not the token. The extension reads only conversations
named by the host, without listing conversations or scanning accounts.

The host receives authenticated `/controller/observe` snapshots and admits active-
branch messages in chronological order. The binding's `bound_at` is the watermark:
earlier messages are stale, off-branch messages are rejected, and provider message
IDs provide deduplication. Account and conversation identity are fixed by the
binding. Each admitted message's context is frozen at its first admission.

Reports contain recorded facts. Ledger-backed structural provenance, rather than
report text, distinguishes generated reports from user input, preventing the relay
and Goal from processing them as new user instructions. At the send boundary, the
report's source conversation and provider account are checked against the live
session to prevent delivery through a browser logged into a different account.

Delivery states do not imply success prematurely. `queued` means the outbox has
accepted the message but the conversation has not consumed it. `unknown` means a
handoff was attempted without a conclusive outcome. Unknown sends are not blindly
retried; a work that exhausts its attempt budget is blocked with
`INSTRUCTION_DELIVERY_UNKNOWN`.

### Successors for completed work

A new instruction does not reopen completed work. The ledger follows existing
successor links to the active end of the chain. If that work is complete, it admits
one successor with a new `work_id`, its own prime, integration branch, and worktree.
The predecessor's result becomes the baseline, including committed history and
uncommitted changes.

The predecessor's checkout, index, `HEAD`, and branch remain unchanged. Git fixture
tests verified inheritance of dirty, staged, and untracked files. The predecessor
receives a successor link and a `work_continued` event. Cyclic, missing, or otherwise
untraversable chains are rejected with `CONTINUATION_CONFLICT`.

### Conversation-independent coding tools

`read`, `find`, `exec_command`, and `apply_patch` do not require a conversation or
work binding. Authentication, configured permissions, and sandbox restrictions
still apply. In `src/main/work/runtime.ts`, `managedToolGate` immediately calls
`invoke()` for non-lifecycle tools, including when a managed conversation is bound.
Working directories come from explicit paths/`workdir` or an approved root, not
from a conversation-derived workspace.

`work_checkpoint` and `work_resume` accept an explicit `work_id` and optional
`agent_id`, allowing clients to operate without the corresponding page being open.
Work lifecycle and ledger checks remain enforced, including target membership,
generation, and terminal-state constraints. Existing managed-conversation target
selection remains available for these work-specific tools; explicit IDs remove the
need for that conversation connection.

### Removed prompt and output overhead

Removed forced role/control templates, legacy Goal markers and automatic
continuation text for managed/controller conversations, and automatic terminal
logs and reminders appended to unrelated tool responses. Background terminal
output is retrieved explicitly with `write_stdin`; tools still return their own
results and errors.

### Independent Node daemon

`src/daemon/{runtime,lifecycle,cli,entry}.ts` provides MCP without loading Electron.
It reuses the loopback MCP server, tool graph, work ledger, admission gate, and
local control socket. The listener retains per-surface secret paths and Host/Origin
checks. The control socket is private and authenticated, with instance identity.
Data-directory ownership is exclusive, and repeated `start` calls are idempotent.
There is no fallback to an Electron executable.

```sh
npm run build:node  # Builds out/cli and out/daemon, not the Electron application.
wgpt daemon start --data-dir /absolute/path/to/data
wgpt daemon status --data-dir /absolute/path/to/data --json
wgpt daemon stop --data-dir /absolute/path/to/data
wgpt daemon serve --data-dir /absolute/path/to/data  # Foreground; Ctrl-C to stop.
```

`--data-dir` is required. If the desktop application owns that directory, startup
fails with `DATA_DIR_CONFLICT` without modifying its `runtime.json` or process.
`status` queries a live authenticated peer rather than trusting a descriptor.
`stop` targets the matching instance, not an arbitrary PID from a stale file.

`wgpt work connection <work_id>` inspects an existing worker connection;
`wgpt work reconnect <work_id>` reopens its existing conversation. `--agent-id`
selects a worker, while `--conversation-id` is an expected-CID fence, not a rebind
request. These commands create no new work or identity and do not pause or resume
work. Readiness requires observed page state. Uncertain opens are retained across
retries to avoid opening duplicate pages; a zero timeout performs a status-only
check without opening the browser.

## Current limitations

- **Tunnels and credentials now work; the app's own automatic tunnel path is still its own.** A
  daemon publishes through the same `tunnel-client`/`cloudflared` adapters the desktop app uses
  (`wgpt daemon config tunnel …`), and it protects `secrets.bin` with `WGPT_SECRET_KEY` instead of
  the OS keychain. What it does *not* do is reuse the desktop app's saved tunnel settings: those
  live in the same `config.json`, so a daemon pointed at a fresh directory starts with no tunnel
  until one is configured, and a daemon sharing a directory with the app would inherit its choice.
- OS-keychain-backed credential reads and writes remain unavailable in headless Node. The
  environment key is the supported substitute; the daemon does not fall back to plaintext storage.
- Desktop browser, native, and clipboard tools are not registered in the daemon.
- The daemon has no browser outbox delivery adapter. A `work start` requiring an
  initial browser message reports failure and blocks the work instead of claiming
  successful delivery. Existing work listing, status, events, and control remain
  available.
- The daemon is not yet a complete browser-worker automation platform without the
  desktop application.
- The server cannot guarantee that ChatGPT's own tool-call UI is hidden.

## Remaining work and acceptance criteria

1. **Headless remote access and credentials — done for the supported path.** A daemon publishes
   through the same `tunnel-client`/`cloudflared` adapters the desktop app uses, and protects
   `secrets.bin` with an operator-supplied `WGPT_SECRET_KEY` (AES-256-GCM, key never on disk).
   Local MCP tool calls and tunnel process connection were exercised. Public MCP reachability
   is not established by that handshake. Without the key variable every secret write is refused by name
   instead of falling back to plaintext. The loopback exposure rules are unchanged. A generic
   OAuth authorization server was deliberately *not* built: ChatGPT's supported path is the
   tunnel, and the other adapters already carry their own authentication.
2. **Optional browser delivery adapter — implemented.** `--browser` installs the shared
   outbox/receipt adapter, continuity bindings and paired bridge. Plain Node bridge startup
   and seeded extension materialization passed. A signed-in ChatGPT composer accepted and
   exactly cleared the production insertion probe; no Send or provider receipt is claimed.
3. **Full desktop GUI as a persistent-backend client — implemented and exercised.**
   Round 4 replaces the earlier reduced work-control client. The existing full renderer
   connects to a windowless Electron backend, preserving native capabilities and the
   existing OS-encrypted credential store. It does not point the full GUI at the plain-Node
   daemon. GUI exit/relaunch and explicit backend stop/start were exercised without a
   second domain-state store in the client profile; see the exact evidence below.
4. **Daemon folder and permission configuration — done.** `wgpt daemon config` reads and changes
   approved roots, Read-only mode, tool permissions and the tunnel selection, applied by the
   running daemon through the same serialized settings transaction the desktop UI uses. Acceptance
   met: a relative, overlapping, non-existent or network path is refused with a concrete reason
   rather than resolved elsewhere, and the live endpoint honours the new permissions immediately.
5. **Real ChatGPT/mobile end-to-end verification.** Native composer insertion was checked
   in the signed-in browser, but the complete relay has not been tested with a real
   account and phone. Acceptance: a human message from the mobile conversation
   reaches its bound work and the report returns to the same conversation.
6. **Release packaging and installation verification.** Acceptance: the actual
   packaged daemon resolves its dependencies outside asar, including QuickJS, and
   `wgpt daemon` works from the installed distribution.

Automatic startup and service-manager registration are not requirements; they
remain optional rather than prerequisites for this implementation.

## Verification evidence

### Structured search paging and installed acceptance (2026-09-23)

- Unified ordinary and managed `find` around the same streamed collector and structured
  search page. `exec` and `exec_read` now return the native page, preserving cursors,
  retained-hit totals, scan-stop reasons, file-size coverage limits and clipped-line metadata.
  Managed artifacts remain compatible; missing legacy scan metrics are null, and malformed
  retained pages fail explicitly instead of silently dropping records.
- Ordinary snapshots retain exact caller ownership and canonical approved scopes, with lazy
  15-minute expiry, eight runs per owner, 128 overall and 64 MiB. Capacity refusal does not
  evict accepted cursors; complete cursorless searches consume no retention slot. Endpoint
  retirement fences in-flight publication and clears snapshots after admission drains.
- The actual bundled daemon reproduced and then resolved the 70-line explicit-file case:
  50 hits plus a cursor, followed by exactly 20 original hits after changing the source.
  The same HTTP smoke verified foreign-owner refusal, ten successive complete searches,
  explicit Unicode clipping and read-only shell refusal, without outer metadata-only
  structured content. It also passed using the installed Electron executable and packaged
  daemon bundle against disposable state; each isolated process exited zero.
- Verification passed privacy/notices/native-source checks and final typecheck. The first
  full command hit its 120-second harness deadline; a separate complete Vitest run finished
  with 230 files passing, 13 skipped and one old oversized-file error expectation failing.
  That assertion now checks the structured skipped-size coverage contract. The affected
  MCP/search/code-mode suites subsequently passed 217 tests (12 skipped), the final search
  edge suite passed 31 tests, and the separate shutdown suite passed six.
- Built and staged the arm64 application through the existing resource/native packaging
  pipeline. Packaged runtime checks passed for Electron, Sharp, PTY, tree-sitter and Desktop;
  bundle metadata, executable modes, thin architectures and ad-hoc sealing passed. Replaced
  the existing `release/mac-arm64/Web GPT Agent.app` only after graceful GUI/backend exit,
  then compared installed ASAR, unpacked daemon and extension-manifest hashes with staging.
- The replacement initially waited on macOS credential authorization. The user approved the
  native request; the same installation/data directory then reported a connected backend and
  a ready GUI. Live installed HTTP discovery exposed `exec_read` as read-only/non-destructive,
  and a real read-only call returned file text plus two distinct cursor pages. The exact Core
  plugin's native ChatGPT Refresh then succeeded: its settings displayed `exec_read` with the
  read classification. This verifies provider schema refresh, not a model-generated invocation
  or elimination of provider/model safety refusals. No model-side shell-fallback policy changed.
- Removed the replaced app backup, packaging staging, smoke scripts and secure-prompt capture;
  closed the agent-owned browser task space. The single final application remains in its
  original location. Managed work readback retained the same 17 rows and state totals
  (four paused, three cancelled, six blocked, four completed). No commit or publication ran.

### Search review corrections (2026-09-23)

- Route retained cursors by their issued ordinary/managed provenance rather than the
  caller's current managed binding. Late exact identity proof preserves an ordinary
  cursor; each reader still enforces its own owner and scope checks, without fallback
  after a refusal. The HTTP regression failed before this routing fix and passed after it.
- Restore one ten-second deadline across ordinary search roots and report time truncation
  when later roots were not searched. Reject an absent scope with `SEARCH_SCOPE_REQUIRED`;
  a valid scope with no matches remains a successful empty search.
- Focused search, code-mode MCP and tool-declaration suites passed 65 tests (three skipped).
  Deterministic deadline coverage checks that an expired budget cannot start another root.
- An isolated Node smoke ran the production search code with real ripgrep over two roots,
  paged all four retained hits after replacing the source files and adding exact caller
  proof, rejected a foreign caller and revoked roots, rejected no-root searches, and
  accepted a valid zero-hit search. Temporary scripts, bundle and fixture were removed.
- Updated the tool contract and ownership map. No package, installation or live data changed.
- The first full run exposed an incidental Date-call-count dependency in the new deadline
  test and hit the command's 120-second limit. Replaced that clock trigger with the actual
  stream-completion boundary. Final `npm run verify` passed privacy, notices/native-source
  checks, typecheck, 5,967 main-suite tests (134 skipped), and six isolated shutdown tests.

Installation acceptance after explicit authorization:
- Packaged the current arm64 tree through the normal build/native preparation pipeline;
  staged runtime and macOS bundle smokes passed. Gracefully stopped both old runtime roles,
  replaced `release/mac-arm64/Web GPT Agent.app`, verified its strict signature and payload,
  and restarted its desktop client and backend. The user approved macOS Keychain access.
- Installed app.asar SHA-256:
  `204d744b23704a14e5a3ab3aa30b6860fa2f6276113a7d61dab9ae4818bc3c58`.
- Original config and encrypted credential bytes stayed identical; installation identity,
  data directory and all 17 managed work rows/statuses were preserved. Core connection and
  paired extension presence returned. Actual installed Core `exec_read` HTTP calls read
  24 search hits as pages of two and 22, ended with a null cursor, and refused a foreign owner.
- Removed the replaced app backup, temporary package directory and protected-prompt capture.
  No release publication or synthetic provider conversation was performed.

### Read-only code mode and terminal diagnostics (2026-09-23)

- Added Core-only `exec_read`, sharing the existing runtime and cell lifecycle.
  Its host-owned allowlist is `read`, `find`, `view_image`, `work_resume` and
  `mcp_tools`; the cell retains that dispatch boundary across `yield_control`
  and `wait`. Ordinary `exec` stays writable. Desktop/Plugins are unchanged;
  external annotations do not grant execution through this read-only wrapper.
- Restored terminal advisory notes to the native `output` field consumed by code
  mode, preserving the existing object shape and exit status. The partial-batch
  HTTP regression failed before the repair and passed afterward.
- Actual bundled-daemon smoke exposed a second boundary: output without a trailing
  newline joined the batch exit marker, so strict section parsing skipped its
  diagnostics. Batch generation now separates exit markers from command output.
  The exact `printf SMOKE_OK` / `false` reproduction then returned the original
  stdout, raw exit code 1 and one partial-batch diagnostic.
- Built the production Node daemon and exercised authenticated HTTP against
  disposable state. Verified read/search/catalog output, the five-name catalog,
  truthful public annotations, valid patch and dynamically named shell refusals
  with no file side effects, ordinary `exec` patch success, and a yielded read
  cell refusing a shell name loaded from shared scratch state through `wait`.
  `work_resume` reached its own identity guard and correctly refused an unproven
  caller; this was not proof of a bound managed-work flow.
- Focused code-mode MCP checks passed 22 tests (three skipped). Terminal output,
  batch display and shell regression suites passed 14 tests. The full verification
  run passed privacy, notices/native-source checks and typecheck; 5,945 tests passed
  and seven failed on previous Core public-tool inventory/count expectations. The
  separate shutdown suite passed all six tests.
- Migrated those public contract expectations in the four affected suites and
  removed the incidental Core tool-count assertion. The serialized discovery budget
  now allows 14 KiB for the added schema (observed 12,767 bytes), rather than 12 KiB.
  Those suites then passed 211 tests (nine skipped), and final typecheck passed.
  No production source changed after the full run; the unchanged full suite was
  not rerun after this test-only migration.
- Both isolated daemon runs exited zero; temporary state and fixtures were removed.
  No package, installed app, live data or signed-in provider conversation changed.
  This proves the local execution boundary, not a change to ChatGPT's safety decisions.

### Code-mode output channel correction (2026-09-23)

- Removed outer `exec`/`wait` metadata-only `structuredContent`. Actual text, native
  media, errors and the running-cell notice now share the existing MCP `content`
  channel. Completed calls no longer advertise a retired cell handle. Nested terminal,
  Desktop and plugin result contracts remain unchanged.
- A structured-preferring consumer regression failed before the fix and passed after
  it; the focused runtime/MCP suites passed 63 tests (three skipped).
- Built the production Node daemon and launched it with disposable state, no browser
  bridge and no tunnel. Actual HTTP calls verified completed text, `yield_control` then
  `wait`, emitted text retained on error, and real Core `read` output. Shutdown exited
  zero and the temporary data directory was removed.
- The full verification run passed privacy, notices/native-source validation and
  typecheck, then 5,946 tests passed while two recorder lifecycle tests exposed old
  structured-cell-handle readers. Those consumers were migrated and their complete
  recorder suite then passed 36/36; final typecheck passed. The separate shutdown suite
  passed six tests. The unchanged full suite was not rerun after this test-only repair.
- No production installation or signed-in ChatGPT conversation was changed. Local
  wire evidence does not prove how ChatGPT ingests the corrected response.

### Commit acceptance and GUI regression (2026-09-22)

- The final production gate passed: `npm run verify` completed privacy, notices,
  native-source checks, typecheck, Electron resolution, 5,948 main-suite tests
  (134 skipped), and six separately run shutdown tests. `npm run build` then
  successfully built main/backend/client, preload, renderer, CLI and Node daemon.
  This supersedes the earlier partial-run failures and no-test notes below.
- Nine isolated Electron GUI fixtures passed: disconnect UI, input queue (15
  checks), history scroll, composer context, appearance, message reactions,
  sidebar/setup, project workspace and chat switching. Seven fixtures needed the
  current required AppState fields rather than the obsolete update projection.
  The chat-switch fixture incorrectly declared history anchored before canonical
  history existed; anchoring now arrives with its committed history sequence.
  Its unchanged no-blank/no-duplicate assertion passed across all 100 frames.
- Removed a Skills-prompt wording assertion instead of re-pinning prose, and an
  implementation-source-order packaging assertion. The focused packaging suite
  passed all 20 remaining checks. No production renderer change was needed for
  these fixture repairs; the full production gate above preceded this test-only
  maintenance.
- Drove the actual built Electron GUI through native accessibility using a fresh
  temporary data directory and real preload/backend IPC. Korean navigation,
  appearance persistence, Stop cancellation, confirmed Stop and GUI Start passed.
  Quitting the GUI left the same backend alive; reopening retained the language
  and settings. An external authenticated backend stop left the GUI open; after
  CLI restart, that same GUI connected to the replacement backend and successfully
  saved another appearance change, confirmed from the backend config. A native
  screenshot also confirmed the Setup layout.
- Background native text injection into the first hidden window delivered zero
  characters, so it is not counted as a typing pass. Composer, queue, Files/editor,
  history and responsive layouts were exercised by the isolated Electron fixtures.
  No signed-in provider delivery or installed-app acceptance is claimed.
- Closed all owned test GUI/backend processes and removed their temporary profiles,
  probes and screenshots. The installed application and personal browser state
  were not changed. No packaging, installation or push was performed.

### Code-mode text preview and retained output (2026-09-22)

- Raised decoded text preview from 40,000 bytes to 512 KiB. Crossing it no longer
  terminates the interpreter or changes success to tool rejection. UTF-8 clipping
  adds an omitted-byte notice; real script/image/resource failures remain errors.
- Full admitted, validated emissions travel through the current call context to
  the existing recorder, with user/inbox appendices once and no full-text wire copy.
  Recording Off, storage failure/quota and the 8 Mi-character overflow ceiling
  still limit persistence; the separate 12 MiB emission safety bound is unchanged.
- Updated regression source for continued calls after clipping, UTF-8 boundaries,
  full original retention, larger previews, later script failure and MCP overflow
  readback. `npm run typecheck` passed after fixing test imports/optional indexing.
  Per request, no tests, smoke, build, app/browser execution or installation ran.

### Minimal control prompts (2026-09-22)

- Reduced common, Core, Desktop, Plugins and shared code-mode prose; removed duplicate
  routing and tutorials already owned by tool schemas. Preserved capability gates, roots,
  user additions, Skills and the ordinary-versus-managed distinction.
- Fixed common text: 2,246 → 583 characters; shared code-mode text: 1,179 → 440.
  Combined reduction: 70.1%. Removed tutorial-wording tests while retaining connector
  routing and capability assertions.
- Static source review and `npm run typecheck` passed. As requested, no tests, app,
  browser, build or smoke flows ran; no packaging or installation was performed.

Subsequent neutralization removes branding from worker refusals, handoff/resume, finish,
skill catalog and observation notices. The Skills add button now targets `/skills`
without a product name, preserving the existing draft. Automatic Continue no longer
adds random phrases or unrelated asides; offline Goal adds one continuation sentence
instead of two randomly selected directives from 200 near-duplicates.

New context frames use `CONTEXT`, and Goal instructions use `GOAL:COMPLETE` /
`GOAL:CONTINUE`. Legacy names remain read-compatible for history and frozen sends;
mixed opening/closing names fail. No stored message bytes, user additions, connector
identities, permissions or receipt ownership are rewritten.
The native Send listener recognizes both previously emitted Goal instruction variants
without appending a second instruction; a quoted marker token alone is not that proof.

Checks for this follow-up: the renderer Skills suite passed 9 tests; a direct Node/JSDOM
smoke exercised the actual main and unbundled extension frame readers against neutral,
legacy and mismatched frames, plus Goal stop/continue/invalid results. Typecheck passed.
The marker/extension/outbox group passed 367 tests; the frozen Goal-draft regression
fails with the old dedup condition and passes with both legacy instructions recognized.
After removing obsolete prose assertions, content-script/session-input/MCP-input-image/
session-prompt suites passed 901 tests. Their byte, content, permission, order, image and
single-delivery checks remain. Final typecheck passed after these edits.
Adjacent session/input-delivery/bridge/resume/skills-integration/renderer-timeline
suites also passed 1,158 tests. These counts describe separate runs, not a full-suite total.

`npm run verify` reached the main Vitest run: 5,900 passed, 134 skipped and 10 failed.
The wording failures above were corrected and rerun. The earlier code-mode truncation
regression now explicitly crosses an async boundary before throwing, exercising script
failure rather than module initialization failure, and passes. One separate managed-work
assembly failure remains: worker-1 worktree assignment persistence returns WORKTREE_FAILED
before the bootstrap gains its work coordinates. Its production owner was not changed
for this prompt task; no passing full-suite claim is made. The later standalone shutdown
suite was not reached by that failed verify command.
No build, packaging, installation or live conversation mutation was performed.

### Worker connection distinction (2026-09-22)

- No-argument `work_resume` distinguishes a proven ordinary conversation from a managed
  agent using the restored work ledger. Unbound reads no checkpoint; bound identifies the
  exact work/agent. Explicit work selection does not claim a conversation connection.
- Untargeted checkpoints for a known unbound conversation return `WORK_NOT_BOUND`.
  Unknown caller/runtime state and existing managed lifecycle refusals remain unchanged.
- Broker binding checks the exact run's managed prime, work and parent; managed finish
  checks use the caller's conversation rather than a shared `worker-N` label. Managed
  bootstrap coordinates now name the assigned work. Common/tool/code-mode guidance
  separates ordinary coding from managed checkpoint/receipt operations.
- Added regression source for bound/unbound/paused/explicit targets and an ordinary
  broker worker colliding with a managed worker label. Removed prose-wording assertions.
- Static verification only, as requested: `npm run typecheck` passed for source and
  test TypeScript. No tests, smoke scripts, app/browser launches or MCP calls were run
  for this change. No package, installation or live-state mutation was performed.

### Round 8: schema-preserving tool performance

Addressed all five requested areas without changing public tool names, descriptions,
input/output schemas, permission decisions, limits or delivery semantics:

- One lazy, single-use Worker reserve preloads QuickJS. Each execution still creates
  a fresh interpreter and disposes its Worker. Reserve creation has no request async
  context; checkout callbacks bind to the current caller. A deterministic A/B probe
  caught and fixed stale AsyncLocalStorage inheritance during implementation. Idle
  errors retire only their own slot; Electron and Node shutdown retire the reserve
  after admission drains. No background retry or model-state reuse was added.
- Existing eight-way `Promise.all` dispatch already overlaps independent children.
  Removed an avoidable dispatch microtask; did not add another scheduler, parallelize
  conflicting mutations, or claim fewer provider round trips than existing batching.
- Explicit output retains decoded values once; normal text avoids a Buffer copy.
  Search pages serialize each selected row once instead of the growing page on every
  iteration. Image decoding, UTF-8 budgets and unsettled child custody remain unchanged.
- Exact-owner recording removes two redundant session reads, keeping one coherent
  request-turn/model/origin snapshot. The execution-time rebind fence and awaited
  durable append remain. Unknown, superseded and unattributed owners retain their
  original target resolution, including bucket deletion/recreation.
- A bounded search index caches only names/descriptions/order. Every request obtains
  current catalog membership and schemas, including in-place schema edits.

Local measurements on macOS arm64, Node 24.16.0 (not provider/tunnel latency):

| Probe | Before | After |
|---|---:|---:|
| Direct runtime, one child, back-to-back median | 24.12 ms | 6.59 ms |
| Eight parallel children, each with a 20 ms fixture delay | 45.32 ms | 24.25 ms |
| Eight sequential children with the same delay | 193.21 ms | 173.23 ms |
| 8 MiB child result, filtered before emission | 90.11 ms | 49.85 ms |
| Local SDK discovery, 20 full schemas from 256 tools | 0.967 ms | 0.331 ms |
| 100 sequential, real durable exact-owner recordings | 130.11 ms | 122.18 ms |

The direct-runtime fixture ran 5–7 repetitions per case; recording used five rounds
of 100 calls in isolated storage. Recording distributions overlap, so its observed
6.1% median reduction is not an end-to-end guarantee. Small Core discovery remained
about 0.2 ms. Back-to-back no-op calls alternate between a ready reserve and startup:
the final median was 19.40 ms, not 3 ms. A separate final idle-ready probe measured
3.24 ms versus its cold 39.10 ms and approximately 29 MB additional process RSS.
Prewarming moves initialization work earlier; it does not eliminate cold startup,
CPU cost or retained allocator pages after termination.

Actual validation:

- Compared 24 complete public/discoverable Core/Desktop response snapshots, including
  a large synthetic catalog page, byte-for-byte against the pre-change snapshot.
  SHA-256: `4c18776586d9b07ea6b901c585793d324e029a71a4a4a7fb384d09728f45d16f`.
- Final full `npm run verify` reached 5,910 passing tests and 134 skipped, with one
  obsolete timing-based test failing: it expected an ordinary absolute read to wait
  for browser identity, contrary to the current kernel contract. Cold Worker startup
  had accidentally supplied its 20 ms delay. Removed that test, not the production
  independence policy. The complete agents suite then passed 162/162; final typecheck
  and all six isolated MCP shutdown tests passed. The entire suite was not rerun
  after this test-only deletion. An earlier full run also included a now-removed
  throwaway baseline writer and failed its intentional existing-file guard.
- Runtime isolation/limits, idle failure, A/B caller ownership, queued recorder rebind,
  image recording, live catalog changes and multibyte page budgets have focused coverage.
  Production Electron, CLI and plain-Node bundles built successfully.
- A real localhost HTTP MCP server with isolated approved files executed parallel
  reads, recorded exactly two calls for caller A and one for caller B, kept interpreter
  globals private, returned exact 36,000-byte Unicode text, and refused access after
  live permission revocation. This exercised real filesystem/recording, not mock echoes.

No package, installation, live-data mutation, commit, push or release was performed
for these optimizations. Existing tunnel/credential files and the installed app were
not touched. Benchmark/smoke source files and generated build intermediates were removed.

### Round 7: GUI reply framing regression and local replacement

The GUI/backend split added 48 KiB raw reply chunks to a transport with a 64 KiB
serialized reply ceiling. Base64 alone filled that ceiling; the JSON envelope
then triggered connection-level `REPLY_TOO_LARGE`. Inline reply/event decisions
also omitted outer JSON escaping. A read-only `sessions:outbox` request against
the installed runtime reproduced the failure at its first `gui.take`. This was
a local GUI transport defect, not a tunnel outage or evidence of failed Send.

Reply and event chunks now use 32 KiB raw bytes, independent of later request-ID
growth. Inline admission measures the full serialized frame. Real-socket
regressions reproduced the reply failures before repair and now preserve complete
Unicode/binary responses, growing request IDs and escaped event payloads.
`npm run verify` passed after the initial reply fix; final adjacent framing
changes passed the desktop/work-control suites (66 tests) and typecheck.

On explicit approval, built and checked an isolated macOS arm64 package, then
cooperatively stopped the GUI and authenticated backend before replacement.
Packaged-runtime and macOS bundle checks passed; 137 built files matched the
archive. The installed runtime read the existing outbox completely in nine
chunks, with the largest observed frame 43,722 bytes under the 65,536-byte limit.
The reported input retained one sent entry; no message was resent. Configuration
and encrypted credentials were byte-identical across replacement. Core/Desktop
tunnels and the paired extension reconnected.

Native permission limit: unlike the pre-replacement runtime, this ad-hoc rebuilt
app reports macOS Screen Recording and Accessibility missing. Those OS grants
are separate from unchanged app settings; native Desktop permission continuity
is not claimed. No commit, push or release publication was performed.

### Round 6: requested local macOS replacement

On explicit user request, built the current working tree with `dist:dir:mac:arm64`
and replaced the existing `release/mac-arm64/Web GPT Agent.app`. Retained a private
rollback archive and config/credential backup outside the repository. Packaged-runtime
and macOS bundle checks passed, including native modules and the ad-hoc seal. All 158
checked output/extension files matched the packaged bytes.

Launched the exact replacement bundle and observed its production GUI. Its separate
backend used the original user-data directory. Authenticated state reported Core and
Desktop live, Plugins off, secure storage available and the saved API key present.
Config and encrypted secrets were byte-identical to their pre-replacement backups.
The stable extension copy matched all 19 ordinary source files plus its separately
validated generated installation seed. This is disk evidence, not a Chrome reload.

Live limits: the extension remained unpaired/absent during the bounded observation.
The UI reported missing macOS Screen Recording and Accessibility permission. No
browser pairing, OS permission grant or successful provider tool invocation is claimed.
No commit, push or release publication was performed.

### Round 5: daemon-split review repairs

Reviewed `3dcfd8d` and the `ab827ae` documentation follow-up while repairing the seven
reported GUI split defects. Long GUI calls keep handler-owned deadlines; subscriptions
recover after backend restart; legacy drafts import through an atomic DB/marker publish;
renderer generations own PTYs/watches; plugin pushes reach the GUI; notification targets
show the window once; background startup stays windowless. The native macOS probe exposed
Electron argv reordering, so second-instance routing uses structured additionalData.

Additional accepted findings and repairs:

- Node/Electron shared data-directory ownership, including serialized stale-lock recovery.
- Exact-instance control requests across descriptor replacement.
- Managed worktree canonical-path, repository and branch revalidation before mutation.
- Live/unknown-process runtime descriptor preservation (including EPERM).
- Portable Node and Windows command launchers.
- Work-store rollback and publication cleanup after COMMIT failure.
- Account-anchor write failure refuses provider snapshot admission.
- Provider auth/conversation response streams bounded before JSON parsing.

Descriptor liveness and COMMIT recovery include inherited defects; not every finding was
introduced by the reviewed split commit. One proposed project-cwd restoration was withdrawn:
the commit deliberately made ordinary tools independent of conversation-derived cwd. That
policy remains intact, with an exact-project-call regression and the stale map text corrected.

Actual verification, using source builds and isolated data:

- Full `npm run verify` passed privacy, notices, typecheck, 5,904 tests across 231 passing
  files (134 tests/13 files skipped), plus all six isolated MCP shutdown tests. An earlier
  run during launcher changes failed on the missing launcher; the final full run passed.
- After the final old-connection presence fence, typecheck and 122 affected tests passed.
  After withdrawing the cwd change, typecheck and 183 MCP/path/independence tests passed
  (nine skipped). Final Electron, CLI and plain-Node builds passed.
- Actual GUI/backend restart recovered pushes without Start; renderer reload terminated
  its PTY and old file watch. A secondary notification-style launch delivered the exact
  session once and showed the window; another reload did not replay it.
- A real legacy localStorage fixture survived failed backend startup, then imported and
  survived another GUI launch. Failure created no replacement Local Storage or marker.
- Real Node-first, Electron-first and simultaneous cold starts admitted exactly one
  data-directory owner and preserved the winner's descriptor and live endpoint.
- A late old subscription/presence could not steal the newer GUI lease; closing it left
  the current real PTY alive. Killing a real owned stdio plugin published its error state
  through the GUI event socket. Background launch created no GUI profile.
- The production provider reader read signed-in ChatGPT auth successfully. The isolated
  browser context returned an empty conversation list, so live conversation-document
  reading was not exercised; bounded streamed-response fixtures cover that parser.

Limits: Windows `.cmd` was not executed on Windows; the portable Node launcher was run
on macOS. OS notification-center clicking and the installed app were not tested. No
provider messages were sent, no live user settings/credentials were changed, and no
package, installation, commit or publication was performed. Throwaway fixtures/scripts
were removed after verification.

### Round 4: full GUI separated from persistent Electron backend

The user chose to retain the existing desktop features rather than replace them with
the reduced work-control client. Ordinary launch now starts the full GUI wrapper;
`--daemon-host` selects a separate, windowless Electron backend. The backend retains
the original data directory, OS-encrypted credentials, native Desktop, plugins,
browser/outbox and work ownership. The plain-Node daemon remains a distinct runtime.

The GUI owns only its Chromium profile and native window presentation. Fixed preload
operations cross the descriptor-authenticated control socket, including bounded
binary payloads and event chunks. Closing the last GUI lease retires human PTYs and
file watches, not MCP processes. Setup exposes status, PID, data directory and explicit
Start/Stop. Stop waits for the exact backend process to exit, not merely for its socket
to disappear: a real stop/start probe reproduced the old early-success race while
the recorder was still draining. The corrected flow preserves that drain.

Actual verification against source builds and isolated data, not the installed app:

- Windowless backend: authenticated status, duplicate-launch exclusion, explicit stop,
  and no BrowserWindow target in the live DevTools target list.
- Full production renderer/preload: distinct GUI/backend PIDs; no config, secrets,
  sessions, state or work database created under the GUI profile.
- Real file watch and preview, plugin state, human PTY input/output events, and exact
  staging of a pathless 1 MiB binary attachment through the private socket.
- A real MCP code-mode shell command survived actual GUI process exit and completed
  while no GUI was running. The human PTY was terminated instead, as intended.
- Relaunch attached to the same backend PID and retained GUI localStorage, settings
  and a real OS-encrypted test key. Explicit Stop followed immediately by Start
  produced a new backend PID and preserved those settings and credentials.
- The full Setup UI was captured and inspected with the connected daemon controls;
  document width equalled the viewport, with no horizontal overflow.
- Final typecheck and all three build passes passed. The required verify command
  passed privacy/notices/typecheck and 5,890 tests across 229 files (134 tests skipped).
  Its only failure was the retired direct-IPC assertion in preload-images; the affected
  regression was updated and passed separately. Final affected IPC/lifecycle validation
  passed 198 tests across seven files, and final typecheck passed. Isolated MCP shutdown
  passed 6 tests.
  Parent packaging/lifecycle/menu/daemon-controls checks passed 37 tests; adjacent
  secrets/daemon-secret/work-control/CLI/IPC/work-IPC/PTY checks passed 209. These
  overlapping counts are not a combined suite total.

No package, install, commit or release was performed for this cutover. Existing live
tunnel settings and API-key bytes were not edited. The persisted-key proof above uses
an isolated real credential store; it is not a claim of installed-runtime or signed-in
ChatGPT acceptance. Source-text tests tied to the retired monolithic entry point were
removed instead of re-pinning implementation strings to the new filenames.

### Round 3: continued availability, ownership and client execution

- SQLite now owns exact request proof; JSON is migration input only. A real plain-Node
  smoke admitted 50,002 proofs, looked up an evicted request, refused a foreign owner,
  reopened the database and retained both the original owner and a question conflict.
- The separate Electron client used an actual detached daemon: status, folder addition
  with canonical disk readback, Read-only on/off, work admission, unavailable presentation
  and reconnect after daemon restart passed. Its profile contained no work.sqlite.
- Worker presentation reads existing operation timestamps, checkpoints and recovery
  deadlines. It explicitly distinguishes no recorded local operation and unknown outcome.
- macOS native observation removed one duplicate WindowServer enumeration per windows/active
  request. Two separately compiled native binaries returned identical window rows and active
  identity. Across 45 warm samples each: windows median 8.72 → 6.51 ms (p95 11.59 → 8.97);
  active median 7.90 → 1.75 ms (p95 11.00 → 4.24). No cache or physical-input change.
- Plain-Node optional browser adapter startup and seeded extension materialization passed.
  On signed-in ChatGPT, the production DOM adapter inserted then exactly cleared a
  multiline literal-markdown probe. This did not send a message or prove a browser receipt.
- No package, installation, commit, release or live-ledger repair was performed.
- Final detached Node 24 `--browser` smoke passed: enabled-mode status, seeded extension,
  HTTP MCP initialize, and explicit transport reconnect retaining the same daemon instance.
- The transport worker additionally reported public quick-tunnel HTTPS initialize/read
  responses of 200, unchanged URL across unrelated settings, and a new URL after reconnect.
  It reported real bridge pairing with a simulated extension and a queued work-opening row;
  coding-only mode instead recorded PRIME_LAUNCH_FAILED. These are worker-observed results,
  not a signed-in ChatGPT Send receipt or an independent mobile-device acceptance test.
- `npm run build` and final typecheck passed. Required `npm run verify` completed privacy,
  notices and the broad suite: 5,895 passed, 134 skipped, six failures. Those failures were
  two shared-directory attribution fixtures, one missing client build fixture, and three
  obsolete secret-error wording assertions. The corrected affected suites passed (ownership
  13, packaging 23); final daemon/runtime/CLI/secret/tunnel plus isolated shutdown passed
  65 tests. Correlation plus shutdown separately passed 21; five renderer locale suites
  passed 24. Counts overlap and must not be summed. The broad suite was not rerun merely
  to obtain a green aggregate after the affected checks passed.

### Round 2: daemon configuration, credentials and tunnels

- Focused suites passed: `daemon-secret` (6), `daemon-runtime` (7), `daemon-cli` (25),
  `daemon-real-socket`, `secrets`, plus the adjacent `connection`/`tunnel`/`config`/`sandbox`/`mcp`
  families — 399 passed, 30 skipped, run with `--pool=threads --maxWorkers=1`.
- A detached daemon built from this source was driven end to end through the real CLI and socket:
  `config add-root`/`remove-root`/`read-only`/`capability`/`tunnel`, `secret status`/`set`/`clear`,
  restart persistence, and the live endpoint honouring a permission change without a restart.
- The tunnel was exercised for real: `cloudflared` reached `connected` and published a public URL.
  Public HTTP tool calls were not verified: the generated hostname failed DNS resolution on
  this host. Local authenticated tool calls passed; those do not prove remote reachability.
  `openai` with a bogus credential reported `unavailable` with the provider's own refusal, and
  switching back to `manual` stopped the child (zero daemon children afterwards).
- `secrets.bin` on disk begins with the cipher's `WGK1` marker and does not contain the stored
  value; a store sealed under a replaced key exposes no decrypted credentials and refuses
  mutations instead of overwriting the unreadable file.
- Not verified here: an `openai` tunnel with a real control-plane key, public MCP reachability,
  or any live ChatGPT connector. No external-host DNS or tool-call success was observed.

### Round 1: the daemon and its control surface

- `npm run typecheck` passed on the final implementation. Vitest passed **35 tests**
  across `work-runtime-assembly`, `work-kernel-admission`, `mcp-work-control`, and
  `daemon-runtime`, using `--pool=threads --maxWorkers=1`. An earlier default-fork
  run timed out before results. This is not a claim that the full suite passed.
- A separate, earlier daemon CLI-related run passed 58 tests. These results overlap
  with other checks and must not be summed into a combined total.
- An actual detached Node process with temporary data exercised start, status,
  idempotent start, authenticated HTTP read/exec/find/patch, out-of-root denial,
  and stop. A package-layout smoke test also verified dependency resolution outside
  asar, including QuickJS. Temporary daemon instances were removed.
- `out/cli/index.js` and `out/daemon/index.js` were regenerated earlier and are
  gitignored. The final admission-gate change happened afterward: **rebuild from
  source before using those local binaries**.
- Final implementation verification did not modify the installed app, browser,
  extension, or release. Earlier experimental UI execution did occur and was
  stopped at the user's request; this is not a claim that no UI was ever launched.
- Pushing, installing, and deploying are outside this documentation-and-commit
  request.

### 2026-09-25: Core output preview removal

Core's default 1 MiB text preview still broke structured JSON above that size even though
the interpreter admitted and recorded it. The new real-HTTP regression failed before the
change with an output-truncation notice instead of parseable 4.5 MB UTF-8 JSON. Core
exec, exec_read and wait now return all admitted emissions by default; Desktop/Plugins
and explicit small budgets retain preview clipping. The separate 12 MiB encoded-emission
and nested-tool/terminal limits remain.

The two code-mode suites passed 73 tests, the compact discovery schema check passed,
typecheck passed, and production bundles built. Full `npm run verify` ran
resource/privacy/notices/type checks and 5,882 tests passed, but its prior version of
the wait schema description exceeded the Desktop discovery threshold (3,149 vs 3,072
bytes). After shortening that description, the exact discovery check passed; the full
suite was not repeated. These checks exercise an isolated Core MCP HTTP endpoint, not
a signed-in provider or installed app.

### 2026-09-25: Core emission byte ceiling removal

The prior change removed only the default preview. Core still stopped a cell after
12 MiB of encoded emissions; a real MCP HTTP regression with two 7 MiB text blocks
failed before this change. Core now skips both the cumulative and per-emission byte
guards; Desktop/Plugins retain them. The host and worker still enforce 32 emissions,
four images, guest resource bounds and nested-tool result limits. After a yielded
exec/wait hands out its output, the cell drops those references while preserving its
total emission count and later output. Real HTTP calls delivered two 7 MiB blocks in
one response, one 13 MiB text block, and a later 14 MiB wait result without replay.
The MCP SDK still builds a complete JSON-RPC response in memory, so peak allocation
scales with a single result; this is not constant-memory streaming. Recorded history
also retains its independent 8 Mi-character overflow ceiling and marks larger text
as lost from history rather than implying the MCP response was clipped.

The two code-mode suites passed 78 tests, including the original failing aggregate
case, a single 13 MiB emission, yielded wait delivery, the cross-wait item guard,
and unchanged byte guards on the other surfaces. Typecheck and the production
main/preload/renderer/CLI/daemon builds passed. This is source and isolated HTTP
evidence, not an installed-app or signed-in-provider test.
Full `npm run verify` then passed privacy, notices, native-source and type checks,
5,888 tests (88 skipped) across the main run, and all six shutdown tests. No package,
installation or signed-in browser flow was exercised.
