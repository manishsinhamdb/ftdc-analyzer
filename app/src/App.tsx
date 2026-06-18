import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Activity,
  Compass,
  Cpu,
  Database,
  FolderOpen,
  Gauge,
  HardDrive,
  Loader2,
  MemoryStick,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Server,
  Sparkles,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast, Toaster } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { TimeSeriesChart } from "@/components/TimeSeriesChart";
import { SignalsTable } from "@/components/SignalsTable";
import { RangeSelector } from "@/components/RangeSelector";
import { InsightsStrip } from "@/components/InsightsStrip";
import { SystemView } from "@/components/SystemView";
import { ExploreView } from "@/components/ExploreView";
import { AssessmentPanel } from "@/components/AssessmentPanel";
import { Landing } from "@/components/Landing";

import {
  type Check,
  type ChartSpec,
  type FtdcResults,
  type MetricsFull,
  type Verdict,
  MASTER_SERIES,
  STATUS_COLORS,
  VERDICT_COLORS,
  fmtNum,
  fmtSpan,
} from "@/lib/ftdc";

type View = "overview" | "inference" | "charts" | "signals" | "system" | "explore";

const VERDICT_META: Record<
  string,
  { title: string; icon: ComponentType<{ className?: string }> }
> = {
  ram: { title: "RAM / Cache", icon: MemoryStick },
  cpu: { title: "CPU", icon: Cpu },
  disk: { title: "Disk", icon: HardDrive },
};

const NAV: {
  label: string;
  view: View;
  icon: ComponentType<{ className?: string }>;
  tip: string;
}[] = [
  { label: "Overview", view: "overview", icon: Gauge, tip: "Verdicts, assessment, and headline charts" },
  { label: "Assessment", view: "inference", icon: Sparkles, tip: "Automated first-pass findings and recommendations" },
  { label: "Charts", view: "charts", icon: Activity, tip: "All metric charts grouped by category" },
  { label: "Signals", view: "signals", icon: Database, tip: "Searchable table of every derived signal" },
  { label: "System", view: "system", icon: Server, tip: "Full host build, OS, and mongod config" },
  { label: "Explore", view: "explore", icon: Compass, tip: "Browse and chart any of the 1300+ raw metrics" },
];

const OVERVIEW_CHART_TITLES = [
  "CPU utilization",
  "WiredTiger cache fill",
  "Disk utilization",
];

function findChart(catalog: FtdcResults["chart_catalog"], title: string): ChartSpec | undefined {
  for (const cat of catalog) {
    const c = cat.charts.find((ch) => ch.title === title);
    if (c) return c;
  }
  return undefined;
}

function spansTwoCols(ch: ChartSpec): boolean {
  const t = ch.title.toLowerCase();
  return ch.series.length === 1 && (t.includes("utilization") || t.includes("targeting"));
}

function StatusCell({ status }: { status: Check["status"] }) {
  return (
    <span className="font-semibold" style={{ color: STATUS_COLORS[status] ?? "#8AA0B6" }}>
      {status}
    </span>
  );
}

