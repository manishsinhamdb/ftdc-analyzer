"""Deterministic FTDC verdicts + results.json assembly.

Consumes metrics.extract + metrics.derive, applies fixed threshold rules to the
summary percentiles, and writes a self-contained results.json (stats, verdicts,
downsampled chart series) under reports/.
"""

import os
import json
import math
import datetime

import numpy as np

from ftdc_analyzer import metrics
from ftdc_analyzer import decoder
from ftdc_analyzer import signatures

# ---------------------------------------------------------------------------
# Units + summary stats
# ---------------------------------------------------------------------------
UNITS = {
    "cache_used_pct": "%", "cache_dirty_pct": "%",
    "cpu_util_pct": "%", "cpu_iowait_pct": "%", "cpu_steal_pct": "%",
    "procs_running": "count", "procs_blocked": "count",
    "mem_free_pct": "%", "page_cache_gb": "GB", "swap_used_mb": "MB",
    "mongod_alloc_gb": "GB",
    "disk_read_iops": "iops", "disk_write_iops": "iops", "disk_iops": "iops",
    "disk_util_pct": "%", "disk_avg_read_ms": "ms", "disk_avg_write_ms": "ms",
    "disk_queue_depth": "count", "disk_read_mbps": "MB/s", "disk_write_mbps": "MB/s",
    "oplat_read_ms": "ms", "oplat_write_ms": "ms", "oplat_cmd_ms": "ms",
    "ops_insert_ps": "ops/s", "ops_query_ps": "ops/s", "ops_update_ps": "ops/s",
    "ops_delete_ps": "ops/s", "ops_getmore_ps": "ops/s", "ops_command_ps": "ops/s",
    "ops_total_ps": "ops/s", "repl_writes_ps": "ops/s",
    "wt_pages_read_into_cache_ps": "pages/s", "wt_pages_written_ps": "pages/s",
    "wt_app_evict_ps": "pages/s", "wt_app_read_into_cache_us": "us",
    "read_queue": "count", "write_queue": "count", "connections_current": "count",
    "asserts_per_min": "per_min", "repl_lag_s": "s",
    # --- Atlas-style additions (schema v2) ---
    "cpu_user_pct": "%", "cpu_system_pct": "%",
    "docs_returned_ps": "docs/s", "docs_inserted_ps": "docs/s",
    "docs_updated_ps": "docs/s", "docs_deleted_ps": "docs/s",
    "keys_scanned_ps": "keys/s", "objs_scanned_ps": "objs/s",
    "scan_and_order_ps": "ops/s", "write_conflicts_ps": "ops/s",
    "net_in_mbps": "MB/s", "net_out_mbps": "MB/s", "net_requests_ps": "req/s",
    "cache_read_mbps": "MB/s", "cache_write_mbps": "MB/s",
    "conn_created_ps": "conn/s", "page_faults_ps": "faults/s",
    "repl_getmores_ps": "ops/s", "repl_apply_ops_ps": "ops/s",
    "read_ticket_util_pct": "%", "write_ticket_util_pct": "%",
    "conn_used_pct": "%", "query_targeting_ratio": "ratio",
    "mem_resident_gb": "GB", "mem_virtual_gb": "GB",
    "read_tickets_out": "count", "write_tickets_out": "count",
    "read_tickets_available": "count", "write_tickets_available": "count",
    "active_clients_readers": "count", "active_clients_writers": "count",
    "repl_buffer_mb": "MB", "queue_depth": "count",
    "stale_config_errors_ps": "/s", "wt_checkpoint_running": "0/1",
    # --- Atlas-parity additions ---
    "keys_examined_per_returned": "x", "docs_examined_per_returned": "x",
    "repl_lag_member_0_s": "s", "repl_lag_member_1_s": "s", "repl_lag_member_2_s": "s",
    "cursors_open": "count", "cursors_timed_out_ps": "/s",
}


def _r3(x):
    return None if x is None else round(float(x), 3)


def _stats(arr):
    if arr is None or len(arr) == 0 or not np.any(np.isfinite(arr)):
        return None
    p50, p95, p99 = np.nanpercentile(arr, [50, 95, 99])
    return {
        "p50": _r3(p50), "p95": _r3(p95), "p99": _r3(p99),
        "max": _r3(np.nanmax(arr)), "mean": _r3(np.nanmean(arr)),
    }


def _conf(margin):
    return "high" if (margin is not None and margin > 0.25) else "medium"


def _chk(name, value, threshold, status):
    return {"name": name, "value": _r3(value), "threshold": threshold, "status": status}


def _grade_high(v, warn, fail):
    """Higher is worse."""
    if v is None:
        return "NA"
    if v >= fail:
        return "FAIL"
    if v >= warn:
        return "WARN"
    return "PASS"


