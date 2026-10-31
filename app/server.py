"""Gatehold: API + web front end.

    .venv/bin/python app/server.py            # then open http://localhost:8600

Models and rules produce all numbers. Jev (TypeSafe) is called live only to read the forecast text.
"""
from __future__ import annotations

import json
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

import ctypes
import platform

# LightGBM needs the OpenMP runtime; serverless hosts (Vercel) don't ship it, so load the bundled copy first.
if platform.system() == "Linux":
    try:
        ctypes.CDLL("libgomp.so.1")
    except OSError:
        ctypes.CDLL(str(Path(__file__).resolve().parents[1] / "vendor" / "libgomp.so.1"), mode=ctypes.RTLD_GLOBAL)
import lightgbm as lgb  # noqa: E402
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import advisor  # noqa: E402
import c5lib as C  # noqa: E402
import jev  # noqa: E402

MODEL, PROC, WEB = ROOT / "data" / "model", ROOT / "data" / "processed", Path(__file__).parent / "web"
LOG = ROOT / "logs" / "decisions.jsonl"
if not __import__("os").access(ROOT, __import__("os").W_OK):   # read-only file system (serverless): keep the log in /tmp
    LOG = Path("/tmp/gatehold/decisions.jsonl")

# ------------------------------------------------------------------ load once
AAR = C.read_table(MODEL / "aar_test.parquet")
METRICS = json.loads((MODEL / "metrics.json").read_text())
CONF = json.loads((MODEL / "conformal.json").read_text())
DEPS = C.read_table(MODEL / "test_departures.parquet")
for c in ["carrier", "dest"]:
    DEPS[c] = DEPS[c].astype("category")
HIST = C.read_table(MODEL / "hourly_history.parquet")
POOL = C.read_table(MODEL / "analog_pool.parquet")
FAIL = C.read_table(MODEL / "failure_cases.parquet")
STORMS = C.read_table(MODEL / "storm_lead_times.parquet")
REPORT = json.loads((PROC / "cleaning_report.json").read_text())
DICT = pd.read_csv(PROC / "data_dictionary.csv")
AAR_MODEL = lgb.Booster(model_file=str(MODEL / "aar_p50.txt"))
CLF = lgb.Booster(model_file=str(MODEL / "delay_clf.txt"))
ISO = C.Calibrator(MODEL / "delay_calibrator")
MAIN = lgb.Booster(model_file=str(MODEL / "delay_main.txt"))
MISO = C.Calibrator(MODEL / "delay_main_calibrator")
MAIN_FEATS = MAIN.feature_name()
HUBF = C.read_table(MODEL / "test_hub_flights.parquet")
for c in ["carrier", "other"]:
    HUBF[c] = HUBF[c].astype("category")
AAR_FEATS = AAR_MODEL.feature_name()
CLF_FEATS = CLF.feature_name()
AIRPORTS = C.TRAIN_AIRPORTS + C.HOLDOUT_AIRPORTS
NAMES = {a: {"KATL": "Atlanta Hartsfield–Jackson", "KDFW": "Dallas/Fort Worth", "KORD": "Chicago O'Hare"}.get(a, C._AP[a]["name"])
         for a in AIRPORTS}
MODEL_VERSION = datetime.fromtimestamp((MODEL / "aar_p50.txt").stat().st_mtime, timezone.utc).strftime("%Y-%m-%d %H:%MZ")
TAF_MAX_AGE_H = 6
METARS = {a: C.load_metar_hourly(a, CONF["headings"][a]) for a in AIRPORTS}
WXS = {a: C.load_hourly_weather(a, CONF["headings"][a]) for a in AIRPORTS}
THR = CONF["main_threshold"]
JEV_CACHE: dict = {}
JEV_LOCK = threading.Lock()

app = FastAPI(title="Gatehold")


def clean(obj):
    """JSON-safe: NaN -> None, timestamps -> ISO strings, numpy -> python."""
    if isinstance(obj, pd.DataFrame):
        return json.loads(obj.to_json(orient="records", date_format="iso"))
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (pd.Timestamp, datetime)):
        return obj.isoformat()
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        return None if not np.isfinite(obj) else float(obj)
    if obj is pd.NA or obj is pd.NaT:
        return None
    return obj


