import type { PickLeagueBridge } from '../core/app-state.ts';

declare global {
  interface Window {
    pickleague: PickLeagueBridge;
  }
}
