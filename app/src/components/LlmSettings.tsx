import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  Save,
  Send,
  Star,
  Trash2,
  X,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  type ChatResponse,
  type Dialect,
  type LabeledModel,
  type LlmConfig,
  type LlmProvider,
  ANTHROPIC_FALLBACK_MODELS,
  DIALECTS,
  activeProvider,
  getLlmConfig,
  labelModelsForDialect,
  makeClient,
  setLlmConfig,
} from "@/lib/llm";

type TestState = { state: "idle" | "testing" | "ok" | "err"; msg?: string };

function blankProvider(): LlmProvider {
  return {
    id: `p-${Date.now()}`,
    label: "",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    dialect: "openai",
  };
}

export function LlmSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [models, setModels] = useState<LabeledModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [pinging, setPinging] = useState(false);
  const [ping, setPing] = useState<ChatResponse | null>(null);

  const loadModels = useCallback(async (c: LlmConfig) => {
    const ap = activeProvider(c);
    if (!ap) return;
    setModelsLoading(true);
    setModelsErr(null);
    try {
      const res = await makeClient(ap).listModels();
      setModels(labelModelsForDialect(res.models, ap.dialect).filter((m) => m.selectable));
    } catch (e) {
      if (ap.dialect === "anthropic") {
        setModels(labelModelsForDialect(ANTHROPIC_FALLBACK_MODELS, "anthropic"));
        setModelsErr("couldn't reach Anthropic — showing known models (chat needs a valid key)");
      } else {
        setModels([]);
        setModelsErr(String(e));
      }
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    getLlmConfig()
      .then((c) => {
        setCfg(c);
        void loadModels(c);
      })
      .catch(() => {});
  }, [open, loadModels]);

  function save(next: LlmConfig) {
    setCfg(next);
    setLlmConfig(next).catch(() => {});
  }

  function setActive(id: string) {
    if (!cfg) return;
    const next = { ...cfg, activeId: id, model: null };
    save(next);
    setPing(null);
    void loadModels(next);
  }

  function upsertProvider(p: LlmProvider) {
    if (!cfg) return;
    const exists = cfg.providers.some((x) => x.id === p.id);
    const providers = exists ? cfg.providers.map((x) => (x.id === p.id ? p : x)) : [...cfg.providers, p];
    const next = { ...cfg, providers, activeId: p.id };
    save(next);
    setEditing(null);
    void loadModels(next);
  }

  function duplicate(p: LlmProvider) {
    if (!cfg) return;
    setEditing({ ...p, id: `p-${Date.now()}`, label: `${p.label} (copy)` });
  }

  function remove(id: string) {
    if (!cfg || id === "endpoint") return;
    const providers = cfg.providers.filter((p) => p.id !== id);
    const activeId = cfg.activeId === id ? "endpoint" : cfg.activeId;
    save({ ...cfg, providers, activeId });
  }

  async function testProvider(p: LlmProvider) {
    setTests((t) => ({ ...t, [p.id]: { state: "testing" } }));
    try {
      const res = await makeClient(p).listModels();
      setTests((t) => ({ ...t, [p.id]: { state: "ok", msg: `${res.count} models` } }));
    } catch (e) {
      setTests((t) => ({ ...t, [p.id]: { state: "err", msg: String(e) } }));
    }
  }

  function pickModel(id: string) {
    if (!cfg) return;
    save({ ...cfg, model: id });
  }

  async function pingModel() {
    if (!cfg || !cfg.model) return;
    const ap = activeProvider(cfg);
    setPinging(true);
    setPing(null);
    try {
      const res = await makeClient(ap).chat([{ role: "user", content: "Reply with: OK" }], cfg.model, {
        max_tokens: 16,
        temperature: 0,
      });
      setPing(res);
    } finally {
      setPinging(false);
    }
  }

  const active = cfg ? activeProvider(cfg) : null;
  const local = models.filter((m) => m.tier === "local");
  const cloud = models.filter((m) => m.tier === "cloud");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[92vw] max-w-2xl flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <PlugZap className="size-4 text-primary" /> LLM Providers
          </DialogTitle>
          <DialogDescription>
            Manage OpenAI-compatible and Anthropic/Claude endpoints. Pick the active one + model;
            the assessment falls back to the default if the active provider is unreachable. API
            keys are stored locally in the app config store, never logged.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {!cfg ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> loading…
            </div>
          ) : (
            <>
              {/* Provider list */}
              <div className="space-y-2">
                {cfg.providers.map((p) => {
                  const isActive = p.id === cfg.activeId;
                  const t = tests[p.id];
                  return (
                    <div
                      key={p.id}
                      className={
                        "rounded-lg border p-3 " +
                        (isActive ? "border-primary bg-primary/5" : "border-border")
                      }
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <button onClick={() => setActive(p.id)} title="Make active" className="shrink-0">
                          <Star className={"size-4 " + (isActive ? "fill-primary text-primary" : "text-muted-foreground")} />
                        </button>
                        <span className="text-sm font-medium">{p.label || "(unnamed)"}</span>
                        <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground">
                          {p.dialect}
                        </Badge>
                        {p.id === "endpoint" && (
                          <Badge variant="secondary" className="text-[9px] uppercase">default</Badge>
                        )}
                        {isActive && (
                          <Badge className="text-[9px]" style={{ backgroundColor: "#00ED64", color: "#0D1B2A" }}>
                            active
                          </Badge>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                          <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px]" onClick={() => testProvider(p)}>
                            {t?.state === "testing" ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                            Test
                          </Button>
                          <Button size="sm" variant="ghost" className="size-7 p-0" title="Edit" onClick={() => setEditing({ ...p })}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="size-7 p-0" title="Duplicate" onClick={() => duplicate(p)}>
                            <Copy className="size-3.5" />
                          </Button>
                          {p.id !== "endpoint" && (
                            <Button size="sm" variant="ghost" className="size-7 p-0 text-muted-foreground hover:text-destructive" title="Delete" onClick={() => remove(p.id)}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 pl-6 font-mono text-[11px] text-muted-foreground">{p.baseUrl}</div>
                      {t && t.state !== "testing" && (
                        <div className={"mt-1 pl-6 text-[11px] " + (t.state === "ok" ? "text-primary" : "text-destructive")}>
                          {t.state === "ok" ? <Check className="mr-1 inline size-3" /> : <X className="mr-1 inline size-3" />}
                          {t.msg}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!editing && (
                  <Button size="sm" variant="outline" className="h-8 w-full gap-1.5 text-xs" onClick={() => setEditing(blankProvider())}>
                    <Plus className="size-4" /> Add provider
                  </Button>
                )}
              </div>

              {/* Add/edit form */}
              {editing && (
                <div className="space-y-2.5 rounded-lg border border-primary/40 bg-secondary/20 p-3">
                  <div className="text-xs font-semibold">{cfg.providers.some((x) => x.id === editing.id) ? "Edit provider" : "Add provider"}</div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      Label
                      <Input className="h-8 text-xs" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} placeholder="e.g. My OpenAI" />
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      Dialect
                      <select
                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        value={editing.dialect}
                        onChange={(e) => {
                          const d = e.target.value as Dialect;
                          const def = DIALECTS.find((x) => x.id === d)?.defaultBaseUrl ?? editing.baseUrl;
                          setEditing({ ...editing, dialect: d, baseUrl: editing.baseUrl || def });
                        }}
                      >
                        {DIALECTS.map((d) => (
                          <option key={d.id} value={d.id}>{d.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="space-y-1 text-[11px] text-muted-foreground">
                    Base URL
                    <Input className="h-8 font-mono text-xs" value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://…" />
                  </label>
                  <label className="space-y-1 text-[11px] text-muted-foreground">
                    API key <span className="opacity-60">(optional; stored locally)</span>
                    <Input type="password" className="h-8 font-mono text-xs" value={editing.apiKey ?? ""} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value || null })} placeholder={editing.dialect === "anthropic" ? "sk-ant-… (required for Claude)" : "optional"} />
                  </label>
                  <div className="flex items-center gap-2">
                    <Button size="sm" className="h-8 gap-1.5 text-xs" disabled={!editing.label.trim() || !editing.baseUrl.trim()} onClick={() => upsertProvider({ ...editing, label: editing.label.trim(), baseUrl: editing.baseUrl.trim() })}>
                      <Save className="size-4" /> Save provider
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              )}

              <Separator />

              {/* Active provider model picker + ping */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-muted-foreground">Active model</span>
                  {active && <Badge variant="outline" className="text-[10px] text-muted-foreground">{active.label}</Badge>}
                  <span className="font-mono text-foreground">{cfg.model ?? "— none —"}</span>
                </div>
                {modelsLoading ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> loading models…
                  </div>
                ) : (
                  <>
                    {modelsErr && <div className="text-[11px] text-[#F5A623]">{modelsErr}</div>}
                    {[["local", local] as const, ["cloud", cloud] as const].map(([tier, list]) =>
                      list.length === 0 ? null : (
                        <div key={tier} className="space-y-1">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {list[0].label}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {list.map((m) => (
                              <button
                                key={m.id}
                                onClick={() => pickModel(m.id)}
                                className={
                                  "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors " +
                                  (cfg.model === m.id ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-secondary/40")
                                }
                              >
                                {m.id}
                                {m.reasoningOnly ? " ·r" : ""}
                              </button>
                            ))}
                          </div>
                        </div>
                      ),
                    )}
                  </>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={!cfg.model || pinging} onClick={pingModel}>
                    {pinging ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                    Ping (dev round-trip)
                  </Button>
                  {ping && (
                    <span className={"font-mono text-[11px] " + (ping.ok ? "text-primary" : "text-destructive")}>
                      {ping.ok ? `reply: ${JSON.stringify(ping.content)}` : `[${ping.kind}] ${ping.error}`}
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
