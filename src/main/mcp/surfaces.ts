/**
 * The model-facing surfaces this app publishes, and what each one is for.
 *
 * ChatGPT connects to one MCP server per connector, and the *whole* of that server's
 * tool list is one discovery unit: `api_tool.list_resources(paths=["Name"])` with no
 * query returns every schema the server advertises. A query narrows it, but nothing
 * guarantees the harness will ask a narrow one, so the honest planning number for a
 * surface is its complete tools/list — not the subset a lucky query would return.
 *
 * That is the entire reason this file exists. Splitting into separate servers is the
 * only mechanism that actually bounds the worst case, because a separate server is a
 * separate discovery boundary that no query can cross.
 *
 * It is deliberately not a splitting free-for-all. Every extra surface is another
 * connector the user has to create, name, describe and keep connected, and on the
 * OpenAI tunnel it is another tunnel id as well (see `docs/tool-surface.md` §6.4).
 * A surface has to earn that. The test applied here is: a distinct capability boundary
 * the user already thinks in, plus enough schema weight that folding it into Core
 * would meaningfully raise Core's no-query cost.
 *
 * Three surfaces pass that test today, and every one of them is small on the wire. Each
 * publishes `exec`, `wait` and `tools_search`; Core also publishes restricted `exec_read`.
 * The real tool vocabulary lives in `capabilities`, is discovered per conversation through
 * `tools_search`, and is invoked as `tools["name"](args)` inside a code wrapper. That is what keeps
 * the no-query cost of a connector near-constant no matter how many tools it can do.
 *
 * `tools` is therefore the public wire list — what a no-query discovery pull actually
 * receives — and `capabilities` is the internal inventory of everything reachable through
 * those two entry points. Setup reads `tools` for "what you get" and `capabilities` only
 * for its own accounting; a capability is never advertised as a public tool.
 */

import type { Capabilities } from '../../shared/types.js';
import { desktopAutomationSupported } from '../platform.js';
import { CUA_DESKTOP_TOOLS } from '../cua/catalog.js';
import { BROWSER_TOOLS } from '../../shared/browser-control.js';

export const SURFACE_IDS = ['core', 'desktop', 'plugins'] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

/**
 * Brand shown to the user and pasted into ChatGPT.
 *
 * One constant because it appears in the MCP server name, the suggested connector
 * name and the setup cards, and those three drifting apart is how a user ends up with
 * a connector whose name does not match the thing the instructions told them to type.
 */
export const CONNECTOR_BRAND = 'Web GPT Agent';

export interface SurfaceDefinition {
  id: SurfaceId;
  /** MCP server name. Stable; ChatGPT keys its cached metadata off it. */
  serverName: string;
  /**
   * Exactly what the user should type as the connector name in ChatGPT.
   *
   * Offered as copyable text rather than described, because the name is also the
   * retrieval handle: `paths=["…"]` is matched against it, and a user who invents
   * "my pc" gets a surface the model cannot address by name.
   */
  connectorName: string;
  /**
   * Exactly what the user should paste as the connector description.
   *
   * This is the single most load-bearing string in the whole design. Before any
   * discovery has happened the model holds the server name and this sentence and
   * nothing else, and it decides from them alone whether to pull this surface's
   * schemas at all. So it is written as vocabulary, not as prose: the words a person
   * would actually use for the work live in here, because a query that misses is
   * indistinguishable to the model from a capability that does not exist.
   */
  description: string;
  /** Short line for the setup card, in the app's own voice. */
  cardSummary: string;
  /**
   * Whether the app is usable without it. Core is required; Desktop and Plugins are opt-in
   * and most sessions never want them.
   */
  required: boolean;
  /**
   * The complete public `tools/list` for this surface, in listing order.
   *
   * This is what the connector costs a no-query discovery pull, and it is the authority for
   * the published declaration, the setup UI's "what you get" list and the cross-surface
   * leakage assertions. A tool that appears here and nowhere else is a bug in one direction;
   * a public tool registered on a server that does not name it here is a bug in the other.
   */
  tools: readonly string[];
  /**
   * Everything else this connector can reach, as internal names behind `tools_search`/`exec`.
   *
   * Not public: no `tools/list` ever returns one of these, and `tools_search` reports them as
   * data so `tools["name"](args)` can call them. Kept here rather than in each registrar
   * because setup, diagnostics and the migration recognition in `plugin-refresh.ts` all need
   * one inventory that says what a connector *can* do, separately from what it advertises.
   */
  capabilities: readonly string[];
}

/**
 * Core — the coding loop.
 *
 * Core publishes a writable code wrapper and a restricted read wrapper:
 *
 *  - `exec` composes any of Core's internal tools in one bounded JavaScript call.
 *  - `exec_read` composes only the host-approved read tools in the same runtime.
 *  - `tools_search` is the discovery half — read-only metadata, no worker identity, no
 *    backend invocation — so a conversation can learn exact schemas before it scripts.
 *  - `agents` is one flat tool and is registered only while multi-agent mode is on.
 *    Fresh installs enable it; an existing config that keeps it off still pays nothing for
 *    it here. A dedicated connector for one conditional schema is pure setup overhead with
 *    no discovery benefit.
 *  - `session_finish` appears only when the user has enabled finish hold.
 *  - `work` is the no-DOM lifecycle control, registered directly on the Core server rather
 *    than through the coding registrar because it is deliberately *not* worker-attributed: a
 *    phone conversation that never proved a browser identity must still be able to start,
 *    list, inspect and stop work. That is an internal dispatch distinction, not a second
 *    connector.
 *
 * Everything in `capabilities` is reachable only from inside `exec`, and the lifecycle tools
 * are the opposite: `agents`, `work` and `session_finish` are called directly and refuse a
 * nested call, because a script cannot own a lifecycle decision.
 */
