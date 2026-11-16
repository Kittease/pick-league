#!/usr/bin/env bash
# Installs the systemd timers (backup, watchdog, socket sampling). Run once with sudo.
set -euo pipefail
cp "$(dirname "$0")"/systemd/*.service "$(dirname "$0")"/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pickleague-backup.timer pickleague-watchdog.timer pickleague-sockets.timer
