#!/usr/bin/env bash
# Allow HTTPS (443, and 8443 for the services site) only from Cloudflare's published IP ranges. Idempotent. Run as root.
set -euo pipefail

ranges="$(curl -fsSL https://www.cloudflare.com/ips-v4; echo; curl -fsSL https://www.cloudflare.com/ips-v6)"
[[ $(grep -c . <<<"$ranges") -gt 10 ]] || { echo "could not fetch Cloudflare ranges" >&2; exit 1; }

# ponytail: only adds ranges; Cloudflare rarely drops one. Diff and delete stale rules if that ever matters.
while read -r cidr; do
  [[ -n $cidr ]] || continue
  for port in 443 8443; do ufw allow proto tcp from "$cidr" to any port "$port" comment cloudflare >/dev/null; done
done <<<"$ranges"
echo "cloudflare: $(grep -c . <<<"$ranges") ranges allowed on 443 and 8443"
