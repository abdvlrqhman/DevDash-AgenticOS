#!/usr/bin/env bash
# Installs Claude Code for every member from the Agent SDK package, so Chat mode (SDK) and CLI mode run the
# exact same binary. Versioned dirs + a `current` symlink; keeps the previous version for rollback. Run as root.
# Usage: claude-update.sh [version]   (default: latest)
set -euo pipefail
main() {
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
VER="${1:-$(npm view @anthropic-ai/claude-agent-sdk version)}"
[[ $VER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: $VER" >&2; exit 1; }
BASE=/opt/devdash/claude
DIR="$BASE/$VER"

if [[ ! -x $DIR/bin/claude ]]; then
  rm -rf "$DIR"
  install -d -o devdash-build -g devdash-build "$DIR"
  runuser -u devdash-build -- bash -c "cd '$DIR' && npm init -y >/dev/null && npm install '@anthropic-ai/claude-agent-sdk@$VER' --no-fund --no-audit --loglevel=error"
  chown -R root:root "$DIR" && chmod -R go-w "$DIR"
  bin=$(find "$DIR/node_modules/@anthropic-ai" -maxdepth 2 -type f -name claude -perm -u+x | head -1)
  [[ -n $bin ]] || { echo "no claude binary in the SDK package" >&2; exit 1; }
  install -d "$DIR/bin" && ln -sfn "$bin" "$DIR/bin/claude"
fi

"$DIR/bin/claude" --version >/dev/null # smoke test
ln -sfn "$DIR" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
ln -sfn "$BASE/current/bin/claude" /usr/local/bin/claude

# Members never self-update (it would fail on root-owned files); this script is the update path.
echo 'export DISABLE_AUTOUPDATER=1' > /etc/profile.d/devdash-claude.sh

# Keep the two newest versions.
ls -1dt "$BASE"/[0-9]*/ | tail -n +3 | xargs -r rm -rf
echo "claude: $("$BASE/current/bin/claude" --version)"
}
main "$@"
