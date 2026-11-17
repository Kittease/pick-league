import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { UpdateState } from '../../../core/update.ts';

/** Auto-update state from the main process; toasts once when an update is ready. */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = window.pickleague.update.onState((s) => setState(s));
    void window.pickleague.update.getState().then((s) => {
      if (alive) setState((prev) => prev ?? s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const toasted = useRef<string | null>(null);
  const readyVersion = state?.status === 'ready' ? state.version : null;
  useEffect(() => {
    if (!readyVersion || toasted.current === readyVersion) return;
    toasted.current = readyVersion;
    toast.info(`Update ${readyVersion} ready`, {
      description: 'It installs when you quit PickLeague.',
      duration: 15_000,
      action: { label: 'Restart', onClick: () => window.pickleague.update.install() },
    });
  }, [readyVersion]);

  return state;
}

export function updateStatusText(state: UpdateState): string {
  switch (state.status) {
    case 'disabled':
      return 'Automatic updates only run in the installed Windows app.';
    case 'idle':
      return 'Updates are checked automatically.';
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return `Downloading ${state.version ?? 'update'}${state.progress != null ? ` (${state.progress}%)` : ''}…`;
    case 'up_to_date':
      return 'Up to date.';
    case 'ready':
      return `Version ${state.version} is ready: it installs when you quit, or restart now.`;
    case 'error':
      return 'Could not check for updates; will try again later.';
  }
}
