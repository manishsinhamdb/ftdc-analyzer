import { useEffect, useState } from "react";
import { Lock, Maximize2, RotateCcw, Upload } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

import {
  DEFAULT_GRANULARITY,
  LINE_PALETTE,
  REF_LINE_COLOR,
  type ChartRow,
  type ChartSpec,
  type SeriesData,
  bucketSeries,
  fmtAxisDate,
  fmtFullTs,
  formatAxisValue,
  formatValue,
  presentKeys,
} from "@/lib/ftdc";

export type { ChartSeriesEntry as LineSpec } from "@/lib/ftdc";

const MODAL_BUCKETS = 800; // detail resolution inside the maximized modal

interface Props {
  spec: ChartSpec;
  series: Record<string, SeriesData>;
  range: [number, number];
  granularity?: number;
  description?: string;
  className?: string;
}

interface ZoomHandlers {
  refLeft: number | null;
  refRight: number | null;
  onDown: (e: { activeLabel?: string | number } | null) => void;
  onMove: (e: { activeLabel?: string | number } | null) => void;
  onUp: () => void;
}

interface BodyProps {
  config: ChartConfig;
  data: ChartRow[];
  presentLines: ChartSpec["series"];
  range: [number, number];
  unit: string;
  className: string;
  zoom?: ZoomHandlers;
}

function ChartBody({ config, data, presentLines, range, unit, className, zoom }: BodyProps) {
  return (
    <ChartContainer config={config} className={className}>
      <ComposedChart
        data={data}
        margin={{ left: 4, right: 16, top: 8, bottom: 4 }}
        onMouseDown={zoom ? (e) => zoom.onDown(e) : undefined}
        onMouseMove={zoom ? (e) => zoom.onMove(e) : undefined}
        onMouseUp={zoom ? () => zoom.onUp() : undefined}
        style={zoom ? { userSelect: "none", cursor: "crosshair" } : undefined}
      >
        <CartesianGrid vertical={false} stroke="#1E3450" />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={range}
          allowDataOverflow
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
                      <span className="inline-block size-2 rounded-[2px]" style={{ background: item?.color }} />
                      {label}
                    </span>
                    <span className="font-mono text-foreground">{formatValue(value as number, unit)}</span>
                  </div>
                );
              }}
            />
          }
        />
        {/* min–max band behind each line (so spikes show even at coarse granularity) */}
        {presentLines.map((l) => (
          <Area
            key={`${l.key}_band`}
            dataKey={`${l.key}_band`}
            stroke="none"
            fill={`var(--color-${l.key})`}
            fillOpacity={0.13}
            isAnimationActive={false}
            connectNulls
            legendType="none"
            activeDot={false}
          />
        ))}
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
        {zoom && zoom.refLeft != null && zoom.refRight != null && (
          <ReferenceArea x1={zoom.refLeft} x2={zoom.refRight} strokeOpacity={0.3} fill="#00ED64" fillOpacity={0.12} />
        )}
        <ChartLegend content={<ChartLegendContent />} />
      </ComposedChart>
    </ChartContainer>
  );
}

function chartConfig(presentLines: ChartSpec["series"]): ChartConfig {
  const config: ChartConfig = {};
  presentLines.forEach((l, i) => {
    config[l.key] = { label: l.label, color: LINE_PALETTE[i % LINE_PALETTE.length] };
  });
  return config;
}

