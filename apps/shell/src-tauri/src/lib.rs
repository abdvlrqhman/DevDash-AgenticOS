// DevDash shell: a thin native window around a DevDash space.
// The bundled connect screen (../ui) asks for a space domain, checks /.well-known/devdash.json,
// then loads the space. The space gets no native permissions (no IPC capabilities); it can only ask the shell,
// through navigations to devdash-shell://, to open a link in the system browser, go back to the connect screen,
// or show a system notification. On iPhone the shell also hands the space its push token (ios_push.rs) and saves its
// downloads where the Files app shows them; on Android, downloads are DevDash's Kotlin (android/Downloads.kt).
use tauri::{plugin::PermissionState, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "ios")]
mod ios_push;

/// Desktop self-update, from the space this app opens rather than from GitHub: DevDash's repository can be private, so
/// each space serves the app's releases itself (https://<space>/api/app/latest.json). Every update is still checked
/// against the public key built into the app (tauri.conf.json), so a space can't hand out anything unsigned.
#[cfg(desktop)]
mod updates {
    use std::sync::Mutex;
    use tauri::{ipc::Channel, AppHandle, State, Url};
    use tauri_plugin_updater::{Update, UpdaterExt};

    /// The update found by `check_update`, for `install_update`.
    #[derive(Default)]
    pub struct Found(Mutex<Option<Update>>);

    /// Download progress, in the shape ui/updater.js reads.
    #[derive(Clone, serde::Serialize)]
    #[serde(tag = "event", content = "data")]
    pub enum Progress {
        #[serde(rename_all = "camelCase")]
        Started { content_length: Option<u64> },
        #[serde(rename_all = "camelCase")]
        Progress { chunk_length: usize },
        Finished,
    }

    /// A newer version from `space` (a host like dev.example.com), or None.
    #[tauri::command]
    pub async fn check_update(app: AppHandle, found: State<'_, Found>, space: String) -> Result<Option<String>, String> {
        if space.is_empty() || !space.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':')) {
            return Err("not a space address".into());
        }
        let url = Url::parse(&format!("https://{space}/api/app/latest.json")).map_err(|e| e.to_string())?;
        let update = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?;
        let version = update.as_ref().map(|u| u.version.clone());
        *found.0.lock().unwrap() = update;
        Ok(version)
    }

    /// Downloads and installs the update `check_update` found, reporting progress.
    #[tauri::command]
    pub async fn install_update(found: State<'_, Found>, on_event: Channel<Progress>) -> Result<(), String> {
        let update = found.0.lock().unwrap().take().ok_or("no update to install")?;
        let mut started = false;
        update
            .download_and_install(
                |chunk_length, content_length| {
                    if !started {
                        started = true;
                        let _ = on_event.send(Progress::Started { content_length });
                    }
                    let _ = on_event.send(Progress::Progress { chunk_length });
                },
                || {
                    let _ = on_event.send(Progress::Finished);
                },
            )
            .await
            .map_err(|e| e.to_string())
    }
}

/// URL of the bundled connect screen, so "Switch space" can return to it from the space.
struct Home(Url);

/// Where Tauri serves the bundled UI when the WebView can't say yet (on Android it has no URL until it has loaded).
#[cfg(any(windows, target_os = "android"))]
const BUNDLED_HOME: &str = "http://tauri.localhost/index.html";
#[cfg(not(any(windows, target_os = "android")))]
const BUNDLED_HOME: &str = "tauri://localhost/index.html";

const BRIDGE: &str = r#"
  window.devdashShell = {
    switchSpace() { location.href = 'devdash-shell://switch' },
    openExternal(url) { location.href = 'devdash-shell://open?u=' + encodeURIComponent(url) },
    notify(title, body) {
      location.href = 'devdash-shell://notify?t=' + encodeURIComponent(title) + '&b=' + encodeURIComponent(body || '')
    },
    notificationPermission(ask) {
      return new Promise((resolve) => {
        window.__devdashPermission = resolve;
        location.href = 'devdash-shell://notification-permission?ask=' + (ask ? 1 : 0);
      });
    },
    showDownload(id) { location.href = 'devdash-shell://reveal?id=' + encodeURIComponent(id) },
  };
"#;

fn is_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/**
 * A page that opens a blank window and points it somewhere afterwards gets a hidden one of ours: the first web address
 * it goes to opens in the system browser instead, and the window goes away (also if it never goes anywhere).
 */
