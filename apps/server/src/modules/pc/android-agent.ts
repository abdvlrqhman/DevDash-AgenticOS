import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallerParams } from './windows-agent.ts'

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function renderAndroidAgentScript(): string {
  return readFileSync(join(import.meta.dirname, 'android-agent.mjs'), 'utf8')
}

export function renderAndroidInstallerScript(p: InstallerParams): string {
  const agentBase64 = Buffer.from(renderAndroidAgentScript(), 'utf8').toString('base64')
  const configJson = JSON.stringify(
    {
      pcName: p.pcName,
      platform: 'android',
      tailscaleIp: p.tailscaleIp,
      vpsTailscaleIp: p.vpsTailscaleIp,
      port: p.port,
      token: p.token,
      allowShell: p.allowShell,
      adbTarget: '',
    },
    null,
    2,
  )
  const configBase64 = Buffer.from(configJson, 'utf8').toString('base64')

  return [
    '#!/data/data/com.termux/files/usr/bin/bash',
    'set -euo pipefail',
    '',
    'echo ""',
    'echo "=== DevDash Android Computer Use Installer (Termux + Tailscale-Only) ==="',
    `echo "Binds strictly to ${p.tailscaleIp}:${p.port} and accepts ONLY your DevDash VPS (${p.vpsTailscaleIp})."`,
    'echo ""',
    '',
    '# 1. Ensure Node.js and android-tools (adb) are installed in Termux',
    'if ! command -v node >/dev/null 2>&1 || ! command -v adb >/dev/null 2>&1; then',
    '  echo "Installing nodejs and android-tools in Termux..."',
    '  pkg update -y && pkg install -y nodejs android-tools',
    'fi',
    '',
    '# 2. Write agent & locked config into ~/.devdash-android',
    'DIR="$HOME/.devdash-android"',
    'mkdir -p "$DIR"',
    'chmod 700 "$DIR"',
    `printf '%s' ${shQuote(agentBase64)} | base64 -d > "$DIR/agent.mjs"`,
    `printf '%s' ${shQuote(configBase64)} | base64 -d > "$DIR/config.json"`,
    'chmod 700 "$DIR/agent.mjs"',
    'chmod 600 "$DIR/config.json"',
    '',
    '# 3. Create start / stop / pair-adb helpers',
    'cat <<\x27STOP\x27 > "$DIR/stop.sh"',
    '#!/data/data/com.termux/files/usr/bin/bash',
    'pkill -f "$HOME/.devdash-android/agent.mjs" 2>/dev/null || true',
    'echo "DevDash Android Agent stopped."',
    'STOP',
    'chmod 700 "$DIR/stop.sh"',
    '',
    'cat <<\x27START\x27 > "$DIR/start.sh"',
    '#!/data/data/com.termux/files/usr/bin/bash',
    'DIR="$HOME/.devdash-android"',
    '"$DIR/stop.sh" >/dev/null 2>&1 || true',
    'nohup node "$DIR/agent.mjs" "$DIR/config.json" > "$DIR/agent.log" 2>&1 &',
    'sleep 1',
    'echo "DevDash Android Agent started (log: $DIR/agent.log)"',
    'tail -n 5 "$DIR/agent.log" || true',
    'START',
    'chmod 700 "$DIR/start.sh"',
    '',
    'cat <<\x27PAIR\x27 > "$DIR/pair-adb.sh"',
    '#!/data/data/com.termux/files/usr/bin/bash',
    'set -euo pipefail',
    'echo ""',
    'echo "=== Pair Android Wireless Debugging (Split-Screen with Settings -> Developer Options -> Wireless Debugging) ==="',
    'read -p "1) Tap [Pair device with pairing code] and enter Pairing Port (e.g. 37123): " PAIR_PORT',
    'read -p "2) Enter 6-digit Pairing Code: " PAIR_CODE',
    'adb pair "127.0.0.1:${PAIR_PORT}" "${PAIR_CODE}"',
    'read -p "3) Now enter the main Wireless Debugging Port shown on the Wireless Debugging screen (e.g. 41234): " CONN_PORT',
    'adb connect "127.0.0.1:${CONN_PORT}"',
    'adb devices',
    'echo ""',
    'echo "ADB connected! Your AI agents can now see and control your Android screen over Tailscale."',
    'PAIR',
    'chmod 700 "$DIR/pair-adb.sh"',
    '',
    '# 4. Verify Tailscale IP & start agent',
    '"$DIR/start.sh"',
    'echo ""',
    'echo "Next step for full screen + touch + UI tree control:"',
    'echo "  Run: ~/.devdash-android/pair-adb.sh"',
    'echo "Turning off Tailscale on Android or running ~/.devdash-android/stop.sh cuts access immediately."',
    '',
  ].join('\n')
}
