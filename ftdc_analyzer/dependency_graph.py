"""Cross-metric dependency graph for root cause analysis.

Models causal relationships between MongoDB metrics to trace symptoms back to root causes.
This enables high-confidence provisioning recommendations by understanding WHY metrics are
firing, not just THAT they fired.

Architecture:
- Nodes: Metrics/categories with their current state
- Edges: Causal relationships (amplifies, masks, conditions)
- Algorithms: Root cause tracing, impact scoring, confidence propagation
"""

from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional, Set, Tuple
from dataclasses import dataclass, field


class RelationshipType(Enum):
    """Types of causal relationships between metrics."""
    AMPLIFIES = "amplifies"          # A increases B (e.g., memory pressure → disk I/O)
    CAUSES = "causes"                # A directly causes B (e.g., cache miss → disk read)
    MASKS = "masks"                  # A hides B (e.g., slow disk masks query inefficiency)
    CONDITIONS = "conditions"        # A changes interpretation of B
    INDICATES = "indicates"          # A is evidence of B (e.g., eviction → memory pressure)


@dataclass
class MetricNode:
    """A node in the dependency graph representing a metric or category."""
    id: str
    value: Optional[float] = None
    threshold: Optional[float] = None
    fired: bool = False
    confidence: float = 0.0
    evidence: List[str] = field(default_factory=list)
    category: Optional[str] = None  # memory, cpu, disk, query, etc.

    def __hash__(self):
        return hash(self.id)


@dataclass
class CausalEdge:
    """A directed edge representing a causal relationship."""
    from_node: str
    to_node: str
    relationship: RelationshipType
    weight: float  # 0.0-1.0, how strong is this relationship
    condition: Optional[str] = None  # Optional condition for this edge to apply
    note: str = ""

    def __repr__(self):
        cond = f" [if {self.condition}]" if self.condition else ""
        return f"{self.from_node} --[{self.relationship.value} {self.weight:.2f}]--> {self.to_node}{cond}"


class DependencyGraph:
    """
    Dependency graph for MongoDB metric relationships.

    Supports:
    - Adding nodes (metrics/categories) and edges (relationships)
    - Tracing root causes backward from symptoms
    - Computing impact scores (how many downstream effects)
    - Confidence propagation through causal chains
    """

    def __init__(self):
        self.nodes: Dict[str, MetricNode] = {}
        self.edges: List[CausalEdge] = []
        self._incoming: Dict[str, List[CausalEdge]] = {}  # node_id -> edges pointing to it
        self._outgoing: Dict[str, List[CausalEdge]] = {}  # node_id -> edges from it

    def add_node(self, node: MetricNode):
        """Add a metric/category node to the graph."""
        self.nodes[node.id] = node
        if node.id not in self._incoming:
            self._incoming[node.id] = []
        if node.id not in self._outgoing:
            self._outgoing[node.id] = []

    def add_edge(self, edge: CausalEdge):
        """Add a causal relationship edge."""
        # Ensure nodes exist in index (create if needed)
        if edge.from_node not in self._incoming:
            self._incoming[edge.from_node] = []
        if edge.from_node not in self._outgoing:
            self._outgoing[edge.from_node] = []
        if edge.to_node not in self._incoming:
            self._incoming[edge.to_node] = []
        if edge.to_node not in self._outgoing:
            self._outgoing[edge.to_node] = []

        self.edges.append(edge)
        self._incoming[edge.to_node].append(edge)
        self._outgoing[edge.from_node].append(edge)

    def add_relationship(self, from_id: str, to_id: str, relationship: RelationshipType,
                        weight: float, condition: Optional[str] = None, note: str = ""):
        """Helper to add a relationship between two node IDs."""
        edge = CausalEdge(
            from_node=from_id,
            to_node=to_id,
            relationship=relationship,
            weight=weight,
            condition=condition,
            note=note
        )
        self.add_edge(edge)

    def trace_root_causes(self, symptom_id: str, max_depth: int = 5) -> List[Tuple[str, float, List[str]]]:
        """
        Trace backward from a symptom to find root causes.

        Returns: [(root_cause_id, confidence, evidence_chain)]
        Sorted by confidence (highest first).
        """
        if symptom_id not in self.nodes:
            return []

        # BFS backward through the graph
        visited: Set[str] = set()
        queue: List[Tuple[str, float, List[str], int]] = [(symptom_id, 1.0, [symptom_id], 0)]
        root_causes: List[Tuple[str, float, List[str]]] = []

        while queue:
            current_id, confidence, chain, depth = queue.pop(0)

            if current_id in visited or depth > max_depth:
                continue
            visited.add(current_id)

            # Get incoming edges (causes of this node)
            incoming = self._incoming.get(current_id, [])

            if not incoming:
                # No causes → this is a root cause
                root_causes.append((current_id, confidence, chain))
            else:
                # Traverse causes
                for edge in incoming:
                    if self._edge_applies(edge):
                        # Propagate confidence through edge
                        new_confidence = confidence * edge.weight
                        new_chain = [edge.from_node] + chain
                        queue.append((edge.from_node, new_confidence, new_chain, depth + 1))

        # Sort by confidence descending
        root_causes.sort(key=lambda x: x[1], reverse=True)
        return root_causes

    def _edge_applies(self, edge: CausalEdge) -> bool:
        """Check if edge condition is satisfied."""
        if not edge.condition:
            return True

        # Evaluate condition (simple for now: check if source node fired)
        from_node = self.nodes.get(edge.from_node)
        return from_node is not None and from_node.fired

    def compute_impact_score(self, metric_id: str, visited: Optional[Set[str]] = None) -> int:
        """
        Compute how many downstream metrics this affects (DFS).
        Higher score = more impactful root cause.
        """
        if visited is None:
            visited = set()

        if metric_id in visited or metric_id not in self.nodes:
            return 0

        visited.add(metric_id)
        impact = 1  # Count itself

        # Add all downstream impacts
        for edge in self._outgoing.get(metric_id, []):
            if self._edge_applies(edge):
                impact += self.compute_impact_score(edge.to_node, visited)

        return impact

    def get_related_metrics(self, metric_id: str, relationship_types: Optional[List[RelationshipType]] = None) -> List[str]:
        """Get all metrics related to this one (incoming + outgoing)."""
        related = set()

        for edge in self._incoming.get(metric_id, []) + self._outgoing.get(metric_id, []):
            if relationship_types is None or edge.relationship in relationship_types:
                related.add(edge.from_node)
                related.add(edge.to_node)

        related.discard(metric_id)
        return list(related)

    def explain_relationship(self, from_id: str, to_id: str) -> Optional[str]:
        """Get human-readable explanation of relationship between two metrics."""
        for edge in self._outgoing.get(from_id, []):
            if edge.to_node == to_id:
                return edge.note or f"{from_id} {edge.relationship.value} {to_id}"
        return None

    def to_dict(self) -> dict:
        """Export graph structure for debugging/visualization."""
        return {
            "nodes": [
                {
                    "id": node.id,
                    "value": node.value,
                    "fired": node.fired,
                    "confidence": node.confidence,
                    "category": node.category
                }
                for node in self.nodes.values()
            ],
            "edges": [
                {
                    "from": edge.from_node,
                    "to": edge.to_node,
                    "relationship": edge.relationship.value,
                    "weight": edge.weight,
                    "note": edge.note
                }
                for edge in self.edges
            ]
        }


