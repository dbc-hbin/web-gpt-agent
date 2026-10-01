# Cua Driver Desktop cutover, 2026-09-25

## 0.31.0 engine and cursor update, 2026-10-01

Upgraded the SDK, all six executable target pins and corresponding source/license
inventory together to 0.31.0 (`5272e492d61b96caf08e3bf434d91126c1f3dccc`).
Downloaded and hashed the release archives, then checked each target's extracted
architecture/provenance. Linux retains browser-only native policy. Current Setup,
Plugins, tool documentation and the ownership map describe the new engine; the
older release notes and dated evidence below remain historical.

Desktop and managed Core now enforce token-only element actions. Pixel click names
the observed immutable capture; native tools without that field use their same
host-owned session's current exact-window observation. Input reserves observation
authority before dispatch, including uncertain outcomes. Verification cannot retarget
another window's tokens. The new screen-read `get_agent_cursor_state({})` exposes only
the host-owned chat/work cursor, does not consume the current input observation and
rejects caller session routing. Administrative cursor tools remain excluded.

An isolated signed macOS arm64 package passed bundle checks (nine launch modes,
25 thin Mach-O payloads) and native-stack/Node-daemon smoke checks with CUA 0.31.0.
An isolated Electron Node-mode harness used the production runtime and Desktop
wrapper against that packaged SDK/child, not the installed app or external daemon.
It proved host identity and granted Screen Recording/Accessibility, captured a
controlled 780×464 AppKit window, typed text, clicked by token and by capture-bound
pixels, and independently observed exactly two button increments. A repeated stale
input and a foreign cursor session were refused. A cursor-state read between
observation and input preserved the input authority. The foreground app and user's
native mouse position stayed unchanged. Desktop capture reported overlay exclusion
through `screencapturekit_excluding_windows`. The harness recorded no user screenshot.
The fixture's initial showing animation produced a correctly refused frame-size
mismatch; disabling animation and publishing fixture readiness after layout fixed
only the fixture, without relaxing engine capture validation.

Native Windows execution is unverified: this host is macOS and has no configured
remote test host. Both Windows targets were integrity/architecture checked only.
No installed app, running user driver, provider chat or runtime ledger was replaced.

Verification: privacy, notices (168 production packages, seven catalog entries),
732 native-source archives/patches and TypeScript passed. The full main suite
completed with 212 passing files, three skipped and one failure in an obsolete
copied tool-name list. Removed that list rather than repinning it; the existing
test now checks retained keyboard focus across host-state pushes. All 43 renderer
tests then passed. The six isolated shutdown tests passed separately. The focused
native Desktop/managed-gateway/recording run passed 32 tests. An earlier TypeScript
run caught a possibly undefined test-array access, fixed before the passing check.
Production main/preload/renderer, CLI and daemon builds passed; final isolated
packaging sealed with the existing local signing identity and verified its envelope.

Perception assessment: the optional 0.2.1 release is separate from MIT Driver 0.31.0.
Its MIT worker and ONNX runtime carry AGPL-3.0-only OmniParser detector weights and
exporter material, plus Apache-2.0 OCR. Selecting only text regions still runs the
detector and does not remove those obligations. Actual published macOS arm64 and
Windows x64 manifests match their catalog hashes; archive inventories indicate
426/421 MB downloads and approximately 450/429 MiB expanded payloads respectively.
There is no published macOS x64 or Windows arm64 artifact. No extension was installed
or executed, and this review did not independently hash full compressed archives
or verify catalog signatures through the local Driver.

Parsing is local, capture/session/generation-bound and non-consuming. A future
opt-in route would need explicit host-owned installation, signed artifact verification,
mixed-license notices/source handling, bounded region/text output, and real containment
and inference checks. Its separate sandboxed process does not establish licensing
clearance. The current application deliberately does not expose parsing, model-controlled
installation or cursor administration.
The user explicitly chose to exclude Perception from this integration after reviewing
its role and footprint. Its three inference models total about 93.6 MB (80,933,219-byte
icon detector, 4,826,518-byte OCR detector and 7,848,423-byte English recognizer); the
larger distribution includes original weights, conversion sources and runtime material.
No optional installation feature or parser exposure is part of this change.

