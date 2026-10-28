#!/usr/bin/env bash
# After `tauri android init`: DevDash's own Android code (back button, background notifications, new windows, downloads) goes into the
# generated project. Run from apps/shell. Used by the release and the emulator-check workflows.
set -euo pipefail
main=$(find src-tauri/gen/android -name MainActivity.kt | head -1)
cp android/MainActivity.kt android/NotifyService.kt android/BootReceiver.kt android/NewWindows.kt android/Downloads.kt "$(dirname "$main")/"
app=$(find src-tauri/gen/android -path '*/app/src/main/AndroidManifest.xml' | head -1)
mkdir -p "$(dirname "$app")/res/drawable"
cp android/res/drawable/ic_stat_devdash.xml "$(dirname "$app")/res/drawable/"
node android/patch-manifest.mjs "$app"
