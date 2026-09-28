import { $ } from './dom.js';
import { t, ui } from './i18n.js';
import type { DesktopDaemonApi } from '../shared/desktop-daemon.js';

declare global {
  interface Window { desktopDaemon?: DesktopDaemonApi }
}

export function initDaemonSettings(): void {
  const section = document.getElementById('daemonSettings');
  if (!window.desktopDaemon || !section) return;
  const api = window.desktopDaemon;
  section.hidden = false;
  const status = $('daemonRuntimeStatus');
  const directory = $('daemonDataDirectory');
  const error = $('daemonRuntimeError');
  const start = $<HTMLButtonElement>('daemonStart');
  const stop = $<HTMLButtonElement>('daemonStop');
  const refresh = $<HTMLButtonElement>('daemonRefresh');
  let generation = 0;
  let mutating = false;
  let running = false;
  let connected = false;
  let pid: number | null = null;
  ui(status, 'textContent', () => running
    ? connected ? t('Daemon connected · PID {0}', [pid ?? '—']) : t('Daemon running · GUI disconnected')
    : t('Daemon stopped'));

  async function update(action: 'status' | 'start' | 'stop'): Promise<void> {
    if (mutating) return;
    if (action === 'stop' && !window.confirm(t('Stop the daemon? Local tools and tunnels will stop. Closing the GUI instead keeps them running.'))) return;
    const request = ++generation;
    mutating = action !== 'status';
    start.disabled = stop.disabled = refresh.disabled = true;
    error.hidden = true;
    status.textContent = action === 'status' ? t('Checking daemon…') : action === 'start' ? t('Starting daemon…') : t('Stopping daemon…');
    try {
      const result = await api[action]();
      if (request !== generation) return;
      if (!result.ok) throw new Error(result.error);
      running = result.data.running;
      connected = result.data.connected;
      pid = result.data.pid;
      directory.textContent = result.data.dataDir;
      status.textContent = running
        ? connected ? t('Daemon connected · PID {0}', [pid ?? '—']) : t('Daemon running · GUI disconnected')
        : t('Daemon stopped');
    } catch (failure) {
      if (request !== generation) return;
      status.textContent = t('Daemon status unavailable');
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
    } finally {
      if (request === generation) {
        mutating = false;
        start.disabled = running && connected;
        stop.disabled = !running;
        refresh.disabled = false;
      }
    }
  }
  start.addEventListener('click', () => { void update('start'); });
  stop.addEventListener('click', () => { void update('stop'); });
  refresh.addEventListener('click', () => { void update('status'); });
  window.addEventListener('focus', () => { void update('status'); });
  void update('status');
}
