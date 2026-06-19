import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileCheck,
  Flame,
  GitBranch,
  Lock,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  type AssessmentV2,
  type CategoryResult,
  type LedgerRow,
  FAMILY_COLOR,
  unlockMessage,
} from "@/lib/ruleset";
import { type LlmProvider, activeProvider, getLlmConfig } from "@/lib/llm";
import { type NarrationResult, runNarration } from "@/lib/narration";
import {
  type AssessmentMode,
  CategorySelector,
  ModeSelector,
  ModelPicker,
} from "@/components/AssessmentControls";

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

function PlaceholderCard({ r }: { r: CategoryResult }) {
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
      ? unlockMessage(r.missing_inputs)
      : r.description;
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
            <Badge
              variant="outline"
              className="ml-auto gap-1 text-[10px] font-normal"
              style={isProvided ? { color: "#B392F0", borderColor: "#B392F055" } : undefined}
            >
              {badge.icon}
              {badge.label}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{text}</p>
        </div>
      </div>
    </Card>
  );
}

function NarrativePanel({
  narrating,
  narration,
  model,
}: {
  narrating: boolean;
  narration: NarrationResult | null;
  model: string | null;
}) {
  if (narrating) {
    return (
      <Card className="border-primary/30">
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" />
          Narrating the scored findings with <span className="font-mono text-foreground">{model}</span>…
        </div>
      </Card>
    );
  }
  if (!narration) return null;
  if (!narration.ok) {
    // Graceful fallback — grounded ledger below stays fully usable.
    return (
      <Card className="border-[#F5A623]/40 bg-[#F5A623]/5">
        <div className="flex items-start gap-2 p-4 text-xs text-[#F5A623]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            LLM narration unavailable — showing the grounded assessment below.{" "}
            <span className="text-muted-foreground">
              {narration.kind ? `[${narration.kind}] ` : ""}
              {narration.reason}
            </span>
          </span>
        </div>
      </Card>
    );
  }
  return (
    <Card className="border-primary/30 bg-gradient-to-br from-card to-secondary/20">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Sparkles className="size-4 text-primary" /> LLM-reasoned narrative
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
            {narration.model ?? model}
          </Badge>
          <span className="text-[10px] font-normal text-muted-foreground">
            grounded on the scores below — no new numbers introduced
          </span>
        </CardTitle>
      </CardHeader>
      <div className="px-4 pb-4">
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {narration.narrative}
        </div>
      </div>
    </Card>
  );
}

export function AssessmentV2Panel({
  v2,
  mode,
  onModeChange,
  targetCategory,
  onTargetCategoryChange,
  sizing,
}: {
  v2: AssessmentV2;
  mode: AssessmentMode;
  onModeChange: (m: AssessmentMode) => void;
  targetCategory: string | null;
  onTargetCategoryChange: (id: string | null) => void;
  sizing?: import("@/lib/sizing").SizingRecommendation | null;
}) {
  const [provider, setProvider] = useState<LlmProvider | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [narration, setNarration] = useState<NarrationResult | null>(null);
  const [narrating, setNarrating] = useState(false);

  // provider for the narration call (model is driven by the picker below)
  useEffect(() => {
    getLlmConfig()
      .then((c) => setProvider(activeProvider(c)))
      .catch(() => {});
  }, []);

  // Run narration whenever mode/model/target/data change (LLM mode only).
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
    runNarration(v2, provider, model, targetCategory, sizing)
      .then((r) => {
        if (alive) setNarration(r);
      })
      .finally(() => {
        if (alive) setNarrating(false);
      });
    return () => {
      alive = false;
    };
  }, [mode, model, targetCategory, provider, v2, sizing]);

  let scored = v2.ranked.filter((r) => r.status === "scored");
  // Client-side targeted focus: surface the chosen category first (engine scores all).
  if (targetCategory) {
    const focus = scored.find((r) => r.id === targetCategory);
    if (focus) scored = [focus, ...scored.filter((r) => r.id !== targetCategory)];
  }
  const inputProvided = v2.ranked.filter((r) => r.status === "input_provided");
  const requiresInput = v2.ranked.filter((r) => r.status === "requires_input");
  const stubs = v2.ranked.filter((r) => r.status === "stub");
  const pending = [...inputProvided, ...requiresInput];

  return (
    <div className="space-y-4">
      <Card className="border-primary/30 bg-gradient-to-br from-card to-secondary/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <GitBranch className="size-4 text-primary" />
            {v2.intent ? v2.intent.title : "Deterministic Scoring — Layer 2"}
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {targetCategory ? "targeted" : v2.intent ? "intent lens" : "full sweep"}
            </Badge>
          </CardTitle>
          {v2.intent && (
            <p className="pt-0.5 text-xs italic text-muted-foreground">{v2.intent.subtitle}</p>
          )}
          <p className="pt-1 text-xs text-muted-foreground">
            {v2.counts.scored} scored · {v2.counts.fired} fired ·{" "}
            {(v2.counts.input_provided ?? 0) + v2.counts.requires_input} awaiting input ·{" "}
            {v2.counts.stub} declared (stub). Every score is reconstructable from its evidence
            ledger below.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">mode</span>
              <ModeSelector mode={mode} onChange={onModeChange} />
            </div>
            {mode === "llm" && <ModelPicker model={model} onChange={setModel} />}
            <CategorySelector value={targetCategory} onChange={onTargetCategoryChange} />
          </div>
        </CardHeader>
      </Card>

      {mode === "llm" && <NarrativePanel narrating={narrating} narration={narration} model={model} />}

      <div className="space-y-3">
        {scored.map((r) => (
          <ScoredCard key={r.id} r={r} focused={!!targetCategory && r.id === targetCategory} />
        ))}
      </div>

      {pending.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Awaiting input
          </div>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {pending.map((r) => (
              <PlaceholderCard key={r.id} r={r} />
            ))}
          </div>
        </div>
      )}

      {stubs.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Declared (not yet deep)
          </div>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {stubs.map((r) => (
              <PlaceholderCard key={r.id} r={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
