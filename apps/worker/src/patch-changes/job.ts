/**
 * Patch changes job: reads each new game build from Community Dragon, diffs it and stores the
 * change set (docs/architecture.md, Worker, patch changes). Its own loop, outside the Riot rate
 * limiter: a failure is logged and retried at the next check, never affecting the crawl.
 *
 * - Every `intervalMs` (30 min) it reads the build of Community Dragon's `latest` folder. A build
 *   not stored yet is read from its patch folder (once that folder holds the same build): every
 *   champion file of the patch's Data Dragon champions and the items file, reduced to a snapshot
 *   of the gameplay values.
 * - The first build of a patch is diffed against the newest stored build of the previous patch
 *   (read from that patch's folder when none is stored): the patch diff. A later build of the same
 *   patch is diffed against the build before it: a hotfix diff, stored even when empty.
 * - `backfill(patches)` stores the patch diffs of past patches from both patches' final builds.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  type Db,
  type GameBuildInput,
  getGameBuild,
  hasPatchDiff,
  newestGameBuildSnapshot,
  type PatchChangeInput,
  type PatchChangeSetInput,
  storeGameBuild,
} from '@pick-league/db';
import {
  comparePatches,
  type DdragonClient,
  latestPatchVersions,
  normaliseChampions,
  normaliseItems,
  type PatchId,
} from '@pick-league/shared';
import { type Clock, isAbortError, systemClock } from '../clock.ts';
import { errorMessage, type Logger, silentLogger } from '../log.ts';
import type { CdragonClient, ContentVersion } from './cdragon.ts';
import {
  type ChampionSnapshot,
  diffChampionSnapshots,
  diffItems,
  type EntityChanges,
  extractChampion,
  extractItems,
  type ItemsSnapshot,
} from './diff.ts';

/** Bumped when the extracted values change shape or filters: older snapshots are not diffed. */
export const SNAPSHOT_FORMAT = 1;

/** The gameplay values of one build. */
export interface GameSnapshot {
  format: number;
  /** By alias (Data Dragon id lowercased). */
  champions: Record<string, ChampionSnapshot>;
  items: ItemsSnapshot;
}

export function encodeSnapshot(snapshot: GameSnapshot): Uint8Array {
  return gzipSync(JSON.stringify(snapshot));
}

/** Null when the snapshot is of another format. */
export function decodeSnapshot(bytes: Uint8Array): GameSnapshot | null {
  const snapshot = JSON.parse(gunzipSync(bytes).toString('utf8')) as GameSnapshot;
  return snapshot.format === SNAPSHOT_FORMAT ? snapshot : null;
}

/** A patch's champions and items as Data Dragon names them. */
export interface PatchNames {
  patch: PatchId;
  champions: { id: number; alias: string; name: string }[];
  items: Map<number, string>;
}

/**
 * The change rows of a diff: champions (by name) then items (by name). Champions and items are
 * those of Data Dragon (an item only in the game files is an internal one); names from the newer
 * patch, the older one for a removed item.
 */
export function buildChangeSet(
  before: GameSnapshot,
  after: GameSnapshot,
  names: PatchNames,
  previousNames: PatchNames,
): Pick<PatchChangeSetInput, 'changedChampions' | 'changedItems' | 'changes'> {
  const champions: { name: string; id: number; diff: EntityChanges<string> }[] = [];
  for (const c of names.champions) {
    const snap = after.champions[c.alias];
    if (!snap) continue;
    const diff = diffChampionSnapshots(c.alias, before.champions[c.alias] ?? null, snap);
    if (diff) champions.push({ name: c.name, id: c.id, diff });
  }
  champions.sort((a, b) => a.name.localeCompare(b.name));
  const items: { name: string; diff: EntityChanges<number> }[] = [];
  for (const diff of diffItems(before.items, after.items)) {
    const name = names.items.get(diff.key) ?? previousNames.items.get(diff.key);
    if (name !== undefined) items.push({ name, diff });
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.diff.key - b.diff.key);

  const changes: PatchChangeInput[] = [];
  const rows = (
    diff: EntityChanges<unknown>,
    entity: Pick<PatchChangeInput, 'kind' | 'championId' | 'itemId' | 'name'>,
  ) => {
    if (diff.changes.length === 0) {
      changes.push({
        ...entity,
        status: diff.status,
        slot: null,
        spellName: null,
        calculation: null,
        valueName: null,
        oldValues: null,
        newValues: null,
        path: null,
      });
    }
    for (const c of diff.changes) changes.push({ ...entity, status: diff.status, ...c });
  };
  for (const c of champions) {
    rows(c.diff, { kind: 'champion', championId: c.id, itemId: null, name: c.name });
  }
  for (const i of items) {
    rows(i.diff, { kind: 'item', championId: null, itemId: i.diff.key, name: i.name });
  }
  return { changedChampions: champions.length, changedItems: items.length, changes };
}

