<h1 align="center">Web GPT Agent</h1>

<p align="center"><strong>High-performance local coding and system automation runtime driven by ChatGPT Web over MCP.</strong></p>

<p align="center">
  <a href="#core-overhaul--differences-from-upstream">What's New</a> &nbsp;·&nbsp;
  <a href="#runtime-and-tool-architecture">Architecture</a> &nbsp;·&nbsp;
  <a href="#cli-guide-wgpt">CLI Guide</a> &nbsp;·&nbsp;
  <a href="#build-and-quickstart">Quickstart</a> &nbsp;·&nbsp;
  <a href="#disclaimer">Disclaimer</a> &nbsp;·&nbsp;
  <a href="LICENSE">License</a>
</p>

<br />

## Overview

**Web GPT Agent** connects your everyday **ChatGPT Web conversation** directly to your local development environment without API billing. It enables ChatGPT to read and edit local files, execute terminal commands, coordinate multi-worker subagents, and control desktop browsers and native windows through a secure, permissioned local runtime over the Model Context Protocol (MCP).

ChatGPT Web handles model inference and account availability, while the local Web GPT Agent runtime (Core, Desktop, Plugins) safely bridges your filesystem, shell, and applications.

---

## Core Overhaul & Differences from Upstream

Web GPT Agent is an extensive architectural overhaul of [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids). It eliminates context-window pollution, removes heavy GUI dependencies, embeds native drivers, and isolates background work:

### 1. Tool Code Mode (QuickJS Sandbox Composition)
- **Eliminated Context Pollution**: Instead of advertising dozens of individual tool schemas (`read`, `apply_patch`, `exec_command`, etc.) that waste thousands of prompt tokens per turn, tools are encapsulated into four meta-tools: **`exec_read`**, **`exec`**, **`wait`**, and **`tools_search`**.
- **Programmatic Composition**: The model writes concise JavaScript executed within an isolated QuickJS sandbox to batch, filter, and extract file or search data in a single round-trip:
  ```js
  // Example inside exec_read: read multiple files and return only relevant excerpts
  const app = await tools.read({ paths: ["/workspace/src/main.ts"] });
  const config = await tools.read({ paths: ["/workspace/src/config.ts"] });
  text(`App: ${app.length} bytes, Config: ${config.length} bytes`);
  ```
- **Context Window Protection**: Multi-megabyte command outputs or file reads stay inside the sandbox. Only explicit output helpers (`text(...)`, `image(...)`) emit data back to the model context.
- **Async Yield & Wait**: Long-running operations (>10s) yield execution into background cells and collect results asynchronously via `wait`, preventing gateway timeouts.

### 2. Embedded CUA Driver & Cursor Isolation
- **Self-Contained Native Runtime**: Removed external CuaDriver app and daemon installation dependencies. CUA Driver 0.29.1 is bundled directly into the application process as an embedded native runtime.
- **Zero-Disruption Browser Control (Background Chrome CDP)**:
  - Tab control (`browser_snapshot`, `browser_click`, DOM queries) runs via the companion extension through Chrome's background debugger.
  - **Never steals your OS cursor or window focus**: browse, inspect, and automate pages entirely in the background while continuing normal desktop work.
- **Separated OS Native Control (CUA)**:
  - Full-screen capture, OS window management, and native mouse/keyboard automation are strictly isolated behind explicit macOS Screen Recording and Accessibility permissions.

### 3. Headless Node.js MCP Daemon (`wgpt daemon`)
- **GUI-Independent Runtime**: Runs as a lightweight, headless plain-Node.js daemon without requiring an open Electron window or desktop profile.
- **Shared SQLite Work Ledger**: Serves identical Core, Desktop, and Plugins MCP endpoints alongside the durable state ledger (`work.sqlite`).
- **Mobile & Background Continuity**: Tasks continue running on the Mac even after closing windows. Work can be inspected, steered, paused, or resumed via the local CLI (`wgpt work`) or from a mobile device through the synced ChatGPT conversation thread.

### 4. Isolated Git Worktrees for Multi-Agent
- **Workspace Protection**: The main agent and worker subagents do not edit your working tree directly. Each modifying task receives an isolated Git worktree (`wgpt/<work_id>/...`).
- **Collision-Free Collaboration**: Parallel worker edits never clobber your working copy or unstaged changes. Verified results are committed to an integration branch before final merge.

### 5. Native Localization
- Full in-app localization for Korean (한국어), English, Spanish, Japanese, and Chinese across all settings, setup guides, and recovery interfaces.

---

## Runtime and Tool Architecture

Web GPT Agent publishes three logical MCP connector surfaces. For standard coding and agent workflows, **Core** is the only connector required:

```text
                  ChatGPT Web (Model / Browser)
                                │
                       [MCP via Public Tunnel]
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                      Web GPT Agent                          │
│          (Electron Backend  OR  wgpt daemon)                │
├──────────────────────────────┬──────────────────────────────┤
│ Core (`...-core`)            │ Desktop (`...-desktop`)       │
│  - exec_read, exec           │  - Browser Tab Tools (CDP)   │
│  - wait, tools_search        │  - Embedded CUA Driver       │
│  - work (durable management) │    (Native Screen & Input)   │
│  - agents (multi-worker)     │                              │
├──────────────────────────────┴──────────────────────────────┤
│ Plugins (`...-plugins`): External MCP Servers Proxy          │
└─────────────────────────────────────────────────────────────┘
```

