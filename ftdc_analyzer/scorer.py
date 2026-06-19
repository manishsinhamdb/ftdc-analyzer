"""Layer-2 deterministic two-pass scorer.

Pass 1 — for each enabled category whose required inputs are available, compute a
confidence from its weighted signals (applying disambiguators) and build an evidence
*ledger* (one row per signal). The score is fully reconstructable from the ledger.

Pass 2 — cross-category arbitration: where a category is `conditioned_by` another, swap
in the conditional recommendation if the conditioning category *fired*; and where a
conditioning category's input is ABSENT, attach an honest caveat instead of silently
finalizing.

Output is a JSON-serializable `assessment_v2` block. The deterministic scorer is always
computed; an LLM step can later narrate it (a clean hook is left, not wired here).
"""

from __future__ import annotations

from typing import Dict, List, Optional

from .ruleset.schema import Category, Intent, IntentCategory, Ruleset, compare

# Categories whose required inputs aren't all satisfied sort after scored ones;
# input_provided (file supplied, parser pending) above requires_input; stubs/disabled last.
_STATUS_RANK = {"scored": 0, "input_provided": 1, "requires_input": 2, "stub": 3, "disabled": 4}


def _stat_value(sig_stats: dict, path: str, stat: str):
    """Read a summary stat for a derived signal; fall back p95 → max → mean."""
    s = sig_stats.get(path)
    if not s:
        return None
    for key in (stat, "p95", "max", "mean"):
        v = s.get(key)
        if v is not None:
            return v
    return None


def _eval_signal(sig, sig_stats: dict) -> dict:
    """Evaluate one signal into a ledger row (deterministic, self-describing)."""
    value = _stat_value(sig_stats, sig.metric_path, sig.stat)
    sign = 1.0 if sig.direction == "+" else -1.0

    if value is None:
        return {
            "signal": sig.metric_path, "stat": sig.stat, "value": None,
            "weight": sig.weight, "direction": sig.direction,
            "comparator": sig.comparator, "threshold": sig.threshold,
            "passed": False, "factor": 0.0, "contribution": 0.0,
            "interpretation": sig.interpretation,
            "reason": "metric absent in this capture — contributes nothing",
            "disambiguator": None, "unit": sig.unit,
        }

    passed = compare(value, sig.comparator, sig.threshold)
    factor = 1.0
    dis_out = None
    if sig.disambiguator:
        d = sig.disambiguator
        co_val = _stat_value(sig_stats, d.co_signal, sig.stat)
        co_passed = compare(co_val, d.comparator, d.value) if co_val is not None else False
        if d.effect == "enable":
            factor = 1.0 if co_passed else 0.0
        elif d.effect == "suppress":
            factor = 0.0 if co_passed else 1.0
        elif d.effect == "scale":
            factor = d.scale if co_passed else 1.0
        dis_out = {
            "co_signal": d.co_signal, "comparator": d.comparator, "value": d.value,
            "effect": d.effect, "co_value": co_val, "co_passed": co_passed,
            "factor_applied": factor, "note": d.note,
        }

    base = sig.weight if passed else 0.0
    contribution = round(base * factor * sign, 6)

    if not passed:
        reason = f"below threshold ({value} {sig.comparator} {sig.threshold} is False)"
    elif factor == 0.0:
        reason = "fired but suppressed by disambiguator (co-signal condition not met)"
    else:
        reason = sig.interpretation or "fired"

    return {
        "signal": sig.metric_path, "stat": sig.stat, "value": value,
        "weight": sig.weight, "direction": sig.direction,
        "comparator": sig.comparator, "threshold": sig.threshold,
        "passed": passed, "factor": factor, "contribution": contribution,
        "interpretation": sig.interpretation, "reason": reason,
        "disambiguator": dis_out, "unit": sig.unit,
    }


def _score_category(cat: Category, sig_stats: dict):
    """Pass-1 scoring for one category → (confidence, ledger, raw, denominator)."""
    active = [s for s in cat.signals if s.status == "active"]
    ledger = [_eval_signal(s, sig_stats) for s in active]
    denom = sum(s.weight for s in active if s.direction == "+")
    raw = round(sum(e["contribution"] for e in ledger), 6)
    confidence = max(0.0, min(1.0, raw / denom)) if denom > 0 else 0.0
    return round(confidence, 4), ledger, raw, round(denom, 6)


def _missing_inputs(cat: Category, available: set) -> List[str]:
    return [i for i in cat.required_inputs if i not in available]