def check_airport(airport):
    if airport not in AIRPORTS:
        raise HTTPException(404, f"Declined: {airport} has no data in this build. Run scripts/run_pipeline.py with it first.")


def issue_time(airport, date, hour):
    check_airport(airport)
    if not 0 <= int(hour) <= 23:
        raise HTTPException(400, "Hour must be 0–23 (local time)")
    tz = C._AP[airport]["tz"]
    try:
        loc = pd.Timestamp(f"{date} {int(hour):02d}:00").tz_localize(tz, ambiguous=False, nonexistent="shift_forward")
    except ValueError:
        raise HTTPException(400, f"Not a valid date: {date!r} (use YYYY-MM-DD)")
    return loc, loc.tz_convert("UTC")


def window(airport, T, stale=False):
    check_airport(airport)
    w = AAR[(AAR.airport == airport) & (AAR.issue_utc == T)].sort_values("hour").copy()
    if w.empty:
        raise HTTPException(404, "Declined: the models were only validated on 2 Jan – 29 Jul 2025, so they don't forecast outside it.")
    w["local"] = w.hour.dt.tz_convert(C._AP[airport]["tz"])
    w["status"] = advisor.hour_status(w, CONF["alert_ratio"])
    if stale:   # demo: pretend the TAF feed stopped 8 h ago
        w["taf_age_h"] = 8.0 + 0 * w.taf_age_h
    # Decline rule: no forecast is shown when its key input (the TAF) is missing or too old
    w["withheld"] = w.issue.isna() | (w.taf_age_h > TAF_MAX_AGE_H)
    w.loc[w.withheld, "status"] = "withheld"
    return w


def contributions(model, X, feats, scale):
    c = model.predict(X[feats], pred_contrib=True)
    return pd.DataFrame(c[:, :-1] * np.asarray(scale)[:, None], columns=feats, index=X.index)


# ------------------------------------------------------------------ API
@app.get("/api/meta")
def meta():
    presets = {}
    for a in AIRPORTS:
        s = STORMS[(STORMS.airport == a) & STORMS.capacity_dropped].sort_values("begin_utc")
        tz = C._AP[a]["tz"]
        presets[a] = [{"label": f"{(r.begin_utc - pd.Timedelta(hours=6)).tz_convert(tz):%a %d %b}: {r.types}",
                       "begin_local": r.begin_utc.tz_convert(tz).strftime("%H:%M"),
                       "date": (r.begin_utc - pd.Timedelta(hours=6)).tz_convert(tz).strftime("%Y-%m-%d"),
                       "hour": int((r.begin_utc - pd.Timedelta(hours=6)).tz_convert(tz).hour)} for _, r in s.iterrows()]
    return clean({"airports": [{"icao": a, "name": NAMES[a], "tz": C._AP[a]["tz"], "heading": CONF["headings"][a],
                                "nominal": CONF["nominal"][a], "trained": a in C.TRAIN_AIRPORTS,
                                "lat": C._AP[a]["lat"], "lon": C._AP[a]["lon"]} for a in AIRPORTS],
                  "range": {"min": "2025-01-02", "max": "2025-07-29"}, "presets": presets,
                  "jev_enabled": (ROOT / ".env").exists() or bool(__import__("os").environ.get("TYPESAFE_API_KEY")), "alert_ratio": CONF["alert_ratio"], "model_version": MODEL_VERSION,
                  "integration": METRICS.get("integration", {}),
                  "metrics_headline": {"main": [r for r in METRICS.get("main_test", []) if r["lead_h"] == 6], "threshold": THR,
                                       "excluded": METRICS.get("main_excluded_cancelled_diverted"),
                                       "rmse": METRICS["aar_rmse_test"][-1], "baselines": METRICS["aar_rmse_test"][:4],
                                       "storm": METRICS["storm_lead_time"], "clf6": [r for r in METRICS["clf_test"] if r["lead_h"] == 6],
                                       "monte_carlo": METRICS.get("monte_carlo"), "bootstrap": METRICS.get("bootstrap_ci_lead6"),
                                       "xgb": METRICS.get("xgb_compare")}})


