# FTDC Analyzer — Installation & Build Guide

*From zero to a running build — for a colleague who has never touched this repo, or for future-you months from now.*

This is the **"get it running / build it / ship it"** companion to `ARCHITECTURE.md` (which explains *how it works* and *how to extend it*). If you want to understand the engine internals or add a feature, read `ARCHITECTURE.md`. If you just want it installed, you're in the right place.

---

## 0. What you're installing

A **desktop app** (macOS, Apple Silicon) that analyzes MongoDB diagnostic data — an FTDC `diagnostic.data` capture and/or a `getMongoData.js` healthcheck snapshot — and produces an Atlas-style metrics dashboard plus a scored, opinionated assessment (right-sizing, cost, RCA, index/schema health) with an exportable HTML report. It runs **100% locally**; the only optional network calls are to a user-configured LLM endpoint (for narration) and an opt-in "verify latest Atlas specs."

It is built from three layers (see `ARCHITECTURE.md` for detail):
- a **Python engine** (the brain — decode, score, size, healthcheck parse),
- a **Rust/Tauri shell** (spawns the engine, LLM adapters, history),
- a **React/TypeScript frontend** (the UI).

The build packages all three into a `.app` and `.dmg`.

---

## 1. Platform support (read this first)

- **Primary / validated:** **macOS on Apple Silicon (arm64)**. This is what the tool is built and tested on; the bundled outputs are `FTDC Analyzer.app` + `FTDC Analyzer_<ver>_aarch64.dmg`.
- **Intel macOS:** should build with the standard toolchain but is unvalidated — expect to adjust the target triple.
- **Windows / Linux:** Tauri supports both, but this project has not been built or tested there. You'd need the platform's Tauri prerequisites (e.g. WebView2 on Windows; `webkit2gtk` and friends on Linux) and to adjust the PyInstaller sidecar target. Treat as a porting exercise, not a documented path.

The rest of this guide assumes **Apple Silicon macOS**.

---

## 2. Prerequisites

Install these before cloning. Versions matter — the pins below are what the project is known to build with.

### 2.1 Xcode Command Line Tools (required)
The Rust/Tauri build needs Apple's compiler/linker toolchain.
```bash
xcode-select --install
```
(If already installed, this no-ops.)

