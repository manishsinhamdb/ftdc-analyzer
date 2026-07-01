# FTDC Analyzer — Deep-Audit Context & Plan (resume in a new chat)

**Purpose:** Hand a fresh Claude session everything needed to run a systematic audit for
*subtle correctness bugs* across three subsystems of Manish's FTDC analyzer. Two known bugs
were already fixed and committed (see §2); this audit was triggered because one of them
(epoch-as-lag) was a value that looked sane (20s) for 8 days while masking a 1.78-billion-second
artifact. That class of bug — **structurally valid but semantically wrong** — is the target.

Paste this whole file into a new chat and say: *"Resume the FTDC analyzer deep audit per this plan."*

---

## 0. Working method (C.H.A.I.N. — strict)

- **Roles:** Manish = Operator (runs commands on his Mac, pastes full output). Claude =
  Controller (one action per turn, State Block on top of every reply, never assume a filename —
  confirm by reading it).
- **State Block** every turn: Project / Phase / Step / Status / Last Output Analysis / Project
  Variables.
- **Commands:** Manish is already in the repo root on his Mac. Give ONE paste-and-run block per
  turn. Python edits are written to disk via a `python3 - <<'PYEOF'` splice with `assert`
  guards + a `.bak` backup + a `py_compile` check — NEVER paste Python at the zsh prompt, and
  never hand-edit. Shell `#` comments echo harmlessly; keep them out of command position.
- **Claude can READ the public repo** via raw URLs
  (`https://raw.githubusercontent.com/manishsinhamdb/ftdc-analyzer/main/<path>`) but the GitHub
  API tree and arbitrary raw paths are bot-gated — so the Operator's local clone is the source
  of truth. Use `grep -n` / `sed -n` to surface exact line ranges before editing.
- **Claude CANNOT commit/PR.** Deliverables = corrected file contents written to Manish's clone;
  he commits.
- **The audit method that works** (it caught Bug 1): read the REAL code, RUN it against the REAL
  capture via `.venv/bin/python3`, and hunt the gap between *what the number says* and *what is
  physically true on the box*. Empirical, not code-reading alone. Prefer `p99`/`max`/sample-count
  probes on the real arrays over trusting summaries.
- **Style:** direct, high-velocity, depth over placeholders, honest "this is a judgment call"
  over a silent change. For Track C especially: FLAG AND DISCUSS design choices; do not
  auto-tune thresholds/stats without Manish's explicit decision. Do NOT reframe a real signal
  into "expected" just to match a prior expectation (the cascade firing on REAL 10–20s lag is
  correct, not a bug — see §2).

---

## 1. Environment & real assets

- **Repo / clone:** `manishsinhamdb/ftdc-analyzer` (PUBLIC). Clone at
  `/Users/manishsinha/Desktop/projects/ftdc-analyzer` (macOS case-insensitive; Python may
  resolve `Projects` with a capital P — same dir). IGNORE `vinodkrishnan23/ftdc-analyzer`
  (unrelated).
- **Interpreter:** `.venv/bin/python3` (numpy 2.4.6). The Makefile uses `PY := .venv/bin/python`.
  Bare `python3` has NO numpy — always use the venv for running engine code.
- **Branch:** `fix/repl-lag-sanity-and-txt-intake`, baseline commit **33a1961** (the two fixes).
  Do the audit on this branch (or a child of it).
- **THE REAL CAPTURE** (oci-p PRIMARY, MongoDB 8.2.11 Enterprise→ actually reports 8.2.11,
  4 cores, 23.4 GB, ~694,206 samples, 8-day window 2026-06-16 → 2026-06-24, spanning a
  CE→Enterprise rolling upgrade + encrypted resync mid-window):
  - FTDC dir: `/Users/manishsinha/Desktop/Projects/healthcheck/diagnostic.data` (21 files)
  - getMongoData (v2.x ARRAY schema, 282 records, 99,493 lines): `.../getMongoData-ocip-20260624-100012.txt`
  - sh.status (2-line unsharded notice, plain text): `.../shardstatus-ocip-20260624-100219.txt`
  - profiler (JSON): `.../queryprofiler-ocip-enablement-20260624-105552.json`
- **`.bak` files** are gitignored now; each edit leaves a `<file>.py.bak` revert point locally.

---

## 2. What is ALREADY FIXED (committed 33a1961 — do NOT re-litigate)

