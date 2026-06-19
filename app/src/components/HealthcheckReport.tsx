import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Boxes,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Layers,
  ListTree,
  Lock,
  MemoryStick,
  Network,
  Server,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type HealthcheckReport as HC,
  type HcCollection,
  fmtBytes,
  fmtCompact,
} from "@/lib/ftdc";
import type { SizingRecommendation } from "@/lib/sizing";

// Semantic colors used ONLY for meaning (read well in both themes).
const GOOD = "#00B96A";
const WARN = "#D6940B";
const RISK = "#E0533F";

function Hero({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold leading-tight" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Section({ title, icon, children, right }: { title: string; icon: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
          {right}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function KV({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span className={"text-sm " + (mono ? "font-mono" : "font-medium")}>{v}</span>
    </div>
  );
}

// A simple proportional bar (used for RAM split + histograms).
function Bar({ segments, height = 14 }: { segments: { w: number; color: string; title?: string }[]; height?: number }) {
  const total = segments.reduce((a, s) => a + s.w, 0) || 1;
  return (
    <div className="flex w-full overflow-hidden rounded-md" style={{ height }}>
      {segments.map((s, i) => (
        <div key={i} title={s.title} style={{ width: `${(100 * s.w) / total}%`, backgroundColor: s.color }} />
      ))}
    </div>
  );
}

function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${n}%`;
}

export function HealthcheckReport({ hc, sizing }: { hc: HC; sizing?: SizingRecommendation }) {
  const [tab, setTab] = useState("summary");
  const s = hc.server;
  const t = hc.topology;
  const st = hc.storage;
  const ia = hc.index_analysis;
  const sec = hc.security;

  // RAM illustration: WT cache / (rest = FS cache + OS + connections).
  const memGb = s.mem_gb ?? 0;
  const wtGb = s.wt_cache_gb ?? 0;
  const restGb = Math.max(0, memGb - wtGb);

  return (
    <div className="space-y-4">
      {/* Title row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-lg font-bold">Healthcheck Report</h2>
        <Badge variant="outline" className="font-mono text-[11px]">
          getMongoData v{hc.server.script_version ?? "?"}
        </Badge>
        {sec.is_community && (
          <Badge style={{ backgroundColor: WARN, color: "#1a1206" }} className="text-[11px] font-semibold">
            Community Edition
          </Badge>
        )}
        {t.is_sharded && (
          <Badge variant="outline" className="text-[11px]">
            shard member · {t.repl_set_name}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          descriptive parity with the getMongoData report — the scored intelligence is on the Assessment tab
        </span>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-card p-1">
          {[
            ["summary", "Summary", Gauge],
            ["collections", "Collections", Boxes],
            ["indexes", "Index Analyzer", ListTree],
            ["operations", "Operations", Timer],
            ["wiredtiger", "WiredTiger", Layers],
            ["security", "Health & Security", ShieldCheck],
          ].map(([v, label, Icon]) => {
            const I = Icon as typeof Gauge;
            return (
              <TabsTrigger
                key={v as string}
                value={v as string}
                className="gap-1.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              >
                <I className="size-3.5" />
                {label as string}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* ---- SUMMARY ---- */}
        <TabsContent value="summary" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Hero icon={<Timer className="size-3.5" />} label="Uptime" value={`${s.uptime_days ?? "—"}d`}
              sub={`${s.edition ?? ""} ${s.version ?? ""}`} />
            <Hero icon={<Cpu className="size-3.5" />} label="vCPU" value={s.num_cores ?? "—"} />
            <Hero icon={<MemoryStick className="size-3.5" />} label="RAM" value={`${s.mem_gb ?? "—"} GB`} />
            <Hero icon={<Database className="size-3.5" />} label="WT cache" value={`${s.wt_cache_gb ?? "—"} GiB`}
              sub={`${pct(s.cache_fill_pct)} full`} />
            <Hero icon={<Network className="size-3.5" />} label="Connections" value={fmtCompact(s.connections.current)}
              sub={`${fmtCompact(s.connections.total_created)} created`} />
            <Hero icon={<AlertTriangle className="size-3.5" />} label="Page faults" value={fmtCompact(s.page_faults)}
              tone={(s.page_faults ?? 0) > 100000 ? WARN : undefined} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Binary & defaults" icon={<Server className="size-4 text-muted-foreground" />}>
              <KV k="Edition" v={s.edition ?? "—"} />
              <KV k="Version" v={s.version ?? "—"} />
              <KV k="Storage engine" v={s.storage_engine ?? "—"} />
              <KV k="Replica set" v={t.repl_set_name ?? "—"} mono />
              <KV k="Cluster role" v={t.cluster_role ?? "standalone replica set"} />
              <KV k="Members" v={`${t.data_bearing} data-bearing + ${t.arbiters} arbiter${t.arbiters === 1 ? "" : "s"} (${t.electable} electable)`} />
              <KV k="Oplog window" v={hc.replication.time_diff_hours != null ? `${hc.replication.time_diff_hours} h` : "—"} />
            </Section>

            <Section title="RAM allocation" icon={<MemoryStick className="size-4 text-muted-foreground" />}>
              <Bar
                segments={[
                  { w: wtGb, color: "#4DA6FF", title: `WiredTiger cache ${wtGb} GiB` },
                  { w: restGb, color: "#3DDBD9", title: `Filesystem cache + OS + connections ${restGb.toFixed(1)} GiB` },
                ]}
                height={18}
              />
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: "#4DA6FF" }} /> WT cache {wtGb} GiB ({pct(s.cache_fill_pct)} full, {s.bytes_in_cache_gb ?? "—"} GiB in use)</span>
                <span className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: "#3DDBD9" }} /> FS cache + OS ≈ {restGb.toFixed(1)} GiB</span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                WiredTiger cache is ~50% of (RAM − 1 GiB) by default; the rest backs the OS filesystem
                cache (compressed-page reads), connections and the OS itself.
              </p>
            </Section>

            <Section title="Data sizes & compression" icon={<HardDrive className="size-4 text-muted-foreground" />}>
              <KV k="Logical data" v={fmtBytes(st.total_data_size)} mono />
              <KV k="On-disk (compressed)" v={fmtBytes(st.total_storage_size)} mono />
              <KV k="Compression ratio" v={st.compression_ratio != null ? `${st.compression_ratio}×` : "—"} />
              <KV k="Total index size" v={fmtBytes(st.total_index_size)} mono />
              <KV k="Block compressor" v={Object.keys(st.block_compressors).join(", ") || "—"} />
            </Section>

            <Section title="Catalog" icon={<Boxes className="size-4 text-muted-foreground" />}>
              <KV k="Databases" v={st.n_databases} />
              <KV k="Collections" v={st.n_collections} />
              <KV k="Indexes" v={st.n_indexes} />
              <KV k="Unused indexes" v={<span style={ia.unused_count ? { color: WARN } : undefined}>{ia.unused_count}</span>} />
              <KV k="Reclaimable" v={<span style={ia.reclaimable_gb ? { color: WARN } : undefined}>{ia.reclaimable_gb} GB</span>} />
            </Section>

            <Section title="Network I/O & compression" icon={<Network className="size-4 text-muted-foreground" />}>
              <KV k="Bytes in" v={`${hc.network.bytes_in_gb ?? "—"} GiB`} mono />
              <KV k="Bytes out" v={`${hc.network.bytes_out_gb ?? "—"} GiB`} mono />
              <KV k="Egress ÷ ingress" v={hc.network.egress_ingress_ratio != null ? `${hc.network.egress_ingress_ratio}× (read-heavy)` : "—"} />
              <KV k="Wire (network) compression" v={hc.network.network_compression_active ? `active · ${hc.network.network_compressor} ${hc.network.wire_compression_ratio ?? "?"}×` : "not active"} />
              <KV k="Storage block compression" v={Object.keys(hc.network.storage_block_compressors).join(", ") || "—"} />
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Wire compression (the <span className="font-mono">network.compression</span> block) and storage
                block compression (per-collection <span className="font-mono">block_compressor</span>) are
                independent layers — both shown so neither is mistaken for the other.
              </p>
            </Section>

            {sizing?.cache_fit && (
              <Section title="Working set vs cache" icon={<Gauge className="size-4 text-muted-foreground" />}>
                <KV k="Logical data" v={`${sizing.cache_fit.logical_data_gb} GB`} mono />
                <KV k="WT cache" v={`${sizing.cache_fit.wt_cache_gib} GiB`} mono />
                <KV k="Data ÷ cache" v={`${sizing.cache_fit.data_to_cache_ratio}×`} />
                <KV
                  k="Fits in cache"
                  v={
                    <span style={{ color: sizing.cache_fit.working_set_fits_in_cache ? GOOD : WARN }}>
                      {sizing.cache_fit.working_set_fits_in_cache ? "yes" : "no — disk-served"}
                    </span>
                  }
                />
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{sizing.cache_fit.note}</p>
              </Section>
            )}
          </div>
        </TabsContent>

        {/* ---- COLLECTIONS ---- */}
        <TabsContent value="collections" className="mt-4">
          <Section title={`Collections (${hc.collections.length})`} icon={<Boxes className="size-4 text-muted-foreground" />}>
            <CollectionsTable rows={hc.collections} />
          </Section>
        </TabsContent>

        {/* ---- INDEX ANALYZER ---- */}
        <TabsContent value="indexes" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Hero icon={<ListTree className="size-3.5" />} label="Total indexes" value={ia.total_indexes} />
            <Hero icon={<AlertTriangle className="size-3.5" />} label="Unused" value={ia.unused_count}
              tone={ia.unused_count ? WARN : GOOD} sub={`${ia.droppable_count} droppable`} />
            <Hero icon={<HardDrive className="size-3.5" />} label="Reclaimable" value={`${ia.reclaimable_gb} GB`}
              tone={ia.reclaimable_gb ? WARN : undefined} />
            <Hero icon={<Layers className="size-3.5" />} label="Redundant pairs" value={ia.redundant_pairs.length}
              tone={ia.redundant_pairs.length ? WARN : GOOD} />
          </div>

          {ia.redundant_pairs.length > 0 && (
            <Section title="Prefix / shadow-redundant index pairs" icon={<Layers className="size-4 text-muted-foreground" />}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="py-1.5 pr-3">Collection</th>
                      <th className="py-1.5 pr-3">Redundant index</th>
                      <th className="py-1.5 pr-3">Covered by</th>
                      <th className="py-1.5 pr-3">Kind</th>
                      <th className="py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ia.redundant_pairs.map((p, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-1.5 pr-3 font-mono text-xs">{p.db}.{p.collection}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs" style={{ color: WARN }}>{p.redundant}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{p.covered_by}</td>
                        <td className="py-1.5 pr-3 text-xs text-muted-foreground">{p.kind.replace("_", " ")}</td>
                        <td className="py-1.5 text-xs">{p.redundant_unused ? <span style={{ color: WARN }}>unused</span> : "in use"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title={`Unused indexes (${ia.drop_list.length}) — drop candidates`} icon={<AlertTriangle className="size-4" style={{ color: WARN }} />}>
              <IndexList
                rows={ia.drop_list.map((d) => ({ name: d.index, ops: d.ops, size_mb: d.size_mb, since: d.since }))}
                emptyText="No unused indexes — clean."
                warnTone
              />
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Usage is cumulative since the last restart (uptime {s.uptime_days}d). Confirm across ALL
                members and exclude unique constraints before dropping.
              </p>
            </Section>
            <Section title="Top accessed indexes" icon={<Gauge className="size-4 text-muted-foreground" />}>
              <IndexList rows={ia.top_accessed.map((d) => ({ name: d.index, ops: d.ops, size_mb: d.size_mb }))} emptyText="—" />
            </Section>
          </div>

          <Section title={`All indexes (${ia.all_indexes.length})`} icon={<ListTree className="size-4 text-muted-foreground" />}>
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-1.5 pr-3">Index</th>
                    <th className="py-1.5 pr-3 text-right">Ops</th>
                    <th className="py-1.5 pr-3 text-right">Size</th>
                    <th className="py-1.5">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {ia.all_indexes.map((r, i) => (
                    <tr key={i} className="border-b border-border/40">
                      <td className="py-1.5 pr-3 font-mono text-xs">{r.db}.{r.collection}.{r.name}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-xs">{r.ops === null ? "—" : fmtCompact(r.ops)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-xs">{fmtBytes(r.size_bytes)}</td>
                      <td className="py-1.5 text-xs">
                        {r.unused && r.name !== "_id_" && <span className="mr-1.5" style={{ color: WARN }}>unused</span>}
                        {r.redundant_of && <span className="mr-1.5" style={{ color: WARN }}>redundant</span>}
                        {r.name === "_id_" && <span className="text-muted-foreground">_id</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </TabsContent>

        {/* ---- OPERATIONS ---- */}
        <TabsContent value="operations" className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">{hc.operations.note}</p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Opcounters (lifetime · per-sec avg)" icon={<Timer className="size-4 text-muted-foreground" />}>
              {Object.entries(hc.operations.opcounters).map(([k, v]) => (
                <KV key={k} k={k} v={`${fmtCompact(v)}  ·  ${hc.operations.opcounters_per_sec[k] ?? "—"}/s`} mono />
              ))}
            </Section>
            <Section title="Document metrics" icon={<Database className="size-4 text-muted-foreground" />}>
              {Object.entries(hc.operations.document).map(([k, v]) => (
                <KV key={k} k={k} v={`${fmtCompact(v)}  ·  ${hc.operations.document_per_sec[k] ?? "—"}/s`} mono />
              ))}
              <Separator className="my-2" />
              <KV k="TTL deleted docs" v={fmtCompact(hc.operations.ttl.deletedDocuments)} mono />
              <KV k="TTL passes" v={fmtCompact(hc.operations.ttl.passes)} mono />
            </Section>
          </div>
        </TabsContent>

        {/* ---- WIREDTIGER ---- */}
        <TabsContent value="wiredtiger" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Object.entries(hc.wiredtiger).map(([gid, g]) => (
              <Section key={gid} title={g.label} icon={<Layers className="size-4 text-muted-foreground" />}
                right={<span className="text-[11px] text-muted-foreground">{fmtCompact(g.total)} ops · tail {pct(g.tail_pct)}</span>}>
                <div className="space-y-1.5">
                  {g.buckets.map((b, i) => {
                    const max = Math.max(...g.buckets.map((x) => x.count), 1);
                    const slow = i >= g.buckets.length - 2 && b.count > 0;
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-28 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{b.label}</span>
                        <div className="h-3 flex-1 overflow-hidden rounded-sm bg-secondary/40">
                          <div className="h-full rounded-sm" style={{ width: `${(100 * b.count) / max}%`, backgroundColor: slow ? WARN : "#4DA6FF" }} />
                        </div>
                        <span className="w-20 shrink-0 text-right font-mono text-[11px]">{fmtCompact(b.count)}</span>
                      </div>
                    );
                  })}
                </div>
              </Section>
            ))}
          </div>
          <Section title="Cache utilization" icon={<MemoryStick className="size-4 text-muted-foreground" />}>
            <KV k="Configured WT cache" v={`${s.wt_cache_gb ?? "—"} GiB`} mono />
            <KV k="Currently in cache" v={`${s.bytes_in_cache_gb ?? "—"} GiB`} mono />
            <KV k="Fill" v={<span style={{ color: (s.cache_fill_pct ?? 0) > 95 ? WARN : GOOD }}>{pct(s.cache_fill_pct)}</span>} />
          </Section>
        </TabsContent>

        {/* ---- HEALTH & SECURITY ---- */}
        <TabsContent value="security" className="mt-4 space-y-4">
          {sec.warnings.length > 0 && (
            <Section title="Posture warnings" icon={<AlertTriangle className="size-4" style={{ color: RISK }} />}>
              <ul className="space-y-2">
                {sec.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: RISK }} />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Security & config" icon={<Lock className="size-4 text-muted-foreground" />}>
              <KV k="Edition" v={sec.edition ?? "—"} />
              <KV k="Bind IP" v={sec.bind_ip ?? "—"} mono />
              <KV k="TLS / SSL" v={sec.tls_mode ?? <span style={{ color: WARN }}>not configured</span>} />
              <KV k="Authorization" v={sec.authorization ?? <span style={{ color: WARN }}>not enabled</span>} />
              <KV k="Cluster auth mode" v={sec.cluster_auth_mode ?? "—"} />
              <KV k="Journal" v={sec.journal_enabled === true ? "enabled" : sec.journal_enabled === false ? "disabled" : "—"} />
              <KV k="dbPath" v={sec.db_path ?? "—"} mono />
            </Section>
            <Section title="Edition feature gaps" icon={<ShieldCheck className="size-4 text-muted-foreground" />}>
              {sec.feature_gaps.length === 0 ? (
                <p className="text-sm text-muted-foreground">No edition feature gaps (Enterprise/Atlas).</p>
              ) : (
                <ul className="space-y-1.5">
                  {sec.feature_gaps.map((g, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <Lock className="mt-0.5 size-3.5 shrink-0" />
                      {g}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
          {sec.launch_arguments && (
            <Section title="Launch arguments" icon={<Server className="size-4 text-muted-foreground" />}>
              <code className="block whitespace-pre-wrap break-all rounded-md bg-secondary/40 p-3 font-mono text-xs">
                {sec.launch_arguments.join(" ")}
              </code>
            </Section>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---- sub-tables ----------------------------------------------------------
function CollectionsTable({ rows }: { rows: HcCollection[] }) {
  const sorted = [...rows].sort((a, b) => (b.data_size || 0) - (a.data_size || 0));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3">Collection</th>
            <th className="py-2 pr-3 text-right">Docs</th>
            <th className="py-2 pr-3 text-right">Avg doc</th>
            <th className="py-2 pr-3 text-right">Data</th>
            <th className="py-2 pr-3 text-right">Storage</th>
            <th className="py-2 pr-3 text-right">Compr.</th>
            <th className="py-2 pr-3 text-right">Idx</th>
            <th className="py-2 pr-3 text-right">Idx size</th>
            <th className="py-2 text-right">Idx/Data</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c, i) => {
            const bigDoc = (c.avg_obj_size ?? 0) >= 10 * 1024;
            const manyIdx = (c.nindexes ?? 0) > 12;
            const highRatio = (c.index_to_data_pct ?? 0) > 50 && (c.data_size ?? 0) > 100 * 1e6;
            return (
              <tr key={i} className="border-b border-border/50">
                <td className="py-2 pr-3 font-mono text-xs">{c.db}.{c.name}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{fmtCompact(c.count)}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs" style={bigDoc ? { color: WARN } : undefined}>
                  {c.avg_obj_size != null ? fmtBytes(c.avg_obj_size) : "—"}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{fmtBytes(c.data_size)}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{fmtBytes(c.storage_size)}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{c.compression_ratio != null ? `${c.compression_ratio}×` : "—"}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs" style={manyIdx ? { color: WARN } : undefined}>{c.nindexes}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{fmtBytes(c.total_index_size)}</td>
                <td className="py-2 text-right font-mono text-xs" style={highRatio ? { color: WARN } : undefined}>
                  {c.index_to_data_pct != null ? `${c.index_to_data_pct}%` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function IndexList({
  rows,
  emptyText,
  warnTone,
}: {
  rows: { name: string; ops: number | null; size_mb: number; since?: number | null }[];
  emptyText: string;
  warnTone?: boolean;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <div className="max-h-72 space-y-1 overflow-auto">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-2 border-b border-border/40 py-1">
          <span className="truncate font-mono text-xs" style={warnTone ? { color: WARN } : undefined} title={r.name}>
            {r.name}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {r.ops === null ? "—" : `${fmtCompact(r.ops)} ops`} · {r.size_mb} MB
          </span>
        </div>
      ))}
    </div>
  );
}