@app.get("/api/outlook")
def outlook(airport: str, date: str, hour: int, stale: int = 0):
    loc, T = issue_time(airport, date, hour)
    w = window(airport, T, bool(stale))
    tz = C._AP[airport]["tz"]
    heading = CONF["headings"][airport]
    met = METARS[airport].reindex([T])
    m = met.iloc[0]
    wx = WXS[airport].reindex([T]).iloc[0]
    recs = advisor.recommendations(w, CONF["alert_ratio"], heading)
    out = pd.DataFrame({
        "hour_utc": w.hour, "local": w.local.dt.strftime("%Y-%m-%dT%H:%M"), "label": w.local.dt.strftime("%H:%M"),
        "lead": w.lead_h, "sched": w.arr_sched, "pred": w.pred.round(1), "lo": w.lo.round(1), "hi": w.hi.round(1),
        "actual": w.y_arr, "status": w.status, "busy": w.busy, "taf_class": w.taf_class, "taf_raw": w.taf_raw, "ovl_raw": w.ovl_raw,
        "taf_issue": w.issue.dt.tz_convert(tz).dt.strftime("%d %b %H:%M"), "lamp_run": w.runtime.dt.tz_convert(tz).dt.strftime("%d %b %H:%M"),
        "lamp_ltg": w.lamp_ltg_prob, "lamp_conv": w.lamp_conv_prob, "lamp_pop": w.lamp_pop, "lamp_cig": w.lamp_cig_cat,
        "lamp_vis": w.lamp_vis_cat, "taf_tail": w.taf_tailwind_kt.round(1), "taf_cross": w.taf_crosswind_kt.round(1),
        "taf_gust_cross": w.taf_gust_crosswind_kt.round(1), "taf_wind": w.taf_wind_kt, "jev_sev": w.get("jev_worst_severity"),
        "met_cat_at_H": w.met_cat_at_H, "met_ts_at_H": w.met_ts_at_H, "disrupted_rate": w.dep_disrupted_rate,
        "typical": w.b_clim.round(1), "withheld": w.withheld, "taf_age": w.taf_age_h.round(1),
    })
    # Recent history at this airport: the 14 days before the issue time (all known at T)
    h = HIST[(HIST.airport == airport) & (HIST.hour < T) & (HIST.hour >= T - pd.Timedelta(days=14))].copy()
    h["day"] = h.hour.dt.tz_convert(tz).dt.strftime("%Y-%m-%d")
    h["busy"] = h.arr_sched >= 0.4 * CONF["nominal"][airport]
    recent = h.groupby("day").apply(lambda g: pd.Series({
        "disrupted": np.average(g.dep_disrupted_rate.fillna(0), weights=g.dep_sched.clip(lower=0) + 1e-9),
        "landed_ratio": g.loc[g.busy, "arr_actual"].sum() / max(g.loc[g.busy, "arr_sched"].sum(), 1),
        "ts_hours": g.met_ts.sum()}), include_groups=False).reset_index()
    shown = w[~w.withheld]                        # withheld hours never feed a number
    busy = shown[shown.busy == 1]
    worst = busy.loc[(busy.pred / busy.arr_sched).idxmin()] if len(busy) else None
    return clean({
        "airport": airport, "name": NAMES[airport], "tz": tz, "heading": heading, "trained": airport in C.TRAIN_AIRPORTS,
        "issue_local": loc.strftime("%a %d %b %Y, %H:%M"), "issue_utc": T.strftime("%H:%MZ"),
        "hours": out,
        "kpi": {"reduced_hours": int(w.status.isin(["reduced", "severe"]).sum()), "n_hours": len(w),
                "pred_total": float(shown.pred.sum()) if len(shown) else None, "sched_total": float(w.arr_sched.sum()), "actual_total": float(w.y_arr.sum()),
                "worst_label": worst.local.strftime("%H:%M") if worst is not None else None,
                "worst_ratio": float(worst.pred / worst.arr_sched) if worst is not None else None,
                "taf_age": float(w.taf_age_h.iloc[0]) if pd.notna(w.taf_age_h.iloc[0]) else None},
        "wind_now": {"dir": wx.get("wx_wind_dir"), "speed": (wx.get("wx_wind_kmh") or 0) / 1.852, "gust": None,
                     "head": (wx.get("wx_headwind_kmh") or 0) / 1.852, "tail": (wx.get("wx_tailwind_kmh") or 0) / 1.852,
                     "cross": (wx.get("wx_crosswind_kmh") or 0) / 1.852, "cat": m.get("met_cat"), "wx": m.get("met_wxtext"),
                     "vis": m.get("met_vis_sm"), "ceiling": m.get("met_ceiling_ft"), "temp": wx.get("wx_temp_c"),
                     "source": wx.get("wx_source"), "cond": wx.get("wx_cond")},
        "max_fc": {"tail": float(w.taf_tailwind_kt.max()), "cross": float(w.taf_crosswind_kt.max()),
                   "gust_cross": float(w.taf_gust_crosswind_kt.max())},
        "recommendations": recs, "recent": recent, "model_version": MODEL_VERSION,
        "metar_hour": T.tz_convert(tz).strftime("%H:%M local (report in the hour before)"),
        "withheld_hours": int(w.withheld.sum()),
    })


