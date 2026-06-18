import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Brush,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import {
  type CaptureInfo,
  type SeriesData,
  fmtAxisDate,
  fmtSpan,
} from "@/lib/ftdc";

const HOUR = 3600 * 1000;
const PRESETS: { key: string; label: string; ms: number }[] = [
  { key: "all", label: "All", ms: Infinity },
  { key: "48h", label: "48h", ms: 48 * HOUR },
  { key: "24h", label: "24h", ms: 24 * HOUR },
  { key: "12h", label: "12h", ms: 12 * HOUR },
  { key: "6h", label: "6h", ms: 6 * HOUR },
  { key: "1h", label: "1h", ms: 1 * HOUR },
];

interface Props {
  capture: CaptureInfo;
  masterSeries?: SeriesData;
  value: [number, number];
  onChange: (range: [number, number]) => void;
}

export function RangeSelector({ capture, masterSeries, value, onChange }: Props) {
  const data = useMemo(() => {
    if (!masterSeries?.t?.length) return [];
    return masterSeries.t.map((t, i) => {
      const raw = masterSeries.v?.[i];
      return { t, v: raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw };
    });
  }, [masterSeries]);

  const T = useMemo(() => data.map((d) => d.t), [data]);
  const first = T.length ? T[0] : 0;
  const last = T.length ? T[T.length - 1] : 0;
  const span = Math.max(0, last - first);
  // Prefer the authoritative capture span for deciding which presets to show.
  const captureSpanMs = capture.span_seconds ? capture.span_seconds * 1000 : span;

  const presetRange = (ms: number): [number, number] =>
    ms === Infinity ? [first, last] : [Math.max(first, last - ms), last];

  const tol = T.length ? span / T.length + 1000 : 1000;
  const isActive = (ms: number) => {
    const [s, e] = presetRange(ms);
    return Math.abs(value[0] - s) < tol && Math.abs(value[1] - e) < tol;
  };

  const startIndex = useMemo(() => {
    let idx = 0;
    for (let i = 0; i < T.length; i++) {
      if (T[i] >= value[0]) {
        idx = i;
        break;
      }
      idx = i;
    }
    return idx;
  }, [T, value]);

  const endIndex = useMemo(() => {
    let idx = T.length ? T.length - 1 : 0;
    for (let i = T.length - 1; i >= 0; i--) {
      if (T[i] <= value[1]) {
        idx = i;
        break;
      }
      idx = i;
    }
    return Math.max(idx, startIndex);
  }, [T, value, startIndex]);

  const onBrush = (e: { startIndex?: number; endIndex?: number }) => {
    if (typeof e?.startIndex !== "number" || typeof e?.endIndex !== "number") return;
    const a = data[e.startIndex]?.t;
    const b = data[e.endIndex]?.t;
    if (a == null || b == null) return;
    if (a !== value[0] || b !== value[1]) onChange([a, b]);
  };

  const windowMs = Math.max(0, value[1] - value[0]);

  return (
    <div className="rounded-lg border border-border bg-card/70 px-3 py-1.5 shadow-sm backdrop-blur">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Time window</span>
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background/40 p-1">
          {PRESETS.filter(
            (p) => p.ms === Infinity || p.ms <= captureSpanMs || captureSpanMs === 0,
          ).map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={isActive(p.ms) ? "default" : "ghost"}
              className="h-7 px-3 text-xs"
              onClick={() => onChange(presetRange(p.ms))}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-3 text-xs"
          onClick={() => onChange(presetRange(Infinity))}
        >
          Reset
        </Button>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {fmtAxisDate(value[0])} → {fmtAxisDate(value[1])} · {fmtSpan(Math.round(windowMs / 1000))}
        </span>
      </div>

      {data.length > 1 ? (
        <ResponsiveContainer width="100%" height={64}>
          <AreaChart data={data} margin={{ left: 4, right: 8, top: 2, bottom: 0 }}>
            <defs>
              <linearGradient id="rangeFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4DA6FF" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#4DA6FF" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} hide />
            <YAxis hide domain={[0, "dataMax"]} />
            <Area
              dataKey="v"
              type="monotone"
              stroke="#4DA6FF"
              strokeWidth={1}
              fill="url(#rangeFill)"
              isAnimationActive={false}
              connectNulls
            />
            <Brush
              dataKey="t"
              height={18}
              travellerWidth={8}
              stroke="#4DA6FF"
              fill="#0D1B2A"
              startIndex={startIndex}
              endIndex={endIndex}
              onChange={onBrush}
              tickFormatter={(t: number) => fmtAxisDate(t)}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="py-6 text-center text-xs text-muted-foreground">
          (no master series for range preview)
        </div>
      )}
    </div>
  );
}
