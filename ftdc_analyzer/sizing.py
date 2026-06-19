"""Sizing Recommendation engine — infers current infra from the scored capacity
categories and maps it to confidence-scored Atlas-tier options.

Reads the bundled, dated tier tables (ftdc_analyzer/tier_tables/*.json), applies the same
override layer as the ruleset, and produces a `sizing_recommendation` block: current
inferred infra → three options (General downsize / Low-CPU R-tier / Provisioned IOPS) with
confidences drawn from the capacity-category scores → a recommended option chosen from the
evidence pattern → honest data-gap + workload-efficiency conditioning caveats.

ADDITIVE: never fabricates a storage/tier number it cannot derive — emits an explicit
"insufficient information: provide <input>" instead.
"""

from __future__ import annotations

import json
import math
import os

CLOUDS = ["aws", "gcp", "azure"]
SIZING_INTENTS = {"right_sizing", "cost_optimization"}

try:
    from importlib import resources as _res
except ImportError:  # pragma: no cover
    _res = None


# ---------------------------------------------------------------------------
# Tier-table loading (+ override merge), works in dev and PyInstaller bundles
# ---------------------------------------------------------------------------
def _read_table(cloud: str):
    if _res is not None:
        try:
            f = _res.files("ftdc_analyzer.tier_tables").joinpath(f"{cloud}.json")
            with f.open("r") as fh:
                return json.load(fh)
        except (FileNotFoundError, ModuleNotFoundError, AttributeError, OSError, ValueError):
            pass
    p = os.path.join(os.path.dirname(__file__), "tier_tables", f"{cloud}.json")
    if os.path.exists(p):
        try:
            with open(p) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None
    return None


def _apply_table_overrides(table: dict, ov: dict) -> dict:
    for k in ("specs_as_of", "source_note"):
        if isinstance(ov.get(k), str):
            table[k] = ov[k]
    tier_ovs = ov.get("tiers")
    if isinstance(tier_ovs, dict):
        for t in table.get("tiers", []):
            edit = tier_ovs.get(t["name"])
            if isinstance(edit, dict):
                for f, v in edit.items():
                    if f in t:
                        t[f] = v
    return table


def load_tier_tables(overrides: dict | None = None) -> dict:
    """Return {cloud: table}; bundled defaults merged with overrides.tier_tables[cloud]."""
    tov = ((overrides or {}).get("tier_tables") or {})
    tables = {}
    for c in CLOUDS:
        t = _read_table(c)
        if t is None:
            continue
        if isinstance(tov.get(c), dict):
            _apply_table_overrides(t, tov[c])
        tables[c] = t
    return tables


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _stat(sig_stats, key, stat="p95"):
    s = sig_stats.get(key)
    if not s:
        return None
    for k in (stat, "p95", "max", "mean"):
        v = s.get(k)
        if v is not None:
            return v
    return None


def _cat(ranked, cid):
    return next((r for r in ranked if r["id"] == cid), None)


def _conf(ranked, cid):
    c = _cat(ranked, cid)
    return (c.get("confidence") or 0.0) if c else 0.0


def _fired(ranked, cid):
    c = _cat(ranked, cid)
    return bool(c and c.get("fired"))


def _smallest_tier(tiers, min_vcpu, min_ram, need_prov=False):
    cands = [t for t in tiers
             if t["vcpu"] >= min_vcpu and t["ram_gb"] >= min_ram
             and (t.get("provisioned_iops") if need_prov else True)]
    cands.sort(key=lambda t: (t["ram_gb"], t["vcpu"]))
    return cands[0] if cands else None


def _nearest_tier(tiers, vcpu, ram_gb):
    # closest by RAM first (RAM is the sticky resource), then vCPU
    return min(tiers, key=lambda t: (abs(t["ram_gb"] - ram_gb), abs(t["vcpu"] - vcpu)))


def _clamp01(x):
    return max(0.0, min(1.0, x))


