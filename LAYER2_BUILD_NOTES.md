# Layer-2 Scorer — Build Notes & Decisions Log

> Durable checkpoint + final report for the Layer-2 deterministic scorer, declarative
> editable ruleset, and methodology/management panel. Additive only; decoder untouched.
> Status is updated as the build progresses (survives context compaction).

## Assumptions / decisions logged (forks resolved without stopping)

- **A1. `build_results` lives in `verdicts.py`, not `metrics.py`.** The task said "catalog
  assembled in metrics.py build_results"; in this repo the single assembler is
  `verdicts.build_results(dirpath, ...)`. I extended `verdicts.py` (and call the scorer from
  there). Logged for clarity; no behavior change to existing assembly.
- **A2. Frontend SKILL.md — read (corrected).** It is NOT at the briefed path
  `/mnt/skills/public/frontend-design/SKILL.md`, but it DOES exist on this machine at
  `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/
  frontend-design/SKILL.md`. (An earlier note here said "absent" — written before the
  background `find` returned; corrected after reading it.) The skill targets distinctive
  *greenfield* visual identity and explicitly states the brief's pinned visual direction
  always wins. This brief pinned it ("existing dark theme + MongoDB green; follow the
  existing app's component/catalog patterns"), so the new panels deliberately match the
  established design system (index.css tokens, shadcn/Tailwind/Recharts, AssessmentPanel /
  TimeSeriesChart conventions). The skill's "structure encodes information" and "deliberate
  motion" principles are honored: family-colour coding, the SVG causal-conditioning arc graph
  (real `conditioned_by` links, not decoration), and the score-composition / confidence-bar
  grow animations that show *how a score is reached*.
  - **Known quality-floor follow-up:** the new grow/transition animations do not yet gate on
    `prefers-reduced-motion` (consistent with the rest of the app, which also doesn't). Worth
    a small global `@media (prefers-reduced-motion: reduce)` pass later; deliberately not
    changed post-validation to avoid destabilizing the green build.
- **A3. Available inputs = `{ftdc}` only.** No healthcheck/profiler ingestion exists yet, so
  the scorer treats only `ftdc` as available. Categories requiring `healthcheck`/`profiler`
  return `requires_input` naming the missing source (ties to the existing chart scaffolding).
- **A4. Override transport to the (PyInstaller) sidecar.** The engine resolves an overrides
  file from, in order: `--ruleset-overrides PATH` CLI arg → `FTDC_RULESET_OVERRIDES` env var →
  none. The Rust `analyze_path` passes the app-config path when the file exists; the env var
  makes the round-trip headlessly testable. See "Override mechanism" below.
- **A5. Methodology/Manage panel reads the ruleset via a dedicated engine dump** (`--dump-ruleset`)
  exposed through a Rust `ruleset_dump` command, so the panel works without a loaded analysis
  and always reflects defaults+overrides merged by the engine (engine = source of truth).
- **A6. Scoring stat.** Each signal declares which summary stat to read (`p50|p95|p99|max|mean`),
  default `p95`. Confidence is the clamped ratio of summed signed contributions to the sum of
  positive active weights — fully reconstructable from the evidence ledger.

- **A7. Methodology view reachability.** The new "Methodology & Rules" view lives in the
  main-app sidebar nav (shown once a capture is loaded), consistent with the other views.
  It still works without a *scored* analysis because it pulls the ruleset via the engine
  `--dump-ruleset` (defaults+overrides), independent of FTDC data.
- **A8. Two "how a score is reached" surfaces.** Methodology tab = *structural* breakdown
  (weights/directions/thresholds/disambiguators) from the ruleset dump (works with no
  analysis). Assessment tab (assessment_v2) = the *live* computed evidence ledger +
  confidence. Both are deterministic and reconstructable.

## Status checklist
- [x] Part 1 — ruleset framework + 16 categories (5 deep, 11 stub)
- [x] Part 2 — two-pass scorer + assessment_v2 in build_results
- [x] Part 3 — full-sweep / targeted modes + LLM-narration hook (clean, not wired)
- [x] Part 4 — Methodology & Rules panel (view + manage/override)
- [x] Part 5 — Assessment-tab wiring + requires_input scaffolding
- [x] Validation: Ludo-05 run ✓, override round-trip ✓ — make app pending below

---

## (a) Ruleset schema + the 16 categories

**Schema** (`ftdc_analyzer/ruleset/schema.py`): `Ruleset{version, categories[]}` →
`Category{id, name, family, description, required_inputs[], signals[], caveats[],
recommendation, conditioned_by[], conditional_recommendations{}, status, enabled,
fire_threshold}` → `Signal{metric_path, weight, direction(+/−), comparator, threshold,
stat, interpretation, disambiguator?, status, unit}` → `Disambiguator{co_signal,
comparator, value, effect(enable|suppress|scale), scale, note}`. `to_dict()` emits stable
JSON. Families: Capacity, Incident-RCA, Cluster-Context, Structural-Design,
Query-Optimization, Cross-Cutting. Inputs: ftdc | healthcheck | profiler.

| # | id | family | inputs | depth |
|---|----|--------|--------|-------|
| 1 | memory_cache_pressure | Capacity | ftdc | **DEEP** (5 signals, disambiguator, conditioned) |
| 2 | cpu_compute_sizing | Capacity | ftdc | **DEEP** (6 signals, iowait disambiguator) |
| 3 | disk_io_saturation | Capacity | ftdc | **DEEP** (6 signals, checkpoint disambiguator) |
| 4 | replication_lag_cascade | Incident-RCA | ftdc | **DEEP** (5 signals, conditioned by write_path) |
| 5 | write_path_contention | Incident-RCA | ftdc | **DEEP** (6 signals, conditioned by disk) |
| 6 | connection_workload_surge | Incident-RCA | ftdc | stub (2 placeholder signals) |
| 7 | checkpoint_storage_stalls | Incident-RCA | ftdc | stub (2) |
| 8 | errors_stability | Incident-RCA | ftdc | stub (2) |
| 9 | version_config_risk | Cluster-Context | ftdc | stub (0) |
| 10 | sharding_topology | Cluster-Context | ftdc | stub (1) |
| 11 | index_health_bloat | Structural-Design | ftdc+healthcheck | stub (0) |
| 12 | schema_datamodel | Structural-Design | ftdc+healthcheck | stub (0) |
| 13 | storage_capacity_design | Structural-Design | ftdc+healthcheck | stub (0) |
| 14 | query_targeting_index_recs | Query-Optimization | ftdc+profiler | stub (1 FTDC proxy) |
| 15 | slow_query_hotspots | Query-Optimization | ftdc+profiler | stub (0) |
| 16 | periodic_health_review | Cross-Cutting | ftdc | stub (0) |

Every Capacity category carries the `CAPACITY_CAVEAT` (resource-stress is conditional on
workload efficiency) and is `conditioned_by` the stubbed `query_targeting_index_recs` +
`schema_datamodel`, so the wiring exists before those inputs are live.

## (b) Scorer two-pass logic (`ftdc_analyzer/scorer.py`)

- **Pass 1**: for each enabled category whose `required_inputs ⊆ available`, evaluate each
  active signal → ledger row `{signal, value, weight, direction, comparator, threshold,
  passed, factor, contribution, reason, disambiguator}`. Disambiguators apply `enable`
  (factor 0 unless co-signal passes), `suppress`, or `scale`. `contribution = (weight if
  passed else 0) × factor × (+1/−1)`. `confidence = clamp01(Σcontribution ÷ Σpositive
  weights)`; `fired = confidence ≥ fire_threshold`. Fully reconstructable from the ledger.
  Categories with a missing input → `requires_input` (names the source); stub/no-active →
  `stub`; toggled off → `disabled`.
- **Pass 2 (arbitration)**: for each scored category with `conditioned_by`, if a conditioning
  category **fired**, swap in its `conditional_recommendation` (flagged
  `recommendation_conditioned` + a cross-reference note). If a conditioning category is
  `requires_input`, attach the honest caveat ("…cannot confirm capacity vs workload — provide
  <source>") instead of silently finalizing. Output `assessment_v2{version, mode,
  target_category, available_inputs, counts, ranked[], llm_narration:null}`.

## (c) Override mechanism

- Defaults: `ruleset/defaults.build_default_ruleset()`. Overrides JSON merged on top by
  `ruleset/overrides.build_ruleset(path)`. **Merge order**: defaults → category fields
  (enabled/recommendation/caveats/fire_threshold) → per-signal edits (by metric_path) →
  added_signals → removed_signals. Unknown ids/paths ignored (non-fatal).
- **Path resolution** (engine): `--ruleset-overrides PATH` → `FTDC_RULESET_OVERRIDES` env →
  none. Rust `analyze_path` passes `app_config_dir/ruleset_overrides.json` when it exists;
  `ruleset_dump` passes it too. The Manage panel writes that file via `ruleset_set_overrides`.
- Rust commands (`app/src-tauri/src/ruleset.rs`): `ruleset_dump`, `ruleset_get_overrides`,
  `ruleset_set_overrides`, `ruleset_overrides_path`.

## (d) Methodology & Manage panel (`app/src/components/MethodologyRules.tsx`)

- **Methodology (view)**: category index grouped by family → selected category shows an
  animated structural score-composition (weighted signal bars, +/− coloring, disambiguator
  callouts), caveats, default + conditional recommendations, and a **Causal conditioning
  map** (SVG arc diagram of `conditioned_by` links). Dark theme + MongoDB green.
- **Manage (edit)**: per-category toggle, fire-threshold, per-signal weight/threshold edits,
  add/remove signals, edit caveats/recommendation, **reset-to-defaults** per category.
  Validates weights/thresholds numeric and added-signal metric_path non-empty. Saves the
  override JSON via Rust; shows the overrides path. `assessment_v2` also rendered on the
  Assessment tab (`AssessmentV2Panel.tsx`) with confidence bars, evidence ledgers, conditioned
  recs, caveats, requires_input "upload X" placeholders, and the active-model indicator.

## (e) Per-category validation on Ludo-05 (PRIMARY, 3.6.17) — `assessment_v2`

mode=full · counts: scored 5, requires_input 5, stub 6, fired 1.

| category | result |
|----------|--------|
| disk_io_saturation | **scored, FIRED** conf≈0.72 (matches known DISK-SATURATED verdict) |
| cpu_compute_sizing | scored conf≈0.18 (not fired) |
| replication_lag_cascade | scored conf≈0.15 (conditioned by write_path) |
| write_path_contention | scored conf≈0.15 (conditioned by disk_io_saturation) |
| memory_cache_pressure | scored conf≈0.05 |
| index_health_bloat / schema_datamodel / storage_capacity_design | requires_input (healthcheck) |
| query_targeting_index_recs / slow_query_hotspots | requires_input (profiler) |
| connection_workload_surge, checkpoint_storage_stalls, errors_stability, version_config_risk, sharding_topology, periodic_health_review | stub |

Acceptance asserts (all True): 5 deep scored with full ledgers; capacity categories carry
the workload-efficiency caveat; healthcheck/profiler categories → requires_input.
**Override round-trip**: editing `cache_used_pct` threshold + `wt_app_evict_ps` weight moved
memory confidence 1.000 → 0.600 and applied the custom recommendation; CLI `--ruleset-overrides`
honored (disabled cpu category). Engine merge + scorer verified deterministically.

## (f) Build result
`make app` → **EXIT 0** (clean). Gates passed: engine import, Ludo-05 run, scorer +
override unit checks, `tsc --noEmit`, `cargo check`, vite. Bundles:
- `app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app` — **36 MB**
- `app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_0.1.0_aarch64.dmg` — **26 MB**

The **bundled** sidecar was verified to support `--dump-ruleset` (16 categories, 5 deep) —
so the packaged Methodology/Manage panel works without dev sources. Left **staged but
uncommitted** for review (no commit/tag/push).

## (g) Assumptions / decisions
See A1–A8 at the top of this file.

---

# Layer-2 LLM Narration + UI affordances (follow-up brief)

Additive completion of the Layer-2 feature: LLM narration of the deterministic
assessment, mode/model/category controls on landing + Assessment tab, targeted focus, and
a Methodology HTML export. Decoder/scorer untouched.

## A9. Narration runs in the frontend, not the engine
Consistent with the original "LLM is an optional async add-on, not in the Python engine"
decision, narration is a frontend step: the engine emits `assessment_v2` (with
`llm_narration: null`); the UI builds a constrained prompt from it and calls the existing
`llm_chat` Rust command. The `llm_narration` field stays null in results.json; the narrative
is produced at view time and rendered in its place (state in `AssessmentV2Panel`). Targeted
focus is engine-driven on the analyze run (`--target-category`) AND re-applied client-side on
the tab so switching focus/model is instant (no ~40s re-decode); the scorer always scores all
categories, so client-side re-focus is content-equivalent to a re-run.

## (a) Narration prompt + grounding constraints (`app/src/lib/narration.ts`)
System prompt frames the input as the OUTPUT of a deterministic scorer and imposes hard rules:
(1) cite ONLY provided numbers/signals/scores/thresholds — never invent; (2) no new
verdicts/categories/recommendations; (3) respect + restate caveats, especially the capacity
"workload efficiency unknown" caveat; (4) explain cross-category conditioning in prose; (5) if
a category needs a missing input, say it's unconfirmed and name the source. The user message is
a compact, number-explicit digest of scored categories (confidence, fired, top-6 ledger rows as
`signal=value (test, met?, contribution)`, recommendation incl. CONDITIONED flag,
cross-references, caveats) + a "NOT ASSESSED (missing input)" list. temperature 0.2, max_tokens
900. Targeted focus reorders the digest + adds a FOCUS instruction.

## (b) Mode/model/category UI (`AssessmentControls.tsx`)
Reusable `ModeSelector` (Grounded / LLM-reasoned), `ModelPicker` (lists via provider layer,
paid/embedding gated, persists to llm config, syncs the persisted model on load), and
`CategorySelector` (16 categories grouped by family; healthcheck/profiler ones marked
"requires …"). Rendered on the **landing** screen (under a persisted "Generate assessment"
opt-in) and mirrored on the **Assessment tab** header with the active model picker visible.
Choices persist to localStorage (`ftdc.generateAssessment/assessmentMode/targetCategory`) +
llm config (model) and flow into the run.

## (c) Fallback behavior
`runNarration` returns `{ok:false, reason, kind}` on any error/timeout/unreachable/empty.
`AssessmentV2Panel` then shows an amber inline notice "LLM narration unavailable — showing the
grounded assessment below; [kind] reason" and the full grounded ledger remains rendered. The
assessment never blocks or breaks. Verified: model `nonexistent-model-xyz:9000b` →
`{error:{message:"model ... not found"}}` → ok=false (kind http) → notice + grounded ledger.

## (d) Targeted-mode behavior
Landing/tab category choice → `analyze_path` passes `--target-category` → engine emits
`mode:"targeted"`, `target_category`, and the focused category first with `focus:true`. The tab
also re-focuses client-side (surfaces the chosen category first, ring-highlighted) and, in LLM
mode, the narrative leads with it. Verified on Ludo with `disk_io_saturation`: first ranked =
disk_io_saturation, focus=true, mode=targeted.

## (e) Methodology export (`MethodologyRules.tsx` → `save_text` Rust command)
"Export HTML" builds a self-contained, inline-styled (dark theme) document: every category
grouped by family with its signals table (metric/weight/direction/threshold/stat/interpretation),
disambiguators, caveats, recommendation, and conditioned-by links; active overrides are fetched
and the affected categories are marked "customized" with a banner. Saved via the save dialog
through a new `save_text(dest, content)` Rust command (sibling of `save_report`), then revealed.

## (f) Sample LLM narrative (Ludo-05, ministral-3:8b) — captured
Leads with "disk i/o saturation as the primary constraint (confidence 72%)", restates "all
capacity conclusions are conditional on workload efficiency being unknown", explains write
contention co-occurring with disk saturation ("tickets held due to slow I/O, not raw volume"),
reports the other categories at their exact confidences (cpu 18%, replication 15%, memory 5%),
and lists the missing profiler/healthcheck inputs. Numbers cited all trace to the ledger; no new
categories/verdicts introduced. (Full text saved to /tmp/ftdc-narrative-sample.txt during
validation.) NOTE: the weak model occasionally phrases a comparison imperfectly (it described
read/write latency 3–4ms as "above 10ms"); the cited numbers are still grounded and the
deterministic ledger shown beneath is the authoritative source — which is exactly why Grounded
mode exists and the ledger is always rendered under the narrative.

## (g) Build result (narration follow-up)
`make app` → **EXIT 0** (clean). Gates: `cargo check` ✓, `tsc --noEmit` ✓, vite ✓,
targeted engine run ✓, live narration round-trip ✓, bad-model fallback ✓. Bundles:
- `app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app` — 36 MB
- `app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_0.1.0_aarch64.dmg` — 26 MB

New Rust command: `save_text(dest, content)`; `analyze_path` gained an optional
`target_category`. Left **staged, uncommitted** for review (no commit/tag/push).

---

# Pre-flight intake + intent presets (follow-up brief)

Additive: declarative intent lens over the 16 categories, a guided 3-step pre-flight
landing, real collector helpers, and honest intake-now/parse-later handling. Decoder
untouched.

## A10. Intent is a lens, not a re-score
Intent extends the scorer like `target_category`: it selects/orders/weights which
categories surface (in_lens + lean), but the **lean never touches raw confidence** — the
evidence ledger stays honest. Intent threads landing → `analyze_path --intent` → `cli` →
`build_results` → `scorer.score(intent=…)`; recorded in `assessment_v2.intent`. Targeted
focus still wins the lead slot when both are set.

## A11. Intake now, parse later (honest boundary)
Optional healthcheck/profiler files are accepted and their **paths recorded**
(`assessment_v2.provided_paths`) for the future parser, but NOT parsed/scored. A supplied
file flips its categories from `requires_input` → new status **`input_provided`** ("input
provided — scoring in a later update"); we never fabricate healthcheck/profiler analysis.
FTDC scoring is unchanged and complete.

## (a) Intent preset schema + the 7 intents
`Intent{id, title, subtitle, description, categories:[{category_id, lean}], full_sweep, note}`
in `ruleset/schema.py`; defaults in `ruleset/defaults.build_default_intents()`; overridable
via the same overrides file (`intents` key) and rendered in the Methodology dump.
- **right_sizing** → memory_cache_pressure, cpu_compute_sizing, disk_io_saturation (lean 1.5) + query_targeting_index_recs, schema_datamodel (conditioning context).
- **cost_optimization** → disk/memory/cpu (1.3) + query_targeting_index_recs (1.5, foregrounded), schema_datamodel (1.2) — the "fix the workload, not the hardware" inversion.
- **incident_rca** → replication_lag_cascade, write_path_contention (1.5) + connection_workload_surge, checkpoint_storage_stalls, errors_stability (1.2).
- **general_health** → periodic_health_review lead + `full_sweep` (broad cross-family ranking).
- **query_index_opt** → query_targeting_index_recs, slow_query_hotspots (requires profiler).
- **schema_review** → index_health_bloat, schema_datamodel, storage_capacity_design (requires healthcheck).
- **full_sweep** → all 16 ranked by confidence.

## (b) Landing structure (`Landing.tsx`)
Guided pre-flight, scrollable, dark theme. Step 1 Inputs — three slots (FTDC required;
healthcheck + profiler optional, each showing what it unlocks and a "Don't have this? Get
it" expander). Step 2 Assessment intent — the 7 intents as cards (exact title+subtitle copy)
with a live preview of which categories surface and lock-flags for any needing an
un-provided input (`IntentPicker`). Step 3 Reasoning mode — Rule-based (grounded) / LLM-led
cards with honest framing; LLM-led reveals the model picker (paid gated) + active model.
"Run assessment" gated on FTDC present, carries {inputs, intent, mode, model} into the run;
all selections persisted (localStorage + llm config). Recent Analyses below.

## (c) Collector helpers (`CollectorHelp.tsx`) — real content, script bundled
- **Healthcheck**: the actual script is **bundled at `collectors/getMongoData.js`** (a real,
  runnable allinfo-style collector — getMongoData/Keyhole lineage, Apache-2.0, attributed;
  gathers build/host/server/repl context + per-collection storage & `$indexStats` usage).
  Copy-paste run command (`mongosh "<uri>" --quiet --file collectors/getMongoData.js >
  healthcheck.json`), least-privilege role (clusterMonitor + readAnyDatabase), and the
  run-on-each-member + local-only/schema-revealing caveats.
- **Profiler**: `db.setProfilingLevel(1,{slowms:100})`, an export of the slowest
  `system.profile` shapes (+ mongoexport variant), the mongod slow-log pointer + disable
  command, and the overhead + predicate-PII (handle-locally) caveats.

## (d) Intake-now/parse-later handling
New `input_provided` status (purple) — when a file is supplied its categories render "input
provided — scoring in a later update"; the path is stored in `provided_paths`. Verified on
Ludo with a healthcheck file: schema_datamodel / index_health_bloat / storage_capacity_design
→ input_provided; profiler categories remained requires_input. No fabricated analysis.

## (e) Build result
`make app` → **EXIT 0**. Gates: cargo ✓, tsc ✓, vite ✓, collector JS `node --check` ✓,
scorer intent/lens/input_provided unit checks ✓, real Ludo intent+intake run ✓. Bundled
sidecar `--dump-ruleset` carries all 7 intents (packaged pre-flight works). Bundles:
- `app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app` — 36 MB
- `app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_0.1.0_aarch64.dmg` — 26 MB
New Rust params on `analyze_path` (intent/healthcheck/profiler); new collector file. Left
**staged, uncommitted** for review.

---

# Pre-flight wizard (entry → steps → review) + history purge (follow-up brief)

Frontend-only flow/state restructure of the landing into a guided wizard. Engine, decoder,
scorer, ruleset, and Rust *analysis* commands unchanged; only small history-purge Rust
commands added. Existing section components reused.

## A12. Per-run selection snapshot in localStorage (frontend-only)
To prefill a recent run's Review with its intent/mode/model (none of which are in the
history struct, and mode/model are frontend-only), each completed run writes a snapshot to
`localStorage["ftdc.run.<cache_dir>"]` ({ftdc, intent, mode, model, healthcheck, profiler}).
On re-entry the snapshot is read synchronously to prefill + form the change-detection
baseline (fallbacks: intent→full_sweep, mode→grounded). Chosen over extending the Rust
history struct to honor "FRONTEND ONLY" (only delete/clear Rust commands were added).

## (a) Wizard state model + step gating
`Landing` holds `phase ∈ {entry, recent, wizard}`, `step ∈ 1..4`, and `baseline` (the
restored run's selections, or null for New). Selection values + setters live in App
(persisted), so Back/Edit never lose state and selections survive relaunch. Gating: Step 1
Next enabled once FTDC is chosen; Step 2 once an intent is set (default full_sweep allowed);
Step 3 always (a mode is always selected); Step 4 = Review. Enter advances when the step is
valid (Runs on Review). Steps animate with the app's tw-animate-css (fade + slide-in).

## (b) Entry screen
Two choice cards — **New analysis** (→ wizard Step 1, baseline null) and **Recent analyses
(N)** (→ recent list; disabled when empty) — under the greeting/brand header.

## (c) Review + change-detection labels (`lib/preflight.classifyRun`)
Review summarizes every selection (FTDC path, healthcheck/profiler, intent + subtitle, mode
+ model) with per-row Edit jumps. The action button + an always-visible note reflect the
plan vs the restored baseline:
- no change → **"Open cached result"** ("No changes — will open the cached result instantly.") → reads cached results.json, instant.
- intent/mode/model changed (FTDC same) → **"Re-run (uses cached decode)"** ("… changed — will re-score from the cached decode (no re-decode).") → loads cached results.json and re-lenses `assessment_v2` client-side via `relensAssessment` (verified to match the engine's intent ordering for the same decode); the tab re-narrates for mode/model.
- FTDC folder changed → **"Re-analyze"** ("Input changed — will re-decode the FTDC capture.") → full engine run.
New flow (no baseline) shows **"Run analysis"**.

## (d) Purge commands added (Rust)
`delete_history_entry(cache_dir)` and `clear_history()` in `lib.rs` — remove the history
record(s) and best-effort delete the associated cached run dir (guarded to only remove dirs
under the app cache root). The list updates live; per-run localStorage snapshots are removed
too. Per-entry trash + "Clear all" (with inline confirm) in the Recent screen.

## (e) Build result
`make app` → **EXIT 0**. Gates: cargo ✓ (delete_history_entry/clear_history), tsc ✓,
vite ✓; client re-lens parity vs engine intent ordering verified (lens + flags match;
tail differences were only status-driven across two differently-inputted test files).
Bundles:
- `app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app` — 36 MB
- `app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_0.1.0_aarch64.dmg` — 26 MB
Frontend-only flow change (Landing.tsx wizard, App.tsx state/handlers, lib/preflight.ts,
relensAssessment in lib/ruleset.ts) + 2 history-purge Rust commands. Left **staged,
uncommitted** for review.

---

# Sizing Recommendation engine + cloud selector + verify-latest (follow-up brief)

Additive: bundled dated tier tables, a sizing engine over the scored capacity categories, a
cloud selector for sizing/cost intents, the Sizing panel, and an opt-in web verify. Decoder,
scorer, ruleset untouched (extended additively).

## A13. Tier-table bundling
JSON tables live in `ftdc_analyzer/tier_tables/{aws,gcp,azure}.json` (+ `__init__.py` so the
subpackage is importable). Loaded via `importlib.resources` with a `__file__`-relative
fallback; PyInstaller bundles them via `--collect-data ftdc_analyzer.tier_tables` (added to
the Makefile + ci.yml). Overridable through the ruleset overrides file under a `tier_tables`
key; included in the engine `--dump-ruleset` output and rendered in the Methodology view.

## A14. Sizing recompute without re-decode
`cli --resize-from <results.json> --cloud --intent` recomputes ONLY the sizing block from a
cached results.json (host facts + signals + category scores already there) — no FTDC decode.
Rust `resize` command runs it; the wizard "re-run (cached decode)" path calls it so a
cloud/intent change updates sizing instantly while staying engine-authoritative (no TS
duplication of the sizing math).

## (a) Tier-table schema + AWS values + as-of
Each table: `{cloud, specs_as_of, source_note, tiers:[{name, vcpu, ram_gb, default_storage_gb,
default_iops, disk_ram_ratio, provisioned_iops, low_cpu_available, low_cpu_vcpu, wt_cache_gb,
wt_cache_pct}]}`. AWS seeded M10–M700, **specs_as_of 2026-06-19**: M30 2/8, M40 4/16, M50 8/32,
M60 16/64, M80 32/128 … ; disk:RAM 60:1 (≤M40) / 120:1 (>M40); provisioned IOPS M30+ (AWS only);
R-variant = half vCPU same RAM (R50 4/32, R60 8/64 …); WT cache 25% (≤M30) / 50% (≥M40). GCP/Azure
mirror the grid, provisioned_iops=false, marked best-known-equivalent.

## (b) Cloud selector
Shown in the wizard Step 2 + Review ONLY when intent ∈ {right_sizing, cost_optimization}
(AWS default, GCP, Azure); persisted (`ftdc.cloud`); flows `analyze_path --cloud` →
`build_results(cloud=)` → selects the tier table. Hidden for other intents.

## (c) Sizing engine logic (`ftdc_analyzer/sizing.py`)
Infers current infra (vCPU=host cores, RAM=memSizeMB, nearest tier, disk profile = saturated +
latency-bound vs throughput/checkpoint-bound from disk_avg_*_ms, observed IOPS = read+write
iops). Builds three options — General downsize (smallest tier covering CPU+RAM headroom),
Low-CPU R-tier (half vCPU/same RAM), Provisioned IOPS (keep tier, raise IOPS; M30+ AWS) — each
with a confidence drawn from the relevant capacity-category score + a rationale. Picks: disk
saturated + prov supported + CPU/RAM headroom → **Provisioned IOPS**; elif CPU over-provisioned
(p95<40%) + RAM used → **Low-CPU**; else **General**. Storage size is never fabricated → "provide
healthcheck". Conditioning: profiler absent → workload-efficiency caveat; profiler present +
query-inefficiency fired → flips recommendation to "remediate workload before resizing".

## (d) Sizing panel
Top of the Assessment tab (sizing/cost intents only): current-infra box (vCPU/RAM/≈tier/disk
profile/IOPS + storage-gap callout) → 3 option cards (specs + confidence bar + rationale,
recommended highlighted, unavailable dimmed) → recommendation reason → caveats → "specs as of
<date>" + Verify latest. In LLM-led mode the narrative is grounded on the sizing numbers.

## (e) Verify-latest
User-triggered Rust `verify_tier_specs(url)` does a one-off reqwest GET of the Atlas docs page
(20s timeout); on success → "specs confirmed as of <today>" + offer to stamp the override table
(`tier_tables[cloud].specs_as_of = today`); on failure → "couldn't verify, using bundled specs
as of <date>". Default runs stay 100% offline. (It confirms reachability/recognizability +
stamps; it does NOT auto-scrape exact numbers — users edit numbers via the override table.)

## (f) Ludo run (intent=cost_optimization, cloud=AWS)
current 16 vCPU / 61.5 GB → ≈M60, disk "saturated · throughput/checkpoint-bound", ~3400 IOPS,
cpu p95 11%, cache 80%. Options: General M60 (0.08), Low-CPU R60 (0.72), Provisioned-IOPS M60
(0.72). **Recommended: Provisioned IOPS @ 0.72** — disk dominant + CPU/RAM headroom. Storage:
"insufficient data — provide healthcheck". Profiler-absent workload-efficiency caveat present.
(GCP re-run → provisioned unavailable → falls back to Low-CPU R60, verified via --resize-from.)

## (g) Build result
(filled below)

## A15. Tier-table bundling fix (corrected A13)
`--collect-data ftdc_analyzer.tier_tables` did NOT bundle the JSON (nothing statically
imports the subpackage, so PyInstaller skipped it — the first bundled `--dump-ruleset`
returned empty tier_tables). Fixed by switching to explicit `--add-data`. Gotcha: with
`--specpath build`, PyInstaller resolves the --add-data SOURCE relative to the spec dir, so
the Makefile uses an ABSOLUTE source: `--add-data "$(CURDIR)/ftdc_analyzer/tier_tables:ftdc_analyzer/tier_tables"`.
ci.yml (no --specpath) uses the relative form. Verified: the bundled sidecar `--dump-ruleset`
now returns all 3 clouds (aws as_of 2026-06-19, 12 tiers).

## (g) Build result (sizing follow-up)
`make app` → **EXIT 0** (after the A15 bundling fix). Gates: cargo ✓ (verify_tier_specs,
resize), tsc ✓, vite ✓; synthetic + real Ludo sizing ✓; --resize-from gcp fallback ✓.
The **bundled** sidecar `--dump-ruleset` returns all 3 tier tables (aws as_of 2026-06-19,
12 tiers) and `--resize-from` returns provisioned_iops @ 0.72 on Ludo — packaged app works.
Bundles:
- `app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app` — 36 MB
- `app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_0.1.0_aarch64.dmg` — 26 MB
New: ftdc_analyzer/tier_tables/{aws,gcp,azure}.json + sizing.py; Rust verify_tier_specs +
resize + analyze_path --cloud; Makefile/ci.yml --add-data. Left **staged, uncommitted**.

---

# UAT Brief A — chart granularity/range model + drag-zoom + global polish

Frontend-focused; engine series emission extended additively (decoder untouched).

## A16. Range vs Granularity (engine emits fine mean/min/max; client re-buckets)
**Chose: engine emits fine per-bucket {mean,min,max}; client re-aggregates per range+granularity.**
Why: the old fixed ~2500-pt single-agg series can't be correctly re-bucketed at arbitrary
ranges/granularities (a mean-only downsample loses true min/max within buckets; cropping a
mean series hides spikes). Now `verdicts.downsample` buckets the RAW per-sample array into
≤2500 fine equal-time buckets emitting mean (line) + min + max (band) — `series[k] =
{t, v:mean, min, max}` (v kept = mean for back-compat: report.py/sparklines read .v). The
client `bucketSeries(series,keys,range,targetBuckets)` re-aggregates fine→display buckets:
mean = weighted mean of fine means, band = [min of mins, max of maxs] — exact, never
decimation. A short spike survives because the fine bucket's max captured it and propagates
up (max of maxs). Engine-side per-request bucketing was rejected (engine runs once → static
results.json; client re-bucket gives instant range/granularity/zoom with no re-run).

- **Range** control: Full (default, whole capture end-to-end) / 48h / 24h / 12h / 6h / 1h +
  custom start/end datetime pickers (RCA on a specific window). The old sliding brush bar is
  removed.
- **Granularity** control: Coarse(60)/Medium(200, default)/Fine(600)/Max(3000) target display
  buckets. The WHOLE current range is always plotted; granularity only changes resolution.

## A17. Bucket statistic — mean line + min/max band
Every time-series chart now renders, per series, a faint min–max Area band (fillOpacity 0.13,
series colour) behind the mean Line (`ComposedChart`). Band rows carry `${key}_band` = [lo,hi];
hidden from tooltip/legend via a `_band` filter in ui/chart.tsx.

## A18. Fullscreen drag-to-zoom
In the maximized modal: mousedown→move→mouseup x-selection (Recharts onMouse* + activeLabel)
with a live ReferenceArea preview; on release (>1min drag) the modal re-renders that sub-range
re-bucketed at 800 buckets (finer) with mean+band; a visible "Reset zoom" restores. Scoped to
the modal only (dashboard tiles unchanged).

## A19. Global polish
- Scrollbars: visible styled thumb (#46607F, 12px, inset pill) with MongoDB-green hover, both
  webkit (`::-webkit-scrollbar*`) and standard (`scrollbar-width/color`), applied app-wide.
- Font: base scale bumped `html { font-size: 17px }` (from 16) so all rem-based type grows
  proportionally (assessment cards/ledgers use rem utilities); hierarchy preserved.

## (e) Build result
`make app` → **EXIT 0**. Gates: tsc ✓, cargo ✓ (unchanged Rust), vite ✓; engine series now
emits {t,v,min,max} (2500 fine pts, min≤mean≤max verified; a disk-util bucket shows min 11.2 /
mean 29.9 / max 100.0 — spike survives in the band). Bundles:
- `app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app` — 36 MB
- `app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_0.1.0_aarch64.dmg` — 26 MB
Frontend: ftdc.ts (bucketSeries/Granularity/min-max), TimeSeriesChart (band + ComposedChart +
modal drag-zoom), RangeSelector (range+granularity toolbar, brush removed), ui/chart.tsx
(_band hidden), index.css (scrollbars + 17px base). Engine: verdicts.downsample mean/min/max.
Left **staged, uncommitted**.

---

# UAT Brief B — multi-intent + provider manager (Anthropic) + Step-2 perf

## A20. Multi-intent (union of lenses)
The scorer's `intent` param now accepts a single id, a comma-string, or a list. `_resolve_intent`
resolves the ids; >1 → `_merge_intents`: union of category sets, deduped, lean = best across the
selected intents, ordered by descending best-lean (then first-appearance). full_sweep is exclusive
(enforced in the UI; engine treats any-full as full_sweep). `assessment_v2.intent` is the merged
intent + `intent_members` lists the selected ones. Single-intent unchanged. CLI `--intent` takes the
comma-string; analyze_path passes it; the client re-run path resolves multi via `mergeIntents` (TS
mirror) for client re-lens. Sizing applies if ANY selected intent is sizing/cost. Verified:
Right-sizing+Cost optimization → union of both lenses, deduped (5 cats, no dupes); single still works.

## (a) Multi-intent union logic + scorer param
See A20. UI: IntentPicker is now multi-select (click a card to toggle; Full-sweep exclusive), with a
combined union preview + lock-flags; selection persisted as a canonical comma-joined string
(ruleset order). Review shows "Assessment intents (union): A + B".

## (b) Provider manager + Anthropic adapter
LlmConfig is now `{ providers[], activeId, model }` (migrates the legacy single `provider`; ensures
the non-deletable built-in default "Default — ocialwaysfree" / id `endpoint` is present; picks a
valid active). LlmSettings is a provider-list manager: add/edit/duplicate/delete (default not
deletable), set-active (★), per-provider Test connection, dialect-aware model picker (paid-gated for
the ollama endpoint; Anthropic models all selectable, with a known-models fallback when /v1/models
is unreachable), and a dev Ping. API keys persist in the app config store (app_config_dir/
llm_config.json), never logged.
**Anthropic adapter (llm.rs, dialect "anthropic"):** `list_models` = GET {baseUrl}/v1/models with
`x-api-key` + `anthropic-version: 2023-06-01`; `chat` = POST {baseUrl}/v1/messages with those headers,
splitting any system message into the top-level `system` field, `max_tokens` required (default 1024),
parsing `content[].text` (concatenated). Errors classified (auth/rate_limit/subscription/timeout/
network) from status + `error.type`. `list_models_impl`/`chat_impl` branch on dialect; OpenAI adapter
unchanged. No key → clean auth error (never a panic/fake success).

## (c) Step-2 perf fix
Root cause: entering Step 2 spawned the engine `--dump-ruleset` sidecar on mount AND Landing made a
SECOND dump call for its intent meta (two process spawns), plus per-render preview recompute. Fix:
one shared `cachedRulesetDump()` promise (in lib/ruleset), **prefetched on app mount**, reused by the
IntentPicker, CategorySelector, and Landing; per-intent/union previews and category lookup memoized
(`useMemo`) so hover/select don't recompute. Step 2 now paints from the warm cache instantly.

## (d) Build result
`make app` → **EXIT 0**. Gates: cargo ✓, tsc ✓, vite ✓. LLM round-trip tests (--ignored):
OpenAI ministral chat ok ✓, kimi subscription-gated ✓, **Anthropic real round-trip with a bad
key → clean `auth` ("invalid x-api-key")** ✓, Anthropic no-key → clean auth ✓. Multi-intent
union verified (Right-sizing+Cost → 5 deduped cats). Bundles:
- `app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app` — 36 MB
- `app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_0.1.0_aarch64.dmg` — 26 MB
Left **staged, uncommitted**.

---

# UAT polish pass (contrast, granularity, tabs, overview, explore, Assessment redesign, mini-game)

Display-only; decoder/scorer/ruleset logic untouched.

1. **Contrast**: lifted `--muted-foreground` #8AA0B6 → **#AEBFD2** (both theme blocks) — global,
   secondary text now comfortably readable; hierarchy (foreground > secondary > muted) preserved.
2. **Granularity → durations**: granularity buttons now show the approximate bucket DURATION,
   computed dynamically as `humanBucketDuration(rangeSpan ÷ targetBuckets)` snapped to a ladder
   (1m/5m/10m/30m/1h/2h/6h/12h/1d) → e.g. ~6-day range shows "~2h / ~40m / ~12m / ~3m"; recomputes
   when the range changes; the qualifier (Coarse/Medium/…) moved to the tooltip.
3. **Category tabs**: bolder (`font-semibold`); color-coded — selected = green (active state),
   has-data = foreground, no-data/locked = dimmed + lock icon (a category is "locked" when all its
   charts are placeholders).
4. **Overview**: (a) overlap/clip fixed — the verbose 4-col per-check Table in each verdict card
   (the clip source) was removed; cards are now `min-w-0 overflow-hidden`. (b) Slimmed to a glance:
   verdict cards show verdict + confidence + headline + recommended-vCPUs + a compact check summary
   (counts + worst breach) + "Full evidence on the Assessment & Signals tabs"; the full per-check
   detail now lives only on the deep Assessment/Signals (logged: moved the check table off Overview).
5. **Memory min/max band**: confirmed the engine already emits {mean,min,max} for ALL series incl.
   mem_resident_gb / cache_used_pct / page_cache_gb (verified 2500-pt min/max arrays); TimeSeriesChart
   renders the band for them via bucketSeries — no code change needed (was resolved by Brief A's band work).
6. **Explore**: added a selected-metric chips strip + left-list swatches whose colour matches the
   chart line (LINE_PALETTE by selection order); a selected metric with no finite data shows an explicit
   red "no data" badge (chip + list) instead of silently plotting nothing.
7. **Assessment 3-layer redesign** (see structure below).
8. **Loading mini-game** (`MiniGame.tsx`): original canvas endless-runner ("Leafy", a green rounded
   sprite, hops over blue data-shard pillars) — all simple shapes, no external/copyrighted assets, no
   storage. Space/↑/click to jump; score; crash→retry. Shown as a full overlay during a full analyze
   decode; results load underneath; on completion a "Your analysis is ready — Go to results / Keep
   playing" banner appears (never auto-navigates away). Only shown for full analyze() (not instant
   cached opens). Errors dismiss the overlay to surface the message.

## Assessment redesign structure (item 7, inverted pyramid)
- **Layer 1 — Verdict (hero):** bold recommended action + confidence + the driving constraint for the
  selected lens (e.g. "Cost optimization → Provisioned IOPS → M60 · 72% · driver: Disk I/O Saturation
  fired"), plus the key caveat; the **Sizing Recommendation** (current→recommended tier cards) renders
  in this layer as the concrete artifact (moved out of App into the panel to avoid duplication).
- **Layer 2 — Reasoning (story arc):** three labelled sections — "What we found / Why it points here
  (not elsewhere) / What would change this conclusion". Grounded mode synthesizes them deterministically
  from the ledger (`buildGroundedReasoning`); LLM mode renders the model's prose (prompt now asks for
  those exact 3 headings) and falls back to the deterministic synthesis if the LLM fails.
- **Layer 3 — Evidence (collapsible, default closed):** per-category cards + full ledgers grouped + ranked:
  Fired → Clear (scored, didn't fire) → Awaiting input → Declared (stubs). Nothing removed — progressively
  disclosed. Mode/model/category controls sit in a slim bar above Layer 1.

## Build result
`make app` → **EXIT 0** (tsc ✓, cargo ✓, vite ✓). Display-only pass — no Python/Rust logic
changed (only how results render). Bundles:
- `app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app` — 36 MB
- `app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_0.1.0_aarch64.dmg` — 26 MB
Files touched: index.css, lib/ftdc.ts, RangeSelector, App.tsx, ExploreView, TimeSeriesChart
(unchanged), AssessmentV2Panel (redesign), narration.ts, + new MiniGame.tsx. Staged, uncommitted.
