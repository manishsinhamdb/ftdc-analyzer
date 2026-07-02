#!/usr/bin/env python3
"""
Test script for enhanced capacity planning analysis.

Tests:
1. Dependency graph construction
2. Root cause tracing
3. Confidence scoring
4. Issue classification
5. Dimension-specific recommendations

Usage:
    python test_enhanced_analysis.py
"""

import json
import sys
from pathlib import Path

# Add ftdc_analyzer to path
sys.path.insert(0, str(Path(__file__).parent))

from ftdc_analyzer.dependency_graph import (
    DependencyGraph, MetricNode, RelationshipType,
    build_mongodb_dependency_graph, explain_root_causes
)
from ftdc_analyzer.confidence_calculator import ConfidenceCalculator, explain_confidence
from ftdc_analyzer.issue_classifier import IssueClassifier, IssueType, ResourceDimension


def test_dependency_graph():
    """Test dependency graph construction and traversal."""
    print("="*60)
    print("TEST 1: Dependency Graph")
    print("="*60)

    graph = DependencyGraph()

    # Add nodes
    graph.add_node(MetricNode(id="memory_pressure", fired=True, confidence=0.9, category="memory"))
    graph.add_node(MetricNode(id="disk_io", fired=True, confidence=0.8, category="disk"))
    graph.add_node(MetricNode(id="cpu_iowait", fired=True, confidence=0.7, category="cpu"))
    graph.add_node(MetricNode(id="cache_eviction", fired=True, confidence=0.95, category="memory"))

    # Add relationships
    graph.add_relationship(
        "cache_eviction", "memory_pressure",
        RelationshipType.INDICATES, 1.0,
        note="Cache eviction indicates memory pressure"
    )
    graph.add_relationship(
        "memory_pressure", "disk_io",
        RelationshipType.CAUSES, 0.9,
        note="Memory pressure causes disk I/O via cache misses"
    )
    graph.add_relationship(
        "disk_io", "cpu_iowait",
        RelationshipType.CAUSES, 0.9,
        note="Disk I/O causes CPU to wait"
    )

    print("\nGraph structure:")
    print(f"  Nodes: {len(graph.nodes)}")
    print(f"  Edges: {len(graph.edges)}")

    # Test root cause tracing
    print("\n  Root causes of 'cpu_iowait':")
    roots = graph.trace_root_causes("cpu_iowait")
    for root_id, confidence, chain in roots:
        print(f"    - {root_id} (confidence: {confidence:.2f})")
        print(f"      Chain: {' → '.join(chain)}")

    # Test impact scoring
    print("\n  Impact scores:")
    for node_id in ["cache_eviction", "memory_pressure", "disk_io"]:
        impact = graph.compute_impact_score(node_id)
        print(f"    - {node_id}: {impact} downstream effects")

    print("\n✅ Dependency graph test passed!\n")


def test_confidence_calculator():
    """Test multi-factor confidence scoring."""
    print("="*60)
    print("TEST 2: Confidence Calculator")
    print("="*60)

    # Mock category data
    category = {
        "id": "memory_cache_pressure",
        "name": "Memory Pressure",
        "confidence": 0.85,
        "fired": True,
        "ledger": [
            {"signal": "cache_used_pct", "passed": True, "weight": 0.8, "value": 95},
            {"signal": "cache_dirty_pct", "passed": True, "weight": 0.6, "value": 6.5},
            {"signal": "wt_app_evict_ps", "passed": True, "weight": 1.0, "value": 5},
        ],
        "conditioned_by": [],
        "cross_references": []
    }

    # Mock sig_stats
    sig_stats = {
        "cache_used_pct": {"p50": 90, "p95": 95, "p99": 98, "max": 99, "mean": 92},
        "cache_dirty_pct": {"p50": 5, "p95": 6.5, "p99": 7, "max": 8, "mean": 5.5},
        "wt_app_evict_ps": {"p50": 2, "p95": 5, "p99": 8, "max": 10, "mean": 3},
    }

    # Mock ranked categories
    ranked = [
        category,
        {"id": "disk_io_saturation", "fired": True, "confidence": 0.75},
        {"id": "cpu_compute_sizing", "fired": True, "confidence": 0.65},
    ]

    data_sources = {"ftdc", "healthcheck"}

    calculator = ConfidenceCalculator()
    score = calculator.calculate(category, sig_stats, ranked, data_sources)

    print(f"\n{explain_confidence(score)}")

    assert score.overall >= 0.85, f"Expected confidence >= 0.85, got {score.overall}"
    assert score.grade in ("high", "very_high"), f"Expected high/very_high grade, got {score.grade}"

    print("\n✅ Confidence calculator test passed!\n")