def _category_pass1(cat: Category, sig_stats: dict, available: set,
                    provided: set) -> dict:
    base = {
        "id": cat.id, "name": cat.name, "family": cat.family,
        "description": cat.description, "required_inputs": list(cat.required_inputs),
        "conditioned_by": list(cat.conditioned_by),
        "fire_threshold": cat.fire_threshold,
        "default_recommendation": cat.recommendation,
        "recommendation": cat.recommendation,
        "recommendation_conditioned": False,
        "caveats": list(cat.caveats),
        "cross_references": [],
        "confidence": None, "fired": False,
        "score_raw": None, "score_denominator": None,
        "ledger": [], "signals_count": len(cat.signals),
        "missing_inputs": [],
    }

    if not cat.enabled:
        base["status"] = "disabled"
        return base

    missing = _missing_inputs(cat, available)
    if missing:
        base["missing_inputs"] = missing
        # File(s) supplied for every missing source but not yet parsed → honest pending
        # state (we do NOT fabricate a score for unparsed healthcheck/profiler data).
        if provided and all(m in provided for m in missing):
            base["status"] = "input_provided"
            base["provided_inputs"] = [m for m in missing if m in provided]
        else:
            base["status"] = "requires_input"
        return base

    if cat.status == "stub" or not any(s.status == "active" for s in cat.signals):
        base["status"] = "stub"
        return base

    confidence, ledger, raw, denom = _score_category(cat, sig_stats)
    base["status"] = "scored"
    base["confidence"] = confidence
    base["fired"] = confidence >= cat.fire_threshold
    base["score_raw"] = raw
    base["score_denominator"] = denom
    base["ledger"] = ledger
    return base


def _pass2_arbitration(results: List[dict], ruleset: Ruleset):
    """Cross-category arbitration: swap conditional recommendations when a conditioning
    category fired; attach honest caveats when a conditioning input is absent."""
    by_id = {r["id"]: r for r in results}
    for r in results:
        if r["status"] != "scored" or not r["conditioned_by"]:
            continue
        cat = ruleset.by_id(r["id"])
        for cond_id in r["conditioned_by"]:
            cond = by_id.get(cond_id)
            if cond is None:
                continue
            cond_name = cond["name"]
            if cond["status"] == "scored" and cond["fired"]:
                xref = {"category": cond_id, "name": cond_name, "status": "fired",
                        "confidence": cond["confidence"]}
                alt = (cat.conditional_recommendations or {}).get(cond_id)
                if alt:
                    r["recommendation"] = alt
                    r["recommendation_conditioned"] = True
                    xref["effect"] = "recommendation_swapped"
                    xref["note"] = (f"Recommendation conditioned: '{cond_name}' fired at "
                                    f"{cond['confidence']:.0%} — default advice downgraded.")
                else:
                    xref["effect"] = "noted"
                    xref["note"] = f"'{cond_name}' fired at {cond['confidence']:.0%}."
                r["cross_references"].append(xref)
            elif cond["status"] == "requires_input":
                src = ", ".join(cond["missing_inputs"]) or "additional data"
                caveat = (
                    f"Workload-efficiency / structural cross-check unavailable: '{cond_name}' "
                    f"requires {src} input. Cannot confirm whether this is a capacity limit "
                    f"or a workload/data-model problem — provide {src} to disambiguate.")
                if caveat not in r["caveats"]:
                    r["caveats"].append(caveat)
                r["cross_references"].append({
                    "category": cond_id, "name": cond_name, "status": "requires_input",
                    "missing_inputs": cond["missing_inputs"], "effect": "caveat_added",
                    "note": caveat})
            elif cond["status"] == "stub":
                r["cross_references"].append({
                    "category": cond_id, "name": cond_name, "status": "stub",
                    "effect": "wired_inactive",
                    "note": (f"Conditioning on '{cond_name}' is wired but that category is not "
                             f"yet deep; arbitration is inactive until it is.")})


def _apply_intent_lens(results, intent):
    """Tag each result with in_lens/lean and return the intent-ordered list.

    The intent is a curated lens — it selects/orders/weights which categories surface.
    Lean affects surfacing/ordering ONLY; it is never applied to the raw confidence, so
    the evidence ledger stays honest.
    """
    if intent is None:
        for r in results:
            r["in_lens"] = True
            r["lean"] = 1.0
        return sorted(results, key=lambda r: (_STATUS_RANK.get(r["status"], 9),
                                              -(r["confidence"] or 0.0), r["name"]))

    order = {ic.category_id: idx for idx, ic in enumerate(intent.categories)}
    lean = {ic.category_id: ic.lean for ic in intent.categories}

    if intent.full_sweep:
        # All categories in the lens; the intent's listed ids lead, rest by confidence.
        for r in results:
            r["in_lens"] = True
            r["lean"] = lean.get(r["id"], 1.0)

        def key(r):
            if r["id"] in order:
                return (0, order[r["id"]])
            return (1, _STATUS_RANK.get(r["status"], 9), -(r["confidence"] or 0.0), r["name"])
    else:
        for r in results:
            r["in_lens"] = r["id"] in order
            r["lean"] = lean.get(r["id"], 0.0)

        def key(r):
            if r["in_lens"]:
                return (0, order[r["id"]])
            return (1, _STATUS_RANK.get(r["status"], 9), -(r["confidence"] or 0.0), r["name"])

    return sorted(results, key=key)


