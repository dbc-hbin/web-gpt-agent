# Recorder restoration document boundary

Date: 2026-10-06. Source repair and explicitly requested installed-extension repair; no release or private-ledger edits.

## Failure and repair

Chrome's installed extension error view reported `ReferenceError: CLF_DOM is not defined` at recorder initialization. The installed manifest orders the adapter before the recorder, but `restoreChatgptTab` injected the adapter, MAIN helper and recorder in three separately awaited tab-targeted calls. Navigation between those calls could initialize a recorder in a replacement document without its adapter.

Full restoration now obtains the MAIN helper injection's top-frame document id, injects `chatgpt-dom.js` and `content.js` in one ordered isolated-world call targeted to that document, and inserts CSS into the same document. Missing document proof or a retired document stops restoration without opening or reloading a replacement tab. Healthy recorder retention and exact caller-document repair keep their existing authority.

## Checks completed

- The extension, desktop-input maintenance and content scheduling suites passed all 423 tests.
- New deterministic regression cases cover a stable document, navigation after injection and missing document proof. The navigation fixture gives replacement documents separate VM globals and checks that no recorder consumes an absent adapter.
- `npm run verify` passed privacy, production notices/native-source inventories, typecheck, 5,951 main-suite tests and six isolated MCP shutdown tests. There were 84 skipped tests.
- Source and installed stable-extension `background.js` SHA-256 values matched after the focused patch. Chrome's actual extension Details identified the stable folder, and its Reload action produced an authenticated bridge wake reconnection. The app bundle and version were not replaced.

## Installed acceptance completed

A distinct diagnostic message was admitted through the actual desktop composer. It initially remained queued and unclaimed across extension reload. After the user explicitly authorized visible foreground control, the actual service-worker console confirmed that no tab had been elected for this input. An authenticated status request using the existing browser credential exceeded its 60-second diagnostic deadline. The backend's GUI outbox query took about 23 seconds.

Only completed managed work and the normal native/tunnel children were found. The existing backend was stopped through its authenticated host control and restarted from the same app executable, installation and data directory. No pending user input was cancelled, edited or manually resent. The app bundle remains version 2.2.0.

After restart the outbox query completed in 6.7 milliseconds, and the same diagnostic input had an exact browser owner, conversation and durable sent receipt. The real signed-in ChatGPT page displayed EXTENSION-BOUNDARY-OK. Session metadata recorded one user message, no tool calls, a completed turn and no active turn. The source and installed-extension hashes still matched after backend restart, and git diff --check passed. The inspection window was closed after acceptance.

The recorder initialization boundary is repaired and the installed new-chat flow was observed working. The backend's earlier internal wait was not isolated; restart demonstrates recovery of that runtime state, not a permanent source fix for every possible backend stall. No Chrome profile, security preference or permission setting was changed.
