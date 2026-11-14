# PickLeague — Architecture (v1)

PickLeague helps one player (a support main, to start) pick the right champion in League of Legends champion select and then build it: items + buy order, runes, summoner spells, skill order — all adapted to the 9 other champions, **always showing the reasons** behind every recommendation.

Data comes from high-elo ranked solo/duo games (Challenger + Grandmaster + the top 1,000 Master players by LP — `MASTER_PLAYERS` — of KR, EUW1, NA1, VN2). Only the current patch is collected; the previous patch stays in the database (collected while it was current) until the next patch replaces it.

## Components

```
                ┌────────────── Docker Compose (laptop or VPS) ───────────────┐
Riot API ─────► │ apps/worker ──► Postgres 17 ◄── apps/api (HTTP :3000) ◄─────┼──── apps/desktop (Electron, native)
Data Dragon ──► │   (Bun)                          (Bun + Hono)               │        ▲
                └─────────────────────────────────────────────────────────────┘        │ LCU (local League client API)
                                                                                     League client
```

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@pick-league/shared` | Domain types, platform/routing maps, patch helpers, Data Dragon client, Riot DTO types, **API contract types** shared by api + desktop |
| `packages/db` | `@pick-league/db` | SQL migrations (source of truth = `docs/database-schema.md`), migration runner, `postgres` (porsager) client, typed query functions |
| `apps/worker` | `@pick-league/worker` | Riot crawler: rate limiter, priority scheduler, ingestion, patch detection, cleanup |
| `apps/api` | `@pick-league/api` | Read-only HTTP API: static data, pick + build recommendations (the "engine"), caching, per-IP rate limit, stats refresh |
| `apps/desktop` | `@pick-league/desktop` | Electron helper: reads champion select from the League client, shows picks + builds with reasons, auto-applies runes + summoner spells on lock-in |

Everything runs with `docker compose up -d` except the desktop app (it must reach the local League client). The whole stack must work on Linux, macOS and Windows, and be set up by someone with zero infra knowledge.

## Tooling

- Bun ≥ 1.3 workspaces (`packages/*`, `apps/*`), TypeScript strict, Biome, `bun test`.
- Root scripts: `check` (biome), `typecheck` (tsc -b or per package), `test`.
- Postgres client: `postgres` (porsager). No ORM; migrations are plain `.sql` files in `packages/db/migrations/NNNN_name.sql`, applied in order by a small runner that records them in `schema_migrations`. Migrations run automatically when the worker and the API start (idempotent, guarded by an advisory lock).

## Riot API facts the worker relies on

- **Hosts.** Platform host `https://{platform}.api.riotgames.com` (`kr`, `euw1`, `na1`, `vn2`) for league-v4, champion-mastery-v4. Regional host `https://{cluster}.api.riotgames.com` for match-v5 and account-v1. Match clusters: KR→`asia`, EUW1→`europe`, NA1→`americas`, VN2→`sea`. account-v1 is not served on `sea`: use `asia` for VN2 accounts.
- **Rate limits are enforced per host (routing value).** App limit (this key): 20 req / 1 s and 100 req / 2 min per host. Method limits also exist per endpoint. Read the real limits from `X-App-Rate-Limit`, `X-Method-Rate-Limit` (+ `-Count`) response headers rather than hardcoding; on `429` honour `Retry-After`. One limiter per host, so the 4 platforms + 4 clusters progress independently.
- **Never use a second API key** to go faster (Riot policy).
- Endpoints:
  - `GET /lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5`, `.../grandmasterleagues/...`, `.../masterleagues/...` (every Master player: the worker keeps the top ones by LP) → entries with `puuid`, `leaguePoints`, `wins`, `losses`.
  - `GET /lol/league/v4/entries/by-puuid/{puuid}` → solo rank of any player (low priority).
  - `GET /lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}`.
  - `GET /riot/account/v1/accounts/by-puuid/{puuid}` → `gameName`, `tagLine`.
  - `GET /lol/match/v5/matches/by-puuid/{puuid}/ids?queue=420&type=ranked&startTime={epochSeconds}&count=100`.
  - `GET /lol/match/v5/matches/{matchId}` and `.../{matchId}/timeline`.
- **Patch.** Data Dragon `https://ddragon.leagueoflegends.com/api/versions.json`, first entry is latest (`15.22.1`). A match's `info.gameVersion` (`15.22.715.1234`) belongs to patch `major.minor`. Data Dragon may lag the live patch by hours: a match from a patch newer than Data Dragon stays `PENDING` and is retried later.

## Worker

Long-running Bun process. Each platform runs its own loop; work is pulled from priority levels, highest first, as long as rate-limit budget allows:

1. **Ladder refresh** (once per hour per platform): Challenger + Grandmaster lists, plus the top `MASTER_PLAYERS` (default 1000) of the Master list by LP. More Master players is the lever for more data, not a longer history. Upsert `players` + `ladder_entries`. Players whose `wins + losses` changed (or are new) are marked "played".
2. **Match id listing** for "played" players, using `startTime = players.matches_synced_until` (first time: start of the current patch as far as we know, else 14 days ago), paginating until exhausted. New ids go to `match_fetch_queue`.
3. **Match + timeline fetch** from the queue. Parse, keep only schema fields, insert everything in one transaction (matches, teams, bans, participants + per-minute arrays, item/skill/kill/objective events, `players` rows for all 10 players with their Riot ID from the payload). Matches from a patch older than the current one → `SKIPPED_OLD_PATCH` before their timeline is fetched; the first one seen bounds every listing (older ids are skipped unfetched, and paginating stops there). Non-ladder players are enqueued into `player_enrichment_queue` (respecting the 7-day rule).
4. **Daily refresh of tracked ladder players**: account-v1 (Riot ID) + mastery, if older than 24 h.
5. **Lowest priority**: `player_enrichment_queue` → mastery + `entries/by-puuid` rank. Only when levels 1–4 have nothing ready.

Also, at least hourly: Data Dragon check → new patch row + static data ingest (champions, spells, items, runes, summoner spells, per patch); keep only the 2 latest patches (delete older patch rows → cascades; delete orphan non-tracked players). Every cycle writes a `worker_runs` row. Structured logs to stdout. Graceful shutdown on SIGTERM. Config via env: `RIOT_API_KEY`, `DATABASE_URL`, `PLATFORMS` (default `KR,EUW1,NA1,VN2`), `MASTER_PLAYERS` (default 1000, 0 = Challenger + Grandmaster only), `LOG_LEVEL`.

## API

Bun + Hono, port `3000`. Read-only on match data. Owns the stats layer: materialized views (added as migrations in `packages/db`) refreshed by the API on a timer when new matches arrived (`REFRESH MATERIALIZED VIEW CONCURRENTLY`). In-memory response cache (TTL ≈ 10 min) and a per-IP token bucket. CORS open (the desktop app calls it). Contract types live in `@pick-league/shared` (`api-contract.ts`).

Endpoints (v1):

- `GET /health` → `{ ok, db, latestPatch, matchCount }`.
- `GET /patches` → kept patches with match counts per platform.
- `GET /static/:patch` → champions (id, slug, name, tags, spells), items, runes, summoner spells — what the desktop needs to render icons/names. Image URLs are Data Dragon CDN URLs.
- `POST /recommendations/picks` — body: `{ role, allies: [{championId|null, role}], enemies: [championId|null], bans: number[], availableChampionIds?: number[] }` → ranked candidates `{ championId, score, confidence, patchesUsed, reasons: Reason[] }`.
- `POST /recommendations/build` — body: `{ championId, role, allies: [{championId, role}], enemies: [{championId, role|null}] }` → `{ patchesUsed, items: { starting, early, core, situational, questUpgrade? }, runes, summonerSpells, skillOrder }` (`questUpgrade`: supports only, the support quest upgrade to pick), every piece with `reasons: Reason[]`.
- `GET /tierlist?role=UTILITY&patch=latest` → `{ role, patch, filters, roleGames, entries }`: every champion of the role with ≥ `minCandidateGames`, scored by its win-rate delta vs the role average (shrunk like the picks engine), tiered S–D by score percentile (non-positive scores capped at B), with win/pick/ban rates, confidence, `patchesUsed` (per champion: the previous patch is added below the threshold). Ban rates come from the `stats_champion_bans` / `stats_patch_matches` views. Kept light (~15 KB per role): relations come from the next endpoint.
  - **Filters** `platform=ALL|KR|EUW1|NA1|VN2` (default `ALL`) and `rank=MASTER|GRANDMASTER|CHALLENGER` (default `MASTER` = "Master+"), echoed as `filters` in the response; the cache key includes them. Everything else (per-champion patch choice, percentile tiers, pick rate, `roleGames`) is computed the same way on the filtered rows.
    - Server: only matches of that platform (`matches.platform`).
    - Rank: applied per counted participant, on the player's **current** solo tier (`players.solo_tier` when the stats are refreshed — from the ladders for tracked players, from enrichment for the others — not the tier at match time). `GRANDMASTER` keeps participants whose player is Grandmaster or Challenger, `CHALLENGER` only Challenger ones. A matchup/duo row counts when the champion's own player qualifies (the opponent's/partner's rank is not looked at). `MASTER` counts every participant: the matches all come from Master+ ladder players, and the few participants currently below Master or with an unknown rank (≈1.3 % and <0.01 % of participants on the live data, Nov 2026) stay in the default view so it is the full sample; they are excluded by the two other rank filters.
    - Ban rate under filters: `(counted participants whose match banned the champion) / (counted participants)` — the share of the counted players' matches where it was banned, a match weighing once per counted player in it. With every participant counted (server filter only) that is exactly banned matches / matches of that server.
    - Default filters read the unfiltered views (same response as without filters). Other filters read `stats_tierlist_*` views (`0006_tierlist_filters.sql`), kept per (patch, platform, rank level) and summed at request time; they only hold lane-opponent and duo-partner pairs, which keeps them about the size of `stats_champion_vs` (all ally pairs would be ~3.4× bigger).
- `GET /tierlist/champion?role=UTILITY&championId=111&patch=latest` (same query as `/tierlist`, filters included, plus the champion) → `{ role, patch, filters, championId, patchesUsed, games, winRate, matchups, duos, synergies }`: fetched when a champion is selected in the tier list. Every lane opponent (`matchups`), duo partner (`duos`) and ally in the other roles (`synergies`) with ≥ `tierList.minRelationGames` (5) on the champion's `patchesUsed` (summed), as `{ championId, role, delta, winRate, games }`, sorted by shrunk delta (best first, worst last). Inline in `/tierlist` this would be ~1 MB per role. With server/rank filters, matchups and duos come from the filtered views and `synergies` is `null` (the filtered views have no other-ally pairs).

`Reason = { kind: 'matchup'|'duo'|'vs_comp'|'with_comp'|'base'|'item_swap'|..., label: string (human readable), delta: number (win-rate delta, e.g. +0.028), games: number }`.

### Engine (inside the API)

- **Picks** — for each candidate champion in the requested role, sum weighted win-rate deltas vs. the champion's own baseline, in the user's priority order:
  1. lane matchup (vs. the enemy in the same role, or all known enemies weighted if roles unknown),
  2. duo synergy (UTILITY↔BOTTOM, MIDDLE↔JUNGLE, TOP↔JUNGLE),
  3. vs. enemy composition traits,
  4. with ally composition traits.
  Each delta is shrunk toward 0 with empirical-Bayes style shrinkage (`delta * n / (n + k)`) so tiny samples can't dominate. Exclude banned and already-picked champions; if `availableChampionIds` is given, restrict to them. Confidence derives from sample sizes.
- **Composition traits** come from the data, not hand-written lists: per champion, average physical/magic/true damage share, damage taken + mitigated (tankiness), CC time, healing, plus Data Dragon tags and attack range. Team traits = aggregates of its 5 (or known) champions bucketed (e.g. "AD-heavy", "high CC", "high healing", "tanky", "poke/ranged").
- **Builds** — layered: (1) base = most common winning choices for champion+role (starter, boots, ordered core from `item_events` replayed with UNDO handling, ignoring consumables/trinkets/components), (2) adjusted for the lane opponent, (3) item swaps driven by enemy traits with data-backed deltas where samples allow, else Data Dragon item tags (anti-heal vs healing, armor vs AD-heavy, MR vs AP-heavy, tenacity/QSS vs CC, armor pen vs tanky). Same layering for runes (full page incl. shards), summoner spells, skill order (first 3 levels + max order). Each choice carries reasons.
- **Patch fallback** — use the current patch alone when the champion+role has ≥ a threshold of games (configurable, e.g. 150), else the current and previous patches combined (their games and wins summed); `patchesUsed` (newest first) is returned and shown.

## Desktop helper

Electron (via electron-vite) + React + TypeScript. UI with shadcn/ui on Base UI, initialised **exactly** with `bunx --bun shadcn@latest init --preset b5Ku0GIBG --pointer`; components are added only through the shadcn CLI.

- **LCU connection** (main process): find the running `LeagueClientUx` process and read `--app-port` / `--remoting-auth-token` from its command line (Windows: PowerShell `Get-CimInstance Win32_Process`; macOS/Linux: `ps`), falling back to the `lockfile` in the install dir. HTTPS with Riot's self-signed cert (trust it for `127.0.0.1` only), basic auth `riot:<token>`. Subscribe over WebSocket (WAMP, `OnJsonApiEvent_lol-champ-select_v1_session` and `OnJsonApiEvent_lol-gameflow_v1_gameflow-phase`). Reconnect when the client restarts.
- **Reads**: `/lol-champ-select/v1/session` (picks, bans, assigned positions, actions), `/lol-champions/v1/owned-champions-minimal`, `/lol-champion-mastery/v1/local-player/champion-mastery`, `/lol-summoner/v1/current-summoner`, `/lol-gameflow/v1/gameflow-phase` (a champion select that ends into a game stays shown, with its build, until the game ends), `/lol-gameflow/v1/session` (teams of a game already in progress when the app starts; player ids only matched against the user's own).
- **Writes (only these)**: rune page + summoner spells, **automatically when the local player locks in** (setting, on by default, can be switched off; also a manual "Apply" button). Rune page: create/replace one page named `PickLeague` via `/lol-perks/v1/pages`; if no slot is free and no `PickLeague` page exists, warn instead of deleting a user page. Spells: `PATCH /lol-champ-select/v1/session/my-selection` putting Flash on the key chosen in settings (D or F, F by default); a pair without Flash keeps the user's keys. **Never** pick, ban, lock in, accept, or reveal hidden player identities.
- **UI**: champion select view (allies/enemies/bans, my role), recommended picks with mastery badge on each champion icon and expandable reasons; build view (items in buy order, situational items, runes, spells, skill order) with reasons on every element; patch used + sample size; settings (API URL default `http://localhost:3000`, auto-apply toggle). Dark mode friendly. Icons from Data Dragon CDN.
- **Mock mode** (`PICKLEAGUE_MOCK_LCU=1` or a dev toggle): a fake LCU that replays a scripted champion select and the game after it, so the app can be developed and demoed without the League client.

## Docker

- `docker-compose.yml` at the root: `postgres` (postgres:17, named volume, healthcheck), `worker`, `api` (port `3000` published). Images built from a single multi-stage `Dockerfile` using `oven/bun`. `restart: unless-stopped`. `.env` provides `RIOT_API_KEY` (+ optional `POSTGRES_PASSWORD`, `PLATFORMS`).
- Also `docker-compose.dev.yml` or documented `bun run dev:*` scripts so each app can run outside Docker against the dockerised Postgres.
- `README.md`: setup in 3 steps (install Docker Desktop, copy `.env.example` → `.env` with the Riot key, `docker compose up -d`), how to run the desktop app, how to point it at a VPS (`http://<vps-ip>:3000`), troubleshooting.