@app.get("/api/explain")
def explain(airport: str, date: str, hour: int, target: str):
    _, T = issue_time(airport, date, hour)
    w = window(airport, T)
    row = w[w.local.dt.strftime("%H:%M") == target]
    if row.empty:
        raise HTTPException(404, "hour not in window")
    con = contributions(AAR_MODEL, row, AAR_FEATS, row.nominal.values).iloc[0]
    top = con.reindex(con.abs().sort_values(ascending=False).index).head(9)
    r = row.iloc[0]
    tz = C._AP[airport]["tz"]
    pool = POOL[POOL.airport == airport].dropna(subset=["taf_worst_cat"])
    feats = ["taf_worst_cat", "taf_any_ts", "lamp_ltg_prob", "lamp_conv_prob", "taf_crosswind_kt", "taf_tailwind_kt",
             "taf_vis_sm", "taf_ceiling_ft", "hour_local", "sched_arr_n"]
    P = pool[feats].fillna(0).astype(float)
    mu, sd = P.mean(), P.std().replace(0, 1)
    q = (r[feats].astype(float).fillna(0) - mu) / sd
    dist = (((P - mu) / sd - q) ** 2).mul([3, 3, 2, 2, 1, 1, 1, 1, 1, 1]).sum(axis=1)
    near = pool.loc[dist.nsmallest(5).index]
    groups = {f: g for g, fs in C.FEATURE_GROUPS.items() for f in fs}
    decoded = [{"raw": t, "en": jev.to_english(jev.weather_text(t))} for t in [r.taf_raw] + (r.ovl_raw.split(" | ") if isinstance(r.ovl_raw, str) else [])
               if isinstance(t, str)]
    return clean({
        "label": target, "lead": int(r.lead_h), "pred": r.pred, "lo": r.lo, "hi": r.hi, "sched": r.arr_sched, "actual": r.y_arr,
        "baseline": float(AAR_MODEL.predict(row[AAR_FEATS], pred_contrib=True)[0, -1] * r.nominal),
        "drivers": [{"feature": f, "label": C.label(f), "group": groups.get(f, "other"), "value": float(v),
                     "input": None if pd.isna(r[f]) else float(r[f])} for f, v in top.items()],
        "taf": decoded,
        "lamp": {"ltg": r.lamp_ltg_prob, "conv": r.lamp_conv_prob, "pop": r.lamp_pop, "cig": r.lamp_cig_cat, "vis": r.lamp_vis_cat},
        "metar_at_issue": {"cat": r.met_cat, "ts": r.met_ts, "tail": r.met_tailwind_kt, "cross": r.met_crosswind_kt},
        "observed": {"cat": r.met_cat_at_H, "ts": r.met_ts_at_H},
        "analogs": pd.DataFrame({"when": near.hour.dt.tz_convert(tz).dt.strftime("%a %d %b %Y %H:%M"), "sched": near.arr_sched,
                                 "landed": near.y_arr, "taf": near.taf_raw, "tempo": near.ovl_raw}),
    })