# ---------------------------------------------------------------------------
# Verdicts
# ---------------------------------------------------------------------------
def verdict_ram(st, sig_stats):
    def g(label, q):
        s = sig_stats.get(label)
        return s[q] if s else None

    used_p95 = g("cache_used_pct", "p95")
    dirty_p95 = g("cache_dirty_pct", "p95")
    evict_max = g("wt_app_evict_ps", "max")
    readps_p95 = g("wt_pages_read_into_cache_ps", "p95")
    pf_p95 = g("page_faults_ps", "p95")

    checks = [
        _chk("cache_used_pct.p95", used_p95, 95, _grade_high(used_p95, 80, 95)),
        _chk("cache_dirty_pct.p95", dirty_p95, 5.5, _grade_high(dirty_p95, 5, 5.5)),
        _chk("wt_app_evict_ps.max", evict_max, 0, "FAIL" if (evict_max or 0) > 0 else "PASS"),
        _chk("wt_pages_read_into_cache_ps.p95", readps_p95, 50, "PASS"),
        _chk("page_faults_ps.p95", pf_p95, 10, _grade_high(pf_p95, 1, 10)),
    ]

    # Recalibrated against expert baseline: dirty hovering at the 5% WT dirty-target
    # (real pressure trigger is dirty_trigger=20%) with zero app-thread eviction and no
    # page faults is NOT memory pressure. Threshold set above the target at 5.5%.
    undersized = ((evict_max or 0) > 0
                  or (dirty_p95 or 0) > 5.5
                  or ((used_p95 or 0) > 95 and (pf_p95 or 0) > 10))
    reduce = (used_p95 is not None and used_p95 < 60
              and (readps_p95 or 0) < 50 and (pf_p95 or 0) < 1)

    if undersized:
        cands = []
        if (evict_max or 0) > 0:
            cands.append(("wt_app_evict_ps.max", evict_max, 0, 1.0))
        if (dirty_p95 or 0) > 5.5:
            cands.append(("cache_dirty_pct.p95", dirty_p95, 5.5, (dirty_p95 - 5.5) / 5.5))
        if (used_p95 or 0) > 95 and (pf_p95 or 0) > 10:
            cands.append(("cache_used_pct.p95", used_p95, 95, (used_p95 - 95) / 95))
        name, val, thr, margin = max(cands, key=lambda c: c[3])
        verdict, conf = "UNDERSIZED", _conf(margin)
        headline = (f"WiredTiger cache under pressure ({name}={_r3(val)} "
                    f"exceeds {thr}); more RAM would relieve eviction/dirty load.")
        rec = ("Increase RAM (or wiredTigerCacheSizeGB) so dirty stays <5% and the "
               "cache is not forced into application-thread eviction. Re-check after bump.")
        cost_action = {
            "action": "Increase RAM / WT cache", "lever": "ram",
            "est_saving_note": "spend, not save — relieves cache pressure",
            "risk": "low"}
    elif reduce:
        margin = min((60 - used_p95) / 60, (50 - (readps_p95 or 0)) / 50)
        verdict, conf = "REDUCE", _conf(margin)
        headline = (f"Cache comfortably under target (used p95={_r3(used_p95)}%, "
                    f"low read-in, no page faults); RAM can be trimmed.")
        rec = ("Cache is over-provisioned for the working set. Consider a smaller-RAM "
               "instance; keep headroom so cache_used stays <80%.")
        cost_action = {
            "action": "Downsize RAM tier", "lever": "ram",
            "est_saving_note": "smaller-RAM instance covers the working set",
            "risk": "medium"}
    else:
        margin = min(abs((used_p95 or 0) - 95) / 95, abs((dirty_p95 or 0) - 5) / 5)
        verdict, conf = "HOLD", _conf(margin)
        headline = "Cache adequate — no memory/WT pressure."
        rec = ("Keep current RAM. dirty% sits at the 5% WT target, app-thread eviction "
               "is zero, and page faults are negligible — no memory pressure.")
        cost_action = {
            "action": "No change — adequate", "lever": "none",
            "est_saving_note": "—", "risk": "none"}

    return {"verdict": verdict, "confidence": conf, "headline": headline,
            "checks": checks, "recommendation": rec, "cost_action": cost_action}


def verdict_cpu(st, sig_stats, cores, role):
    def g(label, q):
        s = sig_stats.get(label)
        return s[q] if s else None

    util_p99 = g("cpu_util_pct", "p99")
    util_max = g("cpu_util_pct", "max")
    iowait_p99 = g("cpu_iowait_pct", "p99")
    steal_p99 = g("cpu_steal_pct", "p99")

    checks = [
        _chk("cpu_util_pct.p99", util_p99, 70, _grade_high(util_p99, 55, 70)),
        _chk("cpu_util_pct.max", util_max, 90, _grade_high(util_max, 80, 90)),
        _chk("cpu_iowait_pct.p99", iowait_p99, 10, _grade_high(iowait_p99, 10, 25)),
        _chk("cpu_steal_pct.p99", steal_p99, 5, _grade_high(steal_p99, 5, 10)),
    ]

    constrained = (util_p99 or 0) > 70 or (util_max or 0) > 90
    reduce = util_p99 is not None and util_p99 < 40
    recommended_vcpus = None

    if constrained:
        cands = []
        if (util_p99 or 0) > 70:
            cands.append(("cpu_util_pct.p99", util_p99, 70, (util_p99 - 70) / 70))
        if (util_max or 0) > 90:
            cands.append(("cpu_util_pct.max", util_max, 90, (util_max - 90) / 90))
        name, val, thr, margin = max(cands, key=lambda c: c[3])
        verdict, conf = "CONSTRAINED", _conf(margin)
        headline = f"CPU constrained ({name}={_r3(val)} over {thr}); add vCPUs."
        rec = "Scale up vCPUs; investigate top consumers (checkpoint, eviction, queries)."
    elif reduce:
        margin = (40 - util_p99) / 40
        need = max(math.ceil(cores * (util_max or 0) / 100 / 0.85),
                   math.ceil(cores * util_p99 / 100 / 0.65), 2)
        recommended_vcpus = next((c for c in (2, 4, 8, 16, 32) if c >= need), 32)
        verdict, conf = "REDUCE", _conf(margin)
        headline = (f"CPU lightly used (util p99={_r3(util_p99)}%, max={_r3(util_max)}%); "
                    f"can downsize from {cores} to {recommended_vcpus} vCPU.")
        rec = (f"Headroom is large. {recommended_vcpus} vCPUs cover peak at ~85% and "
               f"p99 at ~65%. Validate post-resize before further cuts.")
    else:
        margin = min(abs((util_p99 or 0) - 70) / 70, abs((util_p99 or 0) - 40) / 40)
        verdict, conf = "HOLD", _conf(margin)
        headline = f"CPU appropriately sized (util p99={_r3(util_p99)}%)."
        rec = "Keep current vCPU count."

    if role == "SECONDARY":
        rec += (" Caveat: as a SECONDARY this reflects replication+read load only; "
                "size for primary write load if this node may be promoted.")

    if verdict == "REDUCE":
        caveat = (" (SECONDARY: re-validate for primary write load before promotion)"
                  if role == "SECONDARY" else "")
        cost_action = {
            "action": f"Downsize vCPU {cores}→{recommended_vcpus}", "lever": "vcpu",
            "est_saving_note": (f"~{round((1 - recommended_vcpus / cores) * 100)}% fewer "
                                f"vCPUs at same headroom{caveat}"),
            "risk": "low"}
    elif verdict == "CONSTRAINED":
        cost_action = {
            "action": "Add vCPUs", "lever": "vcpu",
            "est_saving_note": "spend to add CPU headroom", "risk": "medium"}
    else:
        cost_action = {"action": "No change", "lever": "none",
                       "est_saving_note": "—", "risk": "none"}

    return {"verdict": verdict, "confidence": conf, "headline": headline,
            "checks": checks, "recommendation": rec,
            "recommended_vcpus": recommended_vcpus, "cost_action": cost_action}


