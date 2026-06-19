"""Render a results.json (from ftdc_analyzer.verdicts) into a single self-contained
interactive HTML report (dark, MongoDB-branded). Plotly via CDN by default, or fully
inlined with --inline-plotly for an offline copy.
"""

import os
import glob
import json
import html
import argparse
import datetime
import urllib.request

PLOTLY_URL = "https://cdn.plot.ly/plotly-2.35.2.min.js"

# Catalog category whose placeholder charts are replaced by populated structural snapshot
# tiles when a healthcheck is present (mirrors the live Charts tab; see render_html).
STRUCTURAL_CATEGORY = "Indexes & Storage"

PALETTE = {
    "bg": "#0D1B2A", "panel": "#12243A", "border": "#1E3450",
    "text": "#E6EDF3", "muted": "#8AA0B6",
    "green": "#00ED64", "blue": "#4DA6FF", "amber": "#FFC857",
    "coral": "#FF6B6B", "purple": "#B392F0", "teal": "#3DDBD9", "slate": "#5A6E82",
}
VERDICT_BADGES = {
    "UNDERSIZED": PALETTE["coral"], "SATURATED": PALETTE["coral"],
    "CONSTRAINED": PALETTE["amber"], "HOLD": PALETTE["green"],
    "REDUCE": PALETTE["blue"],
}
STATUS_COLORS = {"PASS": PALETTE["green"], "WARN": PALETTE["amber"],
                 "FAIL": PALETTE["coral"], "NA": PALETTE["muted"]}
ROLE_COLORS = {"PRIMARY": PALETTE["green"], "SECONDARY": PALETTE["slate"]}

# Single source of truth: drives both the rendered chart divs and the JS draw loop.
CHARTS = [
    {"title": "A · Cache & Memory", "full": False, "charts": [
        {"id": "c_cache", "title": "Cache used % / dirty %",
         "specs": [{"name": "cache_used_pct", "label": "used %", "color": PALETTE["green"]},
                   {"name": "cache_dirty_pct", "label": "dirty %", "color": PALETTE["amber"]}],
         "reflines": [{"y": 80, "label": "80% target", "color": PALETTE["muted"]},
                      {"y": 5, "label": "5% dirty", "color": PALETTE["coral"]}]},
        {"id": "c_mem", "title": "mongod alloc / page cache (GB)",
         "specs": [{"name": "mongod_alloc_gb", "label": "mongod alloc GB", "color": PALETTE["green"]},
                   {"name": "page_cache_gb", "label": "page cache GB", "color": PALETTE["blue"]}],
         "reflines": []},
    ]},
    {"title": "B · CPU", "full": False, "charts": [
        {"id": "c_cpu", "title": "CPU util % / iowait %",
         "specs": [{"name": "cpu_util_pct", "label": "util %", "color": PALETTE["green"]},
                   {"name": "cpu_iowait_pct", "label": "iowait %", "color": PALETTE["amber"]}],
         "reflines": []},
    ]},
    {"title": "C · Disk (nvme1n1)", "full": True, "charts": [
        {"id": "c_dutil", "title": "Disk utilization %",
         "specs": [{"name": "disk_util_pct", "label": "util %", "color": PALETTE["blue"]}],
         "reflines": [{"y": 85, "label": "85% saturated", "color": PALETTE["coral"]}]},
        {"id": "c_diops", "title": "IOPS (read / write)",
         "specs": [{"name": "read_iops", "label": "read iops", "color": PALETTE["blue"]},
                   {"name": "write_iops", "label": "write iops", "color": PALETTE["green"]}],
         "reflines": []},
        {"id": "c_dmbps", "title": "Throughput MB/s (read / write)",
         "specs": [{"name": "read_mbps", "label": "read MB/s", "color": PALETTE["blue"]},
                   {"name": "write_mbps", "label": "write MB/s", "color": PALETTE["green"]}],
         "reflines": []},
        {"id": "c_dlat", "title": "Avg service time ms (read / write)",
         "specs": [{"name": "avg_read_ms", "label": "avg read ms", "color": PALETTE["blue"]},
                   {"name": "avg_write_ms", "label": "avg write ms", "color": PALETTE["amber"]}],
         "reflines": []},
    ]},
    {"title": "D · Throughput & Replication", "full": False, "charts": [
        {"id": "c_ops", "title": "Query ops/s / repl writes/s",
         "specs": [{"name": "ops_query_ps", "label": "query ops/s", "color": PALETTE["green"]},
                   {"name": "repl_writes_ps", "label": "repl writes/s", "color": PALETTE["blue"]}],
         "reflines": []},
        {"id": "c_wt", "title": "WT pages read-in / written per s",
         "specs": [{"name": "wt_pages_read_into_cache_ps", "label": "pages read-in/s", "color": PALETTE["blue"]},
                   {"name": "wt_pages_written_ps", "label": "pages written/s", "color": PALETTE["amber"]}],
         "reflines": []},
        {"id": "c_lag", "title": "Replication lag (s)",
         "specs": [{"name": "repl_lag_s", "label": "repl lag s", "color": PALETTE["green"]}],
         "reflines": []},
    ]},
    {"title": "E · Contention & Connections", "full": False, "charts": [
        {"id": "c_queue", "title": "Global lock queue (read / write)",
         "specs": [{"name": "read_queue", "label": "read queue", "color": PALETTE["blue"]},
                   {"name": "write_queue", "label": "write queue", "color": PALETTE["amber"]}],
         "reflines": []},
        {"id": "c_conn", "title": "Current connections",
         "specs": [{"name": "connections_current", "label": "connections", "color": PALETTE["green"]}],
         "reflines": []},
    ]},
]

