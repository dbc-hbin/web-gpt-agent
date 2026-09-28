# Search input-error classification

## Change

Invalid search cursors and malformed regular expressions were recorded as
`tool_internal_error`. Cursor diagnostics also passed through generic filesystem errno
formatting, losing their recovery guidance.

- `src/main/search.ts`: `SearchPatternError` identifies proven regex/glob parse diagnostics.
  Other ripgrep failures retain `SearchEngineFailureError`; bounded JavaScript regex
  validation uses the same pattern-error type.
- `src/main/mcp/kernel.ts`: pattern errors and typed invalid/expired cursor errors record
  `tool_rejected`. Trusted search-page diagnostics retain their code and message before
  filesystem-error formatting. Corrupt retained pages and engine failures remain internal
  errors. Arbitrary error text cannot grant rejection classification.
- Search tests preserve Unicode framing and native-path privacy while distinguishing input
  errors from actual engine failures. Recorder-backed HTTP regressions exercise both Core
  code-mode wrappers and the neighboring internal-failure cases.
- The search contract in `AGENTS.md` and `docs/tool-surface.md` now describes these outcomes.

## Verification

- Before the fix, both new input-error HTTP regressions failed: recorded
  `tool_internal_error` instead of `tool_rejected`. The two internal-failure controls passed.
- After the fix, all four focused HTTP/recorder cases passed.
- Search and engine-framing suites: 41 tests passed.
- A throwaway source-bundled Node process started the production MCP HTTP server against
  an isolated canonical temporary root. Invalid cursor and regex calls returned actionable
  diagnostics and recorded `tool_rejected`; a real ripgrep search returned the expected
  hit and recorded `ok`. Caught errors left their outer code-mode calls successful.
  The initial smoke fixture used a noncanonical macOS temporary path and was correctly
  refused; resolving that fixture root with `realpath` made the three checks pass.
- Temporary smoke source, bundle and runtime data were removed.
- `npm run verify` passed: privacy, dependency notices, native-source inventory, typecheck,
  Electron resolution, 5,971 tests (134 skipped), and all six isolated shutdown tests.
- The final regression revision compares delivered errors with recorded errors rather than
  pinning explanatory prose; its four focused tests and a subsequent typecheck passed.
  The new worklog also passed the public-history privacy check.

This is a source-level correction, not a packaged or installed-app update. It does not alter
provider-side safety checks, attempt blocked-call retries, or modify live session data.
No ChatGPT model quota was consumed for this correction.

## Authorized commit and macOS replacement

- On the user's subsequent commit/install request, committed the verified Core code-mode,
  structured-search and error-classification changes as `dbd5149`. Preserved the separate
  `src/main/work/runtime.ts` working-tree change without committing it; the locally installed
  package includes that existing edit because it was built from the current verified tree.
- Built the main/backend/client, preload, renderer, CLI and daemon bundles, then staged an
  unpublished macOS arm64 directory package separately from the running application.
  Packaged native-runtime smoke passed for Electron, Sharp/libvips, PTY, tree-sitter and
  Desktop. Bundle inspection passed all 24 thin Mach-O payloads and the ad-hoc resource seal.
- With no current activity grants or running managed work, stopped the exact old backend
  through authenticated host control and quit its GUI. Replaced the existing app path,
  comparing 1,018 manifest entries including file hashes, modes and symlink targets.
  Installed `app.asar` SHA-256:
  `fd57ca8fd152da08c985c4af1a6a4ad3219bffa903950bbdc218c6d03784031f`.
- Startup initially waited in macOS `SecItemCopyMatching`; the user approved the native
  keychain request. The new backend then connected, the paired extension returned, and
  the production GUI displayed its existing history and connected state. Existing managed
  work statuses were unchanged. No credentials or permission policy were rewritten.
- Actual loopback HTTP calls to the installed Core `exec_read` returned the expected cursor
  and regex diagnostics. Authenticated history readback confirmed both nested `find` calls
  recorded `tool_rejected`. These local probes have no native conversation proof and remain
  Unattributed history; they did not invoke a ChatGPT model or verify provider-side caching.
- Removed the temporary rollback bundle, staging directory, probes and private diagnostics
  after successful installed-runtime verification. No remote push or release was performed.
