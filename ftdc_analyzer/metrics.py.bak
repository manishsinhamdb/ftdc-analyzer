"""Derived FTDC signals.

Decodes a full diagnostic.data directory once (curated keep set), then computes
per-second rates and gauge signals from the cumulative counters, and prints a
summary table. Built on the validated ftdc_analyzer.decoder.
"""

import os
import warnings
import datetime

import numpy as np

from ftdc_analyzer import decoder

warnings.filterwarnings("ignore", category=RuntimeWarning)  # all-NaN slices etc.

DISKS = ["nvme0n1", "nvme1n1"]
DISK_FIELDS = ["reads", "writes", "read_sectors", "write_sectors",
               "read_time_ms", "write_time_ms", "io_time_ms", "io_in_progress"]


def _disk(d, f):
    return f"systemMetrics.disks.{d}.{f}"


# Atlas-style candidate source paths probed for presence; only PRESENT ones
# yield derived signals (the S()/rate()/gauge() guards return None otherwise).
CANDIDATE_PATHS = [
    "serverStatus.mem.resident",
    "serverStatus.mem.virtual",
    "serverStatus.network.bytesIn",
    "serverStatus.network.bytesOut",
    "serverStatus.network.numRequests",
    "serverStatus.metrics.document.returned",
    "serverStatus.metrics.document.inserted",
    "serverStatus.metrics.document.updated",
    "serverStatus.metrics.document.deleted",
    "serverStatus.metrics.queryExecutor.scanned",
    "serverStatus.metrics.queryExecutor.scannedObjects",
    "serverStatus.metrics.operation.scanAndOrder",
    "serverStatus.metrics.operation.writeConflicts",
    "serverStatus.wiredTiger.concurrentTransactions.read.out",
    "serverStatus.wiredTiger.concurrentTransactions.read.available",
    "serverStatus.wiredTiger.concurrentTransactions.read.totalTickets",
    "serverStatus.wiredTiger.concurrentTransactions.write.out",
    "serverStatus.wiredTiger.concurrentTransactions.write.available",
    "serverStatus.wiredTiger.concurrentTransactions.write.totalTickets",
    "serverStatus.connections.totalCreated",
    "serverStatus.globalLock.activeClients.readers",
    "serverStatus.globalLock.activeClients.writers",
    "serverStatus.extra_info.page_faults",
    "serverStatus.metrics.repl.network.getmores.num",
    "serverStatus.metrics.repl.apply.ops",
    "serverStatus.metrics.repl.buffer.sizeBytes",
    "serverStatus.opLatencies.commands.latency",
    "serverStatus.opLatencies.commands.ops",
    "systemMetrics.cpu.procs_running",
    "systemMetrics.cpu.procs_blocked",
    "systemMetrics.disks.nvme1n1.io_in_progress",
    # --- additive (Part 2): errors/asserts, queue, checkpoint, eviction, log,
    # cursors, ttl. Absent paths simply yield None signals (graceful). ---
    "serverStatus.asserts.rollovers",
    "serverStatus.globalLock.currentQueue.total",
    "serverStatus.globalLock.activeClients.total",
    "serverStatus.wiredTiger.transaction.transaction checkpoint most recent time (msecs)",
    "serverStatus.wiredTiger.transaction.transaction checkpoint min time (msecs)",
    "serverStatus.wiredTiger.transaction.transaction checkpoint max time (msecs)",
    "serverStatus.wiredTiger.cache.modified pages evicted",
    "serverStatus.wiredTiger.cache.unmodified pages evicted",
    "serverStatus.wiredTiger.log.log bytes written",
    "serverStatus.wiredTiger.log.log write operations",
    "serverStatus.wiredTiger.log.log sync operations",
    "serverStatus.metrics.cursor.open.noTimeout",
    "serverStatus.metrics.cursor.open.pinned",
    "serverStatus.metrics.ttl.deletedDocuments",
    "serverStatus.metrics.ttl.passes",
]


