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

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct HistoryEntry {
    hostname: String,
    timestamp: String,
    source_path: String,
    cache_dir: String,
    // Optional enrichment for a useful history label; `default` keeps older
    // history.json files (written before these fields existed) deserializable.
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    first_ts: Option<String>,
    #[serde(default)]
    last_ts: Option<String>,
}

fn history_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create app data dir: {e}"))?;
    Ok(dir.join("history.json"))
}

/// List previously analyzed runs (most recent first).
#[tauri::command]
fn list_history(app: tauri::AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let p = history_path(&app)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&txt).unwrap_or_default())
}

/// Persist a completed run's metadata; returns the updated list (newest first).
#[tauri::command]
fn record_run(app: tauri::AppHandle, entry: HistoryEntry) -> Result<Vec<HistoryEntry>, String> {
    let p = history_path(&app)?;
    let mut cur: Vec<HistoryEntry> = if p.exists() {
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    cur.retain(|e| e.cache_dir != entry.cache_dir);
    cur.insert(0, entry);
    cur.truncate(50);
    let body = serde_json::to_string_pretty(&cur).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| e.to_string())?;
    Ok(cur)
}

/// The local macOS username, for a friendly greeting on the landing screen.
#[tauri::command]
fn get_username() -> String {
    std::env::var("USER")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "there".to_string())
}

/// Copy the run's report.html (in the app cache) to a user-chosen destination.
#[tauri::command]
fn save_report(src: String, dest: String) -> Result<(), String> {
    std::fs::copy(&src, &dest).map_err(|e| format!("could not save report: {e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            analyze_path,
            list_history,
            record_run,
            save_report,
            get_username
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
