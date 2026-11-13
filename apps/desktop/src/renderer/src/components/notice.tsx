import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function Notice({
  tone,
  title,
  message,
  action,
  className,
}: {
  tone: 'warn' | 'bad';
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}) {
  const Icon = tone === 'warn' ? TriangleAlertIcon : CircleAlertIcon;
  return (
    <Alert
      className={cn(
        'm-3 w-auto border',
        tone === 'warn' ? 'border-gold/40 text-gold' : 'border-down/40 text-down',
        className,
      )}
    >
      <Icon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-foreground/80">{message}</AlertDescription>
      {action && (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={action.onClick}>
            {action.label}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
