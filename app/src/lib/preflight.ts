// Pre-flight wizard selection model + run change-detection.
//
// A "snapshot" of everything the user chose for a run; persisted per cached run (keyed by
// cache_dir in localStorage) so a recent analysis can be re-opened on the Review step with
// its prior selections, and the right run action can be computed.

// AssessmentMode removed - always using template-based narratives

export interface Selections {
  ftdc: string | null;
  intent: string;
  // mode removed - always template-based
  model: string | null;
  healthcheck: string | null;
  profiler: string | null;
  cloud: string;
  // Phase-9 evidence inputs (optional; older snapshots omit them).
  sh_status?: string | null;
  rs_status?: string | null;
}

export interface Baseline extends Selections {
  cache_dir: string;
  hostname: string;
}

export type RunAction = "open" | "rerun" | "reanalyze";

export interface RunPlan {
  action: RunAction;
  label: string; // button text
  explain: string; // one-line note shown on Review
}

// Decide what "Run" will do, given the restored baseline (if any) and current selections.
export function classifyRun(baseline: Baseline | null, cur: Selections): RunPlan {
  const hasFtdc = !!cur.ftdc;
  if (!baseline) {
    return {
      action: "reanalyze",
      label: "Run analysis",
      explain: hasFtdc
        ? "Decodes the FTDC capture and scores it."
        : "Parses the healthcheck snapshot and scores the structural categories.",
    };
  }
  // Any change to the actual input files → a full re-run of the engine.
  if (
    cur.ftdc !== baseline.ftdc ||
    cur.healthcheck !== baseline.healthcheck ||
    cur.profiler !== baseline.profiler ||
    (cur.sh_status ?? null) !== (baseline.sh_status ?? null) ||
    (cur.rs_status ?? null) !== (baseline.rs_status ?? null)
  ) {
    return {
      action: "reanalyze",
      label: "Re-analyze",
      explain: hasFtdc
        ? "Inputs changed — will re-run the engine (re-decode the FTDC capture)."
        : "Inputs changed — will re-parse the healthcheck snapshot.",
    };
  }
  const changed: string[] = [];
  if (cur.intent !== baseline.intent) changed.push("Intent");
  // mode removed - always template-based
  if (cur.model !== baseline.model) changed.push("Model");
  if (cur.cloud !== baseline.cloud) changed.push("Cloud");
  if (changed.length) {
    return {
      action: "rerun",
      label: hasFtdc ? "Re-run (uses cached decode)" : "Re-run (cached)",
      explain: `${changed.join(" & ")} changed — will re-score from the cached result (no re-parse).`,
    };
  }
  return {
    action: "open",
    label: "Open cached result",
    explain: "No changes — will open the cached result instantly.",
  };
}

// Per-run snapshot persistence (frontend-only; keyed by the cached run dir).
const KEY = (cacheDir: string) => `ftdc.run.${cacheDir}`;

export function saveRunSnapshot(cacheDir: string, hostname: string, sel: Selections): void {
  try {
    localStorage.setItem(KEY(cacheDir), JSON.stringify({ ...sel, cache_dir: cacheDir, hostname }));
  } catch {
    /* best-effort */
  }
}

export function loadRunSnapshot(cacheDir: string): Partial<Baseline> | null {
  try {
    const raw = localStorage.getItem(KEY(cacheDir));
    return raw ? (JSON.parse(raw) as Partial<Baseline>) : null;
  } catch {
    return null;
  }
}

export function deleteRunSnapshot(cacheDir: string): void {
  try {
    localStorage.removeItem(KEY(cacheDir));
  } catch {
    /* best-effort */
  }
}
