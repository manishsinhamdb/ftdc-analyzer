"""Override layer — user edits applied over the typed defaults at score time.

The Python ruleset ships the typed defaults; the app writes user overrides to a known
JSON path; the engine loads defaults then merges overrides on top before scoring. This
lets an operator re-tune the scorer (weights, thresholds, signals, caveats, toggles)
without editing Python.

Override JSON shape (all keys optional)::

    {
      "version": 1,
      "categories": {
        "<category_id>": {
          "enabled": true,
          "recommendation": "…",
          "caveats": ["…"],
          "fire_threshold": 0.5,
          "signals": {                       # edit existing signals by metric_path
            "cache_used_pct": { "weight": 0.5, "threshold": 75, "direction": "+",
                                 "comparator": ">", "stat": "p95", "interpretation": "…" }
          },
          "added_signals": [ { "metric_path": "…", "weight": 0.2, ... } ],
          "removed_signals": ["page_faults_ps"]
        }
      }
    }

Merge order: typed defaults  →  category-level fields  →  per-signal edits  →
added_signals  →  removed_signals. Unknown category ids / metric paths are ignored
(non-fatal) so a stale override never breaks scoring.
"""

from __future__ import annotations

import json
import os
from dataclasses import replace
from typing import Optional

from .defaults import build_default_ruleset
from .schema import Category, Disambiguator, Intent, IntentCategory, Ruleset, Signal

_SIGNAL_FIELDS = {"metric_path", "weight", "direction", "comparator", "threshold",
                  "stat", "interpretation", "status", "unit"}


def load_overrides(path: Optional[str]) -> dict:
    """Read the overrides JSON; returns {} if no path / missing / unreadable."""
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _signal_from_dict(d: dict) -> Optional[Signal]:
    if not isinstance(d, dict) or not d.get("metric_path"):
        return None
    kw = {k: v for k, v in d.items() if k in _SIGNAL_FIELDS}
    dis = d.get("disambiguator")
    sig = Signal(**kw)
    if isinstance(dis, dict) and dis.get("co_signal"):
        sig.disambiguator = Disambiguator(
            co_signal=dis["co_signal"],
            comparator=dis.get("comparator", ">"),
            value=float(dis.get("value", 0)),
            effect=dis.get("effect", "enable"),
            scale=float(dis.get("scale", 1.0)),
            note=dis.get("note", ""),
        )
    return sig


def _apply_category(cat: Category, ov: dict) -> Category:
    if "enabled" in ov:
        cat.enabled = bool(ov["enabled"])
    if "recommendation" in ov and isinstance(ov["recommendation"], str):
        cat.recommendation = ov["recommendation"]
    if "caveats" in ov and isinstance(ov["caveats"], list):
        cat.caveats = [str(c) for c in ov["caveats"]]
    if "fire_threshold" in ov:
        try:
            cat.fire_threshold = float(ov["fire_threshold"])
        except (TypeError, ValueError):
            pass

    # Per-signal edits by metric_path.
    sig_edits = ov.get("signals") or {}
    if isinstance(sig_edits, dict):
        for s in cat.signals:
            edit = sig_edits.get(s.metric_path)
            if not isinstance(edit, dict):
                continue
            for k in ("weight", "threshold", "scale"):
                if k in edit:
                    try:
                        setattr(s, k if k != "scale" else "weight",
                                float(edit[k]) if k != "scale" else s.weight)
                    except (TypeError, ValueError):
                        pass
            if "weight" in edit:
                try:
                    s.weight = float(edit["weight"])
                except (TypeError, ValueError):
                    pass
            if "threshold" in edit:
                try:
                    s.threshold = float(edit["threshold"])
                except (TypeError, ValueError):
                    pass
            for k in ("direction", "comparator", "stat", "interpretation"):
                if k in edit and isinstance(edit[k], str):
                    setattr(s, k, edit[k])

    # Added signals.
    for d in ov.get("added_signals") or []:
        sig = _signal_from_dict(d)
        if sig:
            cat.signals.append(sig)

    # Removed signals (by metric_path).
    removed = set(ov.get("removed_signals") or [])
    if removed:
        cat.signals = [s for s in cat.signals if s.metric_path not in removed]

    return cat


def _apply_intent(intent: Intent, ov: dict) -> Intent:
    for k in ("title", "subtitle", "description", "note"):
        if k in ov and isinstance(ov[k], str):
            setattr(intent, k, ov[k])
    if "full_sweep" in ov:
        intent.full_sweep = bool(ov["full_sweep"])
    cats = ov.get("categories")
    if isinstance(cats, list):
        rebuilt = []
        for c in cats:
            if isinstance(c, dict) and c.get("category_id"):
                try:
                    lean = float(c.get("lean", 1.0))
                except (TypeError, ValueError):
                    lean = 1.0
                rebuilt.append(IntentCategory(category_id=c["category_id"], lean=lean))
            elif isinstance(c, str):
                rebuilt.append(IntentCategory(category_id=c))
        intent.categories = rebuilt
    return intent


def apply_overrides(ruleset: Ruleset, overrides: dict) -> Ruleset:
    overrides = overrides or {}
    cat_ovs = overrides.get("categories") or {}
    if isinstance(cat_ovs, dict):
        for cat in ruleset.categories:
            ov = cat_ovs.get(cat.id)
            if isinstance(ov, dict):
                _apply_category(cat, ov)
    intent_ovs = overrides.get("intents") or {}
    if isinstance(intent_ovs, dict):
        for intent in ruleset.intents:
            ov = intent_ovs.get(intent.id)
            if isinstance(ov, dict):
                _apply_intent(intent, ov)
    return ruleset


def build_ruleset(overrides_path: Optional[str] = None) -> Ruleset:
    """Defaults merged with overrides from `overrides_path` (env fallback handled by caller)."""
    rs = build_default_ruleset()  # fresh typed instance (safe to mutate)
    ov = load_overrides(overrides_path)
    if ov:
        apply_overrides(rs, ov)
    return rs


# `replace` imported to keep dataclass-immutability option open for future use.
_ = replace
