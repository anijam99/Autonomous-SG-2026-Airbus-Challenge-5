"""Score your own flights file from the command line (same pipeline as the web app's "Try the model" page).

    python scripts/predict.py my_flights.csv                 # 6 h ahead (default)
    python scripts/predict.py my_flights.csv --lead 3 -o predictions.csv

Accepts the organisers' format (Flight_Data_With_Weather_Final.csv) or BTS format.
If DEP_DELAY / ARR_DELAY are present, precision, recall and PR-AUC are printed.
"""
import argparse
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from scoring import Scorer  # noqa: E402

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("csv")
ap.add_argument("--lead", type=int, default=6, help="hours before the scheduled time (3–12)")
ap.add_argument("-o", "--out", default="predictions.csv")
a = ap.parse_args()
res = Scorer().score(pd.read_csv(a.csv, low_memory=False), lead=a.lead)
for n in res["notes"]:
    print("note:", n)
res["rows"].to_csv(a.out, index=False)
print(json.dumps(res["summary"], indent=2))
print(f"wrote {len(res['rows']):,} predictions to {a.out}")