def build_mongodb_dependency_graph(sig_stats: dict, ranked: list) -> DependencyGraph:
    """
    Build the standard MongoDB dependency graph from scored results.

    This encodes MongoDB-specific knowledge about how metrics interact.
    """
    graph = DependencyGraph()

    # Helper to get stat value
    def stat(key, q="p95"):
        s = sig_stats.get(key)
        if not s:
            return None
        return s.get(q) or s.get("p95") or s.get("max")

    # Helper to add category node
    def add_category(cat_id):
        cat = next((c for c in ranked if c["id"] == cat_id), None)
        if cat:
            node = MetricNode(
                id=cat_id,
                fired=cat.get("fired", False),
                confidence=cat.get("confidence", 0.0),
                evidence=[s["signal"] for s in cat.get("ledger", []) if s.get("passed")],
                category=cat.get("family")
            )
            graph.add_node(node)

    # Helper to add metric node
    def add_metric(metric_id, category="other"):
        val = stat(metric_id)
        node = MetricNode(
            id=metric_id,
            value=val,
            fired=val is not None,
            category=category
        )
        graph.add_node(node)

    # === Add category nodes ===
    for cat in ranked:
        add_category(cat["id"])

    # === Add key metric nodes ===
    key_metrics = [
        ("cache_used_pct", "memory"),
        ("cache_dirty_pct", "memory"),
        ("wt_app_evict_ps", "memory"),
        ("page_faults_ps", "memory"),
        ("cpu_util_pct", "cpu"),
        ("cpu_iowait_pct", "cpu"),
        ("disk_util_pct", "disk"),
        ("disk_avg_write_ms", "disk"),
        ("query_targeting_ratio", "query"),
        ("scan_and_order_ps", "query"),
    ]
    for metric, cat in key_metrics:
        add_metric(metric, cat)

    # === Define causal relationships ===

    # 1. MEMORY → DISK I/O (cache misses drive disk reads)
    cache_used = stat("cache_used_pct")
    eviction = stat("wt_app_evict_ps")
    if cache_used is not None and cache_used > 80:
        graph.add_relationship(
            "memory_cache_pressure", "disk_io_saturation",
            RelationshipType.CAUSES, 0.9,
            note="Cache pressure causes disk I/O due to cache misses"
        )
        graph.add_relationship(
            "cache_used_pct", "disk_util_pct",
            RelationshipType.AMPLIFIES, 0.85,
            note="High cache usage increases disk read frequency"
        )

    if eviction is not None and eviction > 0:
        # App-thread eviction is CRITICAL signal
        graph.add_relationship(
            "wt_app_evict_ps", "memory_cache_pressure",
            RelationshipType.INDICATES, 1.0,
            note="App thread eviction indicates severe memory pressure"
        )

    # 2. MEMORY → CPU (via iowait)
    graph.add_relationship(
        "memory_cache_pressure", "cpu_compute_sizing",
        RelationshipType.AMPLIFIES, 0.7,
        note="Memory pressure increases CPU iowait time"
    )
    graph.add_relationship(
        "disk_io_saturation", "cpu_iowait_pct",
        RelationshipType.CAUSES, 0.9,
        note="Disk I/O causes CPU to wait (iowait)"
    )

    # 3. QUERY INEFFICIENCY → ALL RESOURCES
    query_ratio = stat("query_targeting_ratio")
    scan_and_order = stat("scan_and_order_ps")
    if query_ratio is not None and query_ratio > 100:
        # Inefficient queries amplify everything
        graph.add_relationship(
            "query_targeting_index_recs", "memory_cache_pressure",
            RelationshipType.AMPLIFIES, 0.8,
            note="Poor query targeting increases cache churn"
        )
        graph.add_relationship(
            "query_targeting_index_recs", "cpu_compute_sizing",
            RelationshipType.AMPLIFIES, 0.8,
            note="Collection scans consume CPU"
        )
        graph.add_relationship(
            "query_targeting_index_recs", "disk_io_saturation",
            RelationshipType.AMPLIFIES, 0.9,
            note="Scans drive disk I/O for uncached data"
        )

    if scan_and_order is not None and scan_and_order > 10:
        graph.add_relationship(
            "scan_and_order_ps", "cpu_util_pct",
            RelationshipType.AMPLIFIES, 0.75,
            note="In-memory sorts consume CPU"
        )

    # 4. CHECKPOINT → DISK WRITES
    graph.add_relationship(
        "cache_dirty_pct", "disk_util_pct",
        RelationshipType.AMPLIFIES, 0.7,
        note="Dirty pages drive checkpoint write volume"
    )

    # 5. INDEX BLOAT → MEMORY (conditional on healthcheck)
    # This will be filled in when healthcheck data is available

    # 6. CONNECTION OVERHEAD → MEMORY
    # connections_current * 1MB affects memory

    # 7. REPLICATION LAG → DISK (secondary specific)

    # 8. CPU iowait INDICATES disk/memory issue (not CPU issue)
    graph.add_relationship(
        "cpu_iowait_pct", "disk_io_saturation",
        RelationshipType.INDICATES, 0.9,
        note="High iowait indicates disk bottleneck, not CPU bottleneck"
    )
    graph.add_relationship(
        "cpu_iowait_pct", "memory_cache_pressure",
        RelationshipType.INDICATES, 0.7,
        note="iowait can indicate memory pressure causing disk reads"
    )

    return graph


