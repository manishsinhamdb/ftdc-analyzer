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
from ftdc_analyzer import report

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
    parser.add_argument("input_path", metavar="INPUT_PATH", nargs="?", default=None,
                        help="path to a diagnostic.data dir or a folder containing host dirs")
    parser.add_argument("--out", metavar="FILE", default=None,
                        help="write results JSON to FILE (default: <chosen_parent>/ftdc_results.json)")
    parser.add_argument("--stdout", action="store_true",
                        help="write results JSON to stdout instead of a file")
    parser.add_argument("--out-dir", metavar="DIR", default=None,
                        help="write DIR/results.json + DIR/metrics_full.json (desktop-app mode)")
    parser.add_argument("--ruleset-overrides", metavar="FILE", default=None,
                        help="path to a ruleset overrides JSON merged over the defaults")
    parser.add_argument("--target-category", metavar="ID", default=None,
                        help="targeted mode: deep-focus one scoring category by id")
    parser.add_argument("--intent", metavar="ID", default=None,
                        help="assessment intent id — a curated lens over the categories")
    parser.add_argument("--healthcheck", metavar="FILE", default=None,
                        help="path to a healthcheck snapshot (intake only; parsing is future)")
    parser.add_argument("--profiler", metavar="FILE", default=None,
                        help="path to a profiler / slow-query log (intake only; parsing is future)")
    parser.add_argument("--cloud", metavar="NAME", default="aws",
                        choices=["aws", "gcp", "azure"],
                        help="cloud provider for the sizing tier table (default aws)")
    parser.add_argument("--dump-ruleset", action="store_true",
                        help="print the merged ruleset JSON (defaults+overrides) and exit")
    parser.add_argument("--resize-from", metavar="RESULTS_JSON", default=None,
                        help="recompute sizing_recommendation from a cached results.json "
                             "(for a new --cloud/--intent) without re-decoding; prints JSON")
    args = parser.parse_args(argv)

    # Recompute sizing only, from a cached results.json (no FTDC decode).
    if args.resize_from:
        from ftdc_analyzer import sizing
        from ftdc_analyzer.ruleset.overrides import load_overrides
        ov_path = args.ruleset_overrides or os.environ.get("FTDC_RULESET_OVERRIDES")
        try:
            with open(os.path.abspath(os.path.expanduser(args.resize_from))) as fh:
                res = json.load(fh)
        except (OSError, ValueError) as e:
            print(f"error: cannot read results: {e}", file=sys.stderr)
            return 2
        tables = sizing.load_tier_tables(load_overrides(ov_path))
        host = res.get("host", {}) or {}
        a2 = res.get("assessment_v2", {}) or {}
        # Reconstruct the healthcheck sizing facts from the cached report (if present) so a
        # cached-decode resize keeps the real storage size + cache-fit.
        hc_report = res.get("healthcheck")
        hc_sizing = None
        if hc_report:
            sv = hc_report.get("server", {}) or {}
            stg = hc_report.get("storage", {}) or {}
            hc_sizing = {
                "storage_bytes_on_disk": stg.get("total_storage_size"),
                "storage_bytes_logical": stg.get("total_data_size"),
                "total_index_bytes": stg.get("total_index_size"),
                "wt_cache_bytes": sv.get("wt_cache_bytes"),
                "bytes_in_cache": sv.get("bytes_in_cache"),
                "compression_ratio": stg.get("compression_ratio"),
                "n_collections": stg.get("n_collections"),
            }
        out = sizing.build_sizing_recommendation(
            host.get("num_cores"), host.get("mem_mb"), res.get("signals", {}) or {},
            a2.get("ranked", []), args.cloud, tables,
            set(a2.get("provided_inputs", [])), args.intent, healthcheck=hc_sizing)
        sys.stdout.write(json.dumps(out))
        sys.stdout.write("\n")
        return 0

    # Source-of-truth ruleset dump for the Methodology/Manage panel (no data needed).
    if args.dump_ruleset:
        from ftdc_analyzer.ruleset import build_ruleset
        from ftdc_analyzer.ruleset.overrides import load_overrides
        from ftdc_analyzer import sizing
        ov_path = args.ruleset_overrides or os.environ.get("FTDC_RULESET_OVERRIDES")
        rs = build_ruleset(ov_path)
        dump = rs.to_dict()
        dump["tier_tables"] = sizing.load_tier_tables(load_overrides(ov_path))
        sys.stdout.write(json.dumps(dump, indent=2))
        sys.stdout.write("\n")
        return 0

    # ---- HEALTHCHECK-ONLY MODE (co-primary input; no FTDC capture) ----
    # A healthcheck snapshot drives the analysis on its own when no FTDC path is given.
    if args.healthcheck and not args.input_path:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        rl = RunLog(stamp)
        rl.add(f"start: {datetime.datetime.now(datetime.timezone.utc).isoformat()}")
        rl.add(f"healthcheck-only mode: {args.healthcheck}")
        hc_path = os.path.abspath(os.path.expanduser(args.healthcheck))
        if not os.path.exists(hc_path):
            rl.add(f"FAILED: healthcheck file does not exist: {hc_path}")
            rl.write()
            print(f"error: healthcheck file does not exist: {hc_path}", file=sys.stderr)
            return 2
        try:
            results = verdicts.build_results_healthcheck_only(
                hc_path, target_category=args.target_category,
                ruleset_overrides_path=args.ruleset_overrides, intent=args.intent,
                provided_profiler=args.profiler, cloud=args.cloud)
        except Exception as e:  # noqa: BLE001
            rl.add(f"FAILED: {type(e).__name__}: {e}")
            rl.write()
            print(f"error: {type(e).__name__}: {e}", file=sys.stderr)
            return 1
        resolved_host = results.get("host", {}).get("hostname") or "healthcheck"
        if args.out_dir:
            out_dir = os.path.abspath(os.path.expanduser(args.out_dir))
            os.makedirs(out_dir, exist_ok=True)
            with open(os.path.join(out_dir, "results.json"), "w") as fh:
                json.dump(results, fh, indent=2)
            # Empty catalog so the app's Explore lazy-load never 404s on a HC-only run.
            with open(os.path.join(out_dir, "metrics_full.json"), "w") as fh:
                json.dump({"schema": "metrics_full/v1", "host": {"hostname": resolved_host,
                          "version": results.get("host", {}).get("mongo_version")},
                          "n_points": 0, "timeline": {"t": []}, "metrics": []}, fh)
            rl.add(f"wrote {os.path.join(out_dir, 'results.json')}")
            print(f"hostname={resolved_host}")
            print(f"out_dir={out_dir}")
        elif args.stdout:
            sys.stdout.write(json.dumps(results, indent=2))
            sys.stdout.write("\n")
        else:
            out_path = args.out or os.path.join(os.path.dirname(hc_path), "ftdc_results.json")
            out_path = os.path.abspath(os.path.expanduser(out_path))
            with open(out_path, "w") as fh:
                json.dump(results, fh, indent=2)
            print(f"[ftdc-engine] results: {out_path}", file=sys.stderr)
        rl.add("OK")
        rl.write()
        return 0

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    start_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    t0 = time.monotonic()
    rl = RunLog(stamp)
    rl.add(f"start: {start_iso}")
    if not args.input_path:
        parser.error("INPUT_PATH is required (unless using --dump-ruleset)")
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
        results = verdicts.build_results(
            chosen_dir, on_skip=on_skip,
            target_category=args.target_category,
            ruleset_overrides_path=args.ruleset_overrides,
            intent=args.intent,
            provided_healthcheck=args.healthcheck,
            provided_profiler=args.profiler,
            cloud=args.cloud)
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
        # self-contained HTML report (CDN Plotly) for the desktop "Export HTML" action
        try:
            report_path = os.path.join(out_dir, "report.html")
            with open(report_path, "w") as fh:
                fh.write(report.render_html(results))
            rl.add(f"wrote {report_path} ({os.path.getsize(report_path):,} bytes)")
        except Exception as e:  # noqa: BLE001 — report is best-effort, never fail the run
            rl.add(f"WARN report.html not written: {type(e).__name__}: {e}")
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
