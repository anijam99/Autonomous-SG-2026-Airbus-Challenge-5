"""Deterministic recommendation rules for the Traffic Management Coordinator.

Every recommendation names the rule that fired and the numbers behind it. Nothing here is learned
or generated: the forecast models supply numbers, these rules turn them into suggestions, and
a person accepts or dismisses each one.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def hour_status(w: pd.DataFrame, alert: float) -> pd.Series:
    ratio = w.pred / w.arr_sched.replace(0, np.nan)
    lo_ratio = w.lo / w.arr_sched.replace(0, np.nan)
    busy = w.busy == 1
    return pd.Series(np.select([busy & (lo_ratio < 0.6) & (ratio < 0.8), busy & (ratio < alert), busy & (lo_ratio < 0.75)],
                               ["severe", "reduced", "watch"], default="ok"), index=w.index)


def recommendations(w: pd.DataFrame, alert: float, heading: float) -> list[dict]:
    """w: one forecast window (rows = target hours) with status, local, pred/lo/hi, TAF/LAMP features."""
    recs = []
    fmt = lambda s: ", ".join(s.dt.strftime("%H:%M"))
    red = w[w.status.isin(["reduced", "severe"])]  # withheld hours never trigger actions
    if len(red) >= 2:
        end = red.local.max() + pd.Timedelta(hours=1)
        recs.append({
            "level": "reduced", "id": "gdp",
            "title": f"Consider a Ground Delay Program {red.local.min():%H:%M}–{end:%H:%M} local",
            "body": f"Suggested arrival rate ≈ {int(red.pred.median())}/h (80% band {int(red.lo.median())}–{int(red.hi.median())}) "
                    f"against {int(red.arr_sched.median())}/h scheduled. Holding flights at their origin now avoids airborne holding later. "
                    f"A band-aware rate of {int(red.hi.median())}/h holds fewer flights if you expect the forecast to be pessimistic.",
            "trigger": f"{len(red)} hours with forecast below {alert:.0%} of schedule"})
    sev = w[w.status == "severe"]
    if len(sev):
        recs.append({"level": "severe", "id": "contingency", "title": "High-impact hours: prepare contingency",
                     "body": f"At {fmt(sev.local)} even the optimistic end of the band is well below schedule. "
                             "Coordinate with airline operations on cancellations or diversions.",
                     "trigger": "lower band < 60% of schedule and forecast < 80%"})
    ts = w[(w.taf_any_ts.fillna(0) > 0) | (w.lamp_ltg_prob.fillna(0) >= 20)]
    if len(ts):
        recs.append({"level": "watch", "id": "convective", "title": "Convective weather window",
                     "body": f"Thunderstorm signal at {fmt(ts.local)}. Plan arrival reroutes and holding-fuel advisories. "
                             "The model is least reliable in convection; storm impact is often under-estimated.",
                     "trigger": "TAF TS/VCTS (incl. TEMPO/PROB30) or LAMP lightning probability ≥ 20%"})
    wind = w[(w.taf_tailwind_kt.fillna(0) > 10) | (w.taf_gust_crosswind_kt.fillna(0) > 25)]
    if len(wind):
        recs.append({"level": "watch", "id": "wind", "title": f"Runway wind limit on heading {heading:.0f}°",
                     "body": f"Forecast tailwind > 10 kt or gust crosswind > 25 kt at {fmt(wind.local)}. "
                             "Expect a runway configuration change and a temporary rate reduction.",
                     "trigger": "TAF wind resolved onto the runway heading"})
    taf_age = w.taf_age_h.iloc[0] if "taf_age_h" in w and len(w) else np.nan
    wide = ((w.hi - w.lo) > 0.5 * w.arr_sched.clip(lower=1))[w.busy == 1].mean() > 0.5
    if pd.isna(taf_age) or taf_age > 6 or w.runtime.isna().mean() > 0.5 or wide:
        recs.append({"level": "watch", "id": "confidence", "title": "Low confidence: rely on your judgement",
                     "body": "Inputs are stale or missing, or the uncertainty band is wide. Treat the numbers as indicative only.",
                     "trigger": f"TAF age {taf_age:.1f} h (limit 6 h); LAMP missing for {w.runtime.isna().mean():.0%} of hours; "
                                f"wide band in most busy hours: {bool(wide)}"})
    wh = w[w.status == "withheld"] if "status" in w else w.iloc[0:0]
    if len(wh):
        recs.insert(0, {"level": "withheld", "id": "withheld", "title": f"Forecast withheld for {len(wh)} hour(s)",
                        "body": "The TAF these hours depend on is missing or more than 6 h old, so no number is shown. "
                                "Use the 'typical' line and current observations, and check the TAF feed.",
                        "trigger": f"TAF age {w.taf_age_h.max():.1f} h > 6 h or no TAF in force"})
    if not recs:
        recs.append({"level": "ok", "id": "none", "title": "No action suggested",
                     "body": "Forecast landings stay within 15% of schedule for the whole window.", "trigger": "no rule fired"})
    return recs
