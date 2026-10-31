"""Score any flights file with the main-target model: P(delay > 45 min), 3–12 h ahead.

Input: a CSV in the organisers' format (Flight_Data_With_Weather_Final.csv) or BTS format. Minimum columns:
    FL_DATE, OP_UNIQUE_CARRIER, OP_CARRIER_FL_NUM, ORIGIN, DEST, CRS_DEP_TIME, and CRS_ELAPSED_TIME or CRS_ARR_TIME
Optional: TAIL_NUM, DISTANCE, DEP_DELAY, ARR_DELAY (if present, precision/recall are reported), CANCELLED, DIVERTED.
Used by app/server.py (/api/predict) and scripts/predict.py.
"""
from __future__ import annotations

import json
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd

import c5lib as C

REQUIRED = ["FL_DATE", "OP_UNIQUE_CARRIER", "OP_CARRIER_FL_NUM", "ORIGIN", "DEST", "CRS_DEP_TIME"]
OPTIONAL_NUM = ["DEP_DELAY", "ARR_DELAY", "TAXI_OUT", "TAXI_IN", "DISTANCE", "CRS_ELAPSED_TIME", "CRS_ARR_TIME"]


class Scorer:
    def __init__(self, model_dir: Path = C.MODEL_DIR):
        self.model = lgb.Booster(model_file=str(model_dir / "delay_main.txt"))
        self.iso = joblib.load(model_dir / "delay_main_calibrator.joblib")
        self.feats = self.model.feature_name()
        self.thr = json.loads((model_dir / "conformal.json").read_text())["main_threshold"]
        fs = pd.read_parquet(model_dir / "feature_store.parquet")
        self.fs = fs
        self.airports = sorted(fs.airport.unique())
        self.hmin, self.hmax = fs.hour.min(), fs.hour.max()

    # ---------------------------------------------------------- input handling
    def normalise(self, raw: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
        notes = []
        df = raw.copy()
        df.columns = [c.strip().upper() for c in df.columns]
        alias = {"FLIGHTDATE": "FL_DATE", "REPORTING_AIRLINE": "OP_UNIQUE_CARRIER", "CARRIER": "OP_UNIQUE_CARRIER",
                 "FLIGHT_NUMBER_REPORTING_AIRLINE": "OP_CARRIER_FL_NUM", "TAIL_NUMBER": "TAIL_NUM", "CRSDEPTIME": "CRS_DEP_TIME",
                 "CRSARRTIME": "CRS_ARR_TIME", "CRSELAPSEDTIME": "CRS_ELAPSED_TIME", "DEPDELAY": "DEP_DELAY", "ARRDELAY": "ARR_DELAY"}
        df = df.rename(columns={k: v for k, v in alias.items() if k in df.columns})
        missing = [c for c in REQUIRED if c not in df.columns]
        if missing:
            raise ValueError(f"Missing required columns: {', '.join(missing)}")
        for c in OPTIONAL_NUM:
            df[c] = pd.to_numeric(df[c], errors="coerce") if c in df else np.nan
        for c in ["CANCELLED", "DIVERTED"]:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0) if c in df else 0
        if "TAIL_NUM" not in df:
            df["TAIL_NUM"] = None
        df["ORIGIN"] = df.ORIGIN.astype(str).str.strip().str.upper().str.replace(r"^K(?=[A-Z]{3}$)", "", regex=True)
        df["DEST"] = df.DEST.astype(str).str.strip().str.upper().str.replace(r"^K(?=[A-Z]{3}$)", "", regex=True)
        df["FL_DATE"] = pd.to_datetime(df.FL_DATE).dt.strftime("%Y-%m-%d")
        df["CRS_DEP_TIME"] = pd.to_numeric(df.CRS_DEP_TIME, errors="coerce")
        df["OP_CARRIER_FL_NUM"] = pd.to_numeric(df.OP_CARRIER_FL_NUM, errors="coerce")
        df["OP_UNIQUE_CARRIER"] = df.OP_UNIQUE_CARRIER.astype(str).str.strip().str.upper()
        known = {c for c in pd.unique(df[["ORIGIN", "DEST"]].values.ravel()) if c in C._AP_IATA}
        bad = ~(df.ORIGIN.isin(known) & df.DEST.isin(known))
        if bad.any():
            notes.append(f"{bad.sum()} rows have an unknown airport code and were skipped")
            df = df[~bad]
        # Scheduled block time: from CRS_ARR_TIME if needed (local times in each airport's time zone)
        need = df.CRS_ELAPSED_TIME.isna() & df.CRS_ARR_TIME.notna()
        if need.any():
            tmp = df[need].assign(CRS_ELAPSED_TIME=0)
            tmp = C.prepare_flights(tmp)
            arr_naive = (pd.to_datetime(tmp.FL_DATE) + pd.to_timedelta(tmp.CRS_ARR_TIME // 100, unit="h")
                         + pd.to_timedelta(tmp.CRS_ARR_TIME % 100, unit="m"))
            arr_utc = pd.Series([t.tz_localize(C.tz_of_iata(d), ambiguous=False, nonexistent="shift_forward").tz_convert("UTC")
                                 for t, d in zip(arr_naive, tmp.DEST)], index=tmp.index)
            mins = (arr_utc - tmp.sched_dep_utc).dt.total_seconds() / 60
            mins = mins.where(mins > 0, mins + 1440)
            df.loc[need, "CRS_ELAPSED_TIME"] = mins.values
            notes.append(f"Scheduled block time derived from CRS_ARR_TIME for {need.sum()} rows")
        if df.DISTANCE.isna().any():
            la = lambda c: np.radians(df[c].map(lambda x: C._AP_IATA[x]["lat"]).astype(float))
            lo = lambda c: np.radians(df[c].map(lambda x: C._AP_IATA[x]["lon"]).astype(float))
            gc = 3958.8 * 2 * np.arcsin(np.sqrt(np.sin((la("DEST") - la("ORIGIN")) / 2) ** 2 + np.cos(la("ORIGIN")) * np.cos(la("DEST"))
                                                * np.sin((lo("DEST") - lo("ORIGIN")) / 2) ** 2))
            df["DISTANCE"] = df.DISTANCE.fillna(gc.round())
        est = df.CRS_ELAPSED_TIME.isna()
        if est.any():   # stated assumption: ~450 mph cruise plus 30 min taxi/climb/descent
            df.loc[est, "CRS_ELAPSED_TIME"] = (df.loc[est, "DISTANCE"] / 7.5 + 30).round()
            notes.append(f"Block time estimated from distance for {est.sum()} rows (450 mph + 30 min)")
        df = df[df.CRS_ELAPSED_TIME.notna() & df.CRS_DEP_TIME.notna()]
        df["_uid"] = np.arange(len(df))
        return df.reset_index(drop=True), notes

    # ---------------------------------------------------------- scoring
    def score(self, raw: pd.DataFrame, lead: int = 6, max_rows: int = 20000) -> dict:
        if not 3 <= lead <= 12:
            raise ValueError("Lead time must be 3–12 h (the 3-hour weather rule)")
        df, notes = self.normalise(raw)
        if len(df) > max_rows:
            notes.append(f"Only the first {max_rows:,} rows were scored")
            df = df.head(max_rows)
        hub_codes = {C.iata_of(a): a for a in self.airports}
        touches = df.ORIGIN.isin(hub_codes) | df.DEST.isin(hub_codes)
        if (~touches).any():
            notes.append(f"{(~touches).sum()} rows don't touch a processed airport ({', '.join(hub_codes)}) and were declined. "
                         "Run scripts/run_pipeline.py --holdout <ICAO> to add an airport")
        df = df[touches]
        if df.empty:
            return {"rows": pd.DataFrame(), "notes": notes, "summary": {}}
        upload = C.prepare_flights(df)
        upload["_src"] = "upload"
        # Context for aircraft rotation: the same months from BTS (if downloaded)
        months = sorted(set(pd.to_datetime(upload.FL_DATE).dt.strftime("%Y_%m")))
        ctx = []
        bdir = C.bts_dir(C.TRAIN_AIRPORTS + C.HOLDOUT_AIRPORTS)
        for m in months:
            f = bdir / f"bts_{m}.parquet"
            if f.exists():
                ctx.append(pd.read_parquet(f))
        if ctx:
            c = pd.concat(ctx, ignore_index=True)
            c = C.prepare_flights(c[c.CRS_ELAPSED_TIME.notna()])
            c["_src"] = "ctx"; c["_uid"] = -1
            allf = pd.concat([upload, c], ignore_index=True)
        else:
            allf = upload
            notes.append("No BTS context for these months: aircraft-rotation features left empty")
        rows = C.hub_flight_rows(allf, [a for a in self.airports if C.iata_of(a) in set(df.ORIGIN) | set(df.DEST)])
        rows = rows[rows._src == "upload"].copy()
        rows["lead_h"] = lead
        in_range = (rows.hour - pd.Timedelta(hours=lead) >= self.hmin) & (rows.hour <= self.hmax)
        if (~in_range).any():
            notes.append(f"{(~in_range).sum()} flight-ends are outside the period with weather/forecast data "
                         f"({self.hmin:%Y-%m-%d} to {self.hmax:%Y-%m-%d}) and were declined")
        rows = rows[in_range]
        if rows.empty:
            return {"rows": pd.DataFrame(), "notes": notes, "summary": {}}
        d = C.assemble_main_rows(rows, self.fs)          # asserts the 3-hour weather rule
        d["risk"] = self.iso.predict(self.model.predict(d[self.feats]))
        con = self.model.predict(d[self.feats], pred_contrib=True)[:, :-1]
        top = np.argsort(-np.abs(con), axis=1)[:, :4]
        d["reasons"] = [", ".join(f"{C.label(self.feats[j])} {'↑' if con[i, j] > 0 else '↓'}" for j in row) for i, row in enumerate(top)]
        d["flag"] = d.risk >= self.thr
        out = pd.DataFrame({
            "row": d._uid, "direction": np.where(d.is_arrival == 1, "arrival", "departure"), "hub": d.airport,
            "flight": d.OP_UNIQUE_CARRIER.astype(str) + d.OP_CARRIER_FL_NUM.astype("Int64").astype(str),
            "route": d.ORIGIN + "→" + d.DEST, "date": d.FL_DATE, "sched_utc": d.sched_utc.dt.strftime("%Y-%m-%d %H:%MZ"),
            "forecast_issued_utc": d.issue_utc.dt.strftime("%Y-%m-%d %H:%MZ"), "weather_observed_utc": (d.hour - pd.to_timedelta(d.lead_h, unit="h")).dt.strftime("%Y-%m-%d %H:%MZ"),
            "p_delay_gt45": d.risk.round(3), "flag_gt45": d.flag, "top_reasons": d.reasons,
            "actual_delay": np.where(d.is_arrival == 1, d.ARR_DELAY, d.DEP_DELAY), "actual_gt45": d.y45})
        summ = {"scored": int(len(out)), "flagged": int(out.flag_gt45.sum()), "threshold": self.thr, "lead_h": lead}
        # Rows before the test period overlap training/validation data: score them, but keep them out of the metrics
        test_start = pd.Timestamp(C.SPLITS["test"][0], tz="UTC")
        out["in_test_period"] = (d.hour >= test_start).values
        seen = int((~out.in_test_period).sum())
        if seen:
            notes.append(f"{seen} flight-ends are before 2025, inside the training/validation period. They are scored, "
                         "but left out of precision/recall because the model has seen those days")
            summ["in_sample_rows"] = seen
        lab = out.actual_gt45.notna() & out.in_test_period
        if lab.sum() >= 10 and out.loc[lab, "actual_gt45"].nunique() == 2:
            from sklearn.metrics import average_precision_score, roc_auc_score
            y, p, a = out.loc[lab, "actual_gt45"].astype(int), out.loc[lab, "p_delay_gt45"], out.loc[lab, "flag_gt45"]
            tp = int((a & (y == 1)).sum())
            summ.update({"labelled": int(lab.sum()), "base_rate": float(y.mean()), "precision": tp / max(int(a.sum()), 1),
                         "recall": tp / max(int(y.sum()), 1), "pr_auc": float(average_precision_score(y, p)),
                         "roc_auc": float(roc_auc_score(y, p)), "accuracy": float((a == (y == 1)).mean())})
        return {"rows": out.sort_values("p_delay_gt45", ascending=False), "notes": notes, "summary": summ}
