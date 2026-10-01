import type { Tool } from '@modelcontextprotocol/client';
import { effectiveCapabilities, getConfig } from '../config.js';
import { desktopAutomationSupported } from '../platform.js';

export const CUA_SERVER_ID = 'cua-driver';
export const CUA_ALLOWED_TOOLS = [
  'list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree',
  'get_screen_size', 'get_desktop_state', 'get_cursor_position', 'get_agent_cursor_state', 'zoom',
  'check_permissions', 'verify_state', 'launch_app', 'set_window_frame',
  'invoke_menu', 'click', 'double_click', 'right_click', 'drag', 'type_text',
  'press_key', 'hotkey', 'set_value', 'scroll', 'clipboard_read', 'clipboard_write'
] as const;
export const CUA_DESKTOP_TOOLS = CUA_ALLOWED_TOOLS.filter(name => name !== 'zoom' && name !== 'invoke_menu');
export const CUA_READ_ONLY_TOOLS: readonly string[] = [
  'list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree',
  'get_screen_size', 'get_desktop_state', 'get_cursor_position', 'get_agent_cursor_state', 'zoom',
  'check_permissions', 'verify_state', 'clipboard_read'
];
export const CUA_OBSERVATION_TOOLS: readonly string[] = ['get_window_state', 'get_accessibility_tree', 'get_desktop_state'];
export const CUA_SNAPSHOT_BOUND_TOOLS: readonly string[] = [
  'click', 'double_click', 'right_click', 'drag', 'type_text', 'press_key',
  'hotkey', 'set_value', 'scroll'
];
export const CUA_MUTATING_TOOLS: readonly string[] = [
  ...CUA_SNAPSHOT_BOUND_TOOLS, 'launch_app', 'set_window_frame', 'invoke_menu', 'clipboard_write'
];
const RESERVED_ROUTING_FIELDS = ['_session_id', '_transport_session_id', 'session_id', 'transport_session_id'];
export const isCuaReadOnlyTool = (name: string): boolean => CUA_READ_ONLY_TOOLS.includes(name);
export const isCuaObservationTool = (name: string): boolean => CUA_OBSERVATION_TOOLS.includes(name);
export const isCuaSnapshotBoundTool = (name: string): boolean => CUA_SNAPSHOT_BOUND_TOOLS.includes(name);
export const isCuaMutatingTool = (name: string): boolean => CUA_MUTATING_TOOLS.includes(name);
export function cuaToolCapability(name: string): 'screen' | 'control' | 'clipboardRead' | 'clipboardWrite' {
  if (name === 'clipboard_read') return 'clipboardRead';
  if (name === 'clipboard_write') return 'clipboardWrite';
  return isCuaReadOnlyTool(name) ? 'screen' : 'control';
}

/** Live host permission, independent of the different Core/Desktop read-only rules. */
export function cuaCapabilityEnabled(name: string): boolean {
  return desktopAutomationSupported() && effectiveCapabilities(getConfig())[cuaToolCapability(name)];
}
export const cuaReservedRoutingField = (args: Record<string, unknown>): string | null =>
  RESERVED_ROUTING_FIELDS.find(field => field in args) ?? null;

/** Preserve upstream schemas/$refs while projecting host-owned permission and cursor routing. */
export function projectCuaCatalog(tools: readonly Tool[]): Tool[] {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return CUA_ALLOWED_TOOLS.flatMap(name => {
    const tool = byName.get(name);
    if (!tool) return [];
    const properties = tool.inputSchema.properties;
    if (name === 'get_agent_cursor_state' && properties && 'session' in properties) {
      const session = properties.session;
      return [{ ...tool, inputSchema: { ...tool.inputSchema,
        ...(tool.inputSchema.required ? { required: tool.inputSchema.required.filter(field => field !== 'session') } : {}),
        properties: { ...properties, session: {
          ...(session && typeof session === 'object' ? session : {}),
          description: 'Host-owned session: omit this field. Desktop binds the exact calling chat; Core binds the managed prime work.'
        } }
      } }];
    }
    if (name !== 'check_permissions') return [tool];
    if (!properties || !('prompt' in properties)) return [tool];
    return [{ ...tool, inputSchema: { ...tool.inputSchema, properties: {
      ...properties, prompt: { type: 'boolean', const: false, default: false,
        description: 'Status-only permission check; the host owns OS permission prompts.' }
    } } }];
  });
}
