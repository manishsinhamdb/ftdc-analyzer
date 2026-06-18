import { useEffect, useMemo, useState } from "react";
import { Compass, Search } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { TimeSeriesChart } from "@/components/TimeSeriesChart";
import { RangeSelector } from "@/components/RangeSelector";
import {
  type CaptureInfo,
  type ChartSpec,
  type MetricFull,
  type MetricsFull,
  type SeriesData,
  fmtNum,
} from "@/lib/ftdc";

const ALL = "__all__";
const MAX_SELECT = 4;

// Common metric groups offered as one-click pre-filters (shown only if present).
const QUICK_PICKS = [
  "WiredTiger Cache",
  "System CPU",
  "System Disks",
  "System Memory",
  "Op Latencies",
  "Replication Status",
  "TCMalloc",
  "Network",
];

function shortLabel(path: string): string {
  return path.split(".").slice(-2).join(".");
}

function applyMode(m: MetricFull, mode: "raw" | "rate", t: number[]): (number | null)[] {
  if (mode === "raw") return m.v;
  const out: (number | null)[] = [null];
  for (let i = 1; i < m.v.length; i++) {
    const a = m.v[i];
    const b = m.v[i - 1];
    const dt = (t[i] - t[i - 1]) / 1000;
    out.push(a == null || b == null || dt <= 0 ? null : (a - b) / dt);
  }
  return out;
}

interface Props {
  metricsFull: MetricsFull | null;
  loading: boolean;
  capture: CaptureInfo;
  master?: SeriesData;
  range: [number, number];
  setRange: (r: [number, number]) => void;
}