def _tier_view(t, *, vcpu=None, provisioned=False, name=None):
    """A UI-facing tier spec snapshot (optionally an R-variant / provisioned)."""
    return {
        "name": name or t["name"],
        "vcpu": vcpu if vcpu is not None else t["vcpu"],
        "ram_gb": t["ram_gb"],
        "default_storage_gb": t["default_storage_gb"],
        "default_iops": t["default_iops"],
        "provisioned_iops_supported": t.get("provisioned_iops", False),
        "provisioned_iops_recommended": provisioned,
        "wt_cache_gb": t.get("wt_cache_gb"),
    }


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
def build_sizing_recommendation(num_cores, mem_mb, sig_stats, ranked, cloud,
                                tables, provided_inputs, intent):
    """Returns the sizing_recommendation dict (or one carrying an explicit data gap)."""
    cloud = cloud if cloud in tables else "aws"
    table = tables.get(cloud) or tables.get("aws")
    provided = set(provided_inputs or [])
    # intent may be a single id, a comma-string, or a list (multi-intent). Sizing
    # surfaces if ANY selected intent is a sizing/cost intent.
    if isinstance(intent, str):
        intent_ids = [s.strip() for s in intent.split(",") if s.strip()]
    elif intent:
        intent_ids = [str(s).strip() for s in intent if str(s).strip()]
    else:
        intent_ids = []
    applies = bool(set(intent_ids) & SIZING_INTENTS)

    base = {
        "cloud": cloud,
        "specs_as_of": (table or {}).get("specs_as_of"),
        "source_note": (table or {}).get("source_note"),
        "applies_to_intent": applies,
        "intent": ",".join(intent_ids) if intent_ids else None,
    }

    if table is None or not table.get("tiers"):
        base["error"] = "insufficient information: tier table unavailable for this cloud."
        return base
    if not num_cores or not mem_mb:
        base["error"] = "insufficient information: host CPU/RAM facts missing from this capture."
        return base

    tiers = table["tiers"]
    vcpu = int(num_cores)
    ram_gb = mem_mb / 1024.0

    # --- observed signals ---
    cpu_p95 = _stat(sig_stats, "cpu_util_pct") or 0.0
    cache_p95 = _stat(sig_stats, "cache_used_pct") or 0.0
    disk_util = _stat(sig_stats, "disk_util_pct") or 0.0
    write_ms = _stat(sig_stats, "disk_avg_write_ms")
    read_ms = _stat(sig_stats, "disk_avg_read_ms")
    riops = _stat(sig_stats, "disk_read_iops") or 0.0
    wiops = _stat(sig_stats, "disk_write_iops") or 0.0
    observed_iops = round(riops + wiops)

    disk_conf = _conf(ranked, "disk_io_saturation")
    cpu_conf = _conf(ranked, "cpu_compute_sizing")
    mem_conf = _conf(ranked, "memory_cache_pressure")

    disk_saturated = (disk_util > 85) or _fired(ranked, "disk_io_saturation")
    latency_bound = bool((write_ms and write_ms > 10) or (read_ms and read_ms > 10))
    if disk_saturated and latency_bound:
        disk_profile = "saturated · latency-bound"
    elif disk_saturated:
        disk_profile = "saturated · throughput/checkpoint-bound"
    else:
        disk_profile = "healthy"

    cpu_headroom = cpu_p95 < 60
    cpu_overprovisioned = cpu_p95 < 40
    ram_headroom = cache_p95 < 60
    ram_used = cache_p95 >= 50

    current_tier = _nearest_tier(tiers, vcpu, ram_gb)

    # sizing targets (conservative: RAM kept until healthcheck confirms the working set)
    needed_vcpu = max(2, math.ceil((cpu_p95 / 100.0) * vcpu * 1.5)) if cpu_p95 else vcpu
    needed_ram = ram_gb

    # --- Option 1: General downsize ---
    t1 = _smallest_tier(tiers, needed_vcpu, needed_ram) or current_tier
    opt1_conf = _clamp01(min(_clamp01(1 - cpu_p95 / 100.0), _clamp01(1 - cache_p95 / 100.0)))
    if disk_saturated:
        opt1_conf *= 0.4  # general downsize is unsafe while disk is the constraint
    opt1 = {
        "id": "general", "label": "General downsize", "available": True,
        "tier": _tier_view(t1),
        "confidence": round(opt1_conf, 2),
        "rationale": (f"Like-for-like to the smallest tier covering observed CPU "
                      f"(~{round(cpu_p95)}% peak) and RAM headroom."),
    }

    # --- Option 2: Low-CPU (R) variant ---
    t2_base = _smallest_tier([t for t in tiers if t.get("low_cpu_available")], 1, needed_ram)
    if t2_base:
        r_vcpu = t2_base.get("low_cpu_vcpu") or max(2, t2_base["vcpu"] // 2)
        opt2_conf = _clamp01((40 - cpu_p95) / 40.0) * (1.0 if ram_used else 0.4) if cpu_p95 else 0.0
        opt2 = {
            "id": "low_cpu", "label": "Low-CPU (R) variant", "available": True,
            "tier": _tier_view(t2_base, vcpu=r_vcpu, name=f"R{t2_base['name'][1:]}"),
            "confidence": round(opt2_conf, 2),
            "rationale": (f"CPU is over-provisioned (~{round(cpu_p95)}% peak) while RAM is "
                          f"needed (cache ~{round(cache_p95)}%) — keep RAM, halve vCPU."),
        }
    else:
        opt2 = {"id": "low_cpu", "label": "Low-CPU (R) variant", "available": False,
                "tier": None, "confidence": 0.0,
                "rationale": "No low-CPU variant covers the required RAM."}

    # --- Option 3: Provisioned IOPS ---
    t3 = _smallest_tier(tiers, needed_vcpu, needed_ram, need_prov=True)
    prov_supported = t3 is not None
    if prov_supported:
        opt3 = {
            "id": "provisioned_iops", "label": "Provisioned IOPS", "available": True,
            "tier": _tier_view(t3, provisioned=True),
            "confidence": round(disk_conf, 2),
            "rationale": (f"Disk is the constraint ({disk_profile}; ~{observed_iops} IOPS "
                          f"observed) while CPU/RAM have headroom — raise IOPS instead of the tier."),
        }
    else:
        opt3 = {"id": "provisioned_iops", "label": "Provisioned IOPS", "available": False,
                "tier": None, "confidence": 0.0,
                "rationale": f"Provisioned IOPS is AWS-only; not available on {cloud}."}

    options = [opt1, opt2, opt3]

    # --- Pick the best option from the evidence pattern ---
    if disk_saturated and prov_supported and (cpu_headroom or ram_headroom):
        recommended = "provisioned_iops"
        reason = ("Disk is the dominant constraint with CPU/RAM headroom — a provisioned-IOPS "
                  "fix targets the bottleneck without paying for a whole larger tier.")
        rec_conf = opt3["confidence"]
    elif cpu_overprovisioned and ram_used and opt2["available"]:
        recommended = "low_cpu"
        reason = ("CPU is specifically over-provisioned while RAM is in use — the low-CPU "
                  "R-tier keeps RAM and cuts vCPU spend.")
        rec_conf = opt2["confidence"]
    else:
        recommended = "general"
        reason = ("No single dominant constraint — uniform headroom suggests a like-for-like "
                  "downsize to the smallest covering tier.")
        rec_conf = opt1["confidence"]
        if disk_saturated and not prov_supported:
            reason += (f" (Disk is saturated but provisioned IOPS is AWS-only; on {cloud} "
                       "consider AWS or a higher tier.)")

    # --- Honest data gaps + workload-efficiency conditioning ---
    caveats = []
    storage_note = None
    if "healthcheck" in provided:
        storage_note = "input provided — storage capacity sizing in a later update (parser pending)."
    else:
        storage_note = ("insufficient data — provide the healthcheck snapshot (getMongoData.js) "
                        "to size storage; FTDC has no per-collection storage capacity.")
    caveats.append(storage_note)

    profiler_present = "profiler" in provided
    query_fired = _fired(ranked, "query_targeting_index_recs")  # only true once profiler is scored
    flip = False
    if profiler_present and query_fired:
        flip = True
        workload_caveat = ("Query inefficiency fired — remediate the workload (indexing / query "
                           "targeting) BEFORE resizing; resizing would pay for inefficiency.")
        reason = "Remediate workload before resizing: " + workload_caveat
    elif profiler_present:
        workload_caveat = ("Profiler provided — query-efficiency scoring is pending (a later "
                           "update); this recommendation assumes the workload is efficient.")
    else:
        workload_caveat = ("Workload efficiency unconfirmed — provide the profiler / slow-query "
                           "log to rule out that inefficient queries drive this I/O before "
                           "recommending spend.")
    caveats.append(workload_caveat)

    base.update({
        "current": {
            "vcpu": vcpu,
            "ram_gb": round(ram_gb, 1),
            "matched_tier": current_tier["name"],
            "cpu_util_p95": round(cpu_p95, 1),
            "cache_used_p95": round(cache_p95, 1),
            "disk_util_p95": round(disk_util, 1),
            "disk_profile": disk_profile,
            "disk_saturated": disk_saturated,
            "observed_iops": observed_iops,
            "storage_gb": None,
            "storage_note": storage_note,
        },
        "options": options,
        "recommended": recommended,
        "recommended_confidence": round(rec_conf, 2),
        "recommended_reason": reason,
        "caveats": caveats,
        "conditioning": {
            "profiler_present": profiler_present,
            "flip_to_remediate": flip,
            "workload_caveat": workload_caveat,
        },
    })
    return base