### 2.2 Homebrew (recommended, for installing the rest)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2.3 Node.js (required — version-sensitive)
The frontend toolchain requires a modern Node. Use **Node 20.19+ or 22.12+** (older Node 18 will fail the Vite/TS build). The cleanest way is `nvm`:
```bash
brew install nvm        # then follow brew's note to add nvm to your shell rc
nvm install 22          # installs a current 22.x (≥22.12)
nvm use 22
node -v                 # confirm ≥ 20.19 or ≥ 22.12
```
(Or `brew install node` if you prefer Homebrew's current Node — just confirm the version.)

### 2.4 Rust toolchain (required)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# accept defaults, then load it into the current shell:
source "$HOME/.cargo/env"
rustc --version         # confirm it prints a version
```

### 2.5 Python (required — for the engine + the PyInstaller sidecar)
Use **Python 3.11+** (3.12 is fine). macOS' system Python works, but a Homebrew Python is cleaner:
```bash
brew install python@3.12
python3 --version       # confirm ≥ 3.11
```

### 2.6 Quick prerequisite sanity check
```bash
echo "node:   $(node -v)"
echo "npm:    $(npm -v)"
echo "rustc:  $(rustc --version)"
echo "cargo:  $(cargo --version)"
echo "python: $(python3 --version)"
echo "xcode:  $(xcode-select -p)"
```
All five should print a version. If any is missing, fix it before continuing.

---

## 3. Get the code

The repo lives at `github.com/manishsinhamdb/ftdc-analyzer`. If you use a dedicated SSH host alias for the MongoDB GitHub identity (the `github-mdb` alias in `~/.ssh/config`), clone via that; otherwise use the normal SSH/HTTPS URL.

```bash
# with the github-mdb SSH alias:
git clone git@github-mdb:manishsinhamdb/ftdc-analyzer.git

# or standard SSH:
git clone git@github.com:manishsinhamdb/ftdc-analyzer.git

cd ftdc-analyzer
```

> **SSH alias note:** `github-mdb` is an entry in `~/.ssh/config` that maps to `github.com` with a specific key/identity. If you don't have it, either add one or just use the standard `git@github.com:` URL above.

Read the repo's `README.md` and `ARCHITECTURE.md` once before building — they're the orientation.

---

## 4. Set up the Python engine

The engine is the brain and can run standalone (the app spawns a packaged copy of it, but for development you run it directly).

```bash
# from the repo root
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e ftdc_analyzer            # or: pip install -r requirements.txt if present
```

> If neither an installable package nor a `requirements.txt` is obvious, check the repo root / `ftdc_analyzer/` for the dependency manifest (`pyproject.toml` / `setup.py` / `requirements.txt`) and install accordingly. The engine's runtime deps are standard scientific/plotting/templating libraries.

**Verify the engine runs** against a sample (use any `diagnostic.data` directory you have, or the healthcheck fixture):
```bash
# inspect the CLI surface:
python -m ftdc_analyzer.cli --help

# example: analyze an FTDC directory (path will differ on your machine)
python -m ftdc_analyzer.cli --path /path/to/diagnostic.data

# example: a healthcheck-only run
python -m ftdc_analyzer.cli --healthcheck files/upload/healthcheck/output_ludo.json
```
If it prints/produces a results document without erroring, the engine is good. (Exact flags: `--help` is authoritative — it covers `--path`, `--healthcheck`, intent/focus, `--cloud`, overrides, and `--dump-ruleset`.)

---

## 5. Install the app's JS dependencies

```bash
cd app
npm install
cd ..
```

This pulls the frontend (React, Vite, Tailwind, Recharts, shadcn) and the Tauri tooling.

---

## 6. Run in development (hot-reload)

For iterating on the UI/engine without producing a full bundle:

```bash
make dev
```

This launches the Tauri dev shell with the Vite dev server (hot module reload on the frontend) and the engine wired in. Use this for day-to-day development — it's far faster than `make app`.

> If `make dev` isn't wired in your checkout, the equivalent is running the Tauri dev command from `app/` (`npm run tauri dev` or the script the `Makefile` invokes). Check the `Makefile` targets.

---

## 7. Build the production app (the `.app` + `.dmg`)

This is the full, distributable build. It compiles the Rust shell, builds the frontend, **packages the Python engine as a PyInstaller sidecar**, and bundles everything.

```bash
make app
```

On success (look for `EXIT 0` / no errors), the artifacts land here:
```
app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app
app/src-tauri/target/release/bundle/dmg/FTDC Analyzer_<version>_aarch64.dmg
```
Typical sizes: ~36 MB `.app`, ~26 MB `.dmg`.

**Launch it:**
```bash
open "app/src-tauri/target/release/bundle/macos/FTDC Analyzer.app"
```
Or open the `.dmg` and drag the app to Applications.

> **First-run Gatekeeper note (unsigned build):** because the app isn't code-signed/notarized, macOS will block the first launch ("can't be opened because it is from an unidentified developer"). To open it: **right-click the app → Open → Open** (only needed once), or `System Settings → Privacy & Security → Open Anyway`. If you distribute the `.dmg` to a colleague, tell them this — otherwise it looks broken. (See §10 for the proper signing/notarization path if you want to remove this friction.)

---

## 8. First-run configuration

The app works out of the box in **grounded (rule-based)** mode with no setup. Optional configuration:

### 8.1 LLM narration (optional)
For the richer LLM-led narrative, open **LLM Settings** (gear icon) and configure a provider:
- The default provider points at an OpenAI-compatible endpoint; you can **add your own** (any OpenAI-compatible endpoint, or an Anthropic/Claude endpoint with `dialect = anthropic`, base URL + API key), save multiple, switch, and it falls back to the default if one is unreachable.
- Pick a chat model; "Test connection" verifies it.
- Without any model, everything still works — you just get the deterministic narrative instead of LLM prose. **No model is required.**

### 8.2 Inputs
- **FTDC** (`diagnostic.data` directory) — the time-series capture. Either FTDC or a healthcheck is enough to run (co-primary).
- **Healthcheck** (`getMongoData.js` output JSON) — the structural snapshot. Unlocks index/schema/storage analysis and real storage sizing.
- **Profiler / slow-query** (optional) — unlocks query-targeting/index-rec analysis.
- Each input has a **"Don't have this? Get it"** helper with the exact collector command + least-privilege role.

### 8.3 The healthcheck collector
A runnable `collectors/getMongoData.js` is bundled. To produce a healthcheck from a cluster:
```bash
mongosh "<connection-uri>" --quiet collectors/getMongoData.js > healthcheck.json
```
Least-privilege role: `clusterMonitor` + `readAnyDatabase`. Treat the output as local-only (it reveals schema/namespaces).

---

## 9. Verify the install end-to-end

A good smoke test that exercises both input paths:

1. Launch the app.
2. **New analysis → load the healthcheck fixture** `files/upload/healthcheck/output_ludo.json` (healthcheck-only) → pick an intent → Run. You should get the **Healthcheck Report** (6 tabs) + a scored Assessment (Index Health firing with unused indexes, storage sizing filled).
3. **Both-inputs run:** add an FTDC `diagnostic.data` directory too → Run → confirm the time-series charts + the enriched Assessment + the **Sizing Recommendation** panel.
4. **Export HTML** → open the file → confirm the four sections (General → Healthcheck Report → Charts/Metrics → Assessment).

If all four work, you have a correct install.

---

## 10. (Optional) Code-signing & notarization — removing the Gatekeeper warning

For a `.dmg` you hand to colleagues that opens without the right-click dance, you need an Apple Developer ID:
- An **Apple Developer account** + a **Developer ID Application** certificate in your keychain.
- Configure Tauri's macOS signing identity (signing identity + notarization credentials) in the Tauri bundle config, then build.
- After build, **notarize** the app/dmg with Apple (`notarytool`) and **staple** the ticket.

This is optional and only worth doing for wider distribution. For personal use or a trusted colleague, the right-click-Open path in §7 is fine. (Details are Apple/Tauri-version-specific — consult the current Tauri macOS distribution docs.)

---

## 11. Repository map — where to start if you want to change X

| You want to… | Start here | Deep dive |
|---|---|---|
| Understand the whole system | `ARCHITECTURE.md` | — |
| Change a scoring threshold / rule | `ftdc_analyzer/ruleset/defaults.py` (or an override) | `ARCHITECTURE.md` §7–8 |
| Add a metric/signal | metrics + signal layer → reference from a category | `ARCHITECTURE.md` §4, §6 |
| Add an assessment category | `ftdc_analyzer/ruleset/defaults.py` | `ARCHITECTURE.md` §7 |
| Add an intent (lens) | the intents in the ruleset package | `ARCHITECTURE.md` §9 |
| Change Atlas tier specs / add a cloud | `ftdc_analyzer/tier_tables/*.json` | `ARCHITECTURE.md` §10 |
| Add a healthcheck-derived signal | `ftdc_analyzer/healthcheck.py` | `ARCHITECTURE.md` §11 |
| Add a NEW input type (e.g. sh.status) | the evidence-input registry (Phase 9) | `ARCHITECTURE.md` §6, §12 |
| Touch the FTDC decoder | **don't** — it's frozen by design | `ARCHITECTURE.md` §1, §3 |
| Change the UI | `app/src/` (React/TS components) | — |
| Change engine↔app wiring / LLM adapters | `app/src-tauri/` (Rust) | `ARCHITECTURE.md` §13 |

**Golden rule:** the FTDC decoder is **frozen** — every capability is built *on top of* its decoded output, never by editing it. See `ARCHITECTURE.md` §1.

---

## 12. Troubleshooting — gotchas we actually hit

- **Node version errors in the Vite/TS build** → you're on Node < 20.19. Switch with `nvm use 22`. (See §2.3.)
- **`make app` succeeds but the packaged app behaves differently from `make dev`** → almost always a **bundling** issue: a data file the engine needs wasn't included in the PyInstaller sidecar. Historically the tier-table JSONs needed an explicit `--add-data tier_tables` entry (and the `Makefile`/`ci.yml` carry that line). If you add new engine data files (tables, templates, collectors), make sure they're bundled, and **test the packaged sidecar**, not just the build exit code. (Bug class A15 in the build notes.)
- **Storage numbers look "off by ~7%" vs another tool** → decimal-GB vs GiB. The healthcheck/Atlas world uses **decimal GB** (1000³) for storage; don't compare against GiB (1024³) without converting. (Gotcha noted in Phase 7.)
- **getMongoData fields missing/null** → in `getMongoData.js` v0.11, several server-status blocks (`metrics`, `network`, `wiredTiger`) are nested under `serverInfo` — the parser handles this, but if you extend it, look there.
- **Gatekeeper blocks the app** → unsigned build; right-click → Open (§7), or sign/notarize (§10).
- **The engine runs in dev but the bundle can't find it** → confirm the sidecar built and is on the expected path; rebuild with `make app` and check the bundle's `Resources`.
- **LLM "connection failed"** → the endpoint is unreachable or the key/dialect is wrong; "Test connection" in LLM Settings classifies the error. Grounded mode always works without any model.

---

## 13. Updating / pulling latest

```bash
git pull origin main
cd app && npm install && cd ..        # in case JS deps changed
source .venv/bin/activate && pip install -e ftdc_analyzer   # in case engine deps changed
make app                               # rebuild
```

---

*Companion docs: `ARCHITECTURE.md` (how it works / how to extend), `LAYER2_BUILD_NOTES.md` (the running build-decision log, A1–A26+). Between this guide and those, a new contributor has everything needed to install, run, understand, and extend the tool.*
