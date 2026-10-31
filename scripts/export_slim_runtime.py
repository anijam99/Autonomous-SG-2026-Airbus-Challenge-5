"""Write light copies of what the web app reads, so it can run without pyarrow or scikit-learn (e.g. on Vercel).

    python scripts/export_slim_runtime.py      # run after scripts/run_pipeline.py

* every parquet file the server reads  -> <name>.parquet.pkl.gz (pandas pickle, gzip)
* isotonic calibrators (joblib)        -> JSON lookup tables (np.interp gives identical output)
* the provided 61 MB CSV               -> two small extracts (test-period sample rows, hourly temperature profile)
"""
import json
from pathlib import Path

import joblib
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
MODEL, PROC = ROOT / "data" / "model", ROOT / "data" / "processed"
PARQUETS = [MODEL / f for f in ["aar_test.parquet", "test_departures.parquet", "hourly_history.parquet", "analog_pool.parquet",
                                "failure_cases.parquet", "storm_lead_times.parquet", "test_hub_flights.parquet", "feature_store.parquet"]]
PARQUETS += [PROC / "flights_clean_hubs.parquet"] + sorted((ROOT / "data" / "external" / "meteostat").glob("*.parquet"))

PY_STR = pd.StringDtype("python", na_value=float("nan"))


def no_arrow(s: pd.Series | pd.Index):
    """pandas 3 backs text with pyarrow when it is installed; store plain Python strings so the pickle loads without it."""
    if isinstance(s.dtype, pd.CategoricalDtype):
        cats = s.cat.categories
        if isinstance(cats.dtype, pd.StringDtype) or isinstance(cats.dtype, pd.ArrowDtype):
            return s.cat.rename_categories(pd.Index(cats.astype(object), dtype=PY_STR))
        return s
    if isinstance(s.dtype, pd.StringDtype):
        if isinstance(s, pd.Series) and len(s) > 1000 and s.nunique() < 0.2 * len(s):   # repeated codes: category saves memory
            return s.astype(PY_STR).astype("category")
        return s.astype(PY_STR)
    if isinstance(s.dtype, pd.ArrowDtype):
        return s.astype(object)
    return s


for p in PARQUETS:
    out = p.with_name(p.name + ".pkl.gz")
    d = pd.read_parquet(p)
    d = d.apply(no_arrow) if len(d.columns) else d
    d.index = no_arrow(d.index) if not isinstance(d.index, pd.MultiIndex) else d.index
    d.columns = pd.Index(list(d.columns), dtype=object)
    d.to_pickle(out, compression={"method": "gzip", "compresslevel": 6})
    print(f"{p.relative_to(ROOT)} -> {out.name}  {out.stat().st_size / 1e6:.1f} MB")

for name in ["delay_main_calibrator", "delay_calibrator"]:
    iso = joblib.load(MODEL / f"{name}.joblib")
    assert iso.out_of_bounds == "clip"
    (MODEL / f"{name}.json").write_text(json.dumps({"x": iso.X_thresholds_.tolist(), "y": iso.y_thresholds_.tolist()}))
    print(f"{name}.joblib -> {name}.json")

raw = pd.read_csv(ROOT / "Flight_Data_With_Weather_Final.csv", low_memory=False)
test = raw[(raw.ORIGIN.isin(["ATL", "DFW"]) | raw.DEST.isin(["ATL", "DFW"])) & (raw.FL_DATE >= "2025-01-02") & (raw.FL_DATE <= "2025-07-29")]
test.to_csv(PROC / "provided_test_rows.csv.gz", index=False)
d = raw[raw.ORIGIN.isin(["LAX", "ATL", "DFW"])]
d.assign(h=d.CRS_DEP_TIME // 100).groupby(["ORIGIN", "h"]).temp_ORIGIN.mean().round(2).reset_index().to_csv(PROC / "provided_diurnal.csv", index=False)
print(f"provided file -> provided_test_rows.csv.gz ({len(test):,} rows), provided_diurnal.csv")

# BTS context for uploads (aircraft rotation), test period only, just the columns the scorer uses
KEEP = ["FL_DATE", "OP_UNIQUE_CARRIER", "TAIL_NUM", "OP_CARRIER_FL_NUM", "ORIGIN", "DEST", "CRS_DEP_TIME", "DEP_DELAY", "TAXI_OUT",
        "TAXI_IN", "ARR_DELAY", "CANCELLED", "DIVERTED", "CRS_ELAPSED_TIME", "DISTANCE"]
for f in sorted((ROOT / "data" / "external" / "bts").glob("*/bts_2025_*.parquet")):
    d = pd.read_parquet(f, columns=KEEP).apply(no_arrow)
    d.columns = pd.Index(list(d.columns), dtype=object)
    out = f.with_name(f.name + ".pkl.gz")
    d.to_pickle(out, compression={"method": "gzip", "compresslevel": 6})
    print(f"{f.relative_to(ROOT)} -> {out.name}  {out.stat().st_size / 1e6:.1f} MB")
