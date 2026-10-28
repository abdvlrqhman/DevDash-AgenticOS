// DevDash's iPhone notifications while the app is closed.
//
// - Registers with Apple's push service at every launch (Apple's advice: tokens change on restores and reinstalls) and
//   reports the device token, with the APNs environment the app was signed for, to the app's Rust code.
// - Shows DevDash's pushes while the app is open, and reports the page a tapped one opens.
// - Leaves local notifications (tauri-plugin-notification) to that plugin's delegate.
//
// Tauri's app delegate has no remote-notification callbacks, so they are added to its class at runtime.

import ObjectiveC.runtime
import Tauri
import UIKit
import UserNotifications
import WebKit

struct WatchArgs: Decodable {
  let channel: Channel
}

/// What goes to Rust (tauri-plugin-devdash-push's `Event`).
struct PushEvent: Encodable {
  let event: String
  var token: String? = nil
  var environment: String? = nil
  var message: String? = nil
  var url: String? = nil
}

class DevDashPushPlugin: Plugin, UNUserNotificationCenterDelegate {
  private let lock = NSLock()
  private var channel: Channel?
  /// Events from before Rust was listening, e.g. the tap that launched the app.
  private var backlog: [PushEvent] = []
  /// The notification center's delegate before this one (tauri-plugin-notification): local notifications stay its own.
  private weak var previous: UNUserNotificationCenterDelegate?
  private var hooked = false

  override init() {
    super.init()
    // Plugins are created before the app finishes launching, which is when Apple wants this delegate set, so the
    // tap that launches the app still arrives.
    let center = UNUserNotificationCenter.current()
    previous = center.delegate
    center.delegate = self
  }

  /// "sandbox" or "production": the APNs environment in the provisioning profile the app was signed with. nil when the
  /// app was signed without push notifications (AltStore, SideStore, a free Apple ID), so it can't get a token.
  static let environment: String? = {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision") else {
      return "production" // TestFlight and App Store builds carry no profile and always use production
    }
    // The profile is a signed plist: the plist itself sits in it as plain XML.
    guard let data = try? Data(contentsOf: url),
      let start = data.range(of: Data("<?xml".utf8)),
      let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
      let profile = try? PropertyListSerialization.propertyList(
        from: data.subdata(in: start.lowerBound..<end.upperBound), options: [], format: nil) as? [String: Any],
      let entitlements = profile["Entitlements"] as? [String: Any],
      let aps = entitlements["aps-environment"] as? String
    else { return nil }
    return aps == "development" ? "sandbox" : "production"
  }()

  // MARK: Commands (from the app's Rust code, on Tauri's IPC queue)

  /// Rust's channel for events; sends whatever happened before it was there.
  @objc public func watch(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(WatchArgs.self)
    lock.lock()
    channel = args.channel
    let missed = backlog
    backlog = []
    lock.unlock()
    for event in missed { try? args.channel.send(event) }
    invoke.resolve()
  }

  /// Asks Apple for a device token again (the page does when notifications are turned on).
  @objc public func register(_ invoke: Invoke) {
    DispatchQueue.main.async { self.registerForPushes() }
    invoke.resolve()
  }

  @objc public override func load(webview: WKWebView) {
    registerForPushes()
  }

  // MARK: Registering

  private func emit(_ event: PushEvent) {
    lock.lock()
    let listener = channel
    if listener == nil { backlog.append(event) }
    lock.unlock()
    if let listener = listener { try? listener.send(event) }
  }

  /// Main thread only.
  private func registerForPushes() {
    hookAppDelegate()
    guard DevDashPushPlugin.environment != nil else {
      emit(PushEvent(event: "error", message: "no-entitlement"))
      return
    }
    UIApplication.shared.registerForRemoteNotifications()
  }

  /// Adds the two registration callbacks to the app delegate's class. If it already has them, they still run, after ours.
  private func hookAppDelegate() {
    guard !hooked, let delegate = UIApplication.shared.delegate, let cls = object_getClass(delegate) else { return }
    hooked = true

    typealias TokenFn = @convention(c) (AnyObject, Selector, UIApplication, NSData) -> Void
    let tokenSel = #selector(UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:))
    let tokenBefore = class_getInstanceMethod(cls, tokenSel).map { unsafeBitCast(method_getImplementation($0), to: TokenFn.self) }
    let onToken: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { [weak self] me, app, token in
      self?.emit(PushEvent(
        event: "token",
        token: (token as Data).map { String(format: "%02x", $0) }.joined(),
        environment: DevDashPushPlugin.environment ?? "production"))
      tokenBefore?(me, tokenSel, app, token)
    }
    DevDashPushPlugin.install(cls, tokenSel, imp_implementationWithBlock(unsafeBitCast(onToken, to: AnyObject.self)))

    typealias FailFn = @convention(c) (AnyObject, Selector, UIApplication, NSError) -> Void
    let failSel = #selector(UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:))
    let failBefore = class_getInstanceMethod(cls, failSel).map { unsafeBitCast(method_getImplementation($0), to: FailFn.self) }
    let onFail: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { [weak self] me, app, error in
      self?.emit(PushEvent(event: "error", message: error.localizedDescription))
      failBefore?(me, failSel, app, error)
    }
    DevDashPushPlugin.install(cls, failSel, imp_implementationWithBlock(unsafeBitCast(onFail, to: AnyObject.self)))
  }

  private static func install(_ cls: AnyClass, _ sel: Selector, _ imp: IMP) {
    // v@:@@ — returns void; self, _cmd, the application, the token or error.
    if !class_addMethod(cls, sel, imp, "v@:@@"), let method = class_getInstanceMethod(cls, sel) {
      method_setImplementation(method, imp)
    }
  }

  // MARK: UNUserNotificationCenterDelegate

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    guard notification.request.trigger is UNPushNotificationTrigger else {
      if previous?.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler) == nil {
        completionHandler([.banner, .list, .sound])
      }
      return
    }
    // DevDash only pushes while you aren't using it anywhere (or for the test button), so show it even now.
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let request = response.notification.request
    guard request.trigger is UNPushNotificationTrigger else {
      if previous?.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler) == nil {
        completionHandler()
      }
      return
    }
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier, let url = request.content.userInfo["url"] as? String {
      emit(PushEvent(event: "open", url: url))
    }
    completionHandler()
  }
}

@_cdecl("init_plugin_devdash_push")
func initPlugin() -> Plugin {
  return DevDashPushPlugin()
}
