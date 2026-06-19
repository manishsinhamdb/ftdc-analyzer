// LLM narration of the deterministic Layer-2 assessment.
//
// Takes the already-scored assessment_v2 (categories, confidences, evidence ledgers,
// caveats, conditioned recommendations) and asks the selected model to NARRATE it —
// strictly grounded on the provided numbers. The model must not invent metrics, scores,
// or findings; it explains the scored evidence, respects the caveats, and surfaces the
// cross-category conditioning in prose. HTTP runs through the existing llm_chat command.

import type { AssessmentV2, CategoryResult } from "@/lib/ruleset";
import type { SizingRecommendation } from "@/lib/sizing";
import type { ChatMessage, LlmProvider } from "@/lib/llm";
import { makeClient } from "@/lib/llm";

export interface NarrationResult {
  ok: boolean;
  narrative?: string;
  model?: string;
  reason?: string; // human-readable fallback reason when ok=false
  kind?: string; // subscription | auth | timeout | network | http | parse | none
}

const SYSTEM_PROMPT = [
  "You are a MongoDB performance assistant. You are given the OUTPUT of a deterministic",
  "scoring engine (not raw data): scoring categories, each with a confidence score (0-100%),",
  "an evidence ledger (signal = value vs threshold, with a signed contribution), caveats, and",
  "recommendations that may already be conditioned by other categories.",
  "",
  "Your job: rewrite and EXPLAIN these scored findings as a clear, purpose-aware narrative for",
  "a Solutions Architect. Hard rules — follow them exactly:",
  "1. Cite ONLY the numbers, signals, scores, and thresholds provided below. Never invent or",
  "   estimate metrics, values, scores, or findings that are not in the input.",
  "2. Do NOT introduce new verdicts, categories, or recommendations. You narrate the given",
  "   findings; you do not create new ones.",
  "3. Respect and restate the caveats verbatim in meaning — especially any 'workload efficiency",
  "   unknown' capacity caveat. If a capacity finding has that caveat, you MUST say the",
  "   resource conclusion is conditional until query/workload efficiency is confirmed.",
  "4. Explain the cross-category conditioning in plain prose (e.g. why a recommendation was",
  "   downgraded or what it depends on).",
  "5. If a category needs an input that is not available, say it is unconfirmed and name the",
  "   missing source; do not guess what it would show.",
  "Structure the narrative under exactly these three headings (use them verbatim):",
  "  'What we found' — the fired findings + the key numbers.",
  "  'Why it points here (not elsewhere)' — the dominant constraint vs the categories with headroom.",
  "  'What would change this conclusion' — the conditioning caveats / missing inputs.",
  "Keep each section to a few concise sentences. Plain sentence case, no invented precision.",
].join("\n");

