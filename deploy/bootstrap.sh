#!/usr/bin/env bash
# DevDash host bootstrap (Phase 0) for a fresh Ubuntu 24.04 server. Idempotent. Run as root.
# Usage: bootstrap.sh <admin-user> "<ssh-public-key>"
set -euo pipefail

ADMIN="${1:?usage: bootstrap.sh <admin-user> \"<ssh-public-key>\"}"
PUBKEY="${2:?missing ssh public key}"
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $ADMIN =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "invalid username: $ADMIN" >&2; exit 1; }
[[ $PUBKEY =~ ^ssh-(ed25519|rsa)\  ]] || { echo "not an ssh public key" >&2; exit 1; }
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || echo "warning: only tested on Ubuntu 24.04" >&2

export DEBIAN_FRONTEND=noninteractive
step() { printf '\n== %s\n' "$*"; }

step "packages"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg git tmux ufw unattended-upgrades \
  bubblewrap socat sqlite3 jq build-essential python3 gh debian-keyring debian-archive-keyring apt-transport-https
install -d -m 755 /etc/apt/keyrings

step "node 24"
if ! node -v 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q && apt-get install -yq nodejs
fi
node -v

step "caddy"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi
caddy version

step "hostname resolves"
grep -qw "$(hostname)" /etc/hosts || echo "127.0.1.1 $(hostname)" >> /etc/hosts

step "swap (4G)"
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-devdash.conf && sysctl -q -p /etc/sysctl.d/99-devdash.conf

step "admin user: $ADMIN"
id "$ADMIN" &>/dev/null || adduser --disabled-password --gecos "" "$ADMIN"
usermod -aG sudo "$ADMIN"   # sudo works once the admin sets a Linux password (passwd $ADMIN)
add_key() { # <home> <owner>
  install -d -m 700 -o "$2" -g "$2" "$1/.ssh"
  touch "$1/.ssh/authorized_keys"
  grep -qxF "$PUBKEY" "$1/.ssh/authorized_keys" || echo "$PUBKEY" >> "$1/.ssh/authorized_keys"
  chown "$2:$2" "$1/.ssh/authorized_keys" && chmod 600 "$1/.ssh/authorized_keys"
}
add_key "/home/$ADMIN" "$ADMIN"
add_key /root root

step "ssh: keys only"
cat > /etc/ssh/sshd_config.d/00-devdash.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload-or-restart ssh
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '

step "firewall"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment ssh >/dev/null
"$(dirname "$0")/ufw-cloudflare.sh"
ufw --force enable
ufw status | head -5

step "unattended upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

step "bubblewrap userns (Claude Code sandbox)"
if [[ $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0) == 1 ]]; then
  cat > /etc/apparmor.d/bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
  apparmor_parser -r /etc/apparmor.d/bwrap
fi
sudo -u "$ADMIN" bwrap --ro-bind / / true && echo "bwrap OK"

step "done"
