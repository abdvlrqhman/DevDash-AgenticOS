#!/usr/bin/env bash
# Ships the committed HEAD to a server over SSH (as root) and activates it.
# Usage: deploy/deploy.sh <ssh-host> [--domain dev.example.com --name "Space"]   (flags only needed the first time)
set -euo pipefail
HOST="${1:?usage: deploy/deploy.sh <ssh-host> [--domain <domain>] [--name <space name>]}"
shift
cd "$(git rev-parse --show-toplevel)"
SHA="$(git rev-parse --short=12 HEAD)"
[[ -z $(git status --porcelain) ]] || echo "note: uncommitted changes are not deployed (shipping $SHA)" >&2
REL="/opt/devdash/releases/$SHA"

git archive --format=tar HEAD | ssh "$HOST" "set -e; rm -rf '$REL'; mkdir -p '$REL'; tar -x -C '$REL'"
ARGS=""
[[ $# -gt 0 ]] && ARGS="$(printf '%q ' "$@")"
ssh "$HOST" "'$REL/deploy/activate.sh' $ARGS"
