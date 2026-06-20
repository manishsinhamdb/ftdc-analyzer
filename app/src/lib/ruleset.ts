// Layer-2 ruleset + scorer types and Tauri bridges.
//
// The engine is the source of truth: `rulesetDump()` returns the merged
// defaults+overrides ruleset (for the Methodology/Manage panel); user edits are written
// as an override layer via `rulesetSetOverrides()`. `assessment_v2` (the scored output)
// rides in results.json and is typed here for the Assessment tab.

import { invoke } from "@tauri-apps/api/core";

export type RuleStatus = "active" | "stub";
export type Direction = "+" | "-";
export type CategoryStatus =
  | "scored"
  | "input_provided"
  | "requires_input"
  | "stub"
  | "disabled";

export interface IntentCategoryRef {
  category_id: string;
  lean: number;
}

export interface IntentDef {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  categories: IntentCategoryRef[];
  full_sweep: boolean;
  note: string;
}

export interface RuleDisambiguator {
  co_signal: string;
  comparator: string;
  value: number;
  effect: "enable" | "suppress" | "scale";
  scale: number;
  note: string;
}

export interface RuleSignal {
  metric_path: string;
  weight: number;
  direction: Direction;
  comparator: string;
  threshold: number;
  stat: string;
  interpretation: string;
  disambiguator: RuleDisambiguator | null;
  status: RuleStatus;
  unit: string;
}

export interface RuleCategory {
  id: string;
  name: string;
  family: string;
  description: string;
  required_inputs: string[];
  signals: RuleSignal[];
  caveats: string[];
  recommendation: string;
  conditioned_by: string[];
  conditional_recommendations: Record<string, string>;
  status: RuleStatus;
  enabled: boolean;
  fire_threshold: number;
}

// ---- evidence-input registry (engine source of truth, mirrored to the wizard) ----
export interface InputCollector {
  command: string;
  where: string;
  role: string;
  security_note: string;
  doc: string;
}

export interface InputRegistryEntry {
  id: string;
  label: string;
  format: "dir" | "json" | "text";
  primary: boolean;
  description: string;
  unlocks: string[];
  collector: InputCollector;
  parser: string | null;
  parseable: boolean;
  cli_flag: string | null;
}

export interface InputRegistry {
  version: number;
  inputs: InputRegistryEntry[];
  primary: string[];
}