CSS = """
:root{color-scheme:dark;}
*{box-sizing:border-box;}
body{margin:0;background:__BG__;color:__TEXT__;
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  line-height:1.5;}
.wrap{max-width:1200px;margin:0 auto;padding:28px 20px 60px;}
a{color:__BLUE__;}
.muted{color:__MUTED__;}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.panel{background:__PANEL__;border:1px solid __BORDER__;border-radius:12px;
  padding:18px 20px;margin:18px 0;}
h1{font-size:24px;margin:0 0 4px;}
h2{font-size:17px;margin:0 0 14px;color:__TEXT__;font-weight:600;
  letter-spacing:.02em;}
h3{font-size:13px;margin:0 0 8px;color:__MUTED__;font-weight:600;}
.header .row{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;
  font-weight:700;letter-spacing:.04em;color:#0D1B2A;}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11px;
  border:1px solid __BORDER__;color:__MUTED__;}
.hwline{margin-top:8px;font-size:13px;}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px;}
.card{background:__PANEL__;border:1px solid __BORDER__;border-radius:12px;padding:16px 18px;}
.card .vhead{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.vbadge{font-size:15px;font-weight:800;padding:4px 12px;border-radius:8px;color:#0D1B2A;}
.headline{font-size:13px;margin:8px 0;color:__TEXT__;}
.rec{font-size:12px;color:__MUTED__;margin:8px 0;}
.vcpu{font-size:13px;margin:6px 0;}
.vcpu b{font-size:22px;color:__GREEN__;}
table{width:100%;border-collapse:collapse;font-size:12px;}
.checks td{padding:4px 6px;border-top:1px solid __BORDER__;}
.checks td:nth-child(2),.checks td:nth-child(3){text-align:right;}
.st{font-weight:700;}
.sig th,.sig td{padding:5px 10px;text-align:right;border-top:1px solid __BORDER__;}
.sig th:first-child,.sig td:first-child{text-align:left;}
.sig th:nth-child(2),.sig td:nth-child(2){text-align:left;}
.sig tbody tr:nth-child(odd){background:rgba(255,255,255,.025);}
.sig thead th{color:__MUTED__;border-top:none;font-weight:600;}
.cgrid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(480px,1fr));}
.cgrid.full{grid-template-columns:1fr;}
.chartcard{background:rgba(255,255,255,.015);border:1px solid __BORDER__;
  border-radius:10px;padding:10px 10px 4px;}
.plot{width:100%;height:280px;}
.nodata{color:__MUTED__;font-size:13px;padding:30px;text-align:center;}
.footer{font-size:12px;color:__MUTED__;}
.footer ul{margin:6px 0;padding-left:18px;}
.siggrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px;margin-top:10px;}
.sigcard{background:rgba(255,255,255,.02);border:1px solid __BORDER__;border-radius:10px;
  padding:12px 14px;}
.sigcard ul{margin:6px 0;padding-left:16px;}
.sigcard li{font-size:11px;color:__MUTED__;}
.sbadge{display:inline-block;padding:1px 8px;border-radius:6px;font-size:11px;font-weight:700;
  color:#0D1B2A;margin-right:8px;}
.sectionlead{font-size:12px;color:__MUTED__;margin:-6px 0 14px;}
.tilegrid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));}
.tile{background:rgba(255,255,255,.015);border:1px solid __BORDER__;border-radius:10px;padding:12px 14px;}
.tile h3{margin:0 0 8px;color:__TEXT__;font-size:13px;}
.kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;}
.kv span:first-child{color:__MUTED__;}
.bar{height:10px;border-radius:4px;background:rgba(255,255,255,.07);overflow:hidden;margin:3px 0;}
.bar>i{display:block;height:100%;border-radius:4px;}
.barrow{display:flex;align-items:center;gap:8px;font-size:11px;margin:3px 0;}
.barrow .lbl{width:150px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:__MUTED__;}
.barrow .bar{flex:1;margin:0;}
.barrow .val{width:120px;flex:none;text-align:right;}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:10px;border:1px solid __BORDER__;}
.catcard{background:rgba(255,255,255,.02);border:1px solid __BORDER__;border-radius:10px;
  padding:12px 14px;margin:10px 0;}
.catcard.fired{border-left:3px solid __CORAL__;}
.confbar{height:8px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden;margin:6px 0;max-width:320px;}
.led{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;}
.led th,.led td{padding:3px 7px;border-top:1px solid __BORDER__;text-align:right;}
.led th:first-child,.led td:first-child{text-align:left;}
.led thead th{color:__MUTED__;border-top:none;}
.cav{font-size:11px;color:__AMBER__;margin:3px 0;}
.optcard{background:rgba(255,255,255,.02);border:1px solid __BORDER__;border-radius:10px;padding:12px 14px;}
.optcard.rec{border:1px solid __GREEN__;}
.optcard.dim{opacity:.55;}
.grp{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:__MUTED__;margin:14px 0 4px;}
"""

JS = """
(function(){
  function parse(id){try{return JSON.parse(document.getElementById(id).textContent);}catch(e){return null;}}
  var DATA = parse('ftdc-data') || {};
  var CFG = parse('ftdc-charts') || [];
  var SERIES = DATA.series || {};
  function clean(v){return (v===null||v===undefined||(typeof v==='number'&&!isFinite(v)))?null:v;}
  function ser(name){
    var s = SERIES[name];
    if(!s || !s.t || !s.t.length) return null;
    return {x: s.t.map(function(ms){return new Date(ms);}), y: s.v.map(clean)};
  }
  function draw(c){
    var div = document.getElementById(c.id);
    if(!div) return;
    var traces = [];
    (c.specs||[]).forEach(function(sp){
      var d = ser(sp.name);
      if(d){traces.push({x:d.x,y:d.y,name:sp.label,mode:'lines',type:'scatter',
        connectgaps:false,line:{color:sp.color,width:1.5},
        hovertemplate:'%{y}<extra>'+sp.label+'</extra>'});}
    });
    if(!traces.length){div.innerHTML='<div class="nodata">(no data)</div>';return;}
    var shapes = (c.reflines||[]).map(function(r){
      return {type:'line',xref:'paper',x0:0,x1:1,y0:r.y,y1:r.y,
        line:{color:r.color||'#8AA0B6',width:1,dash:'dash'}};});
    var ann = (c.reflines||[]).map(function(r){
      return {xref:'paper',x:1,xanchor:'right',y:r.y,yanchor:'bottom',
        text:r.label||('ref '+r.y),showarrow:false,font:{color:r.color||'#8AA0B6',size:10}};});
    var layout = {paper_bgcolor:'#12243A',plot_bgcolor:'#12243A',
      font:{color:'#E6EDF3',size:11},margin:{l:55,r:18,t:8,b:34},height:280,
      hovermode:'x unified',showlegend:true,
      legend:{orientation:'h',y:1.16,x:0,font:{size:11}},
      xaxis:{type:'date',gridcolor:'#1E3450',zeroline:false},
      yaxis:{gridcolor:'#1E3450',zeroline:false,rangemode:'tozero'},
      shapes:shapes,annotations:ann};
    Plotly.newPlot(c.id, traces, layout, {displayModeBar:false,responsive:true,displaylogo:false});
  }
  function run(){
    if(typeof Plotly==='undefined'){
      document.querySelectorAll('.plot').forEach(function(d){
        d.innerHTML='<div class="nodata">Plotly failed to load (offline + CDN build?).</div>';});
      return;
    }
    CFG.forEach(function(sec){(sec.charts||[]).forEach(draw);});
  }
  if(document.readyState!=='loading'){run();}else{document.addEventListener('DOMContentLoaded',run);}
})();
"""


# ---------------------------------------------------------------------------
# HTML helpers
# ---------------------------------------------------------------------------
def _e(x):
    return html.escape("" if x is None else str(x))


def _num(x):
    return "—" if x is None else f"{x:,.3f}"


def _apply_palette(s):
    return (s.replace("__BG__", PALETTE["bg"]).replace("__PANEL__", PALETTE["panel"])
            .replace("__BORDER__", PALETTE["border"]).replace("__TEXT__", PALETTE["text"])
            .replace("__MUTED__", PALETTE["muted"]).replace("__BLUE__", PALETTE["blue"])
            .replace("__GREEN__", PALETTE["green"]).replace("__CORAL__", PALETTE["coral"])
            .replace("__AMBER__", PALETTE["amber"]))


def _fmt_bytes(b):
    """Decimal byte units (disk-vendor convention; matches the engine)."""
    if b is None or (isinstance(b, float) and b != b):
        return "—"
    b = float(b)
    if b == 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    import math as _m
    i = min(len(units) - 1, int(_m.log10(abs(b)) / 3)) if b else 0
    v = b / (1000 ** i)
    return f"{v:,.0f} {units[i]}" if v >= 100 else f"{v:,.2f} {units[i]}"


def _compact(n):
    if n is None:
        return "—"
    n = float(n)
    for unit, div in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if abs(n) >= div:
            return f"{n / div:.1f}{unit}"
    return f"{n:,.0f}"


def _bar(pct, color):
    pct = max(0, min(100, pct or 0))
    return f"<div class='bar'><i style='width:{pct:.0f}%;background:{color}'></i></div>"


