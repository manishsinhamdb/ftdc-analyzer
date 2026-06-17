import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { type Facts, flattenObject } from "@/lib/ftdc";

const SECTIONS: { key: keyof Facts; label: string }[] = [
  { key: "derived", label: "Derived" },
  { key: "buildInfo", label: "Build Info" },
  { key: "hostInfo", label: "Host Info" },
  { key: "getCmdLineOpts", label: "Command-line Options" },
];

export function SystemView({ facts }: { facts: Facts }) {
  const [query, setQuery] = useState("");

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SECTIONS.map((s) => {
      const rows = flattenObject(facts[s.key]).filter(
        (r) => !q || r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q),
      );
      return { ...s, rows };
    });
  }, [facts, query]);

  const total = sections.reduce((a, s) => a + s.rows.length, 0);

  return (
    <div className="space-y-4">
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {sections.map((s) => (
          <Card key={s.key}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                {s.label}
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  {s.rows.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {s.rows.length === 0 ? (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  (no matching fields)
                </div>
              ) : (
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
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
