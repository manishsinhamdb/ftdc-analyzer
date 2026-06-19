//! Swappable LLM provider layer (plumbing only — no assessment/scoring logic).
//!
//! One provider config shape `{ id, label, baseUrl, apiKey?, dialect }` and one
//! OpenAI-compatible adapter. The HTTP lives here in Rust so the Python engine stays
//! pure/offline and the LLM is an optional async add-on. Adding another dialect later
//! is a new branch in `list_models_impl`/`chat_impl` (or a sibling module), not a
//! rewrite — the command surface and config shape stay the same.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

// ---------------------------------------------------------------------------
// Provider config + persisted settings
// ---------------------------------------------------------------------------
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProviderConfig {
    pub id: String,
    pub label: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "apiKey", default)]
    pub api_key: Option<String>,
    /// Wire dialect. Only "openai" is implemented today.
    #[serde(default = "default_dialect")]
    pub dialect: String,
}

fn default_dialect() -> String {
    "openai".to_string()
}

impl Default for ProviderConfig {
    /// The preconfigured default provider.
    fn default() -> Self {
        Self {
            id: "endpoint".to_string(),
            label: "ocialwaysfree".to_string(),
            base_url: "https://ai.ocialwaysfree.site".to_string(),
            api_key: None,
            dialect: "openai".to_string(),
        }
    }
}

/// The preconfigured, non-deletable default provider (labelled for the manager).
fn default_endpoint() -> ProviderConfig {
    ProviderConfig {
        id: "endpoint".to_string(),
        label: "Default — ocialwaysfree".to_string(),
        base_url: "https://ai.ocialwaysfree.site".to_string(),
        api_key: None,
        dialect: "openai".to_string(),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LlmConfig {
    /// Saved providers (the built-in default + any user-added).
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    /// Which saved provider is active.
    #[serde(default, rename = "activeId")]
    pub active_id: Option<String>,
    /// Chosen chat model on the active provider (None until picked).
    #[serde(default)]
    pub model: Option<String>,
    /// Legacy single-provider field — read for migration, never written.
    #[serde(default, skip_serializing)]
    pub provider: Option<ProviderConfig>,
}

/// Guarantee a usable config: migrate the legacy single provider, ensure the built-in
/// default is present, and pick a valid active provider.
fn ensure_providers(mut c: LlmConfig) -> LlmConfig {
    if c.providers.is_empty() {
        if let Some(p) = c.provider.take() {
            c.providers.push(p);
        }
    }
    if !c.providers.iter().any(|p| p.id == "endpoint") {
        c.providers.insert(0, default_endpoint());
    }
    let active_ok = c
        .active_id
        .as_ref()
        .map(|id| c.providers.iter().any(|p| &p.id == id))
        .unwrap_or(false);
    if !active_ok {
        c.active_id = c.providers.first().map(|p| p.id.clone());
    }
    c.provider = None;
    c
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize, Default, Debug)]
pub struct ChatOpts {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

// ---------------------------------------------------------------------------
// Results (structured — never panic; auth/subscription/timeout are data)
// ---------------------------------------------------------------------------
#[derive(Serialize, Debug)]
pub struct ModelsResult {
    pub models: Vec<String>,
    pub count: usize,
}

#[derive(Serialize, Debug, Default)]
pub struct ChatResponse {
    pub ok: bool,
    pub content: Option<String>,
    pub model: Option<String>,
    pub error: Option<String>,
    /// Classification: none | subscription | auth | rate_limit | timeout | network | http | parse
    pub kind: Option<String>,
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(90)) // cloud models can be slow; locals are fast
        .build()
        .expect("reqwest client builds")
}

fn base(p: &ProviderConfig) -> String {
    p.base_url.trim_end_matches('/').to_string()
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

fn net_kind(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timeout"
    } else {
        "network"
    }
}

/// Pull an error message out of either dialect: OpenAI `{error:{message}}` or
/// Ollama-native `{error:"..."}`.
fn extract_error(json: &serde_json::Value) -> Option<String> {
    match json.get("error") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Object(o)) => o
            .get("message")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string()),
        _ => None,
    }
}

fn classify_error(msg: &str, status: u16) -> String {
    let m = msg.to_lowercase();
    if m.contains("requires a subscription") || m.contains("upgrade for access") {
        "subscription".to_string()
    } else if status == 401 || status == 403 || m.contains("unauthor") || m.contains("api key") {
        "auth".to_string()
    } else if status == 402 || m.contains("payment") {
        "subscription".to_string()
    } else if status == 429 || m.contains("rate limit") {
        "rate_limit".to_string()
    } else {
        "http".to_string()
    }
}

fn anthropic_kind(etype: &str, status: u16, msg: &str) -> String {
    let m = msg.to_lowercase();
    if status == 401 || status == 403 || etype.contains("authentication") || m.contains("api key") {
        "auth".to_string()
    } else if status == 429 || etype.contains("rate_limit") {
        "rate_limit".to_string()
    } else if status == 529 || etype.contains("overloaded") {
        "rate_limit".to_string()
    } else if etype.contains("permission") || etype.contains("billing") || status == 402 {
        "subscription".to_string()
    } else {
        "http".to_string()
    }
}

