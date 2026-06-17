"""FTDC engine CLI / Tauri-sidecar entrypoint.

Usage:
    ftdc-engine INPUT_PATH [--out FILE] [--stdout] [--out-dir DIR]

Resolves a diagnostic.data directory from INPUT_PATH by searching downward for
metrics.* files, grouping them by parent directory, and analyzing the parent that
holds the most metrics.* files. Unreadable files (e.g. a half-written
metrics.interim) are skipped gracefully. Emits the full schema-v3 results JSON,
and the full per-metric catalog when --out-dir is used. Every run writes a log to
<project_root>/logs/.
"""

import os
import sys
import json
import glob
import time
import argparse
import datetime
from collections import defaultdict

from ftdc_analyzer import verdicts
from ftdc_analyzer import metrics

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(PROJECT_ROOT, "logs")


class RunLog:
    """Accumulates run lines, mirrors them to stderr, and writes a timestamped log
    plus a stable last_run.log on finalize (fail-loud-but-continue)."""

    def __init__(self, stamp):
        self.stamp = stamp
        self.lines = []

    def add(self, msg):
        self.lines.append(msg)
        print(f"[ftdc-engine] {msg}", file=sys.stderr)

    def write(self):
        try:
            os.makedirs(LOG_DIR, exist_ok=True)
            body = "\n".join(self.lines) + "\n"
            for name in (f"run_{self.stamp}.log", "last_run.log"):
                with open(os.path.join(LOG_DIR, name), "w") as fh:
                    fh.write(body)
        except OSError as e:
            print(f"[ftdc-engine] WARN could not write log: {e}", file=sys.stderr)


def _find_metrics_dirs(input_path):
    """Return {parent_dir: count_of_metrics_files} for all metrics.* found under
    INPUT_PATH (recursively). INPUT_PATH may itself be a diagnostic.data dir."""
    groups = defaultdict(int)
    if os.path.isfile(input_path):
        if os.path.basename(input_path).startswith("metrics."):
            groups[os.path.dirname(input_path)] += 1
        return groups
    pattern = os.path.join(input_path, "**", "metrics.*")
    for path in glob.glob(pattern, recursive=True):
        if os.path.isfile(path) and os.path.basename(path).startswith("metrics."):
            groups[os.path.dirname(path)] += 1
    return groups


def _host_label(metrics_dir):
    parent = os.path.dirname(metrics_dir)
    base = os.path.basename(metrics_dir)
    if base == "diagnostic.data":
        return os.path.basename(parent) or metrics_dir
    return base or metrics_dir


def _fill_uptime(results, metrics_full):
    for m in metrics_full["metrics"]:
        if m["path"] == "serverStatus.uptime":
            for val in reversed(m["v"]):
                if val is not None:
                    results["facts"]["derived"]["uptime_days"] = round(val / 86400, 2)
                    return


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="ftdc-engine",
        description="Analyze a MongoDB diagnostic.data capture and emit results JSON.",
    )
    parser.add_argument("input_path", metavar="INPUT_PATH",
                        help="path to a diagnostic.data dir or a folder containing host dirs")
    parser.add_argument("--out", metavar="FILE", default=None,
                        help="write results JSON to FILE (default: <chosen_parent>/ftdc_results.json)")
    parser.add_argument("--stdout", action="store_true",
                        help="write results JSON to stdout instead of a file")
    parser.add_argument("--out-dir", metavar="DIR", default=None,
                        help="write DIR/results.json + DIR/metrics_full.json (desktop-app mode)")
    args = parser.parse_args(argv)

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    start_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    t0 = time.monotonic()
    rl = RunLog(stamp)
    rl.add(f"start: {start_iso}")
    rl.add(f"input_path: {args.input_path}")

    def fail(code, reason):
        rl.add(f"FAILED: {reason}")
        rl.write()
        print(f"error: {reason}", file=sys.stderr)
        return code

    # ---- PREFLIGHT (fail loud and early) ----
    input_path = os.path.abspath(os.path.expanduser(args.input_path))
    if not os.path.exists(input_path):
        return fail(2, f"input path does not exist: {input_path}")

    groups = _find_metrics_dirs(input_path)
    if not groups:
        return fail(1, f"no metrics.* files found under {input_path}")

    ranked = sorted(groups.items(), key=lambda kv: (-kv[1], kv[0]))
    chosen_dir, chosen_count = ranked[0]
    chosen_host = _host_label(chosen_dir)
    rl.add(f"resolved_host_dir: {chosen_dir} (host={chosen_host}, "
           f"{chosen_count} metrics.* files)")
    if len(ranked) > 1:
        rl.add(f"additional hosts not analyzed in this run ({len(ranked) - 1}):")
        for d, c in ranked[1:]:
            rl.add(f"  - {_host_label(d)}: {d} ({c} metrics.* files)")

    # graceful-skip callback (deduped) — logs SKIP lines live
    _seen_skips = set()

    def on_skip(name, reason):
        if name in _seen_skips:
            return
        _seen_skips.add(name)
        rl.add(f"SKIP {name}: {reason}")

    # ---- ANALYSIS ----
    try:
        results = verdicts.build_results(chosen_dir, on_skip=on_skip)
        metrics_full = None
        if args.out_dir:
            metrics_full = metrics.build_metrics_full(chosen_dir, on_skip=on_skip)
            _fill_uptime(results, metrics_full)
    except Exception as e:  # noqa: BLE001
        return fail(1, f"{type(e).__name__}: {e}")

    skipped = results.get("skipped_files", [])
    samples = results.get("capture", {}).get("samples", 0)
    resolved_host = results.get("host", {}).get("hostname") or chosen_host

    # ---- OUTPUT ----
    log = sys.stderr
    if args.out_dir:
        out_dir = os.path.abspath(os.path.expanduser(args.out_dir))
        os.makedirs(out_dir, exist_ok=True)
        results_path = os.path.join(out_dir, "results.json")
        mf_path = os.path.join(out_dir, "metrics_full.json")
        with open(results_path, "w") as fh:
            json.dump(results, fh, indent=2)
        with open(mf_path, "w") as fh:
            json.dump(metrics_full, fh, separators=(",", ":"))
        rl.add(f"wrote {results_path} ({os.path.getsize(results_path):,} bytes)")
        rl.add(f"wrote {mf_path} ({os.path.getsize(mf_path):,} bytes)")
        # two parseable stdout lines
        print(f"hostname={resolved_host}")
        print(f"out_dir={out_dir}")
    elif args.stdout:
        sys.stdout.write(json.dumps(results, indent=2))
        sys.stdout.write("\n")
        rl.add("wrote results to stdout")
    else:
        out_path = args.out or os.path.join(os.path.dirname(chosen_dir), "ftdc_results.json")
        out_path = os.path.abspath(os.path.expanduser(out_path))
        with open(out_path, "w") as fh:
            json.dump(results, fh, indent=2)
        rl.add(f"wrote {out_path} ({os.path.getsize(out_path):,} bytes)")
        print(f"[ftdc-engine] results: {out_path}", file=log)

    # ---- FINALIZE LOG ----
    rl.add(f"files_processed: {chosen_count - len(skipped)}")
    rl.add(f"files_skipped: {len(skipped)}")
    for s in skipped:
        rl.add(f"  - {s['file']}: {s['reason']}")
    rl.add(f"total_samples: {samples}")
    rl.add(f"elapsed: {time.monotonic() - t0:.1f}s")
    rl.add("OK")
    rl.write()
    return 0


if __name__ == "__main__":
    sys.exit(main())
