"""Multi-factor confidence scoring for provisioning recommendations.

Target: 9.5-9.9 (0.95-0.99) confidence score based on:
1. Signal strength (how many strong signals fired)
2. Cross-validation (do related metrics confirm?)
3. Data completeness (FTDC + healthcheck + profiler)
4. Temporal stability (sustained issue vs spike)
5. Root cause clarity (single clear cause vs multi-factor ambiguity)

Mathematical approach with transparent confidence breakdowns.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple
from dataclasses import dataclass


@dataclass
class ConfidenceFactor:
    """Individual factor contributing to overall confidence."""
    name: str
    value: float  # 0.0-1.0
    weight: float  # Contribution weight
    contribution: float  # value * weight
    explanation: str


@dataclass
class ConfidenceScore:
    """Complete confidence score with breakdown."""
    overall: float  # 0.0-0.99
    factors: List[ConfidenceFactor]
    penalties: List[Tuple[str, float]]  # (reason, multiplier)
    grade: str  # "very_high" | "high" | "medium" | "low"

    def to_dict(self) -> dict:
        return {
            "overall": round(self.overall, 3),
            "grade": self.grade,
            "factors": [
                {
                    "name": f.name,
                    "value": round(f.value, 2),
                    "weight": round(f.weight, 2),
                    "contribution": round(f.contribution, 3),
                    "explanation": f.explanation
                }
                for f in self.factors
            ],
            "penalties": [
                {"reason": reason, "multiplier": round(mult, 2)}
                for reason, mult in self.penalties
            ]
        }


class ConfidenceCalculator:
    """
    Calculates confidence scores using multi-factor analysis.

    Factors:
    1. Signal Strength (30%): How many strong signals fired
    2. Cross-Validation (25%): Confirmation from related categories
    3. Data Completeness (20%): Available data sources
    4. Temporal Stability (15%): Sustained vs spike
    5. Root Cause Clarity (10%): Single cause vs multi-factor

    Penalties applied for:
    - Contradictory signals
    - Missing critical data
    - Insufficient time series length
    """

    # Factor weights (must sum to 1.0)
    WEIGHTS = {
        "signal_strength": 0.30,
        "cross_validation": 0.25,
        "data_completeness": 0.20,
        "temporal_stability": 0.15,
        "root_cause_clarity": 0.10,
    }

    def calculate(self, category: dict, sig_stats: dict, ranked: list,
                  data_sources: Set[str], dependency_graph=None) -> ConfidenceScore:
        """
        Calculate confidence score for a category's verdict/recommendation.

        Args:
            category: Scored category dict from assessment_v2
            sig_stats: Signal statistics {metric_path: {p50, p95, p99, max, mean}}
            ranked: All categories from assessment_v2 (for cross-validation)
            data_sources: Set of available inputs ("ftdc", "healthcheck", "profiler")
            dependency_graph: Optional DependencyGraph for root cause analysis

        Returns:
            ConfidenceScore with breakdown
        """
        factors = []
        penalties = []

        # Factor 1: Signal Strength
        signal_factor = self._signal_strength(category)
        factors.append(ConfidenceFactor(
            name="signal_strength",
            value=signal_factor,
            weight=self.WEIGHTS["signal_strength"],
            contribution=signal_factor * self.WEIGHTS["signal_strength"],
            explanation=f"Based on {len([s for s in category.get('ledger', []) if s.get('passed')])} fired signals"
        ))

        # Factor 2: Cross-Validation
        cross_val_factor = self._cross_validation(category, ranked, sig_stats)
        factors.append(ConfidenceFactor(
            name="cross_validation",
            value=cross_val_factor,
            weight=self.WEIGHTS["cross_validation"],
            contribution=cross_val_factor * self.WEIGHTS["cross_validation"],
            explanation="Confirmation from related categories"
        ))

        # Factor 3: Data Completeness
        data_factor = self._data_completeness(category, data_sources)
        factors.append(ConfidenceFactor(
            name="data_completeness",
            value=data_factor,
            weight=self.WEIGHTS["data_completeness"],
            contribution=data_factor * self.WEIGHTS["data_completeness"],
            explanation=f"Available: {', '.join(sorted(data_sources))}"
        ))

        # Factor 4: Temporal Stability
        temporal_factor = self._temporal_stability(category, sig_stats)
        factors.append(ConfidenceFactor(
            name="temporal_stability",
            value=temporal_factor,
            weight=self.WEIGHTS["temporal_stability"],
            contribution=temporal_factor * self.WEIGHTS["temporal_stability"],
            explanation="Issue persistence (p95 vs max)"
        ))

        # Factor 5: Root Cause Clarity
        root_cause_factor = self._root_cause_clarity(category, ranked, dependency_graph)
        factors.append(ConfidenceFactor(
            name="root_cause_clarity",
            value=root_cause_factor,
            weight=self.WEIGHTS["root_cause_clarity"],
            contribution=root_cause_factor * self.WEIGHTS["root_cause_clarity"],
            explanation="Clarity of causal chain"
        ))

        # Compute base confidence (weighted sum)
        base_confidence = sum(f.contribution for f in factors)

        # Apply penalties
        if self._has_contradictory_signals(category):
            penalties.append(("Contradictory signals detected", 0.70))

        if self._missing_critical_data(category, data_sources):
            penalties.append(("Missing critical data source", 0.85))

        if self._insufficient_time_series(sig_stats):
            penalties.append(("Insufficient time series data", 0.90))

        # Apply penalties
        final_confidence = base_confidence
        for reason, multiplier in penalties:
            final_confidence *= multiplier

        # Cap at 0.99 (never 100% certain)
        final_confidence = min(final_confidence, 0.99)

        # Grade
        if final_confidence >= 0.90:
            grade = "very_high"
        elif final_confidence >= 0.80:
            grade = "high"
        elif final_confidence >= 0.65:
            grade = "medium"
        else:
            grade = "low"

        return ConfidenceScore(
            overall=final_confidence,
            factors=factors,
            penalties=penalties,
            grade=grade
        )

    def _signal_strength(self, category: dict) -> float:
        """
        Factor 1: How many strong signals fired?

        Strong signal = weight > 0.5 and passed
        Target: 3+ strong signals = 1.0
        """
        ledger = category.get("ledger", [])
        strong_signals = [
            s for s in ledger
            if s.get("passed") and s.get("weight", 0) >= 0.5
        ]

        count = len(strong_signals)
        if count >= 3:
            return 1.0
        elif count == 2:
            return 0.75
        elif count == 1:
            return 0.50
        else:
            return 0.25

    def _cross_validation(self, category: dict, ranked: list, sig_stats: dict) -> float:
        """
        Factor 2: Do related categories confirm this diagnosis?

        Checks:
        - Conditioned categories (if they fired too)
        - Same-family categories
        - Logical dependencies (e.g., memory pressure + disk I/O)
        """
        cat_id = category.get("id")
        confirmations = 0
        total_checks = 0

        # Check conditioned_by relationships
        for cond_id in category.get("conditioned_by", []):
            total_checks += 1
            cond_cat = next((c for c in ranked if c["id"] == cond_id), None)
            if cond_cat and cond_cat.get("fired"):
                confirmations += 1

        # Check cross_references (already computed in Pass 2)
        for xref in category.get("cross_references", []):
            if xref.get("effect") in ("recommendation_swapped", "noted"):
                confirmations += 1
                total_checks += 1

        # Known logical dependencies
        logical_deps = {
            "memory_cache_pressure": ["disk_io_saturation", "cpu_compute_sizing"],
            "disk_io_saturation": ["cpu_compute_sizing"],
            "query_targeting_index_recs": ["memory_cache_pressure", "cpu_compute_sizing", "disk_io_saturation"],
        }

        if cat_id in logical_deps:
            for dep_id in logical_deps[cat_id]:
                total_checks += 1
                dep_cat = next((c for c in ranked if c["id"] == dep_id), None)
                if dep_cat and dep_cat.get("fired"):
                    confirmations += 1

        # Calculate factor
        if total_checks == 0:
            return 0.6  # No cross-checks available (neutral)
        elif confirmations >= 2:
            return 1.0  # Strong confirmation
        elif confirmations == 1:
            return 0.75
        else:
            return 0.4  # No confirmation (reduces confidence)

    def _data_completeness(self, category: dict, data_sources: Set[str]) -> float:
        """
        Factor 3: What data sources are available?

        Base: 0.6 (FTDC only)
        +0.2 if healthcheck available
        +0.2 if profiler available
        """
        base = 0.6  # FTDC always available

        if "healthcheck" in data_sources:
            base += 0.2

        if "profiler" in data_sources:
            base += 0.2

        return min(base, 1.0)

    def _temporal_stability(self, category: dict, sig_stats: dict) -> float:
        """
        Factor 4: Is this a sustained issue or a spike?

        Sustained issue (p95 ≈ max) = high confidence
        Spike issue (p95 << max) = lower confidence

        For each signal in ledger, compute p95/max ratio.
        Average across all signals.
        """
        ledger = category.get("ledger", [])
        ratios = []

        for signal in ledger:
            if not signal.get("passed"):
                continue

            metric_path = signal.get("signal")
            stats = sig_stats.get(metric_path)

            if stats:
                p95 = stats.get("p95")
                max_val = stats.get("max")

                if p95 is not None and max_val is not None and max_val > 0:
                    ratio = p95 / max_val
                    ratios.append(ratio)

        if not ratios:
            return 0.5  # Unknown stability

        avg_ratio = sum(ratios) / len(ratios)

        # High ratio (p95 close to max) = sustained = high confidence
        # Low ratio (p95 << max) = spikey = lower confidence
        if avg_ratio >= 0.85:
            return 1.0  # Very sustained
        elif avg_ratio >= 0.70:
            return 0.85
        elif avg_ratio >= 0.50:
            return 0.65
        else:
            return 0.40  # Very spikey

    def _root_cause_clarity(self, category: dict, ranked: list,
                           dependency_graph=None) -> float:
        """
        Factor 5: Can we identify a clear root cause?

        Single root cause = high clarity = high confidence
        Multi-factor ambiguous = low clarity = lower confidence

        Uses dependency graph if available, otherwise heuristics.
        """
        if dependency_graph:
            # Use graph to trace root causes
            cat_id = category.get("id")
            root_causes = dependency_graph.trace_root_causes(cat_id)

            if len(root_causes) == 0:
                return 0.50  # No clear cause (isolated symptom)
            elif len(root_causes) == 1:
                return 0.95  # Single clear root cause
            elif len(root_causes) == 2:
                return 0.75  # Two contributing factors
            else:
                return 0.50  # Complex multi-factor

        # Fallback: heuristics based on cross_references
        xrefs = category.get("cross_references", [])
        if len(xrefs) == 0:
            return 0.60  # No conditioning (could be root or isolated)
        elif len(xrefs) == 1:
            return 0.80  # One clear conditioning factor
        else:
            return 0.60  # Multiple factors

    def _has_contradictory_signals(self, category: dict) -> bool:
        """
        Check if signals contradict each other.

        Example: cache_used_pct high but no eviction
        """
        ledger = category.get("ledger", [])

        # TODO: Implement contradiction detection logic
        # For now, return False (no contradictions)
        return False

    def _missing_critical_data(self, category: dict, data_sources: Set[str]) -> bool:
        """
        Check if critical data source is missing for this category.

        Structural categories need healthcheck.
        Query efficiency needs profiler.
        """
        cat_id = category.get("id")

        # Structural categories require healthcheck
        structural_cats = {
            "index_redundancy_structural",
            "index_usage_structural",
            "schema_antipatterns_structural"
        }
        if cat_id in structural_cats and "healthcheck" not in data_sources:
            return True

        # Query targeting requires profiler for high confidence
        if cat_id == "query_targeting_index_recs" and "profiler" not in data_sources:
            return True

        return False

    def _insufficient_time_series(self, sig_stats: dict) -> bool:
        """
        Check if time series is too short for reliable percentiles.

        TODO: Add logic to check number of data points
        """
        # For now, assume FTDC is sufficient
        return False


def explain_confidence(confidence_score: ConfidenceScore) -> str:
    """
    Generate human-readable explanation of confidence score.
    """
    lines = [
        f"Overall Confidence: {confidence_score.overall:.1%} ({confidence_score.grade})",
        "",
        "Contributing Factors:"
    ]

    for factor in confidence_score.factors:
        pct = factor.value * 100
        lines.append(f"  • {factor.name}: {pct:.0f}% — {factor.explanation}")

    if confidence_score.penalties:
        lines.append("")
        lines.append("Penalties Applied:")
        for reason, mult in confidence_score.penalties:
            lines.append(f"  • {reason} (×{mult:.2f})")

    return "\n".join(lines)
