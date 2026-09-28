<h1 align="center">Web GPT Agent</h1>

<p align="center"><sub>Independent beta. Use at your own risk and within your provider's rules. <a href="#responsible-use-and-provider-rules">Read the usage notice</a> before connecting.</sub></p>

<p align="center">
  <a href="docs/setup.md">Setup &amp; help</a> &nbsp;·&nbsp;
  <a href="CHANGELOG.md">What's new</a> &nbsp;·&nbsp;
  <a href="docs/plugins.md">Plugins</a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contribute</a> &nbsp;·&nbsp;
  <a href="SECURITY.md">Security</a> &nbsp;·&nbsp;
  <a href="LICENSE">MIT license</a>
</p>

<br />

<h2 align="center">Code. Delegate. Keep going.</h2>

**Work on the real project.** ChatGPT Web — your ordinary ChatGPT conversation, not a model API — reads and edits files, runs commands in a real terminal, and follows the actual tool results as they arrive.

**Give it a team.** One main conversation delegates independent jobs to worker conversations. Each modifying agent works in its own Git worktree, and the main agent integrates the results. Workers keep their conversation, so a later task can pick up where they left off.

**Stay in control of long tasks.** Send a correction while work runs. Inspect, pause, resume or cancel durable background work from any conversation — including the ChatGPT Android app — because the Mac keeps running after the chat closes.

<p align="center"><strong>The agents are ChatGPT Web conversations.</strong><br /><sub>Nothing here is a local coding model. ChatGPT usage limits, model availability and context limits apply to the main conversation and every worker. <a href="https://learn.chatgpt.com/docs/pricing">OpenAI usage details →</a></sub></p>

## Status of this fork

