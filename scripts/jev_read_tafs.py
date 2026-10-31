"""Have Jev read every distinct TAF weather text once and cache the answers (resumable).

    python scripts/jev_read_tafs.py            # all airports in data/external/taf
Output: data/jev/taf_readings.parquet  (one row per distinct weather text)
"""
import concurrent.futures as cf
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import jev  # noqa: E402

OUT = ROOT / "data" / "jev" / "taf_readings.parquet"
OUT.parent.mkdir(parents=True, exist_ok=True)

texts = set()
for f in sorted((ROOT / "data" / "external" / "taf").glob("taf_*.parquet")):
    texts |= set(pd.read_parquet(f, columns=["raw"]).raw.map(jev.weather_text))
done = pd.read_parquet(OUT) if OUT.exists() else pd.DataFrame(columns=["text"])
todo = sorted(texts - set(done.text))
print(f"{len(texts):,} distinct texts, {len(todo):,} to read", flush=True)

rows, t0 = [], time.time()
def flush():
    global done, rows
    if rows:
        done = pd.concat([done, pd.DataFrame(rows)], ignore_index=True)
        done.to_parquet(OUT, index=False)
        rows = []

with cf.ThreadPoolExecutor(12) as ex:
    futs = {ex.submit(jev.read_taf_group, t): t for t in todo}
    for i, f in enumerate(cf.as_completed(futs), 1):
        try:
            rows.append(f.result())
        except Exception as e:
            print("FAILED", repr(futs[f]), repr(e)[:200], flush=True)
        if i % 500 == 0:
            flush()
            print(f"{i:,}/{len(todo):,} in {time.time() - t0:.0f}s", flush=True)
flush()
print(f"DONE {len(done):,} readings", flush=True)
