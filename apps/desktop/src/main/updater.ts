/**
 * Auto-update through electron-updater: checks GitHub Releases at startup and every few hours,
 * downloads in the background, installs on quit (or right away when the user asks).
 * Failures (offline, GitHub down, release without latest.yml) are logged and shown discreetly
 * in Settings, never thrown nor toasted. The app is unsigned: no publisherName is configured,
 * so electron-updater skips the Windows signature check.
 */

import type { UpdateState } from '../core/update.ts';

/** The part of electron-updater's `AppUpdater` used here (a fake in tests). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown;
  on(
    event: 'update-available' | 'update-downloaded',
    listener: (info: { version: string }) => void,
  ): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  /** Only the installed Windows app updates; otherwise the state stays `disabled`. */
  enabled: boolean;
  /** Created lazily, only when enabled. */
  createUpdater: () => UpdaterLike;
  log: (message: string) => void;
  /** First check after startup, so it does not compete with the app's own loading. */
  initialDelayMs?: number;
  intervalMs?: number;
}

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10_000;

export class UpdateService {
  private state: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private updater: UpdaterLike | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = {
      currentVersion: options.currentVersion,
      status: options.enabled ? 'idle' : 'disabled',
      version: null,
      progress: null,
      message: null,
    };
  }

  getState(): UpdateState {
    return this.state;
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts the periodic checks (no-op when disabled). */
  start(): void {
    if (!this.options.enabled) return;
    const interval = this.options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
    this.timers.push(
      setTimeout(() => this.check(), this.options.initialDelayMs ?? INITIAL_DELAY_MS),
      setInterval(() => this.check(), interval),
    );
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  check(): void {
    const { status } = this.state;
    if (status === 'disabled' || status === 'checking' || status === 'downloading') return;
    // Downloaded: nothing more to fetch, it installs on quit.
    if (status === 'ready') return;
    let updater: UpdaterLike;
    try {
      updater = this.getUpdater();
    } catch (error) {
      this.fail(error);
      return;
    }
    // Errors are normally emitted as 'error' events too: only handle the rejection if not.
    updater.checkForUpdates().catch((error: unknown) => {
      if (this.state.status !== 'error') this.fail(error);
    });
  }

  /** Quits and installs the downloaded update, then relaunches the app. */
  install(): void {
    if (this.state.status !== 'ready' || !this.updater) return;
    this.options.log(`update: restarting to install ${this.state.version}`);
    // Silent: the user already chose the install folder the first time; relaunch afterwards.
    this.updater.quitAndInstall(true, true);
  }

  private getUpdater(): UpdaterLike {
    if (this.updater) return this.updater;
    const updater = this.options.createUpdater();
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('checking-for-update', () => this.set({ status: 'checking', message: null }));
    updater.on('update-not-available', () =>
      this.set({ status: 'up_to_date', version: null, progress: null }),
    );
    updater.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version, progress: 0 }),
    );
    updater.on('download-progress', (progress) => {
      if (this.state.status === 'downloading') {
        this.set({ progress: Math.round(progress.percent) });
      }
    });
    updater.on('update-downloaded', (info) => {
      this.options.log(`update: ${info.version} downloaded, installs on quit`);
      this.set({ status: 'ready', version: info.version, progress: null, message: null });
    });
    updater.on('error', (error) => this.fail(error));
    this.updater = updater;
    return updater;
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.log(`update: ${message.split('\n')[0]}`);
    // A failed re-check must not hide an update that is already downloaded.
    if (this.state.status === 'ready') return;
    this.set({ status: 'error', progress: null, message: message.split('\n')[0] ?? message });
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