def test_issue_classifier():
    """Test issue classification and recommendations."""
    print("="*60)
    print("TEST 3: Issue Classifier")
    print("="*60)

    # Test Case 1: Clear capacity limit (memory pressure)
    print("\n[Case 1: Memory Capacity Limit]")
    sig_stats = {
        "cache_used_pct": {"p95": 95},
        "wt_app_evict_ps": {"max": 5},
        "cpu_util_pct": {"p95": 45},
        "cpu_iowait_pct": {"p99": 15},
        "query_targeting_ratio": {"p95": 5},
    }
    ranked = [
        {"id": "memory_cache_pressure", "fired": True, "confidence": 0.92, "status": "scored", "family": "capacity"},
        {"id": "cpu_compute_sizing", "fired": False, "confidence": 0.0, "status": "scored", "family": "capacity"},
    ]

    classifier = IssueClassifier()
    result = classifier.classify(sig_stats, ranked, None)

    print(f"  Issue Type: {result.issue_type.value}")
    print(f"  Primary Dimension: {result.primary_dimension.value}")
    print(f"  Confidence: {result.confidence:.1%}")
    print(f"  Recommendations: {len(result.recommendations)}")
    for rec in result.recommendations:
        print(f"    - {rec.dimension.value}: {rec.action} (confidence: {rec.confidence:.1%})")
        print(f"      {rec.rationale}")

    assert result.issue_type == IssueType.CAPACITY_LIMIT
    assert result.primary_dimension == ResourceDimension.RAM

    # Test Case 2: Workload inefficiency
    print("\n[Case 2: Workload Inefficiency]")
    sig_stats = {
        "cache_used_pct": {"p95": 65},
        "wt_app_evict_ps": {"max": 0},
        "cpu_util_pct": {"p95": 55},
        "query_targeting_ratio": {"p95": 150},
        "scan_and_order_ps": {"p95": 25},
    }
    ranked = [
        {"id": "query_targeting_index_recs", "fired": True, "confidence": 0.94, "status": "scored", "family": "workload"},
        {"id": "memory_cache_pressure", "fired": False, "confidence": 0.0, "status": "scored", "family": "capacity"},
    ]

    result = classifier.classify(sig_stats, ranked, None)

    print(f"  Issue Type: {result.issue_type.value}")
    print(f"  Recommendations: {len(result.recommendations)}")
    for rec in result.recommendations:
        print(f"    - Action: {rec.action}")
        print(f"      Steps: {len(rec.steps)} steps")

    assert result.issue_type == IssueType.WORKLOAD_INEFFICIENCY
    assert result.recommendations[0].action == "remediate"

    # Test Case 3: Well-provisioned
    print("\n[Case 3: Well-Provisioned]")
    sig_stats = {
        "cache_used_pct": {"p95": 70},
        "cpu_util_pct": {"p95": 50},
        "disk_util_pct": {"p95": 45},
    }
    ranked = []  # No fired categories

    result = classifier.classify(sig_stats, ranked, None)

    print(f"  Issue Type: {result.issue_type.value}")
    print(f"  Confidence: {result.confidence:.1%}")

    assert result.issue_type == IssueType.WELL_PROVISIONED
    assert result.confidence >= 0.90

    print("\n✅ Issue classifier test passed!\n")


def test_mongodb_dependency_graph():
    """Test MongoDB-specific dependency graph building."""
    print("="*60)
    print("TEST 4: MongoDB Dependency Graph")
    print("="*60)

    sig_stats = {
        "cache_used_pct": {"p95": 95},
        "wt_app_evict_ps": {"max": 5},
        "disk_util_pct": {"p95": 85},
        "cpu_iowait_pct": {"p99": 20},
        "query_targeting_ratio": {"p95": 120},
    }

    ranked = [
        {"id": "memory_cache_pressure", "fired": True, "confidence": 0.9, "status": "scored",
         "family": "capacity", "ledger": []},
        {"id": "disk_io_saturation", "fired": True, "confidence": 0.8, "status": "scored",
         "family": "capacity", "ledger": []},
        {"id": "query_targeting_index_recs", "fired": True, "confidence": 0.85, "status": "scored",
         "family": "workload", "ledger": []},
    ]

    graph = build_mongodb_dependency_graph(sig_stats, ranked)

    print(f"\n  MongoDB Graph:")
    print(f"    Nodes: {len(graph.nodes)}")
    print(f"    Edges: {len(graph.edges)}")

    # Test explanations
    for cat_id in ["disk_io_saturation", "cpu_compute_sizing"]:
        if cat_id in graph.nodes:
            print(f"\n  Root cause analysis for '{cat_id}':")
            analysis = explain_root_causes(graph, cat_id)
            if analysis.get("root_causes"):
                for rc in analysis["root_causes"][:3]:  # Top 3
                    print(f"    - {rc['root_cause']} (priority: {rc['priority']})")
                    print(f"      Chain: {rc['causal_chain']}")

    print("\n✅ MongoDB dependency graph test passed!\n")


