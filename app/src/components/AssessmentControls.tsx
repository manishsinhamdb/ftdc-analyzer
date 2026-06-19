// Shared assessment controls used on both the landing screen and the Assessment tab:
// mode (Grounded / LLM-reasoned), model picker (paid models gated), and the targeted
// category selector (16 categories grouped by family; input-gated ones marked).

import { useEffect, useMemo, useState } from "react";
import { Check, Cpu, FileText, Loader2, Lock } from "lucide-react";

import {
  type LabeledModel,
  type LlmConfig,
  ANTHROPIC_FALLBACK_MODELS,
  activeProvider,
  getLlmConfig,
  labelModelsForDialect,
  makeClient,
  setLlmConfig,
} from "@/lib/llm";
import {
  type RuleCategory,
  type RulesetDump,
  FAMILY_COLOR,
  FAMILY_ORDER,
  cachedRulesetDump,
  mergeIntents,
} from "@/lib/ruleset";

export type AssessmentMode = "grounded" | "llm";

// ---------------------------------------------------------------------------
export function ModeSelector({
  mode,
  onChange,
}: {
  mode: AssessmentMode;
  onChange: (m: AssessmentMode) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {(["grounded", "llm"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={
            "rounded px-2.5 py-1 text-xs font-medium transition-colors " +
            (mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/50")
          }
          title={
            m === "grounded"
              ? "Deterministic ledger only — instant, no LLM"
              : "Narrate the scored findings with the selected model"
          }
        >
          {m === "grounded" ? "Grounded" : "LLM-reasoned"}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function ModelPicker({
  model,
  onChange,
  compact,
}: {
  model: string | null;
  onChange: (model: string) => void;
  compact?: boolean;
}) {
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  const [models, setModels] = useState<LabeledModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await getLlmConfig();
        if (!alive) return;
        setCfg(c);
        if (c.model) onChange(c.model); // sync parent to the persisted choice
        const ap = activeProvider(c);
        try {
          const res = await makeClient(ap).listModels();
          if (!alive) return;
          setModels(labelModelsForDialect(res.models, ap.dialect).filter((m) => m.selectable));
        } catch (e) {
          // Anthropic without a key (or unreachable) → offer the known fallback list.
          if (ap.dialect === "anthropic") {
            setModels(labelModelsForDialect(ANTHROPIC_FALLBACK_MODELS, "anthropic"));
          } else {
            throw e;
          }
        }
        setErr(null);
      } catch (e) {
        if (alive) setErr(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function pick(id: string) {
    onChange(id);
    if (cfg) {
      try {
        await setLlmConfig({ ...cfg, model: id });
      } catch {
        /* persist best-effort */
      }
    }
  }

  const local = models.filter((m) => m.tier === "local");
  const cloud = models.filter((m) => m.tier === "cloud");

  if (loading) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> loading models…
      </span>
    );
  }
  if (err) {
    return (
      <span className="text-xs text-destructive" title={err}>
        models unavailable — set endpoint in LLM Settings
      </span>
    );
  }

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Cpu className="size-3.5 text-primary" />
      {!compact && <span>model</span>}
      <select
        value={model ?? ""}
        onChange={(e) => pick(e.target.value)}
        className="h-8 max-w-[220px] rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground"
      >
        <option value="" disabled>
          select a model…
        </option>
        {local.length > 0 && (
          <optgroup label="local (free)">
            {local.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.reasoningOnly ? " (reasoning)" : ""}
              </option>
            ))}
          </optgroup>
        )}
        {cloud.length > 0 && (
          <optgroup label="cloud (free, may change)">
            {cloud.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
export function CategorySelector({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [cats, setCats] = useState<RuleCategory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    cachedRulesetDump()
      .then((rs) => {
        if (alive) setCats(rs.categories);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const byFamily = FAMILY_ORDER.map(
    (f) => [f, cats.filter((c) => c.family === f)] as [string, RuleCategory[]],
  ).filter(([, cs]) => cs.length > 0);

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <FileText className="size-3.5" />
      <span>focus</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={loading}
        className="h-8 max-w-[260px] rounded-md border border-border bg-background px-2 text-xs text-foreground"
      >
        <option value="">Full sweep (all categories)</option>
        {byFamily.map(([fam, cs]) => (
          <optgroup key={fam} label={fam}>
            {cs.map((c) => {
              const gate = c.required_inputs.filter((i) => i !== "ftdc");
              return (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {gate.length ? ` — requires ${gate.join("/")}` : ""}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Intent picker — MULTI-select over the 7 presets. Click a card to add/remove (toggle);
// "Full sweep" is exclusive. The combined (union) category preview + lock-flags update as
// the selection changes. Ruleset dump is the shared cached promise (prefetched), and the
// per-intent previews are memoized — so Step 2 paints instantly (no per-render recompute).
// ---------------------------------------------------------------------------
export function IntentPicker({
  value,
  onChange,
  providedInputs,
}: {
  value: string | null;
  onChange: (ids: string) => void; // canonical comma-joined intent ids
  providedInputs: Set<string>;
}) {
  const [rs, setRs] = useState<RulesetDump | null>(null);
  useEffect(() => {
    let alive = true;
    cachedRulesetDump()
      .then((r) => alive && setRs(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const selectedSet = useMemo(
    () => new Set((value ?? "").split(",").filter(Boolean)),
    [value],
  );

  // Memoized once from the ruleset: category lookup + canonical intent order.
  const catById = useMemo(
    () => new Map((rs?.categories ?? []).map((c) => [c.id, c])),
    [rs],
  );

  // Combined (union) preview categories for the current selection — memoized on selection.
  const previewCats = useMemo<RuleCategory[]>(() => {
    if (!rs) return [];
    const chosen = rs.intents.filter((i) => selectedSet.has(i.id));
    const merged = mergeIntents(chosen);
    if (!merged) return [];
    if (merged.full_sweep) {
      const lead = merged.categories.map((c) => c.category_id);
      const rest = rs.categories.filter((c) => !lead.includes(c.id)).map((c) => c.id);
      return [...lead, ...rest].map((id) => catById.get(id)).filter(Boolean) as RuleCategory[];
    }
    return merged.categories.map((c) => catById.get(c.category_id)).filter(Boolean) as RuleCategory[];
  }, [rs, selectedSet, catById]);

  const fullSweepSelected = selectedSet.has("full_sweep");

  if (!rs) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> loading intents…
      </span>
    );
  }

  const toggle = (id: string) => {
    let next: Set<string>;
    if (id === "full_sweep") {
      next = selectedSet.has("full_sweep") ? new Set() : new Set(["full_sweep"]);
    } else {
      next = new Set(selectedSet);
      next.delete("full_sweep"); // mutually exclusive
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    // canonical order = ruleset intent order
    const canon = rs.intents.filter((i) => next.has(i.id)).map((i) => i.id).join(",");
    onChange(canon);
  };

  const missingFor = (c: RuleCategory) => c.required_inputs.filter((i) => !providedInputs.has(i));

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-muted-foreground">
        Select one or more — the lens is the union of the chosen intents. “Full sweep” is exclusive.
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rs.intents.map((intent) => {
          const sel = selectedSet.has(intent.id);
          const dim = fullSweepSelected && intent.id !== "full_sweep";
          return (
            <button
              key={intent.id}
              onClick={() => toggle(intent.id)}
              className={
                "rounded-lg border p-3 text-left transition-colors " +
                (sel ? "border-primary bg-primary/10" : "border-border hover:bg-secondary/40") +
                (dim ? " opacity-50" : "")
              }
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    "flex size-4 shrink-0 items-center justify-center rounded border " +
                    (sel ? "border-primary bg-primary text-primary-foreground" : "border-border")
                  }
                >
                  {sel && <Check className="size-3" />}
                </span>
                <span className="text-sm font-semibold">{intent.title}</span>
              </div>
              <p className="mt-0.5 pl-6 text-[11px] leading-snug text-muted-foreground">{intent.subtitle}</p>
            </button>
          );
        })}
      </div>

      {previewCats.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-secondary/20 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {fullSweepSelected ? "Surfaces all categories, ranked by confidence" : "Combined lens surfaces"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {previewCats.slice(0, fullSweepSelected ? 6 : 99).map((c) => {
              const miss = missingFor(c);
              const locked = miss.length > 0;
              return (
                <span
                  key={c.id}
                  title={locked ? `Needs ${miss.join(", ")} — add it in Step 1 or this shows as locked` : c.name}
                  className={
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] " +
                    (locked ? "border-[#4DA6FF]/40 bg-[#4DA6FF]/10 text-[#4DA6FF]" : "border-border text-muted-foreground")
                  }
                  style={!locked ? { borderColor: `${FAMILY_COLOR[c.family] ?? "#5A6E82"}55` } : undefined}
                >
                  {locked && <Lock className="size-2.5" />}
                  {c.name}
                  {locked && ` · needs ${miss.join("/")}`}
                </span>
              );
            })}
            {fullSweepSelected && <span className="text-[10px] text-muted-foreground">…and the rest</span>}
          </div>
        </div>
      )}
    </div>
  );
}