export interface PatchChangesJobOptions {
  clock?: Clock;
  log?: Logger;
  /** Between two checks of the latest build (default 30 min). */
  intervalMs?: number;
  /** Champion files downloaded at a time (default 6). */
  concurrency?: number;
}

export type CheckResult = 'stored' | 'known' | 'waiting';

interface ReadBuild {
  cv: ContentVersion;
  snapshot: GameSnapshot;
}

export class PatchChangesJob {
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly names = new Map<PatchId, Promise<PatchNames | null>>();

  constructor(
    private readonly db: Db,
    private readonly cdragon: CdragonClient,
    private readonly ddragon: Pick<DdragonClient, 'getVersions' | 'getChampionFull' | 'getItems'>,
    private readonly options: PatchChangesJobOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? silentLogger;
  }

  /** Checks now, then every `intervalMs` until aborted. Never throws but on abort. */
  async run(signal: AbortSignal): Promise<void> {
    const interval = this.options.intervalMs ?? 30 * 60_000;
    while (!signal.aborted) {
      try {
        await this.checkLatest();
      } catch (err) {
        this.log.warn('patch changes check failed, will retry', { error: errorMessage(err) });
      }
      try {
        await this.clock.sleep(interval, signal);
      } catch (err) {
        if (isAbortError(err)) return;
        throw err;
      }
    }
  }

  /** Reads Community Dragon's latest build and stores its diff when it is new. */
  async checkLatest(): Promise<CheckResult> {
    const latest = await this.cdragon.contentVersion('latest');
    if (!latest) throw new Error('Community Dragon has no latest content version');
    if (await getGameBuild(this.db, latest.build)) return 'known';
    // Files are read from the patch's own folder: it must hold the same build.
    const folder = await this.cdragon.contentVersion(latest.patch);
    if (!folder || folder.build !== latest.build) {
      this.log.debug('patch folder not ready', { build: latest.build, folder: folder?.build });
      return 'waiting';
    }
    const names = await this.patchNames(latest.patch);
    if (!names?.current || !names.previous) {
      this.log.info('patch changes wait for Data Dragon', { patch: latest.patch });
      return 'waiting';
    }
    const after = await this.readBuild(folder, names.current);

    const sameBefore = await newestGameBuildSnapshot(this.db, latest.patch);
    const sameSnapshot = sameBefore ? decodeSnapshot(sameBefore.snapshot) : null;
    if (sameBefore && sameBefore.build.buildNumber < latest.buildNumber && sameSnapshot) {
      await this.store(after, {
        kind: 'hotfix',
        source: 'live',
        basePatch: latest.patch,
        baseBuild: sameBefore.build.build,
        ...buildChangeSet(sameSnapshot, after.snapshot, names.current, names.current),
      });
      return 'stored';
    }
    if (await hasPatchDiff(this.db, latest.patch)) {
      // A later build without its predecessor's values (another snapshot format): no diff.
      this.log.warn('hotfix not diffed: no snapshot of the build before', {
        build: latest.build,
      });
      await this.store(after, null);
      return 'stored';
    }
    const base = await this.previousBuild(names.previous, names.current);
    await this.store(after, {
      kind: 'patch',
      source: 'live',
      basePatch: base.cv.patch,
      baseBuild: base.cv.build,
      ...buildChangeSet(base.snapshot, after.snapshot, names.current, names.previous),
    });
    return 'stored';
  }

  /**
   * Stores the patch diff of each of `patches` (oldest first) from both patches' final builds, as
   * `backfill`. Skips a patch that already has one. Idempotent.
   */
  async backfill(patches: readonly PatchId[]): Promise<void> {
    let previous: ReadBuild | null = null;
    for (const patch of [...patches].sort(comparePatches)) {
      if (await hasPatchDiff(this.db, patch)) {
        this.log.info('patch diff already stored', { patch });
        previous = null;
        continue;
      }
      const names = await this.patchNames(patch);
      if (!names?.current || !names.previous) throw new Error(`${patch}: not in Data Dragon`);
      const cv = await this.cdragon.contentVersion(patch);
      if (!cv) throw new Error(`${patch}: no Community Dragon folder`);
      const base: ReadBuild =
        previous?.cv.patch === names.previous.patch
          ? previous
          : await this.readBuild(await this.folderVersion(names.previous.patch), names.current);
      // The base is stored too, so the next patch (or a later build) can be diffed against it.
      await this.store(base, null);
      const after = await this.readBuild(cv, names.current);
      await this.store(after, {
        kind: 'patch',
        source: 'backfill',
        basePatch: base.cv.patch,
        baseBuild: base.cv.build,
        ...buildChangeSet(base.snapshot, after.snapshot, names.current, names.previous),
      });
      previous = after;
    }
  }