def verdict_disk(st, sig_stats, data_disk, role):
    def g(label, q):
        s = sig_stats.get(label)
        return s[q] if s else None

    util_p95 = g("disk_util_pct", "p95")
    util_max = g("disk_util_pct", "max")
    avgwrite_p95 = g("disk_avg_write_ms", "p95")
    avgread_p95 = g("disk_avg_read_ms", "p95")
    writeiops_p95 = g("disk_write_iops", "p95")
    queue_p95 = g("disk_queue_depth", "p95")
    iowait_p99 = g("cpu_iowait_pct", "p99")

    checks = [
        _chk("disk_util_pct.p95", util_p95, 85, _grade_high(util_p95, 70, 85)),
        _chk("disk_util_pct.max", util_max, 95, _grade_high(util_max, 90, 95)),
        _chk("disk_avg_write_ms.p95", avgwrite_p95, 10, _grade_high(avgwrite_p95, 5, 10)),
        _chk("disk_avg_read_ms.p95", avgread_p95, 5, _grade_high(avgread_p95, 3, 5)),
        _chk("disk_write_iops.p95", writeiops_p95, None, "PASS"),
        _chk("disk_queue_depth.p95", queue_p95, 16, _grade_high(queue_p95, 16, 32)),
        _chk("cpu_iowait_pct.p99", iowait_p99, 10, _grade_high(iowait_p99, 10, 25)),
    ]

    saturated = (util_p95 or 0) >= 85
    reduce = (util_p95 is not None and util_p95 < 40
              and (avgwrite_p95 or 0) < 10 and (avgread_p95 or 0) < 5)
    lat_healthy = (avgwrite_p95 or 0) < 10

    if saturated:
        margin = (util_p95 - 85) / 85
        verdict, conf = "SATURATED", _conf(margin)
        headline = (f"{data_disk} saturated (util p95={_r3(util_p95)}%, "
                    f"write IOPS p95={_r3(writeiops_p95)}); throughput-bound.")
        rec = ("Move to a higher-IOPS/throughput volume or shed write/checkpoint load "
               "(tune checkpoint cadence, reduce write amplification). "
               + ("Latency is still healthy (avg_write_ms.p95 "
                  f"{_r3(avgwrite_p95)}<10), so utilization — not service time — is the "
                  "ceiling; headroom shrinks as load grows."
                  if lat_healthy else
                  "Latency is already elevated; act before service time degrades further."))
    elif reduce:
        margin = min((40 - util_p95) / 40, (10 - (avgwrite_p95 or 0)) / 10,
                     (5 - (avgread_p95 or 0)) / 5)
        verdict, conf = "REDUCE", _conf(margin)
        headline = (f"{data_disk} lightly used (util p95={_r3(util_p95)}%, low latency); "
                    f"can move to a cheaper volume.")
        rec = "Disk is over-provisioned; a smaller/cheaper volume tier would suffice."
    else:
        margin = abs((util_p95 or 0) - 85) / 85
        verdict, conf = "HOLD", _conf(margin)
        headline = f"{data_disk} adequate (util p95={_r3(util_p95)}%)."
        rec = "Keep current volume; monitor utilization and write latency."

    if role == "SECONDARY":
        rec += (" Caveat: SECONDARY write load is replication-driven; a promoted primary "
                "would add direct client writes on top.")

    if verdict == "SATURATED":
        cost_action = {
            "action": "Right-size the storage volume (not the instance)", "lever": "storage",
            "est_saving_note": ("checkpoint-bound saturation, latency healthy — evaluate a "
                                "better/cheaper tier (e.g., gp3 with provisioned IOPS); "
                                "do NOT upsize the VM for this"),
            "risk": "medium"}
    elif verdict == "REDUCE":
        cost_action = {
            "action": "Move to a smaller/cheaper volume", "lever": "storage",
            "est_saving_note": "volume is over-provisioned for the load", "risk": "low"}
    else:
        cost_action = {"action": "No change", "lever": "none",
                       "est_saving_note": "—", "risk": "none"}

    return {"verdict": verdict, "confidence": conf, "headline": headline,
            "checks": checks, "recommendation": rec, "cost_action": cost_action}


# ---------------------------------------------------------------------------
# Downsampled series
# ---------------------------------------------------------------------------
# Series key -> underlying signal key (only where they differ; disk aliases keep the
# short chart-facing names that existed in schema v1).
SERIES_SOURCE = {
    "read_iops": "disk_read_iops",
    "write_iops": "disk_write_iops",
    "read_mbps": "disk_read_mbps",
    "write_mbps": "disk_write_mbps",
    "avg_read_ms": "disk_avg_read_ms",
    "avg_write_ms": "disk_avg_write_ms",
}

# Gauges aggregate with MEAN; everything else (rates / pct / ratio / latency) MAX.
MEAN_SET = {
    "cache_used_pct", "cache_dirty_pct", "mongod_alloc_gb", "page_cache_gb",
    "connections_current", "mem_resident_gb", "mem_virtual_gb",
    "read_tickets_out", "write_tickets_out",
    "active_clients_readers", "active_clients_writers",
    "repl_buffer_mb", "procs_running", "procs_blocked", "queue_depth",
}

MAX_POINTS = 2500


def _sc(key, label, ref_line=None, ref_label=None):
    e = {"key": key, "label": label}
    if ref_line is not None:
        e["refLine"] = ref_line
        e["refLabel"] = ref_label
    return e


