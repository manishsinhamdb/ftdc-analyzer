import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChartModal } from "@/components/TimeSeriesChart";

import {
  type ChartSpec,
  type SeriesData,
  type SignalStat,
  fmtNum,
} from "@/lib/ftdc";

const ALL = "__all__";
const BREACH = "#E05C4B";

export type Thresholds = Record<string, { p95?: number; p99?: number }>;

function Sparkline({ values }: { values: (number | null)[] }) {
  const W = 88;
  const H = 20;
  const P = 2;
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length < 2) {
    return <span className="text-[10px] text-muted-foreground/40">—</span>;
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const N = Math.min(48, values.length);
  const step = (values.length - 1) / (N - 1);
  let last = finite[0];
  const pts: string[] = [];
  for (let i = 0; i < N; i++) {
    const raw = values[Math.round(i * step)];
    const v = raw == null || !Number.isFinite(raw) ? last : (raw as number);
    last = v;
    const x = P + (i / (N - 1)) * (W - 2 * P);
    const y = P + (1 - (v - min) / span) * (H - 2 * P);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return (
    <svg width={W} height={H} className="block">
      <polyline points={pts.join(" ")} fill="none" stroke="#4DA6FF" strokeWidth={1} />
    </svg>
  );
}

interface Props {
  signals: Record<string, SignalStat>;
  series: Record<string, SeriesData>;
  range: [number, number];
  thresholds: Thresholds;
}

export function SignalsTable({ signals, series, range, thresholds }: Props) {
  const [query, setQuery] = useState("");
  const [unit, setUnit] = useState<string>(ALL);
  const [openSpec, setOpenSpec] = useState<ChartSpec | null>(null);
  const entries = useMemo(() => Object.entries(signals), [signals]);

  const units = useMemo(() => {
    const set = new Set<string>();
    for (const [, s] of entries) set.add(s.unit || "—");
    return Array.from(set).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(([name, s]) => {
      if (q && !name.toLowerCase().includes(q)) return false;
      if (unit !== ALL && (s.unit || "—") !== unit) return false;
      return true;
    });
  }, [entries, query, unit]);

  const hasSeries = (name: string) => Boolean(series[name]?.t?.length);

  const breachColor = (name: string, stat: "p95" | "p99", value: number | null) => {
    if (value == null) return undefined;
    const thr = thresholds[name]?.[stat];
    return thr != null && value >= thr ? BREACH : undefined;
  };

  const openChart = (name: string, s: SignalStat) => {
    if (!hasSeries(name)) return;
    setOpenSpec({
      title: name,
      unit: s.unit || "",
      series: [{ key: name, label: name }],
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter signals by name…"
              className="pl-9"
            />
          </div>
          <Select value={unit} onValueChange={setUnit}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Unit" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All units</SelectItem>
              {units.map((u) => (
                <SelectItem key={u} value={u}>
                  {u}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="shrink-0 text-sm text-muted-foreground">
          {filtered.length.toLocaleString("en-US")} / {entries.length.toLocaleString("en-US")} signals
          <span className="ml-2 text-xs text-muted-foreground/70">· click a row to chart it</span>
        </div>
      </div>

      <ScrollArea className="h-[64vh] rounded-md border border-border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-xs">signal</TableHead>
              <TableHead className="text-xs">unit</TableHead>
              <TableHead className="text-xs">trend</TableHead>
              <TableHead className="text-right text-xs">p50</TableHead>
              <TableHead className="text-right text-xs">p95</TableHead>
              <TableHead className="text-right text-xs">p99</TableHead>
              <TableHead className="text-right text-xs">max</TableHead>
              <TableHead className="text-right text-xs">mean</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map(([name, s], i) => {
              const clickable = hasSeries(name);
              const p95c = breachColor(name, "p95", s.p95);
              const p99c = breachColor(name, "p99", s.p99);
              return (
                <TableRow
                  key={name}
                  onClick={() => openChart(name, s)}
                  className={
                    "border-border " +
                    (i % 2 === 1 ? "bg-secondary/20 " : "") +
                    (clickable ? "cursor-pointer hover:bg-secondary/50" : "hover:bg-secondary/30")
                  }
                  title={clickable ? "Click to open this metric in a chart" : undefined}
                >
                  <TableCell className="py-1 text-xs">{name}</TableCell>
                  <TableCell className="py-1 text-xs text-muted-foreground">{s.unit || "—"}</TableCell>
                  <TableCell className="py-1">
                    <Sparkline values={series[name]?.v ?? []} />
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs">{fmtNum(s.p50)}</TableCell>
                  <TableCell
                    className="py-1 text-right font-mono text-xs"
                    style={p95c ? { color: p95c, fontWeight: 600 } : undefined}
                  >
                    {fmtNum(s.p95)}
                  </TableCell>
                  <TableCell
                    className="py-1 text-right font-mono text-xs"
                    style={p99c ? { color: p99c, fontWeight: 600 } : undefined}
                  >
                    {fmtNum(s.p99)}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs">{fmtNum(s.max)}</TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs">{fmtNum(s.mean)}</TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  No signals match the current filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ScrollArea>

      {openSpec && (
        <ChartModal
          spec={openSpec}
          series={series}
          range={range}
          open={!!openSpec}
          onOpenChange={(o) => !o && setOpenSpec(null)}
        />
      )}
    </div>
  );
}
