"""rs.status() parser — replication detail (replSetGetStatus).

Parses the full member roster, per-member state/health/optime, term & configVersion, and
derives the MEASURED member-to-member replication lag (primary optime − each secondary optime).
Enriches the `replication_lag_cascade` category: today its lag *cause* is inferred from
co-occurring resource saturation on the single captured member; rs.status() adds the real
member-to-member lag and the true roster (the tool finally sees ALL members, not just the
captured one). Additive — it does NOT change the FTDC-derived score (no ruleset signal wired to
`rs_*`); it attaches measured evidence + an upgraded recommendation, and resolves the
"inferred, not measured" caveat with a measured note. Extended-JSON aware + defensive.
"""

from __future__ import annotations

import json
import os

from ..healthcheck import _num, _x


def _stat(v):
    return {"p50": v, "p95": v, "p99": v, "max": v, "mean": v, "min": v}


def _optime_ms(member: dict):
    """Best-effort member optime as epoch ms (optimeDate preferred)."""
    od = _x(member.get("optimeDate"))
    if isinstance(od, (int, float)):
        return float(od)
    # fall back to optime.ts ($timestamp.t seconds)
    ts = member.get("optime")
    if isinstance(ts, dict):
        t = ts.get("ts")
        if isinstance(t, dict) and isinstance(t.get("$timestamp"), dict):
            sec = _num(t["$timestamp"].get("t"))
            if sec is not None:
                return sec * 1000.0
    return None


def parse(path: str) -> dict:
    with open(os.path.abspath(os.path.expanduser(path))) as fh:
        raw = json.load(fh)
    if not isinstance(raw, dict):
        raise ValueError("rs.status() file is not a JSON object")
    return _build(raw)


def _build(raw: dict) -> dict:
    members = [m for m in (raw.get("members") or []) if isinstance(m, dict)]
    primary = next((m for m in members if _num(m.get("state")) == 1), None)
    primary_ms = _optime_ms(primary) if primary else None

    roster = []
    per_member_lag = {}
    secondaries = arbiters = unhealthy = 0
    max_lag = 0.0
    for m in members:
        state = int(_num(m.get("state")) or -1)
        state_str = m.get("stateStr") or str(state)
        health = _num(m.get("health"))
        if health == 0:
            unhealthy += 1
        lag_s = None
        if state == 2:  # SECONDARY
            secondaries += 1
            ms = _optime_ms(m)
            if primary_ms is not None and ms is not None:
                lag_s = round(max(0.0, (primary_ms - ms) / 1000.0), 1)
                per_member_lag[m.get("name")] = lag_s
                max_lag = max(max_lag, lag_s)
        elif state == 7:  # ARBITER
            arbiters += 1
        roster.append({
            "id": _x(m.get("_id")), "name": m.get("name"), "state": state,
            "state_str": state_str, "health": health, "lag_s": lag_s,
            "uptime": _num(m.get("uptime")), "config_version": _num(m.get("configVersion")),
            "self": bool(m.get("self")),
        })

    data_bearing = sum(1 for r in roster if r["state"] in (1, 2))
    term = _num(raw.get("term"))
    cfgver = _num(primary.get("configVersion")) if primary else None

    scoring_stats = {  # recorded for the report / future use; NOT wired to ruleset signals
        "rs_max_lag_s": _stat(round(max_lag, 1)),
        "rs_member_count": _stat(float(len(members))),
        "rs_secondary_count": _stat(float(secondaries)),
        "rs_arbiter_count": _stat(float(arbiters)),
        "rs_unhealthy_count": _stat(float(unhealthy)),
    }

    # ---- enrich replication_lag_cascade with MEASURED lag + the full roster ----
    if max_lag >= 10:
        verdict = (f"Measured max secondary lag is {max_lag}s across {data_bearing} data-bearing "
                   f"member(s) — lag is REAL (from member optimes, not inferred). Correlate the "
                   f"lagging member with apply-side disk/CPU saturation and write contention.")
    else:
        verdict = (f"Measured max secondary lag is {max_lag}s across {data_bearing} data-bearing "
                   f"member(s) — within tolerance. The full roster is now visible from rs.status().")
    roster_note = (f"rs.status() roster: {data_bearing} data-bearing + {arbiters} arbiter(s); "
                   f"{secondaries} secondary(ies); term {int(term) if term is not None else '—'}.")

    enrichers = {
        "replication_lag_cascade": {
            "recommendation": verdict,
            "evidence": {
                "set": raw.get("set"),
                "measured_max_lag_s": round(max_lag, 1),
                "per_member_lag_s": per_member_lag,
                "data_bearing": data_bearing, "secondaries": secondaries,
                "arbiters": arbiters, "unhealthy": unhealthy,
                "term": int(term) if term is not None else None,
                "config_version": int(cfgver) if cfgver is not None else None,
                "roster": roster,
            },
            "evidence_key": "replication_evidence",
            "caveats": [
                "Replication lag is now MEASURED from member optimes (rs.status()), not inferred "
                "from single-member resource saturation.",
                "rs.status() is a point-in-time snapshot — lag varies; pair with FTDC for the "
                "time-series cause analysis.",
            ],
            "note": roster_note,
            "when_scored_only": False,
        }
    }

    report = {
        "set": raw.get("set"),
        "members": roster,
        "data_bearing": data_bearing, "secondaries": secondaries, "arbiters": arbiters,
        "unhealthy": unhealthy,
        "measured_max_lag_s": round(max_lag, 1),
        "per_member_lag_s": per_member_lag,
        "term": int(term) if term is not None else None,
        "config_version": int(cfgver) if cfgver is not None else None,
        "primary": primary.get("name") if primary else None,
    }

    return {
        "scoring_stats": scoring_stats,
        "report": report,
        "report_key": "replication",
        "enrichers": enrichers,
        "available": True,
        "notes": [],
    }