@app.get("/api/jev_brief")
def jev_brief(airport: str, date: str, hour: int):
    """Jev reads the decoded TAF groups in force over the window and answers typed questions (live call)."""
    loc, T = issue_time(airport, date, hour)
    key = (airport, str(T))
    if key in JEV_CACHE:
        return JEV_CACHE[key]
    w = window(airport, T)
    lines, seen = [], set()
    for _, r in w.iterrows():
        for raw in [r.taf_raw] + (r.ovl_raw.split(" | ") if isinstance(r.ovl_raw, str) else []):
            if isinstance(raw, str):
                en = jev.to_english(jev.weather_text(raw))
                tag = "possible at times" if raw.startswith(("TEMPO", "PROB")) else "expected"
                line = f"{r.local:%H:%M} local ({tag}): {en}"
                if (en, tag) not in seen:
                    seen.add((en, tag)); lines.append(line)
    try:
        with JEV_LOCK:
            ans = jev.brief(lines)
        res = clean({"ok": True, "lines": lines, **ans})
    except Exception as e:  # never break the page if Jev is unavailable
        res = {"ok": False, "error": str(e)[:200], "lines": lines}
    JEV_CACHE[key] = res
    return res


@app.get("/api/departures")
def departures(airport: str, date: str, hour: int):
    _, T = issue_time(airport, date, hour)
    tz = C._AP[airport]["tz"]
    sub = DEPS[(DEPS.airport == airport) & (DEPS.hour >= T + pd.Timedelta(hours=3)) & (DEPS.hour < T + pd.Timedelta(hours=13))].copy()
    if sub.empty:
        return {"flights": [], "by_hour": []}
    sub["lead_h"] = ((sub.hour - T) / pd.Timedelta(hours=1)).astype(int)
    rows = C.assemble_flight_rows(sub, AAR)
    rows["risk"] = ISO.predict(CLF.predict(rows[CLF_FEATS]))
    con = contributions(CLF, rows, CLF_FEATS, np.ones(len(rows)))
    grp = {f: g for g, fs in C.CLF_GROUPS.items() for f in fs}
    gsum = con.T.groupby(pd.Series(grp)).sum().T
    rows["driver"] = gsum.idxmax(axis=1).map({"schedule": "Schedule & route", "ops": "Late inbound / congestion", "weather": "Weather forecast"})
    top = [", ".join(f"{C.label(f)} {'↑' if v > 0 else '↓'}" for f, v in r.reindex(r.abs().sort_values(ascending=False).index).head(4).items())
           for _, r in con.iterrows()]
    rows["why"] = top
    past = DEPS[(DEPS.airport == airport) & (DEPS.sched_dep_utc < T) & (DEPS.sched_dep_utc >= T - pd.Timedelta(days=30))]
    route = past.groupby([past.OP_UNIQUE_CARRIER.astype(str), past.DEST.astype(str)]).disrupted_45.agg(["mean", "size"])
    key = list(zip(rows.OP_UNIQUE_CARRIER.astype(str), rows.DEST.astype(str)))
    rows["route_rate"] = [route["mean"].get(k, np.nan) if route["size"].get(k, 0) >= 5 else np.nan for k in key]
    rows["local"] = rows.sched_dep_utc.dt.tz_convert(tz)
    rows = rows.sort_values("local")
    hr = rows.groupby(rows.local.dt.strftime("%H:00")).agg(forecast=("risk", "mean"), actual=("disrupted_45", "mean"), n=("risk", "size"))
    dly = rows.in_dep_delay_known.round(0)
    dep_txt = np.where(dly > 0, "Departed " + dly.abs().astype("Int64").astype(str) + " min late",
                       np.where(dly < 0, "Departed " + dly.abs().astype("Int64").astype(str) + " min early", "Departed on time"))
    inbound = np.where(rows.in_departed == 1, dep_txt, np.where(rows.has_inbound == 1, "Not yet departed", "No inbound found"))
    fl = pd.DataFrame({"time": rows.local.dt.strftime("%H:%M"), "flight": rows.OP_UNIQUE_CARRIER.astype(str) + rows.OP_CARRIER_FL_NUM.astype("Int64").astype(str),
                       "dest": rows.DEST.astype(str), "tail": rows.TAIL_NUM, "risk": rows.risk.round(3), "driver": rows.driver,
                       "why": rows.why, "route_rate": rows.route_rate,
                       "inbound": inbound, "dep_delay": rows.DEP_DELAY, "cancelled": rows.CANCELLED, "disrupted": rows.disrupted_45})
    return clean({"flights": fl, "by_hour": hr.reset_index().rename(columns={"local": "hour"}),
                  "expected": float(rows.risk.sum()), "actual": int(rows.disrupted_45.sum()), "n": len(rows),
                  "base_rate": METRICS.get("clf_base_rate_test")})


