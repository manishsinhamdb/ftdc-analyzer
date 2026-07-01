import os, sys, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from ftdc_analyzer import decoder

FTDC_DIR = "/Users/manishsinha/Desktop/Projects/healthcheck/diagnostic.data"
ts, series, meta = decoder.decode_directory(FTDC_DIR)
ts = np.asarray(ts, dtype="int64")
n = ts.shape[0]
def fmt(ms): return datetime.datetime.fromtimestamp(ms/1000, tz=datetime.timezone.utc).isoformat()
print("samples:", n, "| span:", fmt(ts[0]), "->", fmt(ts[-1]))
print("meta:", meta)

# pick cumulative counters likely to reset at restart
want = {
  "uptime": [k for k in series if k.lower().endswith("uptime") or k.lower().endswith("uptimemillis")],
  "insert": [k for k in series if k=="serverStatus.opcounters.insert"],
  "query":  [k for k in series if k=="serverStatus.opcounters.query"],
  "netIn":  [k for k in series if k=="serverStatus.network.bytesIn"],
  "asserts":[k for k in series if k=="serverStatus.asserts.regular"],
}
for label, keys in want.items():
    if not keys:
        print(f"\n[{label}] NO KEY FOUND (candidates: {[k for k in series if label.split()[0].lower() in k.lower()][:4]})")
        continue
    k = keys[0]
    a = np.asarray(series[k], dtype="float64")
    d = np.diff(a)
    drops = np.where(d < 0)[0]
    print(f"\n[{label}] {k}")
    print(f"   first5={a[:5]}  last5={a[-5:]}")
    print(f"   downward jumps: {len(drops)}")
    for idx in drops[:6]:
        print(f"     idx {idx} @ {fmt(ts[idx+1])}: {a[idx]:.0f} -> {a[idx+1]:.0f}")
