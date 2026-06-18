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
        <div className="gap-4 lg:columns-2 xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
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
                  <table className="w-full text-xs">
                    <tbody>
                      {s.rows.map((r, i) => (
                        <tr
                          key={r.key}
                          className={
                            "border-b border-border last:border-0 " +
                            (i % 2 === 1 ? "bg-secondary/20" : "")
                          }
                        >
                          <td className="w-1/2 px-3 py-1.5 align-top font-mono text-muted-foreground">
                            {r.key}
                          </td>
                          <td className="px-3 py-1.5 align-top font-mono break-all text-foreground">
                            {r.value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
