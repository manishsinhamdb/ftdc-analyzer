# FTDC Analyzer — Project Status & Handoff

> Working handoff doc. Snapshot of what's **done** and what's **pending** so the next phase
> can start cold.

---

## ★ START HERE (current state — updated 2026-06-19)

**Read `LAYER2_BUILD_NOTES.md` (repo root) first** — it's the running decisions log + per-brief
reports (decisions A1–A20+) and holds most of the current context. Then skim `git log`.

**Since the original handoff below, the "Layer-2" line of work shipped (committed on `main`):**
- **Engine (Python):** declarative ruleset (`ftdc_analyzer/ruleset/` — 16 categories across 6
  families, 5 deep + 11 stub), a two-pass conditioned **scorer** (`scorer.py` → `assessment_v2`
  with evidence ledgers + intent lenses, single & multi-intent union), an Atlas **sizing engine**
  (`sizing.py` + `tier_tables/{aws,gcp,azure}.json`), and **fine `{mean,min,max}` series**.
  `build_results` lives in **`verdicts.py`**. New `cli.py` flags: `--intent`, `--target-category`,
  `--cloud`, `--healthcheck`, `--profiler`, `--ruleset-overrides`, `--dump-ruleset`, `--resize-from`.
- **App (React/TS + Rust):** a guided **pre-flight wizard** (Inputs → Intent → Mode → Review +
  history purge + mini-game loading screen), **LLM provider manager** (OpenAI + Anthropic dialects,
  `llm.rs`/`llm.ts`/`LlmSettings.tsx`), the **Assessment v2 panel** (3-layer: Verdict → Reasoning →
  Evidence), **Sizing panel**, **Methodology & Rules** view, Atlas-style **chart granularity/range/
  drag-zoom + min/max bands**, collector helper (`collectors/getMongoData.js`), and UI polish
  (contrast, scrollbars, fonts).

**Working conventions (important):**
- **Leave changes staged; do NOT commit/tag/push** unless the task explicitly says so (the user
  reviews diffs + controls commit grouping). Commit messages end with the Co-Authored-By trailer.
- **Additive only:** never touch `decoder.py` / decode logic; for display/UAT tasks don't change
  scorer/ruleset *logic*, only how results render.
- **No headless GUI here** — verify at engine (cli on `files/upload/ludo-prod-mongo-05`), HTTP
  (`cargo test llm::tests -- --ignored`), `tsc --noEmit`, `cargo check`, and `make app` (run in
  background); always test the **bundled** sidecar for data bundling; flag GUI click-through as pending.
- Build: `make app` → `.app`/`.dmg` in `app/src-tauri/target/release/bundle/`.

_(The sections below are the ORIGINAL Atlas-parity-phase handoff — still useful for engine/UI
foundations, but predate Layer-2; the bullets above + LAYER2_BUILD_NOTES.md are the current truth.)_

---

## 1. What this is (1 paragraph)

A **macOS desktop app** that analyzes a MongoDB **FTDC** (`diagnostic.data`) capture **100%
locally** (nothing uploaded). A **Python engine** decodes the BSON/delta-encoded `metrics.*`
files, derives ~80 Atlas-style per-second signals + a full 1370-metric catalog, computes
RAM/CPU/Disk verdicts, cost-optimization actions, insights, and a deterministic "Automated
Assessment". The engine is packaged as a **PyInstaller sidecar binary** and bundled into a
**Tauri (React + TS + Rust) app**. Everything is fork-and-runnable via a `Makefile`.

Architecture:
```
Tauri app (app/)  --spawns-->  ftdc-engine sidecar (PyInstaller bundle of ftdc_analyzer/)
  React/TS UI                    writes results.json + metrics_full.json + report.html
  Rust shell      <--reads--     into an app-cache run dir; UI reads it back via fs
```

---

## 2. COMPLETED

