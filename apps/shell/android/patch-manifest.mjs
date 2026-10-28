// Registers the background-notification service and boot receiver in the generated Android manifest.
// usage (CI, after `tauri android init`): node android/patch-manifest.mjs <path to app/src/main/AndroidManifest.xml>
import { readFileSync, writeFileSync } from 'node:fs'

const [file] = process.argv.slice(2)
let m = readFileSync(file, 'utf8')
if (!m.includes('<application') || !m.includes('</application>')) throw new Error(`no <application> in ${file}`)
const perms = ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_REMOTE_MESSAGING', 'POST_NOTIFICATIONS', 'RECEIVE_BOOT_COMPLETED']
  .filter((p) => !m.includes(`"android.permission.${p}"`))
  .map((p) => `<uses-permission android:name="android.permission.${p}" />`)
m = m.replace('<application', `${perms.join('\n    ')}\n    <application`)
m = m.replace('</application>', `<service android:name=".NotifyService" android:exported="false" android:foregroundServiceType="remoteMessaging" />
        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>
    </application>`)
writeFileSync(file, m)
console.log(`patched ${file}`)
