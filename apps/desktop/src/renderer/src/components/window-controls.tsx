import { CopyIcon, MinusIcon, SquareIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { WindowState } from '../../../core/app-state.ts';

/** Native-like window state, pushed by the main process (frameless window only). */
export function useWindowState(): WindowState | null {
  const [state, setState] = useState<WindowState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = window.pickleague.window.onState(setState);
    void window.pickleague.window.getState().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

function ControlButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid h-full w-11 place-items-center text-muted-foreground transition-colors outline-none focus-visible:bg-muted focus-visible:text-foreground [&_svg]:size-3.5',
        danger ? 'hover:bg-[#c42b1c] hover:text-white' : 'hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Minimize / maximize-restore / close, at the right end of the header (Windows/Linux). */
export function WindowControls({ maximized }: { maximized: boolean }) {
  const w = window.pickleague.window;
  return (
    <div className="flex h-full shrink-0 items-stretch border-l border-border">
      <ControlButton label="Minimize" onClick={w.minimize}>
        <MinusIcon />
      </ControlButton>
      <ControlButton label={maximized ? 'Restore' : 'Maximize'} onClick={w.toggleMaximize}>
        {maximized ? <CopyIcon className="-scale-x-100" /> : <SquareIcon className="size-3!" />}
      </ControlButton>
      <ControlButton label="Close" onClick={w.close} danger>
        <XIcon />
      </ControlButton>
    </div>
  );
}
