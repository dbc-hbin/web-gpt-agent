# ChatGPT composer update and 2.2.0

Date: 2026-09-30.

ChatGPT's 2026-09-30 composer update broke two companion behaviors on the alternate shell.

- **Empty composer counted as an attachment draft.** The shell keeps `[data-composer-attachments]`
  mounted, `hidden` and childless when empty. `hasComposerAttachments()` treated any mounted tray
  as a draft, so every page looked draft-protected. It now requires a shown tray with a tile.
- **Settings control missing from an empty composer.** The shell's trailing controls carry no test
  id and an empty composer has no Send button, so `composerActions()` found no anchor. `TRAILING`
  now also names the responsive footer's trailing voice/Send sub-group; the microphone-glyph scan
  applies the `button` descendant to every alternative.

Regressions in `test/shell-compat.test.ts` fail before each fix and pass after it.

Live evidence (signed-in Chrome, reused CDP session): the installed 2.1.14 extension showed no
settings control on an empty composer. After rebuilding (`npm run dist:dir:mac:arm64`), replacing
`release/mac-arm64/Web GPT Agent.app` after authenticated `host.stop`, refreshing the userData
extension mirror and reloading the extension, the control appeared both empty and with a draft.
A file attach/remove toggled the tray as expected. A temporary-chat send was recorded by the app
with the user message, the final answer and a completed turn.

Observed but unchanged: the shell now names turns `fallback-turn-N` rather than a UUID; no broken
behavior was attributed to it. Recording of a local MCP tool call was not exercised.

App and extension are now 2.2.0 (bridge protocol unchanged at 16). `npm run verify` passed.

## Release pipeline repair

The first two `publish.yml` dispatches for v2.2.0 failed. The first failure was the tunnel-client
pin (v0.0.14 → v0.0.15; all six checksums cross-checked against upstream `SHA256SUMS.txt`, and
both live tunnels reconnected with the new binary). The second failure was every package job.
Those failures were pre-existing and present on every CI run since the fork's first commit;
none was introduced here.

- Linux: `approveWorktreeRoot` read `/tmp/...` as the virtual root of an approved folder named
  `tmp` and blocked every prime launch; `approvedRootContaining` checks native paths canonically.
  The remaining Linux failures were tests assuming a macOS host (embedded CUA, native clipboard
  capability, default data directory).
- Windows: open SQLite handles (the request-correlation ledger and unclosed work stores) made
  temp-directory removal return EBUSY until hooks timed out; teardowns now close them. Product
  fixes: `WorkService.pump()` holds a work whose prime is unbound once per pass instead of
  leasing and releasing its whole backlog; `core.fileMode=false` manifests keep HEAD's recorded
  mode; `defaultUserDataDir` joins with the platform's own path grammar. CRLF, UNC and code-mode
  output expectations were made platform-correct. The control-pipe ACL window now drains one
  event-loop turn before admitting connections ([INFERENCE]: derived from the Windows log, not
  reproduced locally; the next Windows run confirms it).
- macOS x64: `safePatchOutput` scanned the whole output once per patched path; it now makes one
  pass. The budget test uses a smaller fixture that still exceeds the default budget.
- macOS GUI smoke: the split GUI client no longer logged `window loaded`, and its detached backend
  discarded its startup trace. Both are restored under `CLF_DEBUG`; the smoke launches an isolated
  `--data-dir` and stops the backend it started. Local `smoke-macos-gui.mjs arm64` passed.
