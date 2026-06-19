import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  TrendingDown,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type SizingOption,
  type SizingRecommendation,
  verifyTierSpecs,
} from "@/lib/sizing";
import { type OverridesDoc, rulesetGetOverrides, rulesetSetOverrides } from "@/lib/ruleset";

function ConfBar({ value, recommended }: { value: number; recommended: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary/40">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.round(value * 100)}%`, background: recommended ? "#00ED64" : "#5A6E82" }}
      />
    </div>
  );
}

function OptionCard({ opt, recommended }: { opt: SizingOption; recommended: boolean }) {
  const t = opt.tier;
  return (
    <Card
      className={
        "overflow-hidden p-0 " +
        (recommended ? "ring-2 ring-primary" : opt.available ? "" : "opacity-60")
      }
    >
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{opt.label}</span>
          {recommended && (
            <Badge className="gap-1 text-[10px]" style={{ backgroundColor: "#00ED64", color: "#0D1B2A" }}>
              <Check className="size-3" /> Recommended
            </Badge>
          )}
          {!opt.available && (
            <Badge variant="outline" className="ml-auto text-[10px] text-muted-foreground">
              unavailable
            </Badge>
          )}
        </div>
        {t ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-extrabold text-primary">{t.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {t.vcpu} vCPU · {t.ram_gb} GB
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
              <span>storage {t.default_storage_gb.toLocaleString()} GB</span>
              <span>
                {t.provisioned_iops_recommended ? "IOPS provisioned ▲" : `IOPS ${t.default_iops.toLocaleString()}`}
              </span>
              {t.wt_cache_gb != null && <span>WT cache ~{t.wt_cache_gb} GB</span>}
              <span>{t.provisioned_iops_supported ? "prov-IOPS ✓" : "prov-IOPS ✗"}</span>
            </div>
          </>
        ) : (
          <div className="text-[11px] text-muted-foreground">{opt.rationale}</div>
        )}
        {t && (
          <>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>confidence</span>
              <span className="font-mono">{Math.round(opt.confidence * 100)}%</span>
            </div>
            <ConfBar value={opt.confidence} recommended={recommended} />
            <p className="text-[11px] leading-snug text-muted-foreground">{opt.rationale}</p>
          </>
        )}
      </div>
    </Card>
  );
}

export function SizingPanel({ sizing }: { sizing: SizingRecommendation }) {
  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const [stamped, setStamped] = useState(false);

  if (sizing.error || !sizing.current || !sizing.options) {
    return (
      <Card className="border-[#4DA6FF]/30 bg-[#4DA6FF]/5">
        <CardContent className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <AlertTriangle className="size-4 text-[#4DA6FF]" />
          {sizing.error ?? "Sizing recommendation unavailable for this capture."}
        </CardContent>
      </Card>
    );
  }

  const cur = sizing.current;
  const today = new Date().toISOString().slice(0, 10);

  async function verify() {
    setVerifying(true);
    setVerifyNote(null);
    setStamped(false);
    try {
      const r = await verifyTierSpecs();
      if (r.ok) {
        setVerifyNote(`Specs confirmed against Atlas docs as of ${today}.`);
      } else {
        setVerifyNote(`Couldn't verify — keeping bundled specs as of ${sizing.specs_as_of}. (${r.note})`);
      }
    } catch (e) {
      setVerifyNote(`Couldn't verify (${String(e)}) — keeping bundled specs as of ${sizing.specs_as_of}.`);
    } finally {
      setVerifying(false);
    }
  }

  async function stampConfirmed() {
    try {
      const ov = (await rulesetGetOverrides().catch(() => null)) as OverridesDoc | null;
      const doc: OverridesDoc = ov && "categories" in ov ? ov : { version: 1, categories: {} };
      doc.tier_tables = doc.tier_tables ?? {};
      (doc.tier_tables as Record<string, unknown>)[sizing.cloud] = {
        specs_as_of: today,
        source_note: `Confirmed via web check on ${today} (values unchanged from bundled ${sizing.specs_as_of}).`,
      };
      await rulesetSetOverrides(doc);
      setStamped(true);
    } catch {
      /* best-effort */
    }
  }

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-card to-secondary/20">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <TrendingDown className="size-4 text-primary" /> Sizing Recommendation
          <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground">
            {sizing.cloud}
          </Badge>
          <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
            specs as of {sizing.specs_as_of}
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11px]" disabled={verifying} onClick={verify}>
              {verifying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Verify latest
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {verifyNote && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-1.5 text-[11px] text-muted-foreground">
            <Check className="size-3.5 text-primary" /> {verifyNote}
            {verifyNote.startsWith("Specs confirmed") &&
              (stamped ? (
                <span className="text-primary">saved ✓</span>
              ) : (
                <button onClick={stampConfirmed} className="font-medium text-primary hover:underline">
                  Save confirmation to override table
                </button>
              ))}
          </div>
        )}

        {/* Current inferred infra */}
        <div className="rounded-lg border border-border bg-secondary/20 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Server className="size-3.5" /> Current inferred infra
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
            <Stat icon={<Cpu className="size-3.5" />} label="vCPU" value={`${cur.vcpu}`} sub={`${cur.cpu_util_p95}% p95`} />
            <Stat icon={<Database className="size-3.5" />} label="RAM" value={`${cur.ram_gb} GB`} sub={`cache ${cur.cache_used_p95}%`} />
            <Stat icon={<Server className="size-3.5" />} label="≈ tier" value={cur.matched_tier} sub={sizing.cloud} />
            <Stat icon={<HardDrive className="size-3.5" />} label="disk" value={cur.disk_saturated ? "saturated" : "healthy"} sub={`${cur.observed_iops} IOPS`} />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Gauge className="size-3.5" /> {cur.disk_profile}
          </div>
          <div className="mt-1.5 flex items-start gap-1.5 rounded border border-[#4DA6FF]/30 bg-[#4DA6FF]/5 px-2 py-1 text-[11px] text-[#4DA6FF]">
            <HardDrive className="mt-0.5 size-3 shrink-0" /> Storage: {cur.storage_note}
          </div>
        </div>

        {/* Options */}
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
          {sizing.options.map((o) => (
            <OptionCard key={o.id} opt={o} recommended={o.id === sizing.recommended} />
          ))}
        </div>
        <p className="text-xs leading-relaxed text-foreground/90">
          <span className="font-semibold text-primary">Recommendation:</span> {sizing.recommended_reason}
        </p>

        {/* Caveats / conditioning */}
        {sizing.caveats && sizing.caveats.length > 0 && (
          <ul className="space-y-1">
            {sizing.caveats.map((c, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-[#F5A623]" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[10px] text-muted-foreground">{sizing.source_note}</p>
      </CardContent>
    </Card>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold">{value}</div>
      {sub && <div className="font-mono text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