def explain_root_causes(graph: DependencyGraph, symptom_id: str) -> dict:
    """
    Generate human-readable explanation of root causes for a symptom.

    Returns dict with:
    - root_causes: List of identified root causes with confidence
    - chains: Causal chains from root to symptom
    - impact_scores: How impactful each root cause is
    - recommendation_priority: Which to address first
    """
    root_causes = graph.trace_root_causes(symptom_id)

    if not root_causes:
        return {
            "symptom": symptom_id,
            "root_causes": [],
            "message": "No clear root cause identified (isolated symptom or insufficient data)"
        }

    # Compute impact scores for each root cause
    impacts = []
    for root_id, confidence, chain in root_causes:
        impact = graph.compute_impact_score(root_id)
        impacts.append({
            "root_cause": root_id,
            "confidence": round(confidence, 3),
            "impact_score": impact,
            "causal_chain": " → ".join(chain),
            "priority": round(confidence * impact, 2)  # Combined score
        })

    # Sort by priority
    impacts.sort(key=lambda x: x["priority"], reverse=True)

    # Generate recommendation
    top_cause = impacts[0] if impacts else None
    recommendation = None
    if top_cause and top_cause["priority"] > 0.5:
        recommendation = f"Address '{top_cause['root_cause']}' first (priority {top_cause['priority']:.2f})"

    return {
        "symptom": symptom_id,
        "root_causes": impacts,
        "recommendation": recommendation,
        "analysis": f"Found {len(impacts)} potential root cause(s)"
    }
