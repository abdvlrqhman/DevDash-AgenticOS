#!/usr/bin/env bash
# DevDash system setup (users, dirs, units, Caddy). Idempotent; activate.sh runs it on every deploy. Run as root.
# First install needs: --domain dev.example.com [--name "Space name"]
set -euo pipefail

DOMAIN="" NAME=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
REL="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE=/etc/devdash/devdash.env
CERTS=/etc/caddy/certs

# Service user (owns data, never builds) and build user (runs npm, sees no secrets).
id devdash &>/dev/null || useradd --system --home-dir /var/lib/devdash --shell /usr/sbin/nologin devdash
id devdash-build &>/dev/null || useradd --system --create-home --home-dir /var/cache/devdash-build --shell /usr/sbin/nologin devdash-build
install -d -m 700 -o devdash -g devdash /var/lib/devdash
install -d -m 750 -o root -g devdash /etc/devdash
install -d -m 755 /opt/devdash/releases
getent group devdash-users >/dev/null || groupadd devdash-users
# Shared git checkouts: every member can work in every project (setgid keeps the group, members' umask is 0002).
install -d -m 755 /srv/devdash
install -d -m 2775 -o root -g devdash-users /srv/devdash/projects /srv/devdash/worktrees /srv/devdash/files
command -v gh >/dev/null || apt-get install -yq gh >/dev/null
# Bun for members who switch claude-mem on (its worker runs on Bun and looks for /usr/local/bin/bun).
if [[ ! -x /usr/local/bin/bun ]]; then
  command -v unzip >/dev/null || apt-get install -yq unzip >/dev/null
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
fi

# rclone for members' own cloud storage: their sessions move big files to Google Drive with it.
# Pinned. The hashes were checked against rclone's GPG-signed SHA256SUMS (key FBF737ECE9F8AB18604BD2AC93935E02FF3B54FA)
# when this pin was set, so a download is trusted only if it matches them — not a checksum fetched alongside it.
RCLONE_VERSION=1.75.2
if [[ "$(/usr/local/bin/rclone version 2>/dev/null | head -1)" != "rclone v$RCLONE_VERSION" ]]; then
  case "$(uname -m)" in
    x86_64|amd64) RC_ARCH=amd64 RC_SHA=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702 ;;
    aarch64|arm64) RC_ARCH=arm64 RC_SHA=7e1e8d69654941b7b7df84ee74c5f7fb09cce7d5496947fb7bf16b55ff427d10 ;;
    *) echo "unsupported arch for rclone: $(uname -m)" >&2; RC_ARCH="" ;;
  esac
  if [[ -n $RC_ARCH ]]; then
    RC_TMP=$(mktemp -d)
    RC_ZIP="rclone-v${RCLONE_VERSION}-linux-${RC_ARCH}.zip"
    if curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/${RC_ZIP}" -o "$RC_TMP/$RC_ZIP" \
       && echo "$RC_SHA  $RC_TMP/$RC_ZIP" | sha256sum -c - >/dev/null; then
      command -v unzip >/dev/null || apt-get install -yq unzip >/dev/null
      unzip -qo "$RC_TMP/$RC_ZIP" -d "$RC_TMP"
      install -m 755 "$RC_TMP/rclone-v${RCLONE_VERSION}-linux-${RC_ARCH}/rclone" /usr/local/bin/rclone
    else
      echo "could not download/verify rclone $RCLONE_VERSION; members' cloud storage stays unavailable until it installs" >&2
    fi
    rm -rf "$RC_TMP"
  fi
fi

# Tailscale (static binaries only) for per-user userspace tailnet nodes. We never enable a
# host-level tailscaled; each member runs their own rootless userspace daemon inside their agent. Pinned and idempotent:
# skip when the pinned version is already installed. Guard against a system daemon that a package may have started.
TAILSCALE_VERSION=1.104.1
if [[ "$(/usr/local/bin/tailscale --version 2>/dev/null | head -1)" != "$TAILSCALE_VERSION" ]]; then
  case "$(uname -m)" in
    x86_64|amd64) TS_ARCH=amd64 ;;
    aarch64|arm64) TS_ARCH=arm64 ;;
    *) echo "unsupported arch for tailscale: $(uname -m)" >&2; TS_ARCH="" ;;
  esac
  if [[ -n $TS_ARCH ]]; then
    TS_TMP=$(mktemp -d)
    TS_TGZ="tailscale_${TAILSCALE_VERSION}_${TS_ARCH}.tgz"
    # Installs a root binary, so verify it against Tailscale's published SHA-256 before trusting it.
    if curl -fsSL "https://pkgs.tailscale.com/stable/$TS_TGZ" -o "$TS_TMP/$TS_TGZ" \
       && curl -fsSL "https://pkgs.tailscale.com/stable/$TS_TGZ.sha256" -o "$TS_TMP/$TS_TGZ.sha256" \
       && (cd "$TS_TMP" && echo "$(cat "$TS_TGZ.sha256")  $TS_TGZ" | sha256sum -c -); then
      tar -xzf "$TS_TMP/$TS_TGZ" -C "$TS_TMP"
      install -m 755 "$TS_TMP/tailscale_${TAILSCALE_VERSION}_${TS_ARCH}/tailscale" /usr/local/bin/tailscale
      install -m 755 "$TS_TMP/tailscale_${TAILSCALE_VERSION}_${TS_ARCH}/tailscaled" /usr/local/bin/tailscaled
    else
      echo "could not download/verify tailscale $TAILSCALE_VERSION; per-user tailnet will be unavailable until it installs" >&2
    fi
    rm -rf "$TS_TMP"
  fi
