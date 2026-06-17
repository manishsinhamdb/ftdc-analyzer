import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { type Insight, INSIGHT_COLORS, fmtNum } from "@/lib/ftdc";

export function InsightsStrip({ insights }: { insights: Insight[] }) {
  if (!insights?.length) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {insights.map((ins) => {
        const color = INSIGHT_COLORS[ins.status] ?? "#8AA0B6";
        return (
          <Card key={ins.id} className="gap-2 p-3" style={{ borderColor: `${color}55` }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{ins.title}</span>
              <Badge
                className="font-bold tracking-wide"
                style={{ backgroundColor: color, color: "#0D1B2A" }}
              >
                {ins.status}
              </Badge>
            </div>
            <p className="text-xs leading-snug text-muted-foreground">{ins.headline}</p>
            <div className="mt-auto font-mono text-[11px] text-muted-foreground">
              {fmtNum(ins.value)} vs {ins.threshold ?? "n/a"}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
