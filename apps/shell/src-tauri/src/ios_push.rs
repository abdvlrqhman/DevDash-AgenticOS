// iPhone: notifications while the app is closed, through Apple's push service.
// The plugin (plugins/devdash-push) reports the device token and taps. The space's page gets the token as
// window.__devdashPushState plus a 'devdash-push' event and registers it with its own server
// (apps/web/src/lib/ios-push.ts); a tapped notification's page opens once its space has loaded.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url, WebviewWindow, Wry};
use tauri_plugin_devdash_push::{Event, Push};

/// Added to the bridge on iPhone: asks Apple for a device token again (the answer comes as the event above).
pub const BRIDGE: &str = r#"
  window.devdashShell.registerPush = () => { location.href = 'devdash-shell://push-register' };
"#;

#[derive(Default)]
pub struct PushState {
    token: Option<String>,
    environment: Option<String>,
    error: Option<String>,
    /// A tapped notification's page, until its space has loaded (a tap can start the app).
    open: Option<(Url, Instant)>,
}
pub type Shared = Mutex<PushState>;

fn script(s: &PushState) -> String {
    let state = serde_json::json!({ "token": s.token, "environment": s.environment, "error": s.error });
    format!("window.__devdashPushState={state};window.dispatchEvent(new CustomEvent('devdash-push',{{detail:window.__devdashPushState}}))")
}

/// Only a space's pages listen; the bundled connect screen has nothing to do with it.
fn tell_page(app: &AppHandle, js: String) {
    if let Some(w) = app.get_webview_window("main") {
        if w.url().is_ok_and(|u| u.scheme() == "https") {
            let _ = w.eval(&js);
        }
    }
}

/// Everything the plugin reports, on any thread.
pub fn on_event(app: &AppHandle, event: Event) {
    let state = app.state::<Shared>();
    match event {
        Event::Token { token, environment } => {
            let js = {
                let mut s = state.lock().unwrap();
                s.token = Some(token);
                s.environment = Some(environment);
                s.error = None;
                script(&s)
            };
            tell_page(app, js);
        }
        Event::Error { message } => {
            let js = {
                let mut s = state.lock().unwrap();
                s.error = Some(message);
                script(&s)
            };
            tell_page(app, js);
        }
        Event::Open { url } => {
            let Ok(url) = Url::parse(&url) else { return };
            if url.scheme() != "https" {
                return;
            }
            // The space is open: go there now. Otherwise wait for it (the connect screen opens the last space).
            if let Some(w) = app.get_webview_window("main") {
                if w.url().is_ok_and(|u| u.scheme() == "https" && u.host_str() == url.host_str()) {
                    let _ = w.navigate(url);
                    return;
                }
            }
            state.lock().unwrap().open = Some((url, Instant::now()));
        }
    }
}

/// A space's page finished loading: hand it the state, and open a tapped notification's page if it is from this space.
pub fn page_loaded(w: &WebviewWindow, url: &Url) {
    let (js, open) = {
        let state = w.state::<Shared>();
        let mut s = state.lock().unwrap();
        let open = s.open.take().filter(|(target, at)| at.elapsed() < Duration::from_secs(120) && target.host_str() == url.host_str());
        (script(&s), open)
    };
    let _ = w.eval(&js);
    if let Some((target, _)) = open {
        if &target != url {
            let w = w.clone();
            // Navigate after this callback returns.
            std::thread::spawn(move || {
                let _ = w.navigate(target);
            });
        }
    }
}

/// The page turned notifications on: ask Apple for a token again, and forget an old failure.
pub fn register(app: &AppHandle) {
    app.state::<Shared>().lock().unwrap().error = None;
    let app = app.clone();
    std::thread::spawn(move || {
        app.state::<Push<Wry>>().register();
    });
}
