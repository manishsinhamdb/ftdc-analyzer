// Template-based narrative generation from the deterministic Layer-2 assessment.
//
// Takes the already-scored assessment_v2 (categories, confidences, evidence ledgers,
// caveats, conditioned recommendations) and generates a structured narrative using
// deterministic templates. No external dependencies - purely local generation.

import type { AssessmentV2 } from "@/lib/ruleset";
import type { SizingRecommendation } from "@/lib/sizing";

export interface NarrationResult {
  ok: boolean;
  narrative?: string;
  model?: string;
  reason?: string;
  kind?: string;
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

function formatValue(value: number | null, unit?: string | null): string {
  if (value === null) return "n/a";
  const rounded = value > 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return unit ? `${rounded}${unit}` : `${rounded}`;
}

// Template-based narrative generation
function generateFindingsSection(v2: AssessmentV2, focusId?: string | null): string {
  const fired = v2.ranked.filter((r) => r.fired && r.status === "scored");

  if (fired.length === 0) {
    return "All monitored categories are within healthy thresholds. No critical issues detected in this analysis period.";
  }

  const sections: string[] = [];
  const focus = focusId ? fired.find((c) => c.id === focusId) : null;
  const toShow = focus ? [focus, ...fired.filter((c) => c.id !== focusId).slice(0, 2)] : fired.slice(0, 3);

  for (const cat of toShow) {
    const conf = pct(cat.confidence);
    sections.push(`**${cat.name}** (${conf} confidence): ${cat.description}`);

    // Top 2 contributing signals
    const topSignals = cat.ledger
      .filter((s) => s.passed && s.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 2);

    for (const sig of topSignals) {
      const val = formatValue(sig.value, sig.unit);
      sections.push(`  • ${sig.signal} = ${val} (threshold: ${sig.comparator} ${sig.threshold})`);
    }
  }

  if (fired.length > toShow.length) {
    sections.push(`\n*Plus ${fired.length - toShow.length} additional categories with elevated signals.*`);
  }

  return sections.join("\n");
}

function generateReasoningSection(v2: AssessmentV2, sizing?: SizingRecommendation | null): string {
  const fired = v2.ranked.filter((r) => r.fired && r.status === "scored");

  if (fired.length === 0) {
    return "No dominant constraints identified. System resources and performance metrics are operating within expected parameters.";
  }

  const dominant = fired[0];
  const sections: string[] = [];

  sections.push(`${dominant.name} is the dominant constraint. ${dominant.recommendation}`);

  // Mention conditioning if present
  if (dominant.recommendation_conditioned && dominant.cross_references.length > 0) {
    const condNote = dominant.cross_references[0].note;
    sections.push(`Note: ${condNote}`);
  }

  // Add sizing recommendation if available
  if (sizing && sizing.recommended) {
    sections.push(`\nRecommended sizing: ${sizing.recommended} — ${sizing.recommended_reason}`);
  }

  return sections.join(" ");
}

function generateCaveatsSection(v2: AssessmentV2): string {
  const fired = v2.ranked.filter((r) => r.fired && r.status === "scored");
  const requiresInput = v2.ranked.filter((r) => r.status === "requires_input");

  const allCaveats: string[] = [];

  // Collect caveats from fired categories
  for (const cat of fired) {
    for (const caveat of cat.caveats) {
      if (!allCaveats.includes(caveat)) {
        allCaveats.push(caveat);
      }
    }
  }

  // Add missing input notices
  if (requiresInput.length > 0) {
    const inputNames = requiresInput.map((r) => r.name).join(", ");
    allCaveats.push(
      `Additional categories (${inputNames}) require supplementary data and are not yet assessed. ` +
      `Provide the missing inputs for a more complete analysis.`
    );
  }

  if (allCaveats.length === 0) {
    return "No conditional factors identified. The assessment is based on the complete available data.";
  }

  return allCaveats.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

export async function runNarration(
  v2: AssessmentV2,
  focusId?: string | null,
  sizing?: SizingRecommendation | null,
): Promise<NarrationResult> {
  try {
    const sections: string[] = [];

    // Generate three-part narrative structure
    sections.push("**What we found**\n");
    sections.push(generateFindingsSection(v2, focusId));

    sections.push("\n\n**Why it points here (not elsewhere)**\n");
    sections.push(generateReasoningSection(v2, sizing));

    sections.push("\n\n**What would change this conclusion**\n");
    sections.push(generateCaveatsSection(v2));

    const narrative = sections.join("");

    return {
      ok: true,
      narrative,
      model: "template-based",
      kind: "none",
    };
  } catch (e) {
    return {
      ok: false,
      reason: String(e),
      kind: "parse",
    };
  }
}
