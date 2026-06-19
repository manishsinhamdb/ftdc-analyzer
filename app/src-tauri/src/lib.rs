// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

mod llm;
mod ruleset;

#[derive(serde::Serialize)]
struct AnalyzeResult {
    dir: String,
    hostname: String,
}

/// Run the bundled `ftdc-engine` sidecar on `path`, writing results into a fresh
/// app-cache subdir. Returns the output dir + resolved hostname (parsed from the
/// engine's two parseable stdout lines), or a clear error string.
#[tauri::command]
async fn analyze_path(
    app: tauri::AppHandle,
    path: String,
    target_category: Option<String>,
    intent: Option<String>,
    healthcheck: Option<String>,
    profiler: Option<String>,
    cloud: Option<String>,
) -> Result<AnalyzeResult, String> {
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
    // Pass operator ruleset overrides to the Layer-2 scorer when present.
    let mut args: Vec<String> =
        vec![path.clone(), "--out-dir".to_string(), out_str.clone()];
    if let Some(ov) = ruleset::existing_overrides_path(&app) {
        args.push("--ruleset-overrides".to_string());
        args.push(ov);
    }
    // Targeted mode: bias the scorer toward one category (deep-focus).
    if let Some(tc) = target_category.filter(|s| !s.is_empty()) {
        args.push("--target-category".to_string());
        args.push(tc);
    }
    // Assessment intent (curated lens over the categories).
    if let Some(i) = intent.filter(|s| !s.is_empty()) {
        args.push("--intent".to_string());
        args.push(i);
    }
    // Optional intake files (path recorded for the future parser; not scored yet).
    if let Some(hc) = healthcheck.filter(|s| !s.is_empty()) {
        args.push("--healthcheck".to_string());
        args.push(hc);
    }
    if let Some(pf) = profiler.filter(|s| !s.is_empty()) {
        args.push("--profiler".to_string());
        args.push(pf);
    }
    // Cloud provider selects the sizing tier table (right-sizing / cost intents).
    if let Some(c) = cloud.filter(|s| !s.is_empty()) {
        args.push("--cloud".to_string());
        args.push(c);
    }
    let output = sidecar
        .args(args)
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

/// Helper: only remove a cached run dir if it sits under the app cache (safety).
fn remove_cache_dir(app: &tauri::AppHandle, cache_dir: &str) {
    if cache_dir.is_empty() {
        return;
    }
    if let Ok(cache_root) = app.path().app_cache_dir() {
        let p = std::path::Path::new(cache_dir);
        if p.starts_with(&cache_root) && p.is_dir() {
            let _ = std::fs::remove_dir_all(p); // best-effort
        }
    }
}

/// Delete one history entry (by cache_dir) + its cached run dir. Returns updated list.
#[tauri::command]
fn delete_history_entry(app: tauri::AppHandle, cache_dir: String) -> Result<Vec<HistoryEntry>, String> {
    let p = history_path(&app)?;
    let mut cur: Vec<HistoryEntry> = if p.exists() {
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    cur.retain(|e| e.cache_dir != cache_dir);
    let body = serde_json::to_string_pretty(&cur).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| e.to_string())?;
    remove_cache_dir(&app, &cache_dir);
    Ok(cur)
}

/// Clear all history + remove every associated cached run dir. Returns empty list.
#[tauri::command]
fn clear_history(app: tauri::AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let p = history_path(&app)?;
    let cur: Vec<HistoryEntry> = if p.exists() {
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    for e in &cur {
        remove_cache_dir(&app, &e.cache_dir);
    }
    std::fs::write(&p, "[]").map_err(|e| e.to_string())?;
    Ok(vec![])
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

/// Write a generated text/HTML document to a user-chosen destination (e.g. the
/// Methodology & Rules export). Like save_report but for in-app-generated content.
#[tauri::command]
fn save_text(dest: String, content: String) -> Result<(), String> {
    std::fs::write(&dest, content).map_err(|e| format!("could not save file: {e}"))?;
    Ok(())
}

#[derive(serde::Serialize)]
struct VerifyResult {
    ok: bool,
    status: u16,
    reachable: bool,
    has_tier_markers: bool,
    note: String,
}

/// User-triggered one-off web check against the Atlas tier-spec docs. Confirms the page is
/// reachable and looks like the cluster-tier spec page. It does NOT auto-scrape exact
/// numbers (the UI stamps a confirmation; users edit numbers via the override tier table).
/// The default analysis run stays 100% offline — this is the only network call.
#[tauri::command]
async fn verify_tier_specs(url: String) -> Result<VerifyResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(VerifyResult {
                ok: false,
                status: 0,
                reachable: false,
                has_tier_markers: false,
                note: format!("couldn't verify ({e}) — using bundled specs"),
            })
        }
    };
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let hits = ["M30", "M40", "M50", "vCPU", "RAM", "IOPS"]
        .iter()
        .filter(|m| body.contains(**m))
        .count();
    let has = hits >= 2;
    let ok = status.is_success() && has;
    Ok(VerifyResult {
        ok,
        status: status.as_u16(),
        reachable: status.is_success(),
        has_tier_markers: has,
        note: if ok {
            "Atlas spec page reachable and recognizable".to_string()
        } else if status.is_success() {
            "page reachable but tier markers not found — using bundled specs".to_string()
        } else {
            format!("HTTP {} — using bundled specs", status.as_u16())
        },
    })
}

/// Recompute the sizing recommendation from a cached results.json for a new cloud/intent,
/// WITHOUT re-decoding the FTDC. Returns the fresh sizing_recommendation JSON.
#[tauri::command]
async fn resize(
    app: tauri::AppHandle,
    results_path: String,
    cloud: String,
    intent: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut args: Vec<String> =
        vec!["--resize-from".to_string(), results_path, "--cloud".to_string(), cloud];
    if let Some(i) = intent.filter(|s| !s.is_empty()) {
        args.push("--intent".to_string());
        args.push(i);
    }
    if let Some(ov) = ruleset::existing_overrides_path(&app) {
        args.push("--ruleset-overrides".to_string());
        args.push(ov);
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
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_str(&String::from_utf8_lossy(&output.stdout))
        .map_err(|e| format!("could not parse sizing JSON: {e}"))
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
            delete_history_entry,
            clear_history,
            save_report,
            save_text,
            verify_tier_specs,
            resize,
            get_username,
            llm::llm_list_models,
            llm::llm_chat,
            llm::llm_get_config,
            llm::llm_set_config,
            ruleset::ruleset_dump,
            ruleset::ruleset_get_overrides,
            ruleset::ruleset_set_overrides,
            ruleset::ruleset_overrides_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