// ---------------------------------------------------------------------------
// Dialect dispatch
// ---------------------------------------------------------------------------
pub async fn list_models_impl(p: &ProviderConfig) -> Result<ModelsResult, String> {
    match p.dialect.as_str() {
        "anthropic" => anthropic_list_models(p).await,
        _ => openai_list_models(p).await,
    }
}

pub async fn chat_impl(
    p: &ProviderConfig,
    model: &str,
    messages: Vec<ChatMessage>,
    opts: Option<ChatOpts>,
) -> ChatResponse {
    match p.dialect.as_str() {
        "anthropic" => anthropic_chat(p, model, messages, opts).await,
        "openai" => openai_chat(p, model, messages, opts).await,
        other => ChatResponse {
            ok: false,
            error: Some(format!("unsupported dialect: {other}")),
            kind: Some("http".to_string()),
            ..Default::default()
        },
    }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter (dialect = "openai")
// ---------------------------------------------------------------------------
async fn openai_list_models(p: &ProviderConfig) -> Result<ModelsResult, String> {
    let url = format!("{}/v1/models", base(p));
    let mut req = http_client().get(&url);
    if let Some(k) = p.api_key.as_ref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), truncate(&body, 300)));
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;
    let mut models = Vec::new();
    if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            }
        }
    }
    Ok(ModelsResult {
        count: models.len(),
        models,
    })
}

async fn openai_chat(
    p: &ProviderConfig,
    model: &str,
    messages: Vec<ChatMessage>,
    opts: Option<ChatOpts>,
) -> ChatResponse {
    let url = format!("{}/v1/chat/completions", base(p));
    let mut payload = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    if let Some(o) = opts {
        if let Some(t) = o.temperature {
            payload["temperature"] = serde_json::json!(t);
        }
        if let Some(mt) = o.max_tokens {
            payload["max_tokens"] = serde_json::json!(mt);
        }
    }
    let mut req = http_client().post(&url).json(&payload);
    if let Some(k) = p.api_key.as_ref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return ChatResponse {
                ok: false,
                error: Some(e.to_string()),
                kind: Some(net_kind(&e).to_string()),
                ..Default::default()
            }
        }
    };
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let json: serde_json::Value =
        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    // Error path: explicit error field, or any non-2xx body.
    let err = extract_error(&json).or_else(|| {
        if !status.is_success() {
            Some(truncate(&body, 300))
        } else {
            None
        }
    });
    if let Some(msg) = err {
        let kind = classify_error(&msg, status.as_u16());
        return ChatResponse {
            ok: false,
            error: Some(msg),
            kind: Some(kind),
            ..Default::default()
        };
    }

    let content = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let used_model = json
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    match content {
        Some(c) => ChatResponse {
            ok: true,
            content: Some(c),
            model: used_model,
            kind: Some("none".to_string()),
            ..Default::default()
        },
        None => ChatResponse {
            ok: false,
            error: Some(format!("no assistant content in response: {}", truncate(&body, 300))),
            kind: Some("parse".to_string()),
            ..Default::default()
        },
    }
}

// ---------------------------------------------------------------------------
// Anthropic / Claude adapter (dialect = "anthropic")
//   POST {baseUrl}/v1/messages with x-api-key + anthropic-version; system is a
//   top-level field (split out of the messages); response is content[].text.
// ---------------------------------------------------------------------------
async fn anthropic_list_models(p: &ProviderConfig) -> Result<ModelsResult, String> {
    let key = match p.api_key.as_ref().filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => return Err("Anthropic requires an API key".to_string()),
    };
    let url = format!("{}/v1/models", base(p));
    let resp = http_client()
        .get(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), truncate(&body, 200)));
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;
    let mut models = Vec::new();
    if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            }
        }
    }
    Ok(ModelsResult {
        count: models.len(),
        models,
    })
}

