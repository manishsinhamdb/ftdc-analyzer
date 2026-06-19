import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Activity,
  ChevronDown,
  Compass,
  Cpu,
  Database,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  Home,
  Loader2,
  MemoryStick,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Server,
  Settings2,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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
import { Checkbox } from "@/components/ui/checkbox";
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

import { TimeSeriesChart, ChartPlaceholder } from "@/components/TimeSeriesChart";
import { SignalsTable, type Thresholds } from "@/components/SignalsTable";
import { RangeSelector } from "@/components/RangeSelector";
import { InsightsStrip } from "@/components/InsightsStrip";
import { SystemView } from "@/components/SystemView";
import { ExploreView } from "@/components/ExploreView";
import { AssessmentPanel } from "@/components/AssessmentPanel";
import { AssessmentV2Panel } from "@/components/AssessmentV2Panel";
import { SizingPanel } from "@/components/SizingPanel";
import { resizeFromCache } from "@/lib/sizing";
import { MethodologyRules } from "@/components/MethodologyRules";
import { type AssessmentMode } from "@/components/AssessmentControls";
import { relensAssessment, mergeIntents, cachedRulesetDump } from "@/lib/ruleset";
import { getLlmConfig, setLlmConfig } from "@/lib/llm";
import {
  type Baseline,
  type Selections,
  classifyRun,
  loadRunSnapshot,
  saveRunSnapshot,
  deleteRunSnapshot,
} from "@/lib/preflight";
import { Landing } from "@/components/Landing";
import { LlmSettings } from "@/components/LlmSettings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  type Check,
  type ChartSpec,
  type FtdcResults,
  type MetricsFull,
  type RunHistoryEntry,
  type Verdict,
  MASTER_SERIES,
  STATUS_COLORS,
  VERDICT_COLORS,
  DEFAULT_GRANULARITY,
  fmtNum,
  fmtSpan,
  historyEntryLabels,
} from "@/lib/ftdc";

type View = "overview" | "inference" | "charts" | "signals" | "system" | "explore" | "methodology";

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
  { label: "Overview", view: "overview", icon: Gauge, tip: "Unbiased results: verdicts, insight chips, headline charts" },
  { label: "Charts", view: "charts", icon: Activity, tip: "All metric charts grouped by category" },
  { label: "Signals", view: "signals", icon: Database, tip: "Searchable table of every derived signal" },
  { label: "System", view: "system", icon: Server, tip: "Full host build, OS, and mongod config" },
  { label: "Explore", view: "explore", icon: Compass, tip: "Browse and chart any of the 1300+ raw metrics" },
  { label: "Methodology", view: "methodology", icon: SlidersHorizontal, tip: "View & tune the scoring ruleset: categories, signals, conditioning" },
  { label: "Assessment", view: "inference", icon: Sparkles, tip: "Opt-in automated first-pass findings and recommendations" },
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