def test_integration():
    """Test full integration of all modules."""
    print("="*60)
    print("TEST 5: Full Integration")
    print("="*60)

    # Simulate a complete scenario
    sig_stats = {
        "cache_used_pct": {"p50": 88, "p95": 95, "p99": 98, "max": 99, "mean": 90},
        "cache_dirty_pct": {"p50": 5, "p95": 6.5, "p99": 7, "max": 8, "mean": 5.5},
        "wt_app_evict_ps": {"p50": 2, "p95": 5, "p99": 8, "max": 10, "mean": 3},
        "disk_util_pct": {"p50": 70, "p95": 85, "p99": 92, "max": 95, "mean": 75},
        "cpu_util_pct": {"p50": 40, "p95": 55, "p99": 65, "max": 75, "mean": 45},
        "cpu_iowait_pct": {"p50": 5, "p95": 12, "p99": 20, "max": 25, "mean": 8},
        "query_targeting_ratio": {"p50": 8, "p95": 15, "p99": 25, "max": 30, "mean": 12},
    }

    ranked = [
        {
            "id": "memory_cache_pressure",
            "name": "Memory Cache Pressure",
            "fired": True,
            "confidence": 0.92,
            "status": "scored",
            "family": "capacity",
            "ledger": [
                {"signal": "cache_used_pct", "passed": True, "weight": 0.8},
                {"signal": "wt_app_evict_ps", "passed": True, "weight": 1.0},
            ],
            "conditioned_by": [],
            "cross_references": []
        },
        {
            "id": "disk_io_saturation",
            "name": "Disk I/O Saturation",
            "fired": True,
            "confidence": 0.85,
            "status": "scored",
            "family": "capacity",
            "ledger": [
                {"signal": "disk_util_pct", "passed": True, "weight": 0.9},
            ],
            "conditioned_by": [],
            "cross_references": []
        },
    ]

    print("\n[Step 1: Build Dependency Graph]")
    graph = build_mongodb_dependency_graph(sig_stats, ranked)
    print(f"  ✓ Built graph with {len(graph.nodes)} nodes, {len(graph.edges)} edges")

    print("\n[Step 2: Calculate Confidence Scores]")
    calculator = ConfidenceCalculator()
    for cat in ranked:
        score = calculator.calculate(cat, sig_stats, ranked, {"ftdc", "healthcheck"}, graph)
        print(f"  ✓ {cat['name']}: {score.overall:.1%} confidence ({score.grade})")

    print("\n[Step 3: Classify Issue]")
    classifier = IssueClassifier()
    classification = classifier.classify(sig_stats, ranked, None, graph)
    print(f"  ✓ Issue Type: {classification.issue_type.value}")
    print(f"  ✓ Primary Dimension: {classification.primary_dimension.value}")
    print(f"  ✓ Confidence: {classification.confidence:.1%}")
    print(f"  ✓ Recommendations: {len(classification.recommendations)}")

    print("\n[Step 4: Generate Report]")
    report = {
        "assessment_summary": {
            "issue_type": classification.issue_type.value,
            "primary_dimension": classification.primary_dimension.value,
            "confidence": round(classification.confidence, 3),
        },
        "root_causes": classification.root_causes,
        "recommendations": [r.to_dict() for r in classification.recommendations],
    }
    print(f"  ✓ Generated comprehensive report")
    print(json.dumps(report, indent=2))

    print("\n✅ Full integration test passed!\n")


def main():
    """Run all tests."""
    print("\n" + "="*60)
    print("ENHANCED CAPACITY PLANNING - TEST SUITE")
    print("="*60 + "\n")

    tests = [
        ("Dependency Graph", test_dependency_graph),
        ("Confidence Calculator", test_confidence_calculator),
        ("Issue Classifier", test_issue_classifier),
        ("MongoDB Dependency Graph", test_mongodb_dependency_graph),
        ("Full Integration", test_integration),
    ]

    passed = 0
    failed = 0

    for name, test_func in tests:
        try:
            test_func()
            passed += 1
        except Exception as e:
            print(f"\n❌ Test '{name}' FAILED:")
            print(f"   {str(e)}\n")
            import traceback
            traceback.print_exc()
            failed += 1

    print("\n" + "="*60)
    print(f"TEST RESULTS: {passed} passed, {failed} failed")
    print("="*60 + "\n")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