def _merge_intents(objs, ids) -> Intent:
    """Union of several intents' lenses: dedupe categories, lean = best across the
    selected intents, ordered by descending best-lean (then first appearance)."""
    full = any(o.full_sweep for o in objs)
    best_lean, first_seen, seq = {}, {}, 0
    for o in objs:
        for ic in o.categories:
            if ic.category_id not in first_seen:
                first_seen[ic.category_id] = seq
                seq += 1
            best_lean[ic.category_id] = max(best_lean.get(ic.category_id, 0.0), ic.lean)
    cats_sorted = sorted(best_lean.keys(), key=lambda c: (-best_lean[c], first_seen[c]))
    return Intent(
        id="+".join(ids),
        title=" + ".join(o.title for o in objs),
        subtitle="Combined lens — union of the selected intents",
        description="Union of: " + "; ".join(o.title for o in objs),
        categories=[IntentCategory(category_id=c, lean=best_lean[c]) for c in cats_sorted],
        full_sweep=full,
        note="; ".join(o.note for o in objs if o.note),
    )


def _resolve_intent(ruleset: Ruleset, intent):
    """intent may be None | an id | a comma-string of ids | a list of ids.
    'full_sweep' is exclusive (handled at selection time). Returns (merged_or_None, members)."""
    if not intent:
        return None, []
    if isinstance(intent, str):
        ids = [s.strip() for s in intent.split(",") if s.strip()]
    else:
        ids = [str(s).strip() for s in intent if str(s).strip()]
    objs = [o for o in (ruleset.intent_by_id(i) for i in ids) if o is not None]
    if not objs:
        return None, []
    if len(objs) == 1:
        return objs[0], objs
    return _merge_intents(objs, [o.id for o in objs]), objs


def score(sig_stats: dict, available_inputs, ruleset: Ruleset,
          target_category: Optional[str] = None, intent=None,
          provided_inputs=None) -> dict:
    """Run the two-pass scorer and return the assessment_v2 block.

    sig_stats: {derived_signal_key: {p50,p95,p99,max,mean,...}} (from build_results).
    available_inputs: data sources available for SCORING (e.g. {"ftdc"}).
    intent: optional intent id — a curated lens that selects/orders/weights categories.
    provided_inputs: sources the user supplied a file for but which aren't parsed/scored
        yet (e.g. {"healthcheck"}) → those categories show as `input_provided`, not scored.
    """
    available = set(available_inputs)
    provided = set(provided_inputs or [])

    # Pass 1
    results = [_category_pass1(cat, sig_stats, available, provided)
               for cat in ruleset.categories]
    # Pass 2
    _pass2_arbitration(results, ruleset)

    # Intent lens (ordering/surfacing) — extends, does not replace, category scoring.
    # Supports a single intent or the UNION of several (multi-intent selection).
    intent_obj, intent_members = _resolve_intent(ruleset, intent)
    ranked = _apply_intent_lens(results, intent_obj)

    # Targeted focus (a single category) still wins the lead position if requested.
    mode = "targeted" if target_category else ("intent" if intent_obj else "full")
    focus_id = target_category
    if target_category:
        target = next((r for r in ranked if r["id"] == target_category), None)
        if target:
            target["focus"] = True
            rest = [r for r in ranked if r["id"] != target_category]
            ranked = [target] + rest

    scored = [r for r in ranked if r["status"] == "scored"]
    return {
        "version": 2,
        "mode": mode,
        "target_category": focus_id,
        "intent": intent_obj.to_dict() if intent_obj else None,
        "intent_members": [
            {"id": o.id, "title": o.title, "subtitle": o.subtitle} for o in intent_members
        ],
        "available_inputs": sorted(available),
        "provided_inputs": sorted(provided),
        "ruleset_version": ruleset.version,
        "families": [f for f in {r["family"] for r in results}],
        "counts": {
            "scored": sum(1 for r in results if r["status"] == "scored"),
            "input_provided": sum(1 for r in results if r["status"] == "input_provided"),
            "requires_input": sum(1 for r in results if r["status"] == "requires_input"),
            "stub": sum(1 for r in results if r["status"] == "stub"),
            "disabled": sum(1 for r in results if r["status"] == "disabled"),
            "fired": sum(1 for r in scored if r["fired"]),
        },
        "ranked": ranked,
        # Hook for the LLM narration step (run in the app, not the engine): an LLM reads
        # `ranked` + `intent` and narrates it, grounded strictly on the numbers.
        "llm_narration": None,
    }
