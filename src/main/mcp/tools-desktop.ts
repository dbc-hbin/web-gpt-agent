import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { getConfig } from '../config.js';
import { desktopAutomationSupported } from '../platform.js';
import { externalSchemaHash } from '../plugins/external-declaration.js';
import { ExternalNotDispatched } from '../plugins/manager.js';
import {
  CUA_DESKTOP_TOOLS, cuaCapabilityEnabled, cuaToolCapability, cuaReservedRoutingField, isCuaMutatingTool,
  isCuaObservationTool, isCuaReadOnlyTool, isCuaSnapshotBoundTool
} from '../cua/catalog.js';
import { embeddedCuaCatalog, invokeEmbeddedCua, validateEmbeddedCuaArguments } from '../cua/runtime.js';
import { requestCorrelation } from '../session/correlation.js';
import { getSession } from '../session/store.js';
import { isChatBlocked } from '../session/blocked-chats.js';
import { compactingConversation } from '../session/continuation.js';
import { dormantWorkerNotice, endedWorkerNotice, retiredWorkerForConversation } from '../agents.js';
import { noteOutcome, type CallContext } from './call-context.js';
import { dispatch, fail, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { registerBrowserTools } from './tools-browser.js';
import { markExternalOutcomeUnknown } from './tools-external.js';

/** Native declarations come from the app-owned driver, never a hand-written schema. */
const allowed = new Set<string>(CUA_DESKTOP_TOOLS);
const PATH_FIELDS = new Set(['screenshot_out_file', 'debug_image_out', 'image_path', 'file_path', 'urls', 'additional_arguments', 'webkit_inspector_port']);
const browserApp = /(?:chrome|chromium|edge|brave|firefox|safari|browser|\bArc\b|opera|vivaldi|chatgpt|web gpt agent)/i;
const SNAPSHOT_MS = 30_000;
interface Observation { generation: number; snapshotId: string | null; captureId: string | null; pid: number; windowId: number; appName: string; hasImage: boolean; hasTree: boolean; at: number; consumed: boolean }
const observations = new Map<string, Observation>();
const observationEpochs = new Map<string, symbol>();
const MAX_OBSERVATIONS = 128;

function enabled(name: string): boolean {
  return cuaCapabilityEnabled(name) && (!getConfig().readOnly || isCuaReadOnlyTool(name));
}

function nativeTools(): Array<{ tool: Tool; generation: number }> {
  const catalog = embeddedCuaCatalog();
  if (!catalog) return [];
  return catalog.tools.filter(tool => allowed.has(tool.name) && enabled(tool.name))
    .map(tool => ({ tool, generation: catalog.generation }));
}

export function desktopCuaCatalog(): PluginToolSchema[] {
  return nativeTools().map(({ tool }) => ({
    name: tool.name, ...(tool.title ? { title: tool.title } : {}),
    description: tool.description ?? '', inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: { readOnlyHint: isCuaReadOnlyTool(tool.name), destructiveHint: !isCuaReadOnlyTool(tool.name),
      idempotentHint: isCuaReadOnlyTool(tool.name), openWorldHint: true }
  }));
}

/** Browser control remains available even if native CUA is unavailable. */
export function registerDesktopTools(reg: SurfaceRegistrar): void {
  registerBrowserTools(reg);
}

interface NativePrincipal { key: string; session: string; sessionId: string; chat: string; epoch: number }

async function principal(parent: CallContext): Promise<NativePrincipal | null> {
  const exact = parent.caller.sessionId && parent.caller.conversationId
    ? parent.caller : parent.caller.requestId ? requestCorrelation(parent.caller.requestId) : null;
  if (!exact?.sessionId || !exact.conversationId) return null;
  try {
    const binding = await getSession(exact.sessionId);
    const epoch = binding?.bindingEpoch;
    const retiredAt = binding?.retiredChatAt?.[exact.conversationId];
    if (binding?.conversationId !== exact.conversationId || !Number.isSafeInteger(epoch) ||
        typeof epoch !== 'number' || epoch < 0 || typeof retiredAt === 'number' && parent.startedAt <= retiredAt) return null;
    const key = `${exact.sessionId}\0${exact.conversationId}\0${epoch}`;
    return { key, sessionId: exact.sessionId, chat: exact.conversationId, epoch,
      session: `wga-${createHash('sha256').update(key).digest('hex').slice(0, 24)}` };
  } catch { return null; }
}

async function active(parent: CallContext, name: string, owner: NativePrincipal): Promise<boolean> {
  if (!currentPolicy(name, owner.chat)) return false;
  try {
    const binding = await getSession(owner.sessionId);
    const retiredAt = binding?.retiredChatAt?.[owner.chat];
    return currentPolicy(name, owner.chat) && binding?.conversationId === owner.chat && binding.bindingEpoch === owner.epoch &&
      !(typeof retiredAt === 'number' && parent.startedAt <= retiredAt);
  } catch { return false; }
}

function currentPolicy(name: string, chat: string): boolean {
  return enabled(name) && !isChatBlocked(chat) && !compactingConversation(chat) &&
    !dormantWorkerNotice(chat) && !endedWorkerNotice(chat) && !retiredWorkerForConversation(chat);
}

function invalidFields(args: Record<string, unknown>): string | null {
  const reserved = cuaReservedRoutingField(args);
  if (reserved) return `CUA_RESERVED_FIELD: ${reserved} is owned by the host.`;
  if ('session' in args) return 'CUA_SESSION_OWNED: session is bound to the exact calling chat, not model input.';
  for (const field of PATH_FIELDS) if (field in args)
    return `CUA_FILE_PATH_DENIED: ${field} cannot bypass approved file roots through the native driver.`;
  const target = args.target;
  if (target !== undefined && target !== null) {
    if (typeof target !== 'object' || Array.isArray(target)) return 'CUA_TARGET_INVALID: target must be a native target object.';
    for (const field of Object.keys(target))
      if (!['kind', 'pid', 'window_id', 'display_id'].includes(field)) return `CUA_TARGET_INVALID: unexpected target field ${field}.`;
  }
  return null;
}

function targetWindow(args: Record<string, unknown>, observation?: Observation): { pid: number; windowId: number } | null {
  const target = args.target;
  if (target && typeof target === 'object' && !Array.isArray(target) && 'kind' in target && target.kind !== 'window') return null;
  const nested = target && typeof target === 'object' && !Array.isArray(target) ? target : null;
  const pid = args.pid ?? (nested && 'pid' in nested ? nested.pid : undefined);
  const explicitWindowId = args.window_id ?? (nested && 'window_id' in nested ? nested.window_id : undefined);
  // A current token carries its exact window; never infer a pixel or focused-input target.
  const windowId = explicitWindowId ?? (observation?.snapshotId && observation.hasTree && pid === observation.pid &&
    typeof args.element_token === 'string' && args.element_token.split(':', 1)[0] === observation.snapshotId
    ? observation.windowId : undefined);
  if (args.scope === 'desktop' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 ||
      typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId <= 0) return null;
  if (nested && ('pid' in nested && nested.pid !== pid || 'window_id' in nested && nested.window_id !== windowId)) return null;
  return { pid, windowId };
}

function snapshotRefusal(tool: Tool, args: Record<string, unknown>, observation: Observation | undefined, generation: number): string | null {
  const name = tool.name;
  // Screen-absolute input and implicit focused-element input can hit a protected browser chat.
  const target = targetWindow(args, observation);
  if (!target) return 'CUA_EXACT_WINDOW_REQUIRED: name an observed pid and window_id; desktop/frontmost input is unavailable.';
  if (!observation || observation.generation !== generation ||
      observation.consumed || Date.now() - observation.at > SNAPSHOT_MS || observation.pid !== target.pid || observation.windowId !== target.windowId)
    return 'CUA_SNAPSHOT_STALE: observe this exact window again before input. No action was dispatched.';
  if (browserApp.test(observation.appName))
    return 'CUA_PROTECTED_BROWSER: native input into browser windows is refused; use the browser tools for tabs.';
  if (isCuaSnapshotBoundTool(name)) {
    if (['click', 'double_click', 'right_click', 'type_text'].includes(name) &&
        !('element_token' in args || 'x' in args && 'y' in args))
      return 'CUA_EXACT_ELEMENT_REQUIRED: address an observed element or screenshot pixel in this window. No action was dispatched.';
    const pixel = 'x' in args || 'y' in args || 'from_x' in args || 'from_y' in args ||
      'to_x' in args || 'to_y' in args || args.from_zoom === true;
    if (pixel && !observation.hasImage)
      return 'CUA_SCREENSHOT_REQUIRED: pixel input requires a screenshot of this exact window. No action was dispatched.';
    if ('element_token' in args && (!observation.snapshotId || !observation.hasTree))
      return 'CUA_TREE_REQUIRED: element input requires an accessibility snapshot of this exact window. No action was dispatched.';
    const token = args.element_token;
    if (typeof token === 'string' && token.split(':', 1)[0] !== observation.snapshotId)
      return 'CUA_SNAPSHOT_MISMATCH: the action names a different snapshot. No action was dispatched.';
    if (args.capture_id !== undefined && args.capture_id !== observation.captureId)
      return 'CUA_CAPTURE_MISMATCH: use the capture_id returned by this exact window observation. No action was dispatched.';
    if (pixel && 'capture_id' in (tool.inputSchema.properties ?? {}) &&
        (!observation.captureId || args.capture_id !== observation.captureId))
      return 'CUA_CAPTURE_REQUIRED: pass capture_id from this exact window observation. No action was dispatched.';
    // Other pixel/keyboard tools bind to this session's current exact-window read.
    // Do not invent snapshot_id or capture_id arguments absent from their declarations.
  }
  return null;
}

function refused(reason: string): ToolResult {
  noteOutcome('tool_rejected');
  return fail(`${reason} This call was not dispatched.`);
}

/** The nested call keeps the upstream MCP envelope, including image blocks and structuredContent. */
export async function invokeDesktopCua(name: string, value: unknown, parent: CallContext): Promise<ToolResult> {
  return dispatch(name, value, parent.caller.transportKey, parent.caller.requestId, 'desktop', async () => {
    if (!desktopAutomationSupported()) return refused('CUA_PLATFORM_UNSUPPORTED: native Desktop requires supported macOS or Windows; browser tools remain available.');
    const catalog = embeddedCuaCatalog();
    if (!catalog) return refused('CUA_DRIVER_UNAVAILABLE: the app-owned bundled CUA Driver is not ready.');
    if (!allowed.has(name) || !catalog.tools.some(tool => tool.name === name)) return refused(`CUA_TOOL_DISABLED: ${name} is not declared by the bundled driver.`);
    if (!enabled(name)) return refused(`TOOL_DISABLED: ${name} requires live ${cuaToolCapability(name)} permission and writable mode for input.`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return refused('INVALID_ARGUMENTS: native tools accept one argument object.');
    const args = value as Record<string, unknown>;
    const fields = invalidFields(args);
    if (fields) return refused(fields);
    const owner = await principal(parent);
    if (!owner || !(await active(parent, name, owner)))
      return refused('CUA_IDENTITY_REQUIRED: an exact, current local session and calling chat are required.');
    const tool = catalog.tools.find(candidate => candidate.name === name);
    if (!tool) return refused(`CUA_TOOL_UNAVAILABLE: ${name} is not in the current catalog.`);
    const validation = validateEmbeddedCuaArguments(tool, args);
    if (!validation.ok) return refused(`CUA_INVALID_ARGUMENTS: ${validation.detail}`);
    if (name === 'launch_app' && (typeof args.name === 'string' && browserApp.test(args.name) ||
        typeof args.bundle_id === 'string' && /(?:chrome|chromium|safari|firefox|edge|brave|browser|chatgpt|webgpt)/i.test(args.bundle_id)))
      return refused('CUA_PROTECTED_BROWSER: browser and app chat launches are unavailable through native tools.');
    if (name === 'launch_app' && ('path' in args || 'launch_path' in args || 'aumid' in args))
      return refused('CUA_LAUNCH_SELECTOR_DENIED: launch by name or bundle_id only; paths, argument-bearing launch_path and Windows app ids are unavailable.');
    if (args.delivery_mode === 'foreground') return refused('CUA_FOREGROUND_DENIED: native foreground escalation is not approved.');
    const navigationKey = /^(?:w|t|n|q|tab|space|`|pageup|pagedown)$/i;
    if (name === 'hotkey' && Array.isArray(args.keys) && args.keys.some(key => typeof key === 'string' && navigationKey.test(key)))
      return refused('CUA_BROWSER_CHORD_DENIED: system, tab, window and app switching chords are unavailable through native input.');
    if (name === 'press_key' && Array.isArray(args.modifiers) && args.modifiers.length && typeof args.key === 'string' && navigationKey.test(args.key))
      return refused('CUA_BROWSER_CHORD_DENIED: system, tab, window and app switching chords are unavailable through native input.');
    const observation = observations.get(owner.key);
    if (isCuaMutatingTool(name) && name !== 'clipboard_write' && name !== 'launch_app') {
      const stale = snapshotRefusal(tool, args, observation, catalog.generation);
      if (stale) return refused(stale);
      observation!.consumed = true; // reserve before async dispatch; ambiguous outcomes cannot replay it
    }
    if (name === 'launch_app') observations.delete(owner.key);
    if (name === 'get_window_state' && !targetWindow(args))
      return refused('CUA_EXACT_WINDOW_REQUIRED: observe with exact pid and window_id.');
    const observationEpoch = isCuaObservationTool(name) ? Symbol() : null;
    if (observationEpoch) {
      observations.delete(owner.key); // any new snapshot invalidates old tokens
      observationEpochs.delete(owner.key);
      observationEpochs.set(owner.key, observationEpoch);
      if (observationEpochs.size > MAX_OBSERVATIONS) observationEpochs.delete(observationEpochs.keys().next().value!);
    }
    // Bind the driver lifecycle session to the proven caller, never to a value from JavaScript.
    const properties = tool.inputSchema.properties;
    const wireArgs = properties && typeof properties === 'object' && 'session' in properties
      ? { ...args, session: owner.session } : args;
    if (!(await active(parent, name, owner))) return refused('CUA_IDENTITY_LOST: the calling chat is no longer current.');
    try {
      const result = await invokeEmbeddedCua(name, wireArgs,
        { schemaHash: externalSchemaHash(tool), generation: catalog.generation },
        () => active(parent, name, owner)) as ToolResult;
      if (!(await active(parent, name, owner))) {
        observations.delete(owner.key);
        const reason = isCuaReadOnlyTool(name)
          ? 'CUA_AUTHORITY_CHANGED: this observation was withheld because its caller or permission changed; it grants no snapshot or action authority.'
          : 'CUA_AUTHORITY_CHANGED: the caller or permission changed after dispatch. An effect may have occurred; inspect current state before another action. No action was replayed.';
        return isCuaReadOnlyTool(name) ? fail(reason) : markExternalOutcomeUnknown(fail(reason));
      }
      if (result.isError) noteOutcome('tool_execution_error');
      if (name === 'launch_app' && result.structuredContent?.self_activation_suppressed === false)
        return { ...result, content: [...result.content, { type: 'text', text: 'CUA_FOREGROUND_CHANGED: the driver reports the launched app held foreground focus despite its background launch attempt.' }] };
      if (!result.isError && isCuaObservationTool(name)) {
        const data = result.structuredContent;
        const target = targetWindow(args);
        const snapshotId = typeof data?.snapshot_id === 'string' && data.snapshot_id.trim().length > 0 ? data.snapshot_id : null;
        const captureId = typeof data?.capture_id === 'string' && data.capture_id.trim().length > 0 ? data.capture_id : null;
        const hasImage = result.content.some(part => part.type === 'image');
        if (name === 'get_window_state' && target && data && (snapshotId || captureId && hasImage) &&
            data.pid === target.pid && data.window_id === target.windowId && typeof data.app_name === 'string' && data.app_name.trim().length > 0 &&
            embeddedCuaCatalog()?.generation === catalog.generation && observationEpochs.get(owner.key) === observationEpoch) {
          observations.delete(owner.key);
          observations.set(owner.key, { generation: catalog.generation,
            snapshotId, captureId,
            pid: target.pid, windowId: target.windowId,
            appName: data.app_name, hasImage,
            hasTree: snapshotId !== null && args.include_accessibility_tree !== false, at: Date.now(), consumed: false });
          if (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value!);
        }
      }
      return result;
    } catch (error) {
      if (error instanceof ExternalNotDispatched) return refused(error.message);
      noteOutcome('tool_execution_error');
      return markExternalOutcomeUnknown(fail('CUA_OUTCOME_UNKNOWN: driver call failed after dispatch; inspect state before retrying. No action was replayed.'));
    }
  }, parent);
}
