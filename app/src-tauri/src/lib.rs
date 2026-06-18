// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[derive(serde::Serialize)]
struct AnalyzeResult {
    dir: String,
    hostname: String,
}

/// Run the bundled `ftdc-engine` sidecar on `path`, writing results into a fresh
/// app-cache subdir. Returns the output dir + resolved hostname (parsed from the
/// engine's two parseable stdout lines), or a clear error string.
#[tauri::command]
async fn analyze_path(app: tauri::AppHandle, path: String) -> Result<AnalyzeResult, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve app cache dir: {e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = cache.join(format!("run-{stamp}"));
    std::fs::create_dir_all(&out).map_err(|e| format!("cannot create output dir: {e}"))?;
    let out_str = out.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("ftdc-engine")
        .map_err(|e| format!("sidecar not found: {e}"))?;
    let output = sidecar
        .args([path.as_str(), "--out-dir", out_str.as_str()])
        .output()
        .await
        .map_err(|e| format!("failed to launch engine: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr
            .lines()
            .rev()
            .find(|l| l.contains("error") || l.contains("FAILED"))
            .map(|l| l.trim().to_string())
            .unwrap_or_else(|| "engine exited non-zero".to_string());
        return Err(reason);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut hostname = String::new();
    let mut dir = out_str.clone();
    for line in stdout.lines() {
        if let Some(h) = line.strip_prefix("hostname=") {
            hostname = h.trim().to_string();
        } else if let Some(d) = line.strip_prefix("out_dir=") {
            dir = d.trim().to_string();
        }
    }
    if hostname.is_empty() {
        hostname = "(unknown host)".to_string();
    }
    Ok(AnalyzeResult { dir, hostname })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![analyze_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