def _build_curated():
    P = set()
    P.add("start")
    # cache gauges
    P |= {
        "serverStatus.wiredTiger.cache.maximum bytes configured",
        "serverStatus.wiredTiger.cache.bytes currently in the cache",
        "serverStatus.wiredTiger.cache.tracked dirty bytes in the cache",
    }
    # cache counters
    P |= {
        "serverStatus.wiredTiger.cache.pages read into cache",
        "serverStatus.wiredTiger.cache.pages written from cache",
        "serverStatus.wiredTiger.cache.pages evicted by application threads",
        "serverStatus.wiredTiger.cache.modified pages evicted by application threads",
        "serverStatus.wiredTiger.cache.bytes read into cache",
        "serverStatus.wiredTiger.cache.bytes written from cache",
        "serverStatus.wiredTiger.cache.application threads page read from disk to cache count",
        "serverStatus.wiredTiger.cache.application threads page read from disk to cache time (usecs)",
    }
    # cpu
    for f in ["user_ms", "nice_ms", "system_ms", "idle_ms", "iowait_ms", "irq_ms",
              "softirq_ms", "steal_ms", "num_cpus", "procs_running", "procs_blocked"]:
        P.add(f"systemMetrics.cpu.{f}")
    # memory
    for f in ["MemTotal_kb", "MemFree_kb", "Cached_kb", "Buffers_kb", "Dirty_kb",
              "SwapTotal_kb", "SwapFree_kb"]:
        P.add(f"systemMetrics.memory.{f}")
    # process heap
    P |= {
        "serverStatus.tcmalloc.generic.current_allocated_bytes",
        "serverStatus.tcmalloc.generic.heap_size",
        "serverStatus.tcmalloc.tcmalloc.pageheap_free_bytes",
        "serverStatus.tcmalloc.tcmalloc.pageheap_unmapped_bytes",
        "serverStatus.tcmalloc.tcmalloc.total_free_bytes",
    }
    # disks
    for d in DISKS:
        for f in DISK_FIELDS:
            P.add(_disk(d, f))
    # op latency
    for grp in ["reads", "writes", "commands"]:
        for f in ["latency", "ops"]:
            P.add(f"serverStatus.opLatencies.{grp}.{f}")
    # throughput
    for f in ["insert", "query", "update", "delete", "getmore", "command"]:
        P.add(f"serverStatus.opcounters.{f}")
    for f in ["insert", "update", "delete", "command"]:
        P.add(f"serverStatus.opcountersRepl.{f}")
    # contention
    P |= {
        "serverStatus.globalLock.currentQueue.readers",
        "serverStatus.globalLock.currentQueue.writers",
        "serverStatus.connections.current",
        "serverStatus.connections.available",
    }
    # health
    for f in ["regular", "warning", "msg", "user"]:
        P.add(f"serverStatus.asserts.{f}")
    # repl
    P.add("replSetGetStatus.myState")
    for i in range(3):
        P.add(f"replSetGetStatus.members.{i}.optimeDate")
        P.add(f"replSetGetStatus.members.{i}.state")
    # Atlas-style candidates (additive).
    for p in CANDIDATE_PATHS:
        P.add(p)
    # Sharding correlation (additive).
    P.add("serverStatus.shardingStatistics.countStaleConfigErrors")
    # Checkpoint-running indicator (additive) — visualizes checkpoint saturation.
    P.add("serverStatus.wiredTiger.transaction.transaction checkpoint currently running")
    # Cursors (additive).
    P.add("serverStatus.metrics.cursor.open.total")
    P.add("serverStatus.metrics.cursor.timedOut")
    return P


CURATED_PATHS = _build_curated()


def probe(dirpath):
    """Return [(path, present_bool)] for each CANDIDATE_PATHS entry."""
    avail = _available_paths(dirpath)
    return [(p, p in avail) for p in CANDIDATE_PATHS]


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------
def _available_paths(dirpath):
    """The actual leaf-path schema, from the first type-1 chunk in the directory.

    The decoder fills keep-set paths that are absent in the data with zeros, so a
    path missing here (but present, all-zero, in the decoded series) is genuinely
    absent rather than merely constant.
    """
    for doc in decoder.iter_directory_docs(dirpath):
        if doc.get("type") == 1:
            paths, _, _, _, _ = decoder._parse_chunk(doc)
            return set(paths)
    return set()


def extract(dirpath, on_skip=None):
    skipped = []
    ts, series, meta = decoder.decode_directory(
        dirpath, keep_paths=CURATED_PATHS, skipped=skipped, on_skip=on_skip)
    avail = _available_paths(dirpath)
    missing = sorted(p for p in CURATED_PATHS if p not in avail)

    # role: mode of myState (1=PRIMARY, 2=SECONDARY)
    role_label, role_counts = "UNKNOWN", {}
    if "replSetGetStatus.myState" in avail:
        states = series["replSetGetStatus.myState"]
        vals, counts = np.unique(states, return_counts=True)
        role_counts = {int(v): int(c) for v, c in zip(vals, counts)}
        mode_state = int(vals[int(np.argmax(counts))])
        role_label = {1: "PRIMARY", 2: "SECONDARY"}.get(mode_state, f"STATE_{mode_state}")

    # data_disk: the disk with the larger total Δio_time_ms
    io_totals = {}
    for d in DISKS:
        p = _disk(d, "io_time_ms")
        if p in avail:
            v = series[p].astype(np.float64)
            io_totals[d] = float(np.nansum(np.clip(np.diff(v), 0, None)))
        else:
            io_totals[d] = 0.0
    data_disk = max(io_totals, key=io_totals.get) if io_totals else None

    return {
        "ts": ts, "series": series, "meta": meta, "avail": avail,
        "missing": missing, "role": role_label, "role_counts": role_counts,
        "io_totals": io_totals, "data_disk": data_disk, "skipped": skipped,
    }


