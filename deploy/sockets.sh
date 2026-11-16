#!/usr/bin/env bash
# Samples the worker's open HTTPS connections (Riot), to check they stay flat over hours.
# Prints "<established> <other states>"; pickleague-sockets.timer logs it every 5 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
pid=$(docker inspect -f '{{.State.Pid}}' "$(docker compose ps -q worker)")
est=$(nsenter -t "$pid" -n ss -Htan state established '( dport = :443 )' | wc -l)
all=$(nsenter -t "$pid" -n ss -Htan '( dport = :443 )' | wc -l)
echo "worker sockets: established=$est total=$all"
