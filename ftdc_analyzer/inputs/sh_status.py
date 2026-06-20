"""sh.status() parser — sharded-cluster topology + state.

Parses the JSON-serialized config metadata that `sh.status()` (run on a mongos) exposes:
shards, databases & their primary shards, sharded collections, per-shard chunk counts,
balancer state, and jumbo-chunk presence. Injects `sh_*` signals so the ruleset's
`sharding_topology` category SCORES (real verdict) when this input is present — replacing the
Phase-8 "run sh.status()" context caveat. Defensive + Extended-JSON aware. Honest caveats where
sh.status() alone is insufficient (chunk COUNTS ≠ data size; shard-key effectiveness needs
query patterns). Returns the uniform parsed shape consumed by inputs.dispatch().
"""

from __future__ import annotations

import json
import os

from ..healthcheck import _num, _x  # reuse Extended-JSON helpers


def _stat(v):
    return {"p50": v, "p95": v, "p99": v, "max": v, "mean": v, "min": v}


def parse(path: str) -> dict:
    with open(os.path.abspath(os.path.expanduser(path))) as fh:
        raw = json.load(fh)
    if not isinstance(raw, dict):
        raise ValueError("sh.status() file is not a JSON object")
    return _build(raw)


def _build(raw: dict) -> dict:
    notes = []

    shards = [s for s in (raw.get("shards") or []) if isinstance(s, dict)]
    shard_ids = [s.get("_id") for s in shards]
    shard_count = len(shards)

    balancer = raw.get("balancer") or {}
    bal_enabled = str(balancer.get("currently_enabled")).lower() == "yes"
    bal_running = str(balancer.get("currently_running")).lower() == "yes"
    failed_rounds = int(_num(balancer.get("failed_balancer_rounds_in_last_5_attempts")) or 0)
    bal_inactive = 1.0 if (bal_enabled and not bal_running) or failed_rounds > 0 else 0.0

    sharded_colls = []
    partitioned_dbs = 0
    for db in (raw.get("databases") or []):
        if not isinstance(db, dict):
            continue
        if db.get("partitioned") and db.get("_id") not in ("config", "admin"):
            partitioned_dbs += 1
        for cname, c in (db.get("collections") or {}).items():
            if not isinstance(c, dict):
                continue
            chunks = {k: int(_num(v) or 0) for k, v in (c.get("chunks") or {}).items()}
            total = sum(chunks.values())
            jumbo = int(_num(c.get("jumbo_chunks")) or 0)
            max_share = (max(chunks.values()) / total * 100) if total else 0.0
            even = (100.0 / len(chunks)) if chunks else 0.0
            imbalance = max(0.0, max_share - even)
            hottest = max(chunks, key=chunks.get) if chunks else None
            sharded_colls.append({
                "ns": cname, "db": db.get("_id"), "shard_key": c.get("shardKey"),
                "unique": bool(c.get("unique")), "chunks": chunks, "total_chunks": total,
                "jumbo_chunks": jumbo, "max_shard_share_pct": round(max_share, 1),
                "imbalance_pct": round(imbalance, 1), "hottest_shard": hottest,
            })

    total_jumbo = sum(c["jumbo_chunks"] for c in sharded_colls)
    worst = max(sharded_colls, key=lambda c: c["imbalance_pct"], default=None)
    worst_imbalance = worst["imbalance_pct"] if worst else 0.0

    # ---- scoring signals (sh_*) read by ruleset sharding_topology ----
    scoring_stats = {
        "sh_chunk_imbalance_pct": _stat(round(worst_imbalance, 1)),
        "sh_balancer_inactive": _stat(bal_inactive),
        "sh_jumbo_chunks": _stat(float(total_jumbo)),
        "sh_shard_count": _stat(float(shard_count)),
        "sh_sharded_collections": _stat(float(len(sharded_colls))),
    }

    # ---- dynamic recommendation + evidence (merged into the scored category) ----
    findings = []
    if worst and worst_imbalance > 30:
        findings.append(
            f"chunk distribution is imbalanced (worst: {worst['ns']} "
            f"{worst['max_shard_share_pct']}% on {worst['hottest_shard']})")
    if total_jumbo > 0:
        findings.append(f"{total_jumbo} jumbo chunk(s) present (cannot be auto-split/migrated)")
    if bal_inactive:
        state = ("enabled but not running" if bal_enabled and not bal_running
                 else f"{failed_rounds} failed balancer round(s)")
        findings.append(f"balancer {state}")
    head = (f"Sharded cluster: {shard_count} shards, {len(sharded_colls)} sharded collection(s) "
            f"across {partitioned_dbs} partitioned database(s).")
    reco = (head + " " + ("; ".join(findings).capitalize() + ". " if findings else "")
            + "Investigate balancer health and jumbo chunks; review shard-key cardinality "
              "(hotspotting) for the imbalanced collections.")

    caveats = [
        "sh.status() shows chunk COUNTS, not per-chunk data size — a balanced chunk count can "
        "still hide data/throughput skew.",
        "Shard-key effectiveness (cardinality, hotspotting, monotonic keys) needs the query "
        "profiler + access patterns, which sh.status() alone does not expose.",
        "Point-in-time mongos view — balancer state and chunk counts fluctuate over time.",
    ]

    report = {
        "shards": [{"id": s.get("_id"), "host": s.get("host"), "state": _x(s.get("state"))}
                   for s in shards],
        "shard_count": shard_count,
        "partitioned_databases": partitioned_dbs,
        "databases": [{"db": d.get("_id"), "primary": d.get("primary"),
                       "partitioned": bool(d.get("partitioned"))}
                      for d in (raw.get("databases") or []) if isinstance(d, dict)],
        "sharded_collections": sharded_colls,
        "balancer": {
            "enabled": bal_enabled, "running": bal_running,
            "failed_rounds_last_5": failed_rounds,
            "last_error": balancer.get("last_reported_error"),
        },
        "totals": {"jumbo_chunks": total_jumbo, "worst_imbalance_pct": round(worst_imbalance, 1),
                   "sharded_collections": len(sharded_colls)},
        "active_mongoses": [m.get("_id") for m in (raw.get("active_mongoses") or [])
                            if isinstance(m, dict)],
        "shard_ids": shard_ids,
    }

    enrichers = {
        "sharding_topology": {
            "recommendation": reco,
            "evidence": report["totals"] | {"shards": report["shards"],
                                            "sharded_collections": sharded_colls,
                                            "balancer": report["balancer"]},
            "evidence_key": "sharding_evidence",
            "caveats": caveats,
            "when_scored_only": False,
        }
    }

    return {
        "scoring_stats": scoring_stats,
        "report": report,
        "report_key": "sharding",
        "enrichers": enrichers,
        "available": True,
        "notes": notes,
    }