# ---------------------------------------------------------------------------
# Derivation
# ---------------------------------------------------------------------------
def derive(ex):
    ts = ex["ts"].astype(np.float64)
    series, avail = ex["series"], ex["avail"]
    n = len(ts)
    dt_s = np.diff(ts) / 1000.0  # seconds between consecutive samples (n-1)

    def S(path):
        """Float series if genuinely present, else None."""
        if path in avail and path in series:
            return series[path].astype(np.float64)
        return None

    def gauge(path):
        v = S(path)
        return None if v is None else v[1:]

    def delta(path):
        """Consecutive diff, NaN where dt<=0; reset (dv<0) left as-is for callers."""
        v = S(path)
        if v is None:
            return None
        dv = np.diff(v)
        dv = np.where(dt_s <= 0, np.nan, dv)
        return dv

    def rate(path):
        dv = delta(path)
        if dv is None:
            return None
        r = dv / dt_s
        return np.where(dv < 0, np.nan, r)

    sig = {}  # ordered dict (py3.7+) label -> array(n-1) or None

    # --- cache (gauges) ---
    maxb = S("serverStatus.wiredTiger.cache.maximum bytes configured")
    curb = S("serverStatus.wiredTiger.cache.bytes currently in the cache")
    dirtyb = S("serverStatus.wiredTiger.cache.tracked dirty bytes in the cache")
    sig["cache_used_pct"] = (curb / maxb * 100)[1:] if (curb is not None and maxb is not None) else None
    sig["cache_dirty_pct"] = (dirtyb / maxb * 100)[1:] if (dirtyb is not None and maxb is not None) else None

    # --- cpu ---
    comp = {f: delta(f"systemMetrics.cpu.{f}") for f in
            ["user_ms", "nice_ms", "system_ms", "idle_ms", "iowait_ms",
             "irq_ms", "softirq_ms", "steal_ms"]}
    if all(comp[k] is not None for k in comp):
        active = (comp["user_ms"] + comp["nice_ms"] + comp["system_ms"]
                  + comp["irq_ms"] + comp["softirq_ms"] + comp["steal_ms"])
        total = active + comp["idle_ms"] + comp["iowait_ms"]
        bad = total <= 0
        sig["cpu_util_pct"] = np.where(bad, np.nan, active / total * 100)
        sig["cpu_iowait_pct"] = np.where(bad, np.nan, comp["iowait_ms"] / total * 100)
        sig["cpu_steal_pct"] = np.where(bad, np.nan, comp["steal_ms"] / total * 100)
        sig["cpu_user_pct"] = np.where(bad, np.nan, comp["user_ms"] / total * 100)
        sig["cpu_system_pct"] = np.where(bad, np.nan, comp["system_ms"] / total * 100)
    else:
        sig["cpu_util_pct"] = sig["cpu_iowait_pct"] = sig["cpu_steal_pct"] = None
        sig["cpu_user_pct"] = sig["cpu_system_pct"] = None
    sig["procs_running"] = gauge("systemMetrics.cpu.procs_running")
    sig["procs_blocked"] = gauge("systemMetrics.cpu.procs_blocked")

    # --- memory ---
    memtot = S("systemMetrics.memory.MemTotal_kb")
    memfree = S("systemMetrics.memory.MemFree_kb")
    cached = S("systemMetrics.memory.Cached_kb")
    buffers = S("systemMetrics.memory.Buffers_kb")
    swaptot = S("systemMetrics.memory.SwapTotal_kb")
    swapfree = S("systemMetrics.memory.SwapFree_kb")
    sig["mem_free_pct"] = (memfree / memtot * 100)[1:] if (memfree is not None and memtot is not None) else None
    sig["page_cache_gb"] = ((cached + buffers) / 1048576)[1:] if (cached is not None and buffers is not None) else None
    sig["swap_used_mb"] = ((swaptot - swapfree) / 1024)[1:] if (swaptot is not None and swapfree is not None) else None

    # --- process heap ---
    alloc = S("serverStatus.tcmalloc.generic.current_allocated_bytes")
    sig["mongod_alloc_gb"] = (alloc / 1073741824)[1:] if alloc is not None else None

    # --- data disk ---
    d = ex["data_disk"]
    if d is not None:
        dreads = delta(_disk(d, "reads"))
        dwrites = delta(_disk(d, "writes"))
        sig["disk_read_iops"] = rate(_disk(d, "reads"))
        sig["disk_write_iops"] = rate(_disk(d, "writes"))
        ri, wi = sig["disk_read_iops"], sig["disk_write_iops"]
        sig["disk_iops"] = (ri + wi) if (ri is not None and wi is not None) else None
        dio = delta(_disk(d, "io_time_ms"))
        if dio is not None:
            util = np.where(dio < 0, np.nan, dio / (dt_s * 1000) * 100)
            sig["disk_util_pct"] = np.minimum(util, 100.0)
        else:
            sig["disk_util_pct"] = None
        drt = delta(_disk(d, "read_time_ms"))
        sig["disk_avg_read_ms"] = (np.where((dreads <= 0), np.nan, drt / dreads)
                                   if (drt is not None and dreads is not None) else None)
        dwt = delta(_disk(d, "write_time_ms"))
        sig["disk_avg_write_ms"] = (np.where((dwrites <= 0), np.nan, dwt / dwrites)
                                    if (dwt is not None and dwrites is not None) else None)
        sig["disk_queue_depth"] = gauge(_disk(d, "io_in_progress"))
        drs = delta(_disk(d, "read_sectors"))
        sig["disk_read_mbps"] = (np.where(drs < 0, np.nan, drs * 512 / 1e6 / dt_s)
                                 if drs is not None else None)
        dws = delta(_disk(d, "write_sectors"))
        sig["disk_write_mbps"] = (np.where(dws < 0, np.nan, dws * 512 / 1e6 / dt_s)
                                  if dws is not None else None)

    # --- op latency ---
    for grp, label in [("reads", "oplat_read_ms"), ("writes", "oplat_write_ms"),
                       ("commands", "oplat_cmd_ms")]:
        dl = delta(f"serverStatus.opLatencies.{grp}.latency")
        do = delta(f"serverStatus.opLatencies.{grp}.ops")
        sig[label] = (np.where(do <= 0, np.nan, dl / do / 1000)
                      if (dl is not None and do is not None) else None)

    # --- throughput ---
    op_rates = {}
    for f in ["insert", "query", "update", "delete", "getmore", "command"]:
        r = rate(f"serverStatus.opcounters.{f}")
        op_rates[f] = r
        sig[f"ops_{f}_ps"] = r
    present_ops = [r for r in op_rates.values() if r is not None]
    sig["ops_total_ps"] = (np.nansum(np.vstack(present_ops), axis=0)
                           if present_ops else None)
    repl_rates = [rate(f"serverStatus.opcountersRepl.{f}")
                  for f in ["insert", "update", "delete", "command"]]
    repl_present = [r for r in repl_rates if r is not None]
    sig["repl_writes_ps"] = (np.nansum(np.vstack(repl_present), axis=0)
                             if repl_present else None)

    # --- wiredTiger flow ---
    sig["wt_pages_read_into_cache_ps"] = rate("serverStatus.wiredTiger.cache.pages read into cache")
    sig["wt_pages_written_ps"] = rate("serverStatus.wiredTiger.cache.pages written from cache")
    sig["wt_app_evict_ps"] = rate("serverStatus.wiredTiger.cache.pages evicted by application threads")
    dtime = delta("serverStatus.wiredTiger.cache.application threads page read from disk to cache time (usecs)")
    dcount = delta("serverStatus.wiredTiger.cache.application threads page read from disk to cache count")
    sig["wt_app_read_into_cache_us"] = (np.where(dcount <= 0, np.nan, dtime / dcount)
                                        if (dtime is not None and dcount is not None) else None)

    # --- contention ---
    sig["read_queue"] = gauge("serverStatus.globalLock.currentQueue.readers")
    sig["write_queue"] = gauge("serverStatus.globalLock.currentQueue.writers")
    sig["connections_current"] = gauge("serverStatus.connections.current")

    # --- health ---
    da = [delta(f"serverStatus.asserts.{f}") for f in ["regular", "warning", "msg", "user"]]
    if all(x is not None for x in da):
        ssum = da[0] + da[1] + da[2] + da[3]
        sig["asserts_per_min"] = np.where(ssum < 0, np.nan, ssum / dt_s * 60)
    else:
        sig["asserts_per_min"] = None

    # --- repl lag (per member vs the most-recent/primary optime) ---
    optime_members = {i: S(f"replSetGetStatus.members.{i}.optimeDate") for i in range(3)}
    optime_present = {i: v for i, v in optime_members.items() if v is not None}
    if len(optime_present) >= 2:
        stacked = np.vstack(list(optime_present.values()))  # ms, full length
        primary_optime = stacked.max(axis=0)   # the freshest member is the primary
        # max secondary lag = freshest - stalest
        sig["repl_lag_s"] = ((primary_optime - stacked.min(axis=0)) / 1000.0)[1:]
        # per-member seconds behind the primary (clamped >= 0)
        for i, v in optime_present.items():
            member_lag = np.clip((primary_optime - v) / 1000.0, 0.0, None)
            sig[f"repl_lag_member_{i}_s"] = member_lag[1:]
    else:
        sig["repl_lag_s"] = None

    # --- Atlas-style additional signals (additive; absent paths -> None) ---
    def srate(path, factor):
        r = rate(path)
        return None if r is None else r * factor

    def ratio_pct(num_path, den_path):
        """100 * num/den per sample, NaN where den<=0, aligned to samples[1:]."""
        num = S(num_path)
        den = S(den_path)
        if num is None or den is None:
            return None
        return np.where(den > 0, num / den * 100, np.nan)[1:]

    # rates: document metrics
    sig["docs_returned_ps"] = rate("serverStatus.metrics.document.returned")
    sig["docs_inserted_ps"] = rate("serverStatus.metrics.document.inserted")
    sig["docs_updated_ps"] = rate("serverStatus.metrics.document.updated")
    sig["docs_deleted_ps"] = rate("serverStatus.metrics.document.deleted")
    # rates: query executor / operation
    sig["keys_scanned_ps"] = rate("serverStatus.metrics.queryExecutor.scanned")
    sig["objs_scanned_ps"] = rate("serverStatus.metrics.queryExecutor.scannedObjects")
    sig["scan_and_order_ps"] = rate("serverStatus.metrics.operation.scanAndOrder")
    sig["write_conflicts_ps"] = rate("serverStatus.metrics.operation.writeConflicts")
    # rates: network
    sig["net_in_mbps"] = srate("serverStatus.network.bytesIn", 1.0 / 1e6)
    sig["net_out_mbps"] = srate("serverStatus.network.bytesOut", 1.0 / 1e6)
    sig["net_requests_ps"] = rate("serverStatus.network.numRequests")
    # rates: cache I/O bytes
    sig["cache_read_mbps"] = srate("serverStatus.wiredTiger.cache.bytes read into cache", 1.0 / 1e6)
    sig["cache_write_mbps"] = srate("serverStatus.wiredTiger.cache.bytes written from cache", 1.0 / 1e6)
    # rates: connections / faults / repl
    sig["conn_created_ps"] = rate("serverStatus.connections.totalCreated")
    sig["page_faults_ps"] = rate("serverStatus.extra_info.page_faults")
    sig["repl_getmores_ps"] = rate("serverStatus.metrics.repl.network.getmores.num")
    sig["repl_apply_ops_ps"] = rate("serverStatus.metrics.repl.apply.ops")

    # pct / ratio
    sig["cpu_user_pct"] = sig.get("cpu_user_pct")      # set in cpu block (keep order stable)
    sig["cpu_system_pct"] = sig.get("cpu_system_pct")
    sig["read_ticket_util_pct"] = ratio_pct(
        "serverStatus.wiredTiger.concurrentTransactions.read.out",
        "serverStatus.wiredTiger.concurrentTransactions.read.totalTickets")
    sig["write_ticket_util_pct"] = ratio_pct(
        "serverStatus.wiredTiger.concurrentTransactions.write.out",
        "serverStatus.wiredTiger.concurrentTransactions.write.totalTickets")

    cur = S("serverStatus.connections.current")
    cav = S("serverStatus.connections.available")
    sig["conn_used_pct"] = (np.where((cur + cav) > 0, cur / (cur + cav) * 100, np.nan)[1:]
                            if (cur is not None and cav is not None) else None)

    objs = sig["objs_scanned_ps"]
    docr = sig["docs_returned_ps"]
    if objs is not None and docr is not None:
        denom = np.where(docr > 0, docr, np.nan)
        sig["query_targeting_ratio"] = objs / denom
    else:
        sig["query_targeting_ratio"] = None

    # gauges
    res = S("serverStatus.mem.resident")
    virt = S("serverStatus.mem.virtual")
    sig["mem_resident_gb"] = (res / 1024)[1:] if res is not None else None
    sig["mem_virtual_gb"] = (virt / 1024)[1:] if virt is not None else None
    sig["read_tickets_out"] = gauge("serverStatus.wiredTiger.concurrentTransactions.read.out")
    sig["write_tickets_out"] = gauge("serverStatus.wiredTiger.concurrentTransactions.write.out")
    sig["read_tickets_available"] = gauge("serverStatus.wiredTiger.concurrentTransactions.read.available")
    sig["write_tickets_available"] = gauge("serverStatus.wiredTiger.concurrentTransactions.write.available")
    sig["active_clients_readers"] = gauge("serverStatus.globalLock.activeClients.readers")
    sig["active_clients_writers"] = gauge("serverStatus.globalLock.activeClients.writers")
    rbuf = S("serverStatus.metrics.repl.buffer.sizeBytes")
    sig["repl_buffer_mb"] = (rbuf / 1048576)[1:] if rbuf is not None else None
    sig["queue_depth"] = (gauge(_disk(d, "io_in_progress")) if d is not None else None)

    # sharding: stale config error rate
    sig["stale_config_errors_ps"] = rate(
        "serverStatus.shardingStatistics.countStaleConfigErrors")

    # checkpoint-running indicator (0/1 gauge; MAX-agg highlights checkpoint windows)
    sig["wt_checkpoint_running"] = gauge(
        "serverStatus.wiredTiger.transaction.transaction checkpoint currently running")

    # --- GROUP 1: Query Efficiency (Atlas Query Targeting) ---
    def safe_ratio(num, den):
        """num/den per bucket; where the denominator rate is ~0 -> NaN (never inf)."""
        if num is None or den is None:
            return None
        den_safe = np.where(den > 0, den, 1.0)  # avoid div-by-zero entirely
        return np.where(den > 0, num / den_safe, np.nan)

    ret_ps = sig.get("docs_returned_ps")
    sig["keys_examined_per_returned"] = safe_ratio(sig.get("keys_scanned_ps"), ret_ps)
    sig["docs_examined_per_returned"] = safe_ratio(sig.get("objs_scanned_ps"), ret_ps)

    # --- GROUP 3: Cursors ---
    sig["cursors_open"] = gauge("serverStatus.metrics.cursor.open.total")
    sig["cursors_timed_out_ps"] = rate("serverStatus.metrics.cursor.timedOut")
    sig["cursors_no_timeout"] = gauge("serverStatus.metrics.cursor.open.noTimeout")
    sig["cursors_pinned"] = gauge("serverStatus.metrics.cursor.open.pinned")

    # --- GROUP 4: Errors & Asserts (per-type rates) ---
    for f in ["regular", "warning", "msg", "user", "rollovers"]:
        sig[f"asserts_{f}_ps"] = rate(f"serverStatus.asserts.{f}")

    # --- GROUP 4: global-lock queued operations (gauges) ---
    sig["queued_total"] = gauge("serverStatus.globalLock.currentQueue.total")
    sig["active_clients_total"] = gauge("serverStatus.globalLock.activeClients.total")

    # --- WiredTiger checkpoint duration (gauges, ms) ---
    sig["wt_checkpoint_recent_ms"] = gauge(
        "serverStatus.wiredTiger.transaction.transaction checkpoint most recent time (msecs)")
    sig["wt_checkpoint_min_ms"] = gauge(
        "serverStatus.wiredTiger.transaction.transaction checkpoint min time (msecs)")
    sig["wt_checkpoint_max_ms"] = gauge(
        "serverStatus.wiredTiger.transaction.transaction checkpoint max time (msecs)")

    # --- WiredTiger cache eviction composition (rates) ---
    sig["wt_modified_evict_ps"] = rate("serverStatus.wiredTiger.cache.modified pages evicted")
    sig["wt_unmodified_evict_ps"] = rate("serverStatus.wiredTiger.cache.unmodified pages evicted")

    # --- WiredTiger log throughput ---
    sig["wt_log_bytes_mbps"] = srate("serverStatus.wiredTiger.log.log bytes written", 1.0 / 1e6)
    sig["wt_log_write_ops_ps"] = rate("serverStatus.wiredTiger.log.log write operations")
    sig["wt_log_sync_ps"] = rate("serverStatus.wiredTiger.log.log sync operations")

    # --- TTL background deletes ---
    sig["ttl_deleted_ps"] = rate("serverStatus.metrics.ttl.deletedDocuments")
    sig["ttl_passes_ps"] = rate("serverStatus.metrics.ttl.passes")

    return sig, n


