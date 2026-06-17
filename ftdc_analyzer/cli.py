"""FTDC engine CLI / Tauri-sidecar entrypoint.

Usage:
    ftdc-engine INPUT_PATH [--out FILE] [--stdout]

Resolves a diagnostic.data directory from INPUT_PATH by searching downward for
metrics.* files, grouping them by parent directory, and analyzing the parent that
holds the most metrics.* files. Emits the full schema-v2 results JSON.
"""

import os
import sys
import json
import glob
import argparse
from collections import defaultdict

from ftdc_analyzer import verdicts


def _find_metrics_dirs(input_path):
    """Return {parent_dir: count_of_metrics_files} for all metrics.* found under
    INPUT_PATH (recursively). INPUT_PATH may itself be a diagnostic.data dir."""
    groups = defaultdict(int)
    if os.path.isfile(input_path):
        # A single file was passed: analyze its parent directory.
        name = os.path.basename(input_path)
        if name.startswith("metrics."):
            groups[os.path.dirname(input_path)] += 1
        return groups

    # Directory: search downward for metrics.* files.
    pattern = os.path.join(input_path, "**", "metrics.*")
    for path in glob.glob(pattern, recursive=True):
        if os.path.isfile(path) and os.path.basename(path).startswith("metrics."):
            groups[os.path.dirname(path)] += 1
    return groups


def _host_label(metrics_dir):
    """Best-effort host name from a .../<host>/diagnostic.data layout."""
    parent = os.path.dirname(metrics_dir)  # the <host> dir (diagnostic.data's parent)
    base = os.path.basename(metrics_dir)
    if base == "diagnostic.data":
        return os.path.basename(parent) or metrics_dir
    return base or metrics_dir


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="ftdc-engine",
        description="Analyze a MongoDB diagnostic.data capture and emit results JSON.",
    )
    parser.add_argument("input_path", metavar="INPUT_PATH",
                        help="path to a diagnostic.data dir or a folder containing host dirs")
    parser.add_argument("--out", metavar="FILE", default=None,
                        help="write JSON to FILE (default: <chosen_parent>/ftdc_results.json)")
    parser.add_argument("--stdout", action="store_true",
                        help="write JSON to stdout instead of a file")
    args = parser.parse_args(argv)

    input_path = os.path.abspath(os.path.expanduser(args.input_path))
    if not os.path.exists(input_path):
        print(f"error: input path does not exist: {input_path}", file=sys.stderr)
        return 2

    groups = _find_metrics_dirs(input_path)
    if not groups:
        print(f"error: no metrics.* files found under {input_path}", file=sys.stderr)
        return 1

    # Pick the directory holding the MOST metrics.* files.
    ranked = sorted(groups.items(), key=lambda kv: (-kv[1], kv[0]))
    chosen_dir, chosen_count = ranked[0]
    chosen_host = _host_label(chosen_dir)

    # Diagnostics go to stderr so --stdout stays pure JSON.
    log = sys.stderr
    print(f"[ftdc-engine] chosen host : {chosen_host}", file=log)
    print(f"[ftdc-engine] chosen dir  : {chosen_dir} ({chosen_count} metrics.* files)",
          file=log)
    if len(ranked) > 1:
        print(f"[ftdc-engine] additional hosts not analyzed in this run "
              f"({len(ranked) - 1}):", file=log)
        for d, c in ranked[1:]:
            print(f"               - {_host_label(d)}: {d} ({c} metrics.* files)", file=log)

    results = verdicts.build_results(chosen_dir)
    payload = json.dumps(results, indent=2)

    if args.stdout:
        sys.stdout.write(payload)
        sys.stdout.write("\n")
        print("[ftdc-engine] wrote results to stdout", file=log)
        return 0

    out_path = args.out or os.path.join(os.path.dirname(chosen_dir), "ftdc_results.json")
    out_path = os.path.abspath(os.path.expanduser(out_path))
    with open(out_path, "w") as fh:
        fh.write(payload)
    print(f"[ftdc-engine] wrote results to: {out_path} "
          f"({os.path.getsize(out_path):,} bytes)", file=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
