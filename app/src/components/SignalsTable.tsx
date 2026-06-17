import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { type SignalStat, fmtNum } from "@/lib/ftdc";

const ALL = "__all__";

interface Props {
  signals: Record<string, SignalStat>;
}

export function SignalsTable({ signals }: Props) {
  const [query, setQuery] = useState("");
  const [unit, setUnit] = useState<string>(ALL);
  const entries = useMemo(() => Object.entries(signals), [signals]);

  const units = useMemo(() => {
    const set = new Set<string>();
    for (const [, s] of entries) set.add(s.unit || "—");
    return Array.from(set).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(([name, s]) => {
      if (q && !name.toLowerCase().includes(q)) return false;
      if (unit !== ALL && (s.unit || "—") !== unit) return false;
      return true;
    });
  }, [entries, query, unit]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter signals by name…"
              className="pl-9"
            />
          </div>
          <Select value={unit} onValueChange={setUnit}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Unit" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All units</SelectItem>
              {units.map((u) => (
                <SelectItem key={u} value={u}>
                  {u}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="shrink-0 text-sm text-muted-foreground">
          {filtered.length.toLocaleString("en-US")} / {entries.length.toLocaleString("en-US")} signals
        </div>
      </div>

      <ScrollArea className="h-[64vh] rounded-md border border-border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-xs">signal</TableHead>
              <TableHead className="text-xs">unit</TableHead>
              <TableHead className="text-right text-xs">p50</TableHead>
              <TableHead className="text-right text-xs">p95</TableHead>
              <TableHead className="text-right text-xs">p99</TableHead>
              <TableHead className="text-right text-xs">max</TableHead>
              <TableHead className="text-right text-xs">mean</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map(([name, s], i) => (
              <TableRow
                key={name}
                className={
                  "border-border hover:bg-secondary/40 " +
                  (i % 2 === 1 ? "bg-secondary/20" : "")
                }
              >
                <TableCell className="py-1.5 text-xs">{name}</TableCell>
                <TableCell className="py-1.5 text-xs text-muted-foreground">
                  {s.unit || "—"}
                </TableCell>
                <TableCell className="py-1.5 text-right font-mono text-xs">{fmtNum(s.p50)}</TableCell>
                <TableCell className="py-1.5 text-right font-mono text-xs">{fmtNum(s.p95)}</TableCell>
                <TableCell className="py-1.5 text-right font-mono text-xs">{fmtNum(s.p99)}</TableCell>
                <TableCell className="py-1.5 text-right font-mono text-xs">{fmtNum(s.max)}</TableCell>
                <TableCell className="py-1.5 text-right font-mono text-xs">{fmtNum(s.mean)}</TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  No signals match the current filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  );
}