### 2a. Python engine (`ftdc_analyzer/`)
- **`decoder.py`** — concatenated-BSON reader; per-chunk decode: `zlib` framing
  (`uint32 LE len + zlib`), reference BSON + `metricCount`/`deltaCount`, unsigned-LEB128
  varint stream, zero-RLE delta matrix (column-major), uint64-wrap reconstruction. `flatten`
  (numeric leaves; Timestamp→2). **Graceful per-file skip** at the shared iteration layer
  (`iter_directory_docs`) used by both `decode_directory` and `build_metrics_full` — a
  corrupt `metrics.interim` is skipped + recorded, not fatal. **Core decode logic is
  considered frozen/validated** (a `recon.py`-style flatten count == metricCount check passed
  file-wide).
- **`metrics.py`** — `extract` (decode curated keep-set + role/data-disk resolution),
  `derive` (**81 signals**, all div-by-zero guarded), `build_metrics_full` (ALL 1370 metrics,
  memory-conscious online equal-time bucketing to 2000 points; categories + kind=counter/gauge
  + summary), `read_metadata_doc`, `json_sanitize`, `probe`, `category_for`.
- **`verdicts.py`** — **`build_results(dirpath, on_skip=None) -> dict`** is the single
  assembler. Contains the verdict rules (RAM/CPU/DISK, each with `cost_action`),
  `build_cost_optimization`, `build_insights` + `build_extra_insights`, `build_facts`, the
  **data-driven `CHART_CATALOG`** (11 categories), assessment via `signatures`, `downsample`,
  and a `__main__` dev-regenerate (writes to `reports/`; **no longer copies to app/public**).
- **`signatures.py`** — deterministic signature engine → `assessment`
  (headline/posture/purposes/signatures). Heuristics **attributed to mongo-ftdc / Keyhole
  (Apache-2.0)**; no code copied.
- **`report.py`** — self-contained HTML report (CDN-Plotly or inlined); renders the full
  data-driven catalog + assessment + cost optimization + verdicts + signals.
- **`cli.py`** — preflight (resolve `diagnostic.data`, require ≥1 `metrics.*`, fail with
  named reason), graceful skip + per-run logging to `logs/run_<stamp>.log` + `logs/last_run.log`,
  modes: `--out FILE`, `--stdout`, and **`--out-dir DIR`** (writes `results.json` +
  `metrics_full.json` + `report.html`, prints parseable `hostname=`/`out_dir=`). Imports
  `report` to emit `report.html`.
- **`ftdc_engine_entry.py`** — PyInstaller entrypoint. **`pyproject.toml`** makes the package
  `pip install -e .`-able and exposes the `ftdc-engine` console script.

### 2b. results.json schema (v3) — top-level keys
`schema_version, generated_at, source, host{…,cluster_role}, capture, signals,
assessment, verdicts, cost_optimization, insights, chart_catalog, facts, series,
missing_paths, skipped_files, notes`. Purely additive growth; **schema is at v3**.

### 2c. Atlas-parity metrics (latest phase)
- **Query Efficiency** category: `keys_examined_per_returned`, `docs_examined_per_returned`
  (Atlas Query Targeting, 1.0 = ideal; div-by-zero → NaN, never inf); charts: Query Targeting
  (ref 1.0), Scan & Order, Document Metrics, Operation execution time.
- **Replication**: per-member lag `repl_lag_member_{i}_s` + max-secondary `repl_lag_s`; chart
  draws a line per member present (member 0 had no optimeDate → dropped). **Oplog
  window/churn/headroom: VERIFIED ABSENT in FTDC → omitted + noted (not fabricated).**
- **Cursors**: `cursors_open` (gauge), `cursors_timed_out_ps` (rate); "Cursors" chart.
- **Insights** feeding the opt-in Assessment: `query_efficiency` (framed as a PROXY — real
  offending queries need the Query Profiler / slow-query log, not in FTDC) and `replication`
  (max secondary lag; oplog WARN gated on availability).

### 2d. Tauri app (`app/`)
- **Live flow**: Open folder (`plugin-dialog`) → **Analyze** (Rust `analyze_path` runs the
  sidecar to an app-cache run dir, parses `hostname`/`out_dir`) → UI reads `results.json` (and
  lazy-loads `metrics_full.json` for Explore) via `plugin-fs`. Error toasts via `sonner`.