**Bug 1 — replication-lag epoch-as-lag.** Root cause: `metrics.derive()` computed
`repl_lag_s = (primary_optime − stalest_member_optime)/1000`; a member with `optimeDate == 0`
(freshly resynced / restarting / INITIALIZING) made the stalest = 0, so lag ≈ a Unix epoch
(~1.78e9 s). Fix (in `metrics.py`): treat optimeDate≤0 as INVALID (NaN), exclude from per-member
AND aggregate, cap valid lag at `min(capture_span, 48h)`, aggregate via `np.nanmax` over valid
members → all-NaN ⇒ n/a (never 0, never epoch). Surfaced `_repl_lag_invalid_samples/_total/_ceiling_s`
diagnostics. In `verdicts.py`: made `_stats()` scalar-safe (the diagnostics are scalars), and
attached an honest "initializing members" caveat to the `replication_lag_cascade` ranked entry
when invalid samples were dropped (FTDC `build_results` path only — site B, the one followed by
the "Sizing Recommendation" comment; NOT the healthcheck-only assembler). Validated: `repl_lag_s`
max **1,782,261,710 → 20.0s** on the real capture.

**IMPORTANT nuance (don't "fix" this):** On the full 8-day capture there are **0 invalid
samples** — the epoch came from a different/transient state; this window's lag is REAL: 85,709
nonzero-lag samples, p95=10, p99=12, max=20, mean=1.24, ~1.2% of samples >10s. The
`replication_lag_cascade` rule consequently FIRES at conf 0.55 (repl_lag_s>10 @ `max`=20 → 0.40,
+ oplat_write_ms p95 23.29>20 → 0.15). **This is CORRECT behavior on real mild lag, not a false
alarm.** Whether the lag signal should read `p99` instead of `max` (so it keys on *sustained*
lag, not a single 20s sample) is an OPEN Track-C tuning question, deliberately left for Manish to
decide — it was NOT changed.

**Bug 2 — format-tolerant intake.** `inputs/_sniff.py` (new) classifies a file as
`json_object | json_array | text` by content. `healthcheck.parse_healthcheck` now accepts the
getMongoData **v2.x array-of-section-records** schema (a new `_adapt_getmongodata_v2()` reshapes
it into the v0.11 object `_build()` consumes — server/host/serverStatus, per-collection
collStats+getIndexes+$indexStats grouped by a contiguous `collection_stats_(mb) → indexes →
index_stats` triple anchored on `indexes.commandParameters.db` + `index_stats.cursor.ns`,
collStats MB→bytes), in addition to the original v0.11 object. `inputs/sh_status.parse` treats the
"not a mongos / sharding not enabled" text as the FINDING (`{enabled:false,
topology:"replica_set"}`, available=False) instead of raising. Validated end-to-end on the real
inputs: no parse-skip notes; 8 categories scored incl. the 3 structural; correct topology
(rs0, 3 data-bearing — N150 pri 0.1 / OCI-P pri 2.0 / OCI pri 1.0); unsharded finding clean.

---

## 3. Architecture map (verified by reading the code)

Tauri v2 desktop app; Python engine + React/TS UI + Rust shell. Engine package `ftdc_analyzer/`:

- **`decoder.py`** — FTDC binary decode. BSON framing (`zlib.decompress(B[4:])`), type-0 metadata
  vs type-1 metric chunks, column-major RLE delta reconstruction, `uint64` cast → `int64`
  (`MASK64`), `_parse_chunk`, `_reconstruct`, `decode_directory(keep_paths=…)`, zero-fills absent
  keep-set paths.
- **`metrics.py`** — `extract()` (decode + role/data-disk detection) and `derive(ex)` → `sig`
  dict of ~90 derived signals (rates/gauges/ratios) each aligned to `samples[1:]` via `dt_s`.
  Also `build_metrics_full()` (online equal-time bucketing into n_points, emits per-bucket
  mean+min+max for the charts), `_summ()`, `category_for()`. Curated keep-set in `_build_curated`.
- **`verdicts.py`** — `build_results()` (FTDC spine) + `build_results_healthcheck_only()`.
  `_stats(arr)`→{p50,p95,p99,max,mean}; legacy capacity verdicts (`verdict_ram/cpu/disk`);
  `build_insights`/`build_extra_insights`; `_assemble_assessment()` calls the scorer; merges
  evidence-input dispatch; sizing. `sig_stats = {label:_stats(arr)}` at ~L1033.
- **`scorer.py`** — Layer-2 deterministic two-pass scorer. `_stat_value(sig_stats,path,stat)`
  (fallback stat→p95→max→mean→None), `_eval_signal` (None value ⇒ passed=False/contrib 0;
  disambiguator enable/suppress/scale gated on a co-signal stat), `_score_category`
  (confidence = clamp01(Σcontribution ÷ Σpositive weights)), `_category_pass1`
  (disabled/requires_input/input_provided/stub/scored), pass-2 conditioning (swap conditional
  recommendation when a conditioning category fired; attach honest caveat when its input absent).
- **`ruleset/`** — `schema.py` (Category/Signal/Disambiguator/Intent dataclasses),
  `defaults.py` (the 16 categories: 5 DEEP capacity/incident + structural + stubs; `_S` signal
  helper, `_D` disambiguator, `_ic` intent; `replication_lag_cascade` at ~L197), `overrides.py`.
- **`healthcheck.py`** — getMongoData parser (now multi-schema). `_x`/`_num`/`_get` Extended-JSON
  helpers, `_index_rows` (per-index name/key/ops/size/unique + `_flag_redundant` prefix &
  name-shadow), `_block_compressor`, `_build(raw)` → report/scoring_stats(`hc_*`)/structural/
  sizing/host. `_adapt_getmongodata_v2()` + `parse_healthcheck()` (sniff-routed).
- **`inputs/`** — evidence-input framework. `registry.py` (5 inputs: ftdc/healthcheck/profiler/
  sh_status/rs_status; `format`, `parser`, `unlocks`, collector), `__init__.py` (`dispatch()` →
  `DispatchResult{sig_stats,reports,available,enrichers,notes,parsed,sizing}`; resolves parsers
  via importlib; a raising parser ⇒ note+skip), `healthcheck_input.py` (adapter→healthcheck),
  `sh_status.py`, `rs_status.py`, `_sniff.py` (new).
- **`report.py`** (HTML export, 4-section), `cli.py`, `sizing.py` (tier tables + sizing engine),
  `tier_tables/{aws,gcp,azure}.json`. Rust shell in `app/src-tauri/`; React UI in `app/src/`
  (TimeSeriesChart, RangeSelector, AssessmentV2Panel, ExploreView, HealthcheckReport, etc.).
- Full multi-phase build history is in **`LAYER2_BUILD_NOTES.md`** (authoritative layout map).

---

## 4. THE AUDIT — run A → B → C (each layer's correctness underpins the next)

For every suspected issue: (1) state the hypothesis, (2) read the exact code, (3) RUN it on the
real capture via `.venv/bin/python3`, (4) show the number-vs-physical-truth gap, (5) only then
fix (Track A/B) or flag-for-decision (Track C).

### Track A — Decode & intake correctness
Does data entering the app faithfully represent the source bytes?
Hypotheses to test:
- **A1 (cross-cutting, HIGH priority): counter resets across the CE→Enterprise upgrade +
  encrypted resync mid-capture.** Every cumulative counter (opcounters, network bytes, WT cache,
  asserts) almost certainly reset to 0 at the restart. Verify `delta()`/`rate()` in `metrics.py`
  handle the 5e9→0 drop as NaN (the `np.where(dv<0, np.nan, …)` guard) and do NOT emit a spurious
  spike — AND that a reset doesn't corrupt downstream percentiles. Check what the chart shows at
  the restart boundary. This single event can quietly distort many Track-B signals.
- **A2: uint64→int64 cast** (`decoder.MASK64`, `.view(np.int64)`) — any genuine value >2^63
  becomes negative. Are there such paths (e.g. large byte counters)? Do they then feed a rate?
- **A3: zero-fill of absent keep-set paths** — `decoder` fills missing paths with zeros; a metric
  that is genuinely absent vs constant-zero is conflated. Where does this mislead a signal/verdict?
- **A4: schema drift across chunks** in `build_metrics_full` (`_grow`, reduceat groups) — a path
  appearing mid-capture; column reindexing correctness.
- **A5: the v2.8.3 adapter (just written)** — re-scrutinize the MB→bytes scaling, the per-coll
  triple pairing when a collection has no `index_stats` row, timeseries collections, and the
  `oplog window not present` gap (replicationInfo empty → does anything divide by it?).
- **A6: rs.status / profiler parsers** — rs_status measured-lag math; profiler is intake-only.

### Track B — Metrics derivation & charting (range / granularity / drag-zoom)
Two linked questions: is each derived signal correct, and does the chart show the TRUTH when
range+granularity change?
Hypotheses:
- **B1: the `[1:]` alignment + `dt_s`** — every signal is sliced `[1:]` to align with the n−1
  deltas. Off-by-one or misalignment between gauges (sliced) and rates (already n−1) would shift
  series vs time. Verify a known event lands at the right timestamp.
- **B2: re-bucketing fidelity** (the big one). Build notes A16–A18: engine emits fine per-bucket
  {mean,min,max} (≤2500), client `bucketSeries` re-aggregates to display buckets (mean = weighted
  mean of means; band = min-of-mins / max-of-maxs). Verify on real data that (a) a true spike
  survives at every granularity (max propagates), (b) cropping a range recomputes from fine
  buckets (not decimation), (c) drag-zoom re-buckets the sub-range correctly, (d) the displayed
  value at a point matches the raw samples in that window. The repl-lag lesson applies: a
  mean-of-means that flattens a real spike is exactly this class of bug.
- **B3: rate vs gauge vs ratio correctness** — `rate()` (dv/dt, NaN on reset), `ratio_pct`
  (den≤0 → NaN), `safe_ratio`, the cpu/total composition, `disk_util_pct` min(…,100) clamp,
  ticket-util ratios. Spot-check each family against raw counters.
- **B4: percentile honesty** — `_summ`/`_stats` use nan-aware percentiles; confirm an all-NaN or
  thin series can't masquerade as a real value (this is what the repl-lag `max` exposed).
- **B5: `build_metrics_full` mean** — `SUM/CNT` per bucket vs the fine-array mean; min/max via
  `reduceat`. Confirm the charted mean equals the true bucket mean.

### Track C — Scoring logic & conditioning (BRAINSTORM — flag, don't silently change)
Design soundness, not just code correctness.
Topics:
- **C1: stat choice per signal** — `repl_lag_s` reads `max` (one worst sample fires it; live
  example). Audit ALL signals: which read `max` and could fire on a single blip vs which need
  sustained elevation (`p95`/`p99`)? Propose a principled policy; let Manish decide per signal.
- **C2: disambiguator gating** — e.g. disk_util in the cascade is enable-gated on `repl_lag_s>5`.
  With repl_lag now possibly n/a, does the gate behave correctly? Enumerate all disambiguators and
  check each gate's co-signal still resolves sanely post-Bug-1.
- **C3: confidence normalization** — `clamp01(Σcontribution ÷ Σpositive weights)`. Does the
  denominator (sum of positive weights) make a category with one dominant signal fire too easily?
  The cascade hit 0.55 from 0.40+0.15 over denom 1.0. Is the fire_threshold (0.4) right per family?
- **C4: cross-category conditioning** — capacity ← schema_datamodel/query_targeting; the
  schema-flip that resolves the capacity "provide healthcheck" caveat. Verify the conditioning
  graph has no contradictions and the pass-2 swaps are correct on the real both-inputs run.
- **C5: structural `hc_*` signals** — thresholds for unused-index / reclaimable / redundant /
  data÷cache / on-disk÷RAM / compression. Are they meaningful at this box's scale (e.g. 64 unused
  indexes on mostly sample DBs)? On THIS capture index_health/storage previously hit conf 1.0 —
  check whether that's real or threshold-saturation.
- **C6: capacity verdicts (legacy `verdict_ram/cpu/disk`)** vs the Layer-2 scorer — two parallel
  systems; do they ever contradict on the same capture? Which is authoritative in the UI?

---

## 5. Suggested first moves for the new chat
1. Confirm branch + baseline (`git log --oneline -3`; expect 33a1961) and that `.venv/bin/python3`
   imports the engine.
2. Track A1 first (counter-reset across the upgrade/resync) — highest-yield, touches everything.
   Run `metrics.derive` on the real dir and inspect rate signals across the restart boundary
   (find the sample index where uptime/opcounters reset; check the deltas there).
3. Proceed A→B→C, one hypothesis per turn, each proven on the real capture before any change.
4. Keep a running findings log; commit Track A and Track B fixes in logical batches; for Track C,
   produce a decisions memo for Manish rather than auto-applied edits.

## 6. Open item carried from the fix work
- `replication_lag_cascade` lag signal stat = `max` vs `p99` (C1) — Manish to decide.
- Bundled-sidecar rebuild (`make app`) + GUI click-through are NOT done here (engine-only work);
  any chart-related Track-B fix ultimately needs a `make app` + human eyes on the UI.
