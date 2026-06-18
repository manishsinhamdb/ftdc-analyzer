import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { type Facts, flattenObject } from "@/lib/ftdc";

const DETAIL_SECTIONS: { key: keyof Facts; label: string }[] = [
  { key: "buildInfo", label: "Build Info" },
  { key: "hostInfo", label: "Host Info" },
  { key: "getCmdLineOpts", label: "Command-line Options" },
];

const DERIVED_LABELS: Record<string, string> = {
  mongo_version: "MongoDB",
  os: "OS",
  num_cores: "Cores",
  mem_gb: "RAM (GB)",
  uptime_days: "Uptime (days)",
  wt_cache_gb: "WT cache (GB)",
};

// One config field. Short scalars stay inline (key → value); long values (>~40 chars)
// stack with the value full-width in a wrapping monospace block; cpuFeatures renders as
// wrapped chips. overflow-wrap:anywhere prevents the 1–2-char-per-line collapse.
const LONG = 40;

function ConfigRow({ rowKey, value, zebra }: { rowKey: string; value: string; zebra: boolean }) {
  const cell = "border-b border-border px-3 py-1.5 last:border-0 " + (zebra ? "bg-secondary/20" : "");

  if (rowKey.endsWith("cpuFeatures")) {
    const feats = value.split(/\s+/).filter(Boolean);
    return (
      <div className={cell}>
        <div className="mb-1 font-mono text-xs text-muted-foreground">{rowKey}</div>
        <div className="flex flex-wrap gap-1">
          {feats.map((f) => (
            <span
              key={f}
              className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground"
            >
              {f}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (value.length > LONG) {
    return (
      <div className={cell}>
        <div className="mb-1 font-mono text-xs text-muted-foreground">{rowKey}</div>
        <div className="whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
          {value}
        </div>
      </div>
    );
  }

  return (
    <div className={cell + " flex items-baseline justify-between gap-3"}>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{rowKey}</span>
      <span className="min-w-0 break-words text-right font-mono text-xs text-foreground [overflow-wrap:anywhere]">
        {value}
      </span>
    </div>
  );
}

export function SystemView({ facts }: { facts: Facts }) {
  const [query, setQuery] = useState("");

  const tiles = useMemo(() => flattenObject(facts.derived), [facts]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return DETAIL_SECTIONS.map((s) => {
      const rows = flattenObject(facts[s.key]).filter(
        (r) => !q || r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q),
      );
      return { ...s, rows };
    }).filter((s) => s.rows.length > 0);
  }, [facts, query]);

  const total = sections.reduce((a, s) => a + s.rows.length, 0);

  return (
    <div className="space-y-4">
      {/* Derived key facts — compact stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.key} className="rounded-lg border border-border bg-card p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {DERIVED_LABELS[t.key] ?? t.key}
            </div>
            <div className="truncate text-base font-semibold" title={t.value}>
              {t.value}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter config by key or value…"
            className="pl-9"
          />
        </div>
        <div className="text-sm text-muted-foreground">{total} fields shown</div>
      </div>

      {/* Detail sections — masonry columns so cards size to content (no empty boxes) */}
      {sections.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No config fields match the filter.
          </CardContent>
        </Card>
      ) : (
        <div className="gap-4 columns-1 lg:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
          {sections.map((s) => (
            <Card key={s.key} className="inline-block w-full align-top">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  {s.label}
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {s.rows.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-hidden rounded-md border border-border">
                  {s.rows.map((r, i) => (
                    <ConfigRow key={r.key} rowKey={r.key} value={r.value} zebra={i % 2 === 1} />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
