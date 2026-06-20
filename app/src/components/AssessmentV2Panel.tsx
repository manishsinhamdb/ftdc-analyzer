import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileCheck,
  Flame,
  GitBranch,
  Layers,
  Lock,
  Loader2,
  Share2,
  Sparkles,
  Target,
  Upload,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  type AssessmentV2,
  type CategoryResult,
  type InputRegistry,
  type IntentDef,
  type LedgerRow,
  FAMILY_COLOR,
  cachedInputRegistry,
  cachedRulesetDump,
  mergeIntents,
  relensAssessment,
  unlockMessage,
} from "@/lib/ruleset";
import { RegistryCollectorHelp } from "@/components/CollectorHelp";
import { type LlmProvider, activeProvider, getLlmConfig } from "@/lib/llm";
import { type NarrationResult, runNarration } from "@/lib/narration";
import {
  type AssessmentMode,
  IntentLens,
  ModeSelector,
  ModelPicker,
} from "@/components/AssessmentControls";
import { SizingPanel } from "@/components/SizingPanel";

function ConfidenceBar({ value, threshold }: { value: number; threshold: number }) {
  // Grow from 0 → value on mount for a clear "score builds up" feel.
  const [w, setW] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setW(value), 60);
    return () => window.clearTimeout(id);
  }, [value]);
  const pct = Math.round(value * 100);
  const fired = value >= threshold;
  return (
    <div className="relative h-6 w-full overflow-hidden rounded-md bg-secondary/40">
      <div
        className="h-full rounded-md transition-[width] duration-700 ease-out"
        style={{ width: `${w * 100}%`, background: fired ? "#00ED64" : "#5A6E82" }}
      />
      <div
        className="absolute inset-y-0 w-px bg-foreground/50"
        style={{ left: `${threshold * 100}%` }}
        title={`fire threshold ${Math.round(threshold * 100)}%`}
      />
      <div className="absolute inset-0 flex items-center justify-between px-2 text-[11px] font-medium">
        <span className="text-foreground/90">confidence {pct}%</span>
        <span className="text-muted-foreground">fires ≥{Math.round(threshold * 100)}%</span>
      </div>
    </div>
  );
}

