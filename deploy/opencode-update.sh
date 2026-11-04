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

if [[ ! -x $DIR/bin/opencode ]]; then
  rm -rf "$DIR"
  install -d -o devdash-build -g devdash-build "$DIR"
  runuser -u devdash-build -- bash -c "cd '$DIR' && npm init -y >/dev/null && npm install '@opencode/cli@$VER' --no-fund --no-audit --loglevel=error"
  CLI="$DIR/node_modules/@opencode/cli"
  [[ -x $CLI/bin/opencode.exe ]] || { echo "no opencode binary in the package" >&2; exit 1; }
  # npm fetches every Linux x64 build (glibc, musl, baseline, ~240 MB each); its postinstall put the right one in bin/.
  rm -rf "$DIR"/node_modules/@opencode/cli-*
  chown -R root:root "$DIR" && chmod -R go-w "$DIR"
  install -d "$DIR/bin" && ln -sfn "$CLI/bin/opencode.exe" "$DIR/bin/opencode"
fi

"$DIR/bin/opencode" --version >/dev/null # smoke test
ln -sfn "$DIR" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
ln -sfn "$BASE/current/bin/opencode" /usr/local/bin/opencode

# Keep the two newest versions.
ls -1dt "$BASE"/[0-9]*/ | tail -n +3 | xargs -r rm -rf
echo "opencode: $("$BASE/current/bin/opencode" --version)"
}
main "$@"
