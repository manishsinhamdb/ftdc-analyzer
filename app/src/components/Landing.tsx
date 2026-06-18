import { Database, FolderOpen, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  username: string;
  selectedPath: string | null;
  analyzing: boolean;
  error: string | null;
  onPick: () => void;
  onAnalyze: () => void;
}

export function Landing({
  username,
  selectedPath,
  analyzing,
  error,
  onPick,
  onAnalyze,
}: Props) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-xl space-y-8">
        {/* Brand + purpose */}
        <div className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Database className="size-6" />
          </div>
          {username && (
            <p className="text-sm font-medium text-primary">Hi {username} :)</p>
          )}
          <h1 className="text-2xl font-bold">FTDC Analyzer</h1>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            Analyze a MongoDB diagnostic.data folder — Atlas-style metrics + an automated
            first-pass assessment. Runs 100% locally.
          </p>
        </div>

        {/* Primary actions */}
        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Button className="gap-2" onClick={onPick} disabled={analyzing}>
              <FolderOpen className="size-4" /> Open FTDC data…
            </Button>
            <Button
              variant={selectedPath ? "default" : "secondary"}
              className="gap-2"
              onClick={onAnalyze}
              disabled={analyzing || !selectedPath}
            >
              {analyzing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {analyzing ? "Analyzing…" : "Analyze"}
            </Button>
          </div>
          <p
            className="truncate font-mono text-xs text-muted-foreground"
            title={selectedPath ?? ""}
          >
            {selectedPath ?? "no folder selected"}
          </p>
          {analyzing && (
            <p className="text-xs text-muted-foreground">
              running engine — ~1–2 min for multi-day captures. Nothing is uploaded; analysis
              runs locally.
            </p>
          )}
          {error && !analyzing && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
