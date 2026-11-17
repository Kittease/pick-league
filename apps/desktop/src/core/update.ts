/** Auto-update state, owned by the main process (electron-updater) and shown in Settings. */

export interface UpdateState {
  /** Version of the running app. */
  currentVersion: string;
  /**
   * `disabled`: not the installed Windows app (dev, macOS, Linux), nothing is checked.
   * `ready`: `version` is downloaded; it installs on quit, or now with "Restart to update".
   */
  status: 'disabled' | 'idle' | 'checking' | 'downloading' | 'up_to_date' | 'ready' | 'error';
  /** The newer version being downloaded or ready to install. */
  version: string | null;
  /** Download progress in percent while `downloading`. */
  progress: number | null;
  /** Last error (network failure, missing release files...), shown discreetly. */
  message: string | null;
}

export const UPDATE_IPC = {
  state: 'update:state',
  getState: 'update:get-state',
  check: 'update:check',
  install: 'update:install',
} as const;

/** `window.pickleague.update` in the renderer. */
export interface UpdateBridge {
  getState(): Promise<UpdateState>;
  /** Check now (no-op when disabled, already checking/downloading or ready). */
  check(): void;
  /** Quit and install the downloaded update, then relaunch (no-op unless `ready`). */
  install(): void;
  onState(listener: (state: UpdateState) => void): () => void;
}
