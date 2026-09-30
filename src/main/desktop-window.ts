import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, session, Tray } from 'electron';
import type { AppState, ConnectionStatus } from '../shared/types.js';
import { UI_BASE_ZOOM, titleBarOverlayForTheme, windowBackgroundForTheme, windowLayoutForWorkArea } from './window-layout.js';
import { browserWindowIconPath } from './window-icon.js';
import { editContextMenuTemplate } from './edit-context-menu.js';
import { trayGuidArgsForPlatform, trayImageSpec } from './tray-image.js';
import { logError, logInfo } from './logger.js';

/** The GUI-only presentation contract. Backend state arrives only through `AppState`. */
export interface DesktopWindowOptions {
  /** Frozen from `state:get` before the first BrowserWindow is made; null is a truthful
   * unavailable-backend presentation, not a fabricated persisted state. */
  initialState: AppState | null;
  /** The local preload belongs to the GUI process, never the persistent backend. */
  preloadPath: string;
  /** Production renderer document. Ignored when `rendererUrl` is supplied. */
  rendererPath: string;
  rendererUrl?: string;
  /** Fixed, allowlisted request to the authenticated backend proxy. */
  invoke(channel: 'connection:connect' | 'connection:disconnect', payload?: undefined): Promise<unknown>;
  /** GUI-only quit. It must never stop the persistent backend. */
  quitGui(): void;
  /** Runs after the local renderer document has completed loading. */
  rendererReady?(): void;
  /** Replaces the view-owned backend lease before the next document can invoke IPC. */
  rendererStarting?(): void;
  /** Retires view-owned resources without stopping the persistent backend. */
  rendererClosed?(): void;
  /** Projects client window visibility to the authenticated backend; it owns no window there. */
  onVisibilityChange?(visible: boolean): void;
}

export interface DesktopWindowHandle {
  /** The live GUI window for client-owned sender and native window operations, if any. */
  getWindow(): BrowserWindow | null;
  /** Shows/recreates the one GUI window. First presentation alone maximizes it. */
  show(): void;
  /** Applies a newly received remote state without consulting a backend store locally. */
  update(state: AppState): void;
  /** Delivers one backend event to the current renderer, if it is alive. */
  send(channel: string, args: unknown[]): void;
  /** Registers native activation and close-to-tray behavior after Electron is ready. */
  bindLifecycle(): void;
  /** Releases tray presentation without affecting the backend. */
  dispose(): void;
}

/** Build the native tray image from encoded PNGs, never platform-dependent bitmap bytes. */
function trayImage(running: boolean): Electron.NativeImage {
  const spec = trayImageSpec(process.platform, running);
  const [base, ...highDpi] = spec.representations;
  const image = nativeImage.createFromBuffer(base.png, { scaleFactor: base.scaleFactor });
  for (const representation of highDpi) {
    image.addRepresentation({
      scaleFactor: representation.scaleFactor,
      dataURL: `data:image/png;base64,${representation.png.toString('base64')}`
    });
  }
  if (spec.template) image.setTemplateImage(true);
  return image;
}

function statusLabel(status: ConnectionStatus): string {
  switch (status.state) {
    case 'connected': return 'Connected';
    case 'offline': return 'No internet';
    case 'disconnected': return 'Not connected';
    default: return 'Connecting';
  }
}

/**
 * Owns all native GUI presentation for the client process. It deliberately imports no config,
 * session, secret or work store: every presentation decision is based on the last backend state.
 */
