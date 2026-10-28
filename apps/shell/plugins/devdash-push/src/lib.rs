//! DevDash's iPhone notifications while the app is closed.
//!
//! The Swift side (ios/) registers with Apple's push service, shows DevDash's pushes while the app is open, and reports
//! taps. Everything comes back to the app's Rust code through one channel: the remote DevDash page has no IPC, so the
//! shell hands it what it needs (apps/shell/src-tauri/src/lib.rs).
#![cfg(target_os = "ios")]

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_devdash_push);

/// What the iPhone reports.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum Event {
    /// Apple gave this install a device token (hex), for its "sandbox" or "production" environment.
    Token { token: String, environment: String },
    /// No token. `message` is "no-entitlement" for a build signed without push notifications (AltStore, SideStore,
    /// an unsigned build), otherwise why registering failed.
    Error { message: String },
    /// The member tapped a DevDash notification that opens this page.
    Open { url: String },
}

#[derive(Serialize)]
struct Watch {
    channel: Channel,
}

/// The plugin, from the app: `app.state::<Push<R>>()`.
pub struct Push<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Push<R> {
    /// Asks Apple for a (new) device token. The answer comes back as [`Event::Token`] or [`Event::Error`].
    pub fn register(&self) {
        if let Err(e) = self.0.run_mobile_plugin::<()>("register", ()) {
            eprintln!("devdash-push: register: {e}");
        }
    }
}

/// `on_event` gets every [`Event`], on any thread. A tap that launched the app is kept until this is set up.
pub fn init<R: Runtime, F>(on_event: F) -> TauriPlugin<R>
where
    F: Fn(&AppHandle<R>, Event) + Send + Sync + 'static,
{
    Builder::new("devdash-push")
        .setup(move |app, api| {
            let handle = api.register_ios_plugin(init_plugin_devdash_push)?;
            let app_handle = app.clone();
            let channel = Channel::new(move |body| {
                let event = match body {
                    InvokeResponseBody::Json(json) => serde_json::from_str::<Event>(&json),
                    InvokeResponseBody::Raw(raw) => serde_json::from_slice::<Event>(&raw),
                };
                match event {
                    Ok(event) => on_event(&app_handle, event),
                    Err(e) => eprintln!("devdash-push: unreadable event: {e}"),
                }
                Ok(())
            });
            handle.run_mobile_plugin::<()>("watch", Watch { channel })?;
            app.manage(Push(handle));
            Ok(())
        })
        .build()
}
