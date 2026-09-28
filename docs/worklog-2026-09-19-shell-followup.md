# Alternate shell follow-up delivery, issue #311

The reporter's retest after #319 confirmed model selection but still reported blocked follow-up
sends, worker startup and visible setup instructions. This follow-up compares the two privately
provided page captures with @ehkogh's #318 and the matching public client modules. Private exports,
account/session fields, network payloads and real conversation text are not publication inputs.

## Demonstrated boundaries

The shell editor serializes ordinary inserted text as Markdown. The native literalPaste mark,
identified in #318 and confirmed in the matching client schema, preserves prepared punctuation and
hard breaks. The adapter applies that mark only to the marked shell editor, through its existing
single HTML edit. Classic insertion and the exact native Send receipt remain unchanged.

The shell user bubble lacks the classic role attribute. Its current MAIN message stamp now joins
the bubble to the same exact source/frame parser used by the recorder. Presentation hides only a
valid setup frame, and restores original presentation when a reused bubble no longer has one.

An older exchange may retain in_progress after a later exchange finishes. Only the latest native
exchange can provide the composer's typed running hint. This does not synthesize a completed turn
or a tool receipt. The normal exact final and native control guards remain in force.

The shell's typed tool invocation can use the underscore recipient spelling of the known connector
name. Both exact spellings are accepted; similarly named third-party connectors remain excluded.

Typed items omit backend request metadata. The bounded native cache observation from #318 is
adapted to read only request ids/timestamps for the mounted exchange's explicitly named message
ids in its exact conversation cache. The query, node and message identities must agree. Multiple
matching caches, conflicting conversation ids and duplicated selected ids abstain. Cache failure
does not erase typed messages. No child traversal, cached answer text or cached final status is
used; the existing stream observer still supplies early live request evidence.

Recorder, MAIN helper and background restoration versions advance together to 16 so an older
live recorder cannot prevent the new adapter from loading. The app/extension release stays 2.1.14.

## Verification

Before changes, the focused regressions reproduced both text/presentation failures and the three
additional metadata/name/busy gaps. Synthetic integration fixtures exercise the production DOM
adapter, MAIN helper, isolated recorder, native model-selection path, exact Send acceptance and
extension-to-app publication contract. They cover three successive desktop inputs and worker
bootstrap, including multiline instructions, answer completion, prompt presentation and attribution.
Classic input/recorder/extension suites run alongside them.

Full repository verification passed: 5,509 tests plus six isolated shutdown tests, with 45 skipped.
TypeScript, public-history privacy, dependency notices and pinned native-source checks passed.
The Windows x64 production build and installer completed successfully. A separate isolated
Chromium 153 check used native HTML editing and native button clicks: it retained the literal
mark and exact text, traversed/restored the picker, selected the exact worker lane, and completed
three successive sends with one exact receipt and a settled final for each. Page data in that
check was synthetic; it did not load the private captures or contact the reporter's account.
CI and installed-payload acceptance remain separate publication gates.
The reporter's actual NixOS/affected-account execution cannot be established by these fixtures.
The issue remains open for that retest; source/test proof is not claimed as their live acceptance.

## Canonical user-source receipt repair

A later shell opening was accepted by the provider while its app outbox still awaited the
exact receipt. The mounted user item exposed Markdown presentation escapes, so the recorder
compared that representation rather than the original prepared text. Native literalPaste
insertion alone did not fix this separate observation boundary.

`extension/fiber.js` now takes the original user text from the already-proved conversation
graph for that exact mounted message. Exchange membership, graph node id, message id and user
role must agree. The existing bounded text reader applies. Assistant prose/completion remains
owned by the mounted exchange; no unrelated graph messages are imported. Literal backslashes
are preserved, not decoded away to force a receipt. The existing Send claim and acknowledgement
remain unchanged, including when canonical source arrives after submission. No protocol shape
or helper version changes, new timer, alternate send path or durable-state migration is needed.

