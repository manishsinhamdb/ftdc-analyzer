"""Declarative ruleset package for the Layer-2 scorer.

The ruleset is the single source of truth: the scorer reads it, the UI renders it, and
user edits are merged in as an override layer (see overrides.build_ruleset).
"""

from .schema import (
    Category,
    Disambiguator,
    Ruleset,
    Signal,
    FAMILIES,
    INPUTS,
    compare,
)
from .defaults import build_default_ruleset, RULESET_VERSION, CAPACITY_CAVEAT
from .overrides import build_ruleset, load_overrides, apply_overrides

__all__ = [
    "Category",
    "Disambiguator",
    "Ruleset",
    "Signal",
    "FAMILIES",
    "INPUTS",
    "compare",
    "build_default_ruleset",
    "build_ruleset",
    "load_overrides",
    "apply_overrides",
    "RULESET_VERSION",
    "CAPACITY_CAVEAT",
]