### Screenshot-only Windows admission correction

Review found that the native Windows screenshot-only response omits `snapshot_id`,
although it returns a screenshot and `capture_id`. This predates 0.31.0. Desktop now
keeps nullable snapshot identity and admits either real snapshot authority or a
delivered image with its capture identity. Capture-based observation grants no token
authority. It retains exact caller/window/binding/runtime generation, expiry, replacement
and single-use checks; the native engine and schema remain unchanged.

The positive regression failed before the fix. A separate isolated signed macOS
runtime smoke used the production wrapper and real screenshot/input transport, removing
only the screenshot-only result's `snapshot_id` to reproduce the Windows response shape.
The fixed wrapper delivered one real background pixel click; independent AppKit state
and a fresh native observation both showed exactly one button increment. Old element
tokens and repeated input were refused, and foreground/user mouse position were
unchanged. The harness initially used `width`/`height` for a native rectangle whose
actual fields are `w`/`h`; correcting only that fixture enabled this successful check.
This proves the app's capture-only path with real macOS transport, not Windows native
execution. No installed application or user data was replaced.
The focused Desktop/recording/Core run passed 178 tests (seven skipped), and the
final Desktop regression run passed 25. Negative cases cover absent/blank snapshot
and capture IDs, missing image or app identity, wrong chat/window/capture, token
misuse, replacement-read ordering and changed runtime generation. The permanent
image fixture is a valid 64×64 PNG with the tested coordinates inside its bounds.
Final `npm run verify` passed: privacy/notices/native-source checks, TypeScript,
213 main-suite files with 5,922 passing tests (84 skipped), and six isolated shutdown
tests. `npm run build` then passed for main, preload, renderer, CLI and daemon.

## Embedded-engine correction

The user rejected the external-driver ownership below: the app must bundle and own its
native engine. The current change pins upstream CUA Driver 0.29.1, retains `exec`/`wait`
and upstream schemas, and replaces the Plugins proxy with an Electron-owned embedded
runtime and private endpoint. The prior installed external-proxy build was rolled back;
the historical checks below are not evidence for this replacement.

Current permission UI validation: the production renderer ran in isolated Electron with
an in-memory backend fixture. Native pointer input exercised explicit Request and Recheck,
both controls disabled during an outstanding operation, failure recovery, disappearance
after granted status, Korean labels, and 800px/150% zoom layout without overflow. All five
localization suites passed (24 tests). This proves renderer behavior, not OS consent or
native capture. Embedded runtime and package evidence is recorded separately below.

Integrated source validation passed `npm run verify`: privacy, production notices
(170 packages and seven catalog entries), 732 pinned native source archives/patches,
TypeScript, 5,881 main-suite tests (83 skipped), and six isolated shutdown tests.
The new lifecycle regressions cover Stop during startup, draining an accepted invocation
before restart while refusing stale-generation dispatch, and startup/child-exit failure
remaining an actionable unknown permission state until explicit recovery. Focused
IPC/renderer/platform/connection tests also passed (146 tests). An earlier verify stopped
on in-progress removed-preset imports; another timed out at the command limit after
exposing notice-fixture failures. Those fixtures were migrated before this passing run.

The isolated macOS arm64 package passed native resource/import and ad-hoc bundle checks
(25 thin Mach-O payloads, nine launch modes). The bundled 0.29.1 child reported
`bundle_identity: pass`, `identity_source: parent_application`, and
`com.webgptagent.app`; nonprompting Accessibility and Screen Recording checks were granted.
An isolated copy running the production `cua/runtime.ts` owner published 24 native
declarations, invoked its real MCP transport, and captured its controlled 720×480 window
as a valid PNG with an accessibility tree. Stop cleared readiness and removed the private
child socket. No external CuaDriver installation or socket supplied these checks.
Windows assets were staged/integrity-checked but not executed on this Mac; Linux retains
its existing browser-only native policy. The installed app was not replaced.

