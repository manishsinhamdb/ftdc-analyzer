// Typed model for results.json produced by ftdc_analyzer.verdicts.

export type VerdictStatus = "PASS" | "WARN" | "FAIL" | "NA";

export interface Check {
  name: string;
  value: number | null;
  threshold: number | null;
  status: VerdictStatus;
}

export interface Verdict {
  verdict: string;
  confidence: string;
  headline: string;
  recommendation: string;
  recommended_vcpus?: number | null;
  checks: Check[];
}

export interface Verdicts {
  ram: Verdict;
  cpu: Verdict;
  disk: Verdict;
}

export interface SignalStat {
  unit: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export interface SeriesData {
  t: number[]; // epoch ms
  v: (number | null)[];
}

export interface HostInfo {
  hostname: string | null;
  mongo_version: string | null;
  num_cores: number | null;
  mem_mb: number | null;
  role: string | null;
  data_disk: string | null;
  cluster_role?: string | null;
}

export interface CaptureInfo {
  first_ts_iso: string | null;
  last_ts_iso: string | null;
  span_seconds: number;
  samples: number;
}

export interface SourceInfo {
  dir: string;
  file_count: number;
}

// ---- v2: chart catalog + insights ---------------------------------------

export interface ChartSeriesEntry {
  key: string;
  label: string;
  refLine?: number;
  refLabel?: string;
}

export interface ChartSpec {
  title: string;
  unit: string;
  series: ChartSeriesEntry[];
}

export interface ChartCategory {
  category: string;
  charts: ChartSpec[];
}

export type InsightStatus = "OK" | "WARN" | "FAIL";

export interface Insight {
  id: string;
  title: string;
  status: InsightStatus;
  headline: string;
  detail: string;
  metric: string;
  value: number | null;
  threshold: number | null;
}

// ---- v3: assessment (signature engine) + cost optimization -----------------

export type SignatureSeverity = "OK" | "INFO" | "WARN" | "CRITICAL";

export interface Signature {
  id: string;
  title: string;
  severity: SignatureSeverity;
  purpose: string;
  symptoms: string[];
  recommendation: string;
}

export interface Assessment {
  headline: string;
  posture: string;
  purposes_covered: string[];
  signatures: Signature[];
}

export interface CostAction {
  resource: string;
  recommendation: string;
  rationale: string;
  lever: string;
  risk: string;
}

export interface CostOptimization {
  opportunity: "high" | "medium" | "low" | "none";
  headline: string;
  actions: CostAction[];
}

export const SIGNATURE_COLORS: Record<SignatureSeverity, string> = {
  OK: "#00ED64",
  INFO: "#5A6E82",
  WARN: "#F5A623",
  CRITICAL: "#E05C4B",
};

export const SEVERITY_RANK: Record<SignatureSeverity, number> = {
  CRITICAL: 0,
  WARN: 1,
  INFO: 2,
  OK: 3,
};

export interface FtdcResults {
  schema_version: number;
  generated_at: string;
  source: SourceInfo;
  host: HostInfo;
  capture: CaptureInfo;
  signals: Record<string, SignalStat>;
  assessment: Assessment;
  verdicts: Verdicts;
  cost_optimization: CostOptimization;
  insights: Insight[];
  chart_catalog: ChartCategory[];
  facts: Facts;
  series: Record<string, SeriesData>;
  missing_paths: string[];
  skipped_files?: { file: string; reason: string }[];
  notes: string[];
}

// ---- v3: facts (full metadata) ------------------------------------------

export interface Facts {
  buildInfo: Record<string, unknown>;
  hostInfo: Record<string, unknown>;
  getCmdLineOpts: Record<string, unknown>;
  derived: Record<string, string | number | null>;
}

// ---- metrics_full (all 1370 metrics, bucketed) --------------------------

export type MetricKind = "counter" | "gauge";

export interface MetricSummary {
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export interface MetricFull {
  path: string;
  category: string;
  kind: MetricKind;
  summary: MetricSummary;
  v: (number | null)[];
}

export interface MetricsFull {
  schema: string;
  generated_at?: string;
  host: { hostname: string | null; version: string | null };
  n_points: number;
  timeline: { t: number[] };
  metrics: MetricFull[];
}

/** Flatten a nested object into dotted key → string-value rows. */
export function flattenObject(obj: unknown, prefix = ""): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [];
  const walk = (val: unknown, key: string) => {
    if (val === null || val === undefined) {
      rows.push({ key, value: val === null ? "null" : "—" });
    } else if (Array.isArray(val)) {
      if (val.length === 0) rows.push({ key, value: "[]" });
      else val.forEach((v, i) => walk(v, key ? `${key}.${i}` : String(i)));
    } else if (typeof val === "object") {
      const entries = Object.entries(val as Record<string, unknown>);
      if (entries.length === 0) rows.push({ key, value: "{}" });
      else entries.forEach(([k, v]) => walk(v, key ? `${key}.${k}` : k));
    } else {
      rows.push({ key, value: String(val) });
    }
  };
  walk(obj, prefix);
  return rows;
}

export interface RunHistoryEntry {
  hostname: string;
  timestamp: string;
  source_path: string;
  cache_dir: string;
}

/** Preferred master series for the global range selector; falls back to first
 *  series with data if absent. */
export const MASTER_SERIES = "disk_util_pct";

export const INSIGHT_COLORS: Record<InsightStatus, string> = {
  OK: "#00ED64",
  WARN: "#F5A623",
  FAIL: "#E05C4B",
};

// ---- helpers -------------------------------------------------------------

export interface ChartPoint {
  t: number; // epoch ms
  v: number | null;
}

/** Zip a series {t,v} into [{t,v}] points for Recharts; null v gaps the line. */
export function seriesToPoints(s: SeriesData | undefined): ChartPoint[] {
  if (!s || !s.t) return [];
  return s.t.map((t, i) => {
    const raw = s.v?.[i];
    const v = raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw;
    return { t, v };
  });
}

export function fmtNum(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtSpan(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(" ") || `${seconds}s`;
}

/** Verdict → accent hex, matching the engine's verdict semantics. */
export const VERDICT_COLORS: Record<string, string> = {
  REDUCE: "#00ED64",
  HOLD: "#5A6E82",
  UNDERSIZED: "#F5A623",
  CONSTRAINED: "#F5A623",
  SATURATED: "#E05C4B",
};

export const STATUS_COLORS: Record<VerdictStatus, string> = {
  PASS: "#00ED64",
  WARN: "#F5A623",
  FAIL: "#E05C4B",
  NA: "#8AA0B6",
};

// ---- chart helpers -------------------------------------------------------

export type YUnit = "%" | "/s" | "ms" | "GB" | "MB/s" | "s" | "";

export const LINE_PALETTE = [
  "#00ED64",
  "#4DA6FF",
  "#FFC857",
  "#E05C4B",
  "#B392F0",
  "#3DDBD9",
];

export const REF_LINE_COLOR = "#F5A623"; // dashed amber reference lines

export function fmtAxisDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtFullTs(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatValue(
  v: number | null | undefined,
  unit: string,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const n = v.toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(v) >= 100 ? 1 : 2,
  });
  switch (unit) {
    case "%":
      return `${n}%`;
    case "/s":
      return `${n}/s`;
    case "/min":
      return `${n}/min`;
    case "ms":
      return `${n} ms`;
    case "GB":
      return `${n} GB`;
    case "MB":
      return `${n} MB`;
    case "MB/s":
      return `${n} MB/s`;
    case "s":
      return `${n} s`;
    case "":
    case "ratio":
    case "count":
      return n;
    default:
      return `${n} ${unit}`;
  }
}

export function formatAxisValue(v: number, unit: string): string {
  const n = v.toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1,
  });
  return unit === "%" ? `${n}%` : n;
}