export function createDesktopWindow(options: DesktopWindowOptions): DesktopWindowHandle {
  let state = options.initialState;
  let window: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let presented = false;
  let sessionSecurityInstalled = false;

  const installSessionSecurity = (): void => {
    if (sessionSecurityInstalled) return;
    sessionSecurityInstalled = true;
    // This is the client profile's session, not the backend's. The renderer is local-only and
    // needs no browser permission, so no remote page can inherit privileged Electron access.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
          ]
        }
      });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  };

  const refreshTray = (): void => {
    if (!tray) return;
    const label = state ? statusLabel(state.status) : 'Backend unavailable';
    const connected = state?.status.state === 'connected' || state?.status.state === 'offline';
    tray.setImage(trayImage(connected));
    tray.setToolTip(`Web GPT Agent — ${label.toLowerCase()}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: () => show() },
      {
        label: connected ? 'Disconnect' : 'Connect',
        click: () => void options.invoke(connected ? 'connection:disconnect' : 'connection:connect')
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; options.quitGui(); } }
    ]));
  };

  const create = (): BrowserWindow => {
    installSessionSecurity();
    const layout = windowLayoutForWorkArea(screen.getPrimaryDisplay().workArea);
    const icon = browserWindowIconPath(process.platform, app.isPackaged, process.resourcesPath);
    const next = new BrowserWindow({
      ...layout,
      ...(icon ? { icon } : {}),
      fullscreenable: process.platform === 'darwin',
      show: false,
      autoHideMenuBar: true,
      ...(process.platform === 'win32' ? {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: state
          ? titleBarOverlayForTheme(state.config.ui.theme, state.config.ui.appearance)
          : titleBarOverlayForTheme('dark')
      } : {}),
      backgroundColor: state
        ? windowBackgroundForTheme(state.config.ui.theme, state.config.ui.appearance)
        : windowBackgroundForTheme('dark'),
      title: 'Web GPT Agent',
      webPreferences: {
        zoomFactor: UI_BASE_ZOOM,
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        webSecurity: true
      }
    });
    if (process.platform === 'win32') next.removeMenu();
    next.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat) return;
      event.preventDefault();
      next.setFullScreen(!next.isFullScreen());
    });
    next.webContents.on('context-menu', (_event, params) => {
      const template = editContextMenuTemplate(params);
      if (template.length) Menu.buildFromTemplate(template).popup({ window: next });
    });
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    next.webContents.on('will-navigate', event => event.preventDefault());
    next.webContents.on('will-redirect', event => event.preventDefault());
    next.webContents.on('will-attach-webview', event => event.preventDefault());
    next.on('close', event => {
      if (!quitting && state?.config.ui.minimizeToTray === true) {
        event.preventDefault();
        next.hide();
      }
    });
    next.on('show', () => options.onVisibilityChange?.(true));
    next.on('hide', () => options.onVisibilityChange?.(false));
    next.on('closed', () => {
      if (window === next) window = null;
      options.onVisibilityChange?.(false);
    });
    next.webContents.on('did-start-loading', () => {
      if (window === next) options.rendererStarting?.();
    });
    next.webContents.on('destroyed', () => options.rendererClosed?.());
    next.webContents.on('render-process-gone', () => options.rendererClosed?.());
    next.webContents.on('did-finish-load', () => {
      // Native package smokes read this from the launched GUI process under CLF_DEBUG.
      logInfo('window loaded');
      if (window === next && !next.isDestroyed()) options.rendererReady?.();
    });
    // A renderer that fails to load leaves a blank window with no other clue.
    next.webContents.on('did-fail-load', (_event, code, description) =>
      logError(`window failed to load (${code}): ${description}`));
    // Only renderer error text, never page data.
    next.webContents.on('console-message', details => {
      if (details.level === 'error') logError(`renderer: ${details.message}`);
    });
    next.once('ready-to-show', () => {
      if (!presented) {
        presented = true;
        if (!next.isFullScreen()) next.maximize();
      }
      if (!quitting) next.show();
    });
    window = next;
    if (options.rendererUrl) void next.loadURL(options.rendererUrl); else void next.loadFile(options.rendererPath);
    return next;
  };

  const show = (): void => {
    if (quitting) return;
    if (!window) {
      // The first window stays hidden until ready-to-show applies its frozen appearance.
      create();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  return {
    getWindow: () => window,
    show,
    update: (next) => {
      state = next;
      nativeTheme.themeSource = next.config.ui.theme;
      if (window && !window.isDestroyed()) {
        window.setBackgroundColor(windowBackgroundForTheme(next.config.ui.theme, next.config.ui.appearance));
        if (process.platform === 'win32') window.setTitleBarOverlay(titleBarOverlayForTheme(next.config.ui.theme, next.config.ui.appearance));
      }
      refreshTray();
    },
    send: (channel, args) => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, ...args);
    },
    bindLifecycle: () => {
      installSessionSecurity();
      nativeTheme.themeSource = state?.config.ui.theme ?? 'dark';
      tray = new Tray(trayImage(false), ...trayGuidArgsForPlatform());
      tray.on('click', show);
      refreshTray();
      if (process.platform === 'darwin') app.on('activate', show);
      app.on('window-all-closed', () => {
        if (process.platform !== 'darwin' && state?.config.ui.minimizeToTray !== true) options.quitGui();
      });
    },
    dispose: () => {
      quitting = true;
      tray?.destroy();
      tray = null;
      window?.destroy();
      window = null;
    }
  };
}
