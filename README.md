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

_To be completed._

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
