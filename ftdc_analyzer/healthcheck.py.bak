"""getMongoData (healthcheck snapshot) parser — a CO-PRIMARY input alongside FTDC.

Parses the JSON emitted by `collectors/getMongoData.js` into a typed structure, derives
the structural findings (index health/bloat, schema/data-model anti-patterns, storage
capacity & cache-fit), and exposes:

  * ``report``        — rich, descriptive facts for the Healthcheck Report UI (parity with
                        the getMongoData report the team already reads);
  * ``scoring_stats`` — derived scalar signals injected into the scorer's ``sig_stats`` so
                        the three Structural-Design categories produce REAL verdicts +
                        ledgers (see ruleset/defaults.py — they require ``healthcheck``);
  * ``structural``    — per-category dynamic recommendation + concrete evidence (drop list,
                        reclaimable bytes, redundant pairs, anti-pattern flags) merged into
                        the scored categories after scoring;
  * ``host``/``sizing`` — host facts + storage/cache numbers for the sizing engine.

ADDITIVE and defensive: every field is read through guarded helpers — a missing/oddly
shaped field becomes ``None`` (recorded in ``notes``), never an exception. The FTDC decoder
is untouched; this module never imports it.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

GIB = 1024 ** 3
MIB = 1024 ** 2
# On-disk storage / index sizes are reported in DECIMAL GB/MB/TB (disk-vendor convention,
# matching the getMongoData team tool — e.g. 2.51 GB reclaimable). RAM / WiredTiger cache
# stay in GiB (how mongod reports the configured cache), so the two are not conflated.
GB = 1000 ** 3
MB = 1000 ** 2
TB = 1000 ** 4

# Collections smaller than this are excluded from index:data-ratio anti-pattern checks —
# on a tiny collection the _id index legitimately dwarfs the data and is not a finding.
_MIN_DATA_FOR_RATIO = 100 * MIB


# ---------------------------------------------------------------------------
# Extended-JSON + safe accessors
# ---------------------------------------------------------------------------
def _x(v: Any) -> Any:
    """Resolve MongoDB Extended JSON scalars ($numberLong / $numberInt / $date / etc.)
    into plain Python numbers; pass other values through."""
    if isinstance(v, dict):
        if "$numberLong" in v:
            try:
                return int(v["$numberLong"])
            except (TypeError, ValueError):
                return None
        if "$numberInt" in v:
            try:
                return int(v["$numberInt"])
            except (TypeError, ValueError):
                return None
        if "$numberDouble" in v:
            try:
                return float(v["$numberDouble"])
            except (TypeError, ValueError):
                return None
        if "$numberDecimal" in v:
            try:
                return float(v["$numberDecimal"])
            except (TypeError, ValueError):
                return None
        if "$date" in v:
            d = v["$date"]
            if isinstance(d, dict):  # {$date:{$numberLong:"…"}}
                return _x(d)
            if isinstance(d, str):
                return d
            return d
    return v


def _num(v: Any) -> Optional[float]:
    v = _x(v)
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def _get(d: Any, *path, default=None):
    """Nested dict get with Extended-JSON resolution on the leaf."""
    cur = d
    for k in path:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    r = _x(cur)
    return r if r is not None else (cur if not isinstance(cur, dict) else default)


def _ratio(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None or b is None or not b:
        return None
    return a / b


def _stat(value: Optional[float]) -> Dict[str, Optional[float]]:
    """A scalar dressed as a summary-stat block so the scorer reads it via any stat key."""
    return {"p50": value, "p95": value, "p99": value, "max": value, "mean": value,
            "min": value}


# ---------------------------------------------------------------------------
# block_compressor extraction (creationString / parsedCreationString)
# ---------------------------------------------------------------------------
def _block_compressor(coll: dict) -> Optional[str]:
    pcs = coll.get("parsedCreationString")
    if isinstance(pcs, list):
        for item in pcs:
            if isinstance(item, dict) and item.get("block_compressor"):
                return str(item["block_compressor"])
    cs = coll.get("creationString")
    if isinstance(cs, str):
        for part in cs.split(","):
            if part.startswith("block_compressor="):
                return part.split("=", 1)[1] or None
    return None


# ---------------------------------------------------------------------------
# Index analysis (unused / prefix-redundant / unique)
# ---------------------------------------------------------------------------
def _index_rows(db_name: str, coll: dict) -> List[dict]:
    """One row per index with name/key/ops/since/size/unique + derived flags filled later."""
    rows: List[dict] = []
    idx = coll.get("indexes") or {}
    sizes = idx.get("indexSizes") or {}
    stats = idx.get("stats") or []
    by_name = {}
    for s in stats:
        if not isinstance(s, dict):
            continue
        name = s.get("name")
        if not name:
            continue
        key = s.get("key") if isinstance(s.get("key"), dict) else {}
        ops = _num(_get(s, "accesses", "ops")) or 0.0
        since = _x(_get(s, "accesses", "since"))
        by_name[name] = {
            "db": db_name,
            "collection": coll.get("name"),
            "name": name,
            "key": key,
            "key_fields": list(key.keys()),
            "ops": int(ops),
            "since": since,
            "size_bytes": int(_num(sizes.get(name)) or 0),
            "unique": bool(s.get("unique") or (isinstance(key, dict) and key.get("_id") and name == "_id_") is False and s.get("unique")),
        }
    # Some snapshots list sizes for indexes without a matching stats row — include them.
    for name, sz in sizes.items():
        if name not in by_name:
            by_name[name] = {
                "db": db_name, "collection": coll.get("name"), "name": name,
                "key": {}, "key_fields": [], "ops": None, "since": None,
                "size_bytes": int(_num(sz) or 0), "unique": False,
            }
    rows = list(by_name.values())
    _flag_redundant(rows)
    return rows


def _is_prefix(short: List[str], long: List[str]) -> bool:
    """True when `short`'s key fields are a strict leading prefix of `long`'s."""
    return 0 < len(short) < len(long) and long[: len(short)] == short


def _flag_redundant(rows: List[dict]) -> None:
    """Mark prefix-redundant indexes within one collection.

    Two complementary heuristics (a redundant index is one COVERED by another):
      * key-prefix : index A's key fields are a strict leading prefix of index B's
        (single-field {a} covered by compound {a,b}) — A is redundant.
      * name-shadow: B's name == A's name + "_<suffix>" (the accidental duplicate-index
        pattern, e.g. `id_1` shadowed by `id_1_1`) — B is redundant. This is what the
        team tool flags on parchisi.users.
    """
    for r in rows:
        r["redundant_of"] = None
        r["redundant_kind"] = None
    for a in rows:
        if a["name"] == "_id_":
            continue
        for b in rows:
            if b is a or b["name"] == "_id_":
                continue
            # key-prefix: a covered by b → a redundant
            if a["key_fields"] and b["key_fields"] and _is_prefix(a["key_fields"], b["key_fields"]):
                if not a["redundant_of"]:
                    a["redundant_of"] = b["name"]
                    a["redundant_kind"] = "key_prefix"
            # name-shadow: b is a "<a>_<n>" duplicate → b redundant
            if b["name"].startswith(a["name"] + "_") and b["name"] != a["name"]:
                if not b["redundant_of"]:
                    b["redundant_of"] = a["name"]
                    b["redundant_kind"] = "name_shadow"


def _is_unused(r: dict) -> bool:
    return (r.get("ops") == 0) and r["name"] != "_id_"


def _droppable(r: dict) -> bool:
    """Unused, not the _id index, and not a unique constraint (those are retained)."""
    return _is_unused(r) and not r.get("unique")


# ---------------------------------------------------------------------------
# Main parse
# ---------------------------------------------------------------------------
def parse_healthcheck(path: str) -> dict:
    """Parse a getMongoData snapshot file into the healthcheck structure (see module docstring).

    Raises only on an unreadable/!JSON file (the caller treats that as a hard input error);
    every internal field is read defensively and missing data is recorded in ``notes``."""
    with open(os.path.abspath(os.path.expanduser(path))) as fh:
        raw = json.load(fh)
    if not isinstance(raw, dict):
        raise ValueError("healthcheck file is not a JSON object")
    return _build(raw, source_path=path)


def _build(raw: dict, source_path: str) -> dict:
    notes: List[str] = []

    def note_missing(label: str):
        notes.append(f"{label} missing from healthcheck snapshot")

    si = raw.get("serverInfo") or {}
    if not si:
        note_missing("serverInfo")

    # ---- Server / host -----------------------------------------------------
    version = _get(si, "version")
    edition = _get(si, "binary")  # "community" | "enterprise"
    num_cores = _num(_get(si, "numCores"))
    mem_mb = _num(_get(si, "memSizeMB"))
    uptime_sec = _num(_get(si, "uptimeSec"))
    page_faults = _num(_get(si, "pageFaults"))
    wt_cache_bytes = _num(_get(si, "wiredtigerCacheSize"))
    bytes_in_cache = _num(_get(si, "bytesCurrentlyInCache"))
    conn = si.get("connections") or {}
    connections = {
        "current": _num(conn.get("current")),
        "available": _num(conn.get("available")),
        "total_created": _num(conn.get("totalCreated")),
    }
    server = {
        "version": version,
        "edition": edition,
        "storage_engine": _get(si, "storageEngine"),
        "num_cores": int(num_cores) if num_cores else None,
        "mem_mb": mem_mb,
        "mem_gb": round(mem_mb / 1024, 1) if mem_mb else None,
        "uptime_sec": uptime_sec,
        "uptime_days": round(uptime_sec / 86400, 2) if uptime_sec else None,
        "page_faults": page_faults,
        "connections": connections,
        "wt_cache_bytes": wt_cache_bytes,
        "wt_cache_gb": round(wt_cache_bytes / GIB, 2) if wt_cache_bytes else None,
        "bytes_in_cache": bytes_in_cache,
        "bytes_in_cache_gb": round(bytes_in_cache / GIB, 2) if bytes_in_cache else None,
        "cache_fill_pct": round(100 * bytes_in_cache / wt_cache_bytes, 1)
        if bytes_in_cache and wt_cache_bytes else None,
        "shell_version": _get(raw, "shellVersion"),
        "script_version": _get(raw, "scriptInfo", "v"),
    }

    # ---- Topology (replica set) -------------------------------------------
    rs_cfg = raw.get("replicaSetConfig")
    members: List[dict] = []
    arbiters = electable = data_bearing = priority_zero = hidden = 0
    if isinstance(rs_cfg, list):
        for m in rs_cfg:
            if not isinstance(m, dict):
                continue
            arb = bool(m.get("arbiterOnly"))
            pri = _num(m.get("priority"))
            hid = bool(m.get("hidden"))
            row = {
                "id": _x(m.get("_id")),
                "host": m.get("host"),
                "arbiter": arb,
                "priority": pri,
                "votes": _num(m.get("votes")),
                "hidden": hid,
                "build_indexes": bool(m.get("buildIndexes", True)),
                "secondary_delay_secs": _num(m.get("secondaryDelaySecs")),
                "electable": (not arb) and (pri or 0) > 0,
            }
            members.append(row)
            if arb:
                arbiters += 1
            else:
                data_bearing += 1
                if (pri or 0) > 0:
                    electable += 1
                else:
                    priority_zero += 1
            if hid:
                hidden += 1
    elif rs_cfg is not None:
        note_missing("replicaSetConfig (unexpected shape)")

    parsed_opts = raw.get("serverCmdLineOpts", {}).get("parsed", {}) if isinstance(
        raw.get("serverCmdLineOpts"), dict) else {}
    repl_set_name = _get(parsed_opts, "replication", "replSetName")
    cluster_role = _get(parsed_opts, "sharding", "clusterRole")
    topology = {
        "configuration": _get(raw, "configuration"),
        "members_total": _num(raw.get("members")) or len(members),
        "members": members,
        "arbiters": arbiters,
        "data_bearing": data_bearing,
        "electable": electable,
        "priority_zero": priority_zero,
        "hidden": hidden,
        "repl_set_name": repl_set_name,
        "cluster_role": cluster_role,
        "is_sharded": bool(cluster_role),
    }

    # ---- Replication / oplog window ---------------------------------------
    ri = raw.get("replicationInfo") or {}
    replication = {
        "log_size_mb": _num(ri.get("logSizeMB")),
        "used_mb": _num(ri.get("usedMB")),
        "time_diff_hours": _num(ri.get("timeDiffHours")),
        "used_pct": (round(100 * _num(ri.get("usedMB")) / _num(ri.get("logSizeMB")), 1)
                     if _num(ri.get("usedMB")) and _num(ri.get("logSizeMB")) else None),
    }
    if not ri:
        note_missing("replicationInfo")

    # ---- Storage / databases / collections --------------------------------
    total_data = _num(raw.get("totalDataSize"))
    total_storage = _num(raw.get("totalStorageSize"))
    total_index = _num(raw.get("totalIndexSize"))
    compression_ratio = _ratio(total_data, total_storage)

    databases: List[dict] = []
    collections: List[dict] = []  # flattened, enriched
    all_indexes: List[dict] = []
    compressors: Dict[str, int] = {}

    for db in raw.get("databaseStats") or []:
        if not isinstance(db, dict):
            continue
        db_name = db.get("db")
        db_colls = []
        for coll in db.get("collectionstats") or []:
            if not isinstance(coll, dict):
                continue
            data_size = _num(coll.get("dataSize")) or 0.0
            storage_size = _num(coll.get("storageSize")) or 0.0
            total_idx_size = _num(coll.get("totalIndexSize")) or 0.0
            count = _num(coll.get("count")) or 0.0
            avg_obj = _num(coll.get("avgObjSize"))
            comp = _block_compressor(coll)
            if comp:
                compressors[comp] = compressors.get(comp, 0) + 1
            rows = _index_rows(db_name, coll)
            all_indexes.extend(rows)
            idx_to_data = _ratio(total_idx_size, data_size)
            crow = {
                "db": db_name,
                "name": coll.get("name"),
                "type": coll.get("type"),
                "capped": bool(coll.get("capped")),
                "count": count,
                "avg_obj_size": avg_obj,
                "data_size": data_size,
                "storage_size": storage_size,
                "total_index_size": total_idx_size,
                "nindexes": int(_num(coll.get("nindexes")) or len(rows)),
                "block_compressor": comp,
                "compression_ratio": _ratio(data_size, storage_size),
                "index_to_data_pct": round(idx_to_data * 100, 1) if idx_to_data is not None else None,
                "indexes": rows,
            }
            db_colls.append(crow)
            collections.append(crow)
        databases.append({
            "db": db_name,
            "collections": int(_num(db.get("collections")) or len(db_colls)),
            "views": int(_num(db.get("views")) or 0),
            "data_size": _num(db.get("dataSize")),
            "storage_size": _num(db.get("storageSize")),
            "index_size": _num(db.get("indexSize")),
            "avg_obj_size": _num(db.get("avgObjSize")),
            "indexes": int(_num(db.get("indexes")) or 0),
            "collection_names": [c["name"] for c in db_colls],
        })

    storage = {
        "total_data_size": total_data,
        "total_storage_size": total_storage,
        "total_index_size": total_index,
        "total_data_tb": round(total_data / (1000 ** 4), 2) if total_data else None,
        "total_storage_tb": round(total_storage / (1000 ** 4), 2) if total_storage else None,
        "total_data_gib": round(total_data / GIB, 1) if total_data else None,
        "total_storage_gib": round(total_storage / GIB, 1) if total_storage else None,
        "total_index_gib": round(total_index / GIB, 2) if total_index else None,
        "compression_ratio": round(compression_ratio, 3) if compression_ratio else None,
        "n_databases": int(_num(raw.get("nDatabases")) or len(databases)),
        "n_collections": int(_num(raw.get("nCollections")) or len(collections)),
        "n_indexes": int(_num(raw.get("nIndexes")) or len(all_indexes)),
        "block_compressors": compressors,
    }

    # ---- Ops / throughput (metrics live UNDER serverInfo in getMongoData) --
    m = si.get("metrics") or {}
    opc = {k: _num(v) for k, v in (m.get("opcounters") or {}).items()}
    doc = {k: _num(v) for k, v in (m.get("document") or {}).items()}
    ttl = {k: _num(v) for k, v in (m.get("ttl") or {}).items()}
    up = uptime_sec or 0

    def _per_sec(v):
        return round(v / up, 1) if (v is not None and up) else None

    operations = {
        "opcounters": opc,
        "opcounters_per_sec": {k: _per_sec(v) for k, v in opc.items()},
        "document": doc,
        "document_per_sec": {k: _per_sec(v) for k, v in doc.items()},
        "ttl": ttl,
        "note": "per-second rates are cumulative-since-start averages over the uptime window, "
                "not instantaneous (getMongoData reports lifetime counters).",
    }

    # ---- WiredTiger latency histograms (also UNDER serverInfo) ------------
    perf = _get(si, "wiredTiger", "perf") or {}
    wt_hist = _parse_wt_histograms(perf if isinstance(perf, dict) else {})

    # ---- Network / compression posture ------------------------------------
    net = si.get("network") or {}
    net_in = _num(_get(net, "bytesIn"))
    net_out = _num(_get(net, "bytesOut"))
    snappy = _get(net, "compression", "snappy") if isinstance(net.get("compression"), dict) else None
    comp_in = _num(_get(snappy, "compressor", "bytesIn")) if isinstance(snappy, dict) else None
    comp_out = _num(_get(snappy, "compressor", "bytesOut")) if isinstance(snappy, dict) else None
    decomp_in = _num(_get(snappy, "decompressor", "bytesIn")) if isinstance(snappy, dict) else None
    decomp_out = _num(_get(snappy, "decompressor", "bytesOut")) if isinstance(snappy, dict) else None
    network = {
        "bytes_in": net_in,
        "bytes_out": net_out,
        "bytes_in_gb": round(net_in / GIB, 1) if net_in else None,
        "bytes_out_gb": round(net_out / GIB, 1) if net_out else None,
        # Wire (network) compression — distinct from storage block compression below.
        "network_compression_active": bool(snappy),
        "network_compressor": "snappy" if snappy else None,
        "compressor_bytes_in": comp_in,
        "compressor_bytes_out": comp_out,
        "decompressor_bytes_in": decomp_in,
        "decompressor_bytes_out": decomp_out,
        # in÷out of the wire compressor = how well outbound traffic compressed on the wire.
        "wire_compression_ratio": round(_ratio(comp_in, comp_out), 2) if _ratio(comp_in, comp_out) else None,
        # egress÷ingress (raw network) — a read-heavy server ships far more than it receives.
        "egress_ingress_ratio": round(_ratio(net_out, net_in), 1) if _ratio(net_out, net_in) else None,
        "storage_block_compressors": compressors,  # restated so the UI can label correctly
    }
    network["write_amplification"] = network["egress_ingress_ratio"]  # labeled: egress÷ingress

    # ---- Security / config -------------------------------------------------
    sec = _security(raw, parsed_opts, edition, version)

    # ---- Derived structural intelligence (scoring + recommendations) ------
    structural, scoring_stats, idx_summary = _structural(
        collections, all_indexes, server, storage, compression_ratio)

    report = {
        "source_path": source_path,
        "server": server,
        "topology": topology,
        "replication": replication,
        "storage": storage,
        "databases": databases,
        "collections": collections,
        "index_analysis": idx_summary,
        "operations": operations,
        "wiredtiger": wt_hist,
        "network": network,
        "security": sec,
        "errors": raw.get("errors") or [],
        "notes": notes,
    }

    host = {
        "hostname": repl_set_name or "healthcheck",
        "version": version,
        "num_cores": int(num_cores) if num_cores else None,
        "mem_mb": mem_mb,
        "role": (f"shard member (replica-set {repl_set_name})" if cluster_role
                 else (f"replica-set {repl_set_name}" if repl_set_name else "healthcheck")),
        "cluster_role": (f"shard member (replica-set {repl_set_name})" if cluster_role else None),
        "edition": edition,
        "storage_engine": _get(si, "storageEngine"),
    }

    sizing_facts = {
        "storage_bytes_on_disk": total_storage,
        "storage_bytes_logical": total_data,
        "total_index_bytes": total_index,
        "wt_cache_bytes": wt_cache_bytes,
        "bytes_in_cache": bytes_in_cache,
        "compression_ratio": compression_ratio,
        "n_collections": storage["n_collections"],
        "working_set_proxy_bytes": total_data,  # logical data is the upper bound on working set
    }

    return {
        "report": report,
        "scoring_stats": scoring_stats,
        "structural": structural,
        "host": host,
        "sizing": sizing_facts,
        "errors": report["errors"],
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# WiredTiger histogram parsing (flatten the verbose bucket labels)
# ---------------------------------------------------------------------------
def _parse_wt_histograms(perf: dict) -> dict:
    """Group the 'X latency histogram (bucket N) - <range>:count' keys into 4 histograms."""
    groups = {
        "fs_read": "file system read latency histogram",
        "fs_write": "file system write latency histogram",
        "op_read": "operation read latency histogram",
        "op_write": "operation write latency histogram",
    }
    out: Dict[str, dict] = {}
    for gid, prefix in groups.items():
        buckets = []
        total = 0
        for k, v in perf.items():
            if not isinstance(k, str) or not k.startswith(prefix):
                continue
            count = int(_num(v) or 0)
            label = k.split(" - ", 1)[1] if " - " in k else k
            buckets.append({"label": label, "count": count})
            total += count
        if buckets:
            # tail share = fraction of ops in the two slowest visible buckets
            tail = sum(b["count"] for b in buckets[-2:])
            out[gid] = {
                "label": prefix.replace(" histogram", "").title(),
                "buckets": buckets,
                "total": total,
                "tail_count": tail,
                "tail_pct": round(100 * tail / total, 3) if total else None,
            }
    return out


# ---------------------------------------------------------------------------
# Security / config posture (edition feature gaps, bind IP, auth, TLS)
# ---------------------------------------------------------------------------
def _security(raw: dict, parsed: dict, edition: Optional[str], version: Optional[str]) -> dict:
    bind_ip = _get(parsed, "net", "bindIp")
    tls_mode = (_get(parsed, "net", "tls", "mode") or _get(parsed, "net", "ssl", "mode"))
    authz = _get(parsed, "security", "authorization")
    cluster_auth = _get(raw, "clusterAuthMode")
    args = _get(raw, "serverCmdLineOpts", "arguments")
    is_community = (str(edition).lower() == "community") if edition else None

    gaps = []
    if is_community:
        gaps = [
            "Client-Side Field-Level Encryption / Queryable Encryption (Enterprise/Atlas only)",
            "Database auditing (Enterprise only)",
            "LDAP / Kerberos external authentication (Enterprise only)",
            "In-memory storage engine & encryption-at-rest (Enterprise only)",
        ]

    warnings = []
    if bind_ip and "0.0.0.0" in str(bind_ip):
        warnings.append("bindIp is 0.0.0.0 — server listens on all interfaces; ensure a firewall/VPC restricts access.")
    if not authz or str(authz).lower() != "enabled":
        warnings.append("Access control (security.authorization) is not 'enabled' in the parsed config — confirm authentication is enforced.")
    if not tls_mode:
        warnings.append("No TLS/SSL mode found in the parsed config — confirm in-transit encryption is configured.")
    if cluster_auth and str(cluster_auth).lower() == "undefined":
        warnings.append("clusterAuthMode is 'undefined' — intra-cluster auth (keyfile/x509) may not be configured.")

    return {
        "edition": edition,
        "is_community": is_community,
        "version": version,
        "bind_ip": bind_ip,
        "tls_mode": tls_mode,
        "authorization": authz,
        "cluster_auth_mode": cluster_auth,
        "launch_arguments": args,
        "feature_gaps": gaps,
        "warnings": warnings,
        "config_path": _get(parsed, "config"),
        "db_path": _get(parsed, "storage", "dbPath"),
        "journal_enabled": _get(parsed, "storage", "journal", "enabled"),
    }


# ---------------------------------------------------------------------------
# Derived structural findings → scoring stats + per-category recommendations
# ---------------------------------------------------------------------------
def _structural(collections, all_indexes, server, storage, compression_ratio):
    # ---- Index health & bloat ----
    secondary = [r for r in all_indexes if r["name"] != "_id_"]
    unused = [r for r in secondary if _is_unused(r)]
    droppable = [r for r in unused if _droppable(r)]
    unique_unused = [r for r in unused if r.get("unique")]
    redundant = [r for r in all_indexes if r.get("redundant_of")]
    reclaimable_bytes = sum(r["size_bytes"] for r in droppable)
    reclaimable_gb = reclaimable_bytes / GB  # decimal GB (matches the team tool's 2.51 GB)

    def _idx_label(r):
        return f"{r['db']}.{r['collection']}.{r['name']}"

    drop_list = sorted(droppable, key=lambda r: -r["size_bytes"])
    redundant_pairs = [
        {"db": r["db"], "collection": r["collection"], "redundant": r["name"],
         "covered_by": r["redundant_of"], "kind": r["redundant_kind"],
         "redundant_unused": _is_unused(r), "size_bytes": r["size_bytes"]}
        for r in redundant
    ]

    uptime_days = server.get("uptime_days")
    idx_caveats = [
        (f"Index access counts are cumulative since the last restart / stats reset "
         f"(uptime {uptime_days}d) — on a recently restarted node 'unused' does not mean "
         f"safe-to-drop."),
        "Confirm zero usage across ALL replica-set members before dropping (an index may serve "
        "reads on a member not captured here).",
        "Unique indexes are retained even when unused — they enforce a data constraint, not just "
        "query acceleration.",
    ]
    if drop_list:
        top = ", ".join(_idx_label(r) for r in drop_list[:4])
        idx_reco = (f"Drop {len(droppable)} unused secondary index(es) to reclaim "
                    f"~{reclaimable_gb:.2f} GB (largest: {top}"
                    f"{', …' if len(drop_list) > 4 else ''}).")
        if redundant_pairs:
            ex = redundant_pairs[0]
            idx_reco += (f" {len(redundant_pairs)} prefix/shadow-redundant index pair(s) detected "
                         f"(e.g. {ex['db']}.{ex['collection']}: {ex['redundant']} shadows "
                         f"{ex['covered_by']}).")
        idx_reco += " Validate the caveats below before dropping."
    else:
        idx_reco = "No clearly-droppable unused indexes detected in this snapshot."

    index_health = {
        "recommendation": idx_reco,
        "evidence": {
            "secondary_index_count": len(secondary),
            "unused_count": len(unused),
            "droppable_count": len(droppable),
            "unique_unused_count": len(unique_unused),
            "reclaimable_bytes": reclaimable_bytes,
            "reclaimable_gb": round(reclaimable_gb, 3),
            "redundant_pair_count": len(redundant_pairs),
            "drop_list": [
                {"index": _idx_label(r), "db": r["db"], "collection": r["collection"],
                 "name": r["name"], "size_bytes": r["size_bytes"],
                 "size_mb": round(r["size_bytes"] / MB, 1), "ops": r["ops"],
                 "since": r["since"], "key": r["key"]}
                for r in drop_list
            ],
            "redundant_pairs": redundant_pairs,
            "uptime_days": uptime_days,
        },
        "caveats": idx_caveats,
    }

    # ---- Schema & data-model ----
    sized = [c for c in collections if (c["data_size"] or 0) >= _MIN_DATA_FOR_RATIO]
    max_avg_obj = max((c["avg_obj_size"] or 0) for c in collections) if collections else 0
    max_avg_obj_kb = max_avg_obj / 1024.0
    max_indexes = max((c["nindexes"] or 0) for c in collections) if collections else 0
    # index:data ratio only meaningful on collections with real data volume
    ratio_candidates = [(c, c["total_index_size"] / c["data_size"] * 100)
                        for c in sized if c["data_size"]]
    max_idx_to_data = max((r for _, r in ratio_candidates), default=0.0)

    large_doc_colls = sorted(
        [c for c in collections if (c["avg_obj_size"] or 0) >= 10 * 1024],
        key=lambda c: -(c["avg_obj_size"] or 0))
    over_indexed = sorted(
        [c for c in collections if (c["nindexes"] or 0) > 12],
        key=lambda c: -(c["nindexes"] or 0))
    high_idx_ratio = sorted(
        [{"db": c["db"], "name": c["name"], "index_to_data_pct": round(r, 1)}
         for c, r in ratio_candidates if r > 50],
        key=lambda x: -x["index_to_data_pct"])

    schema_flags = []
    if large_doc_colls:
        c = large_doc_colls[0]
        schema_flags.append(
            f"Large average document size: {c['db']}.{c['name']} ≈ {(c['avg_obj_size'] or 0)/1024:.1f} KB/doc "
            f"({int(c['count']):,} docs) — review embedding / unbounded array growth.")
    if over_indexed:
        c = over_indexed[0]
        schema_flags.append(
            f"Over-indexed collection: {c['db']}.{c['name']} carries {c['nindexes']} indexes — "
            f"each adds write amplification; confirm all are earning their keep.")
    if high_idx_ratio:
        h = high_idx_ratio[0]
        schema_flags.append(
            f"High index:data ratio: {h['db']}.{h['name']} indexes are {h['index_to_data_pct']}% of data size.")
    schema_reco = (" ".join(schema_flags) if schema_flags
                   else "No prominent schema/data-model anti-patterns detected in this snapshot.")

    schema = {
        "recommendation": schema_reco,
        "evidence": {
            "max_avg_obj_kb": round(max_avg_obj_kb, 2),
            "max_indexes_per_collection": max_indexes,
            "max_index_to_data_pct": round(max_idx_to_data, 1),
            "large_doc_collections": [
                {"db": c["db"], "name": c["name"], "avg_obj_kb": round((c["avg_obj_size"] or 0)/1024, 1),
                 "count": int(c["count"] or 0)} for c in large_doc_colls[:8]],
            "over_indexed_collections": [
                {"db": c["db"], "name": c["name"], "nindexes": c["nindexes"]} for c in over_indexed[:8]],
            "high_index_ratio_collections": high_idx_ratio[:8],
        },
        "caveats": [
            "Schema findings are structural heuristics from collection stats; confirm against the "
            "application's access patterns (a large embedded doc can be correct by design).",
        ],
    }

    # ---- Storage capacity design ----
    total_data = storage.get("total_data_size")
    total_storage = storage.get("total_storage_size")
    wt_cache = server.get("wt_cache_bytes")
    mem_mb = server.get("mem_mb")
    ram_bytes = mem_mb * MIB if mem_mb else None
    data_to_cache = _ratio(total_data, wt_cache)
    storage_to_ram = _ratio(total_storage, ram_bytes)
    bytes_in_cache = server.get("bytes_in_cache")
    working_set_fits_cache = bool(total_data and wt_cache and total_data <= wt_cache)

    storage_flags = []
    if data_to_cache and data_to_cache > 5:
        storage_flags.append(
            f"Logical data ({storage.get('total_data_tb')} TB) is ~{data_to_cache:.0f}× the WiredTiger "
            f"cache ({server.get('wt_cache_gb')} GB) — the working set cannot be RAM-resident; "
            f"reads are disk-served and storage latency dominates.")
    if storage_to_ram and storage_to_ram > 15:
        storage_flags.append(
            f"On-disk size ({storage.get('total_storage_tb')} TB) is ~{storage_to_ram:.0f}× host RAM "
            f"({server.get('mem_gb')} GB) — this is a large-storage / cold-data profile.")
    if compression_ratio and compression_ratio < 2.0:
        storage_flags.append(
            f"Compression ratio is {compression_ratio:.2f}× (snappy) — modest; zstd could reclaim more "
            f"on-disk space if CPU headroom allows.")
    storage_reco = (" ".join(storage_flags) if storage_flags
                    else "Storage profile is within typical bounds for the cache size.")

    storage_design = {
        "recommendation": storage_reco,
        "evidence": {
            "logical_data_bytes": total_data,
            "on_disk_bytes": total_storage,
            "compression_ratio": round(compression_ratio, 3) if compression_ratio else None,
            "wt_cache_bytes": wt_cache,
            "data_to_cache_ratio": round(data_to_cache, 1) if data_to_cache else None,
            "storage_to_ram_ratio": round(storage_to_ram, 1) if storage_to_ram else None,
            "bytes_in_cache": bytes_in_cache,
            "cache_fill_pct": server.get("cache_fill_pct"),
            "working_set_fits_in_cache": working_set_fits_cache,
        },
        "caveats": [
            "Logical data size is an upper bound on the working set; the hot subset may be far "
            "smaller. Pair with FTDC cache-eviction signals to confirm true memory pressure.",
        ],
    }

    # ---- Scoring stats injected into the scorer's sig_stats ----
    scoring_stats = {
        # index_health_bloat
        "hc_unused_index_count": _stat(float(len(unused))),
        "hc_reclaimable_gb": _stat(round(reclaimable_gb, 3)),
        "hc_prefix_redundant_pairs": _stat(float(len(redundant_pairs))),
        "hc_uptime_days": _stat(uptime_days),
        # schema_datamodel
        "hc_max_avg_obj_kb": _stat(round(max_avg_obj_kb, 2)),
        "hc_max_indexes_per_collection": _stat(float(max_indexes)),
        "hc_max_index_to_data_pct": _stat(round(max_idx_to_data, 1)),
        # storage_capacity_design
        "hc_data_to_cache_ratio": _stat(round(data_to_cache, 2) if data_to_cache else 0.0),
        "hc_storage_to_ram_ratio": _stat(round(storage_to_ram, 2) if storage_to_ram else 0.0),
        "hc_compression_ratio": _stat(round(compression_ratio, 3) if compression_ratio else 0.0),
    }

    structural = {
        "index_health_bloat": index_health,
        "schema_datamodel": schema,
        "storage_capacity_design": storage_design,
    }

    idx_summary = {
        "total_indexes": len(all_indexes),
        "secondary_indexes": len(secondary),
        "unused_count": len(unused),
        "droppable_count": len(droppable),
        "unique_unused_count": len(unique_unused),
        "reclaimable_bytes": reclaimable_bytes,
        "reclaimable_gb": round(reclaimable_gb, 3),
        "redundant_pairs": redundant_pairs,
        "drop_list": index_health["evidence"]["drop_list"],
        "top_accessed": [
            {"index": f"{r['db']}.{r['collection']}.{r['name']}", "ops": r["ops"],
             "size_mb": round(r["size_bytes"] / MB, 1)}
            for r in sorted([r for r in all_indexes if r.get("ops")],
                            key=lambda r: -(r["ops"] or 0))[:10]
        ],
        "all_indexes": [
            {"db": r["db"], "collection": r["collection"], "name": r["name"],
             "key": r["key"], "ops": r["ops"], "since": r["since"],
             "size_bytes": r["size_bytes"], "size_mb": round(r["size_bytes"] / MB, 1),
             "unused": _is_unused(r), "redundant_of": r.get("redundant_of"),
             "unique": r.get("unique")}
            for r in sorted(all_indexes, key=lambda r: (r["db"] or "", r["collection"] or "", r["name"] or ""))
        ],
    }

    return structural, scoring_stats, idx_summary