  private async folderVersion(patch: PatchId): Promise<ContentVersion> {
    const cv = await this.cdragon.contentVersion(patch);
    if (!cv) throw new Error(`${patch}: no Community Dragon folder`);
    return cv;
  }

  /** The newest stored build of the previous patch, else its folder's (final) build, stored. */
  private async previousBuild(previous: PatchNames, current: PatchNames): Promise<ReadBuild> {
    const stored = await newestGameBuildSnapshot(this.db, previous.patch);
    const snapshot = stored ? decodeSnapshot(stored.snapshot) : null;
    if (stored && snapshot) {
      return {
        cv: {
          version: stored.build.version,
          patch: stored.build.patch,
          build: stored.build.build,
          buildNumber: stored.build.buildNumber,
        },
        snapshot,
      };
    }
    const read = await this.readBuild(await this.folderVersion(previous.patch), current);
    await this.store(read, null);
    return read;
  }

  private async store(build: ReadBuild, changeSet: PatchChangeSetInput | null): Promise<void> {
    const input: GameBuildInput = {
      build: build.cv.build,
      patch: build.cv.patch,
      buildNumber: build.cv.buildNumber,
      version: build.cv.version,
      champions: Object.keys(build.snapshot.champions).length,
      items: Object.keys(build.snapshot.items).length,
      snapshot: encodeSnapshot(build.snapshot),
      changeSet,
    };
    const stored = await storeGameBuild(this.db, input);
    if (stored && changeSet) {
      this.log.info('patch changes stored', {
        build: input.build,
        kind: changeSet.kind,
        source: changeSet.source,
        base: changeSet.baseBuild,
        champions: changeSet.changedChampions,
        items: changeSet.changedItems,
        rows: changeSet.changes.length,
      });
    }
  }

  /**
   * The champion files of `names` (the newer patch's champions: one missing from the folder is
   * new there) and the items file of a folder, reduced to their gameplay values. The folder's build
   * is read again at the end: a folder rewritten meanwhile is an error (retried at the next check).
   */
  private async readBuild(cv: ContentVersion, names: PatchNames): Promise<ReadBuild> {
    const folder = cv.patch;
    const champions: Record<string, ChampionSnapshot> = {};
    const queue = names.champions.map((c) => c.alias);
    const worker = async () => {
      for (let alias = queue.shift(); alias !== undefined; alias = queue.shift()) {
        const file = await this.cdragon.championFile(folder, alias);
        if (file !== null) champions[alias] = extractChampion(alias, file);
      }
    };
    await Promise.all(Array.from({ length: this.options.concurrency ?? 6 }, worker));
    const items = extractItems(await this.cdragon.itemsFile(folder));
    const after = await this.cdragon.contentVersion(folder);
    if (after?.build !== cv.build) {
      throw new Error(`${folder}: build changed while reading (${cv.build} → ${after?.build})`);
    }
    return { cv, snapshot: { format: SNAPSHOT_FORMAT, champions, items } };
  }

  /** Data Dragon's champions and items of `patch` and of the patch before it (null: not there yet). */
  private async patchNames(
    patch: PatchId,
  ): Promise<{ current: PatchNames | null; previous: PatchNames | null } | null> {
    const versions = latestPatchVersions(await this.ddragon.getVersions(), 50);
    const at = versions.findIndex((v) => v.patch === patch);
    if (at < 0) return null;
    const load = (v: { patch: PatchId; ddragonVersion: string } | undefined) => {
      if (!v) return Promise.resolve(null);
      const cached = this.names.get(v.ddragonVersion);
      if (cached) return cached;
      const loaded = (async (): Promise<PatchNames> => {
        const [champions, items] = await Promise.all([
          this.ddragon.getChampionFull(v.ddragonVersion),
          this.ddragon.getItems(v.ddragonVersion),
        ]);
        return {
          patch: v.patch,
          champions: normaliseChampions(champions).map((c) => ({
            id: c.id,
            alias: c.slug.toLowerCase(),
            name: c.name,
          })),
          items: new Map(normaliseItems(items).map((i) => [i.id, i.name])),
        };
      })();
      loaded.catch(() => this.names.delete(v.ddragonVersion));
      this.names.set(v.ddragonVersion, loaded);
      return loaded;
    };
    const [current, previous] = await Promise.all([load(versions[at]), load(versions[at + 1])]);
    return { current, previous };
  }
}
