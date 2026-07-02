"""Issue classification for capacity planning recommendations.

Classifies issues into distinct types to enable dimension-specific recommendations:

1. CAPACITY_LIMIT: Genuinely undersized, need to scale up
2. WORKLOAD_INEFFICIENCY: Queries/indexes wasteful, remediate first
3. CONFIGURATION_ISSUE: Settings misconfigured, reconfigure
4. MIXED: Both capacity and workload issues
5. WELL_PROVISIONED: Resources adequate
6. OVER_PROVISIONED: Can scale down

Each classification comes with recommended actions and confidence score.
"""

from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass


class IssueType(Enum):
    """Types of capacity/performance issues."""
    CAPACITY_LIMIT = "capacity_limit"
    WORKLOAD_INEFFICIENCY = "workload_inefficiency"
    CONFIGURATION_ISSUE = "configuration_issue"
    MIXED = "mixed"
    WELL_PROVISIONED = "well_provisioned"
    OVER_PROVISIONED = "over_provisioned"


class ResourceDimension(Enum):
    """Resource dimensions for scaling."""
    RAM = "ram"
    CPU = "cpu"
    STORAGE = "storage"
    IOPS = "iops"
    NONE = "none"


@dataclass
class DimensionRecommendation:
    """Specific recommendation for a resource dimension."""
    dimension: ResourceDimension
    action: str  # "scale_up", "scale_down", "maintain", "remediate", "reconfigure"
    from_value: Optional[str] = None
    to_value: Optional[str] = None
    rationale: str = ""
    expected_impact: str = ""
    confidence: float = 0.0
    steps: List[str] = None

    def __post_init__(self):
        if self.steps is None:
            self.steps = []

    def to_dict(self) -> dict:
        return {
            "dimension": self.dimension.value,
            "action": self.action,
            "from_value": self.from_value,
            "to_value": self.to_value,
            "rationale": self.rationale,
            "expected_impact": self.expected_impact,
            "confidence": round(self.confidence, 3),
            "steps": self.steps
        }


@dataclass
class IssueClassification:
    """Complete issue classification with recommendations."""
    issue_type: IssueType
    primary_dimension: ResourceDimension
    secondary_dimensions: List[ResourceDimension]
    recommendations: List[DimensionRecommendation]
    root_causes: List[str]
    confidence: float
    explanation: str

    def to_dict(self) -> dict:
        return {
            "issue_type": self.issue_type.value,
            "primary_dimension": self.primary_dimension.value,
            "secondary_dimensions": [d.value for d in self.secondary_dimensions],
            "recommendations": [r.to_dict() for r in self.recommendations],
            "root_causes": self.root_causes,
            "confidence": round(self.confidence, 3),
            "explanation": self.explanation
        }


