#!/usr/bin/env bash
# Installs OpenCode (version 2, the @opencode/cli package) for every member. DevDash drives it over ACP (`opencode acp`,
# apps/agent/src/harness.ts), so Chat mode and CLI mode run the same binary, and no SDK is needed. Versioned dirs + a
# `current` symlink; keeps the previous version for rollback. Run as root.
# Usage: opencode-update.sh [version]   (default: latest)
set -euo pipefail
main() {
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
VER="${1:-$(npm view @opencode/cli version)}"
[[ $VER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: $VER" >&2; exit 1; }
BASE=/opt/devdash/opencode
DIR="$BASE/$VER"

# A version installed before runs, or is installed again from scratch (a half-done install is never kept).
if ! "$DIR/bin/opencode" --version >/dev/null 2>&1; then
  rm -rf "$DIR"
  install -d -o devdash-build -g devdash-build "$DIR"
  # No package scripts (servers often turn them off, and only one is needed): npm installs, then the build user runs
  # OpenCode's own postinstall, which puts the binary for this machine (glibc or musl, AVX2 or not) in bin/.
  runuser -u devdash-build -- bash -c "cd '$DIR' && npm init -y >/dev/null && npm install '@opencode/cli@$VER' --ignore-scripts --no-fund --no-audit --loglevel=error && node node_modules/@opencode/cli/postinstall.mjs"
  CLI="$DIR/node_modules/@opencode/cli"
  # npm fetches every Linux x64 build (~240 MB each); the postinstall linked the right one into bin/.
  rm -rf "$DIR"/node_modules/@opencode/cli-*
  chown -R root:root "$DIR" && chmod -R go-w "$DIR"
  install -d "$DIR/bin" && ln -sfn "$CLI/bin/opencode.exe" "$DIR/bin/opencode"
  "$DIR/bin/opencode" --version >/dev/null || { rm -rf "$DIR"; echo "opencode $VER doesn't run here: removed it, nothing changed" >&2; exit 1; }
fi
ln -sfn "$DIR" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
# The `opencode` command in members' shells, unless one is there already that isn't DevDash's (a member's own install,
# with its own version): that one stays. DevDash itself always runs $BASE/current/bin/opencode.
LINK=/usr/local/bin/opencode
if [[ ! -e $LINK || "$(readlink -f "$LINK")" == "$BASE"/* ]]; then
  ln -sfn "$BASE/current/bin/opencode" "$LINK"
else
  echo "kept the existing $LINK ($(readlink -f "$LINK")); DevDash uses $BASE/current/bin/opencode"
fi

# Keep the two newest versions.
ls -1dt "$BASE"/[0-9]*/ | tail -n +3 | xargs -r rm -rf
echo "opencode: $("$BASE/current/bin/opencode" --version)"
}
main "$@"