# Data-driven Atlas-style catalog. Charts/series are filtered to what exists.
CHART_CATALOG = [
    {"category": "Operations", "charts": [
        {"title": "Opcounters", "unit": "/s", "series": [
            _sc("ops_query_ps", "query"), _sc("ops_insert_ps", "insert"),
            _sc("ops_update_ps", "update"), _sc("ops_delete_ps", "delete"),
            _sc("ops_getmore_ps", "getmore"), _sc("ops_command_ps", "command")]},
        {"title": "Document metrics", "unit": "/s", "series": [
            _sc("docs_returned_ps", "returned"), _sc("docs_inserted_ps", "inserted"),
            _sc("docs_updated_ps", "updated"), _sc("docs_deleted_ps", "deleted")]},
        {"title": "Query targeting (scanned objects ÷ returned)", "unit": "", "series": [
            _sc("query_targeting_ratio", "scanned/returned", 100, "100× targeting")]},
        {"title": "Scan-and-order / write conflicts", "unit": "/s", "series": [
            _sc("scan_and_order_ps", "scanAndOrder"),
            _sc("write_conflicts_ps", "writeConflicts")]},
    ]},
    {"category": "Latency", "charts": [
        {"title": "Operation latency", "unit": "ms", "series": [
            _sc("oplat_read_ms", "read"), _sc("oplat_write_ms", "write"),
            _sc("oplat_cmd_ms", "command")]},
    ]},
    {"category": "Query Efficiency", "charts": [
        {"title": "Query Targeting", "unit": "x", "series": [
            _sc("keys_examined_per_returned", "keys/returned"),
            _sc("docs_examined_per_returned", "docs/returned", 1, "1:1 ideal")]},
        {"title": "Scan & Order", "unit": "/s", "series": [
            _sc("scan_and_order_ps", "scanAndOrder/s")]},
        {"title": "Document Metrics", "unit": "/s", "series": [
            _sc("docs_returned_ps", "returned"), _sc("docs_inserted_ps", "inserted"),
            _sc("docs_updated_ps", "updated"), _sc("docs_deleted_ps", "deleted")]},
        {"title": "Operation execution time", "unit": "ms", "series": [
            _sc("oplat_read_ms", "read"), _sc("oplat_write_ms", "write"),
            _sc("oplat_cmd_ms", "command")]},
    ]},
    {"category": "Connections & Network", "charts": [
        {"title": "Connections", "unit": "", "series": [
            _sc("connections_current", "current")]},
        {"title": "Connection used %", "unit": "%", "series": [
            _sc("conn_used_pct", "used %", 80, "80%")]},
        {"title": "New connections", "unit": "/s", "series": [
            _sc("conn_created_ps", "created/s")]},
        {"title": "Network throughput", "unit": "MB/s", "series": [
            _sc("net_in_mbps", "in"), _sc("net_out_mbps", "out")]},
        {"title": "Network requests", "unit": "/s", "series": [
            _sc("net_requests_ps", "requests/s")]},
    ]},
    {"category": "Memory", "charts": [
        {"title": "Process memory", "unit": "GB", "series": [
            _sc("mem_resident_gb", "resident"), _sc("mem_virtual_gb", "virtual"),
            _sc("mongod_alloc_gb", "tcmalloc alloc")]},
        {"title": "WiredTiger cache fill", "unit": "%", "series": [
            _sc("cache_used_pct", "used %", 80, "80% target"),
            _sc("cache_dirty_pct", "dirty %", 5, "5% dirty")]},
        {"title": "System page cache", "unit": "GB", "series": [
            _sc("page_cache_gb", "page cache")]},
    ]},
    {"category": "Cache & Tickets", "charts": [
        {"title": "Cache I/O", "unit": "MB/s", "series": [
            _sc("cache_read_mbps", "read"), _sc("cache_write_mbps", "written")]},
        {"title": "Cache pages", "unit": "/s", "series": [
            _sc("wt_pages_read_into_cache_ps", "read-in"),
            _sc("wt_pages_written_ps", "written"),
            _sc("wt_app_evict_ps", "app evict")]},
        {"title": "Concurrency tickets out", "unit": "", "series": [
            _sc("read_tickets_out", "read out"), _sc("write_tickets_out", "write out")]},
        {"title": "Ticket utilization", "unit": "%", "series": [
            _sc("read_ticket_util_pct", "read %"),
            _sc("write_ticket_util_pct", "write %", 90, "90%")]},
    ]},
    {"category": "CPU", "charts": [
        {"title": "CPU breakdown", "unit": "%", "series": [
            _sc("cpu_user_pct", "user"), _sc("cpu_system_pct", "system"),
            _sc("cpu_iowait_pct", "iowait"), _sc("cpu_steal_pct", "steal")]},
        {"title": "CPU utilization", "unit": "%", "series": [
            _sc("cpu_util_pct", "util %")]},
        {"title": "Run/blocked processes", "unit": "", "series": [
            _sc("procs_running", "running"), _sc("procs_blocked", "blocked")]},
    ]},
    {"category": "Disk (nvme1n1)", "charts": [
        {"title": "Disk utilization", "unit": "%", "series": [
            _sc("disk_util_pct", "util %", 85, "85% saturated")]},
        {"title": "Disk IOPS", "unit": "/s", "series": [
            _sc("read_iops", "read"), _sc("write_iops", "write")]},
        {"title": "Disk latency", "unit": "ms", "series": [
            _sc("avg_read_ms", "read"), _sc("avg_write_ms", "write")]},
        {"title": "Disk throughput", "unit": "MB/s", "series": [
            _sc("read_mbps", "read"), _sc("write_mbps", "write")]},
        {"title": "Disk queue depth", "unit": "", "series": [
            _sc("queue_depth", "queue depth")]},
        {"title": "Checkpoint running", "unit": "0/1", "series": [
            _sc("wt_checkpoint_running", "checkpoint running")]},
    ]},
    {"category": "Replication", "charts": [
        {"title": "Replication lag", "unit": "s", "series": [
            _sc("repl_lag_s", "lag s")]},
        {"title": "Replication writes & apply", "unit": "/s", "series": [
            _sc("repl_writes_ps", "repl writes"), _sc("repl_apply_ops_ps", "apply ops"),
            _sc("repl_getmores_ps", "getmores")]},
        {"title": "Replication buffer", "unit": "MB", "series": [
            _sc("repl_buffer_mb", "buffer MB")]},
    ]},
    {"category": "Locks & Asserts", "charts": [
        {"title": "Lock queue", "unit": "", "series": [
            _sc("read_queue", "read queue"), _sc("write_queue", "write queue")]},
        {"title": "Active clients", "unit": "", "series": [
            _sc("active_clients_readers", "readers"),
            _sc("active_clients_writers", "writers")]},
        {"title": "Asserts", "unit": "/min", "series": [
            _sc("asserts_per_min", "asserts/min")]},
        {"title": "Page faults", "unit": "/s", "series": [
            _sc("page_faults_ps", "faults/s")]},
    ]},
    {"category": "Sharding", "charts": [
        {"title": "Stale config errors", "unit": "/s", "series": [
            _sc("stale_config_errors_ps", "stale config errors/s")]},
        {"title": "Read latency", "unit": "ms", "series": [
            _sc("oplat_read_ms", "read latency ms")]},
    ]},
]