export interface ChartRow {
  t: number;
  [key: string]: number | null;
}

/** Merge multiple named series into Recharts rows keyed by timestamp,
 *  restricted to [range]. Missing values stay undefined → Recharts gaps. */
export function mergeSeries(
  series: Record<string, SeriesData>,
  keys: string[],
  range: [number, number],
): ChartRow[] {
  const [s, e] = range;
  const map = new Map<number, ChartRow>();
  for (const k of keys) {
    const sd = series[k];
    if (!sd || !sd.t) continue;
    for (let i = 0; i < sd.t.length; i++) {
      const t = sd.t[i];
      if (t < s || t > e) continue;
      let row = map.get(t);
      if (!row) {
        row = { t };
        map.set(t, row);
      }
      const raw = sd.v?.[i];
      row[k] = raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

export function presentKeys(
  series: Record<string, SeriesData>,
  keys: string[],
): string[] {
  return keys.filter((k) => series[k] && series[k].t && series[k].t.length > 0);
}

export function globalRange(
  series: Record<string, SeriesData>,
): [number, number] {
  let mn = Infinity;
  let mx = -Infinity;
  for (const k in series) {
    const sd = series[k];
    if (!sd?.t?.length) continue;
    mn = Math.min(mn, sd.t[0]);
    mx = Math.max(mx, sd.t[sd.t.length - 1]);
  }
  return Number.isFinite(mn) ? [mn, mx] : [0, 0];
}

export type Preset = "all" | "48h" | "24h" | "12h" | "6h";

export const PRESETS: { key: Preset; label: string }[] = [
  { key: "all", label: "All" },
  { key: "48h", label: "48h" },
  { key: "24h", label: "24h" },
  { key: "12h", label: "12h" },
  { key: "6h", label: "6h" },
];

export function rangeForPreset(
  p: Preset,
  g: [number, number],
): [number, number] {
  const [mn, mx] = g;
  if (p === "all") return [mn, mx];
  const hours: Record<Exclude<Preset, "all">, number> = {
    "48h": 48,
    "24h": 24,
    "12h": 12,
    "6h": 6,
  };
  return [Math.max(mn, mx - hours[p] * 3600 * 1000), mx];
}
