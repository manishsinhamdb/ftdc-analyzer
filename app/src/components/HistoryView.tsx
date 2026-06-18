import { Clock, FolderOpen } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { type RunHistoryEntry } from "@/lib/ftdc";

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

interface Props {
  entries: RunHistoryEntry[];
  analyzing: boolean;
  onLoad: (entry: RunHistoryEntry) => void;
}

export function HistoryView({ entries, analyzing, onLoad }: Props) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Analysis history</h2>
        <p className="text-xs text-muted-foreground">
          Past runs, persisted locally. Selecting one reloads its cached results — no
          re-analysis. Cached results may have been cleared by the OS.
        </p>
      </div>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-6 opacity-50" />
            No past runs yet. Open a diagnostic.data folder and Analyze to start building history.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <Card key={e.cache_dir} className="p-0">
              <div className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                  <Clock className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{e.hostname}</span>
                    <span className="text-xs text-muted-foreground">{fmtTs(e.timestamp)}</span>
                  </div>
                  <div
                    className="truncate font-mono text-[11px] text-muted-foreground"
                    title={e.source_path}
                  >
                    {e.source_path}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-2 text-xs"
                  disabled={analyzing}
                  onClick={() => onLoad(e)}
                >
                  <FolderOpen className="size-4" /> Load
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
