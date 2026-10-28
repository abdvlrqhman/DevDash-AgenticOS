#!/usr/bin/env bash
# Deploys a commit of DevDash's own GitHub repository from the server itself, after an admin approved it in DevDash
# (Server page). Runs as root, as devdash-deploy@<commit>.service, so restarting the server doesn't stop it.
# Usage: devdash-deploy.sh <full commit id>. The commit must be on the repository's main branch.
set -euo pipefail
# Everything runs inside main(): bash parses it fully first, so nothing it fetches can alter what root executes next.
main() {
SHA="${1:?usage: devdash-deploy.sh <commit>}"
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo "not a full commit id: $SHA" >&2; exit 2; }
# Which repository: DEVDASH_REPO (owner/name on GitHub) in the server's settings, else DevDash's own.
REPO="$(sed -n 's/^DEVDASH_REPO=//p' /etc/devdash/devdash.env 2>/dev/null | tail -n 1)"
REPO="${REPO:-abdvlrqhman/DevDash-AgenticOS}"
[[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "DEVDASH_REPO is not owner/name: $REPO" >&2; exit 2; }
REL="/opt/devdash/releases/${SHA:0:12}"
[[ "$(readlink -f /opt/devdash/current 2>/dev/null || true)" != "$REL" ]] || { echo "${SHA:0:12} is already live" >&2; exit 3; }

# A private repository needs DevDash's read-only GitHub token (DEVDASH_GITHUB_TOKEN). git gets it in its environment,
# inside a subshell: never on a command line, in a config file, or in the environment of the build that runs next.
TOKEN="$(sed -n 's/^DEVDASH_GITHUB_TOKEN=//p' /etc/devdash/devdash.env 2>/dev/null | tail -n 1)"
github() (
  if [[ -n $TOKEN ]]; then
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'
    GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
    export GIT_CONFIG_VALUE_0
  fi
  git "$@"
)

# A root-only mirror: the build user (which runs npm) can't touch what root deploys next.
SRC=/var/lib/devdash-deploy/src.git
install -d -m 700 -o root -g root /var/lib/devdash-deploy
[[ -d $SRC ]] || github clone --quiet --bare "https://github.com/$REPO.git" "$SRC"
git -C "$SRC" remote set-url origin "https://github.com/$REPO.git"
github -C "$SRC" fetch --quiet --prune origin '+refs/heads/main:refs/heads/main'
unset TOKEN
git -C "$SRC" merge-base --is-ancestor "$SHA" refs/heads/main || { echo "${SHA:0:12} is not on $REPO's main branch" >&2; exit 3; }

echo "deploying ${SHA:0:12}: $(git -C "$SRC" log -1 --format=%s "$SHA")"
rm -rf "$REL"
mkdir -p "$REL"
git -C "$SRC" archive --format=tar "$SHA" | tar -x -C "$REL"
"$REL/deploy/activate.sh"
}
main "$@"
