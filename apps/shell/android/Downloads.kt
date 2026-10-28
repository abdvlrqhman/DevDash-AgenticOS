// Copied into the generated project by android/prepare.sh. MainActivity installs it.
// Downloads from the space (a Download button, a file the server sends as an attachment) go to the phone's Downloads
// through the system's download manager, signed in with the app's cookie: it shows progress, and a notification that
// opens the file. Without this the WebView drops them. Files made in the page itself (blob: links) can't be fetched
// from outside it, so the page hands over their bytes (window.DevDashAndroid.saveFile*, web lib/download.ts).
package io.github.abdvlrqhman.devdash

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.webkit.WebView
import android.widget.Toast
import java.io.File
import java.io.OutputStream
import java.net.URLDecoder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

object Downloads {
  fun install(webView: WebView) {
    webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
      val scheme = Uri.parse(url).scheme
      if (scheme == "https" || scheme == "http") fromServer(webView.context, url, userAgent, contentDisposition, mimeType)
    }
  }

  private fun fromServer(context: Context, url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
    val name = fileName(url, contentDisposition, mimeType)
    try {
      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle(name)
        .setMimeType(typeOf(name, mimeType))
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
      CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
      if (userAgent != null) request.addRequestHeader("User-Agent", userAgent)
      // Android 10 on: the shared Downloads folder, no permission needed. Before: the app's own, listed in Downloads.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
      else request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
      (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
      say(context, "Downloading $name")
    } catch (e: Exception) {
      say(context, "Couldn't download $name")
    }
  }

  /** The server's name for the file (RFC 6266: filename*, then filename), else one guessed from the address. */
  fun fileName(url: String, contentDisposition: String?, mimeType: String?): String {
    val cd = contentDisposition ?: ""
    val encoded = Regex("""filename\*\s*=\s*UTF-8''([^;\s]+)""", RegexOption.IGNORE_CASE).find(cd)?.groupValues?.get(1)
      ?.let { runCatching { URLDecoder.decode(it.replace("+", "%2B"), "UTF-8") }.getOrNull() }
    val plain = Regex("""filename\s*=\s*"([^"]*)"""", RegexOption.IGNORE_CASE).find(cd)?.groupValues?.get(1)
    return clean(encoded ?: plain ?: URLUtil.guessFileName(url, contentDisposition, mimeType))
  }

  /** A name that stays one file in Downloads: no folders, no characters file systems refuse. */
  private fun clean(name: String): String =
    name.replace(Regex("""[/\\:*?"<>|\x00-\x1f]"""), "_").trim().trimStart('.').take(200).ifEmpty { "download" }

  /** The file's real type, so its notification opens it in the right app (the server sends octet-stream for all). */
  private fun typeOf(name: String, given: String?): String {
    if (given != null && given.isNotBlank() && given != "application/octet-stream") return given
    val ext = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }

  private fun say(context: Context, text: String) =
    Handler(Looper.getMainLooper()).post { Toast.makeText(context.applicationContext, text, Toast.LENGTH_SHORT).show() }

  // A file made in the page, arriving in pieces: written straight to where it ends up, published once complete.
  private class Saving(val name: String, val type: String, val out: OutputStream, val done: () -> Unit, val failed: () -> Unit)
  private val saving = ConcurrentHashMap<String, Saving>()

  /** Starts saving a file from the page; returns its id for the pieces, or "" if it can't be saved. */
  fun start(context: Context, rawName: String, mimeType: String): String {
    val name = clean(rawName)
    val type = typeOf(name, mimeType)
    return try {
      val s = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, name)
          put(MediaStore.Downloads.MIME_TYPE, type)
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return ""
        val out = resolver.openOutputStream(item) ?: run { resolver.delete(item, null, null); return "" }
        Saving(name, type, out,
          done = { resolver.update(item, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null) },
          failed = { resolver.delete(item, null, null) })
      } else {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return ""
        dir.mkdirs()
        var file = File(dir, name)
        var n = 1
        while (file.exists()) file = File(dir, name.replaceFirst(Regex("""(\.[^.]*)?$"""), " (${n++})$1"))
        val out = file.outputStream()
        @Suppress("DEPRECATION")
        Saving(file.name, type, out,
          done = {
            (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager)
              .addCompletedDownload(file.name, file.name, true, type, file.absolutePath, file.length(), true)
          },
          failed = { file.delete() })
      }
      UUID.randomUUID().toString().also { saving[it] = s }
    } catch (e: Exception) {
      ""
    }
  }

  /** One piece of the file, base64. False if it couldn't be written (the save is then dropped). */
  fun append(id: String, base64: String): Boolean {
    val s = saving[id] ?: return false
    return try {
      s.out.write(Base64.decode(base64, Base64.DEFAULT))
      true
    } catch (e: Exception) {
      drop(id)
      false
    }
  }

  /** The last piece has arrived: the file appears in Downloads. */
  fun finish(context: Context, id: String): Boolean {
    val s = saving.remove(id) ?: return false
    return try {
      s.out.close()
      s.done()
      say(context, "Saved to Downloads: ${s.name}")
      true
    } catch (e: Exception) {
      runCatching { s.failed() }
      say(context, "Couldn't save ${s.name}")
      false
    }
  }

  private fun drop(id: String) {
    val s = saving.remove(id) ?: return
    runCatching { s.out.close() }
    runCatching { s.failed() }
  }
}