The new original-source regression failed before the repair and passed afterward. The shell
suite passed all 63 tests; the three-successive-input integration now also delays canonical
opening source, checks that it is not acknowledged prematurely, then verifies one receipt
per native Send and normal subsequent answers. Neighboring regressions refuse foreign
conversations, mismatched node/message ids, wrong roles and ids absent from the mounted exchange.

`npm run verify` passed: 5,886 tests with 83 skipped, then six isolated shutdown tests; TypeScript,
privacy, dependency notices and native-source checks passed. A throwaway Electron 44.3.0 /
Chromium 152 fixture loaded the production Fiber reader and used real window messaging. It
verified escaped presentation differs from recovered original text, exact user identity,
mounted-only assistant text and wrong-role refusal. Its temporary isolated profile and script
were removed. This fixture had no network access to ChatGPT and did not attach to Chrome.

At this initial source-only stage, no package, installed app/extension, live outbox ledger or
user browser was changed. Signed-in provider acceptance after installation remained unverified;
source and fixture results do not claim that an already-stuck live receipt was cleared.

### 2026-09-29 source follow-up: image-bearing canonical user

Review found that the exact mounted graph source used the text-only reader. A shell user
message with `content_type: multimodal_text` therefore left its escaped presentation in place,
even though its public string parts were available. The source now shares the bounded user-text
reader with native user capture: only string parts cross into text, in order with their newline
separators; image pointers and object metadata do not. The exact conversation, mounted id,
graph node, message id and user role requirements remain unchanged. Assistant content types and
the existing Send receipt check are unchanged. Literal backslashes remain authored bytes.

The new cache/live multimodal-source regressions failed before this correction and pass now.
The image-bearing canonical opening, delayed exact receipt, single Send click, three completed
answers and refusal of wrong identity, role, type or object-only source were exercised in the
focused shell fixture. `npx vitest run test/shell-compat.test.ts test/fiber.test.ts` passed
(174 tests); `npm run typecheck` passed. Full `npm run verify` then passed 5,890 tests
(83 skipped) and six isolated shutdown tests, including privacy and dependency/native-source
checks. The multipart regression keeps a valid context frame and preserves literal escapes.

An isolated Electron 44.3.0 / Chromium 152 smoke used the production Fiber, DOM adapter and
content recorder with native HTML insertion and a synthetic provider/app transport. Both cache
and live-store paths produced one native Send, zero premature ACKs, then one ACK after delayed
multimodal source; exact original text survived and image pointers stayed out of the snapshot.
The first harness run completed cache proof but closed its last window before live proof; after
fixing that harness lifetime, the live scenario passed. The same two scenarios passed using
the extension files from the newly installed bundle. No signed-in image upload is claimed.

The macOS arm64 bundle was built separately from the running bundle using the existing package
steps and a builder output override. `smoke-macos-bundle.mjs` and `smoke-packaged-runtime.mjs`
passed, including native dependencies and isolated plain-Node daemon startup/status/clean stop.
The bundle retains version 2.1.14 and the existing local signing identity. After authenticated
backend shutdown, it replaced `release/mac-arm64/Web GPT Agent.app`; the prior bundle remains
under `release/multimodal-previous` for rollback. Installed ASAR, executable and Fiber hashes
matched the staged package. The existing `bridge:extensionPath` IPC transaction refreshed the
managed extension copy; its Fiber hash matches both source and installed bundle. Sessions and
settings were not manually edited, and Chrome was not debug-attached or forcibly reloaded.

The replacement backend answered authenticated `host.status` and the bridge reconnected to
the extension. Full GUI readiness remains blocked on macOS Keychain: `state:get` timed out
and a process sample showed `SecItemCopyMatching` / keychain content decryption waiting on
the Security server. No security setting or credential was changed to bypass that consent.
Actual signed-in receipt acceptance and GUI-ready state remain unverified until that wait
is resolved; installed-file and isolated-script checks are not a substitute.
