"""Throwaway FTDC recon script. Inspects one diagnostic.data sample and reports
its structure. Not part of the ftdc_analyzer package."""

import os
import zlib
import datetime

import bson
from bson import decode_file_iter
from bson.timestamp import Timestamp
from bson.int64 import Int64

DATA_03 = "/Users/manishsinha/Desktop/projects/ftdc-analyzer/files/upload/ludo-prod-mongo-03/diagnostic.data"

# Shared state passed between sections.
TARGET = None
first_type0 = None
first_type1 = None
ref_doc = None
metricCount = None
D = None
L = None


# ---------------------------------------------------------------------------
# SECTION 1: list directory, pick TARGET
# ---------------------------------------------------------------------------
print("=== SECTION 1 ===")
try:
    entries = []
    for name in os.listdir(DATA_03):
        full = os.path.join(DATA_03, name)
        try:
            size = os.path.getsize(full)
        except OSError:
            size = -1
        entries.append((name, size))
    entries.sort(key=lambda x: x[0])
    for name, size in entries:
        print(f"{name}\t{size}")

    metrics_files = [
        (name, size)
        for name, size in entries
        if name.startswith("metrics.") and name != "metrics.interim"
    ]
    if not metrics_files:
        print("No metrics.* (non-interim) files found!")
    else:
        TARGET_name, TARGET_size = max(metrics_files, key=lambda x: x[1])
        TARGET = os.path.join(DATA_03, TARGET_name)
        print(f"\nPicked TARGET: {TARGET_name} ({TARGET_size} bytes)")