- **Views**: **Overview** (intentionally *unbiased*: verdict cards, insight chips, 3 headline
  charts — assessment removed from here), **Charts** (catalog-driven category Tabs, sticky +
  prominent, above a slim 64px RangeSelector; per-chart **maximize modal**), **Signals**
  (triage surface: sparkline column, click-to-chart, p95/p99 colored on verdict-threshold
  breach), **System** (derived stat tiles + masonry config cards), **Explore** (lazy
  metrics_full, search + category/kind filters + quick-pick chips, multi-select up to 4
  overlaid, Raw/Rate toggle), **Assessment** (**opt-in, default OFF** via a "Generate
  assessment" checkbox — this checkbox is the documented **hook point for a future local-LLM
  run**).
- **Chrome**: collapsible icon-rail sidebar (Assessment nav at bottom); fixed full-height
  sidebar, only `main` scrolls; **History** as a top-bar dropdown (Rust `list_history` /
  `record_run` persisted to app-data); **Home / New analysis** (clickable brand + button) →
  back to landing; **Export HTML** opens a **save-file dialog** (Rust `save_report` copies
  report.html to the chosen path, no app-folder writes); **"Hi `<user>` :)"** greeting (Rust
  `get_username`).
- **Privacy-first landing**: minimal (greeting + name + purpose + Open/Analyze). **The bundled
  demo sample and all sample code paths were REMOVED** — a fresh clone shows nothing until the
  user analyzes their own folder.
- Rust commands: `analyze_path`, `list_history`, `record_run`, `save_report`, `get_username`.
  Capabilities grant dialog (open+save), shell sidecar execute, fs read ($APPCACHE/$APPDATA),
  opener reveal.

### 2e. Packaging & CI
- **`Makefile`** (arch-aware: target triple from `uname -m`, no hardcoded aarch64): `setup`,
  `sidecar`, `app`, `dev`, `engine DIR=…`, `clean`. Validated `make sidecar` + `make -n app`
  on aarch64.
- **`README.md`** — fork-and-run: quick start, FTDC explainer, local-only note, architecture,
  prereqs, CLI usage, unsigned-app note, repo layout, attribution, roadmap.
- **`.github/workflows/ci.yml`** (PR/main build check) + **`release.yml`** (tag `v*` → build
  `.dmg` → upload as GitHub Release asset). Both validated as YAML.

---

## 3. Key files map
```
ftdc_analyzer/        decoder.py metrics.py verdicts.py signatures.py report.py cli.py
ftdc_engine_entry.py  pyproject.toml  Makefile  README.md  STATUS.md (this)
app/src/App.tsx       main shell, views, data flow, Rust invokes
app/src/components/    TimeSeriesChart(+ChartModal), SignalsTable, RangeSelector, ExploreView,
                       SystemView, AssessmentPanel, InsightsStrip, Landing
app/src/lib/ftdc.ts    TS types + helpers (chart merge, formatters, palettes)
app/src-tauri/src/lib.rs  Rust commands; capabilities/default.json; tauri.conf.json (externalBin)
app/src-tauri/binaries/ftdc-engine-<triple>   bundled sidecar (gitignored; rebuild via make sidecar)
.github/workflows/     ci.yml, release.yml
```
Engine output of record lives in `reports/` (gitignored). Logs in `logs/` (gitignored).

## 4. How to run
```bash
make dev      # hot-reload dev window (reflects all current code; no Gatekeeper hassle)
make app      # build .app + .dmg  ->  app/src-tauri/target/release/bundle/
make engine DIR=/path/to/diagnostic.data    # engine-only CLI -> ./out
```

---

## 5. PENDING / NEXT PHASE (prioritized)

