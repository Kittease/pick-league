# PickLeague

PickLeague helps you pick the right champion in League of Legends champion select, then build it:
items and buy order, runes, summoner spells and skill order, adapted to the 9 other champions.
Every recommendation shows its reasons. The data comes from high-elo ranked solo/duo games
(Challenger + Grandmaster of KR, EUW, NA and VN) on the current and previous patch.

It has three parts:

- **worker**: collects matches from the Riot API into Postgres.
- **api**: serves static data and recommendations over HTTP (port 3000).
- **desktop**: an Electron app that reads your champion select from the League client and shows picks and builds.

The worker, the API and Postgres all run with Docker. The desktop app runs on your machine.

See [docs/architecture.md](docs/architecture.md) and [docs/database-schema.md](docs/database-schema.md).

## Setup (no infra knowledge needed)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
2. Copy `.env.example` to `.env`, then paste your Riot API key (from <https://developer.riotgames.com>) into `RIOT_API_KEY`.
3. Run `docker compose up -d` in this folder.

The API is then available at <http://localhost:3000>. Data collection starts right away, and
recommendations improve as matches come in. Use `docker compose logs -f worker` to follow
progress and `docker compose down` to stop everything (your data is kept).

If port 3000 is already taken, set `API_PORT=3001` in `.env`.

### Desktop app

The helper runs on the computer where you play (Windows, macOS or Linux), next to the League
client — ideally on a second screen.

```sh
bun install
bun run dev:desktop      # opens the app; start League whenever you like
```

- It finds the League client by itself (and reconnects when the client restarts). During
  champion select it shows the best picks for your assigned role, each with its reasons
  (win-rate delta + number of games) and **your mastery level on the champion icon**. Banned,
  picked and not-owned champions are left out.
- When you lock in it switches to the build: items in buy order (starting, early, core,
  situational), runes, summoner spells and skill order, every element with its reasons.
- Runes and summoner spells are **applied automatically when you lock in** (setting
  "Apply runes and spells on lock-in", on by default; an "Apply runes + spells" button does it
  by hand). Runes go to a page named `PickLeague`; if every page slot holds one of your pages,
  the app warns you instead of deleting anything. Flash stays on the key you already use.
- It never picks, bans, locks in or accepts for you, and never shows other players' names.

**API address.** By default the app talks to `http://localhost:3000` (the Docker stack on the
same computer). If the stack runs on a server, open Settings (gear icon) and set
`http://<vps-ip>:3000` — the port must be reachable from your computer. Settings are saved in
the app's user data folder. `PICKLEAGUE_API_URL=http://<vps-ip>:3000` also overrides it for one
run.

**Demo mode, without League.** `bun run dev:desktop:mock` (or the "Demo mode" switch in
Settings) replays a scripted champion select with a fake account, fake owned champions and
mastery, and fake rune pages. To also run without the API stack, start the dev-only fake API,
which answers with made-up numbers in the contract's shape:

```sh
cd apps/desktop
bun run fake-api                                     # http://localhost:3000 (PORT=3100 to change)
PICKLEAGUE_API_URL=http://localhost:3100 bun run dev:mock   # if you changed the port
```

**Installers.** `bun run --filter @pick-league/desktop package` builds an installer for the
current OS into `apps/desktop/dist/` (unsigned).

**Troubleshooting.** "League client not found": start League (the app retries every few
seconds). "Cannot reach the API": check the address in Settings and that `docker compose ps`
shows the api running. "No data yet": the worker needs time to collect matches.

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
| `POST /recommendations/picks` | ranked champions for a role, with reasons |
| `POST /recommendations/build` | items, runes, summoner spells and skill order, with reasons |

Request/response types are in `packages/shared/src/api-contract.ts`. Every reason carries the
win-rate delta (after shrinkage) and its sample size; `patchUsed` says when the previous patch was used.

The API owns the stats layer: materialized views (`packages/db/migrations/0002_stats_views.sql`)
refreshed in the background every `STATS_REFRESH_MINUTES` (default 15) when matches changed.
Engine weights and thresholds live in `apps/api/src/engine/config.ts`.

Settings (env): `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `CACHE_TTL_SECONDS` (600),
`RATE_LIMIT_PER_MINUTE` (120 per IP, 0 = off), `RATE_LIMIT_BURST` (30), `TRUST_PROXY` (use
`X-Forwarded-For`), `STATS_REFRESH_MINUTES` (15).

```sh
PORT=3001 bun run dev:api
# API tests use their own database (pickleague_api_test) on the DATABASE_URL_TEST server
DATABASE_URL_TEST=postgres://postgres:postgres@localhost:55432/pickleague_test bun test apps/api
# perf check: seeds synthetic matches into pickleague_api_perf, times refresh + requests
DATABASE_URL_TEST=... PERF_MATCHES=20000 bun run --filter @pick-league/api perf
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