function VerdictCard({ id, v }: { id: string; v: Verdict }) {
  const meta = VERDICT_META[id];
  const Icon = meta.icon;
  const color = VERDICT_COLORS[v.verdict] ?? "#8AA0B6";
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4 text-muted-foreground" />
            {meta.title}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge className="font-bold tracking-wide" style={{ backgroundColor: color, color: "#0D1B2A" }}>
              {v.verdict}
            </Badge>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {v.confidence}
            </Badge>
          </div>
        </div>
        <CardDescription className="pt-2 leading-snug text-foreground/90">
          {v.headline}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {v.recommended_vcpus != null && (
          <div className="flex items-baseline gap-2 rounded-md bg-secondary/60 px-3 py-2">
            <span className="text-xs text-muted-foreground">recommended vCPUs</span>
            <span className="text-3xl font-extrabold leading-none text-primary">
              {v.recommended_vcpus}
            </span>
          </div>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">{v.recommendation}</p>
        <Separator className="my-1" />
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="h-7 px-2 text-xs">check</TableHead>
              <TableHead className="h-7 px-2 text-right text-xs">value</TableHead>
              <TableHead className="h-7 px-2 text-right text-xs">thr</TableHead>
              <TableHead className="h-7 px-2 text-right text-xs">status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {v.checks.map((c) => (
              <TableRow key={c.name} className="border-border hover:bg-secondary/40">
                <TableCell className="px-2 py-1 text-xs">{c.name}</TableCell>
                <TableCell className="px-2 py-1 text-right font-mono text-xs">{fmtNum(c.value)}</TableCell>
                <TableCell className="px-2 py-1 text-right font-mono text-xs text-muted-foreground">
                  {c.threshold == null ? "n/a" : c.threshold}
                </TableCell>
                <TableCell className="px-2 py-1 text-right text-xs">
                  <StatusCell status={c.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function HwPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

// Read a JSON file from either the bundled public dir (dir===null, via fetch) or
// a live engine-run dir (via the Tauri fs plugin).
async function readJson<T>(dir: string | null, file: string): Promise<T> {
  if (dir === null) {
    const r = await fetch("/" + file);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  }
  const txt = await readTextFile(`${dir}/${file}`);
  return JSON.parse(txt) as T;
}

export default function App() {
  const [data, setData] = useState<FtdcResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [range, setRange] = useState<[number, number] | null>(null);
  const [activeCat, setActiveCat] = useState<string>("");
  const [metricsFull, setMetricsFull] = useState<MetricsFull | null>(null);
  const [mfLoading, setMfLoading] = useState(false);
  // Data source: null dir = bundled demo (public/), else a live engine-run dir.
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // sidebar rail (in-session)

  async function loadFrom(dir: string | null, label: string) {
    const file = dir === null ? "sample_results.json" : "results.json";
    const d = await readJson<FtdcResults>(dir, file);
    setData(d);
    setDataDir(dir);
    setSourceLabel(label);
    setMetricsFull(null); // re-lazy-load from the new source on next Explore open
    setError(null);
  }

  // Privacy-first: do NOT auto-load anything. Just probe whether a local demo
  // sample exists so we can optionally offer it.
  useEffect(() => {
    fetch("/sample_results.json", { method: "HEAD" })
      .then((r) => setDemoAvailable(r.ok))
      .catch(() => setDemoAvailable(false));
  }, []);

  function loadDemo() {
    loadFrom(null, "demo sample")
      .then(() => setView("overview"))
      .catch((e) => toast.error(`Demo unavailable: ${String(e)}`));
  }

  // Lazy-load the full metric catalog the first time Explore opens; cache after.
  useEffect(() => {
    if (view !== "explore" || metricsFull || mfLoading) return;
    setMfLoading(true);
    readJson<MetricsFull>(dataDir, "metrics_full.json")
      .then((d) => setMetricsFull(d))
      .catch((e) => setError(String(e)))
      .finally(() => setMfLoading(false));
  }, [view, metricsFull, mfLoading, dataDir]);

  async function pickFolder() {
    try {
      const sel = await openDialog({
        directory: true,
        multiple: false,
        title: "Select a diagnostic.data folder (or a parent of host folders)",
      });
      if (typeof sel === "string") setSelectedPath(sel);
    } catch (e) {
      toast.error(`Folder picker unavailable: ${String(e)}`);
    }
  }

  async function analyze() {
    if (!selectedPath) {
      toast.error("Pick a folder first.");
      return;
    }
    setAnalyzing(true);
    try {
      const res = await invoke<{ dir: string; hostname: string }>("analyze_path", {
        path: selectedPath,
      });
      await loadFrom(res.dir, `${res.hostname} (live)`);
      setView("overview");
      toast.success(`Analyzed ${res.hostname}`);
    } catch (e) {
      toast.error(`Analysis failed: ${String(e)}`);
    } finally {
      setAnalyzing(false);
    }
  }

  const master = useMemo(() => {
    if (!data) return undefined;
    const m = data.series[MASTER_SERIES];
    if (m?.t?.length) return m;
    return Object.values(data.series).find((s) => s?.t?.length);
  }, [data]);

  const fullRange = useMemo<[number, number]>(() => {
    if (master?.t?.length) return [master.t[0], master.t[master.t.length - 1]];
    return [0, 0];
  }, [master]);

  // Initialise the window to All once data + master are available.
  useEffect(() => {
    if (data && master) setRange(fullRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, master]);

  const effectiveRange = range ?? fullRange;

  // Privacy-first landing: nothing customer-identifying shows until a run loads.
  if (!data) {
    return (
      <>
        <Landing
          selectedPath={selectedPath}
          analyzing={analyzing}
          demoAvailable={demoAvailable}
          error={error}
          onPick={pickFolder}
          onAnalyze={analyze}
          onLoadDemo={loadDemo}
        />
        <Toaster richColors position="bottom-right" theme="dark" />
      </>
    );
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Sidebar (collapsible to an icon rail) */}
      <aside
        className={
          "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex " +
          (collapsed ? "w-14" : "w-60")
        }
      >
        <div className={"flex items-center py-5 " + (collapsed ? "justify-center px-2" : "gap-2 px-5")}>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Database className="size-4" />
          </div>
          {!collapsed && (
            <div className="leading-tight">
              <div className="text-sm font-bold">FTDC Analyzer</div>
              <div className="text-[10px] text-muted-foreground">MongoDB diagnostics</div>
            </div>
          )}
        </div>
        <Separator className="bg-sidebar-border" />
        <nav className="flex flex-col gap-1 p-2">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = view === n.view;
            return (
              <button
                key={n.view}
                onClick={() => setView(n.view)}
                title={collapsed ? n.label : n.tip}
                className={
                  "flex items-center rounded-md text-left text-sm transition-colors " +
                  (collapsed ? "justify-center px-2 py-2.5 " : "gap-2 px-3 py-2 ") +
                  (active
                    ? "bg-sidebar-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50")
                }
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && n.label}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-2 p-2">
          {!collapsed && (
            <div className="px-2 text-[10px] text-muted-foreground">schema v{data.schema_version}</div>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex items-center justify-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50"
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : (
              <>
                <PanelLeftClose className="size-4" /> Collapse
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Source bar — live file picker + analyze + bundled fallback */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-6 py-2.5">
          <Button size="sm" variant="outline" className="h-8 gap-2 text-xs" onClick={pickFolder}
                  disabled={analyzing}
                  title="Choose a diagnostic.data folder (or a parent of host folders) to analyze">
            <FolderOpen className="size-4" /> Open FTDC data…
          </Button>
          <span className="max-w-[34ch] truncate font-mono text-xs text-muted-foreground"
                title={selectedPath ?? ""}>
            {selectedPath ?? "no folder selected"}
          </span>
          <Button size="sm" className="h-8 gap-2 text-xs" onClick={analyze}
                  disabled={analyzing || !selectedPath}
                  title="Run the local engine on the selected folder (no upload)">
            {analyzing ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {analyzing ? "Analyzing…" : "Analyze"}
          </Button>
          {analyzing && (
            <span className="text-xs text-muted-foreground">
              running engine — ~1–2 min for multi-day captures
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              source: <span className="font-medium text-foreground">{sourceLabel}</span>
            </span>
            {dataDir && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                disabled={analyzing}
                title="Reveal the self-contained HTML report for this run in Finder"
                onClick={() =>
                  revealItemInDir(`${dataDir}/report.html`).catch((e) =>
                    toast.error(`Export failed: ${String(e)}`),
                  )
                }
              >
                Export HTML
              </Button>
            )}
            {demoAvailable && (
              <Button size="sm" variant="ghost" className="h-8 text-xs"
                      onClick={loadDemo} disabled={analyzing}>
                Load demo sample
              </Button>
            )}
          </div>
        </div>
        {/* Topbar */}
        <header className="border-b border-border bg-card/60 px-6 py-4">
          {data ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <h1 className="text-xl font-bold">{data.host.hostname}</h1>
              <Badge style={{ backgroundColor: "#5A6E82", color: "#E6EDF3" }}>{data.host.role}</Badge>
              <span className="text-sm text-muted-foreground">MongoDB {data.host.mongo_version}</span>
              <span className="text-sm text-muted-foreground">
                {data.capture.first_ts_iso?.replace("+00:00", "Z")} →{" "}
                {data.capture.last_ts_iso?.replace("+00:00", "Z")}
              </span>
              <span className="text-sm text-muted-foreground">
                · {fmtSpan(data.capture.span_seconds)} · {data.capture.samples.toLocaleString("en-US")} samples
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <HwPill>{data.host.num_cores} cores</HwPill>
                <HwPill>{((data.host.mem_mb ?? 0) / 1024).toFixed(1)} GB RAM</HwPill>
                <HwPill>data disk: {data.host.data_disk}</HwPill>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {error ? `Failed to load data: ${error}` : "Loading…"}
            </div>
          )}
        </header>

        {/* Content */}
        <main className="flex-1 space-y-5 overflow-auto p-6">
          {data && view === "overview" && (
            <>
              <div className="sticky top-0 z-20 -mx-6 -mt-6 mb-1 bg-background/80 px-6 pb-1 pt-6 backdrop-blur">
                <RangeSelector
                  capture={data.capture}
                  masterSeries={master}
                  value={effectiveRange}
                  onChange={setRange}
                />
              </div>

              {data.assessment && (
                <AssessmentPanel
                  assessment={data.assessment}
                  costOptimization={data.cost_optimization}
                />
              )}

              <InsightsStrip insights={data.insights} />

              <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <VerdictCard id="ram" v={data.verdicts.ram} />
                <VerdictCard id="cpu" v={data.verdicts.cpu} />
                <VerdictCard id="disk" v={data.verdicts.disk} />
              </section>

              <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {OVERVIEW_CHART_TITLES.map((title) => {
                  const spec = findChart(data.chart_catalog, title);
                  return spec ? (
                    <TimeSeriesChart
                      key={title}
                      spec={spec}
                      series={data.series}
                      range={effectiveRange}
                      className={spansTwoCols(spec) ? "xl:col-span-2" : undefined}
                    />
                  ) : null;
                })}
              </section>
            </>
          )}

          {data && view === "charts" && (
            <Tabs
              value={activeCat || data.chart_catalog[0]?.category || ""}
              onValueChange={setActiveCat}
            >
              {/* Category tabs are the primary control: prominent, full-width, sticky,
                  above the slim range strip. */}
              <div className="sticky top-0 z-20 -mx-6 -mt-6 space-y-2 border-b border-border bg-background/95 px-6 pb-2 pt-6 backdrop-blur">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Category
                </div>
                <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-card p-1">
                  {data.chart_catalog.map((cat) => (
                    <TabsTrigger
                      key={cat.category}
                      value={cat.category}
                      className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                    >
                      {cat.category}
                      <span className="ml-1 opacity-70">({cat.charts.length})</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
                <RangeSelector
                  capture={data.capture}
                  masterSeries={master}
                  value={effectiveRange}
                  onChange={setRange}
                />
              </div>

              {data.chart_catalog.map((cat) => (
                <TabsContent key={cat.category} value={cat.category} className="mt-4">
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    {cat.charts.map((ch) => (
                      <TimeSeriesChart
                        key={ch.title}
                        spec={ch}
                        series={data.series}
                        range={effectiveRange}
                        className={spansTwoCols(ch) ? "xl:col-span-2" : undefined}
                      />
                    ))}
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          )}

          {data && view === "inference" && data.assessment && (
            <AssessmentPanel
              assessment={data.assessment}
              costOptimization={data.cost_optimization}
            />
          )}

          {data && view === "signals" && <SignalsTable signals={data.signals} />}

          {data && view === "system" && <SystemView facts={data.facts} />}

          {data && view === "explore" && (
            <ExploreView
              metricsFull={metricsFull}
              loading={mfLoading}
              capture={data.capture}
              master={master}
              range={effectiveRange}
              setRange={setRange}
            />
          )}
        </main>
      </div>
      <Toaster richColors position="bottom-right" theme="dark" />
    </div>
  );
}
