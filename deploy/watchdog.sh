#!/usr/bin/env bash
# Restarts a service that is unhealthy, not running, or (worker) has not heartbeated for 5 min.
# Runs every 2 minutes (pickleague-watchdog.timer); what it does lands in the journal.
set -uo pipefail
cd "$(dirname "$0")/.."
for svc in postgres api worker caddy; do
  id=$(docker compose ps -aq "$svc")
  [ -z "$id" ] && continue
  state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
  case "$state" in
    "running "|"running healthy"|"running starting") ;;
    *) echo "watchdog: $svc is '$state', restarting"; docker compose up -d "$svc" ;;
  esac
done
# The worker has no HTTP endpoint: its platform loops heartbeat into worker_status every 30 s.
# Only judged once it has been up for 5 minutes (the rows may be older than its start).
wid=$(docker compose ps -q worker)
[ -z "$wid" ] && exit 0
started=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$wid")" +%s)
[ $(( $(date +%s) - started )) -lt 300 ] && exit 0
age=$(docker compose exec -T postgres psql -U pickleague -d pickleague -tAc \
  "select coalesce(extract(epoch from now() - max(heartbeat_at))::int, -1) from worker_status" 2>/dev/null)
if [ -n "$age" ] && [ "$age" -gt 300 ]; then
  echo "watchdog: worker heartbeat ${age}s old, restarting it"
  docker compose restart worker
fi
