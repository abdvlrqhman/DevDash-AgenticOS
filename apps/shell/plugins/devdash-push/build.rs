// Builds the Swift package in ios/ and links it into the app when building for iOS (like Tauri's own mobile plugins).
// No commands: only the app's Rust code talks to this plugin, never a web page.
fn main() {
    tauri_plugin::Builder::new(&[]).ios_path("ios").build();
}
