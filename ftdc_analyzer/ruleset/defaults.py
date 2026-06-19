"""The default declarative ruleset: 16 categories across 6 families.

Five are fully specified (deep signal sets, real MongoDB 3.6 derived-signal paths,
weights, disambiguators, caveats, cross-category conditioning); the other eleven are
declared as stubs (id/name/family/required_inputs/description/caveats + a small or empty
placeholder signal set marked status="stub") so they are visible and wired before their
inputs/depth land.

Metric paths are the engine's *derived signal keys* (see verdicts.UNITS / metrics.derive),
not raw FTDC paths — the scorer reads the per-signal summary stats by these keys.
"""

from __future__ import annotations

from .schema import (
    Category,
    Disambiguator,
    Intent,
    IntentCategory,
    Ruleset,
    Signal,
)

RULESET_VERSION = 1

# Honest caveat that MUST ride on every Capacity category: a resource-stress reading is
# only valid once workload efficiency is known (a tiny working set scanned badly mimics
# undersized hardware).
CAPACITY_CAVEAT = (
    "Resource-stress conclusions are conditional on workload efficiency being known: an "
    "inefficient query pattern (poor index targeting, collection scans) can mimic "
    "undersized hardware. Confirm with profiler/healthcheck inputs before resizing."
)

# Conditional recommendation shared by capacity categories when query targeting fires.
_WORKLOAD_FLIP = (
    "Resource stress appears workload-induced — inefficient queries are inflating the "
    "working set / I/O. Remediate query targeting and indexing first, then reassess "
    "sizing after the workload is corrected."
)


def _S(path, weight, direction="+", comparator=">", threshold=0.0, stat="p95",
       interpretation="", disambiguator=None, status="active", unit=""):
    return Signal(metric_path=path, weight=weight, direction=direction,
                  comparator=comparator, threshold=threshold, stat=stat,
                  interpretation=interpretation, disambiguator=disambiguator,
                  status=status, unit=unit)


def _D(co_signal, comparator, value, effect="enable", scale=1.0, note=""):
    return Disambiguator(co_signal=co_signal, comparator=comparator, value=value,
                         effect=effect, scale=scale, note=note)


# ---------------------------------------------------------------------------
# DEEP categories (5)
# ---------------------------------------------------------------------------
def _memory_cache_pressure() -> Category:
    return Category(
        id="memory_cache_pressure",
        name="Memory / Cache Pressure",
        family="Capacity",
        description=(
            "Is the WiredTiger cache (and host RAM) under genuine pressure? Distinguishes a "
            "healthily-full cache from one the server can no longer self-service — where "
            "application threads are forced to evict and the OS starts faulting."),
        required_inputs=["ftdc"],
        signals=[
            _S("cache_used_pct", 0.30, "+", ">", 80, "p95", unit="%",
               interpretation="WiredTiger cache is filling near its configured maximum.",
               disambiguator=_D("wt_app_evict_ps", ">", 0, "enable",
                                note="A full cache is only pressure when application threads "
                                     "are forced to evict; a full-but-calm cache is healthy "
                                     "use of RAM.")),
            _S("wt_app_evict_ps", 0.30, "+", ">", 0, "p95", unit="pages/s",
               interpretation="Application threads are evicting pages — the cache cannot "
                              "self-service under load (the strongest pressure signal)."),
            _S("cache_dirty_pct", 0.20, "+", ">", 5, "p95", unit="%",
               interpretation="Dirty cache above WiredTiger's 5% target — eviction/checkpoint "
                              "cannot keep pace with writes."),
            _S("page_faults_ps", 0.15, "+", ">", 50, "p95", unit="faults/s",
               interpretation="OS page faults — the working set may exceed available RAM."),
            _S("wt_unmodified_evict_ps", 0.05, "+", ">", 0, "p95", unit="pages/s",
               interpretation="Unmodified-page eviction churn (read-side cache pressure)."),
        ],
        caveats=[
            CAPACITY_CAVEAT,
            "A cache fill near 80% is WiredTiger's steady-state design point; pressure is "
            "indicated by eviction *by application threads*, not by fill level alone.",
        ],
        recommendation=(
            "Cache-pressure indicators are elevated. Consider increasing RAM / WiredTiger "
            "cache size — but first rule out inefficient queries inflating the working set."),
        conditioned_by=["query_targeting_index_recs", "schema_datamodel"],
        conditional_recommendations={"query_targeting_index_recs": _WORKLOAD_FLIP},
        fire_threshold=0.5,
    )