def _header_html(results):
    h = results.get("host", {}) or {}
    c = results.get("capture", {}) or {}
    role = h.get("role") or "UNKNOWN"
    role_color = ROLE_COLORS.get(role, PALETTE["muted"])
    mem_gb = (h.get("mem_mb") or 0) / 1024
    return f"""
    <div class="panel header">
      <div class="row">
        <h1>{_e(h.get('hostname'))}</h1>
        <span class="badge" style="background:{role_color}">{_e(role)}</span>
        <span class="muted">MongoDB {_e(h.get('mongo_version'))}</span>
      </div>
      <div class="muted" style="margin-top:6px;">
        {_e(c.get('first_ts_iso'))} &rarr; {_e(c.get('last_ts_iso'))}
        &nbsp;·&nbsp; span {_e(c.get('span_seconds'))} s
        &nbsp;·&nbsp; {_e(c.get('samples'))} samples
      </div>
      <div class="hwline">
        <span class="pill">{_e(h.get('num_cores'))} cores</span>
        <span class="pill">{mem_gb:.1f} GB RAM</span>
        <span class="pill">data disk: {_e(h.get('data_disk'))}</span>
      </div>
    </div>"""


def _checks_table(checks):
    rows = []
    for chk in checks or []:
        col = STATUS_COLORS.get(chk.get("status"), PALETTE["muted"])
        thr = chk.get("threshold")
        thr_s = "n/a" if thr is None else _e(thr)
        rows.append(
            f"<tr><td>{_e(chk.get('name'))}</td>"
            f"<td class='mono'>{_e(chk.get('value'))}</td>"
            f"<td class='mono'>{thr_s}</td>"
            f"<td class='st' style='color:{col}'>{_e(chk.get('status'))}</td></tr>")
    return "<table class='checks'>" + "".join(rows) + "</table>"


def _verdict_card(title, v):
    if not v:
        return f"<div class='card'><h2>{_e(title)}</h2><div class='muted'>(no verdict)</div></div>"
    verdict = v.get("verdict", "?")
    color = VERDICT_BADGES.get(verdict, PALETTE["muted"])
    vcpu = ""
    if v.get("recommended_vcpus") is not None:
        vcpu = f"<div class='vcpu'>recommended vCPUs: <b>{_e(v['recommended_vcpus'])}</b></div>"
    return f"""
    <div class="card">
      <h2>{_e(title)}</h2>
      <div class="vhead">
        <span class="vbadge" style="background:{color}">{_e(verdict)}</span>
        <span class="pill">confidence: {_e(v.get('confidence'))}</span>
      </div>
      <div class="headline">{_e(v.get('headline'))}</div>
      {vcpu}
      <div class="rec">{_e(v.get('recommendation'))}</div>
      {_checks_table(v.get('checks'))}
    </div>"""


_REPORT_PALETTE = ["#00ED64", "#4DA6FF", "#FFC857", "#E05C4B", "#B392F0", "#3DDBD9"]
_SIG_COLORS = {"OK": "#00ED64", "INFO": "#5A6E82", "WARN": "#F5A623", "CRITICAL": "#E05C4B"}


def _catalog_to_chart_config(results):
    """Convert results.chart_catalog → the report's chart-config shape (ids/specs/
    reflines), so the HTML report renders the full data-driven catalog. Falls back
    to the built-in CHARTS if no catalog is present."""
    catalog = results.get("chart_catalog")
    if not catalog:
        return CHARTS
    cfg = []
    cid = 0
    for category in catalog:
        charts = []
        for ch in category.get("charts", []):
            cid += 1
            specs, reflines = [], []
            for i, e in enumerate(ch.get("series", [])):
                specs.append({"name": e["key"], "label": e.get("label", e["key"]),
                              "color": _REPORT_PALETTE[i % len(_REPORT_PALETTE)]})
                if e.get("refLine") is not None:
                    reflines.append({"y": e["refLine"],
                                     "label": e.get("refLabel") or f"ref {e['refLine']}",
                                     "color": "#F5A623"})
            charts.append({"id": f"cat_{cid}", "title": ch.get("title", ""),
                           "specs": specs, "reflines": reflines})
        cfg.append({"title": category.get("category", ""),
                    "full": str(category.get("category", "")).startswith("Disk"),
                    "charts": charts})
    return cfg


def _assessment_html(results):
    a = results.get("assessment")
    if not a:
        return ""
    sev_rank = {"CRITICAL": 0, "WARN": 1, "INFO": 2, "OK": 3}
    sigs = sorted(a.get("signatures", []), key=lambda s: sev_rank.get(s.get("severity"), 9))
    cards = []
    for s in sigs:
        color = _SIG_COLORS.get(s.get("severity"), "#5A6E82")
        syms = "".join(f"<li class='mono'>{_e(x)}</li>" for x in s.get("symptoms", []))
        cards.append(
            f"<div class='sigcard' style='border-left:3px solid {color}'>"
            f"<div><span class='sbadge' style='background:{color}'>{_e(s.get('severity'))}</span>"
            f"<b>{_e(s.get('title'))}</b> <span class='muted'>· {_e(s.get('purpose'))}</span></div>"
            f"<ul>{syms}</ul>"
            f"<div class='rec'>{_e(s.get('recommendation'))}</div></div>")
    purposes = " ".join(f"<span class='pill'>{_e(p)}</span>"
                        for p in a.get("purposes_covered", []))
    return (f"<div class='panel'><h2>First-draft inference — {_e(a.get('posture'))}</h2>"
            f"<div class='headline'>{_e(a.get('headline'))}</div>"
            f"<div style='margin:8px 0'>{purposes}</div>"
            f"<div class='siggrid'>" + "".join(cards) + "</div></div>")


def _cost_html(results):
    co = results.get("cost_optimization")
    if not co or not co.get("actions"):
        return ""
    rows = []
    for act in co["actions"]:
        rows.append(
            f"<div class='sigcard'><div><b>{_e(act.get('resource'))}</b> "
            f"<span class='muted'>· {_e(act.get('lever'))} · {_e(act.get('risk'))} risk</span></div>"
            f"<div class='rec'>{_e(act.get('recommendation'))}</div>"
            f"<div class='muted' style='font-size:11px'>{_e(act.get('rationale'))}</div></div>")
    return (f"<div class='panel'><h2>Cost optimization — opportunity: "
            f"{_e(co.get('opportunity'))}</h2>"
            f"<div class='muted'>{_e(co.get('headline'))}</div>"
            f"<div class='siggrid'>" + "".join(rows) + "</div></div>")


def _charts_html(results, config):
    series = results.get("series", {}) or {}
    out = []
    for sec in config:
        cards = []
        for c in sec["charts"]:
            present = any((series.get(sp["name"]) or {}).get("t") for sp in c["specs"])
            note = "" if present else "<div class='nodata'>(no data)</div>"
            cards.append(
                f"<div class='chartcard'><h3>{_e(c['title'])}</h3>"
                f"<div id='{c['id']}' class='plot'>{note}</div></div>")
        grid_cls = "cgrid full" if sec["full"] else "cgrid"
        out.append(f"<div class='panel'><h2>{_e(sec['title'])}</h2>"
                   f"<div class='{grid_cls}'>" + "".join(cards) + "</div></div>")
    return "".join(out)


def _signal_table(results):
    sigs = results.get("signals", {}) or {}
    head = ("<thead><tr><th>signal</th><th>unit</th><th>p50</th><th>p95</th>"
            "<th>p99</th><th>max</th><th>mean</th></tr></thead>")
    rows = []
    for name, s in sigs.items():
        s = s or {}
        rows.append(
            f"<tr><td>{_e(name)}</td><td>{_e(s.get('unit'))}</td>"
            f"<td class='mono'>{_num(s.get('p50'))}</td>"
            f"<td class='mono'>{_num(s.get('p95'))}</td>"
            f"<td class='mono'>{_num(s.get('p99'))}</td>"
            f"<td class='mono'>{_num(s.get('max'))}</td>"
            f"<td class='mono'>{_num(s.get('mean'))}</td></tr>")
    return (f"<div class='panel'><h2>Signal summary ({len(sigs)})</h2>"
            f"<table class='sig'>{head}<tbody>" + "".join(rows) + "</tbody></table></div>")