# ---------------------------------------------------------------------------
# __main__
# ---------------------------------------------------------------------------
def _summ(arr):
    """(p50, p95, p99, max) via nanpercentile; None/all-NaN safe."""
    if arr is None or len(arr) == 0 or not np.any(np.isfinite(arr)):
        return None
    p50, p95, p99 = np.nanpercentile(arr, [50, 95, 99])
    return p50, p95, p99, np.nanmax(arr)


def _to_dt(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)


# ---------------------------------------------------------------------------
# Full capture (all metrics, online-bucketed) + full metadata facts
# ---------------------------------------------------------------------------
_CATEGORY_RULES = [
    ("serverStatus.wiredTiger.cache", "WiredTiger Cache"),
    ("serverStatus.wiredTiger.concurrentTransactions", "WiredTiger Tickets"),
    ("serverStatus.wiredTiger.transaction", "WiredTiger Transactions"),
    ("serverStatus.wiredTiger.block-manager", "WiredTiger Block Manager"),
    ("serverStatus.wiredTiger.connection", "WiredTiger Connection"),
    ("serverStatus.wiredTiger.cursor", "WiredTiger Cursor"),
    ("serverStatus.wiredTiger.log", "WiredTiger Log"),
    ("serverStatus.wiredTiger.reconciliation", "WiredTiger Reconciliation"),
    ("serverStatus.wiredTiger.session", "WiredTiger Session"),
    ("serverStatus.wiredTiger.thread-yield", "WiredTiger Thread Yield"),
    ("serverStatus.wiredTiger", "WiredTiger"),
    ("serverStatus.metrics.repl", "Repl Metrics"),
    ("serverStatus.metrics.commands", "Command Metrics"),
    ("serverStatus.metrics.document", "Document Metrics"),
    ("serverStatus.metrics.operation", "Operation Metrics"),
    ("serverStatus.metrics.queryExecutor", "Query Executor"),
    ("serverStatus.metrics.cursor", "Cursor Metrics"),
    ("serverStatus.metrics.ttl", "TTL Metrics"),
    ("serverStatus.metrics.getLastError", "GetLastError Metrics"),
    ("serverStatus.metrics", "Metrics"),
    ("serverStatus.opcountersRepl", "Opcounters (Repl)"),
    ("serverStatus.opcounters", "Opcounters"),
    ("serverStatus.opLatencies", "Op Latencies"),
    ("serverStatus.opReadConcernCounters", "Read Concern Counters"),
    ("serverStatus.tcmalloc", "TCMalloc"),
    ("serverStatus.locks", "Locks"),
    ("serverStatus.globalLock", "Global Lock"),
    ("serverStatus.network", "Network"),
    ("serverStatus.connections", "Connections"),
    ("serverStatus.repl", "Replication (serverStatus)"),
    ("serverStatus.mem", "Memory (serverStatus)"),
    ("serverStatus.extra_info", "Extra Info"),
    ("serverStatus.asserts", "Asserts"),
    ("serverStatus.logicalSessionRecordCache", "Logical Sessions"),
    ("serverStatus.shardingStatistics", "Sharding Statistics"),
    ("serverStatus.transactions", "Transactions"),
    ("serverStatus.transportSecurity", "Transport Security"),
    ("serverStatus.storageEngine", "Storage Engine"),
    ("serverStatus", "Server Status"),
    ("systemMetrics.cpu", "System CPU"),
    ("systemMetrics.disks", "System Disks"),
    ("systemMetrics.memory", "System Memory"),
    ("systemMetrics.netstat", "System Netstat"),
    ("systemMetrics", "System Metrics"),
    ("replSetGetStatus", "Replication Status"),
    ("local.oplog.rs.stats.wiredTiger", "Oplog WiredTiger"),
    ("local.oplog.rs.stats", "Oplog Stats"),
    ("local.oplog.rs", "Oplog"),
    ("local", "Local DB"),
]


