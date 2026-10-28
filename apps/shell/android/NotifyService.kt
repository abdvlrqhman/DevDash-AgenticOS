// Copied next to MainActivity by .github/workflows/app-release.yml (android/patch-manifest.mjs registers it).
package io.github.abdvlrqhman.devdash

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Notifications while DevDash is closed, without Google: one connection to the member's own DevDash server
 * (/api/notifications/stream), signed in with the app's own session cookie, shows what arrives. Android requires the
 * quiet "connected" notification while it runs. The app turns it on with notifications; it comes back after a reboot.
 */
class NotifyService : Service() {
  companion object {
    private const val CONNECTED_ID = 1
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("devdash-notify", Context.MODE_PRIVATE)

    fun enable(ctx: Context, origin: String) {
      prefs(ctx).edit().putString("origin", origin).putBoolean("on", true).apply()
      start(ctx)
    }

    fun disable(ctx: Context) {
      prefs(ctx).edit().putBoolean("on", false).apply()
      ctx.stopService(Intent(ctx, NotifyService::class.java))
    }

    fun enabled(ctx: Context) = prefs(ctx).getBoolean("on", false) && prefs(ctx).getString("origin", null) != null

    fun start(ctx: Context) {
      if (!enabled(ctx)) return
      val intent = Intent(ctx, NotifyService::class.java)
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
    }
  }

  @Volatile private var running = false
  private var worker: Thread? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    channels()
    val tap = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
    val connected = NotificationCompat.Builder(this, "connection")
      .setSmallIcon(R.drawable.ic_stat_devdash)
      .setContentTitle("DevDash is connected")
      .setContentText("So Claude and your team can reach you while the app is closed.")
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setOngoing(true)
      .setShowWhen(false)
      .setContentIntent(tap)
      .build()
    if (Build.VERSION.SDK_INT >= 34) startForeground(CONNECTED_ID, connected, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    else startForeground(CONNECTED_ID, connected)
    if (!running) {
      running = true
      worker = Thread({ loop() }, "devdash-notify").apply { isDaemon = true; start() }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    worker?.interrupt()
    super.onDestroy()
  }

  private fun channels() {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel("connection", "Connection", NotificationManager.IMPORTANCE_MIN).apply {
      description = "Keeps DevDash connected so notifications arrive while the app is closed."
      setShowBadge(false)
    })
    nm.createNotificationChannel(NotificationChannel("alerts", "Claude and your team", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "Claude needs you, Claude finished, errors, shared sessions."
    })
  }

  /** Holds the stream open; reconnects with backoff (1 s up to a minute), and waits longer while signed out. */
  private fun loop() {
    var backoff = 1_000L
    while (running) {
      val origin = prefs(this).getString("origin", null) ?: break
      try {
        val cookie = CookieManager.getInstance().getCookie(origin)
        if (cookie.isNullOrEmpty()) { Thread.sleep(60_000); continue }
        val since = prefs(this).getLong("since", 0)
        val c = URL("$origin/api/notifications/stream?since=$since").openConnection() as HttpURLConnection
        c.connectTimeout = 20_000
        c.readTimeout = 90_000 // the server writes at least every 25 s
        c.setRequestProperty("Cookie", cookie)
        c.setRequestProperty("Accept", "text/event-stream")
        c.setRequestProperty("Accept-Encoding", "identity") // uncompressed, so each event arrives as it's sent
        when (c.responseCode) {
          200 -> {
            backoff = 1_000L
            c.inputStream.bufferedReader().use { r ->
              val data = StringBuilder()
              while (running) {
                val line = r.readLine() ?: break
                if (line.startsWith("data:")) data.append(line.substring(5).trim())
                else if (line.isEmpty() && data.isNotEmpty()) {
                  show(origin, JSONObject(data.toString()))
                  data.setLength(0)
                }
              }
            }
          }
          401, 403 -> { c.disconnect(); Thread.sleep(300_000); continue } // signed out here: try again later
        }
        c.disconnect()
      } catch (e: InterruptedException) {
        break
      } catch (e: Exception) {
        // offline, server restarting, network change: retry below
      }
      try { Thread.sleep(backoff) } catch (e: InterruptedException) { break }
      backoff = minOf(backoff * 2, 60_000L)
    }
    stopSelf()
  }

  private fun show(origin: String, e: JSONObject) {
    val id = e.optLong("id")
    if (id > 0) prefs(this).edit().putLong("since", id).apply()
    if (!e.has("title")) return
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    val open = Intent(this, MainActivity::class.java)
      .setAction(Intent.ACTION_VIEW)
      .setData(Uri.parse(origin + e.optString("url", "/")))
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val tap = PendingIntent.getActivity(this, id.toInt(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val body = e.optString("body")
    val n = NotificationCompat.Builder(this, "alerts")
      .setSmallIcon(R.drawable.ic_stat_devdash)
      .setContentTitle(e.optString("title"))
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(tap)
      .build()
    NotificationManagerCompat.from(this).notify(e.optString("tag", "devdash"), 0, n)
  }
}