def _footer_html(results):
    src = results.get("source", {}) or {}
    notes = results.get("notes", []) or []
    missing = results.get("missing_paths", []) or []
    notes_html = "".join(f"<li>{_e(n)}</li>" for n in notes) or "<li>none</li>"
    missing_html = "".join(f"<li class='mono'>{_e(m)}</li>" for m in missing) or "<li>none</li>"
    return f"""
    <div class="panel footer">
      <h2>Provenance</h2>
      <div>generated: {_e(results.get('generated_at'))}</div>
      <div>source: {_e(src.get('dir'))} &nbsp;·&nbsp; {_e(src.get('file_count'))} files</div>
      <h3 style="margin-top:12px;">Notes / caveats</h3>
      <ul>{notes_html}</ul>
      <h3>Missing paths</h3>
      <ul>{missing_html}</ul>
    </div>"""


# ===========================================================================
# SECTION 1 — General cluster information
# ===========================================================================
def _general_html(results):
    h = results.get("host") or {}
    c = results.get("capture") or {}
    hc = results.get("healthcheck") or {}
    server = hc.get("server") or {}
    topo = hc.get("topology") or {}
    rep = hc.get("replication") or {}
    ds = results.get("data_sources") or {}
    role = h.get("role") or "—"
    role_color = ROLE_COLORS.get(role, PALETTE["muted"])
    mem_gb = (h.get("mem_mb") or 0) / 1024
    edition = server.get("edition")
    uptime = server.get("uptime_days")

    # Topology line with arbiter detection (healthcheck only).
    topo_html = ""
    if topo:
        members = (f"{topo.get('data_bearing', '?')} data-bearing + {topo.get('arbiters', 0)} "
                   f"arbiter{'' if topo.get('arbiters') == 1 else 's'} "
                   f"({topo.get('electable', '?')} electable)")
        topo_html = f"""
        <div class="kv"><span>Replica set</span><span class="mono">{_e(topo.get('repl_set_name'))}</span></div>
        <div class="kv"><span>Cluster role</span><span>{_e(topo.get('cluster_role') or 'standalone replica set')}</span></div>
        <div class="kv"><span>Members</span><span>{_e(members)}</span></div>
        <div class="kv"><span>Oplog window</span><span class="mono">{_e(rep.get('time_diff_hours'))} h</span></div>"""

    capture_html = ""
    if ds.get("ftdc", (c.get("samples") or 0) > 0):
        capture_html = f"""
        <div class="kv"><span>Capture window</span><span class="mono">{_e(c.get('first_ts_iso'))} → {_e(c.get('last_ts_iso'))}</span></div>
        <div class="kv"><span>Span / samples</span><span class="mono">{_e(c.get('span_seconds'))} s · {_e(c.get('samples'))} samples</span></div>"""

    sources = ", ".join([k for k in ("ftdc", "healthcheck", "profiler") if ds.get(k)]) or "—"

    return f"""
    <div class="panel header">
      <div class="row">
        <h1>{_e(h.get('hostname'))}</h1>
        <span class="badge" style="background:{role_color}">{_e(role)}</span>
        <span class="muted">MongoDB {_e(h.get('mongo_version'))}{(' · ' + _e(edition)) if edition else ''}</span>
      </div>
      <div class="hwline" style="margin-top:10px;">
        <span class="pill">{_e(h.get('num_cores'))} cores</span>
        <span class="pill">{mem_gb:.1f} GB RAM</span>
        <span class="pill">data disk: {_e(h.get('data_disk') or '—')}</span>
        {f'<span class="pill">uptime {_e(uptime)} d</span>' if uptime is not None else ''}
        <span class="pill">inputs: {_e(sources)}</span>
      </div>
      <div style="margin-top:12px;max-width:560px;">
        {capture_html}{topo_html}
      </div>
    </div>"""


# ===========================================================================
# SECTION 2 — Healthcheck Report (6 sub-areas) — omitted cleanly if absent
# ===========================================================================
def _hc_summary(hc):
    s = hc.get("server") or {}
    st = hc.get("storage") or {}
    net = hc.get("network") or {}
    conn = s.get("connections") or {}
    heroes = [
        ("Uptime", f"{_e(s.get('uptime_days'))} d"), ("vCPU", _e(s.get('num_cores'))),
        ("RAM", f"{_e(s.get('mem_gb'))} GB"), ("WT cache", f"{_e(s.get('wt_cache_gb'))} GiB ({_e(s.get('cache_fill_pct'))}%)"),
        ("Connections", _compact(conn.get('current'))), ("Page faults", _compact(s.get('page_faults'))),
    ]
    hero_html = "".join(
        f"<div class='tile' style='text-align:center'><div style='font-size:20px;font-weight:700'>{v}</div>"
        f"<div class='muted' style='font-size:11px'>{k}</div></div>" for k, v in heroes)
    return f"""
    <h3>Summary</h3>
    <div class="tilegrid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">{hero_html}</div>
    <div class="tilegrid" style="margin-top:12px">
      <div class="tile"><h3>Data sizes & compression</h3>
        <div class="kv"><span>Logical data</span><span class="mono">{_fmt_bytes(st.get('total_data_size'))}</span></div>
        <div class="kv"><span>On-disk (compressed)</span><span class="mono">{_fmt_bytes(st.get('total_storage_size'))}</span></div>
        <div class="kv"><span>Compression</span><span>{_e(st.get('compression_ratio'))}×</span></div>
        <div class="kv"><span>Total index size</span><span class="mono">{_fmt_bytes(st.get('total_index_size'))}</span></div>
        <div class="kv"><span>Catalog</span><span>{_e(st.get('n_databases'))} DB · {_e(st.get('n_collections'))} coll · {_e(st.get('n_indexes'))} idx</span></div>
      </div>
      <div class="tile"><h3>Network I/O & compression</h3>
        <div class="kv"><span>Bytes in / out</span><span class="mono">{_e(net.get('bytes_in_gb'))} / {_e(net.get('bytes_out_gb'))} GiB</span></div>
        <div class="kv"><span>Egress ÷ ingress</span><span>{_e(net.get('egress_ingress_ratio'))}× (write amplification)</span></div>
        <div class="kv"><span>Wire compression</span><span>{('active · ' + _e(net.get('network_compressor')) + ' ' + _e(net.get('wire_compression_ratio')) + '×') if net.get('network_compression_active') else 'not active'}</span></div>
        <div class="kv"><span>Storage block compr.</span><span>{_e(', '.join((net.get('storage_block_compressors') or {}).keys()) or '—')}</span></div>
      </div>
    </div>"""


