/** Plain data shared by the views and the apps that host them (serializable: IPC, Server Actions). */

/** Result of a one-off API call (errors are plain data, never thrown across the boundary). */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string | null; message: string };

export type Loadable<T> =
  | { status: 'idle' }
  | { status: 'loading'; data: T | null }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string; code: string | null; data: T | null };

/** The user's mastery of a champion (League client only). */
export interface MasteryEntry {
  level: number;
  points: number;
}
