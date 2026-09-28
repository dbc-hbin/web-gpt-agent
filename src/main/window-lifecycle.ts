/** Minimal app-event shape kept separate so macOS activation behavior is unit-testable. */
export interface ActivateEventSource {
  on(event: 'activate', listener: () => void): unknown;
}

/** Only the process that owns Electron's single-instance lock owns app runtime state/teardown. */
export function ownsAppRuntime(hasSingleInstanceLock: boolean): boolean {
  return hasSingleInstanceLock;
}

/**
 * Whether this process is allowed to touch the shared userData bootstrap at all.
 *
 * A losing single-instance process still evaluates this module and its `whenReady()` callback
 * can race `app.quit()`. Likewise the primary can receive an OS/application quit before ready.
 * Both are terminal: config/secrets/session/durable initialization belongs only to the live lock
 * owner, never to a process already leaving.
 */
export function shouldBeginAppBootstrap(hasSingleInstanceLock: boolean, quitting: boolean): boolean {
  return ownsAppRuntime(hasSingleInstanceLock) && !quitting;
}

/**
 * `second-instance` is only guaranteed to happen after Electron's `ready` event. Our own startup
 * continues well past that while config/durable state is restored and, critically, before the
 * renderer CSP/permission handlers and IPC surface are installed. Keep an early re-launch from
 * constructing a BrowserWindow across that gap. The normal startup path opens the initial window
 * once the gate is enabled, so dropping an earlier focus request loses nothing; later requests
 * focus/recreate the window immediately.
 */
export function createWindowActivationGate(showWindow: () => void): {
  request: () => void;
  enable: () => void;
  disable: () => void;
  isDisabled: () => boolean;
} {
  let enabled = false;
  // Shutdown is a terminal lifetime boundary, not a temporary pause. A startup continuation
  // can resume after `before-quit` because the main bootstrap contains several awaits; letting
  // that stale continuation call enable() again would reopen native activation during teardown.
  let disabled = false;
  return {
    request: () => {
      if (enabled && !disabled) showWindow();
    },
    enable: () => {
      if (!disabled) enabled = true;
    },
    disable: () => {
      disabled = true;
      enabled = false;
    },
    isDisabled: () => disabled
  };
}

/** A windowless host may receive an explicit relaunch before its GUI control socket exists. */
export function createBackendActivationGate(openClient: () => void): {
  request: (argv?: readonly string[]) => void;
  enable: () => void;
  disable: () => void;
} {
  let ready = false;
  let pending = false;
  let disabled = false;
  return {
    request: argv => {
      if (disabled || argv?.includes('--background') || argv?.includes('--daemon-host')) return;
      if (ready) openClient();
      else pending = true;
    },
    enable: () => {
      if (disabled) return;
      ready = true;
      if (pending) {
        pending = false;
        openClient();
      }
    },
    disable: () => {
      disabled = true;
      pending = false;
    }
  };
}

/**
 * Closing the last ordinary window is not an application quit on macOS. The app stays in the
 * Dock/menu bar until the user explicitly quits (Cmd+Q / application menu / tray menu), and a
 * later `activate` recreates the window. Windows/Linux retain the existing preference semantics:
 * when close-to-tray is off, closing the last window exits the app.
 */
export function shouldQuitOnWindowAllClosed(
  platform: NodeJS.Platform,
  minimizeToTray: boolean
): boolean {
  return platform !== 'darwin' && !minimizeToTray;
}

/**
 * macOS users return to a hidden app through the Dock, which Electron reports as `activate`.
 * Windows/Linux use the tray/second-instance paths and should not gain a synthetic handler.
 */
export function registerNativeWindowActivation(
  source: ActivateEventSource,
  showWindow: () => void,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'darwin') source.on('activate', showWindow);
}

/**
 * Login launch is distinct from tunnel auto-connect and ordinary app activation.
 *
 * `--background` is what makes this a *host* launch rather than a window launch: the app
 * starts its storage, control socket and MCP endpoint without opening the main window, so a
 * machine that was restarted is once again reachable for remote work without anyone touching
 * it. It is passed as an argument on Windows and Linux and simply present in `argv` on macOS,
 * where the OS supplies the command line.
 */
export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes('--background');
}

/**
 * Whether this platform and build may register a login item at all.
 *
 * macOS registers through `SMAppService`, which exists only for a real app bundle; an
 * unpackaged `electron-vite dev` run has no bundle to register and would silently register
 * the Electron binary instead. Windows writes a per-user Run entry. Linux is left out
 * deliberately: there is no single supported API for it, and a half-working autostart entry
 * on a platform this build does not ship for is worse than no checkbox.
 */
export function supportsLoginStartup(platform: NodeJS.Platform, packaged: boolean): boolean {
  return packaged && (platform === 'win32' || platform === 'darwin');
}

/**
 * Adds or removes this app's login item.
 *
 * The two platforms take genuinely different arguments, and passing the wrong ones is not a
 * no-op:
 * - **Windows** needs an explicit `path` and `args`, because it writes the command line
 *   itself. The same pair must be supplied to turn the entry *off*, or the Run key it looks
 *   for is a different one than the key it wrote.
 * - **macOS** derives everything from the bundle through `SMAppService`. `path` and `args`
 *   are Windows-only fields there, and Electron ignores them — so supplying them would look
 *   like it worked while the arguments were never delivered. `openAtLogin` alone is the
 *   whole request, and the OS is what decides whether a login item may run with arguments.
 */
export function applyLoginStartup(
  app: {
    isPackaged: boolean;
    setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[] }): void;
  },
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
  executable = process.execPath
): void {
  if (!supportsLoginStartup(platform, app.isPackaged)) return;
  if (platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args: ['--background'] });
}