def _cpu_compute_sizing() -> Category:
    return Category(
        id="cpu_compute_sizing",
        name="CPU / Compute Sizing",
        family="Capacity",
        description=(
            "Is the node compute-bound (needs more vCPUs) or is the CPU merely waiting on "
            "slow storage? Separates true user/system compute saturation from I/O-wait and "
            "hypervisor steal."),
        required_inputs=["ftdc"],
        signals=[
            _S("cpu_util_pct", 0.35, "+", ">", 75, "p95", unit="%",
               interpretation="Sustained high CPU utilization at peak.",
               disambiguator=_D("cpu_iowait_pct", "<", 20, "enable",
                                note="Only count high CPU as a compute-sizing signal when it "
                                     "is NOT dominated by I/O wait (otherwise it's a storage "
                                     "problem and more vCPUs won't help).")),
            _S("cpu_iowait_pct", 0.15, "-", ">", 20, "p95", unit="%",
               interpretation="I/O wait dominates — the bottleneck is storage, not compute; "
                              "this lowers the compute-sizing confidence."),
            _S("cpu_user_pct", 0.15, "+", ">", 60, "p95", unit="%",
               interpretation="User-space CPU dominant (application compute)."),
            _S("cpu_system_pct", 0.10, "+", ">", 30, "p95", unit="%",
               interpretation="Kernel CPU high — syscall / context-switch overhead."),
            _S("cpu_steal_pct", 0.10, "+", ">", 5, "p95", unit="%",
               interpretation="CPU steal — noisy neighbour / oversubscribed host."),
            _S("procs_running", 0.15, "+", ">", 4, "p95", unit="count",
               interpretation="Run-queue depth indicates more runnable threads than cores."),
        ],
        caveats=[
            CAPACITY_CAVEAT,
            "I/O-wait-dominated CPU is a storage symptom; adding vCPUs will not help it.",
        ],
        recommendation=(
            "CPU appears compute-bound at peak. Consider more vCPUs — after confirming the "
            "load isn't inflated by inefficient queries."),
        conditioned_by=["query_targeting_index_recs", "schema_datamodel"],
        conditional_recommendations={"query_targeting_index_recs": _WORKLOAD_FLIP},
        fire_threshold=0.5,
    )


def _disk_io_saturation() -> Category:
    return Category(
        id="disk_io_saturation",
        name="Disk I/O Saturation",
        family="Capacity",
        description=(
            "Is the data volume saturated, and is it latency-bound (true saturation) or "
            "checkpoint-bound (often acceptable)? Combines utilization, service latency, "
            "queue depth and checkpoint co-occurrence."),
        required_inputs=["ftdc"],
        signals=[
            _S("disk_util_pct", 0.35, "+", ">", 85, "p95", unit="%",
               interpretation="Data-disk utilization is saturated."),
            _S("disk_avg_write_ms", 0.15, "+", ">", 10, "p95", unit="ms",
               interpretation="Write service latency elevated."),
            _S("disk_avg_read_ms", 0.10, "+", ">", 10, "p95", unit="ms",
               interpretation="Read service latency elevated."),
            _S("queue_depth", 0.15, "+", ">", 4, "p95", unit="count",
               interpretation="I/O queue depth building (requests waiting)."),
            _S("wt_checkpoint_running", 0.10, "+", ">", 0, "max", unit="0/1",
               interpretation="Saturation coincides with active checkpoints.",
               disambiguator=_D("disk_util_pct", ">", 85, "enable",
                                note="Checkpoint activity is only saturation evidence when the "
                                     "disk is also saturated; otherwise it's routine.")),
            _S("cache_write_mbps", 0.05, "+", ">", 50, "p95", unit="MB/s",
               interpretation="High cache writeback throughput to disk."),
        ],
        caveats=[
            CAPACITY_CAVEAT,
            "Checkpoint-bound saturation with healthy service latency can be acceptable; "
            "distinguish it from latency-bound saturation before changing storage.",
        ],
        recommendation=(
            "Disk I/O is saturated. Consider faster / provisioned-IOPS storage — but first "
            "confirm the load isn't driven by inefficient queries (scans inflate I/O)."),
        conditioned_by=["query_targeting_index_recs", "schema_datamodel"],
        conditional_recommendations={"query_targeting_index_recs": _WORKLOAD_FLIP},
        fire_threshold=0.5,
    )