// Build {signal: {p95?, p99?}} threshold map from the verdict checks so the Signals
// table can flag percentile values that breach known thresholds.
function buildThresholds(verdicts: FtdcResults["verdicts"]): Thresholds {
  const m: Thresholds = {};
  for (const key of ["ram", "cpu", "disk"] as const) {
    for (const chk of verdicts[key].checks) {
      if (chk.threshold == null) continue;
      const dot = chk.name.lastIndexOf(".");
      if (dot < 0) continue;
      const sig = chk.name.slice(0, dot);
      const stat = chk.name.slice(dot + 1);
      if (stat === "p95" || stat === "p99") {
        (m[sig] ??= {})[stat] = chk.threshold;
      }
    }
  }
  return m;
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

// Read a JSON file from a live engine-run dir (via the Tauri fs plugin).
async function readJson<T>(dir: string, file: string): Promise<T> {
  const txt = await readTextFile(`${dir}/${file}`);
  return JSON.parse(txt) as T;
}

export default function App() {
  const [data, setData] = useState<FtdcResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [range, setRange] = useState<[number, number] | null>(null);
  const [granularity, setGranularity] = useState<number>(DEFAULT_GRANULARITY);
  const [activeCat, setActiveCat] = useState<string>("");
  const [metricsFull, setMetricsFull] = useState<MetricsFull | null>(null);
  const [mfLoading, setMfLoading] = useState(false);
  // Data source: the live engine-run dir for the loaded run (null = nothing loaded).
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [username, setUsername] = useState<string>("");
  // Sidebar rail. Persisted to localStorage so the choice survives navigation,
  // returning to the landing screen, and app relaunch.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("ftdc.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const [llmOpen, setLlmOpen] = useState(false); // LLM Settings modal
  // Opt-in gate for the Automated Assessment. Default OFF so the default view is
  // unbiased. HOOK POINT: when wired, flipping this on should trigger the future
  // local-LLM assessment run (today it just reveals the deterministic pass).
  const [generateAssessment, setGenerateAssessment] = useState<boolean>(() => {
    try {
      return localStorage.getItem("ftdc.generateAssessment") === "1";
    } catch {
      return false;
    }
  });
  // Assessment mode (grounded ledger vs LLM-reasoned narrative) + targeted category —
  // chosen on the landing screen and the Assessment tab, persisted across runs.
  const [assessmentMode, setAssessmentMode] = useState<AssessmentMode>(() => {
    try {
      return (localStorage.getItem("ftdc.assessmentMode") as AssessmentMode) || "grounded";
    } catch {
      return "grounded";
    }
  });
  const [targetCategory, setTargetCategory] = useState<string | null>(() => {
    try {
      return localStorage.getItem("ftdc.targetCategory") || null;
    } catch {
      return null;
    }
  });
  // Pre-flight intake: assessment intent (lens) + optional input file paths.
  const [intent, setIntent] = useState<string>(() => {
    try {
      return localStorage.getItem("ftdc.intent") || "full_sweep";
    } catch {
      return "full_sweep";
    }
  });
  const [healthcheckPath, setHealthcheckPath] = useState<string | null>(null);
  const [profilerPath, setProfilerPath] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null); // LLM model for narration
  const [cloud, setCloud] = useState<string>(() => {
    try {
      return localStorage.getItem("ftdc.cloud") || "aws";
    } catch {
      return "aws";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("ftdc.generateAssessment", generateAssessment ? "1" : "0");
      localStorage.setItem("ftdc.assessmentMode", assessmentMode);
      localStorage.setItem("ftdc.intent", intent);
      localStorage.setItem("ftdc.cloud", cloud);
      if (targetCategory) localStorage.setItem("ftdc.targetCategory", targetCategory);
      else localStorage.removeItem("ftdc.targetCategory");
    } catch {
      /* persistence best-effort */
    }
  }, [generateAssessment, assessmentMode, targetCategory, intent, cloud]);

  async function loadFrom(dir: string, label: string): Promise<FtdcResults> {
    const d = await readJson<FtdcResults>(dir, "results.json");
    setData(d);
    setDataDir(dir);
    setSourceLabel(label);
    setMetricsFull(null); // re-lazy-load from the new source on next Explore open
    setError(null);
    return d;
  }

  // Privacy-first: nothing is auto-loaded. Only fetch the username + run history.
  useEffect(() => {
    invoke<RunHistoryEntry[]>("list_history")
      .then((h) => setHistory(h))
      .catch(() => setHistory([]));
    invoke<string>("get_username")
      .then((u) => setUsername(u))
      .catch(() => setUsername(""));
    // Prefetch the ruleset dump (single shared cache) so the wizard Step-2 intent
    // selector paints instantly instead of spawning the engine on entry.
    cachedRulesetDump().catch(() => {});
  }, []);

  // Persist the sidebar collapsed choice across relaunches.
  useEffect(() => {
    try {
      localStorage.setItem("ftdc.sidebarCollapsed", collapsed ? "1" : "0");
    } catch {
      /* localStorage unavailable — fall back to in-session only */
    }
  }, [collapsed]);

  // The sidebar width animates (200ms). Recharts' ResponsiveContainer measures its
  // own box, so nudge it to re-measure the now-wider/narrower content area across the
  // transition — otherwise charts only repaint on a real window resize.
  useEffect(() => {
    const tick = () => window.dispatchEvent(new Event("resize"));
    const id = window.setInterval(tick, 50);
    const stop = window.setTimeout(() => window.clearInterval(id), 300);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, [collapsed]);

  function loadHistoryEntry(entry: RunHistoryEntry) {
    loadFrom(entry.cache_dir, `${entry.hostname} (history)`)
      .then(() => setView("overview"))
      .catch((e) =>
        toast.error(`Could not load cached run (it may have been cleared): ${String(e)}`),
      );
  }

  // Home / "New analysis": clear the loaded run and return to the landing screen.
  function goHome() {
    setData(null);
    setDataDir(null);
    setMetricsFull(null);
    setView("overview");
    setError(null);
  }

  // Export HTML -> user-chosen Save location (no writes to the app folder).
  async function exportReport() {
    if (!dataDir) return;
    try {
      const host = data?.host.hostname ?? "ftdc";
      const dest = await saveDialog({
        defaultPath: `${host}-ftdc-report.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!dest) return; // user cancelled
      await invoke("save_report", { src: `${dataDir}/report.html`, dest });
      toast.success("Report saved");
      revealItemInDir(dest).catch(() => {});
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    }
  }

  // Lazy-load the full metric catalog the first time Explore opens; cache after.
  useEffect(() => {
    if (view !== "explore" || metricsFull || mfLoading || !dataDir) return;
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

  // Optional intake files — path recorded for the future parser; not scored yet.
  async function pickFile(title: string, setter: (p: string) => void) {
    try {
      const sel = await openDialog({ directory: false, multiple: false, title });
      if (typeof sel === "string") setter(sel);
    } catch (e) {
      toast.error(`File picker unavailable: ${String(e)}`);
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
        targetCategory: targetCategory,
        intent: intent,
        healthcheck: healthcheckPath,
        profiler: profilerPath,
        cloud: cloud,
      });
      // The pre-flight configured an assessment intent + mode → opt in to the panel.
      setGenerateAssessment(true);
      const loaded = await loadFrom(res.dir, `${res.hostname} (live)`);
      setView("overview");
      toast.success(`Analyzed ${res.hostname}`);
      const entry: RunHistoryEntry = {
        hostname: res.hostname,
        timestamp: new Date().toISOString(),
        source_path: selectedPath,
        cache_dir: res.dir,
        role: loaded.host.cluster_role ?? loaded.host.role ?? null,
        first_ts: loaded.capture.first_ts_iso,
        last_ts: loaded.capture.last_ts_iso,
      };
      invoke<RunHistoryEntry[]>("record_run", { entry })
        .then((h) => setHistory(h))
        .catch(() => {});
      // Persist the full selection snapshot so this run can be re-opened on Review
      // prefilled, and the right run action computed (change-detection).
      saveRunSnapshot(res.dir, res.hostname, {
        ftdc: selectedPath,
        intent,
        mode: assessmentMode,
        model,
        healthcheck: healthcheckPath,
        profiler: profilerPath,
        cloud,
      });
    } catch (e) {
      toast.error(`Analysis failed: ${String(e)}`);
    } finally {
      setAnalyzing(false);
    }
  }

  // Open a cached run's results.json; optionally re-lens its assessment for a new intent
  // (the "re-run from cached decode" path — no FTDC re-decode).
  async function openCachedRun(dir: string, label: string, relensIntentId?: string) {
    try {
      const d = await readJson<FtdcResults>(dir, "results.json");
      if (relensIntentId && d.assessment_v2) {
        const rs = await cachedRulesetDump();
        const ids = relensIntentId.split(",").filter(Boolean);
        const merged = mergeIntents(rs.intents.filter((i) => ids.includes(i.id)));
        if (merged) relensAssessment(d.assessment_v2, merged);
      }
      // Re-run path: recompute sizing for the current cloud/intent from the cached
      // decode (no FTDC re-decode), keeping sizing authoritative in the engine.
      if (relensIntentId !== undefined) {
        try {
          d.sizing_recommendation = await resizeFromCache(`${dir}/results.json`, cloud, intent);
        } catch {
          /* keep cached sizing if resize fails */
        }
      }
      setData(d);
      setDataDir(dir);
      setSourceLabel(label);
      setMetricsFull(null);
      setError(null);
      setGenerateAssessment(true);
      setView("overview");
    } catch (e) {
      toast.error(`Could not open cached run (it may have been cleared): ${String(e)}`);
    }
  }

  // Review "Run" — executes open / re-run / re-analyze per change-detection vs baseline.
  async function runFromReview(baseline: Baseline | null) {
    const cur: Selections = {
      ftdc: selectedPath,
      intent,
      mode: assessmentMode,
      model,
      healthcheck: healthcheckPath,
      profiler: profilerPath,
      cloud,
    };
    const plan = classifyRun(baseline, cur);
    setGenerateAssessment(true);
    if (plan.action === "reanalyze" || !baseline) {
      await analyze();
    } else {
      await openCachedRun(
        baseline.cache_dir,
        `${baseline.hostname} (cached)`,
        plan.action === "rerun" ? intent : undefined,
      );
    }
  }

  // Recent → prefill all selections from the run's snapshot and return the baseline.
  function selectRecent(entry: RunHistoryEntry): Baseline {
    const snap = loadRunSnapshot(entry.cache_dir);
    const baseline: Baseline = {
      ftdc: entry.source_path,
      intent: snap?.intent ?? "full_sweep",
      mode: (snap?.mode as AssessmentMode) ?? "grounded",
      model: snap?.model ?? null,
      healthcheck: snap?.healthcheck ?? null,
      profiler: snap?.profiler ?? null,
      cloud: snap?.cloud ?? "aws",
      cache_dir: entry.cache_dir,
      hostname: entry.hostname,
    };
    setSelectedPath(baseline.ftdc);
    setIntent(baseline.intent);
    setAssessmentMode(baseline.mode);
    setHealthcheckPath(baseline.healthcheck);
    setProfilerPath(baseline.profiler);
    setModel(baseline.model);
    setCloud(baseline.cloud);
    if (baseline.model) {
      getLlmConfig()
        .then((c) => setLlmConfig({ ...c, model: baseline.model }))
        .catch(() => {});
    }
    return baseline;
  }

  function deleteHistoryEntry(cacheDir: string) {
    invoke<RunHistoryEntry[]>("delete_history_entry", { cacheDir })
      .then((h) => setHistory(h))
      .catch((e) => toast.error(`Could not delete: ${String(e)}`));
    deleteRunSnapshot(cacheDir);
  }

  function clearAllHistory() {
    history.forEach((h) => deleteRunSnapshot(h.cache_dir));
    invoke<RunHistoryEntry[]>("clear_history")
      .then((h) => setHistory(h))
      .catch((e) => toast.error(`Could not clear history: ${String(e)}`));
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
          username={username}
          analyzing={analyzing}
          error={error}
          selectedPath={selectedPath}
          onPick={pickFolder}
          healthcheckPath={healthcheckPath}
          onPickHealthcheck={() =>
            pickFile("Select a healthcheck snapshot (getMongoData.js output)", setHealthcheckPath)
          }
          onClearHealthcheck={() => setHealthcheckPath(null)}
          profilerPath={profilerPath}
          onPickProfiler={() =>
            pickFile("Select a profiler / slow-query log file", setProfilerPath)
          }
          onClearProfiler={() => setProfilerPath(null)}
          intent={intent}
          onIntentChange={setIntent}
          cloud={cloud}
          onCloudChange={setCloud}
          assessmentMode={assessmentMode}
          onAssessmentModeChange={setAssessmentMode}
          model={model}
          onModelChange={setModel}
          onRun={runFromReview}
          history={history}
          onSelectRecent={selectRecent}
          onDeleteEntry={deleteHistoryEntry}
          onClearHistory={clearAllHistory}
          onOpenLlmSettings={() => setLlmOpen(true)}
        />
        <LlmSettings open={llmOpen} onOpenChange={setLlmOpen} />
        <Toaster richColors position="bottom-right" theme="dark" />
      </>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar (collapsible to an icon rail) — fixed full height, never scrolls with content */}
      <aside
        className={
          "hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-in-out md:flex " +
          (collapsed ? "w-14" : "w-60")
        }
      >
        <button
          onClick={goHome}
          title="New analysis — back to the start screen"
          className={
            "flex items-center py-5 transition-colors hover:bg-sidebar-accent/40 " +
            (collapsed ? "justify-center px-2" : "gap-2 px-5")
          }
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Database className="size-4" />
          </div>
          {!collapsed && (
            <div className="text-left leading-tight">
              <div className="text-sm font-bold">FTDC Analyzer</div>
              <div className="text-[10px] text-muted-foreground">MongoDB diagnostics</div>
            </div>
          )}
        </button>
        <Separator className="bg-sidebar-border" />
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
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
            onClick={() => setLlmOpen(true)}
            title="LLM Settings — configure the model provider"
            aria-label="LLM Settings"
            className={
              "flex items-center rounded-md text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground " +
              (collapsed ? "justify-center px-2 py-2" : "justify-start gap-2 px-3 py-2")
            }
          >
            <Settings2 className="size-4 shrink-0" />
            {!collapsed && "LLM Settings"}
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={
              "flex items-center rounded-md border border-sidebar-border text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground " +
              (collapsed ? "justify-center px-2 py-2" : "justify-start gap-2 px-3 py-2")
            }
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
        {/* Source bar — live file picker + analyze + history + fallback */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-6 py-2.5">
          <Button size="sm" variant="ghost" className="h-8 gap-2 text-xs" onClick={goHome}
                  disabled={analyzing} title="Start a new analysis (back to the start screen)">
            <Home className="size-4" /> New analysis
          </Button>
          <Separator orientation="vertical" className="h-5" />
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
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground"
                 title="Off by default for an unbiased view. Generates the Automated Assessment (deterministic today; the hook point for a future local-LLM pass).">
            <Checkbox
              checked={generateAssessment}
              onCheckedChange={(c) => setGenerateAssessment(c === true)}
            />
            Generate assessment
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-8 gap-1 text-xs"
                      disabled={analyzing} title="Revisit a previously analyzed run">
                <History className="size-4" /> History
                {history.length > 0 && (
                  <span className="ml-0.5 opacity-70">({history.length})</span>
                )}
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-80 overflow-y-auto">
              <DropdownMenuLabel>Past runs (local cache)</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {history.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  No past runs yet. Analyze a folder to build history.
                </div>
              ) : (
                history.map((e) => {
                  const lbl = historyEntryLabels(e);
                  return (
                    <DropdownMenuItem
                      key={e.cache_dir}
                      onClick={() => loadHistoryEntry(e)}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="text-xs font-medium">{lbl.title}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {lbl.range ? `${lbl.range} · ` : ""}{lbl.when}
                      </span>
                    </DropdownMenuItem>
                  );
                })
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
                title="Save the self-contained HTML report to a folder you choose"
                onClick={exportReport}
              >
                Export HTML
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
              <div className="sticky top-0 z-30 -mx-6 -mt-6 mb-4 border-b border-border bg-background px-6 pb-3 pt-6">
                <RangeSelector
                  capture={data.capture}
                  value={effectiveRange}
                  onChange={setRange}
                  granularity={granularity}
                  onGranularityChange={setGranularity}
                />
              </div>

              {/* Overview is intentionally unbiased: verdicts, insight chips, and
                  headline charts only. The Automated Assessment lives on its own tab,
                  opt-in via the "Generate assessment" toggle. */}
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
                      granularity={granularity}
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
                  value={effectiveRange}
                  onChange={setRange}
                  granularity={granularity}
                  onGranularityChange={setGranularity}
                />
              </div>

              {data.chart_catalog.map((cat) => (
                <TabsContent key={cat.category} value={cat.category} className="mt-4">
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    {cat.charts.map((ch) => {
                      const cls = spansTwoCols(ch) ? "xl:col-span-2" : undefined;
                      return ch.data_state && ch.data_state !== "present" ? (
                        <ChartPlaceholder key={ch.title} spec={ch} className={cls} />
                      ) : (
                        <TimeSeriesChart
                          key={ch.title}
                          spec={ch}
                          series={data.series}
                          range={effectiveRange}
                          granularity={granularity}
                          className={cls}
                        />
                      );
                    })}
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          )}

          {data && view === "methodology" && <MethodologyRules />}

          {data && view === "inference" && (
            generateAssessment && data.assessment ? (
              <div className="space-y-4">
                {data.sizing_recommendation?.applies_to_intent && (
                  <SizingPanel sizing={data.sizing_recommendation} />
                )}
                {data.assessment_v2 && (
                  <AssessmentV2Panel
                    v2={data.assessment_v2}
                    mode={assessmentMode}
                    onModeChange={setAssessmentMode}
                    targetCategory={targetCategory}
                    onTargetCategoryChange={setTargetCategory}
                    sizing={data.sizing_recommendation}
                  />
                )}
                <AssessmentPanel
                  assessment={data.assessment}
                  costOptimization={data.cost_optimization}
                />
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
                  <Sparkles className="size-8 text-muted-foreground/60" />
                  <div className="max-w-md space-y-1">
                    <div className="text-base font-semibold">Automated Assessment is off</div>
                    <p className="text-sm text-muted-foreground">
                      A deterministic first pass turns combinatorial signals into named findings
                      and recommendations. It's opt-in so the default view stays unbiased.
                    </p>
                  </div>
                  <Button className="gap-2" onClick={() => setGenerateAssessment(true)}>
                    <Sparkles className="size-4" /> Generate assessment
                  </Button>
                </CardContent>
              </Card>
            )
          )}

          {data && view === "signals" && (
            <SignalsTable
              signals={data.signals}
              series={data.series}
              range={effectiveRange}
              thresholds={buildThresholds(data.verdicts)}
            />
          )}

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
      <LlmSettings open={llmOpen} onOpenChange={setLlmOpen} />
      <Toaster richColors position="bottom-right" theme="dark" />
    </div>
  );
}
