"""Evidence-input framework — registry + dispatcher.

The registry (registry.py) is the declarative source of truth for every diagnostic input the
analyzer accepts. The dispatcher routes a set of PROVIDED input paths to their registered
parsers and merges the results into the uniform `DispatchResult` that build_results consumes —
the same `hc_*`-injection pattern healthcheck used, generalized. Adding a new input is a new
registry entry + a parser module; the scorer is never touched.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Set

from . import registry
from .registry import (  # re-export
    REGISTRY,
    Collector,
    EvidenceInput,
    by_id,
    label_for,
    parseable,
    primary_ids,
    registry_to_dict,
)

# Static imports so PyInstaller bundles the parser modules even though the dispatcher resolves
# them dynamically via importlib (PyInstaller does not follow importlib.import_module). The
# registry's `parser` strings still drive dispatch; these imports are purely for packaging.
from . import healthcheck_input as _healthcheck_input  # noqa: F401
from . import sh_status as _sh_status  # noqa: F401
from . import rs_status as _rs_status  # noqa: F401

__all__ = [
    "REGISTRY", "Collector", "EvidenceInput", "by_id", "label_for", "parseable",
    "primary_ids", "registry_to_dict", "dispatch", "DispatchResult", "resolve_parser",
]


def resolve_parser(dotted: str) -> Callable[[str], dict]:
    """Resolve a "package.module:fn" parser reference into a callable."""
    mod_name, fn_name = dotted.split(":")
    mod = importlib.import_module(mod_name)
    return getattr(mod, fn_name)


@dataclass
class DispatchResult:
    sig_stats: Dict[str, dict] = field(default_factory=dict)   # merged scoring stats
    reports: Dict[str, dict] = field(default_factory=dict)     # {report_key: block}
    available: Set[str] = field(default_factory=set)           # input ids that parsed + score
    enrichers: Dict[str, List[dict]] = field(default_factory=dict)  # {cat_id: [spec,...]}
    notes: List[str] = field(default_factory=list)
    parsed: Dict[str, dict] = field(default_factory=dict)      # {input_id: full parser output}
    sizing: Optional[dict] = None                              # healthcheck sizing facts


def dispatch(provided: Dict[str, str], on_error=None) -> DispatchResult:
    """Parse each PROVIDED, parseable evidence input via its registered parser and merge.

    provided: {input_id: path}. Inputs without a registered parser (FTDC, profiler-intake) are
    ignored here — they are handled by the caller. A parser that raises is recorded as a note
    and skipped (a bad evidence file never fails the run)."""
    result = DispatchResult()
    for inp in parseable():
        path = provided.get(inp.id)
        if not path:
            continue
        try:
            fn = resolve_parser(inp.parser)
            out = fn(path)
        except Exception as e:  # noqa: BLE001 — a bad evidence file must not fail the run
            msg = f"{inp.label} could not be parsed ({type(e).__name__}: {e}); skipped."
            result.notes.append(msg)
            if on_error:
                on_error(inp.id, msg)
            continue
        result.sig_stats.update(out.get("scoring_stats") or {})
        rk = out.get("report_key") or inp.id
        if out.get("report") is not None:
            result.reports[rk] = out["report"]
        if out.get("available", True):
            result.available.add(inp.id)
        for cid, spec in (out.get("enrichers") or {}).items():
            result.enrichers.setdefault(cid, []).append(spec)
        if out.get("sizing"):
            result.sizing = out["sizing"]
        result.notes.extend(out.get("notes") or [])
        result.parsed[inp.id] = out
    return result
