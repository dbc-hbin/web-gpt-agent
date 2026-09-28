export interface DesktopDaemonStatus {
  running: boolean;
  connected: boolean;
  pid: number | null;
  dataDir: string;
}

export type DesktopDaemonReply<T> = { ok: true; data: T } | { ok: false; error: string };

/** GUI-local lifecycle controls for the persistent Electron host. */
export interface DesktopDaemonApi {
  status(): Promise<DesktopDaemonReply<DesktopDaemonStatus>>;
  start(): Promise<DesktopDaemonReply<DesktopDaemonStatus>>;
  stop(): Promise<DesktopDaemonReply<DesktopDaemonStatus>>;
}