def _replication_lag_cascade() -> Category:
    return Category(
        id="replication_lag_cascade",
        name="Replication Lag Cascade",
        family="Incident-RCA",
        description=(
            "Is a secondary falling behind, and is the lag a primary symptom or a downstream "
            "consequence of apply-side resource saturation / write contention? Infers cause "
            "from co-occurring signals (FTDC has no direct apply-timing)."),
        required_inputs=["ftdc"],
        signals=[
            _S("repl_lag_s", 0.40, "+", ">", 10, "max", unit="s",
               interpretation="Maximum secondary replication lag exceeds 10s."),
            _S("repl_buffer_mb", 0.15, "+", ">", 0, "p95", unit="MB",
               interpretation="Replication apply buffer backing up."),
            _S("oplat_write_ms", 0.15, "+", ">", 20, "p95", unit="ms",
               interpretation="Write latency elevated (apply/replicate pressure)."),
            _S("disk_util_pct", 0.15, "+", ">", 85, "p95", unit="%",
               interpretation="Apply-side disk saturated — secondary cannot keep up.",
               disambiguator=_D("repl_lag_s", ">", 5, "enable",
                                note="Disk saturation only counts toward lag cascade when "
                                     "lag is actually present.")),
            _S("write_conflicts_ps", 0.15, "+", ">", 0, "p95", unit="ops/s",
               interpretation="Write conflicts — contention slowing apply throughput."),
        ],
        caveats=[
            "FTDC lacks the oplog window and per-op apply timing; lag *cause* is inferred "
            "from co-occurring resource saturation, not measured directly.",
            "On a SECONDARY capture this reflects that node; on a PRIMARY capture, lag is "
            "derived from member optimes (the freshest member is treated as primary).",
        ],
        recommendation=(
            "Replication lag is elevated. Investigate apply-side resource saturation "
            "(disk/CPU) and write contention on the lagging member."),
        conditioned_by=["write_path_contention"],
        conditional_recommendations={
            "write_path_contention": (
                "Replication lag co-occurs with write-path contention — the lag is likely a "
                "downstream symptom of write-ticket exhaustion / lock queueing. Address the "
                "write-path contention first; lag should recover.")},
        fire_threshold=0.4,
    )