def _hc_collections(hc):
    rows = []
    for c in sorted(hc.get("collections") or [], key=lambda x: -(x.get("data_size") or 0)):
        big = (c.get("avg_obj_size") or 0) >= 10 * 1024
        many = (c.get("nindexes") or 0) > 12
        rows.append(
            f"<tr><td class='mono'>{_e(c.get('db'))}.{_e(c.get('name'))}</td>"
            f"<td>{_compact(c.get('count'))}</td>"
            f"<td style='color:{PALETTE['amber'] if big else PALETTE['text']}'>{_fmt_bytes(c.get('avg_obj_size'))}</td>"
            f"<td>{_fmt_bytes(c.get('data_size'))}</td><td>{_fmt_bytes(c.get('storage_size'))}</td>"
            f"<td>{_e(c.get('compression_ratio'))}×</td>"
            f"<td style='color:{PALETTE['amber'] if many else PALETTE['text']}'>{_e(c.get('nindexes'))}</td>"
            f"<td>{_fmt_bytes(c.get('total_index_size'))}</td>"
            f"<td>{_e(c.get('index_to_data_pct'))}%</td></tr>")
    head = ("<thead><tr><th>Collection</th><th>Docs</th><th>Avg doc</th><th>Data</th>"
            "<th>Storage</th><th>Compr.</th><th>Idx</th><th>Idx size</th><th>Idx/Data</th></tr></thead>")
    return f"<h3>Collections ({len(hc.get('collections') or [])})</h3><table class='led'>{head}<tbody>{''.join(rows)}</tbody></table>"


def _hc_index_analyzer(hc):
    ia = hc.get("index_analysis") or {}
    pairs = "".join(
        f"<tr><td class='mono'>{_e(p.get('db'))}.{_e(p.get('collection'))}</td>"
        f"<td class='mono' style='color:{PALETTE['amber']}'>{_e(p.get('redundant'))}</td>"
        f"<td class='mono'>{_e(p.get('covered_by'))}</td><td>{_e(p.get('kind'))}</td>"
        f"<td>{'unused' if p.get('redundant_unused') else 'in use'}</td></tr>"
        for p in ia.get("redundant_pairs", []))
    pairs_html = (f"<h3 style='margin-top:12px'>Prefix/shadow-redundant pairs ({len(ia.get('redundant_pairs', []))})</h3>"
                  f"<table class='led'><thead><tr><th>Collection</th><th>Redundant</th><th>Covered by</th>"
                  f"<th>Kind</th><th>Status</th></tr></thead><tbody>{pairs}</tbody></table>") if ia.get("redundant_pairs") else ""
    drops = "".join(
        f"<tr><td class='mono' style='color:{PALETTE['amber']}'>{_e(d.get('index'))}</td>"
        f"<td>{d.get('size_mb')} MB</td><td>0 ops</td></tr>" for d in ia.get("drop_list", [])[:15])
    return f"""
    <h3>Index Analyzer</h3>
    <div class="hwline"><span class="pill">{_e(ia.get('total_indexes'))} indexes</span>
      <span class="pill" style="color:{PALETTE['amber']}">{_e(ia.get('unused_count'))} unused</span>
      <span class="pill" style="color:{PALETTE['amber']}">{_e(ia.get('reclaimable_gb'))} GB reclaimable</span>
      <span class="pill">{len(ia.get('redundant_pairs', []))} redundant pairs</span></div>
    {pairs_html}
    <h3 style="margin-top:12px">Unused / droppable ({len(ia.get('drop_list', []))})</h3>
    <table class='led'><thead><tr><th>Index</th><th>Size</th><th>Accesses</th></tr></thead><tbody>{drops}</tbody></table>"""


def _hc_operations(hc):
    op = hc.get("operations") or {}
    opc = op.get("opcounters") or {}
    ops_ps = op.get("opcounters_per_sec") or {}
    doc = op.get("document") or {}
    ttl = op.get("ttl") or {}
    opc_rows = "".join(f"<div class='kv'><span>{_e(k)}</span><span class='mono'>{_compact(v)} · {_e(ops_ps.get(k))}/s</span></div>" for k, v in opc.items())
    doc_rows = "".join(f"<div class='kv'><span>{_e(k)}</span><span class='mono'>{_compact(v)}</span></div>" for k, v in doc.items())
    return f"""
    <h3>Operations</h3>
    <div class="muted" style="font-size:11px;margin-bottom:6px">{_e(op.get('note'))}</div>
    <div class="tilegrid">
      <div class="tile"><h3>Opcounters (lifetime · /s)</h3>{opc_rows}</div>
      <div class="tile"><h3>Document metrics</h3>{doc_rows}
        <div class="kv"><span>TTL deleted</span><span class="mono">{_compact(ttl.get('deletedDocuments'))}</span></div>
        <div class="kv"><span>TTL passes</span><span class="mono">{_compact(ttl.get('passes'))}</span></div></div>
    </div>"""


def _hc_wiredtiger(hc):
    wt = hc.get("wiredtiger") or {}
    cards = []
    for g in wt.values():
        buckets = g.get("buckets", [])
        mx = max([b.get("count", 0) for b in buckets] + [1])
        rows = "".join(
            f"<div class='barrow'><span class='lbl'>{_e(b.get('label'))}</span>"
            f"<div class='bar'><i style='width:{100 * (b.get('count', 0) / mx):.0f}%;background:{PALETTE['blue']}'></i></div>"
            f"<span class='val mono'>{_compact(b.get('count'))}</span></div>" for b in buckets)
        cards.append(f"<div class='tile'><h3>{_e(g.get('label'))} <span class='muted' style='font-weight:400'>· tail {_e(g.get('tail_pct'))}%</span></h3>{rows}</div>")
    if not cards:
        return ""
    return f"<h3>WiredTiger latency histograms</h3><div class='tilegrid'>{''.join(cards)}</div>"


def _hc_security(hc):
    sec = hc.get("security") or {}
    warns = "".join(f"<li class='cav'>{_e(w)}</li>" for w in sec.get("warnings", []))
    gaps = "".join(f"<li class='muted' style='font-size:11px'>{_e(g)}</li>" for g in sec.get("feature_gaps", []))
    return f"""
    <h3>Health & Security</h3>
    <div class="tilegrid">
      <div class="tile"><h3>Posture warnings</h3><ul style="margin:4px 0;padding-left:16px">{warns or '<li class=muted>none</li>'}</ul></div>
      <div class="tile"><h3>Security & config</h3>
        <div class="kv"><span>Edition</span><span>{_e(sec.get('edition'))}</span></div>
        <div class="kv"><span>Bind IP</span><span class="mono">{_e(sec.get('bind_ip'))}</span></div>
        <div class="kv"><span>TLS</span><span>{_e(sec.get('tls_mode') or 'not configured')}</span></div>
        <div class="kv"><span>Authorization</span><span>{_e(sec.get('authorization') or 'not enabled')}</span></div>
        <div class="kv"><span>Cluster auth</span><span>{_e(sec.get('cluster_auth_mode'))}</span></div></div>
      <div class="tile"><h3>Edition feature gaps</h3><ul style="margin:4px 0;padding-left:16px">{gaps or '<li class=muted>none</li>'}</ul></div>
    </div>"""


def _healthcheck_report_html(results):
    hc = results.get("healthcheck")
    if not hc:
        return ""
    return (f"<div class='panel'><h2>Healthcheck Report</h2>"
            f"<div class='sectionlead'>Full structural report from the getMongoData snapshot "
            f"(v{_e((hc.get('server') or {}).get('script_version'))}).</div>"
            + _hc_summary(hc)
            + f"<div style='margin-top:16px'>{_hc_collections(hc)}</div>"
            + f"<div style='margin-top:16px'>{_hc_index_analyzer(hc)}</div>"
            + f"<div style='margin-top:16px'>{_hc_operations(hc)}</div>"
            + f"<div style='margin-top:16px'>{_hc_wiredtiger(hc)}</div>"
            + f"<div style='margin-top:16px'>{_hc_security(hc)}</div>"
            + "</div>")