#[cfg(desktop)]
fn catch_popup(app: &tauri::AppHandle, features: tauri::webview::NewWindowFeatures) -> Option<tauri::WebviewWindow> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let label = format!("popup-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let close = |app: &tauri::AppHandle, label: &str| {
        let (app, label) = (app.clone(), label.to_string());
        std::thread::spawn(move || {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
        });
    };
    let (nav_app, nav_label) = (app.clone(), label.clone());
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().ok()?))
        .window_features(features)
        .visible(false)
        .on_navigation(move |url| {
            if !is_external(url) {
                return true;
            }
            let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            close(&nav_app, &nav_label);
            false
        })
        .build()
        .ok()?;
    let (late_app, late_label) = (app.clone(), label);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        if let Some(w) = late_app.get_webview_window(&late_label) {
            let _ = w.destroy();
        }
    });
    Some(window)
}

fn param(url: &Url, key: &str) -> String {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.chars().take(300).collect()).unwrap_or_default()
}

/// What the space asked for with a devdash-shell:// navigation. Runs on its own thread, never in the navigation callback:
/// that one runs on the main thread, and on phones the plugins need it free (Android queues every plugin call onto it,
/// and iOS opens links on it), so waiting for them there froze the app until the system killed it.
fn shell_action(app: &tauri::AppHandle, url: &Url) {
    match url.host_str() {
        Some("open") => {
            if let Some((_, target)) = url.query_pairs().find(|(k, _)| k == "u") {
                if let Ok(target) = Url::parse(&target) {
                    if is_external(&target) {
                        let _ = app.opener().open_url(target.as_str(), None::<&str>);
                    }
                }
            }
        }
        Some("notify") => {
            let _ = app.notification().builder().title(param(url, "t")).body(param(url, "b")).show();
        }
        Some("notification-permission") => {
            // Asking shows a system prompt on phones; answer the page once it is decided.
            let ask = param(url, "ask") == "1";
            let n = app.notification();
            let mut state = n.permission_state().unwrap_or(PermissionState::Denied);
            if ask && state != PermissionState::Granted && state != PermissionState::Denied {
                state = n.request_permission().unwrap_or(PermissionState::Denied);
            }
            let s = match state {
                PermissionState::Granted => "granted",
                PermissionState::Denied => "denied",
                _ => "prompt",
            };
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&format!("window.__devdashPermission && window.__devdashPermission('{s}')"));
            }
        }
        #[cfg(target_os = "ios")]
        Some("push-register") => ios_push::register(app),
        #[cfg(desktop)]
        Some("reveal") => {
            let file = param(url, "id").parse::<usize>().ok().and_then(|i| DOWNLOADED.lock().unwrap().get(i).cloned());
            if let Some(file) = file {
                let _ = app.opener().reveal_item_in_dir(file);
            }
        }
        Some("switch") => {
            let mut home = app.state::<Home>().0.clone();
            home.set_query(Some("switch=1"));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.navigate(home);
            }
        }
        _ => {}
    }
}

/// Finished downloads on desktop, by the number the page got, so "Show in folder" can't name any other path.
#[cfg(desktop)]
static DOWNLOADED: std::sync::Mutex<Vec<std::path::PathBuf>> = std::sync::Mutex::new(Vec::new());

