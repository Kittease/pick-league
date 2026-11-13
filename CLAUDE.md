# PickLeague — agent instructions

Read `docs/architecture.md` (what we build, how) and `docs/database-schema.md` (approved schema) before working.

## Conventions

- TypeScript everywhere, `strict: true`. Bun is the runtime and package manager (`bun install`, `bun test`, `bunx`).
- Biome for lint + format (`bun run check` at the root). Code must pass it and `bun run typecheck` before each commit.
- Tests with `bun test`, next to the code (`*.test.ts`). Test behaviour through public interfaces; use fixtures, never call the real Riot API in tests.
- No secrets in the repo. The Riot key lives only in `.env` (git-ignored) and is only read by `apps/worker`.
- Never copy real player names/PUUIDs into fixtures or docs: use obviously fake values.

## Git

- Small focused commits, linear history.
- Commit message = **one line, no body**: `<gitmoji> <type>(<scope>): <subject>`, e.g. `✨ feat(worker): poll ladders to detect who played`, `🐛 fix(api): …`, `🔧 chore(docker): …`, `✅ test(engine): …`, `📝 docs: …`, `♻️ refactor(db): …`, `🎉 init: …`.
- **Never** add `Co-Authored-By` or any AI attribution trailer.
- Do not commit `bun.lock` on feature branches unless told to (the orchestrator regenerates it after merges).
