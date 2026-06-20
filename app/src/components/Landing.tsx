import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  HelpCircle,
  History,
  Loader2,
  Pencil,
  Play,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { type RunHistoryEntry, historyEntryLabels } from "@/lib/ftdc";
import {
  type IntentDef,
  type InputRegistryEntry,
  cachedInputRegistry,
  cachedRulesetDump,
} from "@/lib/ruleset";
import { type AssessmentMode, IntentPicker, ModelPicker } from "@/components/AssessmentControls";
import { RegistryCollectorHelp } from "@/components/CollectorHelp";
import { type Baseline, classifyRun } from "@/lib/preflight";
import { CLOUDS } from "@/lib/sizing";

const SIZING_INTENTS = new Set(["right_sizing", "cost_optimization"]);

interface Props {
  username: string;
  analyzing: boolean;
  error: string | null;
  inputValues: Record<string, string | null>;
  onPickInput: (id: string, label: string) => void;
  onClearInput: (id: string) => void;
  intent: string | null;
  onIntentChange: (id: string) => void;
  cloud: string;
  onCloudChange: (c: string) => void;
  assessmentMode: AssessmentMode;
  onAssessmentModeChange: (m: AssessmentMode) => void;
  model: string | null;
  onModelChange: (m: string) => void;
  onRun: (baseline: Baseline | null) => void;
  history: RunHistoryEntry[];
  onSelectRecent: (entry: RunHistoryEntry) => Baseline;
  onDeleteEntry: (cacheDir: string) => void;
  onClearHistory: () => void;
  onOpenLlmSettings?: () => void;
}

type Phase = "entry" | "recent" | "wizard";
const STEPS = ["Inputs", "Intent", "Mode", "Review"] as const;

function InputSlot({
  icon,
  title,
  badge,
  path,
  unlocks,
  onPick,
  onClear,
  help,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: "primary" | "optional";
  path: string | null;
  unlocks?: string;
  onPick: () => void;
  onClear?: () => void;
  help?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const present = !!path;
  return (
    <div className={"rounded-lg border p-3 transition-colors " + (present ? "border-primary/40 bg-primary/5" : "border-border bg-card")}>
      <div className="flex items-center gap-2">
        <span className={present ? "text-primary" : "text-muted-foreground"}>{icon}</span>
        <span className="text-sm font-medium">{title}</span>
        <span
          className={
            "rounded px-1.5 text-[9px] uppercase " +
            (badge === "primary"
              ? "bg-primary/15 text-primary"
              : "bg-secondary/60 text-muted-foreground")
          }
        >
          {badge === "primary" ? "primary" : "optional"}
        </span>
        {present && <Check className="ml-auto size-4 text-primary" />}
      </div>
      {unlocks && !present && <p className="mt-1 pl-6 text-[11px] leading-snug text-muted-foreground">{unlocks}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <Button size="sm" variant={present ? "ghost" : "outline"} className="h-7 gap-1.5 text-xs" onClick={onPick}>
          <FolderOpen className="size-3.5" /> {present ? "Change" : "Choose"}
        </Button>
        {present && (
          <>
            <span className="max-w-[40ch] truncate font-mono text-[11px] text-muted-foreground" title={path ?? ""}>
              {path}
            </span>
            {onClear && (
              <button onClick={onClear} title="Remove" className="text-muted-foreground hover:text-destructive">
                <X className="size-3.5" />
              </button>
            )}
          </>
        )}
        {help && !present && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="ml-auto flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            <HelpCircle className="size-3.5" /> Don't have this? Get it
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
      </div>
      {help && open && !present && <div className="mt-2 pl-6">{help}</div>}
    </div>
  );
}

function Progress({ step, onJump }: { step: number; onJump: (s: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <div key={label} className="flex items-center gap-2">
            <button
              onClick={() => onJump(n)}
              disabled={n > step}
              className={
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors " +
                (active
                  ? "bg-primary text-primary-foreground"
                  : done
                    ? "text-primary hover:bg-secondary/50"
                    : "text-muted-foreground")
              }
            >
              <span
                className={
                  "flex size-4 items-center justify-center rounded-full text-[9px] " +
                  (active ? "bg-primary-foreground/20" : done ? "bg-primary/20" : "bg-secondary")
                }
              >
                {done ? <Check className="size-2.5" /> : n}
              </span>
              {label}
            </button>
            {i < STEPS.length - 1 && <span className="h-px w-4 bg-border" />}
          </div>
        );
      })}
    </div>
  );
}

