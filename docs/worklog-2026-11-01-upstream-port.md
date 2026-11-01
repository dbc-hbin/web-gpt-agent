# Upstream Chat On Steroids port, 2026-10-17 to 2026-10-31

Date: 2026-11-01. Source port only; no package, install, push or release.

The fork shares no Git ancestry with upstream `totec448-spec/chat-on-steroids`, so every change
was reimplemented against the fork's own owners and contracts, not cherry-picked. The comparison
base was upstream `ecba2318` (2026-10-17, the previous sync point) through `2fdc777d`
(2026-10-31). Each port commit names its upstream PR and carries the upstream author's
`Co-authored-by` trailer.

## Ported

Performance:
- #1829 event reads wait for queued appends without forcing a `meta.json` write.
- #1666 extension journal writes that arrive mid-write share one following write.
- #1886 the idle renderer stops re-theming terminals and laying out hidden feeds on every push.
- #1887 PNG tool screenshots are recorded as lossless WebP when that saves space.
- #1702 the Compact & Resume receipt wait checks every 2 s after its first 10 s.

Attribution and diagnostics:
- #1865 the newest response stream and pending request id are kept, not dropped.
- #1873 request ids that differ only in their UUID version digit join one owner.
- #1908, #1913 request-id traces by field path; once-per-chat tracing notice.
- #1885 startup timing in the log and as an informational self-test row.
- #1690 log writes never lose or repeat a line when a write or rotation fails.

Recovery:
- #1927 stale error reports for an ended turn are ignored.
- #1931 a progress note drawn after its turn ended is not new work.
- History 429 hold (upstream d1170dfb, db04ea9e, 2eeb0474) and #1936 longer repeated holds,
  pickup reloads counted when run. The DOM "Too many requests" dialog contract is unchanged.
- #1644 late-starting workers are kept instead of lost.
- #1939 ChatGPT announcement dialogs covering a page are closed before use.
- #1911 a tab stuck on Chrome's offline error page is reloaded when online.
- #1907 an unreadable model-picker entry no longer refuses the whole picker.
- #1784 a Send the page withdrew before clicking is sent once more.
- #1600 app messages are never sent into a signed-out ChatGPT.
- #1960 a withheld input spends no pickup; an untaken automatic Continue becomes an ordinary
  message once while its question is still current.

Features:
- #1797 secrets shield (on by default; Settings and per-project off switches; neutral markers).
- Fresh turns for long work (#1499 through #1954 with the durable rotation-fence follow-ups),
  including the stop-and-continue fallback. Only `purpose: 'rotation'` rows send while
  generating; Send directly and Inject now are unchanged.
- #490 read-only Git Review in the existing work slot, #1609 conflicts, #1774 three-way view,
  #1443 per-turn code checkpoints with compare and restore.
- #1627, #1653, #1654 edit an earlier question and continue from it.
- #1836 changed files under each answer that edited files.
- #1879 optional Goal step reviewer (default Off).

Fork-originated improvements:
- Every withheld automatic browser recovery logs one rate-limited line naming its condition.
- Compaction pickups in the writing/opening phase keep a slow 15-minute cadence with a visible
  row; pickup expiry after a reload is logged and shown.
- One typed `page_unusable` reason (`announcement`, `error_page`, `access_limited`) in held-input
  notes, bootstrap failures, page status and `/diagnostics`.

## Not ported

- #1777 add-to-.gitignore: depends on upstream's shared row context menu, absent here.
- #1678's per-turn tool-count carry-over in Goal context: the fork has no such count.
- #1738's browser-wake log text, #1935 SSE byte retention (not a prerequisite).
- #488/#489 dock shell: Review uses the fork's existing right work slot instead.
- Upstream UI-only features (shortcuts dialog, sounds, pets, sharing, scheduled runs, phone
  push, settings backup) were out of the requested scope.

## Checks completed

- Every ported behavior had its new or upstream-adapted regression test fail with the source
  change reverted and pass with it.
- On the integrated branch: `npm run verify` (privacy, notices, typecheck, full Vitest and the
  isolated MCP shutdown suite), `npm run build`, and the real-Electron UI scripts
  `verify-pr-workspace`, `verify-input-queue`, `verify-sidebar-setup`, `verify-composer-layout`
  and `verify-recovery-layout` passed.
- `verify-settings-focus` fails with 29 one-level pixel differences on `uiLanguage`; base
  `4573a07c` fails identically, so it predates this port.
- `exec.test.ts` and `search.test.ts` require the gitignored `resources/` (bundled ripgrep);
  git worktrees without it fail those two tests on any commit.

No live signed-in ChatGPT acceptance was run. Browser-facing changes (announcement dismissal,
offline-page reload, rotation send-while-generating, edit through ChatGPT's editor, picker
reading) are verified at source/test level only and need the real-page check AGENTS.md §19 asks for.
