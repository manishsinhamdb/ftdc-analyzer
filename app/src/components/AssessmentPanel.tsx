import { Sparkles, TrendingDown } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  type Assessment,
  type CostOptimization,
  type Signature,
  SEVERITY_RANK,
  SIGNATURE_COLORS,
} from "@/lib/ftdc";

const OPPORTUNITY_COLOR: Record<string, string> = {
  high: "#00ED64",
  medium: "#F5A623",
  low: "#5A6E82",
  none: "#5A6E82",
};

function SignatureCard({ s }: { s: Signature }) {
  const color = SIGNATURE_COLORS[s.severity] ?? "#5A6E82";
  return (
    <Card className="gap-2 overflow-hidden p-0">
      <div className="flex gap-0">
        <div className="w-1 shrink-0" style={{ background: color }} />
        <div className="flex-1 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="font-bold tracking-wide" style={{ backgroundColor: color, color: "#0D1B2A" }}>
              {s.severity}
            </Badge>
            <span className="text-sm font-semibold">{s.title}</span>
            <Badge variant="outline" className="ml-auto text-[10px] uppercase text-muted-foreground">
              {s.purpose}
            </Badge>
          </div>
          <ul className="mt-2 space-y-0.5">
            {s.symptoms.map((sym, i) => (
              <li key={i} className="font-mono text-[11px] leading-snug text-muted-foreground">
                • {sym}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-foreground/90">{s.recommendation}</p>
        </div>
      </div>
    </Card>
  );
}

export function AssessmentPanel({
  assessment,
  costOptimization,
}: {
  assessment: Assessment;
  costOptimization: CostOptimization;
}) {
  const sigs = [...assessment.signatures].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const oppColor = OPPORTUNITY_COLOR[costOptimization?.opportunity] ?? "#5A6E82";

  return (
    <div className="space-y-4">
      {/* Headline */}
      <Card className="border-primary/30 bg-gradient-to-br from-card to-secondary/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" />
            First-draft inference
            <Badge variant="outline" className="ml-1 font-normal text-muted-foreground">
              {assessment.posture}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed text-foreground">{assessment.headline}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">purposes:</span>
            {assessment.purposes_covered.map((p) => (
              <Badge key={p} variant="secondary" className="text-[10px] uppercase">
                {p}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Signatures */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {sigs.map((s) => (
          <SignatureCard key={s.id} s={s} />
        ))}
      </div>

      {/* Cost optimization */}
      {costOptimization && costOptimization.actions?.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingDown className="size-4 text-muted-foreground" />
              Cost optimization
              <Badge style={{ backgroundColor: oppColor, color: "#0D1B2A" }} className="ml-1">
                {costOptimization.opportunity}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">{costOptimization.headline}</p>
            <div className="space-y-2">
              {costOptimization.actions.map((a, i) => (
                <div key={i} className="rounded-md border border-border bg-secondary/20 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{a.resource}</span>
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {a.lever} · {a.risk} risk
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-foreground/90">{a.recommendation}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{a.rationale}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