Full desktop-shell validation has an OS authorization limit: a fresh copy of the rollback
bundle answered authenticated `state:get` in 85 ms, while the new ad-hoc-signed bundle
waited inside Electron `safeStorage.isAsyncEncryptionAvailable()`. Disabling native
startup in a temporary copy did not change that wait; single-call tracing excluded
concurrent state requests as its cause. Contemporaneous read-only `securityd` diagnostics
and a single-call GUI fixture explicitly named `Web GPT Agent` confirmed the service-label
boundary: the default-name fixture returned, while the matching-name fixture waited. The logs
explicitly recorded a Keychain approval prompt for the new bundle signature, whereas
the rollback signature was already authorized. No approval was clicked, credentials or
ACLs changed, or integrity checks bypassed. Full shell startup therefore requires the
user's Keychain approval (or a correctly authorized stable release signing identity);
the independent production CUA owner/window-capture smoke above does not claim that
shell check passed. Isolated test processes were stopped; the user's running app and
data were left intact.

## Dedicated-review fixes

The dedicated reviewer found three P1 defects that the original suite missed: Core's
native route bypassed the four capability switches; an eager Electron import stopped
the packaged plain Node daemon; and the explicit macOS permission entrypoint still
resolved the SDK through a virtual ASAR path. These are distinct from the Keychain
authorization limit above.

Core and Desktop now share the native tool/capability mapping. Core filters discovery
and exact schemas, checks live authority at dispatch, and withholds both replies and
driver errors after revocation. Managed identities, mutation receipts and Core's
existing blanket Read-only rule remain intact. The Electron backend now supplies
native executable/SDK locations to the common runtime; importing it grants no Electron
dependency or startup. The permission entrypoint selects the physical unpacked SDK URL.

Focused gateway/Desktop suites passed 21 tests, including a failing-before discovery
regression and pre/post-dispatch capability revocation. The lifecycle suite passed
three tests with the new startup contract. A fresh isolated macOS arm64 package built
successfully. Its expanded packaged smoke imported the real permission SDK without
requesting OS access, then started the packaged daemon under plain Node with no
Electron-resolvable module, verified authenticated local status with tunnel/browser
disabled, and stopped it with a clean process exit. No installed app or user data changed.

Final `npm run verify` passed privacy/notices/native-source checks, TypeScript, 5,884
main-suite tests (83 skipped) and six shutdown tests. The dedicated reviewer rechecked
exactly the three original P1 findings and found all three resolved, with no additional
finding in that narrow pass. The macOS permission probe imported the SDK but deliberately
did not request OS consent; the previously documented Keychain authorization limit remains.

## Historical external-proxy implementation (superseded)

Installed-package validation: the current dirty tree typechecked, built all Electron/CLI/daemon bundles and packaged a darwin-arm64 app. The first packaged-runtime smoke exposed one stale assertion for the removed bundled macOS desktop addon; removing that obsolete assertion made the native runtime/resource smoke pass. The macOS bundle audit verified 22 thin Mach-O payloads, six launchable executables, deployment floors and the ad-hoc resource seal. The staged bundle replaced `release/mac-arm64/Web GPT Agent.app` after an authenticated backend shutdown. The installed GUI and replacement backend then launched from that exact path, the host control socket reported version 2.1.14, and a live Cua Driver window capture returned a valid 1567×813 PNG frame. Packaged `Resources/desktop` is absent as required by the cutover.

Build/check follow-up: `npm run build` passed for main, preload, renderer, CLI and daemon bundles; `node bin/wgpt.mjs --help` exercised the generated non-GUI CLI entry. The first `npm run verify` run failed two code-mode runtime tests because their asynchronous test gates could release before the guest timer was registered or the reader cell had yielded. `test/code-mode-runtime.test.ts` now arms the awaited timer before notifying the fake-clock host and obtains the reader cell before releasing its gate. Its 42 tests passed in isolation; the full `npm run verify` rerun passed privacy/notices/typecheck, 5,880 main-suite tests (88 skipped), and six shutdown tests. No installed package, native GUI, driver daemon or live Desktop action was exercised.

