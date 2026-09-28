import { describe, expect, it, vi } from 'vitest';
import {
  applyLoginStartup,
  supportsLoginStartup,
  createBackendActivationGate,
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  shouldBeginAppBootstrap,
  shouldQuitOnWindowAllClosed
} from '../src/main/window-lifecycle.js';

describe('native window activation', () => {
  it('holds an early explicit host relaunch until GUI control is ready, then refuses teardown resurrection', () => {
    const open = vi.fn();
    const background = createBackendActivationGate(open);
    background.request(['app', '--background']);
    background.request(['app', '--daemon-host']);
    background.enable();
    expect(open).not.toHaveBeenCalled();

    const gate = createBackendActivationGate(open);
    gate.request(['app']);
    gate.request(['app']);
    expect(open).not.toHaveBeenCalled();
    gate.enable();
    expect(open).toHaveBeenCalledTimes(1);
    gate.request(['app', '--background']);
    gate.request(['app', '--daemon-host']);
    expect(open).toHaveBeenCalledTimes(1);
    gate.request();
    expect(open).toHaveBeenCalledTimes(2);
    gate.disable();
    gate.request();
    gate.enable();
    expect(open).toHaveBeenCalledTimes(2);

    const shuttingDown = createBackendActivationGate(open);
    shuttingDown.request();
    shuttingDown.disable();
    shuttingDown.enable();
    expect(open).toHaveBeenCalledTimes(2);
  });
  it('never bootstraps shared state from a secondary or already-quitting process', () => {
    expect(ownsAppRuntime(true)).toBe(true);
    expect(ownsAppRuntime(false)).toBe(false);
    expect(shouldBeginAppBootstrap(true, false)).toBe(true);
    expect(shouldBeginAppBootstrap(false, false)).toBe(false);
    expect(shouldBeginAppBootstrap(false, true)).toBe(false);
    expect(shouldBeginAppBootstrap(true, true)).toBe(false);
  });

  it('drops second-instance focus requests until renderer security and IPC startup are ready', () => {
    const show = vi.fn();
    const gate = createWindowActivationGate(show);

    // Electron can emit second-instance after its `ready` event while our async startup is still
    // restoring state. The initial startup path will show a window itself, so this early request
    // must not create one before CSP/permission/IPC setup is complete.
    gate.request();
    expect(show).not.toHaveBeenCalled();

    gate.enable();
    expect(show).not.toHaveBeenCalled();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // `before-quit` closes the gate again while bounded teardown drains. Native activation or a
    // second launch in that window must not resurrect application UI during shutdown.
    gate.disable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // Startup is async. A continuation that resumes after `before-quit` can still execute its
    // old enable() call; shutdown must be a one-way boundary so that stale continuation cannot
    // reactivate Dock/second-instance/tray presentation.
    expect(gate.isDisabled()).toBe(true);
    gate.enable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('reopens the app from the macOS Dock activation event', () => {
    const listeners = new Map<string, () => void>();
    const source = { on: vi.fn((event: 'activate', listener: () => void) => listeners.set(event, listener)) };
    const show = vi.fn();
    registerNativeWindowActivation(source, show, 'darwin');

    expect(source.on).toHaveBeenCalledWith('activate', show);
    listeners.get('activate')!();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each(['win32', 'linux'] as const)('does not add a foreign activation contract on %s', (platform) => {
    const source = { on: vi.fn() };
    registerNativeWindowActivation(source, vi.fn(), platform);
    expect(source.on).not.toHaveBeenCalled();
  });

  it('keeps a macOS app alive after its last window closes, regardless of close-to-tray preference', () => {
    expect(shouldQuitOnWindowAllClosed('darwin', true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed('darwin', false)).toBe(false);
  });

  it.each(['win32', 'linux'] as const)('keeps close-to-tray semantics on %s', (platform) => {
    expect(shouldQuitOnWindowAllClosed(platform, true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed(platform, false)).toBe(true);
  });
});

describe('login startup', () => {
  it('writes packaged Windows login settings with the background argument, and can turn them off', () => {
    const app = { isPackaged: true, setLoginItemSettings: vi.fn() };
    applyLoginStartup(app, true, 'win32', 'C:/Program Files/Web GPT Agent/app.exe');
    applyLoginStartup(app, false, 'win32', 'C:/Program Files/Web GPT Agent/app.exe');
    expect(app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true, path: 'C:/Program Files/Web GPT Agent/app.exe', args: ['--background'] }],
      [{ openAtLogin: false, path: 'C:/Program Files/Web GPT Agent/app.exe', args: ['--background'] }]
    ]);
  });

  /**
   * macOS registers through SMAppService, which derives the whole command line from the
   * bundle. `path` and `args` are Windows-only fields there and Electron ignores them, so
   * passing them would look like it worked while the `--background` argument was never
   * delivered — a login item that opens the window instead of starting the host.
   */
  it('registers a packaged macOS login item without Windows-only arguments', () => {
    const app = { isPackaged: true, setLoginItemSettings: vi.fn() };
    applyLoginStartup(app, true, 'darwin');
    applyLoginStartup(app, false, 'darwin');
    expect(app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true }],
      [{ openAtLogin: false }]
    ]);
  });

  it('registers nothing for an unpackaged build or an unsupported platform', () => {
    const app = { isPackaged: true, setLoginItemSettings: vi.fn() };
    applyLoginStartup(app, true, 'linux');
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(supportsLoginStartup('linux', true)).toBe(false);
    app.isPackaged = false;
    applyLoginStartup(app, true, 'win32');
    applyLoginStartup(app, true, 'darwin');
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(supportsLoginStartup('win32', false)).toBe(false);
    expect(supportsLoginStartup('darwin', false)).toBe(false);
    expect(supportsLoginStartup('win32', true)).toBe(true);
    expect(supportsLoginStartup('darwin', true)).toBe(true);
  });
  ;
});
