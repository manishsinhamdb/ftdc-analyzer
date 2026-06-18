# FTDC Analyzer

A local macOS desktop app that analyzes MongoDB **FTDC** (Full-Time Diagnostic Data
Capture) — the `diagnostic.data` folder MongoDB writes continuously — and turns it into
Atlas-style metric charts plus an automated first-pass assessment. **Everything runs on
your machine; nothing is uploaded.**

---

## Quick Start

```bash
git clone <repo-url> ftdc-analyzer
cd ftdc-analyzer
make app          # builds the engine sidecar + the desktop app (.app + .dmg)
open app/src-tauri/target/release/bundle/dmg/*.dmg
```

Drag **FTDC Analyzer** to Applications. The app is **unsigned**, so the first launch needs
**right-click → Open** (then "Open" in the dialog) to get past Gatekeeper.

Prefer a hot-reloading dev window instead of a bundle?

```bash
make dev
```

In the app: **Open FTDC data…** → pick a `diagnostic.data` folder (or a parent folder of
several host folders) → **Analyze**. Results populate the dashboard, charts, signals,
system info, and (opt-in) the Automated Assessment.

---

## What is FTDC?

MongoDB continuously records server health into a `diagnostic.data` directory (BSON files
named `metrics.*`): WiredTiger cache/checkpoints, opcounters, replication, op latencies,
system CPU/disk/memory, and ~1300 more metrics sampled roughly every second. It's the
first thing support looks at to diagnose a production incident. This tool decodes it,
derives per-second signals, and surfaces the story.

## Runs 100% locally

There is **no network call and no upload**. You pick a folder; a bundled engine binary
runs on your machine and writes results to a local app-cache directory that the UI reads.
Customer data never leaves the laptop.

## Architecture

```
┌─────────────────────────────┐     spawns      ┌──────────────────────────┐
│  Tauri desktop app (./app)  │ ─────────────▶  │  ftdc-engine sidecar     │
│  React + TypeScript UI      │  <out-dir>      │  (PyInstaller one-file    │
│  Rust shell (commands)      │ ◀───────────── │   bundle of the Python    │
│  reads results.json         │  results.json   │   engine, ./ftdc_analyzer)│
└─────────────────────────────┘                 └──────────────────────────┘
```

- **Python engine** (`ftdc_analyzer/`): `decoder` (BSON + delta/varint decode), `metrics`
  (curated signals + full 1370-metric capture), `verdicts` (RAM/CPU/Disk verdicts, cost
  optimization, insights), `signatures` (deterministic assessment), `report` (HTML), and a
  `cli` entrypoint.
- **Sidecar binary**: the engine packaged with PyInstaller as `ftdc-engine-<triple>` and
  bundled into the app via Tauri `externalBin`.
- **Desktop app** (`app/`): Vite + React + Tailwind + shadcn/ui, Recharts; a small Rust
  layer (`app/src-tauri`) runs the sidecar, persists run history, saves reports, etc.

## Prerequisites

- **macOS** (Apple Silicon or Intel — the build computes the right target triple from
  `uname -m`).
- **Python 3.10+** (`python3`)
- **Node 20.19+ / 22.12+ (LTS 22 recommended)** (`npm`)
- **Rust** (stable, via [rustup](https://rustup.rs))
- **Xcode Command Line Tools** (`xcode-select --install`) — provides the C toolchain/linker
  needed for the Rust compile and the macOS `.dmg` bundling step.
- **PyInstaller** — installed automatically into `.venv` by `make setup` / `make sidecar`.

`make setup` creates a `.venv`, runs `pip install -e .`, and `npm ci` in `./app`. The build
targets (`make app`, `make dev`, `make sidecar`) bootstrap setup automatically on a clean
clone.

## Make targets

| target | what it does |
| --- | --- |
| `make setup` | create `.venv`, `pip install -e .`, `npm ci` in `./app` |
| `make sidecar` | build the engine → `app/src-tauri/binaries/ftdc-engine-<triple>` |
| `make app` | sidecar + `tauri build` → `.app` and `.dmg` |
| `make dev` | sidecar + `tauri dev` (hot reload) |
| `make engine DIR=/path/to/diagnostic.data` | run the engine CLI on a folder |
| `make clean` | remove build artifacts (keeps `.venv` / `node_modules`) |

## Engine-only CLI

The engine runs without the app:

```bash
make engine DIR=/path/to/host/diagnostic.data
# or directly:
.venv/bin/python -m ftdc_analyzer.cli /path/to/diagnostic.data --out-dir ./out
```

- Pass a `diagnostic.data` directory, or a parent folder containing several host folders
  (the host with the most `metrics.*` files is chosen; others are noted).
- `--out-dir DIR` writes `results.json`, `metrics_full.json`, and a self-contained
  `report.html` into `DIR`. Omit it to write `<parent>/ftdc_results.json`; use `--stdout`
  to stream JSON.
- A malformed/half-written `metrics.interim` is **skipped gracefully** (logged, not fatal).
- **Logs**: every run writes `logs/run_<UTCstamp>.log` and `logs/last_run.log` at the
  project root (input path, resolved host, files processed/skipped, sample count, elapsed,
  and a final `OK`/`FAILED`).

## Unsigned app note

The `.app`/`.dmg` are **not code-signed or notarized**. On first launch macOS will block
it — **right-click the app → Open → Open**. After that it launches normally. (`make dev`
sidesteps this entirely.)

## Repo layout

```
ftdc_analyzer/        Python engine (decoder, metrics, verdicts, signatures, report, cli)
ftdc_engine_entry.py  PyInstaller entrypoint
pyproject.toml        installable package (`pip install -e .`, `ftdc-engine` script)
Makefile              arch-aware build (triple from uname -m)
app/                  Tauri desktop app (React/TS frontend + Rust shell)
  src/                UI (views, components, lib)
  src-tauri/          Rust commands, capabilities, bundled sidecar
.github/workflows/    ci.yml (PR build) + release.yml (tag → .dmg release asset)
```

## Attribution

The deterministic assessment heuristics are **informed by the open-source
[mongo-ftdc / Keyhole](https://github.com/simagix/mongo-ftdc) project's FTDC diagnosis
approach** (Apache-2.0) — thresholds and signal combinations were cross-referenced against
its documented rules and adapted to this engine's percentile-summary model. No code was
copied.

## Roadmap

- **Local-LLM assessment** — the "Generate assessment" toggle is the hook point: replace
  the deterministic signature pass with a local LLM that reasons over the same signals and
  writes a narrative.
- **Slow-query-log / profiler ingestion** — optionally ingest the slow-query log or
  `system.profile` to add a namespace/query view (top collections, slowest queries, index
  suggestions) alongside the host metrics.