function LedgerTable({ ledger }: { ledger: LedgerRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-2 py-1 text-left font-medium">signal</th>
            <th className="px-2 py-1 text-right font-medium">value</th>
            <th className="px-2 py-1 text-center font-medium">test</th>
            <th className="px-2 py-1 text-right font-medium">weight</th>
            <th className="px-2 py-1 text-right font-medium">contribution</th>
            <th className="px-2 py-1 text-left font-medium">reason</th>
          </tr>
        </thead>
        <tbody>
          {ledger.map((r) => {
            const pos = r.contribution > 0;
            const neg = r.contribution < 0;
            return (
              <tr key={r.signal} className="border-b border-border/60 last:border-0">
                <td className="px-2 py-1 font-mono">
                  {r.signal}
                  {r.direction === "-" && (
                    <span className="ml-1 text-muted-foreground">(mitigating)</span>
                  )}
                  {r.disambiguator && (
                    <span
                      className="ml-1 text-[#FFC857]"
                      title={`${r.disambiguator.note} [${r.disambiguator.co_signal} ${r.disambiguator.comparator} ${r.disambiguator.value}: ${r.disambiguator.co_passed ? "met" : "not met"}]`}
                    >
                      ⚙
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  {r.value === null ? "—" : r.value}
                  {r.unit ? ` ${r.unit}` : ""}
                </td>
                <td className="px-2 py-1 text-center font-mono text-muted-foreground">
                  {r.comparator}
                  {r.threshold}
                </td>
                <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                  {r.weight}
                </td>
                <td
                  className="px-2 py-1 text-right font-mono font-semibold"
                  style={{ color: pos ? "#00ED64" : neg ? "#E05C4B" : "#5A6E82" }}
                >
                  {r.contribution > 0 ? "+" : ""}
                  {r.contribution}
                </td>
                <td className="px-2 py-1 text-muted-foreground">{r.reason}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ScoredCard({ r, focused }: { r: CategoryResult; focused?: boolean }) {
  const [open, setOpen] = useState(!!focused);
  const color = FAMILY_COLOR[r.family] ?? "#5A6E82";
  return (
    <Card className={"overflow-hidden p-0 " + (focused ? "ring-2 ring-primary" : "")}>
      <div className="flex">
        <div className="w-1 shrink-0" style={{ background: color }} />
        <div className="flex-1 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{r.name}</span>
            {focused && (
              <Badge className="text-[10px]" style={{ backgroundColor: "#FFC857", color: "#0D1B2A" }}>
                focus
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground">
              {r.family}
            </Badge>
            {r.fired && (
              <Badge className="gap-1 text-[10px]" style={{ backgroundColor: "#00ED64", color: "#0D1B2A" }}>
                <Flame className="size-3" /> fired
              </Badge>
            )}
            {r.recommendation_conditioned && (
              <Badge className="gap-1 text-[10px]" style={{ backgroundColor: "#FFC857", color: "#0D1B2A" }}>
                <GitBranch className="size-3" /> conditioned
              </Badge>
            )}
          </div>

          <ConfidenceBar value={r.confidence ?? 0} threshold={r.fire_threshold} />

          <p className="text-xs leading-relaxed text-foreground/90">{r.recommendation}</p>

          {r.cross_references.length > 0 && (
            <div className="space-y-1">
              {r.cross_references.map((x, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <GitBranch className="mt-0.5 size-3 shrink-0 text-[#FFC857]" />
                  <span>{x.note}</span>
                </div>
              ))}
            </div>
          )}

          {r.caveats.length > 0 && (
            <ul className="space-y-1">
              {r.caveats.map((c, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0 text-[#F5A623]" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            evidence ledger ({r.ledger.length} signals · score {r.score_raw}/{r.score_denominator})
          </button>
          {open && <LedgerTable ledger={r.ledger} />}
        </div>
      </div>
    </Card>
  );
}

function PlaceholderCard({ r, registry }: { r: CategoryResult; registry: InputRegistry | null }) {
  const [showHelp, setShowHelp] = useState(false);
  const color = FAMILY_COLOR[r.family] ?? "#5A6E82";
  const isReq = r.status === "requires_input";
  const isProvided = r.status === "input_provided";
  const badge = isProvided
    ? { icon: <FileCheck className="size-3" />, label: "input provided" }
    : isReq
      ? { icon: <Upload className="size-3" />, label: "needs data" }
      : { icon: <Lock className="size-3" />, label: "stub" };
  const text = isProvided
    ? `Input provided (${r.provided_inputs?.join(", ") || "file"}) — parsing & scoring in a later update. The file path is recorded for the future parser.`
    : isReq
      ? unlockMessage(r.missing_inputs, registry)
      : r.description;
  // Collector entries for the specific input(s) this category is awaiting (Part 5).
  const missingEntries = isReq && registry
    ? r.missing_inputs.map((id) => registry.inputs.find((e) => e.id === id)).filter(Boolean)
    : [];
  return (
    <Card className="overflow-hidden p-0 opacity-90">
      <div className="flex">
        <div className="w-1 shrink-0" style={{ background: color }} />
        <div className="flex-1 space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-muted-foreground">{r.name}</span>
            <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground">
              {r.family}
            </Badge>
            {r.context_fired ? (
              <Badge className="ml-auto gap-1 text-[10px]" style={{ backgroundColor: "#4DA6FF", color: "#0D1B2A" }}>
                <Share2 className="size-3" /> context
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="ml-auto gap-1 text-[10px] font-normal"
                style={isProvided ? { color: "#B392F0", borderColor: "#B392F055" } : undefined}
              >
                {badge.icon}
                {badge.label}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{r.context_fired ? r.context_note : text}</p>
          {missingEntries.length > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowHelp((o) => !o)}
                className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
              >
                {showHelp ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                How to get {missingEntries.map((e) => e!.label).join(" + ")}
              </button>
              {showHelp && (
                <div className="mt-2 space-y-3">
                  {missingEntries.map((e) => (
                    <RegistryCollectorHelp key={e!.id} collector={e!.collector} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

type Sizing = import("@/lib/sizing").SizingRecommendation;

const pf = (x: number | null | undefined) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);

// Deterministic "story arc" synthesized from the ledger (used in grounded mode, and as the
// fallback if the LLM narration fails).
function buildGroundedReasoning(v2: AssessmentV2, sizing?: Sizing | null) {
  const scored = v2.ranked.filter((r) => r.status === "scored");
  const lens = scored.filter((r) => r.in_lens !== false);
  const pool = lens.length ? lens : scored;
  const fired = pool.filter((r) => r.fired);
  const clear = pool.filter((r) => !r.fired);
  const awaiting = v2.ranked.filter(
    (r) => r.status === "requires_input" || r.status === "input_provided",
  );
  const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];

  const found = fired.length
    ? fired.map((r) => {
        const top = [...r.ledger]
          .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
          .find((e) => e.passed && e.contribution > 0);
        return `${r.name} fired at ${pf(r.confidence)}${
          top ? ` — ${top.signal} = ${top.value}${top.unit ? ` ${top.unit}` : ""} (${top.comparator}${top.threshold})` : ""
        }.`;
      })
    : [`No category crossed its fire threshold; the strongest is ${pool[0]?.name ?? "—"} at ${pf(pool[0]?.confidence)}.`];

  const why: string[] = [];
  if (sizing?.applies_to_intent && sizing.recommended_reason) why.push(sizing.recommended_reason);
  for (const r of clear) why.push(`${r.name} has headroom (${pf(r.confidence)}, did not fire).`);
  for (const r of fired) for (const x of r.cross_references) why.push(x.note);

  const change: string[] = [];
  if (sizing?.conditioning?.workload_caveat) change.push(sizing.conditioning.workload_caveat);
  for (const r of fired) for (const c of r.caveats) change.push(c);
  for (const r of awaiting) change.push(`${r.name}: provide ${r.missing_inputs.join(", ")} to confirm.`);

  return { found: uniq(found), why: uniq(why).slice(0, 6), change: uniq(change).slice(0, 6) };
}

// LAYER 1 — Verdict hero.
function VerdictHero({ v2, sizing, lead }: { v2: AssessmentV2; sizing?: Sizing | null; lead?: CategoryResult }) {
  const title = v2.intent?.title ?? "Assessment";
  let action: string;
  let conf: number | null;
  if (sizing?.applies_to_intent && sizing.recommended && sizing.options) {
    const opt = sizing.options.find((o) => o.id === sizing.recommended);
    action = opt ? `${opt.label}${opt.tier ? ` → ${opt.tier.name}` : ""}` : sizing.recommended;
    conf = sizing.recommended_confidence ?? lead?.confidence ?? null;
  } else {
    action = lead?.recommendation ?? "No dominant finding — review the evidence below.";
    conf = lead?.confidence ?? null;
  }
  const driver = lead ? `${lead.name} ${lead.fired ? "fired" : "leads"} at ${pf(lead.confidence)}` : "no category fired";
  const caveat = lead?.caveats?.[0] ?? sizing?.conditioning?.workload_caveat ?? null;

  return (
    <Card className="border-primary/40 bg-gradient-to-br from-card to-secondary/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Target className="size-4 text-primary" />
          {title}
          <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground">verdict</Badge>
          {conf != null && (
            <Badge className="ml-auto text-[11px]" style={{ backgroundColor: "#00ED64", color: "#0D1B2A" }}>
              {pf(conf)} confidence
            </Badge>
          )}
        </CardTitle>
        {v2.intent && <p className="pt-0.5 text-xs italic text-muted-foreground">{v2.intent.subtitle}</p>}
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-base font-semibold leading-snug text-foreground">{action}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Flame className="size-3.5 text-primary" /> driver: {driver}
        </p>
        {sizing?.applies_to_intent && sizing.recommended_reason && (
          <p className="text-xs leading-relaxed text-foreground/80">{sizing.recommended_reason}</p>
        )}
        {caveat && (
          <p className="flex items-start gap-1.5 rounded-md border border-[#F5A623]/30 bg-[#F5A623]/5 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#F5A623]" /> {caveat}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// LAYER 2 — Reasoning (story arc): What we found / Why here / What would change it.
function ReasoningSection({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-primary">{label}</div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-xs leading-relaxed text-foreground/85">• {it}</li>
        ))}
      </ul>
    </div>
  );
}

function ReasoningLayer({
  v2,
  sizing,
  mode,
  narration,
  narrating,
  model,
}: {
  v2: AssessmentV2;
  sizing?: Sizing | null;
  mode: AssessmentMode;
  narration: NarrationResult | null;
  narrating: boolean;
  model: string | null;
}) {
  const g = buildGroundedReasoning(v2, sizing);
  const deterministic = (
    <div className="space-y-3">
      <ReasoningSection label="What we found" items={g.found} />
      <ReasoningSection label="Why it points here (not elsewhere)" items={g.why} />
      <ReasoningSection label="What would change this conclusion" items={g.change} />
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Sparkles className="size-4 text-primary" /> Reasoning
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {mode === "llm" ? `LLM · ${model ?? "—"}` : "grounded"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {mode === "grounded" && deterministic}
        {mode === "llm" && narrating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" /> narrating with{" "}
            <span className="font-mono text-foreground">{model}</span>…
          </div>
        )}
        {mode === "llm" && !narrating && narration?.ok && (
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {narration.narrative}
          </div>
        )}
        {mode === "llm" && !narrating && narration && !narration.ok && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-[#F5A623]/40 bg-[#F5A623]/5 px-3 py-2 text-[11px] text-[#F5A623]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              LLM narration unavailable — showing the grounded reasoning.{" "}
              <span className="text-muted-foreground">
                {narration.kind ? `[${narration.kind}] ` : ""}
                {narration.reason}
              </span>
            </div>
            {deterministic}
          </div>
        )}
        {mode === "llm" && !narrating && !narration && deterministic}
      </CardContent>
    </Card>
  );
}

// LAYER 3 — Evidence (collapsed by default; ranked groups).
function EvidenceGroup({
  label,
  color,
  results,
  kind,
  focusId,
  registry,
}: {
  label: string;
  color: string;
  results: CategoryResult[];
  kind: "scored" | "placeholder";
  focusId?: string | null;
  registry?: InputRegistry | null;
}) {
  if (!results.length) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color }}>
        {label} <span className="text-muted-foreground">({results.length})</span>
      </div>
      {kind === "scored" ? (
        <div className="space-y-2">
          {results.map((r) => (
            <ScoredCard key={r.id} r={r} focused={!!focusId && r.id === focusId} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {results.map((r) => (
            <PlaceholderCard key={r.id} r={r} registry={registry ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceLayer({
  fired,
  clear,
  awaiting,
  declared,
  focusId,
  registry,
}: {
  fired: CategoryResult[];
  clear: CategoryResult[];
  awaiting: CategoryResult[];
  declared: CategoryResult[];
  focusId?: string | null;
  registry?: InputRegistry | null;
}) {
  const [open, setOpen] = useState(false);
  const total = fired.length + clear.length + awaiting.length + declared.length;
  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-left text-sm font-semibold transition-colors hover:bg-secondary/40"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <Layers className="size-4 text-primary" /> Evidence
        <span className="font-normal text-muted-foreground">
          — {total} categories · {fired.length} fired · ranked, full ledgers
        </span>
      </button>
      {open && (
        <div className="space-y-4">
          <EvidenceGroup label="Fired — drove the verdict" color="#00ED64" results={fired} kind="scored" focusId={focusId} />
          <EvidenceGroup label="Clear — scored, didn't fire" color="#8AA0B6" results={clear} kind="scored" focusId={focusId} />
          <EvidenceGroup label="Awaiting input" color="#4DA6FF" results={awaiting} kind="placeholder" registry={registry} />
          <EvidenceGroup label="Declared (stubs)" color="#5A6E82" results={declared} kind="placeholder" registry={registry} />
        </div>
      )}
    </div>
  );
}

// The run's selected intent ids (from the merged-intent members the engine recorded), used
// to initialize the Assessment-tab lens so it reflects what the user actually chose.
function initialIntentIds(v2: AssessmentV2): string[] {
  if (v2.intent_members?.length) return v2.intent_members.map((m) => m.id);
  if (v2.intent?.id) return v2.intent.id.split("+").filter(Boolean);
  return ["full_sweep"];
}

// Fired *context* states (e.g. the sharding single-shard caveat) — surfaced near the top,
// not as a scored verdict.
function ContextCallouts({ contexts }: { contexts: CategoryResult[] }) {
  if (!contexts.length) return null;
  return (
    <div className="space-y-2">
      {contexts.map((r) => (
        <Card key={r.id} className="border-[#4DA6FF]/40 bg-[#4DA6FF]/5">
          <CardContent className="flex items-start gap-2 py-3">
            <Share2 className="mt-0.5 size-4 shrink-0 text-[#4DA6FF]" />
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                {r.name}
                <Badge className="text-[10px]" style={{ backgroundColor: "#4DA6FF", color: "#0D1B2A" }}>
                  context
                </Badge>
              </div>
              <p className="text-xs leading-relaxed text-foreground/85">{r.context_note}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function AssessmentV2Panel({
  v2,
  mode,
  onModeChange,
  targetCategory,
  sizing,
  extras,
}: {
  v2: AssessmentV2;
  mode: AssessmentMode;
  onModeChange: (m: AssessmentMode) => void;
  targetCategory: string | null;
  onTargetCategoryChange: (id: string | null) => void;
  sizing?: Sizing | null;
  // Legacy assessment / extra content rendered BETWEEN Reasoning and Evidence so the
  // Layer-3 Evidence stays the final block on the tab.
  extras?: ReactNode;
}) {
  const [provider, setProvider] = useState<LlmProvider | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [narration, setNarration] = useState<NarrationResult | null>(null);
  const [narrating, setNarrating] = useState(false);

  // Intent lens (multi-select), initialized to the run's chosen intents. Changing it
  // re-lenses the already-scored assessment in place (client-side; no re-decode).
  const [rsIntents, setRsIntents] = useState<IntentDef[]>([]);
  const [inputRegistry, setInputRegistry] = useState<InputRegistry | null>(null);
  const [intentIds, setIntentIds] = useState<string[]>(() => initialIntentIds(v2));
  useEffect(() => {
    cachedRulesetDump().then((r) => setRsIntents(r.intents)).catch(() => {});
    cachedInputRegistry().then(setInputRegistry).catch(() => {});
  }, []);
  // Re-initialize the lens whenever a different run is loaded.
  useEffect(() => {
    setIntentIds(initialIntentIds(v2));
  }, [v2]);

  const view = useMemo<AssessmentV2>(() => {
    if (!rsIntents.length || !intentIds.length) return v2;
    const merged = mergeIntents(rsIntents.filter((i) => intentIds.includes(i.id)));
    if (!merged || merged.id === v2.intent?.id) return v2; // already this lens
    const clone: AssessmentV2 = { ...v2, ranked: v2.ranked.map((r) => ({ ...r })) };
    relensAssessment(clone, merged);
    return clone;
  }, [v2, rsIntents, intentIds]);

  useEffect(() => {
    getLlmConfig()
      .then((c) => setProvider(activeProvider(c)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (mode !== "llm") {
      setNarration(null);
      setNarrating(false);
      return;
    }
    if (!provider || !model) return;
    let alive = true;
    setNarrating(true);
    setNarration(null);
    runNarration(view, provider, model, targetCategory, sizing)
      .then((r) => alive && setNarration(r))
      .finally(() => alive && setNarrating(false));
    return () => {
      alive = false;
    };
  }, [mode, model, targetCategory, provider, view, sizing]);

  let scored = view.ranked.filter((r) => r.status === "scored");
  if (targetCategory) {
    const focus = scored.find((r) => r.id === targetCategory);
    if (focus) scored = [focus, ...scored.filter((r) => r.id !== targetCategory)];
  }
  const fired = scored.filter((r) => r.fired);
  const clear = scored.filter((r) => !r.fired);
  const awaiting = view.ranked.filter(
    (r) => r.status === "requires_input" || r.status === "input_provided",
  );
  const declared = view.ranked.filter((r) => r.status === "stub");
  const contexts = view.ranked.filter((r) => r.context_fired);
  const lensFired = fired.filter((r) => r.in_lens !== false);
  const lead = lensFired[0] ?? fired[0] ?? scored[0];

  return (
    <div className="space-y-4">
      {/* Controls bar — re-lens / switch mode without leaving the tab */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <span className="text-xs text-muted-foreground">{view.counts.scored} scored · {view.counts.fired} fired</span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">mode</span>
            <ModeSelector mode={mode} onChange={onModeChange} />
          </div>
          {mode === "llm" && <ModelPicker model={model} onChange={setModel} />}
          <IntentLens value={intentIds} onChange={setIntentIds} />
        </CardContent>
      </Card>

      {/* LAYER 1 — Verdict (5-second glance) */}
      <VerdictHero v2={view} sizing={sizing} lead={lead} />
      <ContextCallouts contexts={contexts} />
      {sizing?.applies_to_intent && sizing.current && <SizingPanel sizing={sizing} />}

      {/* LAYER 2 — Reasoning (30-second story) */}
      <ReasoningLayer v2={view} sizing={sizing} mode={mode} narration={narration} narrating={narrating} model={model} />

      {/* Legacy assessment / extras — kept ABOVE Evidence so Layer-3 stays last. */}
      {extras}

      {/* LAYER 3 — Evidence (full detail, on demand) — the FINAL block on the tab. */}
      <EvidenceLayer fired={fired} clear={clear} awaiting={awaiting} declared={declared} focusId={targetCategory} registry={inputRegistry} />
    </div>
  );
}