@app.get("/api/flights")
def flights_at_risk(airport: str, date: str, hour: int):
    """MAIN TARGET: every departure from / arrival into the hub 3–12 h ahead, P(delay > 45 min)."""
    _, T = issue_time(airport, date, hour)
    tz = C._AP[airport]["tz"]
    sub = HUBF[(HUBF.airport == airport) & (HUBF.hour >= T + pd.Timedelta(hours=3)) & (HUBF.hour < T + pd.Timedelta(hours=13))].copy()
    if sub.empty:
        raise HTTPException(404, "Declined: no scheduled flights in this window within the validated period.")
    sub["lead_h"] = ((sub.hour - T) / pd.Timedelta(hours=1)).astype(int)
    rows = C.assemble_main_rows(sub, AAR)
    rows["risk"] = MISO.predict(MAIN.predict(rows[MAIN_FEATS]))
    con = contributions(MAIN, rows, MAIN_FEATS, np.ones(len(rows)))
    grp = {f: g for g, fs in C.MAIN_GROUPS.items() for f in fs}
    gsum = con.T.groupby(pd.Series(grp)).sum().T
    rows["driver"] = gsum.idxmax(axis=1).map({"schedule": "Schedule & route", "ops": "Late aircraft / congestion",
                                              "hourly_wx": "Observed weather (≥3 h old)", "forecasts": "Weather forecast (TAF/LAMP)"})
    rows["why"] = [", ".join(f"{C.label(f)} {'↑' if v > 0 else '↓'}" for f, v in r.reindex(r.abs().sort_values(ascending=False).index).head(4).items())
                   for _, r in con.iterrows()]
    past = HUBF[(HUBF.airport == airport) & (HUBF.sched_utc < T - pd.Timedelta(hours=3)) & (HUBF.sched_utc >= T - pd.Timedelta(days=30))]
    route = past.groupby([past.OP_UNIQUE_CARRIER.astype(str), past.other.astype(str), past.is_arrival]).y45.agg(["mean", "size"])
    key = list(zip(rows.OP_UNIQUE_CARRIER.astype(str), rows.other.astype(str), rows.is_arrival))
    rows["route_rate"] = [route["mean"].get(k, np.nan) if route["size"].get(k, 0) >= 5 else np.nan for k in key]
    rows["local"] = rows.sched_utc.dt.tz_convert(tz)
    rows = rows.sort_values("local")
    known = lambda dly, lab: np.where(dly > 0, f"{lab} " + dly.abs().round(0).astype("Int64").astype(str) + " min late",
                                      np.where(dly < 0, f"{lab} " + dly.abs().round(0).astype("Int64").astype(str) + " min early", f"{lab} on time"))
    status = np.where(rows.is_arrival == 1,
                      np.where(rows.own_departed == 1, known(rows.own_dep_delay_known, "Left origin"), "Not yet airborne"),
                      np.where(rows.in_departed == 1, known(rows.in_dep_delay_known, "Inbound departed"),
                               np.where(rows.has_inbound == 1, "Inbound not yet departed", "No inbound found")))
    actual = np.where(rows.is_arrival == 1, rows.ARR_DELAY, rows.DEP_DELAY)
    fl = pd.DataFrame({"time": rows.local.dt.strftime("%H:%M"), "dir": np.where(rows.is_arrival == 1, "ARR", "DEP"),
                       "flight": rows.OP_UNIQUE_CARRIER.astype(str) + rows.OP_CARRIER_FL_NUM.astype("Int64").astype(str),
                       "other": rows.other.astype(str), "tail": rows.TAIL_NUM, "risk": rows.risk.round(3), "flag": rows.risk >= THR,
                       "driver": rows.driver, "why": rows.why, "route_rate": rows.route_rate, "status": status,
                       "actual_delay": actual, "cancelled": rows.CANCELLED, "y45": rows.y45})
    hr = rows.assign(h=rows.local.dt.strftime("%H:00")).groupby("h").agg(forecast=("risk", "mean"), actual=("y45", "mean"), n=("risk", "size"))
    lab = rows.y45.notna()
    tp = int(((rows.risk >= THR) & (rows.y45 == 1)).sum())
    return clean({"flights": fl, "by_hour": hr.reset_index().rename(columns={"h": "hour"}), "threshold": THR,
                  "expected": float(rows.risk.sum()), "flagged": int((rows.risk >= THR).sum()), "n": len(rows),
                  "actual": int(rows.y45.sum()), "tp": tp, "labelled": int(lab.sum()),
                  "base_rate": next((r["base rate"] for r in METRICS["main_test"] if r["lead_h"] == 6 and r["scope"] == "ATL+DFW"), None)})


