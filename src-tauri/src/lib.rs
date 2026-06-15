// Paint — Tauri backend.
//
// Deliberately thin. The browser <canvas> owns every pixel and does all
// image encoding/decoding (PNG, and whatever the webview decodes on open),
// so Rust never touches an image codec. It is a byte courier:
//   open_image  — read file bytes  → hand the webview a `data:` URL
//   save_png    — take the canvas's `data:image/png;base64,…` → write bytes
// Everything else (state I/O, path canonicalization, IO error formatting,
// dev-fixture probe) delegates to krill-desktop-core.

use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};

use krill_desktop_core::{dev as kdev, fs as kfs, state as kstate, updater::BuilderExt};

const SLUG: &str = "krill-paint";

// ---- App state ---------------------------------------------------------

/// The path the canvas was last opened from / saved to. Empty = untitled.
/// `save` (Ctrl+S) targets this; `open`/`save_png` keep it current.
#[derive(Default)]
struct AppPaint {
    path: Mutex<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    window: Option<kstate::WindowGeometry>,
    recent: Option<Vec<String>>,
    color: Option<String>,
    brush_size: Option<u32>,
}

// ---- Open --------------------------------------------------------------

#[derive(Debug, Serialize)]
struct OpenedImage {
    path: String,
    name: String,
    /// `data:<mime>;base64,<…>` — fed straight into an `Image` in the webview.
    data_url: String,
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        // PNG is the default; the webview sniffs the bytes anyway.
        _ => "image/png",
    }
}

fn basename(path: &str) -> String {
    let i = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    path[i..].to_string()
}

#[tauri::command]
fn open_image(path: String, app: tauri::State<'_, AppPaint>) -> Result<OpenedImage, String> {
    let p = Path::new(&path);
    let bytes = kfs::read_bytes(p)?;
    let mime = mime_for(p);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let abs = kfs::absolute_path(p);
    *app.path.lock().unwrap() = abs.clone();
    Ok(OpenedImage {
        name: basename(&abs),
        data_url: format!("data:{mime};base64,{b64}"),
        path: abs,
    })
}

// ---- Save --------------------------------------------------------------

/// Write the canvas to `path` as PNG. `data_url` is the canvas's
/// `toDataURL("image/png")` output; we strip the header and decode the
/// base64 tail to the raw PNG bytes.
#[tauri::command]
fn save_png(
    path: String,
    data_url: String,
    app: tauri::State<'_, AppPaint>,
) -> Result<String, String> {
    let b64 = data_url
        .split_once(",")
        .map(|(_, tail)| tail)
        .unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("decode image data: {e}"))?;

    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| kfs::format_io_err(&path, e))?;
        }
    }
    std::fs::write(p, &bytes).map_err(|e| kfs::format_io_err(&path, e))?;

    let abs = kfs::absolute_path(p);
    *app.path.lock().unwrap() = abs.clone();
    Ok(abs)
}

#[tauri::command]
fn current_path(app: tauri::State<'_, AppPaint>) -> String {
    app.path.lock().unwrap().clone()
}

/// Called on `New` so a subsequent `Ctrl+S` prompts for a path instead of
/// silently overwriting the previously opened file.
#[tauri::command]
fn clear_path(app: tauri::State<'_, AppPaint>) {
    app.path.lock().unwrap().clear();
}

// ---- State + dev fixture ----------------------------------------------

#[tauri::command]
fn load_state() -> Option<AppState> {
    kstate::load(SLUG, "state.json")
}

#[tauri::command]
fn save_state(state: AppState) -> Result<(), String> {
    kstate::save(SLUG, "state.json", &state)
}

// Read a text file (a .gpl palette); the webview parses it with the shared
// desktop-ui parser and loads the colors into the swatch strip.
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let bytes = kfs::read_bytes(p)?;
    String::from_utf8(bytes).map_err(|e| {
        kfs::format_io_err(&path, std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    })
}

#[tauri::command]
fn dev_test_file() -> Option<String> {
    kdev::test_file(env!("CARGO_MANIFEST_DIR"), &["test.png"])
}

// ---- Boot --------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .with_updater()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppPaint::default())
        .invoke_handler(tauri::generate_handler![
            open_image,
            save_png,
            current_path,
            clear_path,
            load_state,
            save_state,
            read_text,
            dev_test_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
