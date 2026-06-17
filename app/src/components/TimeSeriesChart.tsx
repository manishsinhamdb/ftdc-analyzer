import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

import {
  LINE_PALETTE,
  REF_LINE_COLOR,
  type ChartSpec,
  type SeriesData,
  fmtAxisDate,
  fmtFullTs,
  formatAxisValue,
  formatValue,
  mergeSeries,
  presentKeys,
} from "@/lib/ftdc";

// Back-compat alias: a chart line is just a catalog series entry.
export type { ChartSeriesEntry as LineSpec } from "@/lib/ftdc";

interface Props {
  spec: ChartSpec;
  series: Record<string, SeriesData>;
  range: [number, number];
  description?: string;
  className?: string;
}

export function TimeSeriesChart({ spec, series, range, description, className }: Props) {
  const unit = spec.unit;
  const present = presentKeys(series, spec.series.map((l) => l.key));
  const presentLines = spec.series.filter((l) => present.includes(l.key));

  const config: ChartConfig = {};
  presentLines.forEach((l, i) => {
    config[l.key] = {
      label: l.label,
      color: LINE_PALETTE[i % LINE_PALETTE.length],
    };
  });

  const data = mergeSeries(series, present, range);

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{spec.title}</CardTitle>
        {description && (
          <CardDescription className="text-xs">{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        {presentLines.length === 0 ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            (no data)
          </div>
        ) : (
          <ChartContainer config={config} className="h-[280px] w-full">
            <LineChart data={data} margin={{ left: 4, right: 16, top: 8, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke="#1E3450" />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={range}
                tickFormatter={fmtAxisDate}
                tickLine={false}
                axisLine={false}
                minTickGap={72}
                stroke="#8AA0B6"
                fontSize={11}
              />
              <YAxis
                tickFormatter={(v: number) => formatAxisValue(v, unit)}
                tickLine={false}
                axisLine={false}
                width={46}
                stroke="#8AA0B6"
                fontSize={11}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, p) => {
                      const t = (p?.[0]?.payload as { t?: number } | undefined)?.t;
                      return t != null ? fmtFullTs(t) : "";
                    }}
                    formatter={(value, name, item) => {
                      const k = String(item?.dataKey ?? name);
                      const label = config[k]?.label ?? k;
                      return (
                        <div className="flex flex-1 items-center justify-between gap-4">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <span
                              className="inline-block size-2 rounded-[2px]"
                              style={{ background: item?.color }}
                            />
                            {label}
                          </span>
                          <span className="font-mono text-foreground">
                            {formatValue(value as number, unit)}
                          </span>
                        </div>
                      );
                    }}
                  />
                }
              />
              {presentLines
                .filter((l) => l.refLine != null)
                .map((l) => (
                  <ReferenceLine
                    key={`ref-${l.key}`}
                    y={l.refLine}
                    stroke={REF_LINE_COLOR}
                    strokeDasharray="4 4"
                    label={{
                      value: l.refLabel ?? `ref ${l.refLine}`,
                      position: "insideTopRight",
                      fill: REF_LINE_COLOR,
                      fontSize: 11,
                    }}
                  />
                ))}
              {presentLines.map((l) => (
                <Line
                  key={l.key}
                  dataKey={l.key}
                  type="monotone"
                  stroke={`var(--color-${l.key})`}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ))}
              <ChartLegend content={<ChartLegendContent />} />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
