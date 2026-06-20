#!/usr/bin/env python3
"""Regression guards for the three fixes (run from project root):
  #1  the wizard Inputs step must NOT gate first paint on the async engine dump
      (it seeds from a built-in default registry; no "Loading input types…" stall).
  #3  index.css must keep the 9c63973 polish: lifted --muted-foreground (#aebfd2) in BOTH
      the :root and .dark blocks, and base html { font-size: 17px }.
  +   the TS default registry ids must match the engine registry (so the instant-paint default
      stays in sync with the source of truth).

These are deliberately grep/parse-based static checks so a FUTURE revert is caught automatically
(standing practice A26). Usage: python3 scripts/uat_regression_guard.py
"""
import re
import sys

APP = "app/src"
fails = 0


def chk(name, cond, detail=""):
    global fails
    ok = bool(cond)
    if not ok:
        fails += 1
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (f"  ({detail})" if detail and not ok else ""))


def read(p):
    with open(p) as f:
        return f.read()


def css_block(css, selector):
    """Return the body of the FIRST top-level `selector { ... }` block."""
    m = re.search(re.escape(selector) + r"\s*\{", css)
    if not m:
        return None
    i = m.end()
    depth = 1
    out = []
    while i < len(css) and depth:
        c = css[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                break
        out.append(c)
        i += 1
    return "".join(out)


print("=== #3 — contrast + base font (index.css both theme blocks) ===")
css = read(f"{APP}/index.css")
root = css_block(css, ":root") or ""
dark = css_block(css, ".dark") or ""
light = css_block(css, ".light") or ""
chk(":root --muted-foreground == #aebfd2 (lifted contrast)", "--muted-foreground: #aebfd2" in root)
chk(".dark  --muted-foreground == #aebfd2 (lifted contrast)", "--muted-foreground: #aebfd2" in dark)
chk(".light --muted-foreground present (light variant)", "--muted-foreground:" in light)
chk("base html font-size == 17px", re.search(r"html\s*\{[^}]*font-size:\s*17px", css, re.S) is not None)
chk("no leftover old muted #8AA0B6 in :root/.dark", "#8aa0b6" not in (root + dark).lower())

print("\n=== #1 — Inputs step seeds from default registry, no first-paint gate ===")
landing = read(f"{APP}/components/Landing.tsx")
chk("no 'Loading input types…' stall string", "Loading input types" not in landing)
chk("inputReg seeded from DEFAULT_INPUT_REGISTRY", "DEFAULT_INPUT_REGISTRY.inputs" in landing)
chk("Inputs step hydrates via cachedInputRegistry (shared cache)", "cachedInputRegistry()" in landing)
rs = read(f"{APP}/lib/ruleset.ts")
chk("DEFAULT_INPUT_REGISTRY exported", "export const DEFAULT_INPUT_REGISTRY" in rs)
chk("cachedInputRegistry falls back to DEFAULT (never blocks/null)",
    "return DEFAULT_INPUT_REGISTRY" in rs)
chk("cachedRulesetDump is module-cached (single spawn)", "if (!_dumpCache)" in rs)
chk("Landing does NOT call uncached rulesetDump()", not re.search(r"[^d]rulesetDump\(\)", landing))

print("\n=== sync — TS default registry ids match the engine registry ===")
sys.path.insert(0, ".")
try:
    from ftdc_analyzer.inputs import registry as eng
    engine_ids = [e.id for e in eng.REGISTRY]
    engine_primary = eng.primary_ids()
except Exception as e:  # pragma: no cover
    engine_ids, engine_primary = None, None
    print(f"  [warn] could not import engine registry: {e}")
block = re.search(r"DEFAULT_INPUT_REGISTRY[^=]*=\s*\{.*?\n\};", rs, re.S)
ts_ids = re.findall(r'id:\s*"(\w+)"', block.group(0)) if block else []
ts_primary = re.findall(r'primary:\s*\[([^\]]*)\]', block.group(0))
ts_primary = re.findall(r'"(\w+)"', ts_primary[0]) if ts_primary else []
if engine_ids is not None:
    chk(f"TS default ids == engine ids ({engine_ids})", ts_ids == engine_ids, f"ts={ts_ids}")
    chk(f"TS default primary == engine primary ({engine_primary})", ts_primary == engine_primary, f"ts={ts_primary}")

print("\n" + ("ALL REGRESSION GUARDS PASSED" if not fails else f"{fails} GUARD(S) FAILED"))
sys.exit(1 if fails else 0)
