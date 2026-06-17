"""FTDC (Full-Time Diagnostic Data Capture) decoder.

A MongoDB diagnostic.data metrics file is a concatenation of BSON documents.
Each document has an integer ``type`` field:

    type 0  -> metadata document (host/build info), under key ``doc``
    type 1  -> metric chunk, with a zlib-framed delta-encoded sample matrix
               under key ``data`` (BSON BinData).

This module reconstructs the per-metric time series. See decode_file /
decode_directory for the public API.
"""

import os
import zlib
import datetime
from collections import defaultdict

import numpy as np
import bson
from bson import decode_file_iter
from bson.timestamp import Timestamp

MASK64 = (1 << 64) - 1
_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


# ---------------------------------------------------------------------------
# Value coercion + reference-document flattening
# ---------------------------------------------------------------------------
def _datetime_to_ms(dt):
    """Epoch milliseconds for a (possibly naive-UTC) datetime, computed exactly."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    delta = dt - _EPOCH
    return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000


def flatten(ref):
    """Flatten a reference document into an ordered list of (path, value0).

    Traversal is in document order, recursing into sub-documents and arrays
    (array index becomes a path segment). Numeric leaves only:

        int32/int64/double/bool/datetime -> ONE metric (int-coerced)
        BSON Timestamp                    -> TWO metrics: (time secs, increment)

    Strings, ObjectId, null, binary, etc. are ignored.
    """
    out = []

    def walk(value, prefix):
        if isinstance(value, dict):
            for k, v in value.items():
                walk(v, k if not prefix else prefix + "." + k)
        elif isinstance(value, list):
            for i, v in enumerate(value):
                seg = str(i)
                walk(v, seg if not prefix else prefix + "." + seg)
        elif isinstance(value, bool):
            out.append((prefix, 1 if value else 0))
        elif isinstance(value, Timestamp):
            # Two consecutive, distinct, stable leaf paths: time then increment.
            out.append((prefix + "․t", value.time))
            out.append((prefix + "․i", value.inc))
        elif isinstance(value, datetime.datetime):
            out.append((prefix, _datetime_to_ms(value)))
        elif isinstance(value, int):  # int32 / int64 (bool already handled above)
            out.append((prefix, int(value)))
        elif isinstance(value, float):  # double -> truncate toward zero
            out.append((prefix, int(value)))
        # else: string, ObjectId, bytes, None, ... -> ignored
    walk(ref, "")
    return out


# ---------------------------------------------------------------------------
# Varint + delta-matrix decoding
# ---------------------------------------------------------------------------
def read_varint(buf, pos):
    """Unsigned LEB128 (7 bits/byte, low-order first, high bit = continuation)."""
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def _decode_delta_slots(buf, pos, total):
    """Decode ``total`` delta slots with zero run-length encoding.

    Returns (np.uint64[total], new_pos). Slots are emitted in stream order;
    the caller reshapes to (metricCount, deltaCount) column-major.
    """
    out = np.zeros(total, dtype=np.uint64)
    nzeroes = 0
    i = 0
    while i < total:
        if nzeroes > 0:
            # delta == 0 (out already zero-filled)
            nzeroes -= 1
            i += 1
            continue
        delta, pos = read_varint(buf, pos)
        if delta == 0:
            # This slot is zero; the next varint says how many ADDITIONAL zeros.
            nzeroes, pos = read_varint(buf, pos)
            i += 1
            continue
        out[i] = delta & MASK64
        i += 1
    return out, pos


def _reconstruct(value0, deltas_row):
    """Series of length len(deltas_row)+1 with uint64 wraparound, as int64."""
    n = deltas_row.shape[0]
    out = np.empty(n + 1, dtype=np.uint64)
    out[0] = np.uint64(value0 & MASK64)
    if n:
        cs = np.cumsum(deltas_row.astype(np.uint64, copy=False))  # uint64 wraps
        out[1:] = out[0] + cs  # uint64 wraps
    return out.view(np.int64)


def _parse_chunk(doc):
    """Decode one type-1 chunk doc -> (paths, value0s, matrix[metricCount,deltaCount])."""
    B = bytes(doc["data"])
    D = zlib.decompress(B[4:])  # framing confirmed: B[:4] LE uint32 == len(D)
    L = int.from_bytes(D[0:4], "little")
    ref = bson.decode(D[0:L])
    metric_count = int.from_bytes(D[L:L + 4], "little")
    delta_count = int.from_bytes(D[L + 4:L + 8], "little")

    flat = flatten(ref)
    paths = [p for p, _ in flat]
    value0s = [v for _, v in flat]

    total = metric_count * delta_count
    slots, _ = _decode_delta_slots(D, L + 8, total)
    matrix = slots.reshape(metric_count, delta_count)
    return paths, value0s, matrix, metric_count, delta_count


# ---------------------------------------------------------------------------
# Core accumulation across an iterable of BSON documents
# ---------------------------------------------------------------------------
def _accumulate(doc_iter, keep_paths):
    metadata = {}
    ts_segments = []
    series_lists = defaultdict(list)   # path -> list of np.int64 arrays
    last_known = {}                    # path -> last reconstructed value
    emitted = 0                        # total samples emitted so far
    chunk_index = -1

    for doc in doc_iter:
        t = doc.get("type")
        if t == 0:
            if not metadata:
                d = doc.get("doc", {}) or {}
                host_info = d.get("hostInfo", {}) or {}
                system = host_info.get("system", {}) or {}
                build_info = d.get("buildInfo", {}) or {}
                metadata = {
                    "hostname": system.get("hostname"),
                    "version": build_info.get("version"),
                    "numCores": system.get("numCores"),
                    "memSizeMB": system.get("memSizeMB"),
                    "cpuArch": system.get("cpuArch"),
                }
            continue
        if t != 1:
            continue

        chunk_index += 1
        paths, value0s, matrix, metric_count, delta_count = _parse_chunk(doc)
        if len(paths) != metric_count:
            raise ValueError(
                f"chunk {chunk_index}: flattened metric count {len(paths)} != "
                f"metricCount {metric_count}"
            )
        n_samples = delta_count + 1

        # First occurrence wins for the path -> row mapping (schema may drift).
        path_to_row = {}
        for row, p in enumerate(paths):
            if p not in path_to_row:
                path_to_row[p] = row

        # Timestamps come from the top-level 'start' metric, always.
        if "start" not in path_to_row:
            raise ValueError(f"chunk {chunk_index}: no top-level 'start' metric")
        ts_segments.append(_reconstruct(value0s[path_to_row["start"]],
                                        matrix[path_to_row["start"]]))

        # Which paths to materialise this chunk.
        if keep_paths is None:
            target = set(path_to_row) | set(series_lists)
        else:
            target = set(keep_paths)

        for p in target:
            if p not in series_lists:
                # Backfill prior span (this path appeared late) with zeros.
                series_lists[p] = [np.zeros(emitted, dtype=np.int64)] if emitted else []
            if p in path_to_row:
                row = path_to_row[p]
                arr = _reconstruct(value0s[row], matrix[row])
                last_known[p] = int(arr[-1])
            else:
                # Absent in this chunk: fill span with last known value (or 0).
                arr = np.full(n_samples, last_known.get(p, 0), dtype=np.int64)
            series_lists[p].append(arr)

        emitted += n_samples

    timestamps = (np.concatenate(ts_segments) if ts_segments
                  else np.empty(0, dtype=np.int64))
    series = {p: (np.concatenate(chunks) if chunks else np.empty(0, dtype=np.int64))
              for p, chunks in series_lists.items()}
    return timestamps, series, metadata


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def decode_file(path, keep_paths=None):
    """Decode a single metrics file.

    Returns (timestamps: int64 epoch-ms, series: dict[path -> int64 array],
    metadata: dict). Samples are concatenated across all chunks in the file.
    """
    def docs():
        with open(path, "rb") as fh:
            for doc in decode_file_iter(fh):
                yield doc
    return _accumulate(docs(), keep_paths)


def _metrics_files_in_order(dirpath):
    names = os.listdir(dirpath)
    regular = sorted(n for n in names
                     if n.startswith("metrics.") and n != "metrics.interim")
    ordered = list(regular)
    if "metrics.interim" in names:
        ordered.append("metrics.interim")  # interim always last
    return [os.path.join(dirpath, n) for n in ordered]


def decode_directory(dirpath, keep_paths=None):
    """Decode all metrics.* files in a directory in chronological filename order
    (metrics.interim last), concatenating into a single set of series."""
    files = _metrics_files_in_order(dirpath)

    def docs():
        for p in files:
            with open(p, "rb") as fh:
                for doc in decode_file_iter(fh):
                    yield doc
    return _accumulate(docs(), keep_paths)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    DATA_03 = ("/Users/manishsinha/Desktop/projects/ftdc-analyzer/files/upload/"
               "ludo-prod-mongo-03/diagnostic.data")
    TARGET = os.path.join(DATA_03, "metrics.2026-06-16T04-30-02Z-00000")

    SELFTEST_KEEP = {
        "start",
        "serverStatus.wiredTiger.cache.maximum bytes configured",
        "serverStatus.wiredTiger.cache.bytes currently in the cache",
        "serverStatus.opcounters.insert",
        "serverStatus.opcounters.query",
        "systemMetrics.cpu.idle_ms",
    }

    ts, series, meta = decode_file(TARGET, keep_paths=SELFTEST_KEEP)

    GB = 1024 ** 3

    def to_dt(ms):
        return datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)

    print("=== METADATA ===")
    print(f"  hostname : {meta.get('hostname')}")
    print(f"  version  : {meta.get('version')}")
    print(f"  numCores : {meta.get('numCores')}")
    print(f"  memSizeMB: {meta.get('memSizeMB')}")

    print("\n=== SAMPLES / TIMESPAN ===")
    n = len(ts)
    print(f"  samples       : {n}")
    if n:
        first, last = to_dt(int(ts[0])), to_dt(int(ts[-1]))
        span = last - first
        print(f"  first timestamp: {first.isoformat()}")
        print(f"  last  timestamp: {last.isoformat()}")
        print(f"  total span     : {span} ({(ts[-1]-ts[0])/1000:.1f} s)")

    print("\n=== wiredTiger.cache.maximum bytes configured ===")
    mbc = series["serverStatus.wiredTiger.cache.maximum bytes configured"]
    mbc_min, mbc_max = int(mbc.min()), int(mbc.max())
    print(f"  min: {mbc_min}  max: {mbc_max}  (constant: {mbc_min == mbc_max})")
    print(f"  value: {mbc_max / GB:.3f} GB")
    mem_mb = meta.get("memSizeMB") or 0
    expected_bytes = ((mem_mb - 1024) / 2) * 1024 * 1024
    print(f"  expected ~= (memSizeMB-1024)/2 = {(mem_mb-1024)/2:.0f} MB "
          f"= {expected_bytes / GB:.3f} GB")
    if expected_bytes > 0:
        diff = abs(mbc_max - expected_bytes) / expected_bytes
        print(f"  within 10%? {'PASS' if diff <= 0.10 else 'FAIL'} "
              f"(deviation {diff*100:.2f}%)")

    print("\n=== wiredTiger.cache.bytes currently in the cache ===")
    cur = series["serverStatus.wiredTiger.cache.bytes currently in the cache"]
    print(f"  min: {int(cur.min())/GB:.3f} GB  max: {int(cur.max())/GB:.3f} GB")

    print("\n=== opcounters ===")
    for key in ("serverStatus.opcounters.insert", "serverStatus.opcounters.query"):
        s = series[key]
        f, l = int(s[0]), int(s[-1])
        print(f"  {key.split('.')[-1]:7s} first={f} last={l} delta={l - f}")

    print("\n=== systemMetrics.cpu.idle_ms ===")
    idle = series["systemMetrics.cpu.idle_ms"]
    print(f"  first={int(idle[0])} last={int(idle[-1])}")
