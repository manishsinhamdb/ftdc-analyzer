import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Check,
  Download,
  GitBranch,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  type CategoryOverride,
  type OverridesDoc,
  type RuleCategory,
  type RuleSignal,
  type RulesetDump,
  FAMILY_COLOR,
  FAMILY_ORDER,
  rulesetDump,
  rulesetGetOverrides,
  rulesetOverridesPath,
  rulesetSetOverrides,
} from "@/lib/ruleset";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function groupByFamily(cats: RuleCategory[]): [string, RuleCategory[]][] {
  return FAMILY_ORDER.map((fam) => [fam, cats.filter((c) => c.family === fam)] as [string, RuleCategory[]]).filter(
    ([, cs]) => cs.length > 0,
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === "active" ? "#00ED64" : "#5A6E82";
  return <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: color }} />;
}

// ---------------------------------------------------------------------------
// Causal conditioning graph (arc diagram) — category ← conditioned-by ← category
// ---------------------------------------------------------------------------
function CausalGraph({
  categories,
  selectedId,
  onSelect,
}: {
  categories: RuleCategory[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Only nodes participating in any conditioning relationship.
  const edges: { from: string; to: string }[] = [];
  for (const c of categories) {
    for (const cond of c.conditioned_by) edges.push({ from: cond, to: c.id }); // cond → influences → c
  }
  const involved = new Set<string>();
  edges.forEach((e) => {
    involved.add(e.from);
    involved.add(e.to);
  });
  const nodes = categories.filter((c) => involved.has(c.id));
  if (nodes.length === 0) return null;

  const ROW = 40;
  const pad = 16;
  const W = 560;
  const H = pad * 2 + nodes.length * ROW;
  const yOf = (id: string) => pad + nodes.findIndex((n) => n.id === id) * ROW + ROW / 2;
  const nodeX = 250; // label column left edge; arcs bulge to the right
  const arcX = W - 40;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <GitBranch className="size-3.5" /> Causal conditioning map
        <span className="font-normal opacity-70">— an arc means the left category's firing conditions the right one's recommendation</span>
      </div>
      <svg width={W} height={H} className="max-w-full">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#FFC857" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const y1 = yOf(e.from);
          const y2 = yOf(e.to);
          if (y1 === undefined || y2 === undefined) return null;
          const active = selectedId === e.from || selectedId === e.to;
          const bulge = arcX + Math.min(80, Math.abs(y2 - y1));
          return (
            <path
              key={i}
              d={`M ${nodeX + 4} ${y1} C ${bulge} ${y1}, ${bulge} ${y2}, ${nodeX + 4} ${y2}`}
              fill="none"
              stroke={active ? "#FFC857" : "#3A4F66"}
              strokeWidth={active ? 2 : 1}
              markerEnd="url(#arrow)"
              opacity={selectedId && !active ? 0.3 : 1}
            />
          );
        })}
        {nodes.map((n) => {
          const y = yOf(n.id);
          const color = FAMILY_COLOR[n.family] ?? "#5A6E82";
          const sel = selectedId === n.id;
          return (
            <g key={n.id} className="cursor-pointer" onClick={() => onSelect(n.id)}>
              <circle cx={nodeX} cy={y} r={5} fill={color} stroke={sel ? "#E6EDF3" : "none"} strokeWidth={2} />
              <text
                x={nodeX - 12}
                y={y + 4}
                textAnchor="end"
                fontSize={12}
                fill={sel ? "#E6EDF3" : "#8AA0B6"}
                fontWeight={sel ? 700 : 400}
              >
                {n.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animated score composition (structural — from rule weights/directions)
// ---------------------------------------------------------------------------
function ScoreComposition({ category }: { category: RuleCategory }) {
  const active = category.signals.filter((s) => s.status === "active");
  const posWeight = active.filter((s) => s.direction === "+").reduce((a, s) => a + s.weight, 0) || 1;
  // grow-in animation keyed to the selected category
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    setGrown(false);
    const id = window.setTimeout(() => setGrown(true), 50);
    return () => window.clearTimeout(id);
  }, [category.id]);

  if (active.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        No active signals — this category is a declared stub. Its evidence set is not yet specified.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-muted-foreground">
        Each signal contributes its <b>weight</b> when its threshold is met; <span style={{ color: "#00ED64" }}>+</span> raises
        confidence, <span style={{ color: "#E05C4B" }}>−</span> lowers it. Confidence = Σ(signed contributions) ÷ Σ(positive
        weights), clamped 0–1. Bars below are sized by weight.
      </div>
      <div className="space-y-2">
        {active.map((s) => {
          const isPos = s.direction === "+";
          const widthPct = (s.weight / posWeight) * 100;
          return (
            <div key={s.metric_path} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono">
                  {s.metric_path}{" "}
                  <span className="text-muted-foreground">
                    [{s.stat}] {s.comparator} {s.threshold}
                    {s.unit ? ` ${s.unit}` : ""}
                  </span>
                  {s.disambiguator && (
                    <span className="ml-1 text-[#FFC857]" title={s.disambiguator.note}>
                      ⚙ disambiguated
                    </span>
                  )}
                </span>
                <span className="font-mono font-semibold" style={{ color: isPos ? "#00ED64" : "#E05C4B" }}>
                  {isPos ? "+" : "−"}
                  {s.weight}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded bg-secondary/40">
                <div
                  className="h-full rounded transition-[width] duration-700 ease-out"
                  style={{
                    width: grown ? `${Math.min(100, widthPct)}%` : "0%",
                    background: isPos ? "#00ED64" : "#E05C4B",
                  }}
                />
              </div>
              {s.interpretation && (
                <div className="text-[11px] leading-snug text-muted-foreground">{s.interpretation}</div>
              )}
              {s.disambiguator && (
                <div className="rounded border border-[#FFC857]/30 bg-[#FFC857]/5 px-2 py-1 text-[11px] text-muted-foreground">
                  <b className="text-[#FFC857]">disambiguator:</b> {s.disambiguator.effect} when{" "}
                  <span className="font-mono">
                    {s.disambiguator.co_signal} {s.disambiguator.comparator} {s.disambiguator.value}
                  </span>{" "}
                  — {s.disambiguator.note}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Methodology (view) tab
// ---------------------------------------------------------------------------
function MethodologyTab({
  ruleset,
  selectedId,
  setSelectedId,
}: {
  ruleset: RulesetDump;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
}) {
  const selected = ruleset.categories.find((c) => c.id === selectedId) ?? ruleset.categories[0];
  const grouped = groupByFamily(ruleset.categories);
  const condByCats = (selected?.conditioned_by ?? [])
    .map((id) => ruleset.categories.find((c) => c.id === id))
    .filter(Boolean) as RuleCategory[];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      {/* category index */}
      <div className="space-y-3">
        {grouped.map(([fam, cats]) => (
          <div key={fam} className="space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: FAMILY_COLOR[fam] }}>
              {fam}
            </div>
            {cats.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={
                  "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors " +
                  (selected?.id === c.id
                    ? "border-primary bg-primary/10 font-medium"
                    : "border-border hover:bg-secondary/40")
                }
              >
                <StatusDot status={c.status} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.required_inputs.filter((i) => i !== "ftdc").map((i) => (
                  <span key={i} className="rounded bg-secondary/60 px-1 text-[9px] text-muted-foreground">
                    {i}
                  </span>
                ))}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* detail */}
      {selected && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {selected.name}
                <Badge variant="outline" className="text-[10px] uppercase" style={{ color: FAMILY_COLOR[selected.family] }}>
                  {selected.family}
                </Badge>
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {selected.status}
                </Badge>
                {selected.required_inputs.map((i) => (
                  <Badge key={i} variant="secondary" className="text-[9px] uppercase">
                    {i}
                  </Badge>
                ))}
              </CardTitle>
              <p className="pt-1 text-xs leading-relaxed text-muted-foreground">{selected.description}</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <Sparkles className="size-3.5 text-primary" /> How the score is reached
                </div>
                <ScoreComposition category={selected} />
              </div>

              {selected.caveats.length > 0 && (
                <div>
                  <Separator className="my-1" />
                  <div className="mb-1 text-xs font-semibold text-muted-foreground">Caveats (always attached)</div>
                  <ul className="space-y-1">
                    {selected.caveats.map((c, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0 text-[#F5A623]" />
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <Separator className="my-1" />
                <div className="mb-1 text-xs font-semibold text-muted-foreground">Recommendation (default)</div>
                <p className="text-xs leading-relaxed text-foreground/90">{selected.recommendation}</p>
                {condByCats.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="text-[11px] font-semibold text-muted-foreground">
                      Conditioned by ({condByCats.length}):
                    </div>
                    {condByCats.map((cc) => (
                      <div key={cc.id} className="rounded border border-border bg-secondary/20 px-2 py-1 text-[11px]">
                        <button onClick={() => setSelectedId(cc.id)} className="font-medium text-primary hover:underline">
                          {cc.name}
                        </button>
                        {selected.conditional_recommendations[cc.id] && (
                          <span className="text-muted-foreground">
                            {" "}
                            → if it fires: “{selected.conditional_recommendations[cc.id]}”
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <CausalGraph categories={ruleset.categories} selectedId={selected.id} onSelect={setSelectedId} />

          {ruleset.tier_tables && <TierTablesSection tables={ruleset.tier_tables} />}
        </div>
      )}
    </div>
  );
}

function TierTablesSection({ tables }: { tables: NonNullable<RulesetDump["tier_tables"]> }) {
  const [cloud, setCloud] = useState<string>(Object.keys(tables)[0] ?? "aws");
  const t = tables[cloud];
  if (!t) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          Sizing tier tables
          <div className="inline-flex rounded-md border border-border p-0.5">
            {Object.keys(tables).map((c) => (
              <button
                key={c}
                onClick={() => setCloud(c)}
                className={
                  "rounded px-2 py-0.5 text-[11px] font-medium uppercase transition-colors " +
                  (cloud === c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/50")
                }
              >
                {c}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[10px] text-muted-foreground">specs as of {t.specs_as_of}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="px-2 py-1 text-left">tier</th>
                <th className="px-2 py-1 text-right">vCPU</th>
                <th className="px-2 py-1 text-right">RAM</th>
                <th className="px-2 py-1 text-right">storage</th>
                <th className="px-2 py-1 text-right">IOPS</th>
                <th className="px-2 py-1 text-center">prov-IOPS</th>
                <th className="px-2 py-1 text-center">R-variant</th>
                <th className="px-2 py-1 text-right">WT cache</th>
              </tr>
            </thead>
            <tbody>
              {t.tiers.map((tr) => (
                <tr key={tr.name} className="border-b border-border/60 last:border-0">
                  <td className="px-2 py-1 font-mono font-semibold text-primary">{tr.name}</td>
                  <td className="px-2 py-1 text-right font-mono">{tr.vcpu}</td>
                  <td className="px-2 py-1 text-right font-mono">{tr.ram_gb} GB</td>
                  <td className="px-2 py-1 text-right font-mono">{tr.default_storage_gb.toLocaleString()} GB</td>
                  <td className="px-2 py-1 text-right font-mono">{tr.default_iops.toLocaleString()}</td>
                  <td className="px-2 py-1 text-center">{tr.provisioned_iops ? "✓" : "✗"}</td>
                  <td className="px-2 py-1 text-center font-mono">{tr.low_cpu_available ? `R=${tr.low_cpu_vcpu}` : "—"}</td>
                  <td className="px-2 py-1 text-right font-mono">{tr.wt_cache_gb} GB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">{t.source_note}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Manage (edit) tab — writes an override layer the engine merges
// ---------------------------------------------------------------------------
function num(v: string): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function ManageTab({ ruleset, reload }: { ruleset: RulesetDump; reload: () => void }) {
  const [draft, setDraft] = useState<OverridesDoc>({ version: 1, categories: {} });
  const [openId, setOpenId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rulesetGetOverrides()
      .then((o) => {
        if (o && typeof o === "object" && "categories" in o) setDraft(o as OverridesDoc);
      })
      .catch(() => {});
    rulesetOverridesPath().then(setPath).catch(() => {});
  }, []);

  const catOv = useCallback((id: string): CategoryOverride => draft.categories[id] ?? {}, [draft]);

  const update = useCallback((id: string, patch: (ov: CategoryOverride) => CategoryOverride) => {
    setDraft((d) => {
      const next = { ...d, categories: { ...d.categories } };
      next.categories[id] = patch({ ...(next.categories[id] ?? {}) });
      return next;
    });
  }, []);

  const resetCategory = useCallback((id: string) => {
    setDraft((d) => {
      const cats = { ...d.categories };
      delete cats[id];
      return { ...d, categories: cats };
    });
  }, []);

  // effective value: override if present, else current merged ruleset value
  const sigVal = (cat: RuleCategory, sig: RuleSignal, field: "weight" | "threshold") => {
    const ov = catOv(cat.id).signals?.[sig.metric_path];
    const v = ov?.[field];
    return v !== undefined ? v : sig[field];
  };

  function validate(): string | null {
    for (const [cid, ov] of Object.entries(draft.categories)) {
      for (const [mp, so] of Object.entries(ov.signals ?? {})) {
        if (so.weight !== undefined && !Number.isFinite(so.weight)) return `${cid}: weight for ${mp} must be numeric`;
        if (so.threshold !== undefined && !Number.isFinite(so.threshold)) return `${cid}: threshold for ${mp} must be numeric`;
      }
      for (const s of ov.added_signals ?? []) {
        if (!s.metric_path) return `${cid}: an added signal is missing its metric_path`;
        if (s.weight !== undefined && !Number.isFinite(s.weight)) return `${cid}: added signal weight must be numeric`;
      }
    }
    return null;
  }

  async function save() {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await rulesetSetOverrides(draft);
      setSavedAt(true);
      window.setTimeout(() => setSavedAt(false), 1500);
      reload();
    } finally {
      setSaving(false);
    }
  }

  const grouped = groupByFamily(ruleset.categories);
  const overriddenCount = Object.keys(draft.categories).length;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-3 text-xs">
          <Settings2 className="size-4 text-primary" />
          <span className="text-muted-foreground">
            Edits are saved as an <b>override layer</b> the engine merges over the typed defaults at score time — no code
            changes. {overriddenCount} categor{overriddenCount === 1 ? "y" : "ies"} overridden.
          </span>
          {error && (
            <span className="flex items-center gap-1 text-destructive">
              <X className="size-3.5" /> {error}
            </span>
          )}
          <Button size="sm" className="ml-auto h-8 gap-2 text-xs" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : savedAt ? <Check className="size-4" /> : <Save className="size-4" />}
            {savedAt ? "Saved — re-analyze to apply" : "Save overrides"}
          </Button>
        </CardContent>
      </Card>
      {path && <div className="px-1 font-mono text-[10px] text-muted-foreground">overrides → {path}</div>}

      {grouped.map(([fam, cats]) => (
        <div key={fam} className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: FAMILY_COLOR[fam] }}>
            {fam}
          </div>
          {cats.map((c) => {
            const ov = catOv(c.id);
            const enabled = ov.enabled !== undefined ? ov.enabled : c.enabled;
            const expanded = openId === c.id;
            const removed = new Set(ov.removed_signals ?? []);
            return (
              <Card key={c.id} className="p-0">
                <button
                  onClick={() => setOpenId(expanded ? null : c.id)}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
                >
                  <StatusDot status={c.status} />
                  <span className="text-sm font-medium">{c.name}</span>
                  {draft.categories[c.id] && (
                    <Badge className="text-[9px]" style={{ backgroundColor: "#FFC857", color: "#0D1B2A" }}>
                      overridden
                    </Badge>
                  )}
                  {!enabled && (
                    <Badge variant="outline" className="text-[9px] text-muted-foreground">
                      disabled
                    </Badge>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground">{c.signals.length} signals</span>
                </button>

                {expanded && (
                  <CardContent className="space-y-3 border-t border-border pt-3">
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) => update(c.id, (o) => ({ ...o, enabled: e.target.checked }))}
                        />
                        enabled
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        fire threshold
                        <Input
                          type="number"
                          step="0.05"
                          className="h-7 w-20 text-xs"
                          defaultValue={ov.fire_threshold ?? c.fire_threshold}
                          onChange={(e) => update(c.id, (o) => ({ ...o, fire_threshold: num(e.target.value) }))}
                        />
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto h-7 gap-1.5 text-xs text-muted-foreground"
                        onClick={() => resetCategory(c.id)}
                      >
                        <RotateCcw className="size-3.5" /> reset to defaults
                      </Button>
                    </div>

                    {/* signals */}
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold text-muted-foreground">Signals</div>
                      {c.signals.filter((s) => !removed.has(s.metric_path)).map((s) => (
                        <div key={s.metric_path} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 rounded border border-border px-2 py-1.5">
                          <span className="min-w-0 truncate font-mono text-[11px]">
                            {s.metric_path}
                            <span className="ml-1 text-muted-foreground">
                              [{s.stat}] {s.comparator} {sigVal(c, s, "threshold")} · {s.direction}
                            </span>
                          </span>
                          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            w
                            <Input
                              type="number"
                              step="0.05"
                              className="h-6 w-16 text-[11px]"
                              defaultValue={sigVal(c, s, "weight")}
                              onChange={(e) =>
                                update(c.id, (o) => ({
                                  ...o,
                                  signals: { ...(o.signals ?? {}), [s.metric_path]: { ...(o.signals?.[s.metric_path] ?? {}), weight: num(e.target.value) } },
                                }))
                              }
                            />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            thr
                            <Input
                              type="number"
                              step="any"
                              className="h-6 w-20 text-[11px]"
                              defaultValue={sigVal(c, s, "threshold")}
                              onChange={(e) =>
                                update(c.id, (o) => ({
                                  ...o,
                                  signals: { ...(o.signals ?? {}), [s.metric_path]: { ...(o.signals?.[s.metric_path] ?? {}), threshold: num(e.target.value) } },
                                }))
                              }
                            />
                          </label>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0 text-muted-foreground hover:text-destructive"
                            title="remove signal"
                            onClick={() => update(c.id, (o) => ({ ...o, removed_signals: [...(o.removed_signals ?? []), s.metric_path] }))}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                      <AddSignal onAdd={(sig) => update(c.id, (o) => ({ ...o, added_signals: [...(o.added_signals ?? []), sig] }))} />
                      {(ov.added_signals ?? []).map((s, i) => (
                        <div key={i} className="flex items-center gap-2 rounded border border-primary/40 bg-primary/5 px-2 py-1.5 text-[11px]">
                          <Plus className="size-3 text-primary" />
                          <span className="font-mono">{s.metric_path}</span>
                          <span className="text-muted-foreground">w {s.weight} · {s.comparator} {s.threshold}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto size-6 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => update(c.id, (o) => ({ ...o, added_signals: (o.added_signals ?? []).filter((_, j) => j !== i) }))}
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>

                    {/* recommendation */}
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold text-muted-foreground">Recommendation</div>
                      <textarea
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                        rows={2}
                        defaultValue={ov.recommendation ?? c.recommendation}
                        onChange={(e) => update(c.id, (o) => ({ ...o, recommendation: e.target.value }))}
                      />
                    </div>

                    {/* caveats */}
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold text-muted-foreground">Caveats</div>
                      {(ov.caveats ?? c.caveats).map((cav, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <Input
                            className="h-7 text-[11px]"
                            defaultValue={cav}
                            onChange={(e) =>
                              update(c.id, (o) => {
                                const base = o.caveats ?? [...c.caveats];
                                base[i] = e.target.value;
                                return { ...o, caveats: base };
                              })
                            }
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="size-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() =>
                              update(c.id, (o) => {
                                const base = (o.caveats ?? [...c.caveats]).filter((_, j) => j !== i);
                                return { ...o, caveats: base };
                              })
                            }
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-[11px] text-muted-foreground"
                        onClick={() => update(c.id, (o) => ({ ...o, caveats: [...(o.caveats ?? [...c.caveats]), "New caveat"] }))}
                      >
                        <Plus className="size-3" /> add caveat
                      </Button>
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function AddSignal({ onAdd }: { onAdd: (s: Partial<RuleSignal>) => void }) {
  const [path, setPath] = useState("");
  const [weight, setWeight] = useState("0.1");
  const [threshold, setThreshold] = useState("0");
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-dashed border-border px-2 py-1.5">
      <Input
        ref={ref}
        placeholder="metric_path (e.g. cache_used_pct)"
        className="h-7 max-w-[220px] text-[11px]"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <Input className="h-7 w-16 text-[11px]" placeholder="weight" value={weight} onChange={(e) => setWeight(e.target.value)} />
      <Input className="h-7 w-20 text-[11px]" placeholder="threshold" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-[11px]"
        disabled={!path.trim() || !Number.isFinite(Number(weight))}
        onClick={() => {
          onAdd({
            metric_path: path.trim(),
            weight: Number(weight),
            threshold: Number(threshold) || 0,
            direction: "+",
            comparator: ">",
            stat: "p95",
            interpretation: "",
            status: "active",
            unit: "",
            disambiguator: null,
          });
          setPath("");
          setWeight("0.1");
          setThreshold("0");
          ref.current?.focus();
        }}
      >
        <Plus className="size-3" /> add signal
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-contained HTML export of the full ruleset (a shareable methodology artifact)
// ---------------------------------------------------------------------------
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function buildMethodologyHtml(rs: RulesetDump, overrides: OverridesDoc | null): string {
  const customized = new Set(Object.keys(overrides?.categories ?? {}));
  const grouped = groupByFamily(rs.categories);
  const fam = (f: string) => FAMILY_COLOR[f] ?? "#5A6E82";

  const sectionFor = (c: RuleCategory) => {
    const isCustom = customized.has(c.id);
    const sigRows = c.signals
      .map(
        (s) => `<tr>
        <td class="mono">${esc(s.metric_path)}${s.status === "stub" ? ' <span class="tag">stub</span>' : ""}</td>
        <td class="num" style="color:${s.direction === "+" ? "#00ED64" : "#E05C4B"}">${s.direction}${s.weight}</td>
        <td class="mono">[${esc(s.stat)}] ${esc(s.comparator)} ${esc(s.threshold)}${s.unit ? " " + esc(s.unit) : ""}</td>
        <td>${esc(s.interpretation)}${
          s.disambiguator
            ? `<div class="dis">⚙ ${esc(s.disambiguator.effect)} when <span class="mono">${esc(
                s.disambiguator.co_signal,
              )} ${esc(s.disambiguator.comparator)} ${esc(s.disambiguator.value)}</span> — ${esc(s.disambiguator.note)}</div>`
            : ""
        }</td>
      </tr>`,
      )
      .join("");
    const caveats = c.caveats.map((cv) => `<li>${esc(cv)}</li>`).join("");
    const conds = c.conditioned_by
      .map((id) => {
        const alt = c.conditional_recommendations[id];
        const name = rs.categories.find((x) => x.id === id)?.name ?? id;
        return `<li><b>${esc(name)}</b>${alt ? ` → if it fires: “${esc(alt)}”` : ""}</li>`;
      })
      .join("");
    return `<section class="cat" style="border-left:4px solid ${fam(c.family)}">
      <h3>${esc(c.name)} ${isCustom ? '<span class="tag custom">customized</span>' : ""} <span class="tag">${esc(c.status)}</span></h3>
      <div class="meta">${esc(c.family)} · inputs: ${c.required_inputs.map(esc).join(", ")}</div>
      <p class="desc">${esc(c.description)}</p>
      ${
        c.signals.length
          ? `<table><thead><tr><th>signal</th><th>weight</th><th>test</th><th>interpretation</th></tr></thead><tbody>${sigRows}</tbody></table>`
          : '<p class="desc"><i>No signals specified yet (stub).</i></p>'
      }
      ${caveats ? `<div class="sub">Caveats</div><ul>${caveats}</ul>` : ""}
      <div class="sub">Recommendation</div><p class="desc">${esc(c.recommendation)}</p>
      ${conds ? `<div class="sub">Conditioned by</div><ul>${conds}</ul>` : ""}
    </section>`;
  };

  const families = grouped
    .map(
      ([f, cats]) =>
        `<div class="fam"><h2 style="color:${fam(f)}">${esc(f)} <span class="count">${cats.length}</span></h2>${cats
          .map(sectionFor)
          .join("")}</div>`,
    )
    .join("");

  const customNote = customized.size
    ? `<div class="banner">⚙ ${customized.size} categor${customized.size === 1 ? "y" : "ies"} customized via operator overrides (marked “customized”). Defaults shown elsewhere.</div>`
    : `<div class="banner">Default ruleset (no operator overrides active).</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FTDC Analyzer — Scoring Methodology (ruleset v${rs.version})</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0D1B2A; color:#E6EDF3; font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 24px; margin:0 0 4px; }
  .lead { color:#8AA0B6; margin:0 0 20px; }
  .banner { background:#16293F; border:1px solid #1E3450; border-radius:8px; padding:10px 14px; margin-bottom:24px; font-size:13px; }
  .fam { margin-bottom: 28px; }
  h2 { font-size: 15px; text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid #1E3450; padding-bottom:6px; }
  h2 .count { color:#5A6E82; font-size:12px; }
  .cat { background:#12243A; border-radius:8px; padding:14px 16px; margin:12px 0; }
  .cat h3 { margin:0 0 2px; font-size:15px; }
  .meta { color:#8AA0B6; font-size:12px; margin-bottom:8px; }
  .desc { color:#C7D3DF; margin:6px 0; }
  table { width:100%; border-collapse:collapse; margin:8px 0; font-size:12.5px; }
  th,td { text-align:left; padding:5px 8px; border-bottom:1px solid #1E3450; vertical-align:top; }
  th { color:#8AA0B6; font-weight:600; }
  td.num { text-align:right; font-family:ui-monospace,Menlo,monospace; font-weight:700; white-space:nowrap; }
  .mono { font-family:ui-monospace,Menlo,monospace; }
  .sub { color:#00ED64; font-size:11px; text-transform:uppercase; letter-spacing:.05em; margin-top:10px; }
  ul { margin:4px 0; padding-left:18px; color:#C7D3DF; }
  .dis { color:#FFC857; font-size:12px; margin-top:4px; }
  .tag { background:#1E3450; color:#8AA0B6; border-radius:4px; padding:1px 6px; font-size:10px; text-transform:uppercase; }
  .tag.custom { background:#FFC857; color:#0D1B2A; }
  footer { color:#5A6E82; font-size:11px; margin-top:32px; border-top:1px solid #1E3450; padding-top:12px; }
</style></head>
<body><div class="wrap">
  <h1>FTDC Analyzer — Scoring Methodology</h1>
  <p class="lead">How the Layer-2 deterministic scorer reaches each recommendation. Ruleset version ${rs.version} · ${rs.categories.length} categories across ${grouped.length} families.</p>
  ${customNote}
  ${families}
  <footer>Each category scores its signals (weight applied when the threshold is met; + raises confidence, − lowers it), with disambiguators that flip a signal's meaning based on a co-signal. Confidence = Σ(signed contributions) ÷ Σ(positive weights), clamped 0–1. "Conditioned by" links arbitrate the final recommendation across categories. Generated from the FTDC Analyzer engine ruleset.</footer>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// top-level view
// ---------------------------------------------------------------------------
export function MethodologyRules() {
  const [ruleset, setRuleset] = useState<RulesetDump | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"methodology" | "manage">("methodology");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function exportHtml() {
    if (!ruleset) return;
    setExporting(true);
    try {
      const ov = await rulesetGetOverrides().catch(() => null);
      const overrides = ov && typeof ov === "object" && "categories" in ov ? (ov as OverridesDoc) : null;
      const html = buildMethodologyHtml(ruleset, overrides);
      const dest = await saveDialog({
        defaultPath: `ftdc-methodology-v${ruleset.version}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!dest) return;
      await invoke("save_text", { dest, content: html });
      revealItemInDir(dest).catch(() => {});
    } finally {
      setExporting(false);
    }
  }

  const load = useCallback(() => {
    setLoading(true);
    // Methodology must fetch FRESH (it reloads after the operator edits overrides — the cached
    // dump would return stale pre-override data). This is a separate tab, not the Inputs step.
    rulesetDump()
      .then((rs) => {
        setRuleset(rs);
        setSelectedId((cur) => cur ?? rs.categories[0]?.id ?? null);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    if (!ruleset) return { active: 0, stub: 0 };
    return {
      active: ruleset.categories.filter((c) => c.status === "active").length,
      stub: ruleset.categories.filter((c) => c.status === "stub").length,
    };
  }, [ruleset]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">Methodology &amp; Rules</h2>
        {ruleset && (
          <span className="text-xs text-muted-foreground">
            {ruleset.categories.length} categories ({counts.active} deep · {counts.stub} stub) · ruleset v{ruleset.version}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8 gap-2 text-xs"
          onClick={exportHtml}
          disabled={exporting || !ruleset}
          title="Export the full ruleset as a self-contained HTML methodology document"
        >
          {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          Export HTML
        </Button>
        <div className="flex gap-1 rounded-md border border-border p-1">
          {(["methodology", "manage"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "rounded px-3 py-1 text-xs font-medium capitalize transition-colors " +
                (tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/50")
              }
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading ruleset from the engine…
        </div>
      )}
      {error && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            Could not load the ruleset from the engine: {error}
          </CardContent>
        </Card>
      )}
      {ruleset && !loading && tab === "methodology" && (
        <MethodologyTab ruleset={ruleset} selectedId={selectedId} setSelectedId={setSelectedId} />
      )}
      {ruleset && !loading && tab === "manage" && <ManageTab ruleset={ruleset} reload={load} />}
    </div>
  );
}
