# Setup and reference

[Back to the overview](../README.md)

## Before connecting

Read the [responsible-use notice and provider rules](../README.md#responsible-use-and-provider-rules). Web GPT Agent is an independent beta, used at your own risk. Its companion observes and automates the ChatGPT browser UI in an app-owned browser profile and records conversation content locally; this is not a public ChatGPT automation API. MCP/tunnel access does not establish permission for every automated workflow. Your account's terms, usage limits, safety decisions and workspace rules still apply.

This fork has no updater and no published installer. Build it yourself; see [Build from source](../README.md#build-from-source). macOS 13 Ventura or newer on Apple silicon is the verified target, and the build is unsigned and unnotarized — Windows and Linux are unexercised here. See [Requirements and limitations](../README.md#requirements-and-limitations).

## Quick start

1. **Build and open the app.** `npm ci && npm run rg && npm run tunnel && npm run build && npm run dist:dir:mac:arm64`, then open `release/mac-arm64/Web GPT Agent.app`.
2. **Choose what ChatGPT may access.** In **Settings → Workspace**, keep **Approved folders only** and approve a project folder, or explicitly choose **All files** after reviewing its confirmation. File tools follow that choice; commands already run with your user privileges and are not confined to approved folders.
3. **Connect the local tools.** Configure a tunnel in **Settings → Setup**, press **Connect**, then add the **`Web GPT Agent`** app in ChatGPT's Developer mode.
4. **Load the companion extension.** Press **Open extension folder**. In `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select that folder. Pairing is automatic.
5. **Sign in to ChatGPT once, yourself, in the app's own browser profile.** The app opens its dedicated profile and waits for you; it does not copy cookies from another browser, decrypt another app's secrets or sign in for you.
6. **Start a task.** Choose a project and model in the app, write your request and send it.

**Separate installations:** the folder opened by the app is generated for its installation identity, including in development. Each `--data-dir` instance needs its matching extension folder and a separate browser profile. A companion with another installation’s saved credentials refuses to reconnect rather than transferring observations. Loading the raw repository `extension/` directly is an unbound manual installation, not a multi-instance isolation setup.

Want screen and keyboard control? Enable **Desktop** permissions and connect its separate **`Web GPT Agent Desktop`** app, which needs its own tunnel. CUA Driver 0.29.1 is bundled and started as an app-owned embedded runtime; do not install a separate driver or configure a socket. On macOS, grant Screen Recording and Accessibility to **Web GPT Agent** using Workspace's permission controls, then recheck to restart the embedded runtime. Browser-tab control remains separate. Core works without Desktop.

**After replacing the app bundle:** reload the companion extension and refresh the connector in ChatGPT. These are two separate steps.

## Tunnel setup

### OpenAI Secure MCP Tunnel

1. Create a tunnel in [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), in the same workspace you use in ChatGPT.
2. Create a **Restricted** [API key](https://platform.openai.com/settings/organization/api-keys) with **Tunnels: Read** and **Tunnels: Use**.
3. Enter the tunnel ID and key in the app and press **Connect**.
4. In ChatGPT, enable Developer mode under **Settings → Apps → Advanced settings**, then create a custom app of type **Tunnel**. Use the connector name and description the app displays. Review and enable its actions.

The Core connector is named exactly **`Web GPT Agent`**; its MCP server name is `web-gpt-agent-core`. Desktop and Plugins are separate optional connectors with their own names and their own tunnels. Release packages include the pinned, checksum-verified `tunnel-client`, fetched at build time by `npm run tunnel`.

### Other tunnels

**Cloudflare quick tunnel:** connect in the app and use the displayed public URL as the MCP server URL in ChatGPT. The random path is a secret and changes on restart.

**Your own HTTPS tunnel:** forward to the loopback URL shown by the app and preserve its secret path. Treat the resulting URL like a password.

## Permissions and connectors

| Connector | What it adds |
| --- | --- |
| **`Web GPT Agent`** (Core, `web-gpt-agent-core`) | Local files, patches, terminals, generated-file downloads, session history, plans and workers through code mode, plus the direct `work` control tool. Available on all supported platforms. |
| **`Web GPT Agent Desktop`** | Browser-tab tools plus bundled CUA inspection, input and clipboard. Windows and macOS; macOS starts with permissions off and requires OS grants to Web GPT Agent. Optional. |
| **`Web GPT Agent Plugins`** | External MCP tools such as Blender, Playwright and Memory, plus custom local or remote servers. Optional. [Plugin guide](plugins.md). |

Embedded CUA is **not** a Plugins installation or a fourth connector. Core retains its managed `mcp_tools` / `mcp_call` route under the reserved `cua-driver` server identity; Desktop exposes native schemas inside `exec` / `wait`. Both routes use the same app-owned runtime, not an externally installed driver.

**Approved folders only** is the default, including existing configs without a file-access choice. **All files** is an explicit saved choice for model-facing file tools: native absolute paths outside approved folders become available wherever the OS lets your account access them. The app asks for confirmation when enabling it in Settings; existing folder aliases remain and disabling it revokes outside-root file access. macOS privacy protections still apply. A rootless All files setup can use absolute paths; unscoped search requires a path, and omitted command cwd starts at home. You still choose individual capabilities. Shell commands already run with your normal user privileges in either mode; Desktop and plugins retain their own permissions. **Read-only mode** disables writes, command execution and desktop control. The plain-Node daemon exposes the same mode through `wgpt daemon config file-access approved-roots|all-files`.

History is stored locally, with recording on and no age expiry by default. Credentials use the operating system's secure storage. Review permissions before connecting: fresh installs enable Core capabilities and multi-agent mode; Windows also starts with Desktop permissions enabled, while macOS starts them off.

[Security policy](../SECURITY.md) · [Tool reference](tool-surface.md) · [Architecture](../AGENTS.md)

## Sessions, workers and background work

**Session history** belongs to the local session, not a particular ChatGPT tab. The companion records messages and the actual local tool results so the app and the model can read earlier work.

**Compact & Resume** asks for a handoff, starts a fresh provider conversation and rebinds that same session. Task and worker history move with it. Automatic compaction uses configured local estimates and eligible live work; Pro models never auto-compact.

**Workers** keep their conversation when they finish. Send a follow-up to reuse one. The default is two simultaneous workers, configurable up to eight. Idle owned tabs can be reused or closed after fresh checks; the durable worker history remains.

**Durable work** is the newer layer on top: a `work_id` in a local SQLite ledger, a prime conversation, worker conversations in isolated Git worktrees, and an integration branch that holds the result. It is what the CLI and the `work` tool drive, and what makes a task survive a closed window, a reloaded page or a restarted host. The worktree machinery never stashes, resets, cleans or checks out in your own repository — but this is operational isolation, not a sandbox: commands, external MCP servers and desktop control still run with your normal user access. See [Results, replay and safety](../README.md#results-replay-and-safety).

**Continue a finished work.** Sending an instruction to a work that already completed does not reopen it: the ledger follows its recorded successor links to the active end of the chain and, when that end is completed, admits one durable successor with a new `work_id`, its own prime and its own worktree, whose baseline is the predecessor's result snapshot. The predecessor keeps its goal, status and revision history; the only things written on it are the successor link and one `work_continued` event. The receipt names the work the instruction landed on and `predecessor_work_id`, and `work_status` shows the chain in both directions, so route later instructions to the `work_id` you were given.

**Connect a chat to a work.** Open the **Works** pane next to the chat you want to drive the work, select the work and press **Connect this chat**. That authorizes new messages in that chat's saved ChatGPT conversation to be relayed to the work; **Disconnect this chat** stops new relay and report delivery and does **not** pause or cancel the work. The pane shows whether the chat it is displaying is connected (`Connected`, `Connected to another work`, `Not connected`, or `Checking…` while the host has not answered), and a chat with no recorded conversation yet is refused rather than connected to a guess. One chat drives one work at a time, and a connection you make is never replaced automatically: the app's own fallback binds only a work that has no controller at all, and reconnecting a chat counts as your decision. The relay uses that chat's synced ChatGPT thread, so the desktop browser must stay reachable while a work is connected, and a native mobile MCP client is not a supported transport. The companion reads a bound conversation from the provider itself — a chat written from a phone has no tab anywhere — and posts one snapshot per bound conversation for the host to admit; both halves are covered by tests against a stubbed provider fetch, but no live account or phone was driven end to end. See [Connect a chat to a work](../README.md#connect-a-chat-to-a-work).

**Goal** can decide the task is complete and send nothing. **Loop** continues within the brief until disabled. Both support ChatGPT helpers or an optional API backend that supplies continuation and planning text only — the agent itself is always ChatGPT Web.

**Session finish** can receive queued instructions and plan checkpoints inside the same working turn when it is enabled. You can end the turn from the composer. This does not remove provider usage or context limits.

These continuity features do not grant additional quota or access. Do not use new chats, workers, Goal/Loop or compaction to evade a provider restriction. Supervise automated work and stop a restricted workflow instead of asking another chat or tool to continue it.

## Troubleshooting

- **Missing or stale tools:** refresh the relevant connector in ChatGPT. Reloading the companion extension is a separate action.
- **Provider usage limit or policy warning:** stop the affected workflow and disable its Goal/Loop automation. Follow the provider's stated reset or support/appeal process. Do not switch accounts, chats, models, connectors or tunnels to evade the restriction. A local retry or reconnection is not evidence that a policy restriction has been lifted. Keep account notices and appeal details private; a GitHub issue cannot resolve an account enforcement decision.
- **Tunnel rejects the API key or tunnel ID:** check the saved tunnel ID, the selected setup profile, and that its key has Tunnels Read + Use for that tunnel. Extension pairing does not authenticate the tunnel. If Platform offers no matching ChatGPT workspace, retain the exact error for an access investigation; a different tunnel does not establish account eligibility.
- **ChatGPT blocks a tool for safety:** local permission alone does not prove that ChatGPT accepted or dispatched the call. Inspect the local tool history for the exact request. If no result exists, execution is unconfirmed; do not replay a potentially executed operation or route it through another connector. Keep the task's progress and report the provider's error, selected Chat/Work surface, and app/extension versions without credentials or private content. A plan label alone does not diagnose a provider refusal.
- **The app returns `TOOL_DISABLED`:** check Read-only and the named local capability. `CALLER_IDENTITY_REQUIRED` or `WORKER_IDENTITY_LOST` instead concerns exact caller ownership; neither proves that command execution is globally disabled.
- **`WORKER_CONNECTION_REQUIRED` on a work call:** the call named a managed work that could not be resolved — a stale generation, a work the ledger does not have, or a conversation no longer bound to one. Coding tools themselves need no worker identity: a phone, a fresh chat, a scheduled run and a host that has not restored its ledger all read, run commands and patch files under the same permissions and approved folders. For managed work use the direct `work` tool with action `start` / `list` / `status`, and pass `work_id` to `work_checkpoint` / `work_resume` when the call has no conversation of its own.
- **`CONTROLLER_BINDING_CONFLICT` when connecting a chat:** the chat is already driving a different work, or you asked to disconnect a chat that is not connected to this work. One chat drives one work at a time — disconnect it from the work named in its own pane first, or use the **Disconnect this chat** button the Works pane offers for the work it actually drives.
- **`STATE_UNAVAILABLE` when connecting a chat:** the saved session has no recorded ChatGPT conversation yet, so there is no thread to relay into. Send a message in that chat first. The same code on a disconnect means the ledger is open but continuity has not been restored yet; retry after the host finishes starting.
- **Work is blocked with `INSTRUCTION_DELIVERY_UNKNOWN`:** an instruction's hand-off was attempted and its outcome cannot be established, so it may or may not have reached the conversation. Nothing is resent as if it had not happened — the outbox row is the reconciliation, and the blocker clears when a late acknowledgement confirms the send. Inspect the work and its pending commands rather than repeating the instruction.
- **`CONTINUATION_CONFLICT`:** the recorded continuation chain loops, names a work that is not in the ledger, or cannot be walked, so the instruction was refused rather than routed. Inspect the chain with `work_status` (`predecessor_work_id` / `successor_work_id`) instead of starting a replacement work to work around it.
- **`WORK_NOT_FOUND` or `STATE_UNAVAILABLE` from `work_checkpoint` / `work_resume`:** the `work_id` is not in the ledger, or the `agent_id` you named is not an agent of that work. Reads and writes never resolve an id globally; list the works with `work` action `list` and use the exact ids they report.
- **Work is blocked with `OPERATION_OUTCOME_UNKNOWN`:** a command or external call may already have taken effect. `resume` is refused on purpose. Inspect the work, then send an instruction with `resolve_operations` for each unknown operation — `accept_observed_effects` or `authorize_retry`.
- **Work is blocked with `PRIME_LAUNCH_FAILED`:** the main ChatGPT conversation could not be opened. The detail names the cause, typically a missing tunnel ID/key or a browser that is not signed in. Fix it, then call `work` with action `control` and input action `resume`. With no tunnel configured this blocker is the expected, honest result.
- **Work is blocked with `AUTH_REQUIRED` / `PROVIDER_UNAVAILABLE`:** ChatGPT needs you to sign in again, or the provider is rate-limiting or refusing. Resolve it yourself; the app does not bypass login, CAPTCHA or account restrictions.
- **`CUA_BUSY`:** another work holds the desktop lease. Git worktrees isolate a checkout, not a desktop, so only one managed work may drive the native desktop at a time. Coding-only work continues.
- **Extension version mismatch:** reload the unpacked companion after replacing the app bundle, then reload the ChatGPT page.
- **Models missing:** use **Reload ChatGPT models**. The picker reflects availability in your signed-in account.
- **`UNIDENTIFIED_CALLER`:** use that conversation in the paired browser so the extension can prove its request identity. The app does not guess from the active tab.
- **`COMPACTION_IN_PROGRESS`:** let the source chat finish its handoff. Work continues in the replacement conversation.
- **Linux credential storage unavailable:** unlock GNOME Keyring or KWallet, then restart the app.
- **A chat will not stop:** **Block** revokes local tools for that exact conversation. It does not claim to cancel the provider's generation.

## CLI reference

The packaged CLI lives at `Contents/Resources/bin/wgpt` inside the app bundle:

```sh
"release/mac-arm64/Web GPT Agent.app/Contents/Resources/bin/wgpt" --help
```

| Command | Purpose |
| --- | --- |
| `wgpt host status` | Report whether a host is running for the data directory, with its pid and control protocol version. |
| `wgpt host start` | Start the app in the background and wait for it to answer on its control socket. |
| `wgpt work start --project <absolute-path> --goal <text>` | Admit durable work; optional `--title`, `--model`, `--reasoning`, `--max-workers 1-8`, `--request-id <uuid>`. |
| `wgpt work list` | List work, newest first; optional `--cursor <work_id>`, `--limit 1-100`. |
| `wgpt work status <work_id>` | Goal, status, agents, worktrees, blocker, checkpoint, pending commands. |
| `wgpt work instruct <work_id> --text <text>` | Send an instruction; optional `--request-id <uuid>`. |
| `wgpt work pause\|resume\|cancel <work_id>` | Control the work; optional `--request-id <uuid>`. |
| `wgpt work events <work_id>` | Read the event log; optional `--after <cursor>`, `--limit 1-200`, `--follow`. |
| `wgpt work connection <work_id>` | Report whether this work's existing chat is usable right now: `--agent-id <uuid>` selects one of its agents (omitted means the current prime), `--conversation-id <uuid>` is an exact expected chat and a mismatch is a refusal, never a rebind. Exit 0 only for `ready`. |
| `wgpt work reconnect <work_id>` | Ask for that same existing chat to be brought back, waiting up to `--timeout <milliseconds>` (default 30000, `0` allowed, capped at 60000). It opens no new work, agent, session or chat, sends no message and never resumes paused or cancelled work; a repeated or concurrent call joins the attempt already in flight. Exit 0 only for `ready`, 4 for `opening`/`unavailable`. |
| `wgpt daemon serve --data-dir <absolute-path>` | Run the standalone daemon in this terminal. Foreground; Ctrl-C stops it. |
| `wgpt daemon start --data-dir <absolute-path>` | Start the daemon detached and wait until it answers. Idempotent: an already-running daemon is reported and reused, never duplicated. |
| `wgpt daemon status --data-dir <absolute-path>` | Report the daemon that actually answers on that directory's control socket — its instance id, pid, version, start time and MCP endpoint URLs. Never read from `runtime.json` alone. |
| `wgpt daemon config --data-dir <absolute-path>` | Read that daemon's approved folders, Read-only mode, tool permissions and tunnel. `add-root <path> [--name <virtual-name>]`, `remove-root <name>`, `read-only on\|off`, `capability <permission> on\|off` and `tunnel openai\|cloudflared\|manual [<tunnel_id>]` change them. The report shows requested and effective permissions separately, so a granted Desktop permission is visible as not effective on a host with no browser. |
| `wgpt daemon secret --data-dir <absolute-path>` | Read which credentials the daemon holds (`status`), or store and clear one (`set openaiApiKey <value>`, `clear openaiApiKey`). Presence only — a value is never echoed back. A daemon protects `secrets.bin` with `WGPT_SECRET_KEY` instead of the OS keychain; without it the command reports the store unavailable and quotes the variable. |
| `wgpt daemon stop --data-dir <absolute-path>` | Stop the exact instance the descriptor and the answering socket agree on, over its authenticated control socket. No pid is ever signalled. |

Global flags `--json` and `--data-dir <absolute-path>` work before or after the subcommand. Work commands never start a host as a side effect. Exit codes: `0` accepted/success, `2` invalid input, `3` host unavailable, `4` rejected operation.

The CLI talks to the host over an app-owned local endpoint discovered from `<data-dir>/runtime.json` (mode `0600`): a Unix socket, mode `0600`, in a private `0700` directory on macOS and Linux, and a randomly named local named pipe on Windows, narrowed to your own account before the host publishes it. It never opens the ledger or initializes Electron itself.

### Standalone daemon

`wgpt daemon` runs the MCP coding surface, the work ledger and the local control socket as a **plain Node** process with no desktop app involved — the same tools a ChatGPT connector reaches, usable on a machine where this app was never installed. `--data-dir` is required rather than defaulted, because the daemon owns its directory alone.

- **One writer per data directory.** `start` is idempotent for a daemon that is already running and refuses with `DATA_DIR_CONFLICT` when the desktop app owns that directory. The desktop app's `runtime.json` and process are never modified or signalled, and a stale descriptor whose owner is genuinely gone is reconciled through the host's existing pid probe rather than assumed dead.
- **Identity, not pids.** `status` requires a live, authenticated answer from the socket (`daemon.status`); a descriptor with a still-existing pid and no answering socket is reported as not running. `stop` requires the descriptor and the answering socket to agree on `instance_id` before it sends `daemon.stop`, so it can never stop a different instance.
- **No Electron fallback.** `bin/wgpt` resolves a real `node` (or `WGPT_NODE_EXECUTABLE`) for the daemon; when none exists the command refuses and says so instead of quietly starting an app process. `npm run build:node` builds just the CLI and daemon bundles (`out/cli`, `out/daemon`) without an Electron build.
- **No service, no autostart.** Nothing here installs a launch agent, service or login item; a daemon runs only because you started it, and the MCP listener keeps the app's existing loopback-only, per-surface secret-path exposure rules.

#### Reaching it from another machine

A daemon serves a loopback endpoint; to publish it, give it a tunnel and a credential:

```sh
export WGPT_SECRET_KEY="$(openssl rand -base64 32)"
wgpt daemon start --data-dir /absolute/path/to/data
wgpt daemon config tunnel openai tunnel_<32 hex> --data-dir /absolute/path/to/data
wgpt daemon secret set openaiApiKey <api-key> --data-dir /absolute/path/to/data
wgpt daemon status --data-dir /absolute/path/to/data    # `tunnel connected` plus the public URL
```

`tunnel cloudflared` needs no credential at all; `tunnel manual` turns publishing off. The transport is the desktop app's own (`tunnel-client`, `cloudflared`), including its supervision and health accounting. `WGPT_SECRET_KEY` is what replaces the OS keychain: AES-256-GCM over the same `secrets.bin`, the key never written to disk, and no plaintext fallback — without it `daemon secret` reports the store unavailable and quotes the variable. Changing the key makes an existing store unreadable and unwritable rather than silently discarded, so a credential is never destroyed by a rotation.

## Building

```sh
npm run dist:dir:mac:arm64   # macOS Apple silicon, unpacked (this fork's verified target)
npm run dist:mac:arm64       # macOS Apple silicon, DMG + zip
npm run dist:x64             # Windows x64
npm run dist:arm64           # Windows ARM64
npm run dist:mac:x64         # macOS Intel
npm run dist:linux:x64       # Linux x64
npm run dist:linux:arm64     # Linux ARM64
```

Build on the target OS. Only the macOS Apple silicon target is verified by this fork; the others retain upstream packaging configuration. The release workflow uses native runners for all six targets, checks the packaged runtimes and assembles the artifact set with checksums and corresponding native library sources.

Read [AGENTS.md](../AGENTS.md) before changing the app and [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a PR.

---

[MIT licensed](../LICENSE). Not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks. A fork of the MIT-licensed Chat On Steroids project.