# ===========================================================================
# Structural tiles (snapshot) — rendered inside the Charts/Metrics section
# ===========================================================================
def _structural_tiles_html(results):
    hc = results.get("healthcheck")
    if not hc:
        return ""
    ia = hc.get("index_analysis") or {}
    s = hc.get("server") or {}
    st = hc.get("storage") or {}
    rep = hc.get("replication") or {}
    sizing = results.get("sizing_recommendation") or {}
    cf = sizing.get("cache_fit") or {}

    # Tile 1 — index usage
    top = ia.get("top_accessed", [])[:6]
    mx_ops = max([x.get("ops") or 0 for x in top] + [1])
    top_rows = "".join(
        f"<div class='barrow'><span class='lbl mono'>{_e('.'.join(str(x.get('index','')).split('.')[-2:]))}</span>"
        f"<div class='bar'><i style='width:{100 * ((x.get('ops') or 0) / mx_ops):.0f}%;background:{PALETTE['blue']}'></i></div>"
        f"<span class='val mono'>{_compact(x.get('ops'))} · {x.get('size_mb')} MB</span></div>" for x in top)
    unused_rows = "".join(
        f"<div class='kv'><span class='mono' style='color:{PALETTE['amber']}'>{_e('.'.join(str(d.get('index','')).split('.')[-2:]))}</span>"
        f"<span class='mono'>{d.get('size_mb')} MB · 0 ops</span></div>" for d in ia.get("drop_list", [])[:6])

    # Tile 2/5 — collections
    colls = sorted(hc.get("collections") or [], key=lambda x: -(x.get("storage_size") or 0))[:8]
    col_rows = "".join(
        f"<div class='barrow'><span class='lbl mono'>{_e(c.get('db'))}.{_e(c.get('name'))}</span>"
        f"<div class='bar'><i style='width:{100 * ((c.get('storage_size') or 0) / max(c.get('storage_size') or 0, c.get('data_size') or 1)):.0f}%;background:{PALETTE['blue']}'></i></div>"
        f"<span class='val mono'>{_fmt_bytes(c.get('storage_size'))}/{_fmt_bytes(c.get('data_size'))}</span></div>" for c in colls)
    frag_rows = "".join(
        (lambda r: f"<div class='barrow'><span class='lbl mono'>{_e(c.get('db'))}.{_e(c.get('name'))}</span>"
         f"<div class='bar'><i style='width:{min(100, r * 100):.0f}%;background:{PALETTE['coral'] if r > 0.9 else PALETTE['blue']}'></i></div>"
         f"<span class='val mono'>{r * 100:.0f}%</span></div>")((c.get("storage_size") or 0) / (c.get("data_size") or 1))
        for c in colls)

    # Tile 3 — cache fit
    fits = cf.get("working_set_fits_in_cache", False)
    d2c = cf.get("data_to_cache_ratio")
    fill = cf.get("cache_fill_pct") or s.get("cache_fill_pct") or 0

    # Tile 4 — oplog
    oplog_h = rep.get("time_diff_hours")
    oplog_used = rep.get("used_pct") or 0

    return f"""
    <div class="panel"><h2>Indexes & Storage <span class="muted" style="font-size:12px;font-weight:400">· healthcheck snapshot</span></h2>
      <div class="sectionlead">Point-in-time structural tiles from the healthcheck (snapshot values — bars/gauges, not time-series).</div>
      <div class="tilegrid">
        <div class="tile"><h3>Index usage & unused indexes <span class="tag" style="color:{PALETTE['amber']}">{_e(ia.get('unused_count'))} unused · {_e(ia.get('reclaimable_gb'))} GB</span></h3>
          <div class="muted" style="font-size:10px;text-transform:uppercase;margin:4px 0">Most accessed</div>{top_rows}
          <div class="muted" style="font-size:10px;text-transform:uppercase;margin:8px 0 4px">Unused (0 accesses, _id excluded)</div>{unused_rows or '<div class=muted style=font-size:11px>none</div>'}</div>
        <div class="tile"><h3>Per-collection storage <span class="tag">{_e(st.get('compression_ratio'))}× compr.</span></h3>
          <div class="muted" style="font-size:10px;margin-bottom:4px">on-disk / logical (bar = on-disk share)</div>{col_rows}</div>
        <div class="tile"><h3>Cache fit <span class="tag" style="color:{PALETTE['green'] if fits else PALETTE['amber']}">{'fits in cache' if fits else 'disk-served'}</span></h3>
          <div style="font-size:24px;font-weight:700;color:{PALETTE['green'] if fits else PALETTE['amber']}">{_e(d2c)}×</div>
          <div class="muted" style="font-size:11px">logical data ÷ WiredTiger cache</div>
          <div class="kv" style="margin-top:8px"><span>WT cache fill</span><span class="mono">{_e(fill)}%</span></div>{_bar(fill, PALETTE['blue'])}
          <div class="kv"><span>WT cache / in-cache / data</span><span class="mono">{_e(s.get('wt_cache_gb'))} GiB / {_e(s.get('bytes_in_cache_gb'))} GiB / {_e(st.get('total_data_tb'))} TB</span></div></div>
        <div class="tile"><h3>Oplog window</h3>
          <div style="font-size:24px;font-weight:700;color:{PALETTE['amber'] if (oplog_h or 99) < 24 else PALETTE['green']}">{_e(oplog_h)} h</div>
          <div class="muted" style="font-size:11px">recovery / replication window</div>
          <div class="kv" style="margin-top:8px"><span>oplog used</span><span class="mono">{_e(oplog_used)}%</span></div>{_bar(oplog_used, PALETTE['blue'])}
          <div class="muted" style="font-size:11px;margin-top:4px">A secondary down longer than this needs a full resync.</div></div>
        <div class="tile"><h3>Collection fragmentation <span class="tag" style="color:{PALETTE['amber']}">proxy</span></h3>
          <div class="muted" style="font-size:11px;margin-bottom:4px">on-disk ÷ logical per collection (freeStorageSize not in snapshot — proxy only).</div>{frag_rows}</div>
      </div>
    </div>"""


# ===========================================================================
# SECTION 4 — Assessment (assessment_v2 3-layer)
# ===========================================================================
_STATUS_LABEL = {"scored": "Scored", "input_provided": "Awaiting parse",
                 "requires_input": "Awaiting input", "stub": "Declared", "disabled": "Disabled"}


def _sizing_cards_html(sizing):
    if not sizing or sizing.get("error") or not sizing.get("current"):
        return ""
    cur = sizing["current"]
    cards = []
    for o in sizing.get("options", []):
        t = o.get("tier") or {}
        cls = "optcard rec" if o.get("id") == sizing.get("recommended") else ("optcard dim" if not o.get("available") else "optcard")
        specs = (f"{_e(t.get('name'))} · {_e(t.get('vcpu'))} vCPU · {_e(t.get('ram_gb'))} GB" if t else "—")
        cards.append(
            f"<div class='{cls}'><div><b>{_e(o.get('label'))}</b>"
            f"{' · ★ recommended' if o.get('id') == sizing.get('recommended') else ''}</div>"
            f"<div class='muted' style='font-size:12px;margin:4px 0'>{specs}</div>"
            f"<div class='confbar'><i style='display:block;height:100%;width:{(o.get('confidence') or 0) * 100:.0f}%;background:{PALETTE['green']}'></i></div>"
            f"<div class='muted' style='font-size:11px'>{_e(o.get('rationale'))}</div></div>")
    storage = ""
    if cur.get("storage_gb") is not None:
        storage = f"<span class='pill'>storage {_e(cur.get('storage_gb'))} GB</span>"
    return f"""
    <h3 style="margin-top:6px">Sizing Recommendation — {_e(sizing.get('recommended'))} @ {_e(sizing.get('recommended_confidence'))}</h3>
    <div class="hwline"><span class="pill">current ≈ {_e(cur.get('matched_tier'))}</span>
      <span class="pill">{_e(cur.get('vcpu'))} vCPU · {_e(cur.get('ram_gb'))} GB</span>
      <span class="pill">disk: {_e(cur.get('disk_profile'))}</span>{storage}</div>
    <div class="muted" style="font-size:12px;margin:8px 0">{_e(sizing.get('recommended_reason'))}</div>
    <div class="tilegrid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">{''.join(cards)}</div>"""


