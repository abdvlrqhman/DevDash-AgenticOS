// Copied next to MainActivity by .github/workflows/app-release.yml (android/patch-manifest.mjs registers it).
package io.github.abdvlrqhman.devdash

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a reboot or an app update, background notifications come back on if they were on. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) NotifyService.start(context)
  }
}
