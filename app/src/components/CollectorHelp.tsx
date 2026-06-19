import { useState } from "react";
import { Check, Copy, ShieldAlert } from "lucide-react";

// Small copyable code block.
function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      {label && <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>}
      <div className="relative">
        <pre className="overflow-x-auto rounded-md border border-border bg-[#0B1726] p-2.5 pr-9 font-mono text-[11px] leading-relaxed text-foreground/90">
          {code}
        </pre>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
          title="Copy"
          className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}

function SecurityNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-[#F5A623]/30 bg-[#F5A623]/5 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-[#F5A623]" />
      <span>{children}</span>
    </div>
  );
}

export function HealthcheckHelp() {
  return (
    <div className="space-y-2.5">
      <p className="text-[11px] leading-snug text-muted-foreground">
        A healthcheck snapshot captures per-database/collection storage and <b>index-usage</b>{" "}
        statistics that FTDC (host-level only) cannot see. This repo bundles an allinfo-style
        collector at <span className="font-mono">collectors/getMongoData.js</span> — lineage:
        the open-source getMongoData.js / Keyhole healthcheck tooling (Apache-2.0).
      </p>
      <CodeBlock
        label="Run (writes healthcheck.json)"
        code={'mongosh "<connection-uri>" --quiet --file collectors/getMongoData.js > healthcheck.json'}
      />
      <CodeBlock
        label="Least-privilege role (clusterMonitor + readAnyDatabase)"
        code={`db.getSiblingDB("admin").createRole({
  role: "ftdcHealthcheck", privileges: [],
  roles: ["clusterMonitor", "readAnyDatabase"]
})`}
      />
      <SecurityNote>
        Run on each replica-set member ideally (storage stats are per-node). The output is
        schema-revealing (db/collection/index names, sizes) — treat it as <b>local-only</b>, like
        FTDC. No document contents or query predicates are collected.
      </SecurityNote>
    </div>
  );
}

export function ProfilerHelp() {
  return (
    <div className="space-y-2.5">
      <p className="text-[11px] leading-snug text-muted-foreground">
        The database profiler / slow-query log reveals which queries are slow and why (COLLSCAN,
        poor targeting) — the per-query truth FTDC's host-level proxy can't give.
      </p>
      <CodeBlock
        label="Enable profiling for ops slower than 100ms"
        code={"db.setProfilingLevel(1, { slowms: 100 })"}
      />
      <CodeBlock
        label="Export the slowest query shapes from system.profile"
        code={`db.system.profile.find(
  { millis: { $gte: 100 }, ns: { $not: /^admin\\.|\\.system\\./ } }
).sort({ millis: -1 }).limit(200).toArray()
// or: mongoexport --uri "<uri>" -d <db> -c system.profile \\
//       -q '{"millis":{"$gte":100}}' --out profiler.json`}
      />
      <CodeBlock
        label="Alternatively, point at the mongod slow-query log"
        code={`# mongod.conf:  operationProfiling.slowOpThresholdMs: 100
# slow ops are logged to the mongod log as COMMAND/QUERY lines
db.setProfilingLevel(0)   # disable profiling when finished`}
      />
      <SecurityNote>
        Profiling adds overhead — use a temporary <span className="font-mono">slowms</span> and
        disable when done. Profiler/log entries can include query predicates (potential PII /
        sensitive values) — handle the export <b>locally</b>.
      </SecurityNote>
    </div>
  );
}