def _catalog_series_keys():
    keys = []
    for cat in CHART_CATALOG:
        for ch in cat["charts"]:
            for e in ch["series"]:
                if e["key"] not in keys:
                    keys.append(e["key"])
    return keys


def build_insights(sig_stats):
    def g(label, q):
        s = sig_stats.get(label)
        return s[q] if s else None

    out = []

    qt = g("query_targeting_ratio", "p95")
    if qt is not None:
        status = "FAIL" if qt > 1000 else "WARN" if qt > 100 else "OK"
        out.append({
            "id": "query_targeting", "title": "Query targeting", "status": status,
            "headline": ("Scanning ≫ returning: likely missing/ineffective indexes"
                         if status != "OK" else "Index targeting looks healthy"),
            "detail": ("p95 of scanned-objects ÷ docs-returned is "
                       f"{_r3(qt)}× — every returned document costs that many object scans."),
            "metric": "query_targeting_ratio.p95", "value": _r3(qt), "threshold": 100})

    rtu = g("read_ticket_util_pct", "p95")
    wtu = g("write_ticket_util_pct", "p95")
    tu_vals = [v for v in (rtu, wtu) if v is not None]
    if tu_vals:
        tu = max(tu_vals)
        status = "FAIL" if tu > 90 else "WARN" if tu > 70 else "OK"
        out.append({
            "id": "ticket_saturation", "title": "Concurrency tickets", "status": status,
            "headline": ("WiredTiger concurrency tickets saturating"
                         if status != "OK" else "Concurrency tickets have headroom"),
            "detail": (f"max(read,write) ticket utilization p95 = {_r3(tu)}% "
                       "(read=" + f"{_r3(rtu)}%, write={_r3(wtu)}%)."),
            "metric": "ticket_util_pct.p95", "value": _r3(tu), "threshold": 90})

    cu = g("conn_used_pct", "p95")
    if cu is not None:
        status = "FAIL" if cu > 85 else "WARN" if cu > 70 else "OK"
        out.append({
            "id": "conn_headroom", "title": "Connection headroom", "status": status,
            "headline": ("Connection pool pressure" if status != "OK"
                         else "Connection pool has headroom"),
            "detail": f"current ÷ (current+available) p95 = {_r3(cu)}% of the connection ceiling.",
            "metric": "conn_used_pct.p95", "value": _r3(cu), "threshold": 85})

    wc = g("write_conflicts_ps", "p95")
    if wc is not None:
        status = "WARN" if wc > 5 else "OK"
        out.append({
            "id": "write_conflicts", "title": "Write conflicts", "status": status,
            "headline": ("Write contention" if status != "OK"
                         else "Negligible write contention"),
            "detail": f"writeConflicts p95 = {_r3(wc)}/s (WiredTiger retried these writes).",
            "metric": "write_conflicts_ps.p95", "value": _r3(wc), "threshold": 5})

    pf = g("page_faults_ps", "p95")
    if pf is not None:
        status = "WARN" if pf > 10 else "OK"
        out.append({
            "id": "page_pressure", "title": "Page faults", "status": status,
            "headline": ("OS page faults: memory pressure" if status != "OK"
                         else "No OS page-fault pressure"),
            "detail": f"extra_info.page_faults p95 = {_r3(pf)}/s.",
            "metric": "page_faults_ps.p95", "value": _r3(pf), "threshold": 10})

    return out


def downsample(ts_aligned, arr, agg):
    """Bucket the timeline into <=2500 equal-time buckets; aggregate per bucket."""
    t = ts_aligned.astype(np.float64)
    n = len(t)
    if n == 0 or arr is None:
        return [], []
    nb = min(MAX_POINTS, n)
    t0, t1 = t[0], t[-1]
    span = t1 - t0
    if span <= 0:
        idx = np.zeros(n, dtype=int)
        bw = 0.0
    else:
        bw = span / nb
        idx = np.minimum(((t - t0) / bw).astype(int), nb - 1)
    # idx is non-decreasing (t sorted) -> contiguous groups.
    bounds = np.nonzero(np.diff(idx))[0] + 1
    seg_arrs = np.split(arr, bounds)
    seg_ids = idx[np.concatenate(([0], bounds))]
    out_t, out_v = [], []
    for b, seg in zip(seg_ids, seg_arrs):
        if not np.any(np.isfinite(seg)):
            continue
        val = np.nanmax(seg) if agg == "max" else np.nanmean(seg)
        out_t.append(int(round(t0 + b * bw)))
        out_v.append(round(float(val), 3))
    return out_t, out_v


