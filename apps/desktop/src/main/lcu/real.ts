/**
 * Connection to the real League client: HTTPS + WAMP WebSocket on 127.0.0.1 with Riot's
 * self-signed certificate, basic auth `riot:<token>`, and a reconnect loop.
 */

import { Agent, request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import type { LcuChampSelectSession } from '../../core/lcu-types.ts';
import {
  CHAMP_SELECT_SESSION_PATH,
  createLcuApi,
  GAMEFLOW_PHASE_PATH,
  type LcuApi,
  LcuHttpError,
  type LcuTransport,
} from './api.ts';
import { discoverLcu, type LcuCredentials } from './discovery.ts';
import type { LcuListener, LcuSource } from './source.ts';

/** The LCU only ever listens on loopback; the self-signed cert is accepted for this host only. */
const LCU_HOST = '127.0.0.1';
const SESSION_EVENT = 'OnJsonApiEvent_lol-champ-select_v1_session';
const PHASE_EVENT = 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase';
const WAMP_SUBSCRIBE = 5;
const WAMP_EVENT = 8;
const RETRY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A WebSocket upgrade the client never answers would otherwise block the reconnect loop. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

function authHeader(token: string): string {
  return `Basic ${Buffer.from(`riot:${token}`).toString('base64')}`;
}

/**
 * Riot signs the LCU certificate with its own root and no hostname we could check, so
 * verification is disabled — but this agent is private to this module and every request it
 * serves is hard-wired to 127.0.0.1.
 */
const loopbackAgent = new Agent({ rejectUnauthorized: false, keepAlive: true });

export function createHttpsTransport(creds: LcuCredentials): LcuTransport {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpsRequest(
        {
          host: LCU_HOST,
          port: creds.port,
          path,
          method,
          agent: loopbackAgent,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            Authorization: authHeader(creds.token),
            Accept: 'application/json',
            ...(payload !== undefined
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new LcuHttpError(method, path, status, text));
              return;
            }
            if (!text) {
              resolve(undefined);
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(text);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`LCU ${method} ${path} timed out`)));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** WebSocket to the client's event stream; a stuck upgrade fails after `handshakeTimeoutMs`. */
export function openLcuSocket(
  creds: LcuCredentials,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
): WebSocket {
  return new WebSocket(`wss://${LCU_HOST}:${creds.port}/`, 'wamp', {
    headers: { Authorization: authHeader(creds.token) },
    rejectUnauthorized: false,
    handshakeTimeout: handshakeTimeoutMs,
  });
}

/** The part of a `ws` WebSocket the source uses. */
export type LcuSocket = Pick<WebSocket, 'on' | 'send' | 'terminate'>;

/** What the source talks to; replaced in tests. */
export interface RealLcuDeps {
  discover(): Promise<LcuCredentials | null>;
  createApi(creds: LcuCredentials): LcuApi;
  openSocket(creds: LcuCredentials): LcuSocket;
  retryMs: number;
}

const DEFAULT_DEPS: RealLcuDeps = {
  discover: discoverLcu,
  createApi: (creds) => createLcuApi(createHttpsTransport(creds)),
  openSocket: (creds) => openLcuSocket(creds),
  retryMs: RETRY_MS,
};

export function createRealLcuSource(overrides: Partial<RealLcuDeps> = {}): LcuSource {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  let running = false;
  /** Bumped by start() and stop(): whatever an older run was awaiting is dropped. */
  let run = 0;
  let socket: LcuSocket | null = null;

  async function connectOnce(listener: LcuListener, current: number): Promise<void> {
    const live = () => run === current;
    const creds = await deps.discover();
    if (!live()) return;
    if (!creds) {
      listener.onStatus({ state: 'searching', message: 'League client not found' });
      return;
    }
    const api = deps.createApi(creds);
    try {
      await api.getCurrentSummoner();
    } catch (e) {
      // 404 = still logging in; anything else = the client isn't ready yet.
      if (live() && !(e instanceof LcuHttpError)) {
        listener.onStatus({ state: 'searching', message: 'League client starting…' });
        return;
      }
    }
    if (!live()) return;

    await new Promise<void>((resolve) => {
      const ws = deps.openSocket(creds);
      socket = ws;
      ws.on('open', () => {
        if (!live()) return;
        ws.send(JSON.stringify([WAMP_SUBSCRIBE, SESSION_EVENT]));
        ws.send(JSON.stringify([WAMP_SUBSCRIBE, PHASE_EVENT]));
        listener.onStatus({ state: 'connected', api });
        api
          .getGameflowPhase()
          .catch(() => null)
          .then((p) => live() && listener.onPhase(p));
        api
          .getChampSelectSession()
          .catch(() => null)
          .then((s) => live() && listener.onSession(s));
      });
      ws.on('message', (raw) => {
        if (!live()) return;
        try {
          const msg = JSON.parse(raw.toString()) as unknown[];
          if (msg[0] !== WAMP_EVENT) return;
          const event = msg[2] as { eventType?: string; data?: unknown; uri?: string };
          const deleted = event.eventType === 'Delete';
          if (msg[1] === PHASE_EVENT) {
            if (event.uri && event.uri !== GAMEFLOW_PHASE_PATH) return;
            listener.onPhase(!deleted && typeof event.data === 'string' ? event.data : null);
            return;
          }
          if (msg[1] !== SESSION_EVENT) return;
          if (event.uri && event.uri !== CHAMP_SELECT_SESSION_PATH) return;
          listener.onSession(deleted ? null : ((event.data as LcuChampSelectSession) ?? null));
        } catch {
          // ignore malformed frames
        }
      });
      // A failed or timed-out upgrade emits 'error' then 'close'.
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        if (socket === ws) socket = null;
        if (live()) {
          listener.onSession(null);
          listener.onPhase(null);
          listener.onStatus({ state: 'searching', message: 'League client disconnected' });
        }
        resolve();
      });
    });
  }

  return {
    start(listener) {
      if (running) return;
      running = true;
      const current = ++run;
      listener.onStatus({ state: 'searching', message: 'Looking for the League client…' });
      void (async () => {
        while (run === current) {
          await connectOnce(listener, current).catch(() => undefined);
          if (run === current) await sleep(deps.retryMs);
        }
      })();
    },
    stop() {
      running = false;
      run++;
      // Also aborts an upgrade still in progress.
      socket?.terminate();
      socket = null;
    },
  };
}
