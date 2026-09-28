import { app, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { WorkspaceTerminals } from './workspace-terminal.js';

type Register = <T>(channel: string, fn: (payload: unknown) => Promise<T>) => void;
type Push = (channel: string, args: unknown[]) => void;

/**
 * Registers the single terminal authority. In a persistent backend it sends output over the
 * GUI event port; in the legacy in-process host it additionally targets the live window.
 */
export function registerWorkspaceTerminalIpc(
  getWindow: () => BrowserWindow | null,
  register: Register,
  remotePush?: Push
): () => void {
  let terminals: WorkspaceTerminals | null = null;
  const dispose = (): void => { terminals?.dispose(); terminals = null; };
  app.on('before-quit', dispose);
  const request = z.discriminatedUnion('action', [
    z.object({ action: z.literal('create'), id: z.string().uuid(), projectId: z.string().uuid(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).strict(),
    z.object({ action: z.literal('write'), id: z.string().uuid(), data: z.string().max(65_536) }).strict(),
    z.object({ action: z.literal('resize'), id: z.string().uuid(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).strict(),
    z.object({ action: z.literal('ack'), id: z.string().uuid(), count: z.number().int().min(0).max(65_536) }).strict(),
    z.object({ action: z.literal('close'), id: z.string().uuid() }).strict()
  ]);

  register('workspaceTerminal:request', async payload => {
    const args = request.parse(payload);
    if (!terminals) {
      terminals = new WorkspaceTerminals(value => {
        remotePush?.('workspaceTerminal:event', [value]);
        const target = getWindow();
        if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send('workspaceTerminal:event', value);
      });
    }
    const service = terminals;
    return args.action === 'create' ? service.create(args.id, args.projectId, args.cols, args.rows)
      : args.action === 'write' ? service.write(args.id, args.data)
      : args.action === 'resize' ? service.resize(args.id, args.cols, args.rows)
      : args.action === 'ack' ? service.acknowledge(args.id, args.count) : service.close(args.id);
  });
  return dispose;
}