const CORE: SurfaceDefinition = {
  id: 'core',
  serverName: 'web-gpt-agent-core',
  // The plan's single unified connector name, exactly. Desktop and Plugins keep a suffix
  // because they are genuinely separate optional connectors; Core is *the* connector, so it
  // carries the brand itself and there is no legacy "Core"-suffixed alias to match.
  connectorName: CONNECTOR_BRAND,
  description:
    'Read and edit code and text files on this computer, and run commands in a real terminal. ' +
    'Use for: opening and reading files, searching a repository, applying patches, creating, renaming and deleting files, ' +
    'running builds, tests, linters, git, npm and shell commands, continuing long-running or interactive terminal sessions, ' +
    'and saving images and files ChatGPT generates onto this computer. ' +
    'Also displays task plans and — when the user has ' +
    'enabled it — spawns and coordinates worker agents, subagents or a parallel swarm across several ChatGPT conversations. ' +
    'Start, follow, instruct, pause, resume, cancel and inspect durable background work on this Mac from any conversation, ' +
    'including a phone. ' +
    'Also lists and calls tools from external MCP servers installed in the app.',
  cardSummary: 'Files, patches and the terminal, plus durable background work control from any conversation.',
  required: true,
  tools: ['exec', 'exec_read', 'wait', 'tools_search', 'agents', 'work', 'session_finish'],
  capabilities: [
    'read', 'view_image', 'find', 'apply_patch', 'exec_command', 'write_stdin',
    'update_plan', 'work_checkpoint', 'work_resume',
    'mcp_tools', 'mcp_call'
  ]
};

/**
 * Desktop — seeing and driving the native desktop.
 *
 * This one earns its boundary twice over. It is gated on permissions the user grants
 * separately and can switch off independently; native tools use the app-owned bundled CUA Driver
 * on supported hosts. The majority of coding sessions
 * never touch the desktop at all. Folding it into Core would put its weight into every
 * no-query discovery of the coding surface, for a capability most conversations do not
 * want.
 *
 * Its browser and native vocabulary is the largest internal inventory in the app, and it
 * is exactly the case the code-first split was built for: the wire cost stays at
 * three wrapper schemas whatever the connected driver can do.
 */
const DESKTOP: SurfaceDefinition = {
  id: 'desktop',
  serverName: 'web-gpt-agent-desktop',
  connectorName: `${CONNECTOR_BRAND} Desktop`,
  description:
    'Control browser tabs in the background and native apps through the app-owned bundled CUA Driver, including the clipboard. ' +
    'Attach existing Chrome/Edge/Brave tabs or open new tabs; inspect DOM refs, page screenshots, JavaScript, console errors and network requests; click, fill forms and navigate without foreground activation. ' +
    'Use for: listing and launching apps, taking background window screenshots, reading what is on screen, listing and finding windows, inspecting buttons, fields and other UI controls, ' +
    'clicking, typing, pressing keys, scrolling and dragging in native applications, ' +
    'and reading the clipboard or copying and pasting text between programs.',
  cardSummary:
    'Browser tabs, DOM, console, network and background screenshots; bundled CUA Driver native apps, input and clipboard.',
  required: false,
  tools: ['exec', 'wait', 'tools_search'],
  capabilities: [...BROWSER_TOOLS, ...CUA_DESKTOP_TOOLS]
};

/**
 * Plugins — the user's own external MCP servers.
 *
 * The internal inventory here is owned and bounded by the plugin manager, so it is
 * deliberately not enumerated: upstream names are data returned by `tools_search`, and a
 * name that collides with this connector's own wrappers is never allowed to shadow them.
 */
const PLUGINS: SurfaceDefinition = {
  id: 'plugins', serverName: 'web-gpt-agent-plugins',
  connectorName: `${CONNECTOR_BRAND} Plugins`,
  description: 'Tools from external MCP integrations installed and enabled in Web GPT Agent Settings, including Blender and other connected applications and services.',
  cardSummary: 'One shared connector for your enabled external MCP plugins.',
  required: false,
  tools: ['exec', 'wait', 'tools_search'],
  capabilities: []
};

export const SURFACES: Record<SurfaceId, SurfaceDefinition> = { core: CORE, desktop: DESKTOP, plugins: PLUGINS };

export const SURFACE_LIST: readonly SurfaceDefinition[] = [CORE, DESKTOP, PLUGINS];

export function surfaceDefinition(id: SurfaceId): SurfaceDefinition {
  return SURFACES[id];
}

/**
 * Whether a surface has anything to offer under these capabilities.
 *
 * Desktop with neither screen, control nor clipboard access would advertise only the two
 * wrappers and no usable backend, which is worse than not being offered: the user pays the
 * whole setup cost for a connector that can do nothing. The setup UI uses this to grey the
 * card out and say why.
 *
 * Core remains the required surface regardless. Keeping that identity stable is what lets
 * permissions be enabled again without changing connectors.
 */
export function surfaceIsUseful(
  id: SurfaceId,
  caps: Capabilities,
  platform: NodeJS.Platform = process.platform,
  release?: string
): boolean {
  // Clipboard counts: it is reached through the native driver, so granting only the clipboard
  // still gives this surface something real to advertise.
  if (id === 'desktop') {
    return (
      caps.screen || caps.control || (desktopAutomationSupported(platform, release) && (caps.clipboardRead || caps.clipboardWrite))
    );
  }
  return true;
}