async fn anthropic_chat(
    p: &ProviderConfig,
    model: &str,
    messages: Vec<ChatMessage>,
    opts: Option<ChatOpts>,
) -> ChatResponse {
    let key = match p.api_key.as_ref().filter(|k| !k.is_empty()) {
        Some(k) => k.clone(),
        None => {
            return ChatResponse {
                ok: false,
                error: Some("Anthropic requires an API key".to_string()),
                kind: Some("auth".to_string()),
                ..Default::default()
            }
        }
    };
    // Anthropic: `system` is a top-level field; messages are only user/assistant.
    let mut system = String::new();
    let mut msgs: Vec<serde_json::Value> = Vec::new();
    for m in &messages {
        if m.role == "system" {
            if !system.is_empty() {
                system.push('\n');
            }
            system.push_str(&m.content);
        } else {
            msgs.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
    }
    let max_tokens = opts.as_ref().and_then(|o| o.max_tokens).unwrap_or(1024);
    let mut payload = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": msgs,
    });
    if !system.is_empty() {
        payload["system"] = serde_json::json!(system);
    }
    if let Some(o) = &opts {
        if let Some(t) = o.temperature {
            payload["temperature"] = serde_json::json!(t);
        }
    }
    let url = format!("{}/v1/messages", base(p));
    let resp = http_client()
        .post(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&payload)
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            return ChatResponse {
                ok: false,
                error: Some(e.to_string()),
                kind: Some(net_kind(&e).to_string()),
                ..Default::default()
            }
        }
    };
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    let is_err = !status.is_success()
        || json.get("type").and_then(|t| t.as_str()) == Some("error");
    if is_err {
        let msg = json
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| truncate(&body, 300));
        let etype = json
            .pointer("/error/type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return ChatResponse {
            ok: false,
            error: Some(msg.clone()),
            kind: Some(anthropic_kind(etype, status.as_u16(), &msg)),
            ..Default::default()
        };
    }
    // content is an array of blocks; concatenate the text blocks.
    let text = json
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let used = json.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    if text.trim().is_empty() {
        ChatResponse {
            ok: false,
            error: Some(format!("no text content in response: {}", truncate(&body, 200))),
            kind: Some("parse".to_string()),
            ..Default::default()
        }
    } else {
        ChatResponse {
            ok: true,
            content: Some(text),
            model: used,
            kind: Some("none".to_string()),
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn llm_list_models(provider: ProviderConfig) -> Result<ModelsResult, String> {
    list_models_impl(&provider).await
}

#[tauri::command]
pub async fn llm_chat(
    provider: ProviderConfig,
    model: String,
    messages: Vec<ChatMessage>,
    opts: Option<ChatOpts>,
) -> Result<ChatResponse, String> {
    // Always Ok: failures are surfaced as structured ChatResponse, not command errors.
    Ok(chat_impl(&provider, &model, messages, opts).await)
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create app config dir: {e}"))?;
    Ok(dir.join("llm_config.json"))
}

#[tauri::command]
pub fn llm_get_config(app: tauri::AppHandle) -> Result<LlmConfig, String> {
    let p = config_path(&app)?;
    if !p.exists() {
        return Ok(ensure_providers(LlmConfig::default()));
    }
    let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let parsed: LlmConfig = serde_json::from_str(&txt).unwrap_or_default();
    Ok(ensure_providers(parsed))
}

#[tauri::command]
pub fn llm_set_config(app: tauri::AppHandle, config: LlmConfig) -> Result<(), String> {
    let p = config_path(&app)?;
    let body = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Live round-trip smoke tests (network; run with `--ignored`)
//   cargo test --release llm::tests -- --ignored --nocapture
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn list_models_returns_endpoint_models() {
        let r = list_models_impl(&ProviderConfig::default()).await.unwrap();
        eprintln!("models ({}): {:?}", r.count, r.models);
        assert!(r.count >= 10, "expected the endpoint catalog");
    }

    #[tokio::test]
    #[ignore]
    async fn ministral_ping_returns_ok() {
        let r = chat_impl(
            &ProviderConfig::default(),
            "ministral-3:8b",
            vec![ChatMessage {
                role: "user".into(),
                content: "Reply with: OK".into(),
            }],
            None,
        )
        .await;
        eprintln!("ministral: ok={} content={:?} kind={:?}", r.ok, r.content, r.kind);
        // Round-trip success is what we assert; a weak model's exact wording varies.
        assert!(r.ok, "ministral ping should succeed");
        assert!(!r.content.unwrap_or_default().trim().is_empty());
    }

    fn anthropic_provider(key: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            id: "a".into(),
            label: "Anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            api_key: key.map(|s| s.to_string()),
            dialect: "anthropic".into(),
        }
    }

    #[tokio::test]
    #[ignore]
    async fn anthropic_no_key_fails_clean() {
        let r = chat_impl(
            &anthropic_provider(None),
            "claude-sonnet-4-6",
            vec![ChatMessage { role: "user".into(), content: "hi".into() }],
            None,
        )
        .await;
        assert!(!r.ok);
        assert_eq!(r.kind.as_deref(), Some("auth"));
    }

    #[tokio::test]
    #[ignore]
    async fn anthropic_bad_key_round_trip_auth() {
        // Real round-trip to api.anthropic.com with an invalid key → clean auth error.
        let r = chat_impl(
            &anthropic_provider(Some("sk-ant-invalid-key-for-test")),
            "claude-sonnet-4-6",
            vec![ChatMessage { role: "user".into(), content: "hi".into() }],
            None,
        )
        .await;
        eprintln!("anthropic bad key: ok={} kind={:?} err={:?}", r.ok, r.kind, r.error);
        assert!(!r.ok);
        assert_eq!(r.kind.as_deref(), Some("auth"));
    }

    #[tokio::test]
    #[ignore]
    async fn paid_model_classified_subscription() {
        let r = chat_impl(
            &ProviderConfig::default(),
            "kimi-k2.6:cloud",
            vec![ChatMessage {
                role: "user".into(),
                content: "Reply with: OK".into(),
            }],
            None,
        )
        .await;
        eprintln!("kimi: ok={} kind={:?} error={:?}", r.ok, r.kind, r.error);
        assert!(!r.ok);
        assert_eq!(r.kind.as_deref(), Some("subscription"));
    }
}