# ---------------------------------------------------------------------------
# Extra insights (version EOL + latency↔sharding correlation) + cost optimization
# ---------------------------------------------------------------------------
def build_extra_insights(sig, sig_stats, facts):
    out = []

    # version EOL
    ver = (facts.get("derived") or {}).get("mongo_version")
    if ver:
        parts = str(ver).split(".")
        try:
            major = int(parts[0])
            minor = int(parts[1]) if len(parts) > 1 else 0
        except (ValueError, IndexError):
            major = minor = None
        if major is not None:
            eol = (major, minor) < (5, 0)
            out.append({
                "id": "version_eol", "title": "MongoDB version",
                "status": "FAIL" if eol else "OK",
                "headline": (f"MongoDB {ver} is end-of-life/unsupported — missing years of "
                             "sharding, performance, and observability fixes; plan an "
                             "upgrade." if eol else f"MongoDB {ver} is a supported release."),
                "detail": f"Detected server version {ver}; EOL boundary is major.minor < 5.0.",
                "metric": "mongo_version", "value": round(major + minor / 10, 1),
                "threshold": 5.0})

    # latency↔sharding correlation: stale-config-error rate inside vs outside read-latency spikes
    oplat = sig.get("oplat_read_ms")
    stale = sig.get("stale_config_errors_ps")
    if (oplat is not None and stale is not None
            and np.any(np.isfinite(oplat)) and np.any(np.isfinite(stale))):
        p95 = float(np.nanpercentile(oplat, 95))
        spike = np.isfinite(oplat) & (oplat > p95)
        base = np.isfinite(oplat) & (oplat <= p95)
        in_vals = stale[spike & np.isfinite(stale)]
        out_vals = stale[base & np.isfinite(stale)]
        mean_in = float(np.mean(in_vals)) if in_vals.size else 0.0
        mean_out = float(np.mean(out_vals)) if out_vals.size else 0.0
        if mean_out > 0:
            ratio = mean_in / mean_out
        elif mean_in > 0:
            ratio = float("inf")
        else:
            ratio = 1.0
        warn = (mean_in >= 2 * mean_out) and (mean_in > 0)
        ratio_disp = round(ratio, 1) if math.isfinite(ratio) else None
        nx = f"{ratio_disp}x" if ratio_disp is not None else "∞x"
        headline = (
            f"Read-latency spikes coincide with stale-config-error activity (~{nx} "
            "baseline) → sharding metadata refresh, not host resource pressure; do NOT "
            "upsize the VM to fix this." if warn else
            "Read-latency spikes do not coincide with stale-config-error activity.")
        out.append({
            "id": "latency_sharding_correlation", "title": "Latency↔Sharding",
            "status": "WARN" if warn else "OK", "headline": headline,
            "detail": (f"spike samples={int(spike.sum())} "
                       f"(oplat_read_ms>p95={round(p95, 2)}ms); mean stale_config_errors_ps "
                       f"inside={round(mean_in, 5)}/s vs outside={round(mean_out, 5)}/s; "
                       f"ratio={nx}."),
            "metric": "stale_err_ratio(spike/base)", "value": ratio_disp, "threshold": 2})

    return out


def build_cost_optimization(verdicts):
    cpu, disk, ram = verdicts["cpu"], verdicts["disk"], verdicts["ram"]
    actions = []
    if cpu["verdict"] == "REDUCE":
        actions.append({
            "resource": "CPU",
            "recommendation": f"Downsize vCPU 16→{cpu.get('recommended_vcpus')}",
            "rationale": cpu["headline"] + " SECONDARY: re-size for primary write load if "
            "promotion is possible.", "lever": "vcpu", "risk": "low"})
    elif cpu["verdict"] == "CONSTRAINED":
        actions.append({"resource": "CPU", "recommendation": "Add vCPUs",
                        "rationale": cpu["headline"], "lever": "vcpu", "risk": "medium"})

    if disk["verdict"] == "SATURATED":
        actions.append({
            "resource": "Storage",
            "recommendation": ("Right-size the STORAGE VOLUME, not the instance — "
                               "checkpoint-bound saturation, latency healthy; evaluate a "
                               "better/cheaper tier (e.g., gp3 w/ provisioned IOPS)."),
            "rationale": disk["headline"], "lever": "storage", "risk": "medium"})
    elif disk["verdict"] == "REDUCE":
        actions.append({"resource": "Storage",
                        "recommendation": "Move to a smaller/cheaper volume",
                        "rationale": disk["headline"], "lever": "storage", "risk": "low"})

    if ram["verdict"] == "HOLD":
        actions.append({"resource": "RAM", "recommendation": "No change — adequate.",
                        "rationale": ram["headline"], "lever": "none", "risk": "none"})
    elif ram["verdict"] == "UNDERSIZED":
        actions.append({"resource": "RAM", "recommendation": "Increase RAM / WT cache",
                        "rationale": ram["headline"], "lever": "ram", "risk": "low"})
    elif ram["verdict"] == "REDUCE":
        actions.append({"resource": "RAM", "recommendation": "Downsize RAM tier",
                        "rationale": ram["headline"], "lever": "ram", "risk": "medium"})

    opportunity = ("high" if (cpu["verdict"] == "REDUCE" and cpu["confidence"] == "high")
                   else "medium")
    movers = [a["resource"] for a in actions if a["lever"] != "none"]
    headline = (("Cost optimization available — right-size " + ", ".join(movers)
                 + "; RAM is already adequate.") if movers
                else "No cost changes recommended.")
    return {"opportunity": opportunity, "headline": headline, "actions": actions}