// Reusable maximize modal with drag-to-zoom.
export function ChartModal({
  spec,
  series,
  range,
  open,
  onOpenChange,
}: {
  spec: ChartSpec;
  series: Record<string, SeriesData>;
  range: [number, number];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const unit = spec.unit;
  const present = presentKeys(series, spec.series.map((l) => l.key));
  const presentLines = spec.series.filter((l) => present.includes(l.key));
  const config = chartConfig(presentLines);

  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null);
  const [refLeft, setRefLeft] = useState<number | null>(null);
  const [refRight, setRefRight] = useState<number | null>(null);

  // Reset zoom whenever the modal opens or the base range changes.
  useEffect(() => {
    if (open) {
      setZoomRange(null);
      setRefLeft(null);
      setRefRight(null);
    }
  }, [open, range[0], range[1]]);

  const effRange = zoomRange ?? range;
  const data = bucketSeries(series, present, effRange, MODAL_BUCKETS);

  const zoom: ZoomHandlers = {
    refLeft,
    refRight,
    onDown: (e) => {
      if (e?.activeLabel != null) {
        setRefLeft(Number(e.activeLabel));
        setRefRight(null);
      }
    },
    onMove: (e) => {
      if (refLeft != null && e?.activeLabel != null) setRefRight(Number(e.activeLabel));
    },
    onUp: () => {
      if (refLeft != null && refRight != null) {
        const lo = Math.min(refLeft, refRight);
        const hi = Math.max(refLeft, refRight);
        if (hi - lo > 60_000) setZoomRange([lo, hi]); // ignore tiny drags (<1 min)
      }
      setRefLeft(null);
      setRefRight(null);
    },
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] max-h-[88vh] w-[92vw] max-w-[92vw] flex-col sm:max-w-[92vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-base">
            {spec.title}
            <span className="text-xs font-normal text-muted-foreground">
              drag across the plot to zoom · mean line with min–max band
            </span>
            {zoomRange && (
              <Button size="sm" variant="outline" className="ml-auto h-7 gap-1.5 text-xs" onClick={() => setZoomRange(null)}>
                <RotateCcw className="size-3.5" /> Reset zoom
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>
        {presentLines.length > 0 ? (
          <ChartBody
            config={config}
            data={data}
            presentLines={presentLines}
            range={effRange}
            unit={unit}
            className="aspect-auto min-h-0 w-full flex-1"
            zoom={zoom}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">(no data)</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TimeSeriesChart({ spec, series, range, granularity, description, className }: Props) {
  const [maximized, setMaximized] = useState(false);
  const unit = spec.unit;
  const present = presentKeys(series, spec.series.map((l) => l.key));
  const presentLines = spec.series.filter((l) => present.includes(l.key));
  const config = chartConfig(presentLines);

  const data = bucketSeries(series, present, range, granularity ?? DEFAULT_GRANULARITY);
  const hasData = presentLines.length > 0;

  return (
    <>
      <Card className={className}>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-semibold">{spec.title}</CardTitle>
              {description && <CardDescription className="text-xs">{description}</CardDescription>}
            </div>
            {hasData && (
              <button
                onClick={() => setMaximized(true)}
                title="Maximize chart (drag to zoom)"
                aria-label="Maximize chart"
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
              >
                <Maximize2 className="size-4" />
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!hasData ? (
            <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">(no data)</div>
          ) : (
            <ChartBody
              config={config}
              data={data}
              presentLines={presentLines}
              range={range}
              unit={unit}
              className="aspect-auto h-[280px] w-full"
            />
          )}
        </CardContent>
      </Card>

      <ChartModal spec={spec} series={series} range={range} open={maximized} onOpenChange={setMaximized} />
    </>
  );
}

// Placeholder tile for catalog charts whose data_state is not "present".
export function ChartPlaceholder({ spec, className }: { spec: ChartSpec; className?: string }) {
  const versionGated = spec.data_state === "unavailable_version";
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground">{spec.title}</CardTitle>
          <Badge variant="outline" className="shrink-0 gap-1 text-[10px] font-normal text-muted-foreground">
            {versionGated ? <Lock className="size-3" /> : <Upload className="size-3" />}
            {versionGated ? "version-gated" : "needs data"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex h-[280px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-secondary/10 px-6 text-center">
          {versionGated ? <Lock className="size-7 text-muted-foreground/40" /> : <Upload className="size-7 text-muted-foreground/40" />}
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            {spec.placeholder ?? "Data not available for this chart."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
