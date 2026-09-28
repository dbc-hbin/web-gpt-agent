# External MCP plugins

Settings → Plugins manages external MCP integrations. Core and Desktop keep their existing
connectors, permissions and tool registration. Plugins uses a third, separately tokenized
endpoint and the shared **Web GPT Agent Plugins** connector.

The [responsible-use notice](../README.md#responsible-use-and-provider-rules) applies to plugins too. Each external service retains its own terms, permissions and usage limits. Installing or enabling a plugin does not authorize routing a provider-blocked action through it or bypassing an account restriction.

## Setup

1. Open Plugins and choose **Set up plugins** in the prominent connection card.
   With OpenAI Secure Tunnels, create a separate Plugins tunnel, enter its ID in
   the dialog, and choose **Save & connect**. The existing API key and tunnel executable are reused.
   Cloudflare/manual transports publish the Plugins endpoint at its separate path.
2. Create the **Web GPT Agent Plugins** connector in ChatGPT using the displayed name,
   description and MCP URL. Keep the Web GPT Agent connection running.
3. Open Settings → Plugins and click **+**. Choose a reviewed catalog recipe or a custom server. Review
   installation instructions and supply credentials in the secure fields.
4. A plugin becomes **Ready** only after connection and discovery succeed. Blender also
   requires its addon to answer a read-only scene probe. Local readiness does not prove
   that ChatGPT has enrolled the connector or refreshed its tools.
5. Refresh the **Web GPT Agent Plugins** connector once when upgrading from direct tools to
   code mode, or enable automatic connector refresh. Its public catalog is now always
   `exec`, `wait` and `tools_search`. Find exact upstream schemas with `tools_search`, then invoke
   them as `await tools["name"](args)` inside `exec`.

Upstream enablement and schema changes are read live by `tools_search` and child dispatch,
not cached as public connector declarations. Disabled tools refuse stale calls immediately.
Automatic refresh compares the public wrapper declarations, while recognizing older installed
direct-tool catalogs for migration. Name, description and input schema are the fields visible
in the provider’s installed-tool UI; richer publication metadata is hashed locally too.

## Supported sources

- Pinned npm and Python recipes: Blender MCP, Knowledge Memory, Playwright Browser, Web Fetch and Unity Editor.
  Node.js/npm or Python/uv must be installed where the recipe requires them. Web GPT Agent installs
  packages into private per-plugin directories and does not install missing system runtimes.
  On Windows, the standard per-user uv directory (`%USERPROFILE%\.local\bin`) is also
  searched, so installing uv there does not require restarting an already-running Web GPT Agent.
  For custom runtime locations, add the directory to PATH and restart the app.
- An executable with explicit arguments (no shell interpolation).
- Remote Streamable HTTP MCP URLs, with HTTPS or loopback HTTP. Credentials use encrypted
  storage; do not embed them in URLs or arguments. HeyGen and Recraft use explicit browser OAuth
  authorization. Their hosted services have separate provider terms and account requirements.
- Local MCPB bundles using the upstream manifest parser and configuration expansion.
  Unsupported runtime/manifest setup reports an error rather than inventing a launch command.
- GitHub URLs that match reviewed recipes. Other repositories need an MCPB release or explicit
  package/executable configuration; a repository URL alone is not executable MCP configuration.

Blender needs the community addon installed and enabled in Blender, with its MCP server started
from the viewport sidebar. The catalog includes the upstream addon installation steps. Blender
is a third-party integration, not an official Blender feature supplied by Web GPT Agent.

## Embedded CUA native desktop engine

Native desktop control is app infrastructure, not a Plugins installation. The Electron
backend starts bundled **CUA Driver 0.29.1** as its own child with a private endpoint and
stops it during backend shutdown. It never searches PATH, a CuaDriver.app installation or
the external driver's default socket. The former Cua Driver preset is removed.

- **No separate install or daemon setup.** On macOS grant Accessibility and Screen Recording
  to **Web GPT Agent**. Workspace's explicit permission request can open OS consent;
  **Recheck Desktop permissions** restarts the embedded runtime to observe changed grants.
  Agent calls never request consent or escalate the driver's permission mode.
- **One runtime, two existing routes.** Core retains managed `mcp_tools` / `mcp_call` under
  the reserved `cua-driver` server identity. Desktop publishes native upstream schemas
  inside `exec` / `wait`, alongside independent browser-tab tools. Neither route registers
  a Plugins record or needs an external socket. The plain Node host has no embedded engine.
- **Reviewed allowlist.** Only a host-owned subset of the driver's tools is agent-visible;
  administration, history access, update/configuration, policy escalation, session
  administration, trajectory replay, cursor theming, the legacy `page` surface and the
  Windows-only `debug_window_info` stay out. Unsupported tools are unavailable — there is no
  fake fallback. `check_permissions` is validated as status-only (`prompt: false`); prompting is
  a setup action outside agent work.
- **One work at a time.** Git worktrees isolate a checkout, not a desktop, so exactly one
  managed work holds the desktop lease. Another work gets `CUA_BUSY` while coding-only work
  continues. The lease constrains this app's own agents, not you or other driver clients.
- **Fresh observations.** Snapshot-bound actions must name an observation the work made, and a
  runtime replacement invalidates prior snapshots and element tokens. The app refuses a stale
  target instead of translating it, and never replays an ambiguous action.

These calls run as your user, with the app's live capability checks and OS grants.

## Authority and lifetime

`src/main/plugins/manager.ts` owns installed records, enabled policy, connections, credentials
references and tool routing. `src/main/plugins/installer.ts` owns isolated package installation
and bounded archive extraction. The manager stores metadata through `durable.ts`, credentials
through `secrets.ts`, and preserves upstream package license files in installation directories.

External processes run with the current user's operating-system permissions. There is no
approved-folder sandbox to inherit: like `exec_command`, an external plugin server can reach
anything your account can. Web GPT Agent read-only mode refuses external plugin calls because
annotations cannot prove that an external process is unable to mutate. Tool annotations are
otherwise relayed without making them more permissive.

The Plugins surface returns complete input/output JSON schemas and metadata on demand.
The manager retains a bounded backend catalog of 256 tools and 250 KB of schemas, while public
`tools/list` contains only those three wrappers. `tools_search` pages are bounded to 64 KiB and
never truncate an individual schema. Upstream names are preserved, including an upstream
`exec` callable as `tools.exec`; conflicting upstream declarations remain excluded rather than renamed.
The installed tool list distinguishes enabled tools from those admitted within the catalog limit.
Child results retain structured data and resources inside JavaScript; explicitly choose what to
emit with `text(...)` or `image(...)`. Every child uses existing request attribution, live
read-only enforcement, credential redaction and recording. Never emit image base64 as text.
Transport failures never automatically retry tool calls. A failed mutation can already have
taken effect; inspect its state before deciding to retry.

Fresh installs contain no plugins. Installed and enabled plugins keep their connection for the app's lifetime, until disabled or uninstalled. App startup restores those connections in the background without waiting for external server discovery before showing chats. Cached tool declarations remain available during startup; every call rechecks current enabled policy.

Restart reconnects/discovers a server. Configure changes its settings and write-only credentials.
Update stages a replacement and requires a successful connection before committing it; failure
restores the prior installation. Package versions stay pinned to reviewed recipes; custom version
changes use Configure. Uninstall stops the process and removes installation data and credentials.
Knowledge Memory retains its data across updates in a stable per-plugin data directory.

## Legal notices

Web GPT Agent remains MIT licensed, as does the Chat On Steroids project it was forked from.
Settings provides the bundled Third-party Notices, generated from
production npm dependencies by `scripts/generate-third-party-notices.mjs`. Platform binary
notices remain alongside their binaries. See [catalog artwork attribution](plugin-licenses.md).
External plugin licenses are shown per installation and remain separate from the app's own license.
Reviewed labels apply only to the exact catalog distribution. Knowledge Memory's reviewed
MIT/Apache transition supersedes its incomplete manifest label; a custom version must supply
its own license information. `npm run verify:notices` checks installed production versions,
license material and catalog notice hashes on every CI platform without rewriting the local
notice file. Packaging regenerates the notices for its installed dependencies.

Notice completeness is not binary-release clearance. Exact corresponding-source and
replacement obligations for LGPL/MPL native dependencies remain a separate release check;
see [the audit](plugin-notice-audit.md).

## Validation

The plugin suites cover archive path and expansion limits, installation, subprocess discovery,
schema/result preservation, credential redaction, durable disabled state, rollback, and routing
through the real loopback MCP endpoint. `COS_PLUGIN_LIVE_TEST=1` enables an opt-in network test
of the pinned upstream Memory server. See [the notice and validation audit](plugin-notice-audit.md).
