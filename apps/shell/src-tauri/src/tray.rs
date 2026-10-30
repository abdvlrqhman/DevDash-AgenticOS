// Desktop: DevDash lives in the tray, like a chat app. Closing the window hides it, so notifications (a session that
// needs you, a teammate's message) keep coming; the tray icon opens it again, and its menu is where you quit. Opening
// DevDash a second time (the Start menu, a shortcut) brings this window back instead of starting another copy
// (the single-instance plugin, registered first in lib.rs).
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Window, WindowEvent};
use tauri_plugin_notification::NotificationExt;

/// Shows the main window, restored and in front.
pub fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The tray icon: a click opens DevDash, its menu opens it or quits.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open DevDash", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit DevDash", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("devdash")
        .tooltip("DevDash")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Closing the main window hides it to the tray (other windows, like sign-in popups, close as usual). The first time,
/// a notification says where it went, so nobody thinks it quit and nobody wonders why it's still running.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if window.label() != "main" {
        return;
    }
    api.prevent_close();
    let _ = window.hide();
    let app = window.app_handle();
    let Ok(dir) = app.path().app_data_dir() else { return };
    let seen = dir.join("tray-hint-shown");
    if seen.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&seen, b"1"));
    let _ = app
        .notification()
        .builder()
        .title("DevDash is still running")
        .body("It's in the tray, so your notifications keep coming. Quit it from the tray icon's menu.")
        .show();
}
