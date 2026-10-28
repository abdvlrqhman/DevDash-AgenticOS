// swift-tools-version:5.5
// Built and linked by the plugin's build.rs (tauri-plugin), like Tauri's own mobile plugins.

import PackageDescription

let package = Package(
  name: "tauri-plugin-devdash-push",
  platforms: [
    .iOS(.v15)
  ],
  products: [
    .library(
      name: "tauri-plugin-devdash-push",
      type: .static,
      targets: ["tauri-plugin-devdash-push"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-devdash-push",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