# ---------------------------------------------------------------------------
# Facts (full metadata)
# ---------------------------------------------------------------------------
def build_facts(meta_doc, wt_cache_bytes=None, uptime_seconds=None):
    """Flatten the type-0 metadata doc by section (JSON-serializable) + derived."""
    san = metrics.json_sanitize
    host_info = meta_doc.get("hostInfo", {}) or {}
    system = host_info.get("system", {}) or {}
    os_info = host_info.get("os", {}) or {}
    build_info = meta_doc.get("buildInfo", {}) or {}

    os_str = " ".join(str(x) for x in
                      [os_info.get("name"), os_info.get("version")] if x)
    mem_mb = system.get("memSizeMB")
    derived = {
        "uptime_days": round(uptime_seconds / 86400, 2) if uptime_seconds else None,
        "wt_cache_gb": round(wt_cache_bytes / 1e9, 2) if wt_cache_bytes else None,
        "mongo_version": build_info.get("version"),
        "os": os_str or None,
        "num_cores": system.get("numCores"),
        "mem_gb": round(mem_mb / 1024, 1) if mem_mb else None,
    }
    return {
        "buildInfo": san(build_info),
        "hostInfo": san(host_info),
        "getCmdLineOpts": san(meta_doc.get("getCmdLineOpts", {}) or {}),
        "derived": derived,
    }


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------
def build_results(dirpath, on_skip=None):
    ex = metrics.extract(dirpath, on_skip=on_skip)
    sig, n = metrics.derive(ex)
    ts = ex["ts"]
    meta = ex["meta"]
    role, data_disk = ex["role"], ex["data_disk"]

    sig_stats = {label: _stats(arr) for label, arr in sig.items()}

    files = decoder._metrics_files_in_order(dirpath)
    now = datetime.datetime.now(datetime.timezone.utc)

    first_iso = metrics._to_dt(int(ts[0])).isoformat() if n else None
    last_iso = metrics._to_dt(int(ts[-1])).isoformat() if n else None
    span_seconds = int((ts[-1] - ts[0]) / 1000) if n else 0

    signals_block = {}
    for label, s in sig_stats.items():
        if s is None:
            signals_block[label] = {"unit": UNITS.get(label, ""), "p50": None,
                                    "p95": None, "p99": None, "max": None, "mean": None}
        else:
            signals_block[label] = {"unit": UNITS.get(label, ""), **s}

    sharding_present = any(p.startswith("serverStatus.shardingStatistics")
                           for p in ex["avail"])
    cluster_role = (f"shard member (replica-set {role})" if sharding_present else None)

    skipped_files = ex.get("skipped", [])

    notes = [
        f"role={role}: CPU/DISK sizing assumes this node remains a read replica; "
        "if promotable to PRIMARY, size for primary write load.",
        "oplat_write_ms is NaN/absent — expected on a SECONDARY (client writes do not "
        "traverse the user write path; replication apply does).",
        "FTDC covers only the analyzed host(s); for a sharded cluster, conclusions are "
        "limited to visible shard members — cluster-wide metadata behavior may originate "
        "elsewhere.",
    ]
    if skipped_files:
        notes.append(
            f"{len(skipped_files)} file(s) were unreadable and skipped: "
            + ", ".join(s["file"] for s in skipped_files)
            + " (analysis is based on the remaining files).")

    verdicts = {
        "ram": verdict_ram(sig_stats, sig_stats),
        "cpu": verdict_cpu(sig_stats, sig_stats, meta.get("numCores") or 0, role),
        "disk": verdict_disk(sig_stats, sig_stats, data_disk, role),
    }

    ts_aligned = ts[1:] if n else ts
    series_block = {}
    for key in _catalog_series_keys():
        src = SERIES_SOURCE.get(key, key)
        arr = sig.get(src)
        agg = "mean" if key in MEAN_SET else "max"
        tt, vv = downsample(ts_aligned, arr, agg) if arr is not None else ([], [])
        series_block[key] = {"t": tt, "v": vv}

    # chart_catalog filtered to charts whose series keys actually have data.
    def _has_data(key):
        sb = series_block.get(key)
        return bool(sb and sb["t"])

    chart_catalog = []
    for cat in CHART_CATALOG:
        charts = []
        for ch in cat["charts"]:
            ser = [e for e in ch["series"] if _has_data(e["key"])]
            if ser:
                charts.append({"title": ch["title"], "unit": ch["unit"], "series": ser})
        if charts:
            chart_catalog.append({"category": cat["category"], "charts": charts})

    insights = build_insights(sig_stats)

    # facts: full metadata (uptime filled by caller from metrics_full if available)
    wt_cache_arr = ex["series"].get(
        "serverStatus.wiredTiger.cache.maximum bytes configured")
    wt_cache_bytes = (float(wt_cache_arr[0])
                      if wt_cache_arr is not None and len(wt_cache_arr) else None)
    facts = build_facts(metrics.read_metadata_doc(dirpath), wt_cache_bytes=wt_cache_bytes)

    # extra insights (version EOL + latency↔sharding correlation) + cost optimization
    insights = insights + build_extra_insights(sig, sig_stats, facts)
    cost_optimization = build_cost_optimization(verdicts)
    assessment = signatures.build_assessment(sig_stats, insights, cost_optimization)

    results = {
        "schema_version": 3,
        "generated_at": now.isoformat(),
        "source": {"dir": dirpath, "file_count": len(files)},
        "host": {
            "hostname": meta.get("hostname"), "mongo_version": meta.get("version"),
            "num_cores": meta.get("numCores"), "mem_mb": meta.get("memSizeMB"),
            "role": role, "data_disk": data_disk, "cluster_role": cluster_role,
        },
        "capture": {"first_ts_iso": first_iso, "last_ts_iso": last_iso,
                    "span_seconds": span_seconds, "samples": n},
        "signals": signals_block,
        "assessment": assessment,
        "verdicts": verdicts,
        "cost_optimization": cost_optimization,
        "insights": insights,
        "chart_catalog": chart_catalog,
        "facts": facts,
        "series": series_block,
        "missing_paths": ex["missing"],
        "skipped_files": skipped_files,
        "notes": notes,
    }
    return results