/// Downloads (a Download button, a file the server sends as an attachment, a file made in the page), with the page told
/// when each starts and ends so it can say so: once the app handles them, WebView2 and WebKit save silently.
/// Desktop: where WebView2 picked (the Downloads folder, under a free name), and the page can ask to show the file.
/// iPhone: the app's Documents folder, which the Files app shows as On My iPhone › DevDash (Info.ios.plist); WebKit
/// would aim for a Downloads folder, which apps don't have.
#[cfg(any(desktop, target_os = "ios"))]
fn on_download(webview: tauri::Webview, event: tauri::webview::DownloadEvent<'_>) -> bool {
    use std::{collections::HashMap, path::PathBuf, sync::Mutex};
    use tauri::webview::DownloadEvent;
    // Each download's name and planned path, by its address: when it ends, WebKit only says the address.
    static SAVING: Mutex<Option<HashMap<String, (String, PathBuf)>>> = Mutex::new(None);
    let name_of = |p: &std::path::Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "download".into());
    let js = |v: &str| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into());
    match event {
        DownloadEvent::Requested { url, destination } => {
            #[cfg(target_os = "ios")]
            {
                let Ok(dir) = webview.path().document_dir() else { return false };
                if std::fs::create_dir_all(&dir).is_err() {
                    return false;
                }
                let name = name_of(destination);
                let (stem, ext) = match name.rsplit_once('.') {
                    Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
                    _ => (name.clone(), String::new()),
                };
                let mut path = dir.join(&name);
                for n in 1.. {
                    if !path.exists() {
                        break;
                    }
                    path = dir.join(format!("{stem} ({n}){ext}"));
                }
                *destination = path;
            }
            let name = name_of(destination);
            let _ = webview.eval(&format!("window.devdashDownloading && window.devdashDownloading({})", js(&name)));
            SAVING.lock().unwrap().get_or_insert_with(HashMap::new).insert(url.to_string(), (name, destination.clone()));
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let (name, planned) = SAVING.lock().unwrap().as_mut().and_then(|m| m.remove(url.as_str())).unwrap_or_default();
            #[cfg(desktop)]
            let (place, id) = {
                let mut done = DOWNLOADED.lock().unwrap();
                done.push(path.unwrap_or(planned)); // macOS doesn't say where it saved; Windows and Linux do
                ("In your Downloads folder", (done.len() - 1).to_string())
            };
            #[cfg(target_os = "ios")]
            let (place, id) = {
                let _ = (path, planned);
                ("In the Files app: On My iPhone › DevDash", "undefined".to_string())
            };
            let _ = webview.eval(&format!(
                "window.devdashDownloaded && window.devdashDownloaded({}, {success}, {}, {id})",
                js(&name),
                js(place)
            ));
            true
        }
        _ => true,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());
    // iPhone: notifications while the app is closed, through Apple's push service. After the
    // notification plugin, so local notifications stay that plugin's.
    #[cfg(desktop)]
    let builder = builder
        .manage(updates::Found::default())
        .invoke_handler(tauri::generate_handler![updates::check_update, updates::install_update]);
    #[cfg(target_os = "ios")]
    let builder = builder
        .manage(ios_push::Shared::default())
        .plugin(tauri_plugin_devdash_push::init(ios_push::on_event));
    builder
        .setup(|app| {
            // Self-update is desktop-only: the connect screen checks GitHub Releases on launch
            // (ui/updater.js), the updater plugin downloads + installs the signed update, and the
            // process plugin relaunches afterwards. Both are registered only on desktop — the shell
            // itself uses neither on mobile, where registering process has crashed the app at launch.
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            #[cfg(target_os = "ios")]
            let bridge = [BRIDGE, ios_push::BRIDGE].concat();
            #[cfg(not(target_os = "ios"))]
            let bridge = BRIDGE.to_string();
            // The page can tell what this app can do (0.1.9 on: links can go through openExternal on phones too).
            let bridge = format!("{bridge}\n  window.devdashShell.version = '{}';\n", env!("CARGO_PKG_VERSION"));
            let nav_app = app.handle().clone();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script(bridge)
                .on_navigation(move |url| {
                    if url.scheme() != "devdash-shell" {
                        return true;
                    }
                    let (app, url) = (nav_app.clone(), url.clone());
                    std::thread::spawn(move || shell_action(&app, &url));
                    false
                });

            #[cfg(any(desktop, target_os = "ios"))]
            let builder = builder.on_download(on_download);

            // iPhone: each loaded space page gets the push token, and a tapped notification's page opens once its space is up.
            #[cfg(target_os = "ios")]
            let builder = builder.on_page_load(|w, p| {
                if p.event() == tauri::webview::PageLoadEvent::Finished && p.url().scheme() == "https" {
                    ios_push::page_loaded(&w, p.url());
                }
            });

            #[cfg(desktop)]
            let builder = {
                let new_win_app = app.handle().clone();
                builder
                    .title("DevDash")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(360.0, 560.0)
                    // window.open() and target=_blank, from the space's pages or a service shown inside them (WebView2
                    // raises popups from frames here too): links go to the system browser, not a stray in-app window.
                    .on_new_window(move |url, features| {
                        if is_external(&url) {
                            let _ = new_win_app.opener().open_url(url.as_str(), None::<&str>);
                        } else if url.as_str() == "about:blank" {
                            // window.open('') now, the address later (common around async work): catch it.
                            if let Some(window) = catch_popup(&new_win_app, features) {
                                return tauri::webview::NewWindowResponse::Create { window };
                            }
                        }
                        tauri::webview::NewWindowResponse::Deny
                    })
            };

            let window = builder.build()?;
            // Match the page background to light/dark mode, so loading never flashes white in dark mode.
            let bg = match window.theme().unwrap_or(tauri::Theme::Light) {
                tauri::Theme::Dark => tauri::webview::Color(10, 10, 10, 255),
                _ => tauri::webview::Color(250, 250, 250, 255),
            };
            let _ = window.set_background_color(Some(bg));
            let home = window.url().ok().filter(|u| u.scheme() != "about").unwrap_or_else(|| Url::parse(BUNDLED_HOME).expect("valid URL"));
            app.manage(Home(home));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DevDash");
}
