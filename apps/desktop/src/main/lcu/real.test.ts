import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import type { LcuApi } from './api.ts';
import type { LcuCredentials } from './discovery.ts';
import { createRealLcuSource, type LcuSocket, openLcuSocket } from './real.ts';
import type { LcuListener } from './source.ts';

const CREDS: LcuCredentials = { port: 1, token: 'fake-token' };
const tick = () => new Promise((r) => setTimeout(r, 10));

function gate<T>() {
  let open: (value: T) => void = () => {};
  const opened = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Records what the source reports. */
function recorder() {
  const events: string[] = [];
  const listener: LcuListener = {
    onStatus: (s) => events.push(`status:${s.state}`),
    onSession: (s) => events.push(`session:${s ? 'live' : 'none'}`),
    onPhase: (p) => events.push(`phase:${p}`),
  };
  return { events, listener };
}

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  terminated = false;
  send(data: string) {
    this.sent.push(data);
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.emit('close');
  }
}

const fakeApi = (over: Partial<LcuApi> = {}) =>
  ({
    getCurrentSummoner: async () => ({ summonerId: 1 }),
    getGameflowPhase: async () => 'Lobby',
    getChampSelectSession: async () => null,
    ...over,
  }) as unknown as LcuApi;

describe('League client source', () => {
  test('stop() during discovery: no socket is opened, nothing is reported after', async () => {
    const discovery = gate<LcuCredentials | null>();
    let opened = 0;
    const { events, listener } = recorder();
    const source = createRealLcuSource({
      discover: () => discovery.opened,
      createApi: () => fakeApi(),
      openSocket: () => {
        opened++;
        return new FakeSocket() as unknown as LcuSocket;
      },
      retryMs: 5,
    });
    source.start(listener);
    source.stop();
    const before = [...events];
    discovery.open(CREDS);
    await tick();
    expect(opened).toBe(0);
    expect(events).toEqual(before);
  });

  test('stop() while the client is checked: no socket is opened', async () => {
    const summoner = gate<{ summonerId: number }>();
    let opened = 0;
    const source = createRealLcuSource({
      discover: async () => CREDS,
      createApi: () => fakeApi({ getCurrentSummoner: () => summoner.opened }),
      openSocket: () => {
        opened++;
        return new FakeSocket() as unknown as LcuSocket;
      },
      retryMs: 5,
    });
    source.start(recorder().listener);
    await tick();
    source.stop();
    summoner.open({ summonerId: 1 });
    await tick();
    expect(opened).toBe(0);
  });

  test('stop() aborts a connection still opening and reports nothing more', async () => {
    const sockets: FakeSocket[] = [];
    const { events, listener } = recorder();
    const source = createRealLcuSource({
      discover: async () => CREDS,
      createApi: () => fakeApi(),
      openSocket: () => {
        const ws = new FakeSocket();
        sockets.push(ws);
        return ws as unknown as LcuSocket;
      },
      retryMs: 5,
    });
    source.start(listener);
    await tick();
    expect(sockets).toHaveLength(1);
    const before = [...events];
    source.stop();
    sockets[0]?.emit('open'); // late upgrade answer
    await tick();
    expect(sockets[0]?.terminated).toBe(true);
    expect(sockets[0]?.sent).toEqual([]);
    expect(events).toEqual(before);
    // The reconnect loop is over too.
    await tick();
    expect(sockets).toHaveLength(1);
  });

  test('connected: subscribes, reports the phase; a closed socket reports the client gone and retries', async () => {
    const sockets: FakeSocket[] = [];
    const { events, listener } = recorder();
    const source = createRealLcuSource({
      discover: async () => CREDS,
      createApi: () => fakeApi(),
      openSocket: () => {
        const ws = new FakeSocket();
        sockets.push(ws);
        return ws as unknown as LcuSocket;
      },
      retryMs: 5,
    });
    source.start(listener);
    await tick();
    sockets[0]?.emit('open');
    await tick();
    expect(sockets[0]?.sent).toHaveLength(2);
    expect(events).toEqual(['status:searching', 'status:connected', 'phase:Lobby', 'session:none']);
    sockets[0]?.emit('close');
    await tick();
    expect(events.slice(4, 7)).toEqual(['session:none', 'phase:null', 'status:searching']);
    expect(sockets.length).toBeGreaterThan(1);
    source.stop();
  });
});

describe('client WebSocket', () => {
  let server: Server | null = null;
  const connections = new Set<Socket>();
  afterEach(async () => {
    for (const c of connections) c.destroy();
    connections.clear();
    await new Promise((r) => server?.close(r) ?? r(undefined));
    server = null;
  });

  test('gives up on an upgrade the client never answers', async () => {
    // Accepts the connection, then never says a word (not even the TLS handshake).
    const silent = createServer((c) => connections.add(c));
    server = silent;
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const address = silent.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = openLcuSocket({ port: address.port, token: 'fake-token' }, 100);
    const failed = new Promise<string>((resolve) => ws.on('error', (e) => resolve(e.message)));
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
    expect(await failed).toMatch(/timed out/i);
    await closed;
  });
});