### P0 — make the package current & prove it end-to-end
1. **Rebuild the distributable bundle** (`make app`). The **sidecar binary was rebuilt** with
   the latest engine, but the **`.app`/`.dmg` bundle was NOT re-bundled this session** (full
   `tauri build` was intentionally skipped). The shipped bundle is therefore stale relative to
   the latest UI + engine. Run `make app` and confirm the `.dmg`.
2. **First human GUI click-through** (never done — no headless GUI driving this session):
   pick `files/upload/ludo-prod-mongo-05/diagnostic.data` → Analyze → verify dashboard,
   per-category Charts (incl. new Query Efficiency / Cursors / per-member Replication),
   Signals click-to-chart + sparklines, maximize modals, History dropdown round-trip, Export
   HTML save dialog, and the opt-in Assessment toggle. Fix anything that doesn't render.

### P1 — the headline roadmap feature
3. **Local-LLM assessment.** The "Generate assessment" checkbox is the wired hook point
   (`generateAssessment` in `App.tsx`; `signatures.build_assessment` is the deterministic
   stand-in). Next: run a **local LLM** over the same signals/percentiles/insights to produce a
   reasoned narrative + ranked recommendations, shown on the Assessment tab. Decide model/runtime
   (e.g., a bundled small model or a user-configured local endpoint), keep it 100% local.

### P2 — deepen the diagnosis
4. **Slow-query-log / profiler ingestion → namespace/query view.** FTDC is host-level only;
   the `query_efficiency` insight is explicitly a *proxy*. Add optional ingestion of the
   slow-query log / `system.profile` to surface top collections, slowest queries, and index
   suggestions — the "which queries?" the proxy can't answer.
5. **Multi-host / cluster comparison.** The engine picks the host with the most files and notes
   the others. We did a manual mongo-03 vs mongo-05 comparison (PRIMARY surfaced the
   latency↔sharding correlation that the SECONDARY hid). Promote this into a UI compare view.

### P3 — hardening / distribution
6. **Code-signing + notarization** (app is currently unsigned → right-click→Open). Needed for
   frictionless distribution; wire into `release.yml`.
7. **CI iteration.** `ci.yml`/`release.yml` are best-effort and unproven on a real runner
   (toolchain/version drift, signing). Run them once on a tag and fix.
8. **Intel (x86_64) validation.** Makefile computes the triple from `uname -m` but only the
   aarch64 path has been exercised. Verify a `make app` on Intel.
9. **Engine test suite.** No automated tests (only ad-hoc `recon`/self-test validation). Add
   pytest for decoder (known-good counts), derive (signal shapes/guards), verdict thresholds.

---

## 6. Known constraints / gotchas
- **Schema is v3**, additive-only growth has been the rule; keep `build_results` the single
  assembler and bump only when removing/renaming.
- **Oplog window is not in FTDC** (verified) — anything needing oplog first/last entry
  timestamps must come from another source.
- **Verdict thresholds are heuristic** (e.g., RAM dirty threshold was calibrated to 5.5% so a
  p95 sitting at WiredTiger's 5% dirty-target reads as HOLD, not UNDERSIZED). Revisit per
  workload and especially for PRIMARY vs SECONDARY captures.
- **A fresh clone ships no sample** (demo removed) — the app is empty until the user analyzes a
  real folder. README covers this.
- **Bundled sidecar + build dirs are gitignored** — CI / a fresh clone must `make sidecar`
  before `make app`.
- Vite emits a >500 kB chunk warning (Recharts + embedded data) — cosmetic; code-split later if
  desired.
- `verdicts.py __main__` and `metrics.py`/`signatures.py` self-tests hardcode the local
  mongo-03 path (dev-only regenerate convenience).

## 7. Current sample verdicts (mongo-03, for sanity)
RAM **HOLD**, CPU **REDUCE → 8 vCPU**, DISK **SATURATED** (checkpoint-bound, latency healthy);
cost opportunity **high**; assessment posture "Stable — action recommended"; query targeting
~1:1; replication lag ~1s; cursors idle; sharding correlation OK on the secondary (it fired on
the mongo-05 PRIMARY). 81 signals, 11 chart categories.
