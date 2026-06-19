# FTDC Analyzer — Architecture & Internals

*A top-to-bottom guide for Solutions Architects and TSEs who want to understand, trust, defend, and extend this tool.*

**Audience:** fellow SAs/TSEs who will run this in front of customers and need to explain *how* a number was produced and *why* a recommendation is what it is.
**Scope:** how MongoDB diagnostic data is decoded, how the time-series is bucketed (and why that changes interpretation), how the scoring/ruleset/conditioning logic turns raw signals into named findings, how the Atlas sizing engine picks a tier, and how the getMongoData healthcheck is parsed into the same model.

> **One-line mental model.** The tool takes two kinds of customer evidence — the **FTDC capture** (a time-series "heart monitor" of how the cluster behaved) and the **getMongoData healthcheck** (a structural "X-ray" of what the data, indexes, and config *are*) — decodes them natively (no `mongod` required), reduces them to a fixed vocabulary of **signals**, scores those signals through a **declarative ruleset** into **categories**, lets categories **condition** each other (so "scale up" can flip to "fix the workload"), and synthesizes a **sizing recommendation** and a **narrative**. Everything is reconstructable from an evidence ledger; the LLM only narrates a pre-computed result, it never invents numbers.

---

## 0. Table of contents

1. [Design principles](#1-design-principles)
2. [System shape (the layers)](#2-system-shape-the-layers)
3. [FTDC on disk: the native BSON decode](#3-ftdc-on-disk-the-native-bson-decode)
4. [From raw samples to metrics](#4-from-raw-samples-to-metrics)
5. [Granularity & bucketing — and why it changes interpretation](#5-granularity--bucketing--and-why-it-changes-interpretation)
6. [The signal layer](#6-the-signal-layer)
7. [The ruleset (declarative)](#7-the-ruleset-declarative)
8. [The scorer (two-pass, conditioned)](#8-the-scorer-two-pass-conditioned)
9. [Intents — a lens over categories](#9-intents--a-lens-over-categories)
10. [The Atlas sizing engine](#10-the-atlas-sizing-engine)
11. [The healthcheck (getMongoData) parser](#11-the-healthcheck-getmongodata-parser)
12. [Co-primary inputs](#12-co-primary-inputs)
13. [The LLM narration layer](#13-the-llm-narration-layer)
14. [Trust, honesty & failure modes](#14-trust-honesty--failure-modes)
15. [How to extend it](#15-how-to-extend-it)
16. [Glossary](#16-glossary)

---

## 1. Design principles

These are the non-negotiables the whole codebase is built around. If you understand these five, the rest follows.

1. **Deterministic core, optional narration.** The scorer is pure and reproducible: the same inputs always produce the same scores and the same evidence ledger. The LLM is *only* a storyteller over that ledger — it is never in the causal path of a number. You can run the entire tool with no model and lose nothing but prose.
2. **Every number is reconstructable.** Each category verdict carries an **evidence ledger**: which signals were checked, their values, the thresholds, whether each fired, and its contribution to the score. An SA can defend any output line-by-line to a skeptical customer.
3. **Honest about what it cannot know.** FTDC has no storage-capacity data; a single FTDC capture is one replica-set member; accesses counters reset on restart. Wherever a conclusion needs data we don't have, the tool says *"insufficient data — provide X"* instead of fabricating. This is a feature, not a limitation.
4. **Local-first.** The FTDC decoder and the scorer run entirely on the analyst's machine. The only network calls are (a) the optional LLM narration to a user-configured endpoint and (b) an explicit, user-triggered "verify latest Atlas specs." Customer diagnostic data never leaves the laptop unless the analyst points narration at a remote model.
5. **Additive & frozen-decoder.** The FTDC binary decoder is treated as **frozen**: every later capability (scoring, sizing, healthcheck, UI) is built *on top of* the decoded output, never by modifying the decoder. This keeps the riskiest, hardest-to-test code stable.

---

## 2. System shape (the layers)

```
            ┌─────────────────────────────────────────────────────────────┐
            │                        INPUTS (co-primary)                   │
            │   diagnostic.data (FTDC)          getMongoData.js (JSON)      │
            └───────────────┬───────────────────────────┬─────────────────┘
                            │                           │
                ┌───────────▼──────────┐    ┌───────────▼──────────────┐
   FROZEN  ───► │  FTDC BSON decoder   │    │  Healthcheck parser      │
                │  (chunk → samples)   │    │  (Extended-JSON → facts) │
                └───────────┬──────────┘    └───────────┬──────────────┘
                            │                           │
                ┌───────────▼──────────┐                │
                │  Metrics layer       │                │
                │  (rates, derived,    │                │
                │   bucketed series)   │                │
                └───────────┬──────────┘                │
                            │                           │
                ┌───────────▼───────────────────────────▼──────────────┐
                │                 SIGNAL LAYER                          │
                │   fixed vocabulary of named stats (p95/p99/max/…)     │
                └───────────┬───────────────────────────────────────────┘
                            │
                ┌───────────▼──────────┐   reads   ┌──────────────────────┐
                │  Two-pass SCORER     │◄──────────│  Declarative RULESET │
                │  pass 1: score       │           │  categories, signals,│
                │  pass 2: condition   │           │  thresholds, intents │
                └───────────┬──────────┘           └──────────────────────┘
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
       ┌────────────┐ ┌───────────┐ ┌───────────────┐
       │ assessment │ │  sizing   │ │  LLM narration│
       │   _v2      │ │  engine   │ │  (optional)   │
       └─────┬──────┘ └─────┬─────┘ └───────┬───────┘
             └──────────────┼───────────────┘
                            ▼
                  ┌──────────────────┐
                  │  Tauri/React UI  │
                  │  (Assessment,    │
                  │   Charts, Report)│
                  └──────────────────┘
```

**Repository layout (the parts that matter):**

| Path | Responsibility |
|---|---|
| `ftdc_analyzer/` (Python engine) | the brain — decode, metrics, signals, ruleset, scorer, sizing, healthcheck |
| `ftdc_analyzer/ruleset/` | declarative `schema.py`, `defaults.py`, `overrides.py`, intents |
| `ftdc_analyzer/scorer.py` | the two-pass conditioned scorer |
| `ftdc_analyzer/sizing.py` | Atlas tier recommendation engine |
| `ftdc_analyzer/healthcheck.py` | getMongoData parser |
| `ftdc_analyzer/tier_tables/` | bundled, dated Atlas tier specs (`aws/gcp/azure.json`) |
| `ftdc_analyzer/verdicts.py` | assembles `build_results` (the result document the UI consumes) |
| `app/` | Tauri v2 + React/TS + Tailwind + Recharts front end |
| `app/src-tauri/` | Rust shell: spawns the engine sidecar, LLM adapters, history, ruleset dump |

The engine is shipped as a **PyInstaller sidecar** the Rust app spawns; the app bundles to a `.app`/`.dmg`. There is no server — the "backend" is a local binary invoked per analysis.

---

## 3. FTDC on disk: the native BSON decode

This is the part SAs are most curious about: *how do we read `diagnostic.data` without a running mongod?* FTDC = **Full-Time Diagnostic Data Capture**. `mongod` continuously writes it to the `diagnostic.data` directory. The tool reads those files directly.

### 3.1 What's in the directory

`diagnostic.data/` contains a series of files:

- `metrics.<timestamp>` — rolling capture files, each holding many **chunks**.
- `metrics.interim` — the not-yet-rolled current file.

Each file is a sequence of **BSON documents**. There are two kinds:

1. **Metadata documents** — periodic snapshots of mostly-static info (host info, build info, command-line options). Stored as ordinary BSON.
2. **Metric chunks** — a BSON document with a binary field (`type: 1`) whose payload is a **compressed, delta-encoded block of samples**. This is where the time-series lives, and decoding it is the heart of the tool.

### 3.2 The metric chunk format (the interesting bit)

A metric chunk encodes *N consecutive samples* of *M metrics* in a compact binary layout. The decode pipeline is:

```
chunk binary field
      │
      ▼  (1) zlib inflate
uncompressed block
      │
      ▼  (2) read the reference document
[ reference BSON sample ]  ← sample 0, in full, as ordinary BSON
      │
      ▼  (3) read counts
[ metricCount ] [ sampleCount ]
      │
      ▼  (4) delta + varint + zero-RLE decode
[ deltas, column-major, per metric across samples ]
      │
      ▼  (5) reconstruct
full sample matrix:  sample[i][metric] = sample[i-1][metric] + delta
```

Step by step:

1. **zlib decompression.** The binary payload is zlib-compressed. Inflate it to get the raw block.
2. **Reference document.** The block begins with one complete BSON document — this is **sample 0**, with every metric at its full value. Walking this document in order also *defines the metric layout*: the flattened, depth-first list of every numeric leaf (e.g. `serverStatus.opcounters.insert`, `systemMetrics.disks.nvme0n1.io_time_ms`, …). That flattened order is the **column order** for everything that follows. This is why the reference doc matters beyond its values: it's the schema for the deltas.
3. **Counts.** Two little-endian uint32s follow: `metricCount` (number of numeric leaves = columns) and `sampleCount` (number of samples after the reference, i.e. rows − 1).
4. **Delta decode (the compression trick).** The remaining bytes are the deltas, stored **column-major**: all deltas for metric 0 across every sample, then all deltas for metric 1, and so on. Two encodings are layered:
   - **varint** — each delta is a variable-length integer (small deltas take one byte). Most metrics barely change sample-to-sample, so deltas are tiny.
   - **zero run-length encoding (zero-RLE)** — a zero delta is extremely common (a counter that didn't move, a gauge that's flat). A zero is encoded as a marker followed by a varint *count of consecutive zeros*. A metric that's constant for 300 samples costs a couple of bytes, not 300.
5. **Reconstruction.** Walking column-major, each metric's series is rebuilt by cumulative addition from the reference value: `value[sample_i] = value[sample_{i-1}] + delta[sample_i]`. The result is a dense matrix: every metric, every sample (default ~1 sample/second), fully reconstructed.

> **Why this matters to an SA:** the file is small (heavily compressed) but expands to *per-second* resolution over the whole capture — for the Ludo example, ~516,000 samples across ~6 days. The tool reconstructs all of it, which is what lets the min/max band (section 5) show a one-second spike even when you're zoomed out to the whole capture.

### 3.3 Metric identity & flattening

Because metrics are addressed *by position* in the flattened reference document, the decoder builds a parallel list of **dotted key paths** by walking the reference doc depth-first. So column 1417 might be `systemMetrics.disks.nvme1n1.io_time_ms`. Downstream code never deals with column indices — it asks for metrics by path. Counters (monotonic, e.g. `opcounters.insert`) and gauges (point-in-time, e.g. `wiredTiger.cache.bytes currently in the cache`) are distinguished later, in the metrics layer.

### 3.4 What FTDC does *not* contain

Critical for honesty (and a recurring theme):

- **No storage-capacity data.** FTDC has disk *utilization/latency/throughput* (performance) but **not** dataSize/storageSize/index sizes. Those require the healthcheck (section 11). The MongoDB docs are explicit that FTDC excludes storage-capacity data.
- **One member's view.** A `diagnostic.data` directory is from **one** `mongod`. Replica-set-wide conclusions (election history, per-member lag) are inferred, not directly measured, and the tool flags this.
- **No query shapes / plans.** FTDC has opcounters and query-targeting *ratios*, but not the slow-query log or `system.profile`. Per-query analysis needs the profiler input.

---

## 4. From raw samples to metrics

Once the decoder yields the dense sample matrix, the **metrics layer** turns raw columns into the things an analyst reasons about.

### 4.1 Counters vs gauges → rates

- **Gauges** (point-in-time values — cache bytes, queue depth, connection count) are used as-is.
- **Counters** (monotonic totals — opcounters, bytes written, document counts) are meaningless as absolute values; what matters is their **rate**. The metrics layer differentiates each counter against the sample clock:

  `rate(t) = (counter[t] − counter[t−1]) / (time[t] − time[t−1])`

  giving per-second rates (inserts/s, queries/s, bytes/s, page-faults/s, etc.). Counter resets (server restart → counter drops to 0) are detected and that interval is dropped rather than producing a huge negative rate.

### 4.2 Derived metrics

Some of the most useful signals don't exist as raw fields — they're computed:

- **Disk utilization %** from `io_time_ms` deltas over the interval (busy time ÷ wall time).
- **CPU utilization %** from `/proc/stat`-style jiffies (`user/system/iowait/idle` deltas).
- **Query targeting ratio** = documents examined ÷ documents returned (a proxy for index efficiency).
- **Cache dirty %** and **cache fill %** from WiredTiger cache byte gauges against the configured cache size.
- **Eviction pressure** = application-thread evictions/s (the signal that actually indicates cache stress — *not* fill level alone; an 80%-full cache is WiredTiger's healthy steady state).
- **Replication headroom** proxies from oplog and apply metrics.

### 4.3 Percentiles & summary stats

For each metric the layer computes `min / p50 / p95 / p99 / max / mean` across the capture. The ruleset overwhelmingly keys on **p95/p99/max** rather than mean, because a sizing or RCA decision cares about the *bad moments*, not the average. (A disk at 30% mean but 100% p95 is saturated for the purpose of a sizing verdict.)

### 4.4 The bucketed series for charts

Separately from the summary stats, the engine emits a **bucketed time-series** per chartable metric for the UI. This is where granularity comes in — section 5.

---

## 5. Granularity & bucketing — and why it changes interpretation

This section deserves special attention because **the granularity you view a chart at changes what the chart is telling you**, and an analyst who doesn't understand the model can misread a result. We deliberately modeled this on MongoDB Atlas's charting behavior.

### 5.1 Range vs granularity are different things

Two independent controls:

- **Range** = *what span of time* you're looking at (the whole capture, or the last 48h, or a custom incident window). Range is a **zoom/crop**.
- **Granularity** = *how finely the visible range is bucketed* (coarse → few wide buckets; fine → many narrow buckets). Granularity is a **resolution**.

A common misconception (and an early bug we fixed) is to conflate them — to make "48h" mean "show only the last 48h." In the corrected model, picking a finer granularity at the full range still shows the **entire capture**, just at higher resolution; picking a 48h range shows that span, bucketed by whatever granularity is selected.

### 5.2 How a bucket is computed

The engine emits a fine base series of `{t, mean, min, max}` tuples (up to ~2500 base buckets over the whole capture). When the UI displays a given range+granularity, it **re-aggregates** the base buckets into display buckets:

- **line value** = the bucket **mean** — specifically a *weighted mean of the base-bucket means* (weighted by each base bucket's sample count), so it equals the true mean of the underlying samples.
- **band** = `[ min-of-the-base-mins , max-of-the-base-maxs ]` across the base buckets that fall in the display bucket.

The critical property: **extremes propagate.** Aggregating min-of-mins and max-of-maxs means a peak in any base bucket survives every level of coarsening. **The shaded band always shows the true minimum and maximum of the raw samples inside each displayed bucket, at any range and any granularity.** A 100%-disk spike that lasted ten seconds still pulls its bucket's max to 100% when you're zoomed out to the whole six days. No sample's peak or trough is ever decimated away — coarsening can only *widen* a band, never hide a spike.

### 5.3 Why this changes interpretation (the part to internalize)

The **line** and the **band** tell different stories, and which dominates depends on where the mean sits in the value range:

- **CPU example (mean low):** util mean ~3%, but the band reaches ~18%. The cluster is *usually* idle with *occasional* spikes. The band fills the space **above** the line. If you only read the mean, you'd under-estimate peak load.
- **Disk example (mean high):** util mean ~92% (persistently saturated), band dipping to ~40-50%. The disk is *usually* saturated with *occasional* dips. The band fills the space **below** the line. The "inverted-looking" band is correct — it's the same min/max band, just with the mean sitting near the top of the range instead of the bottom.
- **Ratio example (mean ~1):** query-targeting mean ~1.0 with the band both above and below — the ratio varies in both directions within buckets.

So: **a band that fills upward = a normally-quiet metric that spikes; a band that fills downward = a normally-hot metric that occasionally relaxes.** Reading the band's *direction and width* is how you tell a steady bottleneck from a bursty one — which directly affects whether a problem is a sizing issue (sustained) or an incident (transient).

### 5.4 Granularity labels

Because "coarse/medium/fine" is ambiguous, the UI labels each granularity by its **approximate bucket duration**, derived from the current range span ÷ target bucket count, snapped to human units (1m/5m/10m/30m/1h/2h/6h/12h/1d). A ~6-day range reads roughly `~2h / ~40m / ~12m / ~3m`. This makes "what does one point represent?" explicit, which matters when you're judging whether a spike is a 3-minute blip or a 2-hour event.

### 5.5 Fullscreen drag-to-zoom

In the maximized chart, dragging selects an x-range and re-buckets *that sub-range* at finer resolution (mean + band preserved). This is the interactive equivalent of a custom range — it lets you drill an 8-hour spike out of a 6-day capture without losing the min/max guarantee.

---

## 6. The signal layer

Between raw metrics and the ruleset sits a deliberately **fixed vocabulary of signals**. A signal is a named, summarized stat the ruleset can reference, e.g.:

- `cpu_util_pct.p99`, `cpu_util_pct.max`, `cpu_iowait_pct.p99`
- `disk_util_pct.p95`, `disk_avg_write_ms.p95`, `disk_queue_depth.p95`, `disk_write_iops.p95`
- `cache_used_pct.p95`, `cache_dirty_pct.p95`, `wt_app_evict_ps.max`, `page_faults_ps.p95`
- `query_targeting.p95`, `repl_lag_*`, `write_conflicts_ps.*`, `tickets_*`

The point of a fixed vocabulary: **the ruleset never touches raw metrics directly.** It references signals by name. This decouples "how a stat is computed" (metrics layer) from "what threshold makes it concerning" (ruleset), so either can change without breaking the other. When the healthcheck parser was added, it injected `hc_*` signals (e.g. `hc_unused_index_count`, `hc_compression_ratio`, `hc_oplog_window_h`) into the same vocabulary — which is why the structural categories could be scored by the *existing* scorer with no scorer-logic change.


---

## 7. The ruleset (declarative)

The ruleset is the tool's **opinion**, expressed as data rather than code. It lives in `ftdc_analyzer/ruleset/` and is intentionally editable — an SA can tune a threshold or add a signal without touching scorer logic, and the same override mechanism is exposed in the UI's "Manage" panel.

### 7.1 The vocabulary

- **Category** — a named area of concern with a verdict (e.g. *Disk I/O Saturation*, *CPU / Compute Sizing*, *Index Health & Bloat*). There are 16, grouped into 6 families:
  - **Capacity** — memory/cache, CPU, disk (the right-sizing core)
  - **Incident-RCA** — replication lag, write-path contention, checkpoint stalls, connection surge, errors
  - **Cluster-Context** — sharding/topology, version/config risk
  - **Structural-Design** — index health, schema/data-model, storage-capacity design *(need the healthcheck)*
  - **Query-Optimization** — query targeting, slow-query hotspots *(need the profiler)*
  - **Cross-Cutting** — periodic health review
- **Signal rule** — within a category, a reference to a signal + a threshold + a direction + a **contribution weight**. e.g. *"`disk_util_pct.p95` > 85 → contributes +0.35"*.
- **Fire threshold** — the category-level score above which the category "fires" (e.g. ≥ 0.50).
- **required_inputs** — which inputs a category needs (`[]` = FTDC-derivable; `["healthcheck"]`; `["profiler"]`). Categories whose inputs are absent render as *awaiting-input* rather than scoring falsely.
- **conditioned_by** — cross-category links (section 8.2).

### 7.2 Why declarative

- **Auditability** — a customer can be shown the exact rule that fired and the threshold it crossed.
- **Tunability** — thresholds are opinions; different fleets warrant different ones. Overrides merge over defaults (`overrides.py`) and can be exported/imported as JSON.
- **Extensibility** — adding a category or signal is a data edit plus (if new) a signal definition, not a rewrite.

### 7.3 Files

| File | Holds |
|---|---|
| `schema.py` | the typed dataclasses (Category, SignalRule, Intent, …) |
| `defaults.py` | the shipped 16-category ruleset with thresholds & weights |
| `overrides.py` | the merge mechanism for user/Manage-panel edits |
| `__init__.py` | assembly + the intent definitions |

---

## 8. The scorer (two-pass, conditioned)

`scorer.py` is the deterministic heart. It is **always** computed (even in LLM mode) and produces, per category, a score in [0,1], a fired/clear/awaiting state, and an **evidence ledger**.

### 8.1 Pass 1 — score each category independently

For each category whose `required_inputs` are satisfied:

1. For each signal rule, read the signal value, compare to threshold, record **met / not-met** and the **contribution** (weight if met).
2. Sum contributions → raw category score, normalized to [0,1] against the category's max possible contribution.
3. Compare to the fire threshold → **fired** or **clear**.
4. Emit the **ledger**: every signal checked, its value, threshold, met-state, and contribution. (This is what the UI's expandable "evidence ledger (N signals · score X/Y)" renders.)

Categories with unmet `required_inputs` are set to **awaiting-input** and never contribute a false negative/positive.

### 8.2 Pass 2 — conditioning (the clever part)

This is what separates the tool from a threshold dashboard. Real systems are coupled — a symptom in one category can be *caused by* another, and a naive per-category readout gives dangerous advice ("add CPU!" when the CPU is high *because* the disk is slow). Pass 2 applies **conditional recommendations**:

- **Capacity ↔ workload-efficiency.** Every capacity category (memory/CPU/disk) carries a conditioning caveat: its "resource is stressed → resize" conclusion is only valid *if the workload is efficient*. An inefficient query pattern (poor index targeting, collection scans) can mimic undersized hardware. So:
  - If the **profiler is absent**, the capacity verdict attaches an honest caveat: *"workload efficiency unconfirmed — provide profiler to rule out that inefficient queries drive this before recommending spend."*
  - If the profiler is present and **query-inefficiency fires**, the recommendation **flips**: *"remediate the workload before resizing."*
- **Structural flip.** When a healthcheck is present and **Index Health** or **Schema** fires, the capacity cards' "provide healthcheck to disambiguate" caveat **resolves** — the structural cause is now known, so the conditioning updates accordingly (`_SCHEMA_FLIP`).
- **Write-path ↔ disk.** Write-path contention conditioned on disk saturation: if tickets are held because I/O is slow (not because write volume is high), the default "reduce write concurrency" advice is downgraded and points at storage first.

The ledger records *why* a recommendation was conditioned ("Recommendation conditioned: 'Disk I/O Saturation' fired at 72% — default advice downgraded"), so the conditioning is itself auditable.

### 8.3 Output

The scorer's result is folded into `assessment_v2` inside `build_results` (`verdicts.py`), carrying: per-category score/state/ledger, the intent lens applied, and the conditioning notes. This single document is what the UI Assessment tab, the sizing panel, and the narration layer all read.


---

## 9. Intents — a lens over categories

An **intent** is the SA's stated purpose for a run (Right-sizing, Cost optimization, Incident/RCA, General health check, Query & index optimization, Schema & data-model review, Full sweep). Intents do **not** add new analysis — they are a **declarative lens** that selects, orders, and weights *which of the 16 categories surface*, leaving raw confidence untouched (the ledger stays honest regardless of lens).

- Each intent maps to a set of category ids with an ordering/lean.
- **Multiple intents** can be selected; their lenses **union** (deduped, ordered by best lean across the selected intents).
- **Full sweep** is exclusive (all 16, ranked by confidence, no lens).
- Intents are defined in the ruleset package and are therefore tunable/overridable like everything else.

The contract to remember: **the pre-flight selections drive what the Assessment tab renders.** Intent decides which category cards lead; inputs decide which categories can score vs show "provide X"; mode/model decides grounded-ledger vs LLM-narrative; cloud-provider decides which tier table sizing maps against. Nothing is rendered that the selections didn't ask for.

---

## 10. The Atlas sizing engine

`sizing.py` is the capstone that turns capacity scores into a concrete, customer-ready tier recommendation. It exists because category verdicts ("disk SATURATED, CPU REDUCE") aren't actionable on their own — an SA needs *"here's your current box, here are three real Atlas options, here's the one I recommend and why."*

### 10.1 Inputs

- **Current inferred infra** — vCPU (`numCores`), RAM (`memSizeMB`), disk profile (from the disk category: saturated? latency-bound vs throughput/checkpoint-bound? observed IOPS).
- **Storage size** — **only available with the healthcheck** (FTDC has no capacity). Without it, the storage line honestly reads *"insufficient data — provide healthcheck snapshot."*
- **The tier table** for the selected cloud (`tier_tables/{aws,gcp,azure}.json`, each `specs_as_of` dated).

### 10.2 The three (really four) options

The options map to **real Atlas classes**, which is what makes the recommendation actionable:

1. **General downsize** — like-for-like to the smallest tier covering observed CPU+RAM+IOPS headroom.
2. **Low-CPU (R) variant** — Atlas's "R" tier: half the vCPUs of the General tier at the same RAM. Chosen when CPU is over-provisioned but RAM is needed.
3. **Provisioned IOPS** — decouple IOPS from instance size; an Atlas feature gated to **M30+ on AWS only**. Chosen when disk is the constraint but CPU/RAM have headroom.
4. **(Cost-aware refinement — a standing principle)** Grow the standard volume to gain IOPS for "free." On AWS/Atlas, standard IOPS stay at 3000 until storage ≥ 1TB, then scale at a 3:1 IOPS:GB ratio up to 16k. So *growing the volume* can be cheaper than *provisioning IOPS* up to a crossover point — but computing that crossover precisely needs the real storage size (healthcheck) and current pricing, so when those are absent the engine flags the path and defers the exact crossover honestly.

### 10.3 How the best option is picked

By **evidence pattern**, read from the scored capacity categories + conditioning:

| Pattern | Recommended |
|---|---|
| Disk constraint + CPU/RAM headroom (latency healthy, throughput/checkpoint-bound) | **Provisioned IOPS** (or grow-volume if cheaper) |
| Uniform headroom everywhere | **General downsize** |
| CPU specifically over-provisioned, RAM needed | **Low-CPU (R)** |
| Profiler shows the I/O is query-driven | **none of the above — remediate workload first** (the conditioning flip) |

Confidence carries through from the underlying category scores. The recommendation always shows `specs as of <date>` with an opt-in **"Verify latest"** that does a single user-triggered web fetch (default runs stay offline).

### 10.4 Tier tables

Bundled, declarative, dated. AWS seeded from Atlas docs: per-tier vCPU/RAM (M30 = 2vCPU/8GB … M60 = 16vCPU/64GB …), disk:RAM ratio (60:1 ≤M40, 120:1 above), provisioned-IOPS support (M30+ AWS-only), R-variant vCPU (half), WiredTiger cache (25% RAM ≤M30, 50% ≥M40). GCP/Azure mirror the grid with provisioned-IOPS marked AWS-only. All overridable.


---

## 11. The healthcheck (getMongoData) parser

`healthcheck.py` ingests the JSON produced by the bundled `getMongoData.js` collector (Keyhole/"allinfo" lineage). Where FTDC is the time-series, this is the **structural snapshot** — and for most SA engagements it's the *more common* input, because it's one `mongosh` command rather than a multi-hundred-MB directory.

### 11.1 What it parses

Extended-JSON-aware (`$numberLong`/`$date`), defensive (missing field → null + noted, never crash). Extracts:

- **Server/host** — version, edition, numCores, memSizeMB, uptimeSec, connections, WT cache size & bytes-in-cache, page faults. *(Note: in v0.11 these live nested under `serverInfo` — a real gotcha the parser handles.)*
- **Topology** — `replicaSetConfig` members → detect **arbiters** (`arbiterOnly`) vs electable; replSetName; `clusterRole` (e.g. `shardsvr` → this RS is one shard of a larger cluster).
- **Replication** — oplog window (`logSizeMB`/`usedMB`/`timeDiffHours`).
- **Storage/compression** — logical (`totalDataSize`) vs on-disk (`totalStorageSize`) → compression ratio; per-collection collstats (size, count, avgObjSize, per-index sizes, `block_compressor`).
- **Indexes** — per index: key, size, `accesses.ops`, `accesses.since`. Derives **unused** (ops=0, `_id_` excluded), **prefix/shadow-redundant** pairs, and flags **unique** indexes as not-droppable.
- **Operations** — opcounters, document metrics, TTL → derived ops/sec.
- **WiredTiger** — operation & filesystem read/write latency histograms.
- **Network** — bytesIn/Out → egress fan-out ("write amplification"); distinguishes **wire/network** compression from **storage block** compression.
- **Security/config** — edition feature gaps, bind IP, auth, TLS, launch args.

### 11.2 The index-health disambiguators (why ours is careful)

Naively "0 accesses = drop it" is wrong, and the tool encodes the caveats as ledger notes:

- **Accesses reset on restart.** `accesses.ops` counts since the stats counter last reset (often server restart), *not* since index creation. The tool weighs this against **uptime** — 0 accesses over a 27-day uptime is meaningful; over a 2-hour uptime it is not.
- **Unique indexes** enforce a constraint even when unused for reads — never auto-recommended for drop.
- **Per-member.** An index unused on the captured member may be used on another (e.g. a secondary serving reads). The tool advises confirming across all RS members.
- **Shadow/prefix redundancy.** An index whose key is a *prefix* of another (e.g. `id_1` vs `id_1_1`) may be redundant — flagged explicitly. *(On the validation file this caught a redundant set that the reference tool reported as "0 redundant" — a real differentiation.)*

### 11.3 How it scores

The parsed facts inject `hc_*` signals into the **same signal vocabulary**, so the existing scorer deep-scores the three structural categories (**Index Health & Bloat**, **Schema & Data-Model**, **Storage Capacity Design**) with real confidence + ledgers — no scorer-logic change. It also fills the sizing engine's **storage size** and a **cache-fit** read (working-set-fits-in-RAM reasoning), and resolves the capacity-category conditioning caveats.

### 11.4 The Healthcheck Report surface

Beyond scoring, the parser powers a descriptive **Healthcheck Report** (6 tabs: Summary / Collections / Index Analyzer / Operations / WiredTiger / Health & Security) intended to match — and exceed — the report SAs already use, so adoption never costs a familiar view. The scored *intelligence* lives in the Assessment tab; the Report is the descriptive parity layer.

---

## 12. Co-primary inputs

FTDC and the healthcheck are **co-equal primaries**. Either alone (or both) can drive a run:

- **Healthcheck only** → structural categories scored + sizing (CPU/RAM/storage) + the Report; time-series surfaces are cleanly marked unavailable.
- **FTDC only** → the time-series capacity/incident categories; structural categories show "provide healthcheck."
- **Both** → the richest analysis: time-series behavior *and* structural cause, with the conditioning caveats resolving.

Which is "primary" depends on the job: **healthcheck-primary** for right-sizing/cost/index/schema/capacity (the common SA work); **FTDC-primary** for incident RCA ("what happened at 3am"), which needs the timeline a single snapshot can't provide. The pre-flight wizard gates Run on *at least one* input and adapts the available intents to what's present.

---

## 13. The LLM narration layer

The model is a **storyteller over a finished result**, never a calculator. Two modes:

- **Rule-based (grounded)** — the deterministic ledger, rendered with a deterministic narrative synthesized from the scores. Works with no model.
- **LLM-led** — the model receives the *already-scored* assessment and writes the prose, structured into "What we found / Why it points here / What would change this." It introduces **no new numbers** — the prompt grounds it on the ledger, and on failure it falls back to the deterministic synthesis.

Provider-agnostic via a dialect-aware adapter layer (`llm.rs`): OpenAI-compatible (`/v1/chat/completions`) and Anthropic (`/v1/messages`, `x-api-key`) are both supported; a provider manager lets the SA save multiple endpoints, switch, and fall back to a default. Heavy compute is the user's endpoint — the FTDC engine itself stays offline.

> **Why this split matters for trust:** because the model can't change a number, an LLM hallucination can at worst produce awkward prose — it can never produce a wrong *recommendation* or a fabricated *metric*. The thing a customer acts on is always the deterministic ledger.

---

## 14. Trust, honesty & failure modes

What to tell a customer when they push:

- **"Where did this number come from?"** → the evidence ledger: signal, value, threshold, contribution. Reconstructable.
- **"Why M60 and not M40?"** → the sizing pattern table (section 10.3) + the tier table's dated specs.
- **"Can you size storage from FTDC?"** → No. FTDC has no capacity data; provide the healthcheck. *(The tool says this itself rather than guessing.)*
- **"Is this index really safe to drop?"** → the disambiguators (section 11.2): check uptime, uniqueness, and all members first.
- **"Is the cluster healthy because the average is fine?"** → read the band, not the mean (section 5.3); p95/p99 drive the verdicts, not mean.

Known honest limitations (by design, surfaced in-product):
- A single FTDC capture is one member; RS-wide claims are inferred.
- accesses counters are since-restart, not since-creation.
- Storage/schema/index depth needs the healthcheck; per-query depth needs the profiler.
- Tier specs are dated and refreshable, not live by default.

---

## 15. How to extend it

The architecture is built so the common extensions are *data edits*, not rewrites:

- **Add/adjust a threshold** → edit `defaults.py` (or an override). No scorer change.
- **Add a signal** → define it in the metrics/signal layer, reference it from a category rule.
- **Add a category** → a dataclass entry in `defaults.py` with its signals, fire threshold, `required_inputs`, and any `conditioned_by` links.
- **Add an intent** → a lens entry mapping to existing category ids; appears automatically in the wizard and Manage panel.
- **Add a cloud / update tier specs** → edit `tier_tables/*.json` (dated, overridable); the "Verify latest" button can refresh.
- **Add a healthcheck derivation** → extend `healthcheck.py` to emit a new `hc_*` signal; the scorer picks it up.
- **Golden rule:** never modify the FTDC decoder. Build on its decoded output. It is the frozen foundation.

---

## 16. Glossary

- **FTDC** — Full-Time Diagnostic Data Capture; the per-second metrics `mongod` writes to `diagnostic.data`.
- **Chunk** — a compressed, delta-encoded block of many samples inside an FTDC metrics file.
- **Reference document** — the full BSON sample 0 at the head of a chunk; also defines the metric column order.
- **Zero-RLE** — run-length encoding of the (very common) zero deltas.
- **Signal** — a named summary stat (e.g. `disk_util_pct.p95`) the ruleset keys on.
- **Category** — a scored area of concern (16 of them).
- **Fire** — a category whose score crossed its threshold.
- **Conditioning** — pass-2 logic where one category's result modifies another's recommendation.
- **Intent** — a declarative lens selecting/weighting which categories surface.
- **Ledger** — the per-category record of every signal, threshold, and contribution; the basis for trust.
- **Healthcheck** — the getMongoData JSON structural snapshot (co-primary input).
- **R-tier** — Atlas low-CPU instance class: half the vCPUs of the General tier at the same RAM.
- **Provisioned IOPS** — Atlas storage option (M30+ AWS) decoupling IOPS from volume size.

---

*This document describes the system as built through the Layer-2 + pre-flight + sizing + healthcheck (co-primary) arc. The FTDC decoder is frozen; everything else is additive and, where possible, declarative — so the tool stays auditable, honest, and extensible.*