def category_for(path):
    """Human-grouped category from a dotted metric path (most specific wins)."""
    for prefix, label in _CATEGORY_RULES:
        if path == prefix or path.startswith(prefix + "."):
            return label
    parts = path.split(".")
    return " ".join(s.capitalize() for s in parts[:2]) or "Other"


def _round_sig(x, sig=4):
    if x is None or not np.isfinite(x):
        return None
    if x == 0:
        return 0.0
    import math
    return round(float(x), -int(math.floor(math.log10(abs(x)))) + (sig - 1))


def _round_out(x, kind):
    if x is None or not np.isfinite(x):
        return None
    return int(round(float(x))) if kind == "counter" else _round_sig(x, 4)


def _kind_of(col):
    finite = col[np.isfinite(col)]
    if finite.size < 3:
        return "gauge"
    d = np.diff(finite)
    if d.size == 0:
        return "gauge"
    nonneg = int(np.count_nonzero(d >= 0))
    return "counter" if nonneg / d.size > 0.95 else "gauge"


def _iter_type1(dirpath, skipped=None, on_skip=None):
    for doc in decoder.iter_directory_docs(dirpath, skipped=skipped, on_skip=on_skip):
        if doc.get("type") == 1:
            yield doc


def build_metrics_full(dirpath, n_points=2000, on_skip=None):
    """Decode ALL metrics with online equal-time bucketing — never holds a full
    full-resolution all-metric series in memory. Returns the metrics_full dict.
    Unreadable files are skipped gracefully via the shared iteration layer."""
    # Pass 0: find first & last type-1 chunk + capture metadata host/version (cheap;
    # decode_file_iter parses BSON framing but not the varint stream).
    first_doc = last_doc = None
    hostname = version = None
    for doc in decoder.iter_directory_docs(dirpath, on_skip=on_skip):
        t = doc.get("type")
        if t == 0 and hostname is None:
            md = doc.get("doc", {}) or {}
            bi = md.get("buildInfo", {}) or {}
            sysd = (md.get("hostInfo", {}) or {}).get("system", {}) or {}
            hostname = sysd.get("hostname")
            version = bi.get("version")
        elif t == 1:
            if first_doc is None:
                first_doc = doc
            last_doc = doc
    if first_doc is None:
        raise ValueError("no metric chunks found")

    def _start_and_paths(doc):
        paths, v0, matrix, _, _ = decoder._parse_chunk(doc)
        si = paths.index("start")
        ts = decoder._reconstruct(v0[si], matrix[si]).astype(np.int64)
        return ts, paths

    ts_first, global_paths = _start_and_paths(first_doc)
    ts_last, _ = _start_and_paths(last_doc)
    global_min = int(ts_first[0])
    global_max = int(ts_last[-1])
    if global_max <= global_min:
        global_max = global_min + 1
    bw = (global_max - global_min) / n_points

    global_paths = list(global_paths)
    index = {p: i for i, p in enumerate(global_paths)}
    M = len(global_paths)
    SUM = np.zeros((n_points, M), dtype=np.float64)
    CNT = np.zeros((n_points, M), dtype=np.float64)
    MN = np.full((n_points, M), np.inf, dtype=np.float64)
    MX = np.full((n_points, M), -np.inf, dtype=np.float64)

    def _grow(extra):
        nonlocal SUM, CNT, MN, MX
        SUM = np.concatenate([SUM, np.zeros((n_points, extra))], axis=1)
        CNT = np.concatenate([CNT, np.zeros((n_points, extra))], axis=1)
        MN = np.concatenate([MN, np.full((n_points, extra), np.inf)], axis=1)
        MX = np.concatenate([MX, np.full((n_points, extra), -np.inf)], axis=1)

    mask = decoder.MASK64
    for doc in _iter_type1(dirpath, on_skip=on_skip):
        paths, v0, matrix, mc, dc = decoder._parse_chunk(doc)
        v0u = np.array([int(x) & mask for x in v0], dtype=np.uint64)
        if dc > 0:
            csu = np.cumsum(matrix.astype(np.uint64), axis=1)
            Su = np.empty((mc, dc + 1), dtype=np.uint64)
            Su[:, 0] = v0u
            Su[:, 1:] = v0u[:, None] + csu
        else:
            Su = v0u[:, None].copy()
        S = Su.view(np.int64)                      # (mc, nsamples) signed
        si = paths.index("start")
        ts = S[si].astype(np.int64)
        bidx = np.clip(((ts - global_min) / bw).astype(np.int64), 0, n_points - 1)
        R = S.T.astype(np.float64)                 # (nsamples, mc)

        # contiguous groups (bidx is non-decreasing within a chunk)
        starts = np.concatenate(([0], np.nonzero(np.diff(bidx))[0] + 1))
        gb = bidx[starts]                          # unique bucket ids, ascending
        seg_sum = np.add.reduceat(R, starts, axis=0)
        seg_min = np.minimum.reduceat(R, starts, axis=0)
        seg_max = np.maximum.reduceat(R, starts, axis=0)
        seg_cnt = np.diff(np.append(starts, len(bidx))).astype(np.float64)

        # map this chunk's columns to global indices (handle rare schema drift)
        new = [p for p in paths if p not in index]
        if new:
            base = len(global_paths)
            for k, p in enumerate(new):
                index[p] = base + k
                global_paths.append(p)
            _grow(len(new))
        cols = np.fromiter((index[p] for p in paths), dtype=np.int64, count=mc)

        ix = np.ix_(gb, cols)
        SUM[ix] += seg_sum
        CNT[ix] += seg_cnt[:, None]
        MN[ix] = np.minimum(MN[ix], seg_min)
        MX[ix] = np.maximum(MX[ix], seg_max)
        del S, Su, R, matrix, seg_sum, seg_min, seg_max

    M = len(global_paths)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(CNT > 0, SUM / CNT, np.nan)
    MN = np.where(np.isfinite(MN), MN, np.nan)
    MX = np.where(np.isfinite(MX), MX, np.nan)

    timeline = (global_min + np.arange(n_points) * bw).round().astype(np.int64)

    metrics_list = []
    for j, path in enumerate(global_paths):
        col = mean[:, j]
        kind = _kind_of(col)
        finite = col[np.isfinite(col)]
        if finite.size:
            p50, p95, p99 = np.percentile(finite, [50, 95, 99])
            summary = {
                "min": _round_out(np.nanmin(MN[:, j]), kind),
                "p50": _round_out(p50, kind), "p95": _round_out(p95, kind),
                "p99": _round_out(p99, kind),
                "max": _round_out(np.nanmax(MX[:, j]), kind),
                "mean": _round_out(float(np.mean(finite)), kind),
            }
        else:
            summary = {k: None for k in ("min", "p50", "p95", "p99", "max", "mean")}
        v = [_round_out(x, kind) for x in col]
        metrics_list.append({
            "path": path, "category": category_for(path), "kind": kind,
            "summary": summary, "v": v,
        })

    return {
        "schema": "metrics_full/1",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "host": {"hostname": hostname, "version": version},
        "n_points": n_points,
        "timeline": {"t": [int(x) for x in timeline]},
        "metrics": metrics_list,
    }