def _ledger_table(ledger):
    if not ledger:
        return ""
    rows = []
    for e in ledger:
        col = PALETTE["green"] if e.get("passed") else PALETTE["muted"]
        rows.append(
            f"<tr><td class='mono'>{_e(e.get('signal'))}</td>"
            f"<td class='mono'>{_e(e.get('value'))}</td>"
            f"<td>{_e(e.get('comparator'))} {_e(e.get('threshold'))}</td>"
            f"<td style='color:{col}'>{'✓' if e.get('passed') else '·'}</td>"
            f"<td class='mono'>{_e(e.get('contribution'))}</td></tr>")
    return ("<table class='led'><thead><tr><th>signal</th><th>value</th><th>test</th>"
            "<th>met</th><th>contrib</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>")


def _category_card_html(r):
    fired = r.get("status") == "scored" and r.get("fired")
    conf = r.get("confidence")
    conf_html = ""
    if conf is not None:
        conf_html = (f"<div class='confbar'><i style='display:block;height:100%;width:{conf * 100:.0f}%;"
                     f"background:{PALETTE['coral'] if fired else PALETTE['blue']}'></i></div>"
                     f"<div class='muted' style='font-size:11px'>confidence {conf:.0%}{' · FIRED' if fired else ''}</div>")
    caveats = "".join(f"<div class='cav'>⚠ {_e(c)}</div>" for c in (r.get("caveats") or [])[:4])
    # healthcheck drop-list evidence, if present
    ev = r.get("healthcheck_evidence") or {}
    ev_html = ""
    if ev.get("drop_list"):
        items = "".join(f"<li class='mono' style='font-size:11px'>{_e(d.get('index'))} — {d.get('size_mb')} MB</li>"
                        for d in ev["drop_list"][:6])
        ev_html = f"<div class='muted' style='font-size:11px;margin-top:6px'>Drop candidates:</div><ul style='margin:2px 0;padding-left:16px'>{items}</ul>"
    cls = "catcard fired" if fired else "catcard"
    return (f"<div class='{cls}'><div><b>{_e(r.get('name'))}</b> "
            f"<span class='tag'>{_e(r.get('family'))}</span> "
            f"<span class='muted' style='font-size:11px'>· {_e(_STATUS_LABEL.get(r.get('status'), r.get('status')))}</span></div>"
            f"{conf_html}"
            f"<div class='rec' style='margin:6px 0'>{_e(r.get('recommendation'))}</div>"
            f"{ev_html}{caveats}"
            f"{_ledger_table(r.get('ledger'))}</div>")


def _context_callouts_html(a2):
    """Fired *context* states (e.g. the sharding single-shard caveat) — surfaced near the top
    of the Assessment, not as a scored verdict."""
    notes = [r for r in a2.get("ranked", []) if r.get("context_fired")]
    out = []
    for r in notes:
        out.append(
            f"<div class='catcard' style='border-left:3px solid {PALETTE['blue']}'>"
            f"<div><b>{_e(r.get('name'))}</b> "
            f"<span class='tag' style='color:{PALETTE['blue']}'>context</span></div>"
            f"<div class='rec' style='margin:6px 0'>{_e(r.get('context_note'))}</div></div>")
    return "".join(out)


def _reasoning_html(results):
    """Layer-2 deterministic 'story arc' (What we found / Why here / What would change it) —
    mirrors the in-app grounded reasoning so the export's order matches the tab."""
    a2 = results.get("assessment_v2") or {}
    sizing = results.get("sizing_recommendation") or {}
    ranked = a2.get("ranked", [])
    scored = [r for r in ranked if r.get("status") == "scored"]
    pool = [r for r in scored if r.get("in_lens") is not False] or scored
    fired = [r for r in pool if r.get("fired")]
    clear = [r for r in pool if not r.get("fired")]
    awaiting = [r for r in ranked if r.get("status") in ("requires_input", "input_provided")]

    def pf(x):
        return "n/a" if x is None else f"{round(x * 100)}%"

    found = []
    if fired:
        for r in fired:
            top = max((e for e in r.get("ledger", []) if e.get("passed") and (e.get("contribution") or 0) > 0),
                      key=lambda e: abs(e.get("contribution") or 0), default=None)
            found.append(f"{r['name']} fired at {pf(r.get('confidence'))}"
                         + (f" — {top['signal']} = {top['value']} ({top['comparator']}{top['threshold']})" if top else "") + ".")
    else:
        found.append(f"No category crossed its fire threshold; strongest is "
                     f"{pool[0]['name'] if pool else '—'} at {pf(pool[0].get('confidence') if pool else None)}.")
    why = []
    if sizing.get("applies_to_intent") and sizing.get("recommended_reason"):
        why.append(sizing["recommended_reason"])
    for r in clear:
        why.append(f"{r['name']} has headroom ({pf(r.get('confidence'))}, did not fire).")
    for r in fired:
        for x in r.get("cross_references", []):
            why.append(x.get("note"))
    change = []
    if (sizing.get("conditioning") or {}).get("workload_caveat"):
        change.append(sizing["conditioning"]["workload_caveat"])
    for r in fired:
        for c in r.get("caveats", []):
            change.append(c)
    for r in awaiting:
        change.append(f"{r['name']}: provide {', '.join(r.get('missing_inputs', []))} to confirm.")

    def dedup(a):
        seen, out = set(), []
        for x in a:
            if x and x not in seen:
                seen.add(x)
                out.append(x)
        return out

    def sect(label, items):
        items = dedup(items)[:6]
        if not items:
            return ""
        lis = "".join(f"<li style='font-size:12px;margin:2px 0'>• {_e(i)}</li>" for i in items)
        return (f"<div class='grp' style='color:{PALETTE['green']}'>{_e(label)}</div>"
                f"<ul style='margin:2px 0 8px;padding-left:4px;list-style:none'>{lis}</ul>")

    body = (sect("What we found", found)
            + sect("Why it points here (not elsewhere)", why)
            + sect("What would change this conclusion", change))
    return f"<h3 style='margin-top:14px'>Reasoning</h3>{body}" if body else ""


def _assessment_top_html(results):
    """LAYER 1 (Verdict hero + context + sizing) + LAYER 2 (Reasoning). The per-category
    Evidence is rendered separately (LAST) by _assessment_evidence_html."""
    a2 = results.get("assessment_v2")
    if not a2:
        return ""
    ranked = a2.get("ranked", [])
    sizing = results.get("sizing_recommendation") or {}
    fired = sorted([r for r in ranked if r.get("status") == "scored" and r.get("fired")],
                   key=lambda r: -(r.get("confidence") or 0))
    if fired:
        top = fired[0]
        hero = (f"<div class='headline' style='font-size:15px'>Primary finding: "
                f"<b>{_e(top.get('name'))}</b> fired at {top.get('confidence', 0):.0%}</div>"
                f"<div class='muted' style='font-size:12px'>{_e(top.get('recommendation'))}</div>")
    else:
        hero = "<div class='muted'>No category fired — see the per-category evidence below.</div>"
    counts = a2.get("counts", {})
    counts_html = " · ".join(f"{v} {k}" for k, v in counts.items())
    return (f"<div class='panel'><h2>Assessment</h2>"
            f"<div class='sectionlead'>Deterministic Layer-2 scorer · {_e(counts_html)}</div>"
            f"{hero}"
            f"{_context_callouts_html(a2)}"
            f"{_sizing_cards_html(sizing)}"
            f"{_reasoning_html(results)}"
            f"</div>")


