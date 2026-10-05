// Windows decides whether a process gets a console from its PE *subsystem*, not from anything it
// does at runtime — and a Rust binary defaults to the console subsystem. That is the black window
// that appeared alongside the app: measured, `moseek.exe` was subsystem `3 = Windows CUI`. This
// attribute sets it to "windows" for release builds, which is what Tauri's own app template does.
//
// Kept behind `not(debug_assertions)` on purpose: a debug build keeps its console, so `cargo run`
// and the `println!`s it prints stay visible during development rather than going nowhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    moseek_lib::run();
}