// Built-in default registry — mirrors the engine's seeded inputs so the wizard Inputs step
// paints INSTANTLY (no first-paint gate on a sidecar spawn). The engine's `inputs_registry`
// (which may carry operator overrides) hydrates over this non-blockingly. Keep in sync with
// ftdc_analyzer/inputs/registry.py (a self-UAT asserts the ids/primary set match).
export const DEFAULT_INPUT_REGISTRY: InputRegistry = {
  version: 1,
  primary: ["ftdc", "healthcheck"],
  inputs: [
    {
      id: "ftdc", label: "FTDC diagnostic.data", format: "dir", primary: true, parseable: false,
      parser: null, cli_flag: null,
      description:
        "MongoDB Full-Time Diagnostic Data Capture — host-level time-series the engine decodes directly.",
      unlocks: ["memory_cache_pressure", "cpu_compute_sizing", "disk_io_saturation",
        "replication_lag_cascade", "write_path_contention", "connection_workload_surge",
        "checkpoint_storage_stalls", "errors_stability", "version_config_risk", "periodic_health_review"],
      collector: {
        command: "cp -r <dbPath>/diagnostic.data ./diagnostic.data   # then select the folder",
        where: "the mongod host (the data directory)",
        role: "filesystem read on the mongod data dir",
        security_note: "FTDC holds host-level metrics + config metadata only — no document data.",
        doc: "Atlas captures it automatically; self-managed mongod writes it under dbPath.",
      },
    },
    {
      id: "healthcheck", label: "Healthcheck snapshot (getMongoData)", format: "json",
      primary: true, parseable: true, parser: "ftdc_analyzer.inputs.healthcheck_input:parse",
      cli_flag: "--healthcheck",
      description:
        "getMongoData/Keyhole snapshot — server/host facts, per-collection storage & index stats, topology, oplog.",
      unlocks: ["index_health_bloat", "schema_datamodel", "storage_capacity_design"],
      collector: {
        command: 'mongosh "<uri>" --quiet --file collectors/getMongoData.js > healthcheck.json',
        where: "any replica-set member (run on each member to compare)",
        role: "clusterMonitor + readAnyDatabase",
        security_note: "Reveals database/collection names + index keys (schema-revealing); no document data.",
        doc: "The collector script is bundled at collectors/getMongoData.js.",
      },
    },
    {
      id: "profiler", label: "Query profiler / slow-query log", format: "json", primary: false,
      parseable: false, parser: null, cli_flag: "--profiler",
      description: "system.profile export or slow-query log — the per-query truth FTDC's proxy cannot provide.",
      unlocks: ["query_targeting_index_recs", "slow_query_hotspots"],
      collector: {
        command: "db.setProfilingLevel(1,{slowms:100});  // later: mongoexport -d <db> -c system.profile > profiler.json",
        where: "a representative member, during a representative window",
        role: "clusterMonitor + read on the profiled db",
        security_note: "Query predicates can contain literal field VALUES (PII). Redact / handle locally; lower slowms only briefly.",
        doc: "Disable afterwards: db.setProfilingLevel(0).",
      },
    },
    {
      id: "sh_status", label: "Sharding status (sh.status())", format: "json", primary: false,
      parseable: true, parser: "ftdc_analyzer.inputs.sh_status:parse", cli_flag: "--sh-status",
      description:
        "Sharded-cluster topology — shards, databases & primary shards, sharded collections, chunk counts, balancer, jumbo chunks.",
      unlocks: ["sharding_topology"],
      collector: {
        command: 'mongosh "<mongos-uri>" --quiet --eval "sh.status()" > sh_status.json',
        where: "a mongos router (NOT a shard mongod)",
        role: "clusterMonitor",
        security_note: "Exposes shard hostnames, database/collection names and shard keys (schema-revealing) — no document data.",
        doc: "Must come from a mongos; a shard mongod cannot see cluster-wide chunk state.",
      },
    },
    {
      id: "rs_status", label: "Replica-set status (rs.status())", format: "json", primary: false,
      parseable: true, parser: "ftdc_analyzer.inputs.rs_status:parse", cli_flag: "--rs-status",
      description:
        "replSetGetStatus — full member roster, per-member state/health/optime, measured replication lag, term & configVersion.",
      unlocks: ["replication_lag_cascade"],
      collector: {
        command: 'mongosh "<member-uri>" --quiet --eval "JSON.stringify(rs.status())" > rs_status.json',
        where: "any replica-set member (primary or secondary)",
        role: "clusterMonitor",
        security_note: "Exposes member hostnames + replication state only — no document data.",
        doc: "Gives the full roster (not just the captured member) + measured lag.",
      },
    },
  ],
};

export interface RulesetDump {
  version: number;
  families: string[];
  inputs: string[];
  categories: RuleCategory[];
  intents: IntentDef[];
  tier_tables?: Record<string, import("@/lib/sizing").TierTable>;
  /** The evidence-input registry — drives the wizard slots, collector helpers, and the
   *  "awaiting input — provide X" messages. Present from Phase 9 on. */
  inputs_registry?: InputRegistry;
}

// ---- scored output (assessment_v2) ---------------------------------------
export interface LedgerRow {
  signal: string;
  stat: string;
  value: number | null;
  weight: number;
  direction: Direction;
  comparator: string;
  threshold: number;
  passed: boolean;
  factor: number;
  contribution: number;
  interpretation: string;
  reason: string;
  unit: string;
  disambiguator: {
    co_signal: string;
    comparator: string;
    value: number;
    effect: string;
    co_value: number | null;
    co_passed: boolean;
    factor_applied: number;
    note: string;
  } | null;
}

export interface CrossReference {
  category: string;
  name: string;
  status: string;
  confidence?: number;
  effect: string;
  note: string;
  missing_inputs?: string[];
}

