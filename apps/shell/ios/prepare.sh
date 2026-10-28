#!/usr/bin/env bash
# After `tauri ios init`, for a signed build: gives the generated Xcode project the Push
# Notifications entitlement exactly as the provisioning profile allows it (aps-environment development or production),
# and prints "<export method> <team ID>" for `tauri ios build`. The export method follows from the profile: development
# → debugging, ad hoc → release-testing, App Store → app-store-connect (TestFlight).
# Run from apps/shell on macOS with IOS_MOBILE_PROVISION (the base64 .mobileprovision) set. Used by app-release.yml.
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '%s' "$IOS_MOBILE_PROVISION" | base64 --decode > "$tmp/profile.mobileprovision"
security cms -D -i "$tmp/profile.mobileprovision" -o "$tmp/profile.plist"
get() { /usr/libexec/PlistBuddy -c "Print :$1" "$tmp/profile.plist" 2>/dev/null || true; }

id=$(node -p "require('./src-tauri/tauri.conf.json').identifier")
app_id=$(get Entitlements:application-identifier)
aps=$(get Entitlements:aps-environment)
team=$(get TeamIdentifier:0)
if [[ "$app_id" != *".$id" ]]; then
  echo "::error::The provisioning profile is for $app_id, but the app is $id. Make a profile for the App ID $id." >&2
  exit 1
fi
if [ -z "$aps" ]; then
  echo "::error::The provisioning profile has no Push Notifications. Turn on Push Notifications for the App ID $id, make the profile again, and update the IOS_MOBILE_PROVISION secret." >&2
  exit 1
fi

ent=$(find src-tauri/gen/apple -name '*_iOS.entitlements' -not -path '*/build/*' | head -1)
if [ -z "$ent" ]; then
  echo "::error::No entitlements file in src-tauri/gen/apple (run tauri ios init first)." >&2
  exit 1
fi
/usr/libexec/PlistBuddy -c "Delete :aps-environment" "$ent" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :aps-environment string $aps" "$ent"
echo "aps-environment = $aps in $ent" >&2

if [ -n "$(get ProvisionedDevices)" ]; then
  if [ "$aps" = development ]; then method=debugging; else method=release-testing; fi
else
  method=app-store-connect
fi
echo "$method $team"