def _write_path_contention() -> Category:
    return Category(
        id="write_path_contention",
        name="Write-Path Contention",
        family="Incident-RCA",
        description=(
            "Are writes contending for WiredTiger tickets and the global lock? Looks at "
            "ticket utilization, queueing, write conflicts and write latency to spot a write "
            "bottleneck — and whether it's driven by volume or by slow storage holding tickets."),
        required_inputs=["ftdc"],
        signals=[
            _S("write_ticket_util_pct", 0.30, "+", ">", 90, "p95", unit="%",
               interpretation="WiredTiger write tickets near exhaustion (90% of pool)."),
            _S("write_queue", 0.20, "+", ">", 0, "p95", unit="count",
               interpretation="Write operations queued at the global lock."),
            _S("write_conflicts_ps", 0.15, "+", ">", 0, "p95", unit="ops/s",
               interpretation="Write conflicts — document-level contention forcing retries."),
            _S("oplat_write_ms", 0.15, "+", ">", 20, "p95", unit="ms",
               interpretation="Write latency elevated."),
            _S("write_tickets_out", 0.10, "+", ">", 100, "p95", unit="count",
               interpretation="Write tickets in use approaching the 128 default limit."),
            _S("queued_total", 0.10, "+", ">", 0, "p95", unit="count",
               interpretation="Total operations queued at the global lock."),
        ],
        caveats=[
            "Ticket exhaustion can be driven by slow storage (tickets held longer per op) "
            "rather than raw write volume — always correlate with disk saturation.",
        ],
        recommendation=(
            "Write-path contention is elevated (ticket/lock queueing). Investigate storage "
            "latency and hot-document write patterns; consider write batching / schema change."),
        conditioned_by=["disk_io_saturation", "schema_datamodel"],
        conditional_recommendations={
            "disk_io_saturation": (
                "Write contention co-occurs with disk saturation — tickets are likely held by "
                "slow I/O rather than write volume. Address storage performance first; "
                "contention should ease.")},
        fire_threshold=0.5,
    )


# ---------------------------------------------------------------------------
# STUB categories (11) — declared + wired, not yet deep
# ---------------------------------------------------------------------------
def _stub(cid, name, family, description, required_inputs, caveats,
          recommendation, signals=None, conditioned_by=None,
          conditional_recommendations=None):
    return Category(
        id=cid, name=name, family=family, description=description,
        required_inputs=required_inputs, signals=signals or [],
        caveats=caveats, recommendation=recommendation,
        conditioned_by=conditioned_by or [],
        conditional_recommendations=conditional_recommendations or {},
        status="stub",
    )


