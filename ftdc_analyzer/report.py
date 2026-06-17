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
            .replace("__GREEN__", PALETTE["green"]))


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


def _charts_html(results):
    series = results.get("series", {}) or {}
    out = []
    for sec in CHARTS:
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


def render_html(results, plotly_inline_content=None):
    if plotly_inline_content is not None:
        plotly_tag = "<script>" + plotly_inline_content + "</script>"
    else:
        plotly_tag = f'<script src="{PLOTLY_URL}" charset="utf-8"></script>'

    # Embed as JSON in script tags; neutralize any "</" to avoid breaking the tag.
    data_json = json.dumps(results).replace("</", "<\\/")
    charts_json = json.dumps(CHARTS).replace("</", "<\\/")

    cards = "".join([
        _verdict_card("RAM", (results.get("verdicts") or {}).get("ram")),
        _verdict_card("CPU", (results.get("verdicts") or {}).get("cpu")),
        _verdict_card("DISK", (results.get("verdicts") or {}).get("disk")),
    ])

    host = (results.get("host") or {}).get("hostname") or "host"
    css = _apply_palette(CSS)

    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>FTDC report · {_e(host)}</title>"
        f"<style>{css}</style>{plotly_tag}</head><body><div class='wrap'>"
        + _header_html(results)
        + "<div class='cards'>" + cards + "</div>"
        + _charts_html(results)
        + _signal_table(results)
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
