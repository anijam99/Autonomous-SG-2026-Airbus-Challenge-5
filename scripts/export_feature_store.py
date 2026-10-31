"""Build the airport-hour feature store used to score any uploaded flight (all hours 2023–2025, leads 3–12 h).

    python scripts/export_feature_store.py
Output: data/model/feature_store.parquet. Every weather input is observed >= 3 h before the target hour.
"""
import json
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import c5lib as C  # noqa: E402

t0 = time.time()
conf = json.loads((C.MODEL_DIR / "conformal.json").read_text())
airports = C.TRAIN_AIRPORTS + C.HOLDOUT_AIRPORTS
flights = pd.concat([pd.read_parquet(f) for f in sorted(C.bts_dir(airports).glob("bts_*.parquet"))], ignore_index=True)
flights = C.prepare_flights(flights[flights.CRS_ELAPSED_TIME.notna()])
hours = pd.date_range("2023-01-01 12:00", "2025-08-01 03:00", freq="h", tz="UTC", name="hour")
keep = ["airport", "hour", "lead_h", "nominal"] + C.CLF_AIRPORT + ["met_cat_at_H", "met_ts_at_H", "wx_obs_utc"]
parts = []
for a in airports:
    h = conf["headings"][a]
    tab = C.build_aar_table(C.hourly_panel(flights, a, hours), C.load_metar_hourly(a, h), C.taf_hourly(a, h),
                            C.load_lamp(a, h), a, conf["nominal"][a], wx=C.load_hourly_weather(a, h))
    tab = tab[[c for c in dict.fromkeys(keep) if c in tab]]
    num = tab.select_dtypes("float64").columns
    tab[num] = tab[num].astype("float32")
    parts.append(tab)
    print(f"{a}: {len(tab):,} rows ({time.time() - t0:.0f}s)", flush=True)
fs = pd.concat(parts, ignore_index=True)
fs.to_parquet(C.MODEL_DIR / "feature_store.parquet", index=False)
print(f"feature_store.parquet: {len(fs):,} rows, {(C.MODEL_DIR / 'feature_store.parquet').stat().st_size / 1e6:.0f} MB")
