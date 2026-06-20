"""Declarative evidence-input registry — the single source of truth for the diagnostic
inputs the analyzer accepts.

Each entry describes one input TYPE: its id, label, on-disk format, whether it is a *primary*
input (one of which is required to run), the categories it unlocks/contributes to, its
collector helper (a real copy-pasteable command + least-privilege role + security note), and
the dotted `parser` ("module:fn") that turns the file into the uniform parsed shape consumed
by the dispatcher (see inputs/__init__.py). FTDC has no `parser` here — it is the dir-decode
spine of build_results — but it is still a first-class registry entry so the wizard slots,
collector helpers, the engine `--dump-ruleset` payload and the "awaiting input — provide X"
messages all read input metadata from ONE place.

ADDITIVE: adding a new input is a new entry here + a parser module; no scorer change.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import List, Optional


@dataclass
class Collector:
    """How an operator obtains this input (rendered in the wizard 'Get it' + awaiting cards)."""
    command: str                 # copy-pasteable
    where: str                   # where to run it (e.g. "a mongos router")
    role: str                    # least-privilege role
    security_note: str           # PII / sensitivity guidance
    doc: str = ""                # optional one-line extra

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class EvidenceInput:
    id: str
    label: str
    format: str                  # "dir" | "json" | "text"
    primary: bool
    description: str
    unlocks: List[str]           # category ids this input scores / contributes to
    collector: Collector
    parser: Optional[str] = None  # "module:fn" — None for FTDC (decode spine) / intake-only
    cli_flag: Optional[str] = None  # the engine CLI flag (for the dispatcher + docs)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["collector"] = self.collector.to_dict()
        d["parseable"] = self.parser is not None
        return d


# ---------------------------------------------------------------------------
# The 5 seeded inputs. (FTDC + healthcheck = primary; profiler/sh_status/rs_status = evidence)
# ---------------------------------------------------------------------------
REGISTRY: List[EvidenceInput] = [
    EvidenceInput(
        id="ftdc",
        label="FTDC diagnostic.data",
        format="dir",
        primary=True,
        description="MongoDB Full-Time Diagnostic Data Capture — host-level time-series "
                    "(CPU, disk, cache, ops, replication lag) the engine decodes directly.",
        unlocks=["memory_cache_pressure", "cpu_compute_sizing", "disk_io_saturation",
                 "replication_lag_cascade", "write_path_contention", "connection_workload_surge",
                 "checkpoint_storage_stalls", "errors_stability", "version_config_risk",
                 "periodic_health_review"],
        collector=Collector(
            command="cp -r <dbPath>/diagnostic.data ./diagnostic.data   # then select the folder",
            where="the mongod host (the data directory)",
            role="filesystem read on the mongod data dir",
            security_note="FTDC holds host-level metrics + config metadata only — no document "
                          "data — but still treat it as sensitive operational data.",
            doc="Atlas captures it automatically; self-managed mongod writes it under dbPath."),
        parser=None,  # decode spine (metrics.extract / verdicts.build_results)
        cli_flag=None,
    ),
    EvidenceInput(
        id="healthcheck",
        label="Healthcheck snapshot (getMongoData)",
        format="json",
        primary=True,
        description="getMongoData/Keyhole point-in-time snapshot — server/host facts, per-"
                    "collection storage & index stats, topology, oplog, WiredTiger detail.",
        unlocks=["index_health_bloat", "schema_datamodel", "storage_capacity_design"],
        collector=Collector(
            command='mongosh "<uri>" --quiet --file collectors/getMongoData.js > healthcheck.json',
            where="any replica-set member (run on each member to compare)",
            role="clusterMonitor + readAnyDatabase",
            security_note="Reveals database/collection names + index keys (schema-revealing); "
                          "no document data. Handle locally as sensitive ops metadata.",
            doc="The collector script is bundled at collectors/getMongoData.js."),
        parser="ftdc_analyzer.inputs.healthcheck_input:parse",
        cli_flag="--healthcheck",
    ),
    EvidenceInput(
        id="profiler",
        label="Query profiler / slow-query log",
        format="json",
        primary=False,
        description="system.profile export or slow-query log — the per-query truth FTDC's "
                    "host-level targeting proxy cannot provide.",
        unlocks=["query_targeting_index_recs", "slow_query_hotspots"],
        collector=Collector(
            command='db.setProfilingLevel(1,{slowms:100});  // later: '
                    'mongoexport -d <db> -c system.profile --sort \'{millis:-1}\' --limit 200 > profiler.json',
            where="a representative member, during a representative window",
            role="clusterMonitor + read on the profiled db",
            security_note="Query predicates can contain literal field VALUES (PII). Redact / "
                          "handle strictly locally; lower slowms only briefly (overhead).",
            doc="Disable afterwards: db.setProfilingLevel(0)."),
        parser=None,  # intake-only today (recorded; parsing is a later phase)
        cli_flag="--profiler",
    ),
    EvidenceInput(
        id="sh_status",
        label="Sharding status (sh.status())",
        format="json",
        primary=False,
        description="Sharded-cluster topology + state — shards, databases & primary shards, "
                    "sharded collections, per-shard chunk counts, balancer state, jumbo chunks.",
        unlocks=["sharding_topology"],
        collector=Collector(
            command='mongosh "<mongos-uri>" --quiet --eval "sh.status()" > sh_status.json  '
                    '# capture as JSON config metadata',
            where="a mongos router (NOT a shard mongod)",
            role="clusterMonitor",
            security_note="Exposes shard hostnames, database/collection names and shard keys "
                          "(schema-revealing) — no document data.",
            doc="Must come from a mongos; a shard mongod cannot see cluster-wide chunk state."),
        parser="ftdc_analyzer.inputs.sh_status:parse",
        cli_flag="--sh-status",
    ),
    EvidenceInput(
        id="rs_status",
        label="Replica-set status (rs.status())",
        format="json",
        primary=False,
        description="replSetGetStatus — full member roster, per-member state/health/optime, "
                    "measured member-to-member replication lag, term & configVersion.",
        unlocks=["replication_lag_cascade"],
        collector=Collector(
            command='mongosh "<member-uri>" --quiet --eval "JSON.stringify(rs.status())" > rs_status.json',
            where="any replica-set member (primary or secondary)",
            role="clusterMonitor",
            security_note="Exposes member hostnames + replication state only — no document data.",
            doc="Gives the full roster (not just the captured member) + measured lag."),
        parser="ftdc_analyzer.inputs.rs_status:parse",
        cli_flag="--rs-status",
    ),
]

_BY_ID = {e.id: e for e in REGISTRY}


def by_id(input_id: str) -> Optional[EvidenceInput]:
    return _BY_ID.get(input_id)


def primary_ids() -> List[str]:
    return [e.id for e in REGISTRY if e.primary]


def parseable() -> List[EvidenceInput]:
    """Evidence inputs the dispatcher routes to a parser (everything with a `parser`)."""
    return [e for e in REGISTRY if e.parser]


def label_for(input_id: str) -> str:
    e = by_id(input_id)
    return e.label if e else input_id


def registry_to_dict() -> dict:
    """Stable JSON for the engine `--dump-ruleset` payload (the UI's source of truth)."""
    return {
        "version": 1,
        "inputs": [e.to_dict() for e in REGISTRY],
        "primary": primary_ids(),
    }
