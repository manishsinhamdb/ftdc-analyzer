import { Database, FolderOpen, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  username: string;
  selectedPath: string | null;
  analyzing: boolean;
  demoAvailable: boolean;
  error: string | null;
  onPick: () => void;
  onAnalyze: () => void;
  onLoadDemo: () => void;
}

const STEPS = [
  { n: 1, t: "Open a diagnostic.data folder" },
  { n: 2, t: "Analyze" },
  { n: 3, t: "Review the dashboard, charts, and assessment" },
];

export function Landing({
  username,
  selectedPath,
  analyzing,
  demoAvailable,
  error,
  onPick,
  onAnalyze,
  onLoadDemo,
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
            first-pass assessment.
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
          {error && !analyzing && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        {/* How it works */}
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            How it works
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-lg border border-border bg-card/50 p-3">
                <div className="flex size-6 items-center justify-center rounded-full bg-secondary text-xs font-bold text-foreground">
                  {s.n}
                </div>
                <div className="mt-2 text-xs leading-snug text-muted-foreground">{s.t}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Secondary demo */}
        {demoAvailable && (
          <div className="text-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={onLoadDemo}
              disabled={analyzing}
            >
              Load demo sample (local, bundled)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
