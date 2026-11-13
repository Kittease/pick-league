import { POSITIONS, type Position } from '@pick-league/shared';
import { SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { ROLE_LABEL } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState, Settings } from '../../../core/app-state.ts';
import { ZOOM_LEVELS } from '../../../core/zoom.ts';

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
  const { settings, forced } = state;
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  useEffect(() => setApiUrl(settings.apiUrl), [settings.apiUrl]);
  const urlValid = /^https?:\/\/\S+$/.test(apiUrl.trim());

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
        <div className="flex flex-col px-4">
          <div className="flex flex-col gap-2 border-b border-border py-4">
            <Label htmlFor="api-url">API address</Label>
            <p className="text-xs text-muted-foreground">
              Where PickLeague runs: <span className="num">http://localhost:3000</span> on this
              computer, or <span className="num">http://&lt;vps-ip&gt;:3000</span> on a server.
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
            hint="Writes a “PickLeague” rune page and sets your summoner spells (Flash stays on your key). Never touches your other pages."
          >
            <Switch
              id="auto-apply"
              checked={settings.autoApply}
              onCheckedChange={(v) => update({ autoApply: v })}
            />
          </Row>

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

          <Row
            id="mock-lcu"
            title="Demo mode (fake League client)"
            hint={
              forced.mockLcu
                ? 'Forced on by PICKLEAGUE_MOCK_LCU=1.'
                : 'Replays a scripted champion select. For trying the app without League.'
            }
          >
            <Switch
              id="mock-lcu"
              checked={forced.mockLcu || settings.mockLcu}
              disabled={forced.mockLcu}
              onCheckedChange={(v) => update({ mockLcu: v })}
            />
          </Row>
        </div>
      </SheetContent>
    </Sheet>
  );
}