@app.get("/api/performance")
def performance():
    ex = FAIL.iloc[0]
    return clean({"metrics": METRICS, "worst_case": {
        "airport": ex.airport, "when": ex.hour.tz_convert(C._AP[ex.airport]["tz"]).strftime("%a %d %b %Y %H:%M local"),
        "pred": ex.pred, "lo": ex.lo, "hi": ex.hi, "actual": ex.y_arr, "sched": ex.arr_sched, "cause": ex["likely cause"],
        "taf": ex.taf_raw, "tempo": ex.ovl_raw, "lamp_ltg": ex.lamp_ltg_prob},
        "failures": FAIL.head(12).assign(hour=FAIL.head(12).hour.astype(str))[["airport", "hour", "arr_sched", "y_arr", "pred", "taf_raw", "likely cause"]]})


@app.get("/api/trends")
def trends(airport: str):
    check_airport(airport)
    tz = C._AP[airport]["tz"]
    hh = HIST[HIST.airport == airport].copy()
    hh["local"] = hh.hour.dt.tz_convert(tz).dt.tz_localize(None)
    hh["busy"] = hh.arr_sched >= 0.4 * CONF["nominal"][airport]
    hh["drop"] = hh.busy & (hh.arr_actual < 0.8 * hh.arr_sched)
    mon = hh.groupby(hh.local.dt.to_period("M").astype(str)).agg(disrupted=("dep_disrupted_rate", "mean"), drop=("drop", "sum"),
                                                                busy=("busy", "sum"), ts=("met_ts", "sum"))
    mon["drop_share"] = mon["drop"] / mon.busy
    hh["wx"] = np.select([hh.met_ts == 1, hh.met_cat >= 2, hh.met_tailwind_kt > 10, hh.met_crosswind_kt > 20],
                         ["Thunderstorm", "IFR / LIFR", "Tailwind > 10 kt", "Crosswind > 20 kt"], default="Fair weather")
    b = hh[hh.busy].groupby("wx").apply(lambda g: pd.Series({"ratio": (g.arr_actual / g.arr_sched).mean(), "hours": len(g),
                                                             "disrupted": g.dep_disrupted_rate.mean()}), include_groups=False)
    hm = hh.assign(h=hh.local.dt.hour, m=hh.local.dt.month).pivot_table(index="h", columns="m", values="dep_disrupted_rate", aggfunc="mean")
    cmp_ = []
    for a in AIRPORTS:
        g = HIST[HIST.airport == a]
        busy = g.arr_sched >= 0.4 * CONF["nominal"][a]
        cmp_.append({"airport": a, "flights_per_day": (g.dep_sched.sum() + g.arr_sched.sum()) / (len(g) / 24),
                     "disrupted_share": g.dep_disrupted_rate.mean(),
                     "delay_min_per_dep": np.average(g.dep_delay_rt.fillna(0), weights=g.dep_actual + 1e-9),
                     "drop_share": ((g.arr_actual < 0.8 * g.arr_sched) & busy).sum() / busy.sum(),
                     "ts_hours_per_year": g.met_ts.sum() / (len(g) / 8766)})
    return clean({"monthly": mon.reset_index().rename(columns={"local": "month"}), "by_weather": b.reset_index(),
                  "heatmap": {"hours": list(hm.index), "months": list(hm.columns), "z": hm.values.tolist()}, "compare": cmp_})


