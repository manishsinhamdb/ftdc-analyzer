import { ArrowDown, Server, Cpu, MemoryStick, HardDrive, Users, Database, CheckCircle2, AlertCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { FtdcResults } from "@/lib/ftdc";

interface MigrationOverviewProps {
  data: FtdcResults;
}

function StatCard({ icon: Icon, label, value, sublabel }: {
  icon: React.ComponentType<{ className?: string }>,
  label: string,
  value: string | number,
  sublabel?: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sublabel && <div className="text-xs text-muted-foreground">{sublabel}</div>}
    </div>
  );
}

export function MigrationOverview({ data }: MigrationOverviewProps) {
  // Extract current system info
  const host = data.host || {};
  const sizing = data.sizing_recommendation;
  const assessment = data.assessment_v2;
  const ranked = assessment?.ranked || [];

  // Current system metrics (from FTDC)
  const cpuCores = host.num_cores || "—";
  const totalRamGB = host.mem_mb ? Math.round(host.mem_mb / 1024) : "—";
  const cacheGB = sizing?.current?.ram_gb || "—";
  const storageGB = sizing?.current?.storage_gb || sizing?.storage_sizing?.on_disk_gb || "—";

  // Replica set info (from healthcheck if available)
  const replicaSet = host.cluster_role || "—";
  const members = "—"; // Not directly available in current schema
  const isSharded = false; // Would need to check healthcheck structure

  // Atlas recommendation
  const recommendedTier = sizing?.recommended || "—";
  const recommendedOption = sizing?.options?.find(opt => opt.tier?.name === sizing?.recommended);

  // Fired categories for evidence
  const firedCategories = ranked.filter((c: any) => c.fired);
  const topIssues = firedCategories.slice(0, 3);

  return (
    <div className="space-y-8 p-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Atlas Migration Sizing</h1>
        <p className="text-muted-foreground">
          Analysis of current Community Edition deployment with recommended Atlas tier configuration
        </p>
      </div>

      {/* Current System */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Server className="size-5 text-primary" />
          <h2 className="text-xl font-semibold">Current System (Community Edition)</h2>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          <StatCard
            icon={Cpu}
            label="CPU Cores"
            value={cpuCores}
            sublabel={typeof cpuCores === 'number' ? `${cpuCores} vCPU` : undefined}
          />
          <StatCard
            icon={MemoryStick}
            label="Total RAM"
            value={typeof totalRamGB === 'number' ? `${totalRamGB} GB` : totalRamGB}
            sublabel={typeof cacheGB === 'number' ? `Cache: ${cacheGB} GB` : undefined}
          />
          <StatCard
            icon={HardDrive}
            label="Storage"
            value={typeof storageGB === 'number' ? `${storageGB} GB` : storageGB}
          />
          <StatCard
            icon={Database}
            label="Deployment"
            value={isSharded ? "Sharded" : "Replica Set"}
            sublabel={replicaSet !== "—" ? `RS: ${replicaSet}` : undefined}
          />
          {members !== "—" && (
            <StatCard
              icon={Users}
              label="Members"
              value={members}
              sublabel={`${members} nodes`}
            />
          )}
        </div>

        {/* System health indicator */}
        {host.hostname && (
          <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
            <span className="font-medium">Hostname:</span> {host.hostname}
            {host.mongo_version && (
              <span className="ml-4">
                <span className="font-medium">MongoDB:</span> {host.mongo_version}
              </span>
            )}
          </div>
        )}
      </section>

      {/* Arrow indicator */}
      <div className="flex items-center justify-center py-4">
        <div className="flex flex-col items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-6 py-3">
          <ArrowDown className="size-8 text-primary" />
          <span className="text-sm font-medium text-primary">Recommended Migration</span>
        </div>
      </div>

      {/* Recommended Atlas Configuration */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Database className="size-5 text-primary" />
          <h2 className="text-xl font-semibold">Recommended Atlas Configuration</h2>
        </div>

        <div className="rounded-lg border-2 border-primary/20 bg-primary/5 p-6">
          <div className="mb-6 flex items-center gap-3">
            <Badge variant="default" className="text-lg px-4 py-1">
              {recommendedTier}
            </Badge>
            {sizing?.cloud && (
              <Badge variant="secondary">
                {sizing.cloud.toUpperCase()}
              </Badge>
            )}
          </div>

          {recommendedOption?.tier && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <StatCard
                icon={Cpu}
                label="vCPU"
                value={recommendedOption.tier.vcpu || "—"}
              />
              <StatCard
                icon={MemoryStick}
                label="RAM"
                value={recommendedOption.tier.ram_gb ? `${recommendedOption.tier.ram_gb} GB` : "—"}
              />
              <StatCard
                icon={HardDrive}
                label="Storage"
                value={recommendedOption.tier.default_storage_gb ? `${recommendedOption.tier.default_storage_gb} GB` : "—"}
              />
              {recommendedOption.tier.default_iops && (
                <StatCard
                  icon={HardDrive}
                  label="IOPS"
                  value={recommendedOption.tier.default_iops}
                />
              )}
            </div>
          )}

          {recommendedOption?.rationale && (
            <div className="mt-4 rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
              <span className="font-medium">Recommendation:</span> {recommendedOption.rationale}
            </div>
          )}
        </div>
      </section>

      {/* Analysis & Evidence */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Analysis & Evidence</h2>

        {topIssues.length > 0 ? (
          <div className="space-y-3">
            {topIssues.map((category: any) => (
              <Card key={category.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-base">{category.name}</CardTitle>
                      <CardDescription className="text-sm">
                        {category.title || category.tagline}
                      </CardDescription>
                    </div>
                    <Badge variant={category.fired ? "destructive" : "secondary"}>
                      {category.fired ? "Issue Detected" : "OK"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {category.ledger?.filter((s: any) => s.passed).slice(0, 3).map((signal: any, idx: number) => (
                    <div key={idx} className="flex items-start gap-2 text-sm">
                      <AlertCircle className="size-4 mt-0.5 shrink-0 text-destructive" />
                      <div>
                        <span className="font-medium">{signal.signal}:</span>{" "}
                        <span className="text-muted-foreground">
                          {signal.summary || `Threshold exceeded (weight: ${signal.weight})`}
                        </span>
                      </div>
                    </div>
                  ))}
                  {category.confidence && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Confidence: {(category.confidence * 100).toFixed(0)}%
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex items-center gap-3 py-6">
              <CheckCircle2 className="size-5 text-green-600" />
              <div>
                <p className="font-medium">System appears well-provisioned</p>
                <p className="text-sm text-muted-foreground">
                  No significant capacity or performance issues detected. The recommended tier provides appropriate headroom for growth.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Methodology note */}
        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          <p className="font-medium mb-2">Analysis Methodology</p>
          <p>
            This assessment is based on deterministic analysis of FTDC metrics and healthcheck data.
            The recommendation considers current resource utilization, workload patterns, and MongoDB best practices
            to suggest an Atlas tier that provides adequate capacity with appropriate headroom.
          </p>
        </div>
      </section>
    </div>
  );
}