def _stub_categories():
    return [
        # Incident-RCA (ftdc-available, shallow)
        _stub("connection_workload_surge", "Connection / Workload Surge", "Incident-RCA",
              "Detects connection storms and sudden workload surges (connection pool "
              "pressure, churn) that precede instability.", ["ftdc"],
              ["Surge attribution to a client/app needs connection-source detail not in FTDC."],
              "Investigate connection pool sizing and client retry storms.",
              signals=[
                  _S("conn_used_pct", 0.5, "+", ">", 80, "p95", status="stub",
                     interpretation="Connection pool utilization high."),
                  _S("conn_created_ps", 0.5, "+", ">", 50, "p95", status="stub",
                     interpretation="High new-connection churn."),
              ]),
        _stub("checkpoint_storage_stalls", "Checkpoint / Storage Stalls", "Incident-RCA",
              "Detects WiredTiger checkpoint stalls and storage write-back stalls that pause "
              "the server.", ["ftdc"],
              ["Checkpoint duration is a gauge; correlating stalls to user-visible latency "
               "needs op-latency overlap analysis (planned)."],
              "Investigate checkpoint duration vs storage throughput.",
              signals=[
                  _S("wt_checkpoint_max_ms", 0.6, "+", ">", 5000, "max", status="stub",
                     interpretation="Longest checkpoint exceeded 5s."),
                  _S("wt_checkpoint_recent_ms", 0.4, "+", ">", 2000, "p95", status="stub",
                     interpretation="Recent checkpoint durations elevated."),
              ]),
        _stub("errors_stability", "Errors & Stability", "Incident-RCA",
              "Tracks asserts and error rates as a stability/health signal.", ["ftdc"],
              ["Asserts are coarse; root-causing a spike needs the mongod log."],
              "Investigate assert spikes against the mongod log around the same window.",
              signals=[
                  _S("asserts_regular_ps", 0.5, "+", ">", 0, "p95", status="stub",
                     interpretation="Regular asserts occurring."),
                  _S("asserts_user_ps", 0.5, "+", ">", 1, "p95", status="stub",
                     interpretation="Elevated user asserts."),
              ]),
        # Cluster-Context (ftdc)
        _stub("version_config_risk", "Version & Config Risk", "Cluster-Context",
              "Flags end-of-life server versions and risky/legacy configuration (from build "
              "and cmdline metadata).", ["ftdc"],
              ["Version EOL is read from buildInfo; configuration-risk depth is planned."],
              "Plan an upgrade path off EOL releases; review risky config flags."),
        _stub("sharding_topology", "Sharding & Topology", "Cluster-Context",
              "Surfaces sharded-cluster context (stale-config churn, balancer signals) and "
              "the limits of single-host FTDC for cluster-wide conclusions.", ["ftdc"],
              ["FTDC covers only the analyzed host; cluster-wide behaviour may originate "
               "elsewhere (mongos/config servers)."],
              "Correlate stale-config churn with balancer activity across shard members.",
              signals=[
                  _S("stale_config_errors_ps", 1.0, "+", ">", 0, "p95", status="stub",
                     interpretation="Stale-config errors (routing/metadata churn)."),
              ]),
        # Structural-Design (require healthcheck)
        _stub("index_health_bloat", "Index Health & Bloat", "Structural-Design",
              "Unused/redundant indexes, index bloat and write-amplification from over-"
              "indexing — needs collection/index stats from a healthcheck snapshot.",
              ["ftdc", "healthcheck"],
              ["Requires the healthcheck snapshot (getMongoData.js) — not derivable from FTDC."],
              "Upload the healthcheck snapshot to populate index usage and bloat analysis."),
        _stub("schema_datamodel", "Schema & Data Model", "Structural-Design",
              "Data-model anti-patterns (unbounded arrays, large documents, hot collections) "
              "that drive resource stress — needs healthcheck collection stats.",
              ["ftdc", "healthcheck"],
              ["Requires healthcheck collection/schema stats — not derivable from FTDC."],
              "Upload the healthcheck snapshot to populate schema / data-model analysis."),
        _stub("storage_capacity_design", "Storage Capacity Design", "Structural-Design",
              "Working-set-vs-cache fit, on-disk sizing and fragmentation — needs collection "
              "size/storage stats from a healthcheck snapshot.",
              ["ftdc", "healthcheck"],
              ["Requires healthcheck storage stats — FTDC has no per-collection sizing."],
              "Upload the healthcheck snapshot to populate storage-capacity design analysis."),
        # Query-Optimization (require profiler)
        _stub("query_targeting_index_recs", "Query Targeting & Index Recs", "Query-Optimization",
              "Query targeting (scanned-vs-returned), COLLSCAN identification and index "
              "recommendations — needs the slow-query log / profiler. FTDC carries only a "
              "host-level targeting proxy.",
              ["ftdc", "profiler"],
              ["Requires the MongoDB slow-query log / profiler output; FTDC's "
               "query_targeting_ratio is a host-level proxy, not per-query truth."],
              "Upload the slow-query log / profiler output to populate query targeting and "
              "index recommendations.",
              signals=[
                  _S("query_targeting_ratio", 1.0, "+", ">", 100, "p95", status="stub",
                     unit="ratio",
                     interpretation="(FTDC proxy) host-level scanned/returned ratio elevated — "
                                    "confirm with the profiler."),
              ]),
        _stub("slow_query_hotspots", "Slow-Query Hotspots", "Query-Optimization",
              "Per-namespace latency, slowest individual queries and operation hotspots — "
              "needs the slow-query log / profiler.",
              ["ftdc", "profiler"],
              ["Requires the slow-query log / profiler output — not derivable from FTDC."],
              "Upload the slow-query log / profiler output to populate slow-query hotspots."),
        # Cross-Cutting
        _stub("periodic_health_review", "Periodic Health Review", "Cross-Cutting",
              "A scheduled, cross-cutting health review that rolls up the other categories on "
              "a cadence and tracks drift over time.", ["ftdc"],
              ["A roll-up view; depends on the maturity of the categories it aggregates."],
              "Run periodically and track category scores over time for drift."),
    ]


# ---------------------------------------------------------------------------
# Intents — declarative lenses over the 16 categories (audience-facing presets)
# ---------------------------------------------------------------------------
def _ic(category_id, lean=1.0):
    return IntentCategory(category_id=category_id, lean=lean)


