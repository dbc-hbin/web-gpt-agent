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