Web GPT Agent is an independent, MIT-licensed fork of [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) by [@totec448-spec](https://github.com/totec448-spec) (pinned base: commit `8f76ccc`, version 2.1.14). The upstream project remains MIT licensed; its copyright notice, contributors and third-party notices are preserved in [LICENSE](LICENSE), [CONTRIBUTORS.md](CONTRIBUTORS.md) and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

This fork adds its own product identity, isolated data and browser profiles, durable work coordination with a CLI, a code-mode MCP interface, and Korean in-app localization. It has **no updater at all** and does not read, write or adopt an existing Chat On Steroids installation. The MCP tool surface differs from upstream; see [the tool reference](docs/tool-surface.md).

- **Separate everything.** Product name `Web GPT Agent`, npm name `web-gpt-agent`, macOS bundle id `com.webgptagent.app`, data directory `~/Library/Application Support/web-gpt-agent`, companion bridge ports `8865–8869`.
- **No updater.** There is no update check, no download and no install path in the app, and no upstream release or download link. Updating is a manual act: rebuild and replace the bundle, then reload the companion extension. See [Build from source](#build-from-source).
- **Verified target.** macOS on Apple silicon is the target this fork is built and exercised on. Windows and Linux keep their upstream packaging configuration, but are not verified here.
- **Korean interface.** Select **한국어** in Setup or **Settings → Appearance → Language** (설정 → 모양 → 언어). The saved choice updates in-app labels immediately without replacing drafts, messages, paths or tool identifiers. Native menu copy and the companion extension retain their existing language.
- **Unverified by design so far.** Android device use and the full ChatGPT main-plus-worker provider flow have not been exercised in this fork; they need a real account login and are not claimed as working. See [What is verified](#what-is-verified-and-what-is-not).

## Responsible use and provider rules

Web GPT Agent is an independent, open-source workspace for coding and other authorized tasks with your own files and tools. It is intended to support productive work within the rules of the services you use. **It is not intended to bypass usage limits, account restrictions or safety controls.**

Use it in accordance with OpenAI's applicable [Terms of Use](https://openai.com/policies/terms-of-use/) ([Europe Terms](https://openai.com/policies/eu-terms-of-use/) for the EEA, Switzerland and UK), [Usage Policies](https://openai.com/policies/usage-policies/) and [Service Terms](https://openai.com/policies/service-terms/), plus your workspace's rules and any connected service's terms.

- **Respect limits and access decisions.** Workers, Goal/Loop, Compact & Resume and finish checkpoints organize work; they do not grant extra quota or model access and must not be used to evade rate limits, usage caps or account restrictions. Do not switch accounts, chats, connectors or tunnels to evade a restriction.
- **Respect safety decisions.** Do not use local tools, browser control, plugins or another worker to carry out an action that the provider blocked for safety. A local permission or an enabled MCP connector is not permission to override a provider refusal.
- **Respect the operating system.** The app never widens an OS permission you did not grant. macOS Accessibility, Screen Recording, and any one-time authorization an external driver needs are yours to grant, and the app does not install, start, update or reconfigure third-party drivers.
- **Understand the integration.** Web GPT Agent connects local tools through MCP. Its companion also observes and automates the ChatGPT browser UI in an app-owned browser profile and records conversation content locally. This browser integration is not a public ChatGPT automation API. MCP availability does not establish permission for every form of browser automation or recording; OpenAI's terms also restrict automated or programmatic extraction of data or output.
- **Use at your own risk.** Review the rules for your account and intended workflow before connecting, supervise automation and review tool actions and outputs. Web GPT Agent cannot guarantee policy compliance, continued service access or protection from account warnings, restrictions or suspension. If a workflow is restricted or receives a policy warning, stop that workflow and seek clarification through the provider's support or appeal process.

This notice states the project's intended use; it does not certify compliance or change provider rules. Web GPT Agent is not affiliated with, endorsed by or approved by OpenAI. The software is provided as-is under the [MIT license](LICENSE); applicable statutory rights remain unaffected. See [Security](SECURITY.md) for local permissions and risks.

<br />

## Build from source

There is no published installer for this fork and the app cannot update itself. Build it locally.

**Requirements:** Node.js 22 or newer (the release workflow uses 22), npm, and Git. `npm run rg` and `npm run tunnel` fetch pinned, checksum-verified build artifacts, so the first build needs network access. Packaging macOS arm64 additionally needs **macOS 13 Ventura or newer on Apple silicon**, which is the target this fork is verified on.

```sh
npm ci
npm run rg          # fetch the pinned ripgrep used by search
npm run tunnel      # fetch the pinned tunnel client used by the Core connector
npm run build       # electron-vite build of the app and the CLI
npm run dist:dir:mac:arm64
```

`npm run dist:dir:mac:arm64` writes an unpacked bundle — not a DMG — to:

```text
release/mac-arm64/Web GPT Agent.app
```

The app bundle carries the local CLI at `Contents/Resources/bin/wgpt`. It is an ordinary executable, so a path containing spaces works:

```sh
"release/mac-arm64/Web GPT Agent.app/Contents/Resources/bin/wgpt" --help
```

`npm run dev` runs the app against the source tree, and `npm run verify` is the full local check (ripgrep present, privacy scan, notices, typecheck, the Vitest suites). `npm run dist:mac:arm64` produces the DMG/zip artifacts instead of the unpacked directory. Read [AGENTS.md](AGENTS.md) before changing the app and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

<details>
<summary>Where this fork keeps its data</summary>

Every store is rooted in one directory, resolved before Electron's single-instance lock and before any store captures a path:

| Path | Contents |
| --- | --- |
| `~/Library/Application Support/web-gpt-agent` | Config, encrypted credentials, session history, durable state, plugins, `work.sqlite`, `runtime.json` |
| `~/Library/Application Support/web-gpt-agent/browser-profile` | The app-owned Chrome/Edge/Brave profile: the companion extension and the ChatGPT login live here |
| `~/Library/Application Support/web-gpt-agent/extension` | The extension folder materialized from the package, stable across launches |
| `~/Library/Application Support/web-gpt-agent/worktrees/<work_id>/…` | Isolated Git worktrees for managed work |

Data directories are mode `0700` and secret files `0600`. `--data-dir <absolute-path>` redirects all of it for an isolated run; a relative value is refused. This directory is this fork's own and is not the upstream app's.

</details>

## Set up once

1. **Approve a project folder.** Settings → Workspace. Add the folder ChatGPT may read and edit. File tools are constrained to the roots you approve; commands are not.
2. **Configure the tunnel.** Settings → Setup. Create a tunnel in [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels) in the same workspace you use in ChatGPT, and a **Restricted** [API key](https://platform.openai.com/settings/organization/api-keys) with **Tunnels: Read** and **Tunnels: Use**. Paste both, press **Connect**, and wait for Connected. Cloudflare quick tunnels and your own HTTPS tunnel are also available; [tunnel setup →](docs/setup.md#tunnel-setup).
3. **Add the connector in ChatGPT.** Enable Developer mode, then create one custom app of type **Tunnel** and use the name and description the app shows on the connector card. The connector name is exactly:

   ```text
   Web GPT Agent
   ```

   That is the Core connector — MCP server name `web-gpt-agent-core`. It is the only connector required. In ChatGPT, set the app's action permissions to **Allow all actions** so approval prompts cannot stall long-running work; your folder and tool permissions in this app still apply.
4. **Load the companion extension.** Press **Open extension folder**, then in `chrome://extensions` enable Developer mode, choose **Load unpacked** and select that folder. Pairing is automatic.
5. **Sign in to ChatGPT once, manually, in the app's own browser profile.** The app opens its dedicated profile (`browser-profile` inside its data directory); sign in there yourself. It does not copy cookies from your everyday browser, does not decrypt another app's stored secrets, and does not log in for you. That one-time login is what every main conversation and worker conversation then uses.
6. **Start a task.** Choose a project and model, write your request and send it.

Want screen and keyboard control? Enable the optional **Web GPT Agent Desktop** connector and its separate tunnel. The app includes CUA Driver 0.29.1 and owns its embedded runtime; no separate CuaDriver installation, daemon or Plugins preset is needed. On macOS, grant Screen Recording and Accessibility to **Web GPT Agent**, then use **Recheck Desktop permissions** in Workspace settings. Native tools retain CUA's upstream schemas inside `exec`/`wait`; browser-tab tools remain separate. **Web GPT Agent Plugins** is the other optional connector. See [docs/plugins.md](docs/plugins.md).

**After you replace the app bundle:** reload the unpacked companion extension and refresh the connector in ChatGPT. Those are two separate steps.

## Control work without a browser

Core publishes a single direct `work` tool with six actions that need **no browser page and no proven worker conversation**. A conversation that can reach this connector — the ChatGPT app on a phone included — can start and steer work on the Mac with `{ "action": "start", "input": { ... } }`; one that cannot reach it is not given the tool.

| `work` action | What it does |
| --- | --- |
| `start` | Start durable coding work on this Mac and return its `work_id` at once. It launches the main conversation and its workers. |
| `list` | List durable work, newest first, with eligible configured projects. |
| `status` | Goal, status, agents and worktrees, blocker, checkpoint, recent operations. |
| `instruct` | Send an instruction to running work at the next safe turn boundary. On a finished work it routes along the continuation chain to the work that actually receives it. |
| `control` | Pause, resume or cancel. Resume continues the same agent in the same worktree. |
| `events` | The durable event log, oldest first; `next_cursor` continues. |

This is not a second connector, endpoint or tunnel. The same secret path and Host/Origin checks apply. Start requires an approved Git project; start, instruct and resume require editing and command permissions and refuse read-only mode. Status, events, pause and cancel remain available.

A work-changing call is authority because the client is authenticated and names its target: `start` names the project, and `instruct` and `control` name the `work_id` they are about. No browser page, attached conversation or worker binding is required or inferred. When the page has placed the call, that metadata dedups the message against the automatic relay's inbox row and attributes the call in the conversation's own timeline, and a `start` makes the asking conversation the work's controller when it has no binding yet — so the work's reports come back to the chat that asked. Absence of that metadata costs the dedup and the attribution, never the call.

### Connect a chat to a work

A work's controller is the conversation whose messages are relayed to it and which receives its reports. Nothing is bound from a message the host merely observed: a binding comes from proven identity only — the **Connect this chat** press below, the first managed prime that owns a work (so a work started here can be continued from the same chat), or a proven `work` call that started it. The **Works** pane can connect the chat this window is displaying to the selected work, which is an explicit opt-in:

| Control | What it does |
| --- | --- |
| **Connect this chat** | Authorizes new messages in this chat's saved ChatGPT conversation to be relayed to this work from now on. |
| **Disconnect this chat** | Stops new automatic relay and report delivery for this chat. It does **not** pause, cancel or otherwise change the work. |

The pane names the chat it is showing and its state — `Connected`, `Connected to another work`, `Not connected`, or `Checking…` while the host has not answered — and renders the host's own refusal instead of guessing when the connection cannot be read. One chat drives one work at a time: connecting a different chat takes the controller role over from the previous one, which is disconnected rather than deleted, so no two chats drive one work. A connection you made is never taken over automatically — the app's own fallback binds only a work that has no controller at all, and switching a chat back on is itself recorded as your decision, so a later fallback cannot displace it. A chat with no recorded conversation yet is refused (`STATE_UNAVAILABLE`) rather than connected to a guess.

Connecting is what authorizes the relay; it does not by itself make messages arrive, and the relay is addressed to that **same saved ChatGPT conversation**. The desktop companion reads it directly from the provider rather than from a page: a chat the user wrote to from a phone while it was closed has no tab anywhere, so the only complete evidence of the active branch is the provider's own conversation document, fetched with the browser's authenticated session and walked from `current_node` back through real parent links. The access token never leaves that module; the host is told only the account id. The extension reads exactly the conversations the host names — there is no conversation listing and no account scan — and posts one authenticated snapshot per bound conversation, as consecutive windows of one read when the branch is longer than a single body, oldest first. The host applies a read only once every window has arrived in order under one unchanged authority, answers `409` for a chat it stopped watching or a window it cannot place and `422` naming any row it could not admit, and admits only messages on that conversation's active branch, oldest first, once each — the provider message id is the identity — and never relays a message the controller chat itself already executed. So the desktop browser must stay reachable while a work is connected.

A native mobile MCP client is not a supported transport: there is no mobile app, and a phone's part is the same synced ChatGPT thread rather than a second connector or endpoint. Both halves are covered by tests — the host side against the bridge fixtures, the companion side against the provider's own document shape with a stubbed fetch — but no live ChatGPT account or phone was driven end to end; see [What is verified](#what-is-verified-and-what-is-not).

Reports travel the other way on the same conversation: a status or final report is written only to the bound conversation and carries a recorded host-generated origin, so the automatic relay refuses to read it back as an instruction — decided from that recorded origin, never from anything the message says about itself, so no control prose is injected into your chat. An explicitly invoked `work` call is not gated on that check: it is authenticated, it names the work it is about, and the ledger admits it.

**Code mode:** the public Core catalog is `exec_read`, `exec`, `wait`, `tools_search`, `work` and, when enabled, `agents` and `session_finish`. Desktop and Plugins expose `exec`, `wait` and `tools_search`. Find exact schemas with `tools_search`; use Core `exec_read` for read-only tools and `exec` for mutating or mixed scripts. For example, inside `exec_read`:

```js
const result = await tools.read({ paths: ["/workspace/src/app.ts"], start_line: 1, end_line: 80 });
text(result);
```

Only explicit output helpers, such as `text(...)` and `image(...)`, emit results. Each execution uses a fresh bounded runtime, with no filesystem or network access except through its own connector’s tools; a yielded cell continues through `wait`. Coding children run under the caller's existing permissions and approved-root sandbox, and a call that names a managed work additionally keeps its `operation_id` receipt and generation fence. Lifecycle controls stay direct, outside the JavaScript wrappers. A failed script never rolls back effects or automatically replays the whole script. [Complete tool contract →](docs/tool-surface.md)

The same six controls are available locally, with no ChatGPT in the loop, through the packaged CLI. `wgpt host start` starts the host in the background and waits for it to answer; the `work` commands never start a host as a side effect:

```sh
wgpt host status
wgpt host start
wgpt work start --project /absolute/path/to/repo --goal "Fix the failing build" --json
wgpt work list
wgpt work status <work_id>
wgpt work instruct <work_id> --text "Also update the README"
wgpt work pause <work_id>
wgpt work resume <work_id>
wgpt work events <work_id> --after 0 --follow
wgpt work connection <work_id>
wgpt work reconnect <work_id> --timeout 30000
```

Global flags (`--json`, `--data-dir`) work before or after the subcommand. `--json` emits one JSON response or event per stdout line; diagnostics go to stderr. Exit codes are part of the contract: `0` accepted/success, `2` invalid input, `3` host unavailable, `4` rejected operation. Run `wgpt --help` for the exact flag list.

### Run the tools without the app: `wgpt daemon`

The `daemon` group runs the MCP coding surface as a standalone **plain Node** process — no window, no tray, no browser, and no Electron installation required. It serves the same MCP listener (Core, and the optional Desktop and Plugins surfaces), the same work ledger and the same local control socket as the desktop app, so `read`, `find`, `exec_command`, `apply_patch` and the `work` tool behave identically whether the app is installed or not.

```sh
wgpt daemon start  --data-dir /absolute/path/to/data   # detached; waits until it answers
wgpt daemon status --data-dir /absolute/path/to/data --json
wgpt daemon config --data-dir /absolute/path/to/data   # approved folders, Read-only, permissions
wgpt daemon secret --data-dir /absolute/path/to/data   # tunnel API key (presence only)
wgpt daemon stop   --data-dir /absolute/path/to/data
wgpt daemon serve  --data-dir /absolute/path/to/data   # foreground, Ctrl-C to stop
```

`--data-dir` is required rather than defaulted: the daemon owns its data directory alone. The rules it enforces are deliberate:

- **`start` is idempotent.** If a daemon already answers for that directory, `start` prints *that* daemon's own report and launches nothing. It never falls back to the desktop app, and it refuses outright (`DATA_DIR_CONFLICT`) when the desktop app owns the directory — two writers over one SQLite ledger is the failure this prevents. The desktop app's own `runtime.json` and process are never touched.
- **`status` reports a live, authenticated peer.** The descriptor in `runtime.json` is a claim, not a fact: `status` completes the control handshake (installation id, protocol version, and the daemon's control token) and asks the daemon itself. A stale descriptor with a still-existing pid reports *not running*, because a pid is not an instance.
- **`config` is the non-UI path for permissions.** A daemon has no window, so `wgpt daemon config` reads and changes its approved folders, Read-only mode and tool permissions: `add-root <path> [--name <virtual-name>]`, `remove-root <name>`, `read-only on|off`, `capability <permission> on|off`. Every change is applied by the *running daemon* through the same serialized settings transaction the desktop UI uses and is on disk before the receipt is answered, so the CLI never writes `config.json` behind the owner's back. The report lists requested and effective permissions separately: a granted Desktop permission is shown as not effective, because a daemon genuinely cannot serve it. Folders are validated exactly as the folder picker validates them — absolute, existing, canonical, and not overlapping an existing root.
- **`stop` stops exactly one instance.** It requires the descriptor and the answering socket to agree on the instance id, then asks *that* daemon to stop over its authenticated socket. No pid is ever signalled.

### Reaching a daemon from another machine

A daemon serves a **loopback** MCP endpoint, exactly like the app. To reach it from elsewhere, point it at a tunnel:

```sh
export WGPT_SECRET_KEY="$(openssl rand -base64 32)"   # protects secrets.bin; keep it secret
wgpt daemon start --data-dir /absolute/path/to/data
wgpt daemon config tunnel openai tunnel_<32 hex> --data-dir /absolute/path/to/data
wgpt daemon secret set openaiApiKey <api-key> --data-dir /absolute/path/to/data
wgpt daemon status --data-dir /absolute/path/to/data     # now reports `tunnel connected` + public_url
```

- **The transport is the app's own.** `cloudflared` (a quick tunnel, no credential needed) and OpenAI's Secure MCP Tunnel are the two adapters the desktop app already uses, with the same supervision, health accounting and restart behaviour. `daemon config tunnel manual` turns the tunnel off and leaves the daemon on loopback.
- **The credential store is the same `secrets.bin`.** A daemon has no OS keychain, so it derives its cipher from `WGPT_SECRET_KEY` — AES-256-GCM, key never written to disk, no plaintext fallback. Without that variable the store reports itself unavailable and every write is refused by name; `daemon secret status` says so and quotes the variable. Replacing the key makes an existing store unreadable *and* unwritable rather than silently discarded, so a credential is never destroyed by a key change.
- **Only presence is ever reported.** `daemon secret` prints `stored` / `not stored` and never the value: a credential readable back over the control socket would leak through anything able to read the descriptor, and the caller that set it already knows it.
- **`status` reports the transport, not a remote receipt.** `tunnel` carries `state`, `detail` and `publicUrl`. A connected child is not proof that another machine can resolve the URL or call a tool. `wgpt daemon config reconnect --data-dir <data>` restarts the configured tunnel without stopping the coding endpoint or losing work. Unrelated permission changes leave an unchanged tunnel running.

The daemon is plain Node, so the portable `bin/wgpt.mjs` launcher resolves a real `node` (or `WGPT_NODE_EXECUTABLE`) instead of reusing the app's Electron binary. `bin/wgpt` is the POSIX entry and `bin/wgpt.cmd` is the Windows entry; arguments and paths containing spaces are preserved. With no Node available, daemon commands refuse and say so. Nothing here installs a service, an agent or a login item. The MCP endpoint keeps the app's existing exposure rules: loopback only, one secret path per surface, and no new unauthenticated listener.

**What a daemon does not have.** The Core coding tools are complete — `read`, `find`, `exec_command`, `write_stdin`, `apply_patch`, `update_plan`, `work`, `work_checkpoint`, `work_resume` and the external MCP gateway all work exactly as in the app, verified over the daemon's own authenticated endpoint. What is genuinely desktop-only is absent rather than failing:

- **No native Desktop in the plain Node host.** Its Desktop permissions are masked, and browser delivery does not add native input. The app-owned embedded CUA runtime belongs to the Electron backend, not to the plain Node daemon. Ordinary external MCP integrations retain their separate installation and permissions.
- **Browser delivery is explicit.** Without `--browser`, managed work has no browser delivery adapter; delivery failure is recorded rather than falsely reported as sent. With it, the existing paired extension, durable input outbox and exact browser receipts deliver work openings and later instructions. An unavailable browser does not become a successful send.
- **No OS credential store — a key from the environment instead.** `secrets.bin` is normally Electron-encrypted; a daemon has no `safeStorage`, so it derives the same store's cipher from `WGPT_SECRET_KEY` (AES-256-GCM, key never on disk). Without that variable the store reports itself unavailable and refuses writes by name rather than inventing a plaintext file. With it, a daemon publishes a tunnel exactly as the app does; without a tunnel configured it serves the loopback endpoint its `runtime.json` and `daemon.status` publish.

`npm run build:node` builds the CLI and daemon bundles (`out/cli`, `out/daemon`) without an Electron build. For a packaged copy, plain Node cannot read inside `app.asar`, so `out/daemon` and its `node_modules` must be resolvable outside the archive; the daemon never uses an Electron binary as a fallback runtime.

### Optional plain-Node browser delivery

```sh
wgpt daemon start --browser --data-dir /absolute/path/to/data
```

Browser mode materializes the companion at `<data>/extension` and uses the existing
bridge and managed browser profile. Load that unpacked extension into the selected
browser and sign in to ChatGPT in that profile. Keep the extension next to the daemon
distribution; it is not downloaded at runtime. Restart an already-running coding-only
daemon with `--browser` to enable the adapter; idempotent `start` never reconfigures
another running process. Browser login, provider generation and native Send receipts
remain separate from a listening local bridge.

### Desktop GUI and persistent backend

The desktop app runs two processes. Its window is a client of a persistent, windowless
Electron backend; it retains the existing chats, history, Goal/Loop, files, plugins and
settings screens. The backend alone owns settings, encrypted credentials, sessions,
work, MCP listeners, tunnels and browser delivery. The GUI uses the private authenticated
control socket and keeps only its Chromium UI profile under `<data>/desktop-client`.
Closing or quitting the GUI does not stop the backend. Setup exposes the backend PID,
data directory and explicit Start/Stop controls; stopping the backend also stops its
local tools and tunnels.

After a backend restart, the GUI reconnects its event subscription and refreshes current
state without replaying commands. Human terminals and file watches belong to the renderer
generation: reload, crash or closure retires them without stopping MCP work. Plugin changes
use that same event stream. GUI operations retain their handler-owned deadlines rather than
the CLI's generic 30-second deadline; losing a reply does not authorize repeating a mutation.
Notification launches show the window and consume their exact session target once.

The first split-profile launch imports legacy Local Storage atomically, retaining the source
and never replacing an existing unmarked destination. If backend startup fails while this
import is pending, startup reports the error before creating a replacement UI database.
Credentials and Chromium encryption metadata are not copied into the GUI profile.

Ordinary desktop launch connects to the existing backend or starts one. `wgpt host start`
starts that same backend without opening the GUI; login-item `--background` launches do
the same. For a source build:

```sh
npm run build
npm run daemon:client -- --data-dir /absolute/path/to/desktop-data
```

This Electron backend is distinct from `wgpt daemon`, the optional plain-Node coding
host above. The desktop backend keeps the original data directory and OS-encrypted
`secrets.bin`, including existing tunnel API keys, and retains native Desktop support.
It does not convert those credentials to `WGPT_SECRET_KEY` or let the plain-Node host
open the same data directory. Both runtimes acquire the same exclusive ownership lock
before opening stores, including concurrent cold starts. Stop and configuration requests
retain their proved runtime instance rather than following a replacement descriptor.

Exact request ownership lives in `state/request-correlations.sqlite`. The 50,000-entry
RAM cache is only a cache: evicted requests are looked up on disk, including after
restart. Existing version 3–5 JSON snapshots migrate as input; new proofs commit in
one SQLite transaction before acknowledgement. First ownership and conflicting human
ancestor evidence remain durable. Worker rows show the last recorded operation/time,
checkpoint and scheduled recovery, without calling a quiet worker dead or completed.


## Results, replay and safety

**Where results land.** A modifying work does not edit your checkout through the app's own Git operations. The host captures a private baseline commit, creates an integration branch `wgpt/<work_id>/main` in a worktree under its data directory, and gives each worker its own branch and worktree. The deliverable is the verified integration branch and worktree, named in the accepted receipt and in `work_status` from admission onward. Your original checkout, index, `HEAD` and branches are left untouched by that snapshot/integration machinery; applying the result is a separate task you can ask for. Isolated parallel editing needs a Git project, so a non-Git directory is refused with `PROJECT_NOT_GIT` rather than silently initialized.

That is a statement about the host's own operations, **not a sandbox**. Commands, external MCP servers and the desktop driver run with your normal user privileges and can reach anything your account can — including your checkout. Isolation here means parallel edits do not collide, not that a command cannot touch a path.

**Replay safety.** Every mutating call carries a UUID, and both kinds are idempotent keys rather than labels:

- **`request_id`** identifies a control request. The same ID with the same payload returns the prior receipt instead of acting twice; the same ID with a different payload is refused with `REQUEST_ID_CONFLICT`.
- **`operation_id`** identifies a mutation (`apply_patch`, `exec_command`, non-empty `write_stdin`, mutating agent actions, `mcp_call`). It is required at admission, recorded `prepared` before anything runs and `running` before any side effect. A retry of the same ID and arguments joins the first call instead of repeating it.

**Continuing a finished work.** Sending an instruction to a work that already completed does not reopen it. The ledger walks the recorded successor links to the active end of the chain and, when that end is completed, admits one durable successor: a new `work_id` with its own prime, its own integration branch and worktree, whose baseline is taken from the predecessor's result snapshot — so committed history and the predecessor's uncommitted work both carry forward. The predecessor keeps its goal, status and revision history; the only things written on it are the successor link and one `work_continued` event. The receipt names the work the instruction actually landed on, plus `predecessor_work_id`, and `work_status` shows `predecessor_work_id` / `successor_work_id` so an interface can route to the tip. A chain that loops, names a missing work or cannot be walked is refused with `CONTINUATION_CONFLICT` rather than followed.

**Unknown outcomes are resolved explicitly, never guessed.** If a command or external MCP call may already have taken effect but its result was never recorded — a dropped response, a killed host, a reconnecting driver — the operation becomes `outcome_unknown` and the work is blocked with `OPERATION_OUTCOME_UNKNOWN`. Nothing is replayed. A bare `resume` is refused until a person decides, through `work_instruct`'s `resolve_operations`: `accept_observed_effects` records the decision without inventing stdout, an exit code or a verified UI outcome, and `authorize_retry` mints one fresh operation id for a single authorized retry. The old record and the decision are both kept.

**Background close is not Quit.** Closing the window keeps the host, the connector, the CLI socket and any running work alive; on macOS the app stays reachable from the Dock and menu bar, and the tray has Open / Connect / Quit. **Quit** is a drain, not a kill: it stops admitting work, fences every agent, terminates owned processes, pauses active work with reason `HOST_STOPPED`, releases the desktop lease and closes the control socket and ledger. Cancellation remains terminal, and an unresolved operation or drain failure keeps its safety blocker instead of being hidden by the shutdown reason. After relaunch, `work_status` shows the same work and `work_control resume` continues it in the same worktree. Nothing is replayed blindly.

**Nothing here lifts a provider or OS restriction.** A local permission, an enabled connector or a running driver is never a reason to retry a provider refusal, and the app does not switch accounts, chats or tunnels to route around one. Login expiry, CAPTCHA, rate limits and account restrictions surface as a truthful blocked state (`AUTH_REQUIRED`, `PROVIDER_UNAVAILABLE`) that you resolve. Commands run with your normal user privileges; see [Security](SECURITY.md).

## Goal, Loop and the optional API provider

Goal, Loop and Plan are optional helpers that decide what to type next, and they can run either as a separate ChatGPT chat or against an **optional API backend** you configure yourself (OpenRouter by default, or any OpenAI-compatible endpoint). That optional API provider supplies continuation and planning text only. It is not the agent: the work itself is always carried by ChatGPT Web conversations — one main conversation plus its workers. Nothing about the agent loop requires an API key.

## What is verified and what is not

Verified on this host, in the packaged app and the packaged CLI: the host starts in the background and answers `host status`; `work start` writes a durable `work_id` into `work.sqlite` and returns at once; work and its event log survive closing the window, killing the host and relaunching; the packaged sample creates an isolated Git worktree under its data directory; and with no tunnel configured, work blocks with a truthful, retained `PRIME_LAUNCH_FAILED` blocker instead of pretending to run.

The "your checkout is left untouched" property is proven against the worktree module with a Git fixture carrying existing staged, unstaged and untracked changes — asserted on the source index bytes, `HEAD` and branch, not inferred from the packaged run. The packaged sample exercises the ordinary clean-project path; the dirty-checkout case is the module fixture. Treat both statements as scoped to the host's snapshot/integration Git operations, not as a sandbox for commands you run.

Not verified, and not claimed: the full ChatGPT main-plus-worker provider flow (it needs your one-time login and a real connector), and any Android device or account interaction. The controller-conversation relay is implemented and tested on both sides — the host's watch list and snapshot endpoint against the bridge fixtures, the companion's provider read against the provider document shape with a stubbed fetch — but no live ChatGPT account or phone was driven through it, so a live phone-to-work sync is unverified. Android's own support for MCP apps is a provider question this project cannot answer; work control is implemented and exercised against the local endpoint without a browser page, which is a protocol fact, not proof that a particular phone client works. Treat mobile use as unverified. Windows and Linux builds are not verified here at all.

## Requirements and limitations

- **macOS 13 Ventura or newer** on Apple silicon is this fork's verified target. The built bundle declares `LSMinimumSystemVersion 13.0`. Windows and Linux keep upstream packaging configuration; they have not been exercised here.
- **Builds are unsigned and unnotarized.** The macOS bundle has no publisher signature: no Apple certificate chain and no TeamIdentifier, so Gatekeeper, SmartScreen or a browser may warn. Verify what you built. By default it is ad-hoc signed. On a machine that has a local signing keychain (`~/Library/Keychains/web-gpt-agent-signing.keychain-db` holding the self-signed `Web GPT Agent Local Signing` identity), packaging signs with that identity instead. Rebuilds then keep one stable code requirement, so macOS keeps the Screen Recording and Accessibility grants. `WGA_MAC_SIGNING=adhoc` forces the ad-hoc seal.
- **The Linux AppImage can fall back to `--no-sandbox`** when the host disables unprivileged user namespaces. That fallback weakens Chromium's process sandbox, and it applies to unchanged upstream code. On Debian/Ubuntu, prefer the DEB if you do not want it.
- **Node.js 22 or newer** is needed to build and to run the development CLI. The packaged CLI runs on the Electron binary it ships beside, so a target machine needs no separate Node.
- Fresh installs enable Core permissions, session recording and multi-agent mode. Windows also enables Desktop permissions; macOS starts them off; Linux masks native desktop capabilities at runtime.

## Get help

- [Setup and reference](docs/setup.md) — tunnel, connectors, permissions, troubleshooting.
- [Plugins](docs/plugins.md) — external MCP integrations, including the optional Cua Driver preset.
- [Tool reference](docs/tool-surface.md) — the exact model-facing surface.
- [Architecture](AGENTS.md) — how the app is put together.
- [Security](SECURITY.md) — the local permission model and its limits.
- [Worklog: MCP daemon and conversation continuity](docs/worklog-2026-09-21-mcp-daemon-continuity.md) — what this branch implements, what was verified, and what is still open.

<p align="center"><sub>Not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks. Web GPT Agent is a fork of the MIT-licensed Chat On Steroids project.</sub></p>