def _assessment_evidence_html(results):
    """LAYER 3 — Evidence (per-category cards + ledgers), grouped Fired/Clear/Awaiting/
    Declared. Rendered LAST in the Assessment section."""
    a2 = results.get("assessment_v2")
    if not a2:
        return ""
    ranked = a2.get("ranked", [])
    groups = [("Fired — drove the verdict", [r for r in ranked if r.get("status") == "scored" and r.get("fired")]),
              ("Clear — scored, didn't fire", [r for r in ranked if r.get("status") == "scored" and not r.get("fired")]),
              ("Awaiting input", [r for r in ranked if r.get("status") in ("requires_input", "input_provided")]),
              ("Declared (stubs)", [r for r in ranked if r.get("status") in ("stub", "disabled")])]
    body = []
    for label, items in groups:
        if not items:
            continue
        body.append(f"<div class='grp'>{label} ({len(items)})</div>")
        body.extend(_category_card_html(r) for r in items)
    if not body:
        return ""
    return f"<div class='panel'><h2>Evidence</h2>{''.join(body)}</div>"


def render_html(results, plotly_inline_content=None):
    if plotly_inline_content is not None:
        plotly_tag = "<script>" + plotly_inline_content + "</script>"
    else:
        plotly_tag = f'<script src="{PLOTLY_URL}" charset="utf-8"></script>'

    chart_config = _catalog_to_chart_config(results)

    # PARITY with the live Charts tab: when a healthcheck is present the structural
    # "Indexes & Storage" category is rendered as populated snapshot TILES, so drop the
    # catalog's placeholder version (5 "needs data" charts) to avoid a duplicate blank panel
    # next to the real one. Without a healthcheck it stays (the upload placeholders).
    if results.get("healthcheck"):
        chart_config = [c for c in chart_config if c.get("title") != STRUCTURAL_CATEGORY]

    # Embed as JSON in script tags; neutralize any "</" to avoid breaking the tag.
    data_json = json.dumps(results).replace("</", "<\\/")
    charts_json = json.dumps(chart_config).replace("</", "<\\/")

    host = (results.get("host") or {}).get("hostname") or "host"
    css = _apply_palette(CSS)

    verdicts = results.get("verdicts") or {}
    has_ftdc = bool(results.get("series"))

    # --- SECTION 3: Charts/Metrics = FTDC time-series charts + structural snapshot tiles ---
    charts_section = ""
    if has_ftdc:
        charts_section += _charts_html(results, chart_config)
    charts_section += _structural_tiles_html(results)
    if has_ftdc:
        charts_section += _signal_table(results)
    if not charts_section:
        charts_section = ("<div class='panel'><h2>Charts / Metrics</h2>"
                          "<div class='muted'>No time-series — provide an FTDC capture for metric charts.</div></div>")

    # --- SECTION 4: Assessment — Layer 1 Verdict + Layer 2 Reasoning, then FTDC capacity
    # verdicts + cost context, and finally Layer 3 Evidence (ledgers) as the LAST block. ---
    assessment_section = _assessment_top_html(results)
    if verdicts:
        cards = "".join([
            _verdict_card("RAM", verdicts.get("ram")),
            _verdict_card("CPU", verdicts.get("cpu")),
            _verdict_card("DISK", verdicts.get("disk")),
        ])
        assessment_section += ("<div class='panel'><h2>Capacity verdicts (FTDC)</h2>"
                               "<div class='cards'>" + cards + "</div></div>")
    assessment_section += _cost_html(results)
    assessment_section += _assessment_evidence_html(results)  # Layer 3 — Evidence LAST

    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>FTDC report · {_e(host)}</title>"
        f"<style>{css}</style>{plotly_tag}</head><body><div class='wrap'>"
        # SECTION 1
        + _general_html(results)
        # SECTION 2 (omitted cleanly if no healthcheck)
        + _healthcheck_report_html(results)
        # SECTION 3
        + charts_section
        # SECTION 4
        + assessment_section
        + _footer_html(results)
        + "</div>"
        + f"<script id='ftdc-data' type='application/json'>{data_json}</script>"
        + f"<script id='ftdc-charts' type='application/json'>{charts_json}</script>"
        + "<script>" + JS + "</script>"
        + "</body></html>"
    )


# ---------------------------------------------------------------------------
# Rendering to disk
# ---------------------------------------------------------------------------
def _newest_results(reports_dir):
    matches = sorted(glob.glob(os.path.join(reports_dir, "ftdc_results_*.json")))
    return matches[-1] if matches else None


_PLOTLY_CACHE = {}


def _fetch_plotly():
    if "content" not in _PLOTLY_CACHE:
        with urllib.request.urlopen(PLOTLY_URL, timeout=60) as resp:
            _PLOTLY_CACHE["content"] = resp.read().decode("utf-8")
    return _PLOTLY_CACHE["content"]


def render(json_path, reports_dir, inline, stamp):
    with open(json_path) as fh:
        results = json.load(fh)

    inline_content = None
    if inline:
        inline_content = _fetch_plotly()

    host = ((results.get("host") or {}).get("hostname") or "unknown").replace("/", "_")
    suffix = "_offline" if inline else ""
    out_path = os.path.join(reports_dir, f"ftdc_report_{host}_{stamp}{suffix}.html")
    with open(out_path, "w") as fh:
        fh.write(render_html(results, inline_content))
    return out_path, os.path.getsize(out_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    reports_dir = "/Users/manishsinha/Desktop/projects/ftdc-analyzer/reports"
    ap = argparse.ArgumentParser(description="Render FTDC results.json to HTML.")
    ap.add_argument("json", nargs="?", help="path to results.json (default: newest)")
    ap.add_argument("--inline-plotly", action="store_true",
                    help="inline Plotly for a fully offline report")
    args = ap.parse_args()

    json_path = args.json or _newest_results(reports_dir)
    if not json_path or not os.path.exists(json_path):
        raise SystemExit("no results.json found in reports/ (run verdicts.py first)")

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print(f"input: {json_path}")

    # Primary render (honors the --inline-plotly flag).
    p1, s1 = render(json_path, reports_dir, args.inline_plotly, stamp)
    kind1 = "offline (inline Plotly)" if args.inline_plotly else "CDN Plotly"
    print(f"\n[1] {kind1}")
    print(f"    {p1}")
    print(f"    size: {s1:,} bytes ({s1/1024:.1f} KiB)")
    print(f"    open with: open {p1}")

    # Also render the opposite variant so both an online and offline copy exist.
    p2, s2 = render(json_path, reports_dir, not args.inline_plotly, stamp)
    kind2 = "CDN Plotly" if args.inline_plotly else "offline (inline Plotly)"
    print(f"\n[2] {kind2}")
    print(f"    {p2}")
    print(f"    size: {s2:,} bytes ({s2/1024:.1f} KiB)")
    print(f"    open with: open {p2}")


if __name__ == "__main__":
    main()