| Connector | MCP Server ID | Advertised Operations | Description |
|---|---|---|---|
| **Web GPT Agent** | `web-gpt-agent-core` | `exec_read`, `exec`, `wait`, `tools_search`, `work`, `agents` | File reads/patches, shell execution, plan updates, worktree coordination |
| **Web GPT Agent Desktop** | `web-gpt-agent-desktop` | `exec`, `wait`, `tools_search` | Background browser tab control + embedded CUA OS automation (optional) |
| **Web GPT Agent Plugins** | `web-gpt-agent-plugins` | `exec`, `wait`, `tools_search` | Upstream local/remote MCP server integration (optional) |

---

## CLI Guide (`wgpt`)

Manage backends and durable tasks from the terminal using the bundled `wgpt` executable:

For the agent workflow and receipt interpretation, see the [wgpt CLI-to-web skill](.agents/skills/wgpt-cli-web/SKILL.md).

The public `bin/wgpt.mjs` launcher discovers the app executable only when `WGPT_APP_EXECUTABLE` is unset or empty. A nonempty override selects that exact path or command on `PATH`; an unusable override fails instead of launching a different app.

### 1. Host & Daemon Control
```sh
# Electron desktop backend (serves GUI and local workspace)
wgpt host start
wgpt host status

# Headless Node.js daemon (no GUI, minimal resource usage)
wgpt daemon start --data-dir /path/to/data
wgpt daemon status --data-dir /path/to/data
wgpt daemon stop --data-dir /path/to/data
```

The daemon requires an explicit data directory; managed browser delivery also requires a connected browser path (`daemon start --browser` opts into its browser transport). `host` exposes `start` and `status`, not `stop`. A work receipt records admission, not confirmed ChatGPT delivery.

### 2. Work Management
```sh
# Start a durable task in an isolated Git worktree
wgpt work start --project /path/to/repo --goal "Fix failing build and add unit tests"

# Check active and completed tasks
wgpt work list
wgpt work status <work_id>

# Steer or send follow-up instructions to running work
wgpt work instruct <work_id> --text "Also update documentation"

# Pause, resume, and stream live events
wgpt work pause <work_id>
wgpt work resume <work_id>
wgpt work events <work_id> --follow
```

---

## Build and Quickstart

### Prerequisites
- **Node.js**: 22 or newer
- **OS**: macOS 13 Ventura+ (Apple Silicon verified), Windows 10/11, or desktop Linux
- **Browser**: Chromium-based (Chrome, Edge, Brave)

### Build from Source
```sh
# 1. Install dependencies and fetch pinned native binaries
npm ci
npm run rg          # fetch pinned ripgrep
npm run tunnel      # fetch pinned tunnel client

# 2. Compile Electron app, CLI, and Node daemon
npm run build

# 3. Package macOS arm64 unpacked application
npm run dist:dir:mac:arm64
```
The application will be located at `release/mac-arm64/Web GPT Agent.app`.

### Setup Sequence
1. **Launch App & Approve Folder**:
   - Open `Web GPT Agent.app`. In **Settings → Workspace**, add the project folder(s) ChatGPT is permitted to access.
2. **Connect Tunnel**:
   - In **Settings → Setup**, configure an OpenAI Platform Tunnel or Cloudflare Quick Tunnel and click **Connect**.
3. **Add MCP Connector in ChatGPT**:
   - In ChatGPT Settings → Enable **Developer mode** → **Plugins / Custom Apps** → Add **Tunnel** app:
     - Name: `Web GPT Agent`
     - URL: The endpoint URL displayed on your setup card.
     - Set permissions to **Allow all actions**.
4. **Load Companion Extension**:
   - Click **Open extension folder** in the app.
   - In Chrome (`chrome://extensions`), turn on **Developer mode**, click **Load unpacked**, and select the extension folder. (Pairing is automatic).
5. **Start Working**:
   - Open ChatGPT Web, select your model, and send tasks.

---

## Disclaimer

- **Independent Project**: Web GPT Agent is an independent open-source project and is not affiliated with, endorsed by, or sponsored by OpenAI. ChatGPT and Codex are trademarks of OpenAI.
- **Provider Policy Compliance**: This software interacts with ChatGPT Web via MCP and browser automation. Users are responsible for complying with OpenAI's Terms of Use and applicable policies. Do not use this tool to circumvent rate limits or security controls.
- **User Responsibility**: The software is provided "AS IS" under the MIT License without warranty. Users bear sole responsibility for supervising all local filesystem modifications, shell commands, and automated actions executed on their host machine.

---

## License

This project is licensed under the [MIT License](LICENSE).
- Copyright (c) 2026 Web GPT Agent contributors
- Copyright (c) 2026 Chat On Steroids contributors