function pct(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

function categoryDigest(c: CategoryResult): string {
  const lines: string[] = [];
  const fired = c.fired ? "FIRED" : "did not fire";
  lines.push(
    `### ${c.name} [${c.family}] — confidence ${pct(c.confidence)} (${fired}; fires at ${pct(
      c.fire_threshold,
    )})`,
  );
  // Top evidence rows (non-zero contribution first, then a couple of misses), capped.
  const rows = [...c.ledger].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const top = rows.slice(0, 6);
  for (const r of top) {
    const val = r.value === null ? "absent" : `${r.value}${r.unit ? ` ${r.unit}` : ""}`;
    const sign = r.contribution > 0 ? "+" : "";
    lines.push(
      `- ${r.signal} = ${val} (test ${r.comparator}${r.threshold}; ` +
        `${r.passed ? "met" : "not met"}; contribution ${sign}${r.contribution})`,
    );
  }
  lines.push(`Recommendation${c.recommendation_conditioned ? " (CONDITIONED)" : ""}: ${c.recommendation}`);
  if (c.cross_references.length) {
    for (const x of c.cross_references) lines.push(`Conditioning: ${x.note}`);
  }
  if (c.caveats.length) {
    for (const cv of c.caveats) lines.push(`Caveat: ${cv}`);
  }
  return lines.join("\n");
}

function sizingDigest(s: SizingRecommendation): string {
  if (!s.current || !s.options) return "";
  const lines = [
    "SIZING RECOMMENDATION (explain this choice grounded on these numbers; do not invent specs):",
    `Current: ${s.current.vcpu} vCPU / ${s.current.ram_gb} GB (~${s.current.matched_tier} on ${s.cloud}), ` +
      `disk ${s.current.disk_profile}, ~${s.current.observed_iops} IOPS. Storage: ${s.current.storage_note}`,
  ];
  for (const o of s.options) {
    const t = o.tier ? `${o.tier.name} (${o.tier.vcpu} vCPU/${o.tier.ram_gb} GB)` : "n/a";
    lines.push(`- ${o.label}: ${t}, confidence ${Math.round(o.confidence * 100)}% — ${o.rationale}`);
  }
  lines.push(`RECOMMENDED: ${s.recommended} — ${s.recommended_reason}`);
  for (const c of s.caveats ?? []) lines.push(`Sizing caveat: ${c}`);
  return lines.join("\n");
}

export function buildNarrationMessages(
  v2: AssessmentV2,
  focusId?: string | null,
  sizing?: SizingRecommendation | null,
): ChatMessage[] {
  const scored = v2.ranked.filter((r) => r.status === "scored");
  const requiresInput = v2.ranked.filter((r) => r.status === "requires_input");

  let ordered = scored;
  let focusLine = "";
  if (focusId) {
    const focus = scored.find((r) => r.id === focusId);
    if (focus) {
      ordered = [focus, ...scored.filter((r) => r.id !== focusId)];
      focusLine =
        `\nFOCUS: the user selected "${focus.name}". Lead with it and go deeper on it; ` +
        `mention the others only as supporting context.\n`;
    } else {
      const req = requiresInput.find((r) => r.id === focusId);
      if (req) {
        focusLine =
          `\nFOCUS: the user selected "${req.name}", but it requires ${req.missing_inputs.join(
            ", ",
          )} which is not available — state that it cannot be assessed yet and what to provide.\n`;
      }
    }
  }

  // Foreground the in-lens categories when an intent is active.
  ordered = [...ordered].sort((a, b) => Number(b.in_lens ?? true) - Number(a.in_lens ?? true));

  const body: string[] = [];
  if (v2.intent) {
    body.push(
      `ASSESSMENT INTENT: "${v2.intent.title}" — ${v2.intent.subtitle}. Frame the narrative for ` +
        `this question and foreground the in-lens categories.`,
    );
  }
  body.push(`Host capture summary: ${v2.counts.scored} categories scored, ${v2.counts.fired} fired, ` +
    `${v2.counts.requires_input} need more data. Mode: ${v2.mode}.`);
  body.push(focusLine);
  body.push("SCORED FINDINGS (narrate only these; numbers are authoritative):\n");
  body.push(ordered.map(categoryDigest).join("\n\n"));
  if (requiresInput.length) {
    body.push("\nNOT ASSESSED (missing input — do not speculate on their values):");
    for (const r of requiresInput) {
      body.push(`- ${r.name}: requires ${r.missing_inputs.join(", ")}`);
    }
  }

  if (sizing && sizing.applies_to_intent && sizing.current) {
    body.push("\n" + sizingDigest(sizing));
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: body.join("\n") },
  ];
}

export async function runNarration(
  v2: AssessmentV2,
  provider: LlmProvider,
  model: string,
  focusId?: string | null,
  sizing?: SizingRecommendation | null,
): Promise<NarrationResult> {
  if (!model) {
    return { ok: false, reason: "no model selected", kind: "none" };
  }
  const messages = buildNarrationMessages(v2, focusId, sizing);
  try {
    const res = await makeClient(provider).chat(messages, model, {
      temperature: 0.2, // low — we want faithful narration, not creativity
      max_tokens: 900,
    });
    if (res.ok && res.content && res.content.trim()) {
      return { ok: true, narrative: res.content.trim(), model: res.model ?? model };
    }
    return {
      ok: false,
      reason: res.error || "the model returned no content",
      kind: res.kind ?? "parse",
    };
  } catch (e) {
    return { ok: false, reason: String(e), kind: "network" };
  }
}