function SummaryRow({
  label,
  value,
  muted,
  onEdit,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={"truncate text-sm " + (muted ? "text-muted-foreground" : "font-medium")}>{value}</div>
      </div>
      <button onClick={onEdit} className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary hover:underline">
        <Pencil className="size-3" /> Edit
      </button>
    </div>
  );
}

export function Landing(props: Props) {
  const {
    username,
    analyzing,
    error,
    inputValues,
    onPickInput,
    onClearInput,
    intent,
    onIntentChange,
    cloud,
    onCloudChange,
    assessmentMode,
    onAssessmentModeChange,
    model,
    onModelChange,
    onRun,
    history,
    onSelectRecent,
    onDeleteEntry,
    onClearHistory,
    onOpenLlmSettings,
  } = props;

  const [phase, setPhase] = useState<Phase>("entry");
  const [step, setStep] = useState(1);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [intents, setIntents] = useState<IntentDef[]>([]);
  const [inputReg, setInputReg] = useState<InputRegistryEntry[]>([]);

  useEffect(() => {
    cachedRulesetDump()
      .then((rs) => setIntents(rs.intents))
      .catch(() => {});
    cachedInputRegistry()
      .then((r) => r && setInputReg(r.inputs))
      .catch(() => {});
  }, []);

  // Read current input paths from the registry-keyed value map.
  const selectedPath = inputValues.ftdc ?? null;
  const healthcheckPath = inputValues.healthcheck ?? null;
  const primaryInputs = inputReg.filter((e) => e.primary);
  const evidenceInputs = inputReg.filter((e) => !e.primary);

  // Inputs actually provided drive the intent lock-flags (a category's "awaiting input" names
  // the specific registry input that unlocks it).
  const provided = new Set<string>();
  for (const e of inputReg) if (inputValues[e.id]) provided.add(e.id);

  // Co-primary: at least one PRIMARY input enables the run.
  const hasAnyInput = primaryInputs.length
    ? primaryInputs.some((e) => inputValues[e.id])
    : !!selectedPath || !!healthcheckPath;
  const canNext = step === 1 ? hasAnyInput : step === 2 ? !!intent : true;
  const plan = classifyRun(phase === "wizard" && baseline ? baseline : null, {
    ftdc: selectedPath,
    intent: intent ?? "full_sweep",
    mode: assessmentMode,
    model,
    healthcheck: healthcheckPath,
    profiler: inputValues.profiler ?? null,
    cloud,
    sh_status: inputValues.sh_status ?? null,
    rs_status: inputValues.rs_status ?? null,
  });
  const intentIds = (intent ?? "").split(",").filter(Boolean);
  const selectedIntents = intentIds
    .map((id) => intents.find((i) => i.id === id))
    .filter(Boolean) as IntentDef[];
  const sizingIntent = intentIds.some((id) => SIZING_INTENTS.has(id));

  // Keyboard: Enter advances when valid (Run on Review).
  useEffect(() => {
    if (phase !== "wizard") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "SELECT" || tag === "INPUT") return;
      if (step < 4 && canNext) setStep((s) => s + 1);
      else if (step === 4 && !analyzing) onRun(baseline);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, step, canNext, analyzing, baseline, onRun]);

  function startNew() {
    setBaseline(null);
    setStep(1);
    setPhase("wizard");
  }

  function openRecent(entry: RunHistoryEntry) {
    const b = onSelectRecent(entry);
    setBaseline(b);
    setStep(4);
    setPhase("wizard");
  }

  const Header = (
    <div className="space-y-2 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Database className="size-6" />
      </div>
      {username && <p className="text-sm font-medium text-primary">Hi {username} :)</p>}
      <h1 className="text-2xl font-bold">FTDC Analyzer</h1>
    </div>
  );

  return (
    <div className="relative min-h-screen overflow-y-auto bg-background p-6 text-foreground">
      {onOpenLlmSettings && (
        <button
          onClick={onOpenLlmSettings}
          title="LLM Settings"
          className="absolute right-4 top-4 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        >
          <Settings2 className="size-4" /> LLM
        </button>
      )}

      <div className="mx-auto w-full max-w-2xl space-y-6 py-8">
        {/* ENTRY */}
        {phase === "entry" && (
          <div className="space-y-6 duration-200 animate-in fade-in">
            {Header}
            <p className="mx-auto max-w-md text-center text-sm text-muted-foreground">
              Analyze a MongoDB diagnostic.data capture — 100% local. Start a new guided analysis,
              or reopen a recent one.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                onClick={startNew}
                className="group rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
              >
                <Play className="size-6 text-primary" />
                <div className="mt-2 text-base font-semibold">New analysis</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Declare inputs, pick an intent and reasoning mode, then run.
                </p>
              </button>
              <button
                onClick={() => setPhase("recent")}
                disabled={history.length === 0}
                className="group rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <History className="size-6 text-primary" />
                <div className="mt-2 text-base font-semibold">
                  Recent analyses {history.length > 0 && <span className="text-muted-foreground">({history.length})</span>}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {history.length ? "Reopen, re-run, or manage past runs." : "No past runs yet."}
                </p>
              </button>
            </div>
          </div>
        )}

        {/* RECENT */}
        {phase === "recent" && (
          <div className="space-y-4 duration-200 animate-in fade-in">
            {Header}
            <div className="flex items-center justify-between">
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" onClick={() => setPhase("entry")}>
                <ArrowLeft className="size-4" /> Back
              </Button>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <History className="size-3.5" /> Recent analyses
              </div>
              {history.length > 0 &&
                (confirmClear ? (
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Clear all?</span>
                    <button
                      className="font-medium text-destructive hover:underline"
                      onClick={() => {
                        onClearHistory();
                        setConfirmClear(false);
                        setPhase("entry");
                      }}
                    >
                      Yes
                    </button>
                    <button className="text-muted-foreground hover:underline" onClick={() => setConfirmClear(false)}>
                      No
                    </button>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmClear(true)}
                  >
                    <Trash2 className="size-3.5" /> Clear all
                  </Button>
                ))}
            </div>
            <div className="space-y-1.5">
              {history.map((e) => {
                const lbl = historyEntryLabels(e);
                return (
                  <div
                    key={e.cache_dir}
                    className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-primary/40"
                  >
                    <button onClick={() => openRecent(e)} disabled={analyzing} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm font-medium">{lbl.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {lbl.range ? `${lbl.range} · ` : ""}
                        {lbl.when}
                      </span>
                    </button>
                    <span className="hidden font-mono text-[10px] text-muted-foreground sm:flex sm:items-center sm:gap-1">
                      <Clock className="size-3" /> open
                    </span>
                    <button
                      onClick={() => onDeleteEntry(e.cache_dir)}
                      title="Delete this run + its cached result"
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* WIZARD */}
        {phase === "wizard" && (
          <div className="space-y-5">
            {Header}
            <Progress step={step} onJump={setStep} />

            <div key={step} className="space-y-4 duration-200 animate-in fade-in slide-in-from-right-2">
              {/* Step 1 — Inputs (rendered from the evidence-input registry) */}
              {step === 1 && (
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold">Step 1 · Inputs <span className="font-normal text-muted-foreground">— provide at least one primary input</span></h2>
                  {inputReg.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Loading input types…</p>
                  ) : (
                    <>
                      {primaryInputs.map((e) => (
                        <InputSlot
                          key={e.id}
                          icon={e.id === "ftdc" ? <Database className="size-4" /> : <FileText className="size-4" />}
                          title={e.label}
                          badge="primary"
                          path={inputValues[e.id] ?? null}
                          unlocks={e.description}
                          onPick={() => onPickInput(e.id, e.label)}
                          onClear={() => onClearInput(e.id)}
                          help={e.id === "ftdc" ? undefined : <RegistryCollectorHelp collector={e.collector} />}
                        />
                      ))}
                      {evidenceInputs.length > 0 && (
                        <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Optional evidence — sharpens specific categories
                        </div>
                      )}
                      {evidenceInputs.map((e) => (
                        <InputSlot
                          key={e.id}
                          icon={<FileText className="size-4" />}
                          title={e.label}
                          badge="optional"
                          path={inputValues[e.id] ?? null}
                          unlocks={e.description}
                          onPick={() => onPickInput(e.id, e.label)}
                          onClear={() => onClearInput(e.id)}
                          help={<RegistryCollectorHelp collector={e.collector} />}
                        />
                      ))}
                    </>
                  )}
                  {!selectedPath && healthcheckPath && (
                    <p className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-[11px] text-muted-foreground">
                      Healthcheck-only run: structural scoring, sizing and the Healthcheck Report
                      will be produced. Time-series charts / signals need an FTDC capture.
                    </p>
                  )}
                </section>
              )}

              {/* Step 2 — Intent */}
              {step === 2 && (
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold">Step 2 · Assessment intent <span className="font-normal text-muted-foreground">— a lens over the categories</span></h2>
                  <IntentPicker value={intent} onChange={onIntentChange} providedInputs={provided} />
                  {sizingIntent && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/20 p-3">
                      <span className="text-xs text-muted-foreground">Cloud provider (for tier sizing)</span>
                      <div className="inline-flex rounded-md border border-border p-0.5">
                        {CLOUDS.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => onCloudChange(c.id)}
                            className={
                              "rounded px-2.5 py-1 text-xs font-medium transition-colors " +
                              (cloud === c.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/50")
                            }
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                      <span className="text-[10px] text-muted-foreground">provisioned IOPS is AWS-only</span>
                    </div>
                  )}
                </section>
              )}

              {/* Step 3 — Mode */}
              {step === 3 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-semibold">Step 3 · Reasoning mode</h2>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <button
                      onClick={() => onAssessmentModeChange("grounded")}
                      className={"rounded-lg border p-3 text-left transition-colors " + (assessmentMode === "grounded" ? "border-primary bg-primary/10" : "border-border hover:bg-secondary/40")}
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <FileText className="size-4 text-primary" /> Rule-based (grounded)
                        {assessmentMode === "grounded" && <Check className="ml-auto size-4 text-primary" />}
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                        Deterministic scoring with a fully traceable evidence ledger. Works with any setup.
                      </p>
                    </button>
                    <button
                      onClick={() => onAssessmentModeChange("llm")}
                      className={"rounded-lg border p-3 text-left transition-colors " + (assessmentMode === "llm" ? "border-primary bg-primary/10" : "border-border hover:bg-secondary/40")}
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <Cpu className="size-4 text-primary" /> LLM-led
                        {assessmentMode === "llm" && <Check className="ml-auto size-4 text-primary" />}
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                        An AI model reasons over the scored evidence for a richer narrative. Best with a strong endpoint.
                      </p>
                    </button>
                  </div>
                  {assessmentMode === "llm" && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/20 p-3">
                      <ModelPicker model={model} onChange={onModelChange} />
                      <span className="text-[11px] text-muted-foreground">
                        active: <span className="font-mono text-foreground">{model ?? "— none —"}</span> · paid hidden · falls back to grounded if unavailable
                      </span>
                    </div>
                  )}
                </section>
              )}

              {/* Step 4 — Review */}
              {step === 4 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-semibold">Step 4 · Review</h2>
                  <div className="space-y-2">
                    <SummaryRow
                      label="FTDC diagnostic.data"
                      value={selectedPath ?? "— none (healthcheck-only) —"}
                      muted={!selectedPath}
                      onEdit={() => setStep(1)}
                    />
                    {inputReg
                      .filter((e) => e.id !== "ftdc" && inputValues[e.id])
                      .map((e) => (
                        <SummaryRow key={e.id} label={e.label} value={inputValues[e.id] as string} muted onEdit={() => setStep(1)} />
                      ))}
                    <SummaryRow
                      label={selectedIntents.length > 1 ? "Assessment intents (union)" : "Assessment intent"}
                      value={
                        selectedIntents.length > 0 ? (
                          <span>{selectedIntents.map((i) => i.title).join(" + ")}</span>
                        ) : (
                          <span className="text-muted-foreground">— none selected —</span>
                        )
                      }
                      onEdit={() => setStep(2)}
                    />
                    {sizingIntent && (
                      <SummaryRow
                        label="Cloud provider"
                        value={CLOUDS.find((c) => c.id === cloud)?.label ?? cloud}
                        onEdit={() => setStep(2)}
                      />
                    )}
                    <SummaryRow
                      label="Reasoning mode"
                      value={assessmentMode === "llm" ? `LLM-led${model ? ` · ${model}` : ""}` : "Rule-based (grounded)"}
                      onEdit={() => setStep(3)}
                    />
                  </div>
                  {/* Change-detection note (the action label, always visible) */}
                  <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground">
                    {plan.explain}
                  </div>
                  <Button className="w-full gap-2" disabled={analyzing || !hasAnyInput} onClick={() => onRun(baseline)}>
                    {analyzing ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                    {analyzing ? "Working…" : plan.label}
                  </Button>
                  {error && !analyzing && <p className="text-center text-xs text-destructive">{error}</p>}
                </section>
              )}
            </div>

            {/* Wizard nav */}
            <div className="flex items-center justify-between">
              <Button
                size="sm"
                variant="ghost"
                className="h-9 gap-1.5 text-xs"
                onClick={() => (step === 1 ? setPhase(baseline ? "recent" : "entry") : setStep((s) => s - 1))}
                disabled={analyzing}
              >
                <ArrowLeft className="size-4" /> Back
              </Button>
              {step < 4 && (
                <Button size="sm" className="h-9 gap-1.5 text-xs" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                  Next <ArrowRight className="size-4" />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