fi
# Never run a host-level tailscaled: a package install may have enabled one, so stop and mask it. Per-user userspace
# nodes use their own socket and need no system daemon.
if systemctl list-unit-files tailscaled.service >/dev/null 2>&1; then
  systemctl disable --now tailscaled.service >/dev/null 2>&1 || true
fi

if [[ ! -f $ENV_FILE ]]; then
  [[ -n $DOMAIN ]] || { echo "first install: pass --domain <domain>" >&2; exit 2; }
  (umask 027; cat > "$ENV_FILE" <<EOF
DEVDASH_ORIGIN=https://$DOMAIN
DEVDASH_SPACE_NAME=${NAME:-DevDash}
DEVDASH_DATA_DIR=/var/lib/devdash
DEVDASH_PORT=8787
DEVDASH_MASTER_KEY=$(openssl rand -base64 32)
DEVDASH_TRUST_CF_IP=1
EOF
  )
  chown root:devdash "$ENV_FILE" && chmod 640 "$ENV_FILE"
  echo "created $ENV_FILE (back it up: the master key decrypts every member's 2FA secret)"
fi
DOMAIN=$(sed -n 's|^DEVDASH_ORIGIN=https://||p' "$ENV_FILE")

# The root helper runs from a root-owned copy, installed before any npm build step can touch the release dir.
install -d -m 755 /usr/local/libexec
install -m 755 -o root -g root "$REL/deploy/helper/devdash-helper.mjs" /usr/local/libexec/devdash-helper.mjs
install -m 755 -o root -g root "$REL/deploy/backup.sh" /usr/local/libexec/devdash-backup.sh
install -m 755 -o root -g root "$REL/deploy/claude-update.sh" /usr/local/libexec/devdash-claude-update.sh
install -m 755 -o root -g root "$REL/deploy/self-deploy.sh" /usr/local/libexec/devdash-deploy.sh
for unit in system-devdash-agent.slice devdash-server.service devdash-helper.socket devdash-helper@.service devdash-agent@.socket devdash-agent@.service devdash-backup.service devdash-backup.timer devdash-claude-update.service devdash-deploy@.service; do
  install -m 644 "$REL/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
install -m 755 "$REL/deploy/devdash-cli" /usr/local/bin/devdash

# Caddy: domain via env, TLS mode from what's on disk.
install -m 644 "$REL/deploy/Caddyfile" /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=DEVDASH_DOMAIN=%s\n' "$DOMAIN" > /etc/systemd/system/caddy.service.d/devdash.conf
if [[ -f $CERTS/origin.crt && -f $CERTS/origin.key ]]; then
  {
    echo "tls $CERTS/origin.crt $CERTS/origin.key {"
    # Authenticated Origin Pulls: only add once it's switched on in Cloudflare, or every request fails.
    if [[ -f $CERTS/cloudflare-origin-pull-ca.pem ]]; then
      printf '\tclient_auth {\n\t\tmode require_and_verify\n\t\ttrust_pool file %s\n\t}\n' "$CERTS/cloudflare-origin-pull-ca.pem"
    fi
    echo "}"
  } > /etc/caddy/devdash-tls.caddy
else
  echo "tls internal" > /etc/caddy/devdash-tls.caddy # until the Cloudflare origin certificate is installed
fi
out=$(DEVDASH_DOMAIN=$DOMAIN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) || { echo "$out" >&2; exit 1; }

systemctl daemon-reload
systemctl enable -q --now devdash-helper.socket
systemctl enable -q devdash-server caddy
systemctl enable -q --now devdash-backup.timer