export function ExploreView({ metricsFull, loading, capture, master, range, setRange }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"raw" | "rate">("rate");

  const metrics = metricsFull?.metrics ?? [];
  const byPath = useMemo(() => {
    const m = new Map<string, MetricFull>();
    for (const x of metrics) m.set(x.path, x);
    return m;
  }, [metrics]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of metrics) set.add(m.category);
    return Array.from(set).sort();
  }, [metrics]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return metrics.filter((m) => {
      if (q && !m.path.toLowerCase().includes(q)) return false;
      if (category !== ALL && m.category !== category) return false;
      if (kind !== ALL && m.kind !== kind) return false;
      return true;
    });
  }, [metrics, query, category, kind]);

  // Auto-pick mode from the primary selected metric's kind.
  const primary = selected[0];
  useEffect(() => {
    if (!primary) return;
    const m = byPath.get(primary);
    if (m) setMode(m.kind === "counter" ? "rate" : "raw");
  }, [primary, byPath]);

  const toggle = (path: string) => {
    setSelected((cur) => {
      if (cur.includes(path)) return cur.filter((p) => p !== path);
      if (cur.length >= MAX_SELECT) return cur;
      return [...cur, path];
    });
  };

  const t = metricsFull?.timeline.t ?? [];
  const selectedMetrics = selected.map((p) => byPath.get(p)).filter(Boolean) as MetricFull[];

  const seriesMap: Record<string, SeriesData> = {};
  for (const m of selectedMetrics) seriesMap[m.path] = { t, v: applyMode(m, mode, t) };

  const spec: ChartSpec = {
    title:
      selectedMetrics.length === 0
        ? "Select a metric"
        : selectedMetrics.length === 1
          ? selectedMetrics[0].path
          : `${selectedMetrics.length} metrics overlaid`,
    unit: mode === "rate" ? "/s" : "",
    series: selectedMetrics.map((m) => ({ key: m.path, label: shortLabel(m.path) })),
  };

  if (loading || !metricsFull) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
          <Skeleton className="h-[60vh] w-full" />
          <Skeleton className="h-[60vh] w-full" />
        </div>
        {loading && (
          <p className="text-center text-sm text-muted-foreground">
            Loading all {metricsFull?.metrics.length ?? "1370"} metrics…
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <RangeSelector capture={capture} masterSeries={master} value={range} onChange={setRange} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        {/* Left: metric picker */}
        <Card className="flex h-fit flex-col">
          <CardHeader className="gap-2 pb-2">
            <CardTitle className="flex items-center justify-between text-sm">
              Metrics
              <span className="font-mono text-xs text-muted-foreground">
                {filtered.length} / {metrics.length}
              </span>
            </CardTitle>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by path…"
                className="pl-9"
              />
            </div>
            <div className="flex gap-2">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-8 flex-1 text-xs">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All categories</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="h-8 w-[110px] text-xs">
                  <SelectValue placeholder="Kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All kinds</SelectItem>
                  <SelectItem value="counter">counter</SelectItem>
                  <SelectItem value="gauge">gauge</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-1">
              {QUICK_PICKS.filter((c) => categories.includes(c)).map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setQuery("");
                    setKind(ALL);
                    setCategory(category === c ? ALL : c);
                  }}
                  className={
                    "rounded-full border px-2 py-0.5 text-[10px] transition-colors " +
                    (category === c
                      ? "border-primary bg-primary/20 text-foreground"
                      : "border-border text-muted-foreground hover:bg-secondary/40")
                  }
                >
                  {c}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {selected.length}/{MAX_SELECT} selected · click to overlay
            </p>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[56vh] rounded-md border border-border">
              <div className="divide-y divide-border">
                {filtered.slice(0, 800).map((m) => {
                  const on = selected.includes(m.path);
                  const disabled = !on && selected.length >= MAX_SELECT;
                  return (
                    <button
                      key={m.path}
                      onClick={() => toggle(m.path)}
                      disabled={disabled}
                      className={
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors " +
                        (on
                          ? "bg-primary/15 text-foreground"
                          : disabled
                            ? "cursor-not-allowed text-muted-foreground/50"
                            : "text-muted-foreground hover:bg-secondary/40")
                      }
                    >
                      <span className="truncate font-mono">{m.path}</span>
                      <Badge
                        variant="outline"
                        className="shrink-0 px-1 py-0 text-[9px] text-muted-foreground"
                      >
                        {m.kind === "counter" ? "C" : "G"}
                      </Badge>
                    </button>
                  );
                })}
                {filtered.length > 800 && (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Showing first 800 of {filtered.length} — refine the filter.
                  </div>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Right: chart + summary */}
        <div className="space-y-4">
          <div className="flex items-center justify-end gap-1 rounded-md border border-border bg-card p-1">
            <span className="mr-auto pl-2 text-xs text-muted-foreground">View</span>
            {(["raw", "rate"] as const).map((mo) => (
              <Button
                key={mo}
                size="sm"
                variant={mode === mo ? "default" : "ghost"}
                className="h-7 px-3 text-xs"
                onClick={() => setMode(mo)}
              >
                {mo === "raw" ? "Raw" : "Rate (/s)"}
              </Button>
            ))}
          </div>

          {selectedMetrics.length === 0 ? (
            <Card>
              <CardContent className="flex h-[280px] flex-col items-center justify-center gap-3 text-center">
                <Compass className="size-7 text-muted-foreground/50" />
                <div className="max-w-md space-y-1">
                  <div className="text-sm font-semibold">Explore the raw metric catalog</div>
                  <p className="text-xs text-muted-foreground">
                    Search {metrics.length.toLocaleString("en-US")} metrics, click up to {MAX_SELECT}{" "}
                    to overlay them on one chart, and toggle Raw/Rate. Use the quick-picks or
                    category filter to jump to a group.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <TimeSeriesChart spec={spec} series={seriesMap} range={range} />
          )}

          {selectedMetrics.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Summary stats (raw bucketed series)</CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="px-2 py-1 text-left">metric</th>
                      <th className="px-2 py-1 text-left">kind</th>
                      {(["min", "p50", "p95", "p99", "max", "mean"] as const).map((k) => (
                        <th key={k} className="px-2 py-1 text-right">{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedMetrics.map((m) => (
                      <tr key={m.path} className="border-t border-border">
                        <td className="px-2 py-1 font-mono">{shortLabel(m.path)}</td>
                        <td className="px-2 py-1 text-muted-foreground">{m.kind}</td>
                        {(["min", "p50", "p95", "p99", "max", "mean"] as const).map((k) => (
                          <td key={k} className="px-2 py-1 text-right font-mono">
                            {fmtNum(m.summary[k])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
