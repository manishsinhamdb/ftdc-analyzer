"""Declarative ruleset schema — the single source of truth for the Layer-2 scorer.

Typed dataclasses describing scoring *categories*, their evidence *signals*, optional
*disambiguators* (co-signal rules that flip a signal's meaning), caveats, and the
cross-category *conditioning* that arbitrates final recommendations. The scorer reads
this; the UI renders it; user edits are applied as an override layer (see overrides.py).

Designed to be read and edited by a non-author: every field is plain data, families are
plain strings, and `to_dict()` emits stable JSON for the engine output and the UI.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

# Category families (grouping for the methodology panel).
FAMILIES = [
    "Capacity",
    "Incident-RCA",
    "Cluster-Context",
    "Structural-Design",
    "Query-Optimization",
    "Cross-Cutting",
]

# Data sources a category can require.
INPUTS = ["ftdc", "healthcheck", "profiler"]

# Valid comparators for thresholds / disambiguators.
COMPARATORS = [">", ">=", "<", "<=", "==", "!="]


def compare(value: float, comparator: str, threshold: float) -> bool:
    """Deterministic numeric comparison used by both signals and disambiguators."""
    if value is None:
        return False
    if comparator == ">":
        return value > threshold
    if comparator == ">=":
        return value >= threshold
    if comparator == "<":
        return value < threshold
    if comparator == "<=":
        return value <= threshold
    if comparator == "==":
        return value == threshold
    if comparator == "!=":
        return value != threshold
    return False


@dataclass
class Disambiguator:
    """A co-signal rule that changes whether/how a signal contributes.

    effect:
      - "enable"   : the signal contributes ONLY IF the co-signal passes (else suppressed).
      - "suppress" : the signal is suppressed IF the co-signal passes.
      - "scale"    : the signal's contribution is multiplied by `scale` IF the co-signal passes.
    """

    co_signal: str
    comparator: str
    value: float
    effect: str = "enable"          # enable | suppress | scale
    scale: float = 1.0              # used when effect == "scale"
    note: str = ""                  # plain-English explanation for the panel

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Signal:
    """One piece of weighted evidence for a category."""

    metric_path: str                # derived signal key, e.g. "cache_used_pct"
    weight: float                   # contribution weight (relative; not required to sum to 1)
    direction: str = "+"            # "+" raises confidence (worse), "-" lowers it (mitigates)
    comparator: str = ">"           # how `threshold` is applied
    threshold: float = 0.0
    stat: str = "p95"               # which summary stat to read: p50|p95|p99|max|mean
    interpretation: str = ""        # plain-English meaning when it fires
    disambiguator: Optional[Disambiguator] = None
    status: str = "active"          # active | stub
    unit: str = ""                  # display hint for the panel (optional)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["disambiguator"] = self.disambiguator.to_dict() if self.disambiguator else None
        return d


@dataclass
class Category:
    """A scoring category — a family of evidence that produces one ranked finding."""

    id: str
    name: str
    family: str
    description: str
    required_inputs: List[str] = field(default_factory=lambda: ["ftdc"])
    signals: List[Signal] = field(default_factory=list)
    caveats: List[str] = field(default_factory=list)
    recommendation: str = ""
    conditioned_by: List[str] = field(default_factory=list)
    conditional_recommendations: Dict[str, str] = field(default_factory=dict)
    status: str = "active"          # active | stub  (stub = declared, not yet deep)
    enabled: bool = True            # toggled off by an override → skipped
    fire_threshold: float = 0.5     # confidence ≥ this ⇒ category "fired" (drives conditioning)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "family": self.family,
            "description": self.description,
            "required_inputs": list(self.required_inputs),
            "signals": [s.to_dict() for s in self.signals],
            "caveats": list(self.caveats),
            "recommendation": self.recommendation,
            "conditioned_by": list(self.conditioned_by),
            "conditional_recommendations": dict(self.conditional_recommendations),
            "status": self.status,
            "enabled": self.enabled,
            "fire_threshold": self.fire_threshold,
        }


@dataclass
class IntentCategory:
    """A category's membership in an intent lens: ordering (list position) + lean."""

    category_id: str
    lean: float = 1.0  # surfacing/ordering emphasis (NOT applied to raw confidence)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Intent:
    """A curated lens over the existing categories — selects/orders/weights which of
    them surface for an audience-facing question. Does NOT replace categories."""

    id: str
    title: str
    subtitle: str
    description: str = ""
    categories: List[IntentCategory] = field(default_factory=list)  # ordered lens
    full_sweep: bool = False  # include all categories ranked by confidence
    note: str = ""            # e.g. "requires the profiler log"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "subtitle": self.subtitle,
            "description": self.description,
            "categories": [c.to_dict() for c in self.categories],
            "full_sweep": self.full_sweep,
            "note": self.note,
        }


@dataclass
class Ruleset:
    version: int
    categories: List[Category] = field(default_factory=list)
    intents: List[Intent] = field(default_factory=list)

    def by_id(self, cid: str) -> Optional[Category]:
        for c in self.categories:
            if c.id == cid:
                return c
        return None

    def intent_by_id(self, iid: str) -> Optional[Intent]:
        for i in self.intents:
            if i.id == iid:
                return i
        return None

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "families": FAMILIES,
            "inputs": INPUTS,
            "categories": [c.to_dict() for c in self.categories],
            "intents": [i.to_dict() for i in self.intents],
        }
