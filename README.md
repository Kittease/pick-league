# PickLeague

PickLeague helps you pick the right champion in League of Legends champion select, then build it:
items and buy order, runes, summoner spells and skill order, adapted to the 9 other champions.
Every recommendation shows its reasons. The data comes from high-elo ranked solo/duo games
(Challenger, Grandmaster and Master players of KR, EUW, NA and VN, best players first) on the
current patch, plus the previous patch for champions with few matchups on the current one.

It has four parts:

- **worker**: collects matches from the Riot API into Postgres.
- **api**: serves static data and recommendations over HTTP.
- **web**: a Next.js app on Vercel (<https://pick-league.vercel.app>) with the tier list, the draft
  planner and builds, and the gateway the desktop app calls.
- **desktop**: an Electron app that reads your champion select from the League client and shows picks and builds.

The worker, the API and Postgres run with Docker on a VPS, behind Caddy (HTTPS). Only the web
app's server talks to the API (with a secret token); browsers and the desktop app talk to Vercel.

```
desktop app ─┐
browsers ────┴─► pick-league.vercel.app (Next.js) ──token──► VPS: Caddy :443 ─► api ─► Postgres ◄─ worker ─► Riot API
```

See [docs/architecture.md](docs/architecture.md) and [docs/database-schema.md](docs/database-schema.md).

## Server (VPS)

Runs on any Linux box with Docker (sized for 6 cores, 12 GB RAM, 100 GB disk; see the limits in
`docker-compose.yml`). The database keeps two patches at about 22 KB per match: ~13 GB for two full
patches of every Master+ player (an estimate, see "Size estimate" in
[docs/database-schema.md](docs/database-schema.md)), more with Diamond players
(`DIAMOND_MAX_TRACKED`).

1. Install Docker Engine with the compose plugin and clone this repository.
2. `cp .env.example .env`, then set `RIOT_API_KEY`, a strong `POSTGRES_PASSWORD` (**before the
   first start**: Postgres only reads it when it creates its volume), `PUBLIC_HOST` (the VPS's
   IPv4, or a domain), and `API_TOKEN` (`openssl rand -hex 32`, the same value as the web app's).
3. `docker compose up -d --build`.
4. `sudo deploy/install.sh` installs the systemd timers: watchdog, worker socket sampling (see
   "Operations").
5. Firewall: allow only 22, 80 and 443 (`ufw allow 22/tcp 80/tcp 443/tcp && ufw enable`). The API
   is published on `127.0.0.1` only (Docker-published ports bypass ufw); Postgres is never published.

Caddy serves `PUBLIC_HOST` over HTTPS. Without a domain it gets a Let's Encrypt certificate for the
bare IP (short-lived, renewed by itself). The API answers only `GET /health` without the token.

The worker starts with the Challenger and Grandmaster players of each server. Each time it has
caught up with their matches, it adds the next 500 Master players by LP, down to the bottom of
Master. Matches of better-placed players are always fetched first. The `masterTracked` and
`masterTotal` fields of its `progress` log lines show how far down it got.

Riot's budget for match requests (3,000 an hour per region) is spent in three strict tiers:

1. the tracked Master+ players: those who played are listed and their matches fetched first;
2. the Masters outside Riot's list (it stops at 10,000 players), found in stored matches: Riot
   gives no list for them, so the worker asks for each one's own win and loss counter, in
   rotation, on the server's platform host (a separate budget of 3,000 requests an hour). Only
   those whose counter moved are listed, and the games found are fetched, whenever tier 1 has
   nothing waiting. `outsideMasters` in the `progress` log shows how many are followed, how many
   were checked in the last hour, the age of the oldest check, how many wait for a listing and
   how many of their matches are waiting;
3. Diamond players, with what is left (see `DIAMOND_MAX_TRACKED`): nothing of theirs is listed or
   fetched while tier 1 or tier 2 has something waiting. First the Diamond players seen in a
   Master+ game in the last 7 days, then, once those have nothing waiting, the other Diamond
   players from Diamond I down to Diamond IV.

The platform host serves, in this order: the ladder lists, the Diamond pages, the checks of the
Masters outside Riot's list, the masteries of tracked players, then masteries and rank of the
other players met in matches (which get what is left).

Worker settings (in `.env`, applied with `docker compose up -d worker`):

- `LISTING_SKIP` = `off` | `shadow` | `on`. A stored match holds about 6 tracked players, and each
  of them is asked for their match ids only to find that match again. With `on`, a tracked player
  whose new games (wins + losses on the ladder, or at the check of a Master outside Riot's list)
  are all stored already is not asked; at least one real listing stays per player who plays,
  every 24 hours for the Master+ players of Riot's lists, every 72 hours for the others. `shadow`
  runs every listing as before, counts what `on` would have skipped (`listingsSkipped` in the
  `progress` log) and records in the `listing_skip_misses` table the skipped listings that would
  have brought new match ids
  (`listingSkipMisses`): run it first, then read that table. In both modes a player is listed only
  after the matches brought by better-placed players are stored.
- `DIAMOND_MAX_TRACKED` = the most Diamond players the worker may track per server (0, the
  default: none, Diamond is not read). It is a ceiling, there to protect the disk: how many are
  tracked under it is a target the worker sizes by itself. With each hourly ladder refresh the
  worker reads the Diamond divisions (a few hundred requests on the server's platform host,
  served right after the ladder lists) and tracks the best candidates, as many as the target: first the Diamond players
  seen in a Master+ game in the last 7 days (by division, I down to IV, then LP), then the other
  Diamond players by division (I down to IV) then LP, as far down as the budget allows. The target is sized on
  the day: it grows by 1,000 when, in the last 24 hourly cycles, the three tiers ran out of work
  in at least 3 (everything listed and fetched: budget was left; at first, two such hours in a
  row are enough), and shrinks by 1,000 (the last candidates leave, their stored matches stay)
  once a full day went by without catching up once. A step up first brings the new players' matches of the patch: until that
  burst is absorbed (a day at most) hours are not counted. Their matches are collected like
  everyone's, so Diamond lobbies enter the statistics. `diamond` in the `progress` log shows the
  players seen per division, the target, those tracked, the ceiling, the last hours (`cycles`:
  `K` kept up, `W` waiting for patch data, `M` missed)
  and the last change of the target with its reason.
- `OUTSIDE_MASTER_CHECKS_PER_HOUR` = the most checks per hour and per server of the Masters
  outside Riot's list (default 1500; 0: they are not followed). At 1,500 each of the 23,000 such
  players of KR or EUW1 is checked about every 16 hours (every 3 hours on NA1 and VN2). The
  checks go before masteries and ranks on the platform host: a higher number checks more often
  and leaves less for those (about 800 requests an hour on KR at 1,500).
- `MASTERY_REFRESH_DAYS` = how old the masteries of a tracked player may get before they are
  fetched again (default 3; a first stored game on a champion fetches them at once).

### Operations

- **Deploy**: `git pull && docker compose up -d --build`.
- **Riot key**: edit `.env`, then `docker compose up -d worker` (a plain restart keeps the old key).
- **Backfill the previous patch**: set `COLLECT_PREVIOUS_PATCH=true` in `.env`, `docker compose
  up -d worker`; remove it and run the same command when done.
- **Logs**: `docker compose logs -f worker` (rotated, 3 × 10 MB per container); timers:
  `journalctl -u 'pickleague-*'`.
- **Backups**: none. The database is not backed up; a lost volume means collecting again.
- **Watchdog**: every 2 minutes `deploy/watchdog.sh` restarts a service that is down or unhealthy,
  or the worker when its heartbeat (`worker_status`) is over 5 minutes old.
- **Sockets**: every 5 minutes `deploy/sockets.sh` logs the worker's open HTTPS connections; they
  should stay flat.

## Web app (Vercel)

Vercel project with root directory `apps/web`, framework Next.js, install command
`bun install --frozen-lockfile`, and two server-only environment variables: `API_URL`
(`https://<PUBLIC_HOST>`) and `API_TOKEN`. Deploy with `vercel deploy --prod` from a clean export of
the repository (`git archive HEAD | tar -x -C <dir>`), or connect the project to GitHub.

### Desktop app

The helper runs on the computer where you play (Windows, macOS or Linux), next to the League
client — ideally on a second screen.

```sh
bun install
bun run dev:desktop      # opens the app; start League whenever you like
```

- It finds the League client by itself (and reconnects when the client restarts). During
  champion select it shows the best picks for your assigned role, each with its reasons
  (win-rate delta + number of games) and **your mastery level on the champion icon**; picks are
  ranked for your mastery of each champion (can be switched off in Settings). Banned, picked and
  not-owned champions are left out.
  Once the lane opponent is picked, each pick also says how the lane usually goes against it
  ("Lane phase: −420 gold · −8 CS · −310 XP at 10 min", 2v2 for the bot lane).
- When you lock in it switches to the build: the lane phase vs your lane opponent (at 10 and
  15 min), items in buy order (starting, early, core, situational, and for supports the quest
  upgrade to pick), runes, summoner spells and skill order, every element with its reasons.
  Under the situational items, "Late-game swaps" shows which completed item players of the
  champion sell once their build is full and what they buy instead, with the number of games and
  the average minute (no win rate: only players already winning a long game can afford one).
- **Until the game ends** it keeps that champion select on screen, marked "In game": your
  champion and role, both teams and the build as it was when champion select ended (nothing is
  fetched or applied again). It goes back to the tier list once the game is over; a dodged
  champion select is dropped right away. Opened mid-game, the app reads the teams from the client.
  If League closes its client during the game, the build stays until the client is back and
  says the game is over.
- Runes and summoner spells are **applied automatically when you lock in** (setting
  "Apply runes and spells on lock-in", on by default; an "Apply runes + spells" button does it
  by hand). If the client refuses, it tries again a few seconds later, up to 3 times. Runes go to a page named `PickLeague`; if every page slot holds one of your pages,
  the app warns you instead of deleting anything. Flash goes on the key chosen in settings
  ("Flash key", F by default); spell pairs without Flash keep the keys you already use.
- The header shows how fresh the API's stats are ("Stats updated 12 min ago", plus "+N new"
  when the worker stored matches the stats don't include yet). The API recomputes them every
  hour; picks and build reload when it is done. When data collection
  stopped on the server ("Riot key rejected" or "Collection stopped"), the header says so in red
  with the time since, and a line under it says the stats may be getting stale — nothing to do
  on your side (the server's admin fixes the key or restarts the worker with
  `docker compose up -d`).
- It never picks, bans, locks in or accepts for you, and never shows other players' names.
- **Tier list** (left rail, shown whenever you are not in champion select): best picks per lane
  with tier (S–D), win/pick/ban rates, confidence and your mastery; filter by server (all, KR,
  EUW, NA, VN), by rank (Diamond+, Master+, Grandmaster+, Challenger only — players' current rank), by
  confidence (Low+, Medium+, High — from sample size; the same choice also filters the
  champion's matchups, duos and synergies, the champion select picks and the draft planner's
  ranking), by name or owned champions; click a champion to open its details next to a compact table: best
  and worst lane matchups (with the lane gold difference at 10 min, e.g. "+250g @10"; CS, XP
  and sample on hover; not available with server/rank filters), duos and synergies (other
  allies; not available with server/rank filters) side by side — stacked when the window is narrow — each with "Show all", and a
  generic build. The
  app switches to champion select by itself when one starts (unless you are reading a
  champion's details); once you go back to the tier list it stays there until the next
  champion select.
- **Draft** (left rail): a draft planner that needs no League client. Play a ranked solo/duo
  draft by hand: 10 bans alternating Blue/Red (a ban can be skipped with "No ban"), then picks
  in the real order B1, R1, R2, B2, B3, R3, R4, B4, B5, R5. On each pick, choose the role being
  picked for (the team's first open role by default, or click an empty slot); the champion grid
  then ranks the remaining champions for that team and role (score from the same pick
  recommendations as in champion select, reasons on hover; champions with too little data come
  last, dimmed). Type in the search box and press Enter to take the first match. Undo steps
  back one action, Reset starts over. Click any drafted champion — once the draft is complete,
  or already during it — to see its build for this match, against the drafted enemies (lane
  phase, items, runes, spells, skill order). The draft is kept while you look at other views;
  a champion select starting switches to it as usual.

**API address.** By default the app talks to PickLeague's public gateway
(`https://pick-league.vercel.app/api/v1`), which forwards to the API: nothing to run on your
side. To use another API (e.g. `http://localhost:3000` in development), open Settings (gear
icon) and set its address. Settings are saved in
the app's user data folder (`settings.json`; if it ever gets corrupted, the app starts with the
defaults and keeps the broken file as `settings.json.corrupt`). `PICKLEAGUE_API_URL=http://localhost:3000` also overrides it for one
run. A settings file still holding the old default (`http://localhost:3000`) moves to the gateway.

**Window.** On Windows and Linux the app has no native title bar or menu: drag the window by
its header (double-click it to maximize) and use the minimize / maximize / close buttons at its
right end. **Zoom** (80–200%, handy on a large second screen) is in Settings; Ctrl + / Ctrl − /
Ctrl 0 and Ctrl + mouse wheel change it too, and it is remembered. macOS keeps its native title bar. In dev, `PICKLEAGUE_FORCE_FRAMELESS=1` applies the
Windows window setup on any OS; Ctrl/Cmd+R reloads and F12 opens the devtools.

**Keyboard.** Ctrl+K or Ctrl+F (Cmd on macOS) jumps to the tier list's champion search and
selects its text. Escape steps back, one step per press: in the search field it clears the text,
then leaves the field; then it closes the generic build page, then the champion's details; from
the champion select view it goes back to the tier list. In the draft planner both work on its
own search instead (Escape then closes the build shown; it never undoes a draft action). While
a menu, a select or Settings is open, Escape only closes that.

**Installers.** Windows: download `PickLeague-<version>-setup.exe` from the GitHub releases
(built by CI on `desktop-v*` tags; unsigned, so SmartScreen asks "More info" → "Run anyway").
`bun run --filter @pick-league/desktop package` builds an installer for the current OS into
`apps/desktop/dist/`.

**Updates.** From 0.2.0 on, the installed Windows app checks GitHub releases at startup and every few
hours, downloads a new version in the background and installs it when you quit (or right away
with "Restart" in the toast or in Settings, which also shows the version). Users of 0.1.0 must
download and run the 0.2.0 setup once by hand; later versions arrive automatically. The update
reads the repository's *latest* release, so it must be a published (not draft, not prerelease)
`desktop-v*` release carrying `latest.yml` and the `.blockmap` (the CI workflow uploads both).

**Troubleshooting.** "League client not found": start League (the app retries every few
seconds). "Cannot reach the API": check your connection and the address in Settings (default
`https://pick-league.vercel.app/api/v1`). "Riot key rejected" (server admin): put a valid key in
the server's `.env`, then run `docker compose up -d worker` (a plain restart keeps the old key).

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.3, and Docker for the database.

```sh
bun install
bun run check       # Biome lint + format check (bun run format to fix)
bun run typecheck   # tsc on every workspace
bun test            # unit tests (DB integration tests are skipped without DATABASE_URL_TEST)
```

### Database integration tests

```sh
bun run db:test:up  # throwaway postgres:17 container on localhost:55432 (data in tmpfs)
DATABASE_URL_TEST=postgres://postgres:postgres@localhost:55432/pickleague_test bun test
bun run db:test:down
```

### Running an app outside Docker

```sh
cp docker-compose.override.example.yml docker-compose.override.yml  # publishes Postgres on 127.0.0.1:5432
docker compose up -d postgres
bun run db:migrate   # optional: the apps also migrate at startup
bun run dev:worker   # or bun run dev:api
```

These commands read `DATABASE_URL` (and the other settings) from the root `.env`.

### API

`apps/api` (Bun + Hono) serves, on `PORT` (default 3000):

| Route | What |
|---|---|
| `GET /health` | `{ ok, db, latestPatch, matchCount }` |
| `GET /patches` | kept patches with match counts per platform |
| `GET /static/:patch` | champions, items, runes, stat shards, summoner spells (`latest` = newest patch) |
| `POST /recommendations/picks` | ranked champions for a role, with reasons; with a lane opponent, each candidate also gets a `lane_phase` reason (gold / CS / XP difference at 10 min, bot lane 2v2) right after its matchup |
| `POST /recommendations/build` | items, runes, summoner spells and skill order, with reasons; `lanePhase` (optional): `lane_phase` reasons at 10 and 15 min vs the lane opponent; `items.late`: up to 3 late items `{ itemId, games, share, reasons }` (most built after the core, with the share of the players who get that far); `items.lateSwaps`: up to 3 late-game swaps `{ sellItemId, buyItemId, games, minute }` (completed item sold once the build is full → completed item bought in its place; no win rate), often empty |
| `GET /stats/status` | `{ refreshing, lastRefreshedAt, lastRefreshDurationMs, matchesIncluded, matchesStored, pendingMatches, collection }`; `collection` = `{ state, platforms }`, `state` one of `collecting`, `key_rejected` (Riot rejects the key), `stalled` (no worker heartbeat for 3 min), `unknown` (no worker status yet); `platforms` = `[{ platform, heartbeatAt, authRejectedSince, lastError, lastErrorAt, lastMatchStoredAt }]` |
| `GET /tierlist?role=UTILITY&patch=latest&platform=ALL&rank=DIAMOND` | tier list of a role: tiers, win/pick/ban rates, confidence. Optional filters (echoed as `filters`): `platform` = `ALL` (default), `KR`, `EUW1`, `NA1`, `VN2`; `rank` = `DIAMOND` (Diamond+, default: every player of the stored games), `MASTER` (Master+), `GRANDMASTER` (Grandmaster+), `CHALLENGER` (Challenger only), on each counted player's current solo rank |
| `GET /tierlist/champion?role=UTILITY&championId=111&patch=latest` | one champion of the tier list: every lane matchup, duo partner and other ally (synergy) with 5+ matchups, best first, with shrunk win-rate delta, win rate, sample size and confidence; matchups also carry `lane` (gold / XP / CS difference at 10 min) when there are 20+ matchups with timeline frames. Same `platform`/`rank` filters; `synergies` is `null` and `lane` is omitted when filtered |

Errors are `{ error: { code, message, details? } }`: `400 BAD_REQUEST` (invalid body or query),
`401 UNAUTHORIZED` (missing or wrong token, only with `API_TOKEN`), `404 NOT_FOUND` (unknown route, patch or champion: the requested `championId` of a build or of
`/tierlist/champion`, including ids beyond the stored champion id range), `413 PAYLOAD_TOO_LARGE`
(POST body over 64 KB), `429 RATE_LIMITED`, `503 NO_DATA`. Champion ids inside lists (`allies`,
`enemies`, `bans`, `availableChampionIds`) that match no champion are ignored, never an error;
`availableChampionIds` holds at most 1000 ids.

Request/response types are in `packages/shared/src/api-contract.ts`. Every reason carries the
win-rate delta (after shrinkage) and its sample size; `patchesUsed` lists the patches used (the previous one counts as a prior worth
at most 5,000 games and is listed while it weighs at least 10 %). `lane_phase` reasons only
explain (delta 0, never in the score): `lane: { minute, gold, xp, cs, duo, games }` is the average
difference vs the lane opponent from the timeline frames (`stats_champion_lane_phase`), shrunk
toward 0 by sample size, 1v1 for top / jungle / mid and 2v2 for the bot lane (own + duo partner vs
both enemy bot laners).

The API owns the stats layer (`docs/database-schema.md`, Stats layer), refreshed in the background
every `STATS_REFRESH_MINUTES` (default 60) when matches changed: per-participant tables that a
refresh completes with the matches stored since the last one (builds, quest upgrades, lanes,
late-game swaps: `packages/db/migrations/0030_incremental_stats.sql`), then materialized views that
aggregate them, recomputed each time. A Postgres advisory lock keeps several API instances from
refreshing at the same time.
Engine weights and thresholds live in `apps/api/src/engine/config.ts`. The calibration script
prints, per kind of effect, the fitted weight of the engine's shrinkage for a grid of `k` (the `k`
to keep is the one with a weight of ~1): statistics from the earlier matches of the patch, the
latest 20 % by start time scored (`--test-share`), as the engine predicts later matches in
production; `--split hash` scores a random 1 match in 5 instead, which flatters the engine.

Settings (env): `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `CACHE_TTL_SECONDS` (600),
`RATE_LIMIT_PER_MINUTE` (120 per IP, 0 = off), `RATE_LIMIT_BURST` (30), `TRUST_PROXY` (use
`X-Forwarded-For`), `STATS_REFRESH_MINUTES` (60; 0 switches the refresh off), `API_TOKEN` (unset = no auth; when set, every
route but `GET /health` needs `Authorization: Bearer <API_TOKEN>`, else `401 UNAUTHORIZED`, and
the per-IP rate limit uses the visitor IP the gateway sends in `X-Client-IP`). No CORS: browsers
never call the API directly.

```sh
PORT=3001 bun run dev:api
# API tests use their own database (pickleague_api_test) on the DATABASE_URL_TEST server
DATABASE_URL_TEST=postgres://postgres:postgres@localhost:55432/pickleague_test bun test apps/api
# perf check: seeds synthetic matches into pickleague_api_perf, times refresh + requests
DATABASE_URL_TEST=... PERF_MATCHES=20000 bun run --filter @pick-league/api perf
# re-measure the engine's shrinkage constants on the stored matches (read-only, a few minutes)
docker compose build api && docker compose run --rm api bun run apps/api/scripts/calibrate.ts --patch 16.22
```

### Layout

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@pick-league/shared` | Domain types, platform routing, patch helpers, Riot DTOs, Data Dragon client, API contract |
| `packages/db` | `@pick-league/db` | SQL migrations, migration runner, Postgres client, typed queries |
| `apps/worker` | `@pick-league/worker` | Riot crawler |
| `apps/api` | `@pick-league/api` | HTTP API and recommendation engine |
| `apps/desktop` | `@pick-league/desktop` | Electron helper |

Migrations are plain SQL files in `packages/db/migrations/NNNN_name.sql`. They are applied in
order when the worker or the API starts. An advisory lock makes it safe for both to start at once.
