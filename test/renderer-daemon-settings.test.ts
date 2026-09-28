import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopDaemonApi } from '../src/shared/desktop-daemon.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

it('does not let an older status response undo a completed daemon stop', async () => {
  const stale = Promise.withResolvers<{ ok: true; data: { running: boolean; connected: boolean; pid: number | null; dataDir: string } }>();
  const running = { ok: true as const, data: { running: true, connected: true, pid: 321, dataDir: '/daemon' } };
  const stopped = { ok: true as const, data: { running: false, connected: false, pid: null, dataDir: '/daemon' } };
  const api: DesktopDaemonApi = { status: vi.fn().mockResolvedValueOnce(running).mockReturnValueOnce(stale.promise),
    start: vi.fn().mockResolvedValue(running), stop: vi.fn().mockResolvedValue(stopped) };
  window.desktopDaemon = api;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { initDaemonSettings } = await import('../src/renderer/daemon-settings.js');
  initDaemonSettings();
  await Promise.resolve();
  window.dispatchEvent(new dom.window.Event('focus'));
  // The already queued click represents a Stop intent admitted before the status repaint.
  document.getElementById('daemonStop')!.dispatchEvent(new dom.window.Event('click'));
  await Promise.resolve();
  stale.resolve(running);
  await Promise.resolve();
  expect(document.getElementById('daemonRuntimeStatus')!.textContent).toBe('Daemon stopped');
  expect((document.getElementById('daemonStart') as HTMLButtonElement).disabled).toBe(false);
  expect((document.getElementById('daemonStop') as HTMLButtonElement).disabled).toBe(true);
});

it('leaves the daemon untouched when shutdown confirmation is cancelled', async () => {
  const running = { ok: true as const, data: { running: true, connected: true, pid: 321, dataDir: '/daemon' } };
  const stop = vi.fn();
  window.desktopDaemon = { status: vi.fn().mockResolvedValue(running), start: vi.fn(), stop };
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { initDaemonSettings } = await import('../src/renderer/daemon-settings.js');
  initDaemonSettings();
  await Promise.resolve();
  (document.getElementById('daemonStop') as HTMLButtonElement).click();
  expect(stop).not.toHaveBeenCalled();
  expect(document.getElementById('daemonRuntimeStatus')!.textContent).toContain('321');
});