This change supersedes the bundled computer-use architecture described in the 2026-09-19 native audit and the older overhaul plan. The browser-tab Desktop tools remain separate. Native Desktop is now the installed Cua Driver preset's advertised tools, with the driver's upstream names and input schemas exposed inside Desktop `exec` / `wait` after `tools_search`. Core retains its external MCP gateway. There is no substitute `observe` / `computer`, Window2, `sky`, PowerShell, Swift helper or app-owned native input path when the driver is absent.

The driver binary and daemon are user-managed. Web GPT Agent does not launch a GUI app or daemon, take foreground focus or grant OS permissions on its behalf. On macOS, Screen Recording and Accessibility consent belongs to CuaDriver.app. The Electron package no longer includes a native desktop helper/addon or a Screen Recording usage declaration. Browser tools, code-mode wrappers and the Node host's distinct capability mask remain.

Desktop discovery is intersected with the reviewed driver catalog and live screen/control/clipboard permissions. Read-only mode prevents native mutations and clipboard writes; read and clipboard-read paths remain subject to their own grants. Caller identity and snapshot ownership are checked for native actions, and responses retain a bounded MCP result envelope. Session recording redacts clipboard contents rather than storing them in text or structured results.

Post-review repair: Desktop rechecks live permission/block/worker policy after the session read and withholds all content and structured data when read authority changes before publication. An already dispatched mutation reports an uncertain effect without forwarding its result. Plugin admission rechecks enablement, declaration and transport after its callback; the race regression failed before the fix for tool disable, installation disable and reconnect, then passed. Alternate Windows launch selectors are refused. Foreground-only invoke_menu and zoom are absent from Desktop discovery and dispatch: the installed driver's zoom schema lacks the explicit session needed to use Desktop's chat-owned screenshot. Core's managed gateway retains zoom; its crop is read-only and does not consume the following action's snapshot. Native-success fixtures now opt into a supported platform independently of the host; the opt-in live test resolves its socket only after its live gate.

After that repair, the focused CUA/Desktop, plugin-manager, Core gateway and recording suites passed (89 tests, six live skips), typecheck passed, and npm run verify passed privacy/notices/typecheck, 5,880 main-suite tests with 88 skips and six shutdown tests. The first full verify caught a stale zoom summary classification; correcting its source made the second full run pass. A final focused Desktop/recording run passed 12 tests, and npm run build produced main, preload, renderer, CLI and daemon bundles. No native GUI or driver daemon call was exercised. A simulated Windows Vitest launch could not start on this macOS dependency installation because the Windows Rollup binary is absent; Windows and Linux CI behavior is source/fixture-checked here, not runtime-proven on those hosts.

Integrated validation: `npx vitest run test/mcp-desktop-cua.test.ts test/code-mode-mcp.test.ts test/cua-live-gateway.test.ts` passed 35 tests with five opt-in live cases skipped. The Desktop suite exercised the local MCP endpoint and nested `exec` against an isolated driver fixture, including cross-chat snapshot refusal and A→B→A fencing. `npm run verify` passed TypeScript, privacy/notices checks, 5,873 tests in the main suite and six shutdown tests. `npm run build` produced main, preload, renderer, CLI and daemon bundles. No installed app, native GUI or driver action was exercised; Windows daemon connectivity and live native window effects remain unverified. The installed Cua Driver 0.28.2 CLI's read-only `describe` output was inspected for native schema fields.

Source-check evidence, without opening the user's apps or driver daemon: `npx vitest run test/cua-desktop-recording.test.ts test/platform.test.ts test/renderer-state.test.ts test/connection.test.ts test/macos-adhoc-seal.test.ts` passed the recording, platform, connection and seal files; one renderer assertion pinned an incidental obsolete tool count and failed. After deleting that wording assertion and its dead fixture, `npx vitest run test/renderer-state.test.ts` passed 43 tests. The MCP connector suite passed; `test/code-mode-mcp.test.ts` initially failed because the test migration removed its still-used `currentCall` import, then passed all 28 tests after the import was restored. The packaging fixture (`npx vitest run test/packaging.test.ts -t "builds runnable CLI and daemon bundles"`) passed, as did `node --check` for `package.mjs`, both package smoke scripts and the macOS afterPack seal script. This is isolated source verification, not a live GUI/daemon exercise or a packaged installer validation.