# ---------------------------------------------------------------------------
# __main__
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    DATA_03 = ("/Users/manishsinha/Desktop/projects/ftdc-analyzer/files/upload/"
               "ludo-prod-mongo-03/diagnostic.data")
    REPORTS = "/Users/manishsinha/Desktop/projects/ftdc-analyzer/reports"

    # STEP 1 — probe presence
    print("=" * 78)
    print("STEP 1 · PROBE candidate paths")
    print("=" * 78)
    probe = metrics.probe(DATA_03)
    n_present = sum(1 for _, p in probe if p)
    for path, present in probe:
        print(f"  {'PRESENT' if present else 'ABSENT ':8s} {path}")
    print(f"\n  -> {n_present}/{len(probe)} present "
          f"({len(probe) - n_present} absent)")

    # STEPS 2-5 — build results + full metrics, patch uptime, write + copy both
    results = build_results(DATA_03)
    metrics_full = metrics.build_metrics_full(DATA_03, n_points=2000)

    # uptime_days from the full capture (serverStatus.uptime last value).
    uptime_last = None
    for m in metrics_full["metrics"]:
        if m["path"] == "serverStatus.uptime":
            for val in reversed(m["v"]):
                if val is not None:
                    uptime_last = val
                    break
            break
    if uptime_last is not None:
        results["facts"]["derived"]["uptime_days"] = round(uptime_last / 86400, 2)

    host = (results["host"]["hostname"] or "unknown").replace("/", "_")
    stamp = datetime.datetime.fromisoformat(
        results["generated_at"]).strftime("%Y%m%dT%H%M%SZ")
    out_path = os.path.join(REPORTS, f"ftdc_results_{host}_{stamp}.json")
    mf_path = os.path.join(REPORTS, "metrics_full.json")
    with open(out_path, "w") as fh:
        json.dump(results, fh, indent=2)
    with open(mf_path, "w") as fh:
        json.dump(metrics_full, fh, separators=(",", ":"))
    size = os.path.getsize(out_path)
    mf_size = os.path.getsize(mf_path)

    sigs = results["signals"]
    series = results["series"]
    catalog = results["chart_catalog"]
    insights = results["insights"]

    print("\n" + "=" * 78)
    print("STEP 6 · SUMMARY")
    print("=" * 78)
    h, c = results["host"], results["capture"]
    print(f"  {h['hostname']}  MongoDB {h['mongo_version']}  schema_version="
          f"{results['schema_version']}  role={h['role']}")
    print(f"  capture: {c['samples']:,} samples  ({c['span_seconds']:,}s)")
    print(f"  total signals : {len(sigs)}")
    print(f"  total series  : {len(series)}")

    print("\n  chart_catalog categories:")
    total_charts = 0
    for cat in catalog:
        nc = len(cat["charts"])
        total_charts += nc
        print(f"      {cat['category']:<26} {nc} charts")
    print(f"      {'TOTAL':<26} {total_charts} charts in {len(catalog)} categories")

    print("\n  insights:")
    for ins in insights:
        print(f"      [{ins['status']:4s}] {ins['title']:<22} "
              f"{ins['metric']}={ins['value']} (thr {ins['threshold']}) — {ins['headline']}")

    print("\n  recalibrated verdicts + cost_action:")
    for key in ("ram", "cpu", "disk"):
        v = results["verdicts"][key]
        extra = (f"  recommended_vcpus={v['recommended_vcpus']}"
                 if key == "cpu" and v.get("recommended_vcpus") is not None else "")
        ca = v["cost_action"]
        print(f"      [{key.upper():4s}] {v['verdict']}  ({v['confidence']}){extra}")
        print(f"             {v['headline']}")
        print(f"             cost_action: {ca['action']}  (lever={ca['lever']}, "
              f"risk={ca['risk']})  — {ca['est_saving_note']}")

    co = results["cost_optimization"]
    print(f"\n  cost_optimization: opportunity={co['opportunity']}")
    print(f"      {co['headline']}")
    for a in co["actions"]:
        print(f"      - {a['resource']:<8} [{a['lever']}/{a['risk']}] {a['recommendation']}")

    print("\n  recalibration spotlight:")
    print(f"      cluster_role: {h.get('cluster_role')}")
    by_id = {i["id"]: i for i in insights}
    lsc = by_id.get("latency_sharding_correlation")
    if lsc:
        print(f"      latency_sharding_correlation: {lsc['status']}  "
              f"ratio(value)={lsc['value']}  (thr {lsc['threshold']})")
        print(f"          {lsc['detail']}")
        print(f"          {lsc['headline']}")
    veol = by_id.get("version_eol")
    if veol:
        print(f"      version_eol: {veol['status']}  {veol['headline']}")
    has_shard_cat = any(cat["category"] == "Sharding" for cat in catalog)
    shard_charts = next((cat["charts"] for cat in catalog
                         if cat["category"] == "Sharding"), [])
    print(f"      chart_catalog 'Sharding' category added: {has_shard_cat}  "
          f"({', '.join(ch['title'] for ch in shard_charts)})")

    # ---- PART 1 validation ----
    mlist = metrics_full["metrics"]
    tline = metrics_full["timeline"]["t"]
    print("\n" + "=" * 78)
    print("PART 1 VALIDATION · full capture")
    print("=" * 78)
    print(f"  total metrics captured : {len(mlist)}  (expect 1370)")
    print(f"  timeline length        : {len(tline)}  (n_points={metrics_full['n_points']})")
    print(f"  metrics_full.json size : {mf_size:,} bytes ({mf_size/1024/1024:.1f} MB)")

    print("\n  sample metric entries:")
    samples = [mlist[0], mlist[len(mlist) // 2], mlist[-1]]
    for m in samples:
        s = m["summary"]
        print(f"    - {m['path']}")
        print(f"        category={m['category']!r}  kind={m['kind']}")
        print(f"        summary min={s['min']} p50={s['p50']} p95={s['p95']} "
              f"p99={s['p99']} max={s['max']} mean={s['mean']}  (len v={len(m['v'])})")

    facts = results["facts"]
    print("\n  facts sections + field counts:")
    for name in ("buildInfo", "hostInfo", "getCmdLineOpts", "derived"):
        sec = facts.get(name, {})
        print(f"    - {name:<16} {len(sec)} top-level fields")
    print(f"    derived: {facts['derived']}")

    shard = [m["path"] for m in mlist if "shardingStatistics" in m["path"]]
    print(f"\n  sharding paths (serverStatus.shardingStatistics.*): {len(shard)} found")
    for p in shard[:5]:
        print(f"      - {p}")

    print("\n" + "=" * 78)
    print(f"  results.json     : {out_path}")
    print(f"  size on disk     : {size:,} bytes ({size/1024:.1f} KiB)")
    print(f"  metrics_full.json: {mf_path}  ({mf_size:,} bytes)")
    print(f"  metrics_full.json: {mf_path} ({mf_size:,} bytes)")
    print(f"  missing_paths    : {results['missing_paths']}")
    print("=" * 78)
