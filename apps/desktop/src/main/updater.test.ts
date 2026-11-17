import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { UpdateState } from '../core/update.ts';
import { type UpdaterLike, UpdateService } from './updater.ts';

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  nextCheck: () => Promise<unknown> = async () => undefined;

  checkForUpdates(): Promise<unknown> {
    this.checks++;
    return this.nextCheck();
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function setup(enabled = true) {
  const fake = new FakeUpdater();
  const logs: string[] = [];
  const service = new UpdateService({
    currentVersion: '0.2.0',
    enabled,
    createUpdater: () => fake as unknown as UpdaterLike,
    log: (m) => logs.push(m),
  });
  const states: UpdateState[] = [];
  service.onChange((s) => states.push(s));
  return { fake, logs, service, states };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('UpdateService', () => {
  test('dev builds never touch the updater', () => {
    let created = false;
    const service = new UpdateService({
      currentVersion: '0.2.0',
      enabled: false,
      createUpdater: () => {
        created = true;
        throw new Error('unreachable');
      },
      log: () => {},
    });
    service.start();
    service.check();
    service.install();
    service.stop();
    expect(created).toBe(false);
    expect(service.getState()).toEqual({
      currentVersion: '0.2.0',
      status: 'disabled',
      version: null,
      progress: null,
      message: null,
    });
  });

  test('downloads in the background and installs on quit', () => {
    const { fake, service } = setup();
    service.check();
    expect(fake.checks).toBe(1);
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);

    fake.emit('checking-for-update');
    expect(service.getState().status).toBe('checking');
    fake.emit('update-available', { version: '0.3.0' });
    fake.emit('download-progress', { percent: 41.6 });
    expect(service.getState()).toMatchObject({
      status: 'downloading',
      version: '0.3.0',
      progress: 42,
    });
    fake.emit('update-downloaded', { version: '0.3.0' });
    expect(service.getState()).toMatchObject({ status: 'ready', version: '0.3.0', progress: null });
  });

  test('no re-check while busy or once an update is ready', () => {
    const { fake, service } = setup();
    service.check();
    fake.emit('checking-for-update');
    service.check();
    expect(fake.checks).toBe(1);
    fake.emit('update-downloaded', { version: '0.3.0' });
    service.check();
    expect(fake.checks).toBe(1);
  });

  test('restart installs silently and relaunches, only when ready', () => {
    const { fake, service } = setup();
    service.install();
    service.check();
    service.install();
    expect(fake.installs).toEqual([]);
    fake.emit('update-downloaded', { version: '0.3.0' });
    service.install();
    expect(fake.installs).toEqual([[true, true]]);
  });

  test('network failures are logged once and kept quiet in the state', async () => {
    const { fake, logs, service } = setup();
    const error = new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack');
    fake.nextCheck = async () => {
      fake.emit('checking-for-update');
      fake.emit('error', error);
      throw error;
    };
    service.check();
    await flush();
    expect(service.getState()).toMatchObject({
      status: 'error',
      message: 'net::ERR_INTERNET_DISCONNECTED',
    });
    expect(logs).toEqual(['update: net::ERR_INTERNET_DISCONNECTED']);

    // The next check starts over.
    fake.nextCheck = async () => {
      fake.emit('checking-for-update');
      fake.emit('update-not-available');
    };
    service.check();
    await flush();
    expect(service.getState()).toMatchObject({ status: 'up_to_date', message: null });
  });

  test('a rejection without error event still ends the check', async () => {
    const { fake, service } = setup();
    fake.nextCheck = async () => {
      throw new Error('ENOENT app-update.yml');
    };
    service.check();
    await flush();
    expect(service.getState()).toMatchObject({ status: 'error', message: 'ENOENT app-update.yml' });
  });

  test('an error after the download keeps the update ready', () => {
    const { fake, service } = setup();
    service.check();
    fake.emit('update-downloaded', { version: '0.3.0' });
    fake.emit('error', new Error('offline'));
    expect(service.getState()).toMatchObject({ status: 'ready', version: '0.3.0' });
  });

  test('listeners get every change', () => {
    const { fake, service, states } = setup();
    service.check();
    fake.emit('checking-for-update');
    fake.emit('update-not-available');
    expect(states.map((s) => s.status)).toEqual(['checking', 'up_to_date']);
  });
});
