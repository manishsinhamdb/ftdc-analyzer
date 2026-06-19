// Swappable LLM provider layer (plumbing only — no assessment/scoring logic).
//
// One internal provider interface + an adapter registry keyed by `dialect`. The
// OpenAI-compatible adapter is implemented now; adding another dialect later is a new
// adapter class here, not a rewrite. The actual HTTP lives in the Rust/Tauri layer
// (commands below) so the Python engine stays pure/offline and the LLM is optional.

import { invoke } from "@tauri-apps/api/core";

export type Dialect = "openai" | "anthropic";

export interface LlmProvider {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string | null;
  dialect: Dialect;
}

// Multi-provider config: saved providers + which is active + active model.
export interface LlmConfig {
  providers: LlmProvider[];
  activeId: string | null;
  model: string | null;
}

export const DIALECTS: { id: Dialect; label: string; defaultBaseUrl: string }[] = [
  { id: "openai", label: "OpenAI-compatible", defaultBaseUrl: "https://api.openai.com" },
  { id: "anthropic", label: "Anthropic (Claude)", defaultBaseUrl: "https://api.anthropic.com" },
];

// Shown in the Anthropic model picker when /v1/models can't be fetched (e.g. no key yet).
export const ANTHROPIC_FALLBACK_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

export function activeProvider(cfg: LlmConfig): LlmProvider {
  return cfg.providers.find((p) => p.id === cfg.activeId) ?? cfg.providers[0];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  ok: boolean;
  content?: string | null;
  model?: string | null;
  error?: string | null;
  // none | subscription | auth | rate_limit | timeout | network | http | parse
  kind?: string | null;
}

export interface ModelsResult {
  models: string[];
  count: number;
}

// ---- model catalog: tiers, labels, gating --------------------------------
export type ModelTier = "local" | "cloud" | "embedding" | "paid";

export interface LabeledModel {
  id: string;
  tier: ModelTier;
  label: string;
  selectable: boolean; // false for embedding (RAG-only) and paid (gated)
  reasoningOnly: boolean; // available but not a sensible default
  isDefault: boolean;
}

// Known paid `:cloud` models that return a subscription error — gated out of the
// picker up front (both the suffixed ids the endpoint emits and the bare forms).
export const PAID_DENYLIST = new Set<string>([
  "kimi-k2.6:cloud",
  "mistral-large-3:675b-cloud",
  "deepseek-v3.1:671b-cloud",
  "kimi-k2.6",
  "mistral-large-3:675b",
  "deepseek-v3.1:671b",
]);

const TIER_LABEL: Record<ModelTier, string> = {
  local: "local (free)",
  cloud: "cloud (free, may change)",
  embedding: "embedding",
  paid: "cloud (paid — subscription)",
};

// Heuristic + data-driven: classify from the /v1/models id, hardcoding only the
// denylist. `extraPaid` carries ids discovered to need a subscription when probed.
export function labelModel(id: string, extraPaid?: Set<string>): LabeledModel {
  const lc = id.toLowerCase();
  let tier: ModelTier;
  if (PAID_DENYLIST.has(id) || extraPaid?.has(id)) tier = "paid";
  else if (/embed/.test(lc)) tier = "embedding";
  else if (lc.includes("cloud")) tier = "cloud"; // :cloud / -cloud suffix → cloud tier
  else tier = "local";
  const reasoningOnly = /deepseek-r1/.test(lc);
  const selectable = tier === "local" || tier === "cloud";
  return { id, tier, label: TIER_LABEL[tier], selectable, reasoningOnly, isDefault: false };
}

// Dialect-aware labelling: ollama/OpenAI uses the paid-gating heuristic; Anthropic models
// run on the user's own key (no gating) and are all selectable.
export function labelModelsForDialect(
  ids: string[],
  dialect: Dialect,
  extraPaid?: Set<string>,
): LabeledModel[] {
  if (dialect === "anthropic") {
    return ids.map((id) => ({
      id,
      tier: "cloud" as ModelTier,
      label: "Claude (your key)",
      selectable: true,
      reasoningOnly: false,
      isDefault: false,
    }));
  }
  return labelModels(ids, extraPaid);
}

export function labelModels(ids: string[], extraPaid?: Set<string>): LabeledModel[] {
  const labeled = ids.map((id) => labelModel(id, extraPaid));
  // Default: prefer ministral-3:8b; else first selectable local non-reasoning; else any selectable.
  const def =
    labeled.find((m) => m.id === "ministral-3:8b" && m.selectable) ??
    labeled.find((m) => m.selectable && m.tier === "local" && !m.reasoningOnly) ??
    labeled.find((m) => m.selectable);
  if (def) def.isDefault = true;
  return labeled;
}

export const TIER_ORDER: ModelTier[] = ["local", "cloud", "embedding", "paid"];

// ---- adapter registry: one client per dialect (HTTP delegated to Rust) ----
export interface ProviderClient {
  provider: LlmProvider;
  listModels(): Promise<ModelsResult>;
  chat(messages: ChatMessage[], model: string, opts?: ChatOpts): Promise<ChatResponse>;
}

// One client for all dialects — the HTTP + dialect branching lives in Rust (llm.rs).
class LlmClient implements ProviderClient {
  constructor(public provider: LlmProvider) {}
  listModels(): Promise<ModelsResult> {
    return invoke<ModelsResult>("llm_list_models", { provider: this.provider });
  }
  chat(messages: ChatMessage[], model: string, opts?: ChatOpts): Promise<ChatResponse> {
    return invoke<ChatResponse>("llm_chat", {
      provider: this.provider,
      model,
      messages,
      opts: opts ?? null,
    });
  }
}

export function makeClient(provider: LlmProvider): ProviderClient {
  return new LlmClient(provider);
}

// ---- persisted config (Rust app-config store) ----------------------------
export const getLlmConfig = () => invoke<LlmConfig>("llm_get_config");
export const setLlmConfig = (config: LlmConfig) => invoke<void>("llm_set_config", { config });
