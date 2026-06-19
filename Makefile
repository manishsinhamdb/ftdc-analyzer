# FTDC Analyzer — fork-and-run build.
#
# The Rust target triple is computed from `uname -m` so both Apple-Silicon and
# Intel macs work without hardcoding. Tauri's `externalBin: ["binaries/ftdc-engine"]`
# resolves the platform-suffixed sidecar `binaries/ftdc-engine-<triple>`, which is
# exactly what `make sidecar` produces.

ARCH := $(shell uname -m)
ifeq ($(ARCH),arm64)
  TRIPLE := aarch64-apple-darwin
else ifeq ($(ARCH),x86_64)
  TRIPLE := x86_64-apple-darwin
else
  TRIPLE := $(ARCH)-apple-darwin
endif

VENV    := .venv
PY      := $(VENV)/bin/python
PIP     := $(VENV)/bin/pip
PYINST  := $(VENV)/bin/pyinstaller
SIDECAR := app/src-tauri/binaries/ftdc-engine-$(TRIPLE)

.PHONY: help setup sidecar app dev engine clean
.DEFAULT_GOAL := help

help:
	@echo "FTDC Analyzer — targets (triple: $(TRIPLE)):"
	@echo "  make setup            create .venv, pip install -e ., npm ci in ./app"
	@echo "  make sidecar          build the engine binary -> $(SIDECAR)"
	@echo "  make app              sidecar + tauri build (produces .app/.dmg)"
	@echo "  make dev              sidecar + tauri dev (hot-reload)"
	@echo "  make engine DIR=path  run the engine CLI on a diagnostic.data dir"
	@echo "  make clean            remove build artifacts"

# --- setup (sentinels so repeated builds skip reinstall) ---
$(PYINST):
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -e .
	$(PIP) install pyinstaller

app/node_modules: app/package-lock.json
	cd app && npm ci
	@touch app/node_modules

setup: $(PYINST) app/node_modules
	@echo "setup complete (triple: $(TRIPLE))"

# --- sidecar engine binary ---
sidecar: $(PYINST)
	$(PYINST) --onefile --name ftdc-engine \
	  --collect-all bson --collect-all numpy --collect-all pymongo \
	  --add-data "$(CURDIR)/ftdc_analyzer/tier_tables:ftdc_analyzer/tier_tables" \
	  --paths . --distpath dist --workpath build/pyi --specpath build \
	  --noconfirm ftdc_engine_entry.py
	mkdir -p app/src-tauri/binaries
	cp dist/ftdc-engine "$(SIDECAR)"
	chmod +x "$(SIDECAR)"
	@echo "sidecar staged: $(SIDECAR)"

# --- desktop app ---
app: sidecar app/node_modules
	cd app && npm run tauri build
	@echo "bundles in app/src-tauri/target/release/bundle/ (.app + .dmg)"

dev: sidecar app/node_modules
	cd app && npm run tauri dev

# --- engine-only CLI ---
engine: $(PYINST)
	@test -n "$(DIR)" || (echo "usage: make engine DIR=/path/to/diagnostic.data" && exit 1)
	$(PY) -m ftdc_analyzer.cli "$(DIR)" --out-dir out
	@echo "results written to ./out (results.json + metrics_full.json + report.html)"

clean:
	rm -rf build dist app/dist app/src-tauri/target
	rm -f app/src-tauri/binaries/ftdc-engine-*
	@echo "cleaned build artifacts (kept .venv and node_modules)"
