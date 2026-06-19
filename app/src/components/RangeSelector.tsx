import { useMemo } from "react";
import { Clock, LayoutGrid } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  type CaptureInfo,
  type SeriesData,
  GRANULARITIES,
  PRESETS,
  fmtAxisDate,
  fmtSpan,
  humanBucketDuration,
  rangeForPreset,
} from "@/lib/ftdc";

interface Props {
  capture: CaptureInfo;
  value: [number, number];
  onChange: (range: [number, number]) => void;
  // Granularity (bucket resolution) — optional; when provided, the granularity control shows.
  granularity?: number;
  onGranularityChange?: (buckets: number) => void;
  // back-compat (ignored): the old sliding-bar took a master series.
  masterSeries?: SeriesData;
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RangeSelector({
  capture,
  value,
  onChange,
  granularity,
  onGranularityChange,
}: Props) {
  // Full capture window — derived from the capture metadata (authoritative end-to-end span).
  const full = useMemo<[number, number]>(() => {
    const a = capture.first_ts_iso ? Date.parse(capture.first_ts_iso) : NaN;
    const b = capture.last_ts_iso ? Date.parse(capture.last_ts_iso) : NaN;
    if (Number.isFinite(a) && Number.isFinite(b)) return [a, b];
    return value;
  }, [capture, value]);

  const [fs, fe] = full;
  const windowSec = Math.max(0, Math.round((value[1] - value[0]) / 1000));

  const presetActive = (key: (typeof PRESETS)[number]["key"]) => {
    const [s, e] = rangeForPreset(key, full);
    const tol = 60_000; // 1-min tolerance
    return Math.abs(value[0] - s) < tol && Math.abs(value[1] - e) < tol;
  };

  const clamp = (ms: number) => Math.min(fe, Math.max(fs, ms));

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* Range presets */}
        <div className="flex items-center gap-1.5">
          <Clock className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium text-muted-foreground">Range</span>
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background/40 p-1">
            {PRESETS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={presetActive(p.key) ? "default" : "ghost"}
                className="h-7 px-2.5 text-xs"
                onClick={() => onChange(rangeForPreset(p.key, full))}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Custom start/end (for RCA on a specific window) */}
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span>custom</span>
          <input
            type="datetime-local"
            value={toLocalInput(value[0])}
            min={toLocalInput(fs)}
            max={toLocalInput(fe)}
            onChange={(e) => {
              const ms = Date.parse(e.target.value);
              if (Number.isFinite(ms)) onChange([clamp(ms), value[1]]);
            }}
            className="h-7 rounded-md border border-border bg-background px-1.5 font-mono text-[11px] text-foreground"
          />
          <span>→</span>
          <input
            type="datetime-local"
            value={toLocalInput(value[1])}
            min={toLocalInput(fs)}
            max={toLocalInput(fe)}
            onChange={(e) => {
              const ms = Date.parse(e.target.value);
              if (Number.isFinite(ms)) onChange([value[0], clamp(ms)]);
            }}
            className="h-7 rounded-md border border-border bg-background px-1.5 font-mono text-[11px] text-foreground"
          />
        </div>

        {/* Granularity (bucket resolution) */}
        {granularity != null && onGranularityChange && (
          <div className="flex items-center gap-1.5">
            <LayoutGrid className="size-3.5 text-muted-foreground" />
            <span className="text-[11px] font-medium text-muted-foreground">Granularity</span>
            <div className="flex items-center gap-1 rounded-md border border-border bg-background/40 p-1">
              {GRANULARITIES.map((g) => {
                const dur = humanBucketDuration(value[1] - value[0], g.buckets);
                return (
                  <Button
                    key={g.key}
                    size="sm"
                    variant={granularity === g.buckets ? "default" : "ghost"}
                    className="h-7 px-2.5 text-xs"
                    title={`${g.label} · ~${g.buckets} buckets — the whole range is always shown, just at this bucket size`}
                    onClick={() => onGranularityChange(g.buckets)}
                  >
                    {dur}
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        {/* Full-capture + current-window label */}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          capture {fmtAxisDate(fs)} → {fmtAxisDate(fe)} · showing {fmtSpan(windowSec)}
        </span>
      </div>
    </div>
  );
}
