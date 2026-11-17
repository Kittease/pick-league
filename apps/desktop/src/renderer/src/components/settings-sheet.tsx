import { POSITIONS, type Position } from '@pick-league/shared';
import { Button } from '@pick-league/ui/components/ui/button';
import { Input } from '@pick-league/ui/components/ui/input';
import { Label } from '@pick-league/ui/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@pick-league/ui/components/ui/sheet';
import { Switch } from '@pick-league/ui/components/ui/switch';
import { ROLE_LABEL } from '@pick-league/ui/lib/format';
import { cn } from '@pick-league/ui/lib/utils';
import { SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppState, Settings } from '../../../core/app-state.ts';
import { FLASH_KEYS } from '../../../core/spells.ts';
import { ZOOM_LEVELS } from '../../../core/zoom.ts';
import { updateStatusText, useUpdateState } from '../hooks/use-update';

function update(patch: Partial<Settings>) {
  void window.pickleague.updateSettings(patch);
}

function Row({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border py-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{title}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  );
}

export function SettingsSheet({ state }: { state: AppState }) {
  const { settings } = state;
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  useEffect(() => setApiUrl(settings.apiUrl), [settings.apiUrl]);
  const urlValid = /^https?:\/\/\S+$/.test(apiUrl.trim());
  // Mounted with the header, so the "update ready" toast shows even with the sheet closed.
  const appUpdate = useUpdateState();

  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Settings" />}>
        <SettingsIcon />
      </SheetTrigger>
      <SheetContent className="w-[420px] sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Saved on this computer.</SheetDescription>
        </SheetHeader>
        {/* Scrolls under the fixed header when zoomed in or on a short window. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
          <div className="flex flex-col gap-2 border-b border-border py-4">
            <Label htmlFor="api-url">API address</Label>
            <p className="text-xs text-muted-foreground">
              PickLeague's servers by default; change it only to use your own API (e.g.{' '}
              <span className="num">http://localhost:3000</span> in development).
            </p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (urlValid) update({ apiUrl: apiUrl.trim() });
              }}
            >
              <Input
                id="api-url"
                className="num"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                aria-invalid={!urlValid}
                spellCheck={false}
              />
              <Button
                type="submit"
                variant="outline"
                disabled={!urlValid || apiUrl.trim() === settings.apiUrl}
              >
                Save
              </Button>
            </form>
          </div>

          <Row
            id="auto-apply"
            title="Apply runes and spells on lock-in"
            hint="Writes a “PickLeague” rune page and sets your summoner spells (Flash on the key chosen below). Never touches your other pages."
          >
            <Switch
              id="auto-apply"
              checked={settings.autoApply}
              onCheckedChange={(v) => update({ autoApply: v })}
            />
          </Row>

          <div className="flex items-start justify-between gap-6 border-b border-border py-4">
            <div className="flex flex-col gap-1">
              <Label>Flash key</Label>
              <p className="text-xs text-muted-foreground">
                Where Flash goes when spells are applied.
              </p>
            </div>
            <div className="flex gap-1">
              {FLASH_KEYS.map((k) => (
                <Button
                  key={k}
                  size="xs"
                  variant={settings.flashKey === k ? 'secondary' : 'ghost'}
                  className={cn('num', settings.flashKey === k && 'text-foreground')}
                  onClick={() => update({ flashKey: k })}
                >
                  {k}
                </Button>
              ))}
            </div>
          </div>

          <Row
            id="owned-only"
            title="Only champions I own"
            hint="Hide recommendations you can't pick (free rotation counts as owned)."
          >
            <Switch
              id="owned-only"
              checked={settings.ownedOnly}
              onCheckedChange={(v) => update({ ownedOnly: v })}
            />
          </Row>

          <div className="flex flex-col gap-2 border-b border-border py-4">
            <Label>Role when none is assigned</Label>
            <p className="text-xs text-muted-foreground">Blind pick and custom games.</p>
            <div className="flex gap-1">
              {POSITIONS.map((p: Position) => (
                <Button
                  key={p}
                  size="xs"
                  variant={settings.fallbackRole === p ? 'secondary' : 'ghost'}
                  className={cn(settings.fallbackRole === p && 'text-foreground')}
                  onClick={() => update({ fallbackRole: p })}
                >
                  {ROLE_LABEL[p]}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2 border-b border-border py-4">
            <Label>Zoom</Label>
            <p className="text-xs text-muted-foreground">
              Bigger text and icons on a large or distant screen. Also{' '}
              <span className="num">Ctrl +</span> / <span className="num">Ctrl −</span> /{' '}
              <span className="num">Ctrl 0</span>, or <span className="num">Ctrl</span> + mouse
              wheel.
            </p>
            <div className="flex flex-wrap gap-1">
              {ZOOM_LEVELS.map((z) => (
                <Button
                  key={z}
                  size="xs"
                  variant={settings.zoom === z ? 'secondary' : 'ghost'}
                  className={cn('num', settings.zoom === z && 'text-foreground')}
                  onClick={() => update({ zoom: z })}
                >
                  {Math.round(z * 100)}%
                </Button>
              ))}
            </div>
          </div>

          {appUpdate && (
            <div className="flex items-start justify-between gap-6 py-4">
              <div className="flex flex-col gap-1">
                <Label>
                  Version <span className="num">{appUpdate.currentVersion}</span>
                </Label>
                <p className="text-xs text-muted-foreground" title={appUpdate.message ?? undefined}>
                  {updateStatusText(appUpdate)}
                </p>
              </div>
              {appUpdate.status === 'ready' ? (
                <Button size="xs" onClick={() => window.pickleague.update.install()}>
                  Restart to update
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    appUpdate.status === 'disabled' ||
                    appUpdate.status === 'checking' ||
                    appUpdate.status === 'downloading'
                  }
                  onClick={() => window.pickleague.update.check()}
                >
                  Check now
                </Button>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