class IssueClassifier:
    """
    Classifies capacity/performance issues and generates dimension-specific recommendations.
    """

    def classify(self, sig_stats: dict, ranked: list, healthcheck: Optional[dict],
                 dependency_graph=None) -> IssueClassification:
        """
        Classify the issue based on fired categories and metric patterns.

        Args:
            sig_stats: Signal statistics
            ranked: Scored categories from assessment_v2
            healthcheck: Optional healthcheck data
            dependency_graph: Optional dependency graph for root cause analysis

        Returns:
            IssueClassification with recommendations
        """

        # Get fired categories by family
        fired = [c for c in ranked if c.get("fired") and c.get("status") == "scored"]
        fired_by_family = {}
        for cat in fired:
            family = cat.get("family", "other")
            if family not in fired_by_family:
                fired_by_family[family] = []
            fired_by_family[family].append(cat)

        # Helper to check if category fired
        def is_fired(cat_id: str) -> bool:
            return any(c["id"] == cat_id for c in fired)

        # Helper to get stat
        def stat(key, q="p95"):
            s = sig_stats.get(key)
            if not s:
                return None
            return s.get(q) or s.get("p95") or s.get("max")

        # Analyze key indicators
        memory_pressure = is_fired("memory_cache_pressure")
        cpu_pressure = is_fired("cpu_compute_sizing")
        disk_saturation = is_fired("disk_io_saturation")
        query_inefficiency = is_fired("query_targeting_index_recs")
        index_bloat = is_fired("index_redundancy_structural") or is_fired("index_usage_structural")

        cache_used = stat("cache_used_pct") or 0
        eviction_rate = stat("wt_app_evict_ps") or 0
        query_ratio = stat("query_targeting_ratio") or 0
        cpu_util = stat("cpu_util_pct") or 0
        cpu_iowait = stat("cpu_iowait_pct") or 0

        # Determine issue type
        if not fired:
            return self._classify_well_provisioned(sig_stats, ranked)

        # Check for over-provisioning
        if self._is_over_provisioned(sig_stats, ranked):
            return self._classify_over_provisioned(sig_stats, ranked, healthcheck)

        # Check for workload inefficiency
        if query_inefficiency or (query_ratio > 100 and not memory_pressure):
            if memory_pressure or disk_saturation:
                return self._classify_mixed_issue(sig_stats, ranked, healthcheck, dependency_graph)
            else:
                return self._classify_workload_inefficiency(sig_stats, ranked, healthcheck)

        # Check for configuration issues
        if index_bloat and not (memory_pressure and eviction_rate > 0):
            return self._classify_configuration_issue(sig_stats, ranked, healthcheck)

        # Check for clear capacity limit
        if memory_pressure and eviction_rate > 0:
            # Clear memory pressure with eviction = capacity limit
            return self._classify_capacity_limit(sig_stats, ranked, healthcheck, dependency_graph)

        if cpu_pressure and cpu_iowait < 10:
            # CPU pressure without iowait = genuine CPU bottleneck
            return self._classify_capacity_limit(sig_stats, ranked, healthcheck, dependency_graph)

        # Default: mixed issue
        return self._classify_mixed_issue(sig_stats, ranked, healthcheck, dependency_graph)

    def _classify_capacity_limit(self, sig_stats: dict, ranked: list,
                                 healthcheck: Optional[dict], dependency_graph) -> IssueClassification:
        """Classify as clear capacity limit requiring scale-up."""

        recommendations = []
        root_causes = []
        fired = [c for c in ranked if c.get("fired")]

        # Determine primary dimension
        memory_fired = any(c["id"] == "memory_cache_pressure" for c in fired)
        cpu_fired = any(c["id"] == "cpu_compute_sizing" for c in fired)
        disk_fired = any(c["id"] == "disk_io_saturation" for c in fired)

        if memory_fired:
            primary = ResourceDimension.RAM
            cache_used = sig_stats.get("cache_used_pct", {}).get("p95", 0)
            eviction = sig_stats.get("wt_app_evict_ps", {}).get("max", 0)

            root_causes.append(f"Working set exceeds cache (cache {cache_used:.0f}%, eviction {eviction:.0f} pages/s)")

            # Calculate needed RAM
            if healthcheck:
                working_set_gb = healthcheck.get("storage_bytes_logical", 0) / (1024 ** 3)
                current_cache_gb = healthcheck.get("wt_cache_bytes", 0) / (1024 ** 3)
                needed_cache_gb = working_set_gb * 1.3  # 30% headroom

                recommendations.append(DimensionRecommendation(
                    dimension=ResourceDimension.RAM,
                    action="scale_up",
                    from_value=f"{current_cache_gb:.1f} GB cache",
                    to_value=f"{needed_cache_gb:.1f} GB cache",
                    rationale=f"Working set ({working_set_gb:.1f} GB) with 30% headroom",
                    expected_impact="Eliminate cache eviction, reduce disk I/O by 70-90%",
                    confidence=0.96,
                    steps=[
                        f"Current: {current_cache_gb:.1f} GB cache",
                        f"Working set: {working_set_gb:.1f} GB",
                        f"Target: {needed_cache_gb:.1f} GB cache (working set × 1.3)"
                    ]
                ))
            else:
                recommendations.append(DimensionRecommendation(
                    dimension=ResourceDimension.RAM,
                    action="scale_up",
                    rationale=f"Cache at {cache_used:.0f}%, eviction active",
                    expected_impact="Eliminate cache eviction, reduce disk I/O",
                    confidence=0.85,
                    steps=[
                        "Cache pressure detected",
                        "Provide healthcheck for precise sizing"
                    ]
                ))

        elif cpu_fired and sig_stats.get("cpu_iowait_pct", {}).get("p99", 0) < 10:
            primary = ResourceDimension.CPU
            cpu_util = sig_stats.get("cpu_util_pct", {}).get("p95", 0)

            root_causes.append(f"CPU utilization at {cpu_util:.0f}% without iowait (genuine compute load)")

            recommendations.append(DimensionRecommendation(
                dimension=ResourceDimension.CPU,
                action="scale_up",
                rationale=f"CPU at {cpu_util:.0f}%, not I/O bound",
                expected_impact="Reduce query latency, increase throughput",
                confidence=0.88,
                steps=["Scale up vCPU count"]
            ))

        elif disk_fired:
            primary = ResourceDimension.IOPS
            disk_util = sig_stats.get("disk_util_pct", {}).get("p95", 0)
            write_ms = sig_stats.get("disk_avg_write_ms", {}).get("p95", 0)

            if write_ms > 10:
                root_causes.append(f"Disk latency-bound ({write_ms:.1f}ms write latency)")
                recommendations.append(DimensionRecommendation(
                    dimension=ResourceDimension.STORAGE,
                    action="scale_up",
                    rationale="Disk latency exceeds healthy threshold",
                    expected_impact="Reduce query latency",
                    confidence=0.90
                ))
            else:
                root_causes.append(f"Disk throughput-bound ({disk_util:.0f}% utilization)")
                recommendations.append(DimensionRecommendation(
                    dimension=ResourceDimension.IOPS,
                    action="scale_up",
                    rationale="Disk saturated but latency healthy (checkpoint-bound)",
                    expected_impact="Accommodate checkpoint load",
                    confidence=0.85
                ))

            primary = ResourceDimension.IOPS
        else:
            primary = ResourceDimension.NONE

        return IssueClassification(
            issue_type=IssueType.CAPACITY_LIMIT,
            primary_dimension=primary,
            secondary_dimensions=[],
            recommendations=recommendations,
            root_causes=root_causes,
            confidence=0.92,
            explanation="Clear capacity limit detected — scale up required"
        )

    def _classify_workload_inefficiency(self, sig_stats: dict, ranked: list,
                                       healthcheck: Optional[dict]) -> IssueClassification:
        """Classify as workload inefficiency requiring remediation."""

        recommendations = []
        root_causes = []

        query_ratio = sig_stats.get("query_targeting_ratio", {}).get("p95", 0)
        scan_and_order = sig_stats.get("scan_and_order_ps", {}).get("p95", 0)

        if query_ratio > 100:
            root_causes.append(f"Poor query targeting ({query_ratio:.0f}:1 scanned/returned ratio)")
            recommendations.append(DimensionRecommendation(
                dimension=ResourceDimension.NONE,
                action="remediate",
                rationale=f"Query targeting ratio {query_ratio:.0f}:1 (target: <10:1)",
                expected_impact="Reduce resource consumption by 50-80%",
                confidence=0.94,
                steps=[
                    "Analyze slow queries with MongoDB profiler",
                    "Add indexes for frequently scanned collections",
                    "Optimize query patterns (avoid $where, regex on non-indexed fields)"
                ]
            ))

        if scan_and_order > 10:
            root_causes.append(f"In-memory sorts ({scan_and_order:.0f}/s scan-and-order ops)")
            recommendations.append(DimensionRecommendation(
                dimension=ResourceDimension.NONE,
                action="remediate",
                rationale="Frequent in-memory sorts consuming CPU/memory",
                expected_impact="Reduce CPU and memory pressure",
                confidence=0.90,
                steps=[
                    "Add compound indexes to cover sort fields",
                    "Review queries with .sort() for index coverage"
                ]
            ))

        return IssueClassification(
            issue_type=IssueType.WORKLOAD_INEFFICIENCY,
            primary_dimension=ResourceDimension.NONE,
            secondary_dimensions=[],
            recommendations=recommendations,
            root_causes=root_causes,
            confidence=0.93,
            explanation="Workload inefficiency detected — remediate before scaling"
        )

    def _classify_configuration_issue(self, sig_stats: dict, ranked: list,
                                     healthcheck: Optional[dict]) -> IssueClassification:
        """Classify as configuration issue requiring tuning."""

        recommendations = []
        root_causes = []

        index_bloat = any(c["id"] in ("index_redundancy_structural", "index_usage_structural")
                         for c in ranked if c.get("fired"))

        if index_bloat and healthcheck:
            # Calculate reclaimable space from unused indexes
            recommendations.append(DimensionRecommendation(
                dimension=ResourceDimension.RAM,
                action="reconfigure",
                rationale="Unused/redundant indexes consuming cache",
                expected_impact="Reclaim cache space without scaling",
                confidence=0.90,
                steps=[
                    "Drop unused indexes (check $indexStats for ops=0)",
                    "Remove prefix-redundant indexes",
                    "Compact collections after index removal"
                ]
            ))
            root_causes.append("Index bloat consuming cache space")

        return IssueClassification(
            issue_type=IssueType.CONFIGURATION_ISSUE,
            primary_dimension=ResourceDimension.NONE,
            secondary_dimensions=[],
            recommendations=recommendations,
            root_causes=root_causes,
            confidence=0.88,
            explanation="Configuration issue detected — reconfigure before scaling"
        )

    def _classify_mixed_issue(self, sig_stats: dict, ranked: list,
                             healthcheck: Optional[dict], dependency_graph) -> IssueClassification:
        """Classify as mixed issue (capacity + workload)."""

        recommendations = []
        root_causes = []

        # Both capacity and workload issues present
        memory_pressure = any(c["id"] == "memory_cache_pressure" for c in ranked if c.get("fired"))
        query_inefficiency = any(c["id"] == "query_targeting_index_recs" for c in ranked if c.get("fired"))

        if query_inefficiency:
            root_causes.append("Query inefficiency amplifying resource usage")
            recommendations.append(DimensionRecommendation(
                dimension=ResourceDimension.NONE,
                action="remediate",
                rationale="Remediate queries first to reduce resource demand",
                expected_impact="Reduce load by 30-50%, then reassess capacity",
                confidence=0.85,
                steps=[
                    "Fix query inefficiencies (see query targeting category)",
                    "Re-run analysis after remediation",
                    "Scale up only if pressure persists"
                ]
            ))

        if memory_pressure:
            root_causes.append("Memory pressure also present (may be amplified by queries)")
            recommendations.append(DimensionRecommendation(
                dimension=ResourceDimension.RAM,
                action="scale_up",
                rationale="Scale RAM after query remediation if pressure persists",
                expected_impact="Eliminate cache pressure",
                confidence=0.70,
                steps=["Remediate queries first", "Reassess memory needs"]
            ))

        return IssueClassification(
            issue_type=IssueType.MIXED,
            primary_dimension=ResourceDimension.NONE,
            secondary_dimensions=[ResourceDimension.RAM],
            recommendations=recommendations,
            root_causes=root_causes,
            confidence=0.78,
            explanation="Mixed issue: remediate workload first, then reassess capacity"
        )

    def _classify_well_provisioned(self, sig_stats: dict, ranked: list) -> IssueClassification:
        """Classify as well-provisioned (no issues)."""

        return IssueClassification(
            issue_type=IssueType.WELL_PROVISIONED,
            primary_dimension=ResourceDimension.NONE,
            secondary_dimensions=[],
            recommendations=[
                DimensionRecommendation(
                    dimension=ResourceDimension.NONE,
                    action="maintain",
                    rationale="All resources within healthy thresholds",
                    expected_impact="No changes needed",
                    confidence=0.95
                )
            ],
            root_causes=[],
            confidence=0.95,
            explanation="System is well-provisioned — no action needed"
        )

    def _classify_over_provisioned(self, sig_stats: dict, ranked: list,
                                   healthcheck: Optional[dict]) -> IssueClassification:
        """Classify as over-provisioned (can scale down)."""

        recommendations = []
        root_causes = []

        cache_used = sig_stats.get("cache_used_pct", {}).get("p95", 0)
        cpu_util = sig_stats.get("cpu_util_pct", {}).get("p95", 0)

        if cache_used < 60:
            root_causes.append(f"Cache lightly used ({cache_used:.0f}%)")
            recommendations.append(DimensionRecommendation(
                dimension=ResourceDimension.RAM,
                action="scale_down",
                rationale=f"Cache only {cache_used:.0f}% utilized",
                expected_impact="Reduce costs without impacting performance",
                confidence=0.88
            ))

        if cpu_util < 40:
            root_causes.append(f"CPU lightly used ({cpu_util:.0f}%)")
            recommendations.append(DimensionRecommendation(
                dimension=ResourceDimension.CPU,
                action="scale_down",
                rationale=f"CPU only {cpu_util:.0f}% utilized",
                expected_impact="Reduce costs",
                confidence=0.85
            ))

        primary = ResourceDimension.RAM if cache_used < 60 else ResourceDimension.CPU

        return IssueClassification(
            issue_type=IssueType.OVER_PROVISIONED,
            primary_dimension=primary,
            secondary_dimensions=[],
            recommendations=recommendations,
            root_causes=root_causes,
            confidence=0.87,
            explanation="System is over-provisioned — can scale down safely"
        )

    def _is_over_provisioned(self, sig_stats: dict, ranked: list) -> bool:
        """Check if system is over-provisioned."""
        cache_used = sig_stats.get("cache_used_pct", {}).get("p95", 100)
        cpu_util = sig_stats.get("cpu_util_pct", {}).get("p95", 100)

        # Over-provisioned if both CPU and cache are lightly used
        return cache_used < 60 and cpu_util < 40
