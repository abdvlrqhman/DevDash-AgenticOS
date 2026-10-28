// Copied into the generated project by android/prepare.sh. MainActivity installs it.
// New windows — window.open() and target=_blank links, from the space's pages or a service shown inside them — go to
// the system: the browser, or the app that owns the link (YouTube for youtu.be). Without this the WebView drops them.
package io.github.abdvlrqhman.devdash

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Message
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

object NewWindows {
  /**
   * Wry sets its own WebChromeClient (file pickers, permissions, dialogs) after MainActivity.onWebViewCreate runs, so
   * this waits for it and wraps it: everything still goes to wry's client, and new windows come here.
   * Needs Android 8 (to read the client back); older phones keep the WebView's own behaviour.
   */
  fun install(webView: WebView, tries: Int = 0) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val inner = webView.webChromeClient
    if (inner == null) {
      if (tries < 40) webView.postDelayed({ install(webView, tries + 1) }, 50)
      return
    }
    if (inner is Wrapper) return
    webView.settings.setSupportMultipleWindows(true)
    webView.settings.javaScriptCanOpenWindowsAutomatically = true // window.open reaches onCreateWindow (gesture-checked there)
    webView.webChromeClient = Wrapper(inner)
  }

  /** Hands an http(s) address to the system: the browser, or the app registered for it. */
  fun openOutside(context: Context, url: String): Boolean {
    val uri = Uri.parse(url)
    if (uri.scheme != "https" && uri.scheme != "http") return false
    return try {
      context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (e: ActivityNotFoundException) {
      false
    }
  }

  /** Wry's client with new windows added. Forwards exactly what RustWebChromeClient (wry 0.57) overrides. */
  private class Wrapper(private val inner: WebChromeClient) : WebChromeClient() {
    /**
     * A new window: give WebView a throwaway one, and hand the first real address it goes to (a link's, or one set
     * later by window.open('') + location) to the system. Like a browser's popup blocker, only from a tap.
     */
    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
      if (!isUserGesture) return false
      val context = view.context
      val popup = WebView(context)
      var done = false
      val finish = { url: String? ->
        if (!done && url != null && url != "about:blank") {
          done = true
          openOutside(context, url)
          popup.post { popup.destroy() }
        }
      }
      popup.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
          finish(request.url.toString())
          return true
        }
        override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
          if (url != null && url != "about:blank") {
            v.stopLoading()
            finish(url)
          }
        }
      }
      popup.postDelayed({ if (!done) { done = true; popup.destroy() } }, 15_000) // a window that never goes anywhere
      (resultMsg.obj as WebView.WebViewTransport).webView = popup
      resultMsg.sendToTarget()
      return true
    }

    override fun onShowCustomView(view: View, callback: CustomViewCallback) = inner.onShowCustomView(view, callback)
    override fun onHideCustomView() = inner.onHideCustomView()
    override fun onPermissionRequest(request: PermissionRequest) = inner.onPermissionRequest(request)
    override fun getDefaultVideoPoster(): Bitmap? = inner.defaultVideoPoster
    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean = inner.onJsAlert(view, url, message, result)
    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean = inner.onJsConfirm(view, url, message, result)
    override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult): Boolean =
      inner.onJsPrompt(view, url, message, defaultValue, result)
    override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
      inner.onGeolocationPermissionsShowPrompt(origin, callback)
    override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri?>?>, fileChooserParams: FileChooserParams): Boolean =
      inner.onShowFileChooser(webView, filePathCallback, fileChooserParams)
    override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = inner.onConsoleMessage(consoleMessage)
    override fun onReceivedTitle(view: WebView, title: String) = inner.onReceivedTitle(view, title)
  }
}