except Exception as e:
    print(f"SECTION 1 ERROR: {type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# SECTION 2: iterate outer BSON docs, tally type field
# ---------------------------------------------------------------------------
print("\n=== SECTION 2 ===")
try:
    if TARGET is None:
        raise RuntimeError("no TARGET selected in section 1")
    count_type0 = 0
    count_type1 = 0
    total = 0
    with open(TARGET, "rb") as fh:
        for doc in decode_file_iter(fh):
            total += 1
            t = doc.get("type")
            if t == 0:
                count_type0 += 1
                if first_type0 is None:
                    first_type0 = doc
            elif t == 1:
                count_type1 += 1
                if first_type1 is None:
                    first_type1 = doc
    print(f"type==0 count: {count_type0}")
    print(f"type==1 count: {count_type1}")
    print(f"total doc count: {total}")
except Exception as e:
    print(f"SECTION 2 ERROR: {type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# SECTION 3: metadata from first type==0 doc
# ---------------------------------------------------------------------------
print("\n=== SECTION 3 ===")
try:
    if first_type0 is None:
        raise RuntimeError("no type==0 doc captured in section 2")
    meta = first_type0.get("doc")
    if meta is None:
        raise RuntimeError("first type==0 doc has no 'doc' sub-document")
    print("metadata top-level keys:")
    for k in meta.keys():
        print(f"  - {k}")

    def deep_find(d, target_key):
        """Depth-first search for target_key anywhere in nested doc/list."""
        if isinstance(d, dict):
            for k, v in d.items():
                if k == target_key:
                    return v
                found = deep_find(v, target_key)
                if found is not None:
                    return found
        elif isinstance(d, list):
            for item in d:
                found = deep_find(item, target_key)
                if found is not None:
                    return found
        return None

    print("\nidentity fields:")
    # hostname
    hostname = deep_find(meta, "hostname")
    print(f"  hostname: {hostname!r}")

    # MongoDB version under buildInfo.version
    buildInfo = meta.get("buildInfo")
    version = None
    if isinstance(buildInfo, dict):
        version = buildInfo.get("version")
    if version is None:
        version = deep_find(meta, "version")
    print(f"  MongoDB version: {version!r}")

    # OS / system info
    hostInfo = meta.get("hostInfo")
    os_info = None
    system_info = None
    numCores = None
    memSizeMB = None
    memLimitMB = None
    if isinstance(hostInfo, dict):
        os_info = hostInfo.get("os")
        system_info = hostInfo.get("system")
        if isinstance(system_info, dict):
            numCores = system_info.get("numCores")
            memSizeMB = system_info.get("memSizeMB")
            memLimitMB = system_info.get("memLimitMB")
    if numCores is None:
        numCores = deep_find(meta, "numCores")
    if memSizeMB is None:
        memSizeMB = deep_find(meta, "memSizeMB")
    if memLimitMB is None:
        memLimitMB = deep_find(meta, "memLimitMB")

    print(f"  OS info: {os_info!r}")
    print(f"  system info: {system_info!r}")
    print(f"  numCores (CPUs): {numCores!r}")
    print(f"  memSizeMB: {memSizeMB!r}")
    print(f"  memLimitMB: {memLimitMB!r}")
except Exception as e:
    print(f"SECTION 3 ERROR: {type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# SECTION 4: decode chunk framing from first type==1 doc
# ---------------------------------------------------------------------------
print("\n=== SECTION 4 ===")
try:
    if first_type1 is None:
        raise RuntimeError("no type==1 doc captured in section 2")
    raw = first_type1.get("data")
    if raw is None:
        raise RuntimeError("first type==1 doc has no 'data' field")
    B = bytes(raw)  # bson Binary -> raw bytes

    leading_uint32 = int.from_bytes(B[0:4], "little")

    path_used = None
    try:
        D = zlib.decompress(B[4:])
        path_used = "zlib.decompress(B[4:])"
    except Exception as first_err:
        print(f"  B[4:] path failed ({type(first_err).__name__}: {first_err}); "
              f"falling back to B")
        D = zlib.decompress(B)
        path_used = "zlib.decompress(B)"

    print(f"  framing path that worked: {path_used}")
    print(f"  leading uint32 of B: {leading_uint32}")
    print(f"  decompressed length len(D): {len(D)}")
    print(f"  leading uint32 == len(D)? "
          f"{'YES' if leading_uint32 == len(D) else 'NO'}")

    L = int.from_bytes(D[0:4], "little")
    ref_doc = bson.decode(D[0:L])

    metricCount = int.from_bytes(D[L:L + 4], "little")
    deltaCount = int.from_bytes(D[L + 4:L + 8], "little")
    print(f"  L (reference BSON length): {L}")
    print(f"  metricCount: {metricCount}")
    print(f"  deltaCount: {deltaCount}")
    print(f"  len(D): {len(D)}")
except Exception as e:
    print(f"SECTION 4 ERROR: {type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# SECTION 5: flatten reference doc to ordered numeric leaf paths
# ---------------------------------------------------------------------------
print("\n=== SECTION 5 ===")
try:
    if ref_doc is None:
        raise RuntimeError("no reference document decoded in section 4")

    paths = []

    def is_int(v):
        # bool is a subclass of int; handle separately. Int64 is a subclass too.
        return isinstance(v, int) and not isinstance(v, bool)

    def flatten(value, prefix):
        """Append dotted numeric-leaf paths in document order.
        int32/int64/double/bool/datetime -> 1; Timestamp -> 2 (time, increment)."""
        if isinstance(value, dict):
            for k, v in value.items():
                child = f"{prefix}.{k}" if prefix else k
                flatten(v, child)
        elif isinstance(value, list):
            for i, v in enumerate(value):
                child = f"{prefix}.{i}" if prefix else str(i)
                flatten(v, child)
        elif isinstance(value, bool):
            paths.append(prefix)
        elif isinstance(value, Timestamp):
            paths.append(prefix + ".time")
            paths.append(prefix + ".increment")
        elif isinstance(value, datetime.datetime):
            paths.append(prefix)
        elif is_int(value):  # int32 / int64 (incl. Int64)
            paths.append(prefix)
        elif isinstance(value, float):  # double
            paths.append(prefix)
        else:
            # strings, ObjectId, bytes, None, etc. -> ignored
            pass

    flatten(ref_doc, "")

    total_leaves = len(paths)
    print(f"  total numeric-leaf count: {total_leaves}")
    if metricCount is not None:
        verdict = "MATCH" if total_leaves == metricCount else "MISMATCH"
        print(f"  vs metricCount: {verdict} "
              f"(flattener={total_leaves}, metricCount={metricCount})")
    else:
        print("  metricCount unavailable from section 4; cannot validate")

    print("\n  first 80 flattened paths:")
    for p in paths[:80]:
        print(f"    {p}")

    needles = [
        "wiredTiger.cache", "wiredTiger.checkpoint", "systemMetrics",
        "tcmalloc", "opcounters", "repl", "page_faults", "disks",
    ]
    print("\n  paths matching keywords of interest:")
    matched = [p for p in paths if any(n in p for n in needles)]
    if matched:
        for p in matched:
            print(f"    {p}")
    else:
        print("    (none)")
    print(f"\n  total matching paths: {len(matched)}")
except Exception as e:
    print(f"SECTION 5 ERROR: {type(e).__name__}: {e}")

print("\n=== DONE ===")
