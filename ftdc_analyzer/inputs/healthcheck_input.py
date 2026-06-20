"""Healthcheck adapter — wraps the existing ftdc_analyzer.healthcheck parser into the uniform
parsed shape consumed by inputs.dispatch(). This is how the (pre-Phase-9) healthcheck wiring
now flows THROUGH the registry without changing behavior: the dispatcher merges the same
scoring_stats, stores the same report block, applies the same structural enrichment, and feeds
the same sizing facts as before. The enricher specs reproduce `_enrich_structural` exactly
(evidence_key="healthcheck_evidence", recommendation_flag="recommendation_healthcheck",
when_scored_only=True), so results are byte-identical.
"""

from __future__ import annotations

from .. import healthcheck as _healthcheck


def parse(path: str) -> dict:
    hc = _healthcheck.parse_healthcheck(path)
    enrichers = {}
    for cid, spec in (hc.get("structural") or {}).items():
        enrichers[cid] = {
            "recommendation": spec.get("recommendation"),
            "evidence": spec.get("evidence"),
            "evidence_key": "healthcheck_evidence",
            "recommendation_flag": "recommendation_healthcheck",
            "caveats": spec.get("caveats", []),
            "when_scored_only": True,  # match the original _enrich_structural (scored-only)
        }
    return {
        "scoring_stats": hc.get("scoring_stats") or {},
        "report": hc.get("report"),
        "report_key": "healthcheck",
        "enrichers": enrichers,
        "available": True,
        "sizing": hc.get("sizing"),
        "notes": hc.get("notes") or [],
        "_raw": hc,  # full parse kept for host facts (hc-only mode) + sharding-context topology
    }