@app.get("/api/data_story")
def data_story():
    dv = pd.read_csv(PROC / "provided_diurnal.csv").pivot(index="h", columns="ORIGIN", values="temp_ORIGIN")   # from export_slim_runtime.py
    full = HIST[HIST.airport == "KATL"].set_index("hour").dep_sched.resample("D").sum()
    prov = C.read_table(PROC / "flights_clean_hubs.parquet", columns=["ORIGIN", "FL_DATE"])
    prov = prov[prov.ORIGIN == "ATL"].groupby("FL_DATE").size()
    drops = pd.Series(REPORT["dropped_columns"]).rename_axis("column").reset_index(name="reason")
    dgroups = [{"reason": k, "columns": list(v)} for k, v in drops.groupby("reason").column]
    return clean({"report": {k: REPORT[k] for k in ["raw_rows", "raw_columns", "clean_rows_hubs", "clean_columns"]},
                  "integration": METRICS.get("integration", {}),
                  "diurnal": {"hours": list(dv.index), **{c: dv[c].tolist() for c in dv.columns}},
                  "sample": {"dates": [d.strftime("%Y-%m-%d") for d in full.index], "full": full.tolist(),
                             "prov": prov.reindex([d.strftime("%Y-%m-%d") for d in full.index]).tolist()},
                  "dropped": dgroups, "dictionary": DICT[["column", "role", "null_frac", "description"]]})


# ------------------------------------------------------------------ "Try the model": score your own data
_SCORER = None
def scorer():
    global _SCORER
    if _SCORER is None:
        import scoring
        _SCORER = scoring.Scorer()
    return _SCORER


@app.post("/api/predict")
async def predict(req: Request, lead: int = 6):
    """Body: CSV text (organisers' or BTS format). Returns per-flight P(delay > 45 min) and, if delays are present, metrics."""
    import io, time as _t
    t0 = _t.time()
    body = (await req.body()).decode("utf-8", errors="replace")
    try:
        raw = pd.read_csv(io.StringIO(body), low_memory=False)
        res = scorer().score(raw, lead=lead)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    rows = res["rows"]
    return clean({"summary": res["summary"], "notes": res["notes"], "input_rows": len(raw),
                  "seconds": round(_t.time() - t0, 2), "rows": rows.head(5000)})


@app.get("/api/sample_csv")
def sample_csv(n: int = 300, seed: int = 7):
    """A sample of the organisers' own file (ATL/DFW, 2025 test period) to try the pipeline with."""
    from fastapi.responses import PlainTextResponse
    raw = pd.read_csv(PROC / "provided_test_rows.csv.gz", low_memory=False)   # organisers' rows, ATL/DFW, test period
    return PlainTextResponse(raw.sample(min(n, len(raw)), random_state=seed).to_csv(index=False), media_type="text/csv")


@app.get("/api/predict_one")
def predict_one(origin: str, dest: str, date: str, dep_time: str, carrier: str = "DL", flight: int = 1000,
                block_min: int | None = None, lead: int = 6):
    hhmm = int(dep_time.replace(":", ""))
    raw = pd.DataFrame([{"FL_DATE": date, "OP_UNIQUE_CARRIER": carrier, "OP_CARRIER_FL_NUM": flight, "ORIGIN": origin,
                         "DEST": dest, "CRS_DEP_TIME": hhmm, "CRS_ELAPSED_TIME": block_min}])
    try:
        res = scorer().score(raw, lead=lead)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    if res["rows"].empty:
        raise HTTPException(404, "Declined: " + " · ".join(res["notes"] or ["no hub flight to score"]))
    return clean({"rows": res["rows"], "notes": res["notes"], "summary": res["summary"]})


@app.post("/api/decision")
async def decision(req: Request):
    d = await req.json()
    d["logged_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps(d) + "\n")
    return {"ok": True}


@app.get("/api/decisions")
def decisions():
    if not LOG.exists():
        return []
    return [json.loads(l) for l in LOG.read_text().splitlines()[-50:]][::-1]


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.middleware("http")
async def no_stale_frontend(request: Request, call_next):
    """Browsers revalidate the page and its scripts on every load, so a code change shows up on refresh."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


if __name__ == "__main__":
    import uvicorn
    import os
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8600)), log_level="warning")
