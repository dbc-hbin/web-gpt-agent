# Native composer text and turn completion

## Failure and native evidence

A new app-owned ChatGPT opening could be accepted by the provider without matching its frozen outbox text. The native final was then recorded without the opening's turn ownership, while the outbox retained an unresolved browser send.

The current shell's native serializer recognizes relative Markdown links even inside code-looking text such as `tools["name"](value)`. Its rich-document branch removes `literalPaste` marks from a cloned document before serializing punctuation and hard breaks. Retaining the mark in the live editor therefore does not prove that submitted bytes stay unchanged. This behavior was traced in the public ChatGPT `396705.6b0f9c5f16.js` and `418851.84e96666b7.js` assets and reproduced on the signed-in page.

The first HTML-only paste approach passed its local tests and a short native Send, but failed actual framed openings. That approach and its inaccurate serializer fixture were reverted rather than shipped.

## Change

- `extension/fiber.js` accepts one bounded synchronous composer action. It joins a unique native controller to the exact editor through `view.dom`, verifies the route and current text, switches that controller to plain-text mode, performs one native HTML edit from the authorized original, and checks the native submission text.
- `extension/chatgpt-dom.js` preserves its synchronous insertion API, including capture-phase human Goal marker insertion. It delegates shell composer edits through the exact-target nonce handshake and verifies native text again immediately before programmatic Send. Classic and inline-editor insertion keep their existing path.
- The helper owns one editor-local mode lease. Existing scans and exact clearing restore the original mode only when the same editor is empty. Helper replacement transfers the lease; a changed or replaced draft is not reparsed for cleanup. No saved ChatGPT preference, new observer, polling loop or durable ledger is introduced.
- `extension/content.js` prepares an already-matching restored shell handoff draft before reserving or arming its Send. Otherwise the new native text guard could refuse it after dispatch authority had already been recorded.
- The existing executing-reader privacy regression now checks that native tool payloads are not parsed and that only allowlisted evidence crosses the boundary. The obsolete source-text prohibition on any `JSON.parse` use was removed; bounded composer-command parsing does not parse native tool arguments.

Receipt matching, canonical source bytes and outbox authorization remain strict. No escape-normalization fallback or resend was added.

## Verification

- A real native controller probe preserved all 11,198 characters of a sample containing the rich-link trigger, Markdown and backslashes: input and `getChatGptPrompt().prompt` SHA-256 matched. The owned diagnostic draft was cleared and the original editor mode restored.
- The installed synchronous isolated-to-MAIN action succeeded against the actual native editor and cleared its owned draft.
- A real app `sessions:send` opening using the observed `gpt-6-thinking` / High selection progressed `queued -> browser -> sent`. Its frozen and canonically recorded native text matched exactly at 10,510 characters. The final `turn-fix-ok` had the same turn identity as its start; the end was `completed`, 2,953 ms after that start. The full operator check finished in 8.45 seconds.
- Native DOM and screenshot inspection confirmed the authored message projection and final answer. The empty composer had returned to its original Markdown mode after Send.
- The helper-replacement mode regression failed before the transfer fix. The restored-handoff regression failed before preparation was moved ahead of dispatch; both are included in the passing suite.
- `npm run verify` passed privacy, license/native-source checks, TypeScript, 6,420 tests, and the separately executed six shutdown tests. The existing 86 skipped tests remained skipped. The final audit's restored-handoff finding was reproduced and fixed.

An earlier family-alias test was refused at model confirmation before Send; the successful flow used the page-observed execution identity. Ambiguous earlier sends were not replayed, and their recorded state was not rewritten.

The three changed unbundled extension files were mirrored to the installed extension and their SHA-256 values checked against source. After the final reload, the native companion popup confirmed that the app was reachable and that it was recording the exact accepted chat. No Electron application package was rebuilt and no commit or release was created. Temporary diagnostic code was removed. The restored-handoff correction is covered by the production-script regression; no additional live compaction was claimed.
