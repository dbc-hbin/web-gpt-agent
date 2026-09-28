export type PluginSurface = 'core' | 'desktop' | 'plugins';
/**
 * One declaration as the provider sees it.
 *
 * `title`, `annotations` and `outputSchema` are part of the published contract: they are
 * what ChatGPT's own tool list carries, and a change to any of them is a change to the
 * connector. They are optional because the provider's settings page does not expose them —
 * the browser can only ever read back name, description and input schema — so a declaration
 * read from the page simply has fewer fields than the one we published.
 */
export interface PluginToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
export interface PluginPublication {
  surface: PluginSurface;
  schemaId: string;
  connectorName: string;
  tools: PluginToolSchema[];
}
export interface PluginRefreshRequest extends PluginPublication {
  id: string;
  appId: string | null;
}
