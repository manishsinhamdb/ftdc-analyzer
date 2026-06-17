"""Deterministic signature engine — first-draft inference.

Fires named diagnoses from COMBINATIONS of the percentile summaries + insights
already computed by the engine, and synthesizes a top-level `assessment`.

Attribution: the diagnosis heuristics here are informed by the open-source
mongo-ftdc / Keyhole project's FTDC diagnosis approach (Apache-2.0):
https://github.com/simagix/mongo-ftdc — thresholds and signal combinations were
cross-referenced against its documented rules, then adapted to this engine's
percentile-summary model. No code was copied.
"""

SEV_RANK = {"OK": 0, "INFO": 1, "WARN": 2, "CRITICAL": 3}


def _g(sig_stats, label, q):
    s = sig_stats.get(label)
    return s[q] if s else None


def _ins(insights, iid):
    return next((i for i in insights if i["id"] == iid), None)


def _f(x, d=1):
    return "n/a" if x is None else f"{x:,.{d}f}"


def build_assessment(sig_stats, insights, cost_optimization):
    """Return the assessment dict (signatures that fired + synthesized headline)."""
    g = lambda lbl, q: _g(sig_stats, lbl, q)  # noqa: E731
    sigs = []

    def emit(sid, title, severity, purpose, symptoms, recommendation):
        sigs.append({
            "id": sid, "title": title, "severity": severity, "purpose": purpose,
            "symptoms": symptoms, "recommendation": recommendation,
        })

    # ---- CPU ----
    cpu_p99, cpu_max = g("cpu_util_pct", "p99"), g("cpu_util_pct", "max")
    if cpu_p99 is not None and cpu_max is not None and cpu_p99 < 40 and cpu_max < 90:
        emit("cost_downsize_cpu", "CPU over-provisioned", "INFO", "cost",
             [f"CPU util p99 {_f(cpu_p99)}% (<40%)", f"CPU util max {_f(cpu_max)}% (<90%)"],
             "Downsize vCPU — large headroom; see cost_optimization for the target count.")

    # ---- Disk ----
    du_p95 = g("disk_util_pct", "p95")
    aw_p95 = g("disk_avg_write_ms", "p95")
    ar_p95 = g("disk_avg_read_ms", "p95")
    if None not in (du_p95, aw_p95, ar_p95):
        if du_p95 >= 85 and aw_p95 < 10 and ar_p95 < 10:
            emit("storage_volume_rightsizing", "Storage volume right-sizing", "WARN", "cost",
                 [f"disk util p95 {_f(du_p95)}% (>=85%)",
                  f"avg write {_f(aw_p95)}ms (<10)", f"avg read {_f(ar_p95)}ms (<10)"],
                 "Right-size the STORAGE VOLUME, not the instance — utilization-bound but "
                 "service time is healthy; evaluate a better/cheaper IOPS tier "
                 "(e.g. gp3 w/ provisioned IOPS). Do NOT upsize the VM for this.")
        elif du_p95 >= 85 and (aw_p95 >= 10 or ar_p95 >= 10):
            emit("disk_io_saturation", "Disk I/O saturation", "CRITICAL", "health",
                 [f"disk util p95 {_f(du_p95)}% (>=85%)",
                  f"avg write {_f(aw_p95)}ms", f"avg read {_f(ar_p95)}ms"],
                 "Disk is service-time-bound; latency is elevated. Provision faster storage "
                 "and/or shed write/checkpoint load before it degrades further.")

    # ---- Cache / memory ----
    dirty_p95 = g("cache_dirty_pct", "p95")
    evict_max = g("wt_app_evict_ps", "max")
    pf_p95 = g("page_faults_ps", "p95")
    swap_max = g("swap_used_mb", "max")
    if dirty_p95 is not None and evict_max is not None and dirty_p95 > 15 and evict_max > 0:
        emit("cache_flush_bound", "Cache flush-bound", "WARN", "health",
             [f"dirty p95 {_f(dirty_p95)}% (>15%)", f"app-thread eviction max {_f(evict_max)}/s (>0)"],
             "WiredTiger is forcing application-thread eviction with high dirty load — add "
             "RAM/cache or reduce write pressure so dirty stays under the 5% target.")
    if (evict_max is not None and dirty_p95 is not None and pf_p95 is not None
            and evict_max == 0 and dirty_p95 < 10 and pf_p95 < 1):
        emit("cache_adequate", "Cache adequate", "OK", "health",
             [f"app-thread eviction {_f(evict_max)}/s", f"dirty p95 {_f(dirty_p95)}%",
              f"page faults p95 {_f(pf_p95)}/s"],
             "RAM/cache is appropriately sized — no eviction stress, dirty at target, no faults.")
    if (pf_p95 is not None and pf_p95 > 10) or (swap_max is not None and swap_max > 0):
        emit("memory_pressure", "Memory pressure", "WARN", "health",
             [f"page faults p95 {_f(pf_p95)}/s", f"swap used max {_f(swap_max)}MB"],
             "OS-level memory pressure (page faults / swap). Increase RAM or reduce "
             "working-set footprint.")

    # ---- Tickets ----
    rt_p95 = g("read_ticket_util_pct", "p95")
    wt_p95 = g("write_ticket_util_pct", "p95")
    if (rt_p95 is not None and rt_p95 > 90) or (wt_p95 is not None and wt_p95 > 90):
        emit("ticket_exhaustion", "WiredTiger ticket exhaustion", "WARN", "health",
             [f"read ticket util p95 {_f(rt_p95)}%", f"write ticket util p95 {_f(wt_p95)}%"],
             "Concurrency tickets are saturating — queries queue behind the 128-ticket pool. "
             "Reduce long-running ops / contention or scale the workload out.")

    # ---- Query ----
    qt_p95 = g("query_targeting_ratio", "p95")
    if qt_p95 is not None:
        if qt_p95 > 1000:
            emit("query_targeting_poor", "Poor query targeting", "CRITICAL", "query",
                 [f"scanned/returned p95 {_f(qt_p95)}× (>1000×)"],
                 "Queries scan far more than they return — almost certainly missing or "
                 "ineffective indexes. Audit slow queries and add covering indexes.")
        elif qt_p95 > 100:
            emit("query_targeting_poor", "Weak query targeting", "WARN", "query",
                 [f"scanned/returned p95 {_f(qt_p95)}× (>100×)"],
                 "Elevated scanned-to-returned ratio — review index coverage for hot queries.")
    wc_p95 = g("write_conflicts_ps", "p95")
    if wc_p95 is not None and wc_p95 > 5:
        emit("write_contention", "Write contention", "WARN", "query",
             [f"writeConflicts p95 {_f(wc_p95)}/s (>5)"],
             "WiredTiger is retrying writes due to document contention — review hot-document "
             "update patterns / transaction scope.")

    # ---- Replication ----
    lag_p95 = g("repl_lag_s", "p95")
    if lag_p95 is not None and lag_p95 > 10:
        emit("replication_lag", "Replication lag", "WARN", "health",
             [f"repl lag p95 {_f(lag_p95)}s (>10s)"],
             "Secondaries are falling behind — check apply throughput, network, and write load "
             "on the primary.")

    # ---- RCA / risk (insight-driven) ----
    lsc = _ins(insights, "latency_sharding_correlation")
    if lsc and lsc.get("status") == "WARN":
        emit("sharding_metadata_churn", "Sharding metadata churn", "WARN", "rca",
             [lsc.get("detail", "")],
             "Read-latency spikes track stale-config-error activity — this is sharding "
             "metadata refresh, NOT host resource pressure. Do NOT upsize the VM to fix it; "
             "investigate config-server / catalog-cache behavior.")
    veol = _ins(insights, "version_eol")
    if veol and veol.get("status") == "FAIL":
        emit("version_eol", "End-of-life MongoDB version", "WARN", "risk",
             [veol.get("headline", "")],
             "Plan a version upgrade — running an unsupported release misses years of "
             "sharding, performance, and security fixes.")

    # ---- synthesis ----
    max_sev = max((SEV_RANK[s["severity"]] for s in sigs), default=0)
    crit = [s for s in sigs if SEV_RANK[s["severity"]] == 3]
    warn = [s for s in sigs if SEV_RANK[s["severity"]] == 2]
    purposes = sorted({s["purpose"] for s in sigs})

    if max_sev == 3:
        posture = "At risk — critical issues"
        drivers = crit
    elif max_sev == 2:
        posture = "Stable — action recommended"
        drivers = warn
    elif max_sev == 1:
        posture = "Healthy — cost headroom"
        drivers = [s for s in sigs if s["severity"] == "INFO"]
    else:
        posture = "Healthy"
        drivers = [s for s in sigs if s["severity"] == "OK"]

    opp = (cost_optimization or {}).get("opportunity", "none")
    co_head = (cost_optimization or {}).get("headline", "")
    driver_titles = "; ".join(d["title"] for d in drivers[:3]) or "no notable pressure detected"
    headline = f"{posture}: {driver_titles}."
    if opp and opp != "none":
        headline += f" Cost optimization opportunity: {opp} — {co_head}"

    return {
        "headline": headline,
        "posture": posture,
        "purposes_covered": purposes,
        "signatures": sigs,
    }
