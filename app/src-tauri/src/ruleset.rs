//! Ruleset override store + engine dump bridge for the Methodology & Rules panel.
//!
//! The Python engine ships the typed default ruleset; the app persists operator edits as
//! an overrides JSON in the app-config dir; the engine merges overrides over defaults at
//! score time. These commands let the UI read the merged ruleset (via an engine dump),
//! read the current overrides, and write new overrides — without touching Python.

use std::path::PathBuf;

use serde_json::Value;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// Stable path of the overrides file the engine reads (shared with `analyze_path`).
pub fn overrides_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create app config dir: {e}"))?;
    Ok(dir.join("ruleset_overrides.json"))
}

/// Returns the overrides path as a string only if the file exists (else None).
pub fn existing_overrides_path(app: &tauri::AppHandle) -> Option<String> {
    overrides_path(app).ok().and_then(|p| {
        if p.exists() {
            Some(p.to_string_lossy().to_string())
        } else {
            None
        }
    })
}

#[tauri::command]
pub fn ruleset_get_overrides(app: tauri::AppHandle) -> Result<Value, String> {
    let p = overrides_path(&app)?;
    if !p.exists() {
        return Ok(serde_json::json!({}));
    }
    let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&txt).unwrap_or_else(|_| serde_json::json!({})))
}

#[tauri::command]
pub fn ruleset_set_overrides(app: tauri::AppHandle, overrides: Value) -> Result<(), String> {
    let p = overrides_path(&app)?;
    let body = serde_json::to_string_pretty(&overrides).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| e.to_string())
}

/// Path string for the UI (so it can show where overrides live).
#[tauri::command]
pub fn ruleset_overrides_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(overrides_path(&app)?.to_string_lossy().to_string())
}

/// Run the engine's `--dump-ruleset` (merged defaults+overrides) and return the JSON.
/// Lets the Methodology/Manage panel render the live ruleset without a loaded analysis.
#[tauri::command]
pub async fn ruleset_dump(app: tauri::AppHandle) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["--dump-ruleset".to_string()];
    if let Some(p) = existing_overrides_path(&app) {
        args.push("--ruleset-overrides".to_string());
        args.push(p);
    }
    let sidecar = app
        .shell()
        .sidecar("ftdc-engine")
        .map_err(|e| format!("sidecar not found: {e}"))?;
    let output = sidecar
        .args(args)
        .output()
        .await
        .map_err(|e| format!("failed to launch engine: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("engine dump failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("could not parse ruleset JSON: {e}"))
}
