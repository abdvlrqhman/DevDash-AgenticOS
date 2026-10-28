#!/usr/bin/env bash
# Builds this release, switches /opt/devdash/current to it, health-checks, rolls back on failure. Run as root.
# Usage: activate.sh [install.sh args]
set -euo pipefail
# Everything runs inside main(): bash parses it fully first, so a build step can't alter what root executes next.
main() {
REL="$(cd "$(dirname "$0")/.." && pwd)"
CURRENT=/opt/devdash/current

"$REL/deploy/install.sh" "$@"

# Build as the unprivileged build user, then make the release read-only for everyone else.
chown -R devdash-build:devdash-build "$REL"
runuser -u devdash-build -- bash -c "cd '$REL' && npm ci --no-fund --no-audit --loglevel=error && npm run build --silent && npm prune --omit=dev --no-fund --no-audit --loglevel=error"
chown -R root:root "$REL"
chmod -R go-w "$REL"

PREV="$(readlink -f "$CURRENT" 2>/dev/null || true)"
switch_to() { ln -sfn "$1" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"; }
healthy() {
  for _ in $(seq 1 20); do
    curl -fsS http://127.0.0.1:8787/.well-known/devdash.json >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

switch_to "$REL"
systemctl restart devdash-server
systemctl reload-or-restart caddy
if ! healthy; then
  echo "health check failed; recent logs:" >&2
  journalctl -u devdash-server -n 30 --no-pager >&2
  if [[ -n $PREV && $PREV != "$REL" ]]; then
    switch_to "$PREV" && systemctl restart devdash-server
    echo "rolled back to $(basename "$PREV")" >&2
  fi
  exit 1
fi

# Agents pick up new code on their own: the new server asks them to restart once no Claude turn is running.
# tmux (terminals, CLI sessions) survives agent restarts because of KillMode=process.

# Keep the 5 newest releases.
ls -1dt /opt/devdash/releases/*/ | tail -n +6 | xargs -r rm -rf
echo "live: $(basename "$REL")"
}
main "$@"
