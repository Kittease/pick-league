import type { LcuChampSelectSession, LcuGameflowPhase } from '../../core/lcu-types.ts';
import type { LcuApi } from './api.ts';

export type LcuConnectionStatus =
  | { state: 'searching'; message: string }
  | { state: 'connected'; api: LcuApi };

export interface LcuListener {
  onStatus(status: LcuConnectionStatus): void;
  /** Champion select session; null when not (or no longer) in champion select. */
  onSession(session: LcuChampSelectSession | null): void;
  /** Gameflow phase ('ChampSelect', 'InProgress'…); null when unknown (client gone). */
  onPhase(phase: LcuGameflowPhase | null): void;
}

/** A League client: the real one over HTTPS/WebSocket, or the scripted mock. */
export interface LcuSource {
  readonly kind: 'real' | 'mock';
  start(listener: LcuListener): void;
  stop(): void;
}
