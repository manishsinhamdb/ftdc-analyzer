import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  type HealthcheckReport as HC,
  fmtBytes,
  fmtCompact,
} from "@/lib/ftdc";
import type { SizingRecommendation } from "@/lib/sizing";

// Snapshot (single-moment) structural tiles rendered from the parsed healthcheck — NOT
// time-series (so: bars / tables / gauges, no min–max band line charts). These populate the
// Charts → "Indexes & Storage" category in place of the "needs data" placeholders once a
// healthcheck is loaded.

const WARN = "#D6940B";
const GOOD = "#00B96A";
const BLUE = "#4DA6FF";
const RISK = "#E0533F";

function Tile({ title, children, badge }: { title: string; children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          {badge}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// One labelled horizontal bar (value as a fraction of `max`).
function BarRow({ label, value, max, color, right }: { label: string; value: number; max: number; color: string; right: string }) {
  const w = max > 0 ? Math.max(2, (100 * value) / max) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-40 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={label}>{label}</span>
      <div className="h-3 flex-1 overflow-hidden rounded-sm bg-secondary/40">
        <div className="h-full rounded-sm" style={{ width: `${w}%`, backgroundColor: color }} />
      </div>
      <span className="w-24 shrink-0 text-right font-mono text-[11px]">{right}</span>
    </div>
  );
}

// A proportional split bar (e.g. on-disk within logical) + a center label.
function SplitBar({ filledPct, color, height = 16 }: { filledPct: number; color: string; height?: number }) {
  return (
    <div className="w-full overflow-hidden rounded-md bg-secondary/40" style={{ height }}>
      <div className="h-full rounded-md" style={{ width: `${Math.max(0, Math.min(100, filledPct))}%`, backgroundColor: color }} />
    </div>
  );
}

export function StructuralTiles({ hc, sizing }: { hc: HC; sizing?: SizingRecommendation }) {
  const ia = hc.index_analysis;
  const s = hc.server;
  const st = hc.storage;
  const rep = hc.replication;

  // ---- Tile 1: Index usage & unused indexes ----
  const topAccessed = ia.top_accessed.slice(0, 6);
  const maxOps = Math.max(1, ...topAccessed.map((x) => x.ops ?? 0));
  const unused = ia.drop_list.slice(0, 8);

  // ---- Tile 2 + 5: per-collection storage / fragmentation ----
  const colls = [...hc.collections].sort((a, b) => (b.storage_size || 0) - (a.storage_size || 0)).slice(0, 8);

  // ---- Tile 3: cache fit ----
  const cf = sizing?.cache_fit;
  const wtCacheGib = cf?.wt_cache_gib ?? s.wt_cache_gb ?? 0;
  const fillPct = cf?.cache_fill_pct ?? s.cache_fill_pct ?? 0;
  const dataToCache = cf?.data_to_cache_ratio ?? null;
  const fits = cf?.working_set_fits_in_cache ?? false;

  // ---- Tile 4: oplog window ----
  const oplogH = rep.time_diff_hours;
  const oplogUsedPct = rep.used_pct ?? 0;

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-secondary/15 px-3 py-2 text-[11px] text-muted-foreground">
        These five tiles are <span className="font-medium text-foreground">point-in-time snapshot</span> values from the
        healthcheck (getMongoData) — bars / gauges, not time-series. The FTDC time-series charts are in the other categories.
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 1 — Index usage & unused indexes */}
        <Tile
          title="Index usage & unused indexes"
          badge={
            <Badge variant="outline" className="text-[10px]" style={ia.unused_count ? { color: WARN, borderColor: WARN } : undefined}>
              {ia.unused_count} unused · {ia.reclaimable_gb} GB
            </Badge>
          }
        >
          <div className="space-y-3">
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Most accessed (ops since restart)</div>
              <div className="space-y-1.5">
                {topAccessed.map((x) => (
                  <BarRow key={x.index} label={x.index.split(".").slice(-2).join(".")} value={x.ops ?? 0} max={maxOps} color={BLUE} right={`${fmtCompact(x.ops)} · ${x.size_mb} MB`} />
                ))}
                {topAccessed.length === 0 && <p className="text-xs text-muted-foreground">No access stats.</p>}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Unused (0 accesses, _id excluded)</div>
              {unused.length === 0 ? (
                <p className="text-xs" style={{ color: GOOD }}>None — clean.</p>
              ) : (
                <div className="space-y-1">
                  {unused.map((u) => (
                    <div key={u.index} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate font-mono" style={{ color: WARN }} title={u.index}>{u.index.split(".").slice(-2).join(".")}</span>
                      <span className="shrink-0 font-mono text-muted-foreground">{u.size_mb} MB · 0 ops</span>
                    </div>
                  ))}
                  {ia.drop_list.length > unused.length && (
                    <p className="text-[10px] text-muted-foreground">+ {ia.drop_list.length - unused.length} more · {ia.reclaimable_gb} GB total reclaimable</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </Tile>

        {/* 2 — Per-collection storage size */}
        <Tile
          title="Per-collection storage size"
          badge={<Badge variant="outline" className="text-[10px]">{st.compression_ratio}× compression</Badge>}
        >
          <div className="space-y-2.5">
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm" style={{ background: BLUE }} /> on-disk (compressed)</span>
              <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm bg-secondary/70" /> logical data</span>
            </div>
            {colls.map((c) => (
              <div key={`${c.db}.${c.name}`} className="space-y-0.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="truncate font-mono" title={`${c.db}.${c.name}`}>{c.db}.{c.name}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">{fmtBytes(c.storage_size)} / {fmtBytes(c.data_size)}</span>
                </div>
                {/* on-disk shown as a fraction of the (larger) logical data → compression visible */}
                <SplitBar filledPct={(c.data_size || 0) > 0 ? (100 * (c.storage_size || 0)) / Math.max(c.storage_size || 0, c.data_size || 0) : 0} color={BLUE} height={10} />
              </div>
            ))}
          </div>
        </Tile>

        {/* 3 — Cache fit */}
        <Tile
          title="Cache fit (working set vs cache)"
          badge={
            <Badge className="text-[10px] font-semibold" style={{ backgroundColor: fits ? GOOD : WARN, color: "#0D1B2A" }}>
              {fits ? "fits in cache" : "disk-served"}
            </Badge>
          }
        >
          <div className="space-y-3">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-bold" style={{ color: fits ? GOOD : WARN }}>{dataToCache != null ? `${dataToCache}×` : "—"}</span>
              <span className="text-xs text-muted-foreground">logical data ÷ WiredTiger cache</span>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>WT cache fill</span>
                <span className="font-mono">{fillPct}%</span>
              </div>
              <SplitBar filledPct={fillPct} color={fillPct > 95 ? WARN : BLUE} />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
              <div className="rounded-md bg-secondary/30 py-1.5"><div className="font-mono font-semibold">{wtCacheGib} GiB</div><div className="text-muted-foreground">WT cache</div></div>
              <div className="rounded-md bg-secondary/30 py-1.5"><div className="font-mono font-semibold">{s.bytes_in_cache_gb} GiB</div><div className="text-muted-foreground">in cache</div></div>
              <div className="rounded-md bg-secondary/30 py-1.5"><div className="font-mono font-semibold">{st.total_data_tb} TB</div><div className="text-muted-foreground">logical data</div></div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {fits
                ? "The working-set upper bound fits the cache — reads can be largely RAM-resident."
                : "Logical data far exceeds the cache — the working set is disk-served, so storage latency/IOPS governs read performance."}
            </p>
          </div>
        </Tile>

        {/* 4 — Oplog window */}
        <Tile
          title="Oplog window"
          badge={<Badge variant="outline" className="text-[10px]">{rep.log_size_mb != null ? `${Math.round(rep.log_size_mb / 1000)} GB oplog` : "—"}</Badge>}
        >
          <div className="space-y-3">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-bold" style={{ color: (oplogH ?? 0) < 24 ? WARN : GOOD }}>{oplogH != null ? `${oplogH} h` : "—"}</span>
              <span className="text-xs text-muted-foreground">recovery / replication window</span>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>oplog used</span>
                <span className="font-mono">{oplogUsedPct}% ({fmtBytes((rep.used_mb ?? 0) * 1e6)} / {fmtBytes((rep.log_size_mb ?? 0) * 1e6)})</span>
              </div>
              <SplitBar filledPct={oplogUsedPct} color={BLUE} />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              How far back the oplog reaches — a secondary down longer than this needs a full resync.
              {(oplogH ?? 99) < 24 && <span style={{ color: WARN }}> Under 24 h is tight for large-data recovery.</span>}
            </p>
          </div>
        </Tile>

        {/* 5 — Collection fragmentation (proxy) */}
        <Tile
          title="Collection fragmentation (proxy)"
          badge={<Badge variant="outline" className="gap-1 text-[10px]" style={{ color: WARN, borderColor: WARN }}>proxy</Badge>}
        >
          <div className="space-y-2.5">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              True fragmentation needs <span className="font-mono">freeStorageSize</span> (not in this snapshot). Shown as
              on-disk ÷ logical per collection — with compression this is usually &lt; 1; an outlier near/above 1 (or far above
              the cluster's {st.compression_ratio}× norm) hints at fragmentation or low compressibility.
            </p>
            {colls.map((c) => {
              const ratio = (c.data_size || 0) > 0 ? (c.storage_size || 0) / (c.data_size || 0) : 0;
              const high = ratio > 0.9;
              return (
                <BarRow
                  key={`${c.db}.${c.name}`}
                  label={`${c.db}.${c.name}`}
                  value={ratio}
                  max={1}
                  color={high ? RISK : BLUE}
                  right={`${(ratio * 100).toFixed(0)}%`}
                />
              );
            })}
          </div>
        </Tile>
      </div>
    </div>
  );
}