def build_default_intents():
    return [
        Intent(
            id="right_sizing",
            title="Right-sizing",
            subtitle="Is this cluster correctly provisioned for its workload?",
            description="Surfaces the Capacity family (memory/cache, CPU, disk) first, with the "
                        "workload-efficiency conditioning kept visible so sizing is never judged "
                        "without knowing whether the load is efficient.",
            categories=[
                _ic("memory_cache_pressure", 1.5),
                _ic("cpu_compute_sizing", 1.5),
                _ic("disk_io_saturation", 1.5),
                _ic("query_targeting_index_recs", 0.8),  # conditioning context
                _ic("schema_datamodel", 0.6),
            ],
        ),
        Intent(
            id="cost_optimization",
            title="Cost optimization",
            subtitle="Where can you save — including when the fix is the workload, not bigger hardware?",
            description="Capacity plus the query/schema conditioning foregrounded — the "
                        "'don't scale up, fix the workload' inversion. Highlights where resource "
                        "stress is workload-induced and a query/index fix beats a bigger box.",
            categories=[
                _ic("disk_io_saturation", 1.3),
                _ic("memory_cache_pressure", 1.3),
                _ic("cpu_compute_sizing", 1.3),
                _ic("query_targeting_index_recs", 1.5),  # foregrounded
                _ic("schema_datamodel", 1.2),
            ],
            note="The conditioning that flips a sizing recommendation to a workload fix needs the "
                 "profiler/healthcheck inputs to confirm.",
        ),
        Intent(
            id="incident_rca",
            title="Incident / RCA",
            subtitle="What happened during a slowdown or outage?",
            description="Leads with the Incident-RCA family: replication lag cascade, write-path "
                        "contention, connection/workload surge, checkpoint/storage stalls, and "
                        "errors & stability.",
            categories=[
                _ic("replication_lag_cascade", 1.5),
                _ic("write_path_contention", 1.5),
                _ic("connection_workload_surge", 1.2),
                _ic("checkpoint_storage_stalls", 1.2),
                _ic("errors_stability", 1.2),
            ],
        ),
        Intent(
            id="general_health",
            title="General health check",
            subtitle="Spot worrying trends before they become incidents.",
            description="A broad cross-family sweep led by the periodic health review, ranking "
                        "every area by confidence to flag the worst trend per area.",
            categories=[_ic("periodic_health_review", 1.2)],
            full_sweep=True,
        ),
        Intent(
            id="query_index_opt",
            title="Query & index optimization",
            subtitle="Find inefficient queries and missing or unused indexes.",
            description="The Query-Optimization family: query-targeting & index recommendations "
                        "and slow-query hotspots.",
            categories=[
                _ic("query_targeting_index_recs", 1.5),
                _ic("slow_query_hotspots", 1.5),
            ],
            note="Requires the query profiler / slow-query log; shows requires_input until provided.",
        ),
        Intent(
            id="schema_review",
            title="Schema & data-model review",
            subtitle="Find data-model anti-patterns hurting performance.",
            description="The Structural-Design family: index health & bloat, schema & data model, "
                        "and storage-capacity design.",
            categories=[
                _ic("index_health_bloat", 1.5),
                _ic("schema_datamodel", 1.5),
                _ic("storage_capacity_design", 1.5),
            ],
            note="Requires the healthcheck snapshot; shows requires_input until provided.",
        ),
        Intent(
            id="full_sweep",
            title="Full sweep",
            subtitle="Score everything and rank by confidence.",
            description="All 16 categories scored and ranked by confidence — no lens applied.",
            categories=[],
            full_sweep=True,
        ),
    ]


def build_default_ruleset() -> Ruleset:
    """The typed default ruleset (defaults only; overrides are merged separately)."""
    categories = [
        _memory_cache_pressure(),
        _cpu_compute_sizing(),
        _disk_io_saturation(),
        _replication_lag_cascade(),
        _write_path_contention(),
    ]
    categories.extend(_stub_categories())
    return Ruleset(version=RULESET_VERSION, categories=categories,
                   intents=build_default_intents())