export interface CategoryResult {
  id: string;
  name: string;
  family: string;
  description: string;
  required_inputs: string[];
  status: CategoryStatus;
  missing_inputs: string[];
  confidence: number | null;
  fired: boolean;
  fire_threshold: number;
  score_raw: number | null;
  score_denominator: number | null;
  recommendation: string;
  recommendation_conditioned: boolean;
  default_recommendation: string;
  caveats: string[];
  conditioned_by: string[];
  cross_references: CrossReference[];
  ledger: LedgerRow[];
  signals_count: number;
  focus?: boolean;
  in_lens?: boolean;
  lean?: number;
  provided_inputs?: string[];
  // Healthcheck-derived dynamic evidence merged post-scoring (Structural-Design categories).
  healthcheck_evidence?: {
    drop_list?: { index: string; size_mb: number }[];
    [k: string]: unknown;
  } | null;
  // A fired *context* state (e.g. sharding single-shard caveat) — surfaced, not scored.
  context_fired?: boolean;
  context_kind?: string;
  context_note?: string;
}

export interface AssessmentV2 {
  version: number;
  mode: "full" | "targeted" | "intent";
  target_category: string | null;
  intent: IntentDef | null;
  intent_members?: { id: string; title: string; subtitle: string }[];
  available_inputs: string[];
  provided_inputs?: string[];
  provided_paths?: Record<string, string>;
  ruleset_version: number;
  families: string[];
  counts: {
    scored: number;
    input_provided?: number;
    requires_input: number;
    stub: number;
    disabled: number;
    fired: number;
  };
  ranked: CategoryResult[];
  llm_narration: string | null;
  overrides_applied?: boolean;
}

// ---- overrides document --------------------------------------------------
export interface SignalOverride {
  weight?: number;
  threshold?: number;
  direction?: Direction;
  comparator?: string;
  stat?: string;
  interpretation?: string;
}

export interface CategoryOverride {
  enabled?: boolean;
  recommendation?: string;
  caveats?: string[];
  fire_threshold?: number;
  signals?: Record<string, SignalOverride>;
  added_signals?: Partial<RuleSignal>[];
  removed_signals?: string[];
}

export interface OverridesDoc {
  version: number;
  categories: Record<string, CategoryOverride>;
  intents?: Record<string, unknown>;
  tier_tables?: Record<string, unknown>;
}

export const FAMILY_ORDER = [
  "Capacity",
  "Incident-RCA",
  "Cluster-Context",
  "Structural-Design",
  "Query-Optimization",
  "Cross-Cutting",
];

export const STATUS_COLOR: Record<CategoryStatus, string> = {
  scored: "#00ED64",
  input_provided: "#B392F0",
  requires_input: "#4DA6FF",
  stub: "#5A6E82",
  disabled: "#5A6E82",
};

export const FAMILY_COLOR: Record<string, string> = {
  Capacity: "#00ED64",
  "Incident-RCA": "#E05C4B",
  "Cluster-Context": "#4DA6FF",
  "Structural-Design": "#B392F0",
  "Query-Optimization": "#FFC857",
  "Cross-Cutting": "#8AA0B6",
};

// Per-source unlock message for requires_input categories. Registry-aware: names the exact
// input(s) by their registry label when the registry is available (Phase 9), else falls back.
export function unlockMessage(missing: string[], registry?: InputRegistry | null): string {
  if (registry) {
    const labels = missing.map(
      (id) => registry.inputs.find((i) => i.id === id)?.label ?? id,
    );
    return `Data not available — provide ${labels.join(" + ")} to populate this.`;
  }
  const set = new Set(missing);
  if (set.has("profiler")) {
    return "Data not available — upload the MongoDB slow-query log / profiler output to populate this.";
  }
  if (set.has("healthcheck")) {
    return "Data not available — upload the healthcheck snapshot (getMongoData.js output) to populate this.";
  }
  return `Data not available — provide ${missing.join(", ")} to populate this.`;
}

