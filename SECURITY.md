# Security policy

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.** Use GitHub's private vulnerability reporting for this repository: **Security → Report a vulnerability**.

Include the smallest useful reproduction, the app version, operating-system version/architecture, and whether the Chrome extension was connected. Redact personal file contents, usernames/paths, conversation text and account/workspace identifiers. Never post live API keys, connector URLs, tunnel tokens or other credentials. Rotate anything accidentally exposed.

This is a solo-maintained beta. There is no bug bounty or guaranteed response window.

Security fixes target the current source tree. This fork has no published release channel and no updater, so there is no "latest published release" to compare against; report against the commit you built.

## Security model

Web GPT Agent is a permission boundary between ChatGPT and the logged-in OS user running the app:

- Filesystem tools validate paths against folders you explicitly approve.
- Read-only mode disables effective file writes, commands, desktop control and clipboard writes.
- `exec_command` is intentionally **not** confined to approved folders. It starts in an approved working directory, then runs with the normal privileges of your account.
- Screen/control permissions also enable the companion's background browser tools on Chromium hosts. Chrome grants the required debugger/tabs and HTTP(S) host permissions; there is no additional per-tab approval dialog. Read-only disables browser input, navigation, tab creation/closure and page JavaScript. Native screen, mouse/keyboard and clipboard use the app-bundled CUA runtime on supported Windows/macOS hosts, independent of approved folders but subject to the app's OS grants and live Desktop permissions. The Electron backend owns its child and private endpoint; an external CuaDriver binary, default socket or Plugins setting cannot replace that runtime.
- MCP servers bind to loopback and use secret tokenized paths. Public reachability comes only from the tunnel you configure. Invalid token, Host or Origin fails before any tool runs.
- The companion-extension bridge is a separate loopback service, stamped with this app's bridge identity, and it requires the installation id persisted in this app's own data directory. It exposes no filesystem, command or settings-mutation route. Its discovery ports (`8865–8869`) are deliberately different from the upstream project's, so two products on one machine cannot pair the wrong extension with the wrong host.
- Stored API/bridge credentials use Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, a secure desktop secret store on Linux). Linux `basic_text` is refused; normal Activity logs are redacted, capped and memory-only.
- Session recording is separate durable local history. It is on for fresh installs, has no age expiry by default, and is not encrypted by `safeStorage`.
- The local CLI control socket is an app-owned local endpoint discovered through `<data-dir>/runtime.json` (mode `0600`): a Unix socket, mode `0600`, inside a private `0700` directory on macOS and Linux, and a randomly named local named pipe on Windows. The CLI verifies the endpoint's owner, permissions and type on POSIX, refuses symlinked descriptors, requires a local `\\.\pipe\` name on Windows, and refuses a descriptor whose endpoint does not match the platform. Windows named pipes are created with a default descriptor that grants read access to Everyone and the anonymous account, so the host replaces it with a protected DACL naming only this user's SID and verifies the result before `runtime.json` is written; a host that cannot prove its pipe is private does not start.

## Per-action approvals are a choice, not a sandbox

This fork adds **no per-action confirmation** of its own. Once a capability is enabled, the app runs the call. The ChatGPT-side counterpart is a choice you make in ChatGPT: the setup instructions suggest **Allow all actions** for the connector so approval prompts cannot stall long-running work, and you can leave per-action approval on instead.

Either way, that choice is about prompts, not containment. There is no application-level sandbox around commands, external MCP servers or desktop control: if a capability is on, an action it permits runs as you, wherever your account can act. Do not treat approved roots, worktree isolation or a per-action setting as isolation from a hostile local process or from a mistaken instruction.

The socket and bridge boundaries are same-user boundaries. They stop other users and other apps' extensions; they do not stop a process already running as your account, which can read your data directory if it has the access to do so.

## Provider rules and responsible use

Local permissions control access to your machine; they do not authorize bypassing a provider's safety decision, usage limit or account restriction. Do not route a blocked action through another tool, worker, connector or account. Follow the [responsible-use notice](README.md#responsible-use-and-provider-rules) and the applicable provider terms.

Web GPT Agent is an independent beta used at your own risk. Its browser automation and local recording are not an OpenAI approval or a guarantee of compliance or continued account access. Review the security model and limitations on this page, supervise tool use and stop workflows that receive a provider restriction or policy warning. Account enforcement questions belong with the provider's support or appeal process; keep private notices and account identifiers out of public reports.

## Updating

There is no updater, no update check and no download path in this fork. A build cannot replace itself, and it never contacts the upstream project's release channel. Updating means rebuilding from source and replacing the bundle — a deliberate act you perform, followed by reloading the companion extension and refreshing the connector in ChatGPT. Any "install update" prompt claiming otherwise did not come from this app.

## Expected limitations

These are properties of the current design, not vulnerability reports by themselves:

- **Builds are not publisher-signed; macOS builds are also unnotarized.** Apple-silicon Mach-O files may carry ad-hoc signatures, which do not identify a publisher or establish Gatekeeper trust. Windows SmartScreen, macOS Gatekeeper or browsers can warn. Verify what you built.
- **The Linux AppImage has a sandbox-availability fallback.** Its electron-builder static launcher can add `--no-sandbox` when the host disables unprivileged user namespaces. On Debian/Ubuntu, prefer the DEB on such restrictive systems if you do not want the portable AppImage to take that fallback.
- **Fresh installs start Core permissions enabled and read-only mode off.** Windows additionally enables Desktop permissions; macOS starts them off, and Linux masks native desktop capabilities off at runtime while preserving stored choices. Existing installs keep their explicit stored choices.
- **Application path checks are not a kernel/VM sandbox.** They substantially constrain the app's filesystem tools, but same-user filesystem races can still exist. Do not treat approved roots as isolation from a hostile local process.
- **Command and Cua Driver Desktop capabilities are powerful by design.** If enabled, they can act wherever your logged-in user can act, subject to normal OS privilege boundaries.
- **The desktop-driver preset never widens the driver's own permissions.** It connects to a daemon you installed and authorized, over an explicit socket, and validates status-only permission checks (`prompt: false`). Granting macOS Accessibility or Screen Recording to that driver is a one-time action you perform; the app does not install, start, update or reconfigure it.
- **Session recording is intentionally detailed and is not encrypted by `safeStorage`.** Recorded conversations/tool activity stay local to this app, but anyone with access to your OS account may be able to read the session files.

## Scope

In scope: this repository's desktop app, MCP surfaces, local browser bridge, local CLI/control socket and `extension/` companion.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, `ripgrep`, third-party MCP servers and the Cua Driver application, and other third-party dependencies. Report upstream vulnerabilities to the relevant project as well.
