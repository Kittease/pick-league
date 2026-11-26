-- Patch changes: which champion and item values each game build changed, read from Community
-- Dragon's game files by the worker (apps/worker/src/patch-changes). Independent of `patches`:
-- kept for more patches than the stats (the 6 newest), so no foreign key to it.

-- Every game build the worker read. `build` is Community Dragon's content version without its
-- branch ('16.23.8418428' for '16.23.8418428+branch.releases-16-23.content.release'), the same
-- number as the matches' game_version without its last dot (16.23.841.8428).
CREATE TABLE game_builds (
  build         text PRIMARY KEY,
  patch         text NOT NULL,
  build_number  bigint NOT NULL,              -- 8418428: orders the builds of a patch
  version       text NOT NULL,                -- content-metadata.json version, as read
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  champions     smallint NOT NULL,            -- champion files read
  items         smallint NOT NULL,            -- items compared
  -- Gzipped JSON of the extracted gameplay values (what the diff compares), so a later build can
  -- be diffed without the old files: kept only for the newest build of the 2 newest patches.
  snapshot      bytea
);
CREATE INDEX game_builds_patch_idx ON game_builds (patch, build_number);

-- One diff per build: `patch` = the first build read of a patch vs the newest build of the
-- previous patch; `hotfix` = a later build of the patch vs the build before it (an empty hotfix,
-- 0 changed champions and items, is a build without gameplay change). `source`: `live` = captured
-- when the build came out; `backfill` = both patches' final builds, read afterwards (Community
-- Dragon keeps only the newest build of a patch: mid-patch changes are merged in).
CREATE TABLE patch_change_sets (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patch             text NOT NULL,
  build             text NOT NULL UNIQUE REFERENCES game_builds ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('patch', 'hotfix')),
  source            text NOT NULL CHECK (source IN ('live', 'backfill')),
  base_patch        text NOT NULL,
  base_build        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  changed_champions smallint NOT NULL,
  changed_items     smallint NOT NULL
);
CREATE INDEX patch_change_sets_patch_idx ON patch_change_sets (patch);

-- The changes of a set: one row per changed value; a new or removed champion / item is one row
-- without value. Names are stored (from Data Dragon of the patch): the patch may no longer be kept.
CREATE TABLE patch_changes (
  set_id      integer  NOT NULL REFERENCES patch_change_sets ON DELETE CASCADE,
  ord         smallint NOT NULL,              -- order inside the set (entity, then slot, spell, path)
  kind        text     NOT NULL CHECK (kind IN ('champion', 'item')),
  champion_id smallint,                       -- Data Dragon key (kind = champion)
  item_id     integer,                        -- kind = item
  name        text     NOT NULL,              -- 'Ezreal', 'Voltaic Cyclosword'
  status      text     NOT NULL CHECK (status IN ('changed', 'new', 'removed')),
  slot        text,                           -- Q W E R, P (passive), base (base stats), other; null for items
  spell_name  text,                           -- game object: 'EzrealR', 'EzrealEMissile'
  calculation text,                           -- spell calculation of a ratio: 'Damage'
  value_name  text,                           -- 'BaseDamage', 'Cooldown', 'Cost', 'bonusAdRatio', 'added'…
  old_values  double precision[],             -- per rank (rank 1 first) or one value; null: absent
  new_values  double precision[],
  path        text,                           -- in the game file, for debugging
  PRIMARY KEY (set_id, ord),
  CHECK ((kind = 'champion') = (champion_id IS NOT NULL)),
  CHECK ((kind = 'item') = (item_id IS NOT NULL))
);