def read_metadata_doc(dirpath):
    """Return the full type-0 metadata sub-document (first one in the directory)."""
    for doc in decoder.iter_directory_docs(dirpath):
        if doc.get("type") == 0:
            return doc.get("doc", {}) or {}
    return {}


def json_sanitize(obj):
    """Recursively convert a BSON-decoded object into a JSON-serializable form."""
    if isinstance(obj, dict):
        return {str(k): json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_sanitize(v) for v in obj]
    if isinstance(obj, bool) or obj is None:
        return obj
    if isinstance(obj, (int, float, str)):
        return obj
    if isinstance(obj, datetime.datetime):
        return obj.isoformat()
    if isinstance(obj, (bytes, bytearray)):
        return bytes(obj).hex()
    return str(obj)


if __name__ == "__main__":
    DATA_03 = ("/Users/manishsinha/Desktop/projects/ftdc-analyzer/files/upload/"
               "ludo-prod-mongo-03/diagnostic.data")

    ex = extract(DATA_03)
    sig, n = derive(ex)
    meta = ex["meta"]
    ts = ex["ts"]

    print("=" * 78)
    print("FTDC DERIVED SUMMARY")
    print("=" * 78)
    print(f"  host / version : {meta.get('hostname')}  /  MongoDB {meta.get('version')}")
    print(f"  cores / RAM    : {meta.get('numCores')} cores  /  {meta.get('memSizeMB')} MB "
          f"({(meta.get('memSizeMB') or 0)/1024:.1f} GB)")
    role = ex["role"]
    rc = ", ".join(f"{k}:{v}" for k, v in sorted(ex["role_counts"].items()))
    print(f"  role (myState) : {role}   (state counts -> {rc})")
    io = ex["io_totals"]
    io_str = "  ".join(f"{d}={io[d]:,.0f}ms" for d in DISKS)
    print(f"  data disk      : {ex['data_disk']}   (Δio_time totals: {io_str})")
    print(f"  samples        : {n}")
    if n:
        first, last = _to_dt(int(ts[0])), _to_dt(int(ts[-1]))
        print(f"  span           : {first.isoformat()}  ->  {last.isoformat()}")
        print(f"                   ({last - first})")
    if ex["missing"]:
        print(f"  MISSING paths  : {len(ex['missing'])}")
        for p in ex["missing"]:
            print(f"      - {p}")
    else:
        print("  MISSING paths  : none")

    print("\n" + "=" * 78)
    print(f"{'derived signal':<34}{'p50':>11}{'p95':>11}{'p99':>11}{'max':>11}")
    print("-" * 78)
    for label, arr in sig.items():
        s = _summ(arr)
        if s is None:
            print(f"{label:<34}{'(missing/nan)':>44}")
        else:
            p50, p95, p99, mx = s
            print(f"{label:<34}{p50:>11.3f}{p95:>11.3f}{p99:>11.3f}{mx:>11.3f}")
    print("=" * 78)