// Shared input-registry promise derived from the SAME cached ruleset dump (one sidecar spawn
// per session, prefetched on app mount). Always resolves to a usable registry — the built-in
// default if the engine dump lacks one or the sidecar is unreachable — so the UI never blocks
// on it and never shows a "loading" stall.
export async function cachedInputRegistry(): Promise<InputRegistry> {
  try {
    const dump = await cachedRulesetDump();
    return dump.inputs_registry ?? DEFAULT_INPUT_REGISTRY;
  } catch {
    return DEFAULT_INPUT_REGISTRY;
  }
}

// Client-side re-lens of an already-scored assessment for a new intent — reorders +
// re-tags in_lens/lean WITHOUT re-decoding/re-scoring (confidences/ledgers are unchanged).
// Mirrors the Python scorer's _apply_intent_lens so "re-run from cached decode" matches.
export function relensAssessment(v2: AssessmentV2, intent: IntentDef): void {
  const order = new Map<string, number>();
  const lean = new Map<string, number>();
  intent.categories.forEach((c, i) => {
    order.set(c.category_id, i);
    lean.set(c.category_id, c.lean);
  });
  const RANK: Record<string, number> = {
    scored: 0,
    input_provided: 1,
    requires_input: 2,
    stub: 3,
    disabled: 4,
  };
  for (const r of v2.ranked) {
    if (intent.full_sweep) {
      r.in_lens = true;
      r.lean = lean.get(r.id) ?? 1;
    } else {
      r.in_lens = order.has(r.id);
      r.lean = lean.get(r.id) ?? 0;
    }
  }
  const keyOf = (r: CategoryResult): number[] => {
    const lead = order.has(r.id);
    if (intent.full_sweep) {
      return lead ? [0, order.get(r.id)!] : [1, RANK[r.status] ?? 9, -(r.confidence ?? 0)];
    }
    return r.in_lens ? [0, order.get(r.id)!] : [1, RANK[r.status] ?? 9, -(r.confidence ?? 0)];
  };
  v2.ranked = [...v2.ranked].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d) return d;
    }
    return a.name.localeCompare(b.name);
  });
  v2.intent = intent;
  v2.mode = "intent";
}

// Union of several intents' lenses (mirrors the engine's _merge_intents): dedupe
// categories, lean = best across selected, ordered by descending best-lean.
export function mergeIntents(objs: IntentDef[]): IntentDef | null {
  if (objs.length === 0) return null;
  if (objs.length === 1) return objs[0];
  const full = objs.some((o) => o.full_sweep);
  const bestLean = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let seq = 0;
  for (const o of objs) {
    for (const c of o.categories) {
      if (!firstSeen.has(c.category_id)) firstSeen.set(c.category_id, seq++);
      bestLean.set(c.category_id, Math.max(bestLean.get(c.category_id) ?? 0, c.lean));
    }
  }
  const categories = [...bestLean.keys()]
    .sort((a, b) => (bestLean.get(b)! - bestLean.get(a)!) || (firstSeen.get(a)! - firstSeen.get(b)!))
    .map((id) => ({ category_id: id, lean: bestLean.get(id)! }));
  return {
    id: objs.map((o) => o.id).join("+"),
    title: objs.map((o) => o.title).join(" + "),
    subtitle: "Combined lens — union of the selected intents",
    description: "Union of: " + objs.map((o) => o.title).join("; "),
    categories,
    full_sweep: full,
    note: objs.map((o) => o.note).filter(Boolean).join("; "),
  };
}

// ---- Tauri bridges -------------------------------------------------------
export const rulesetDump = () => invoke<RulesetDump>("ruleset_dump");

// Single shared, prefetchable ruleset-dump promise (one sidecar spawn, reused by the
// intent/category selectors so Step 2 paints instantly — see A-perf note).
let _dumpCache: Promise<RulesetDump> | null = null;
export function cachedRulesetDump(): Promise<RulesetDump> {
  if (!_dumpCache) _dumpCache = rulesetDump();
  return _dumpCache;
}
export const rulesetGetOverrides = () => invoke<OverridesDoc | Record<string, never>>("ruleset_get_overrides");
export const rulesetSetOverrides = (overrides: OverridesDoc) =>
  invoke<void>("ruleset_set_overrides", { overrides });
export const rulesetOverridesPath = () => invoke<string>("ruleset_overrides_path");
