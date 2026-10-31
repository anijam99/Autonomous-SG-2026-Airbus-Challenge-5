"""Shared pipeline code for Challenge 5: used by the modelling notebook and the dashboard.

Nothing here is specific to one airport: every function takes an ICAO code and a runway heading.
Time rule used everywhere: a value may be used for a forecast issued at time T only if it was
observed or issued at or before T.
"""
from __future__ import annotations

import ast
from pathlib import Path

import airportsdata
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "data" / "external"
MODEL_DIR = ROOT / "data" / "model"

# Runway headings: ATL and DFW follow the challenge brief. Any other airport falls back to its
# longest open runway from OurAirports, so the pipeline accepts any ICAO code.
BRIEF_HEADINGS = {"KATL": 80.0, "KDFW": 180.0}
# Airports are configurable: C5_TRAIN="KATL KDFW" C5_HOLDOUT="KORD" (any ICAO codes; see scripts/run_pipeline.py)
TRAIN_AIRPORTS = __import__("os").environ.get("C5_TRAIN", "KATL KDFW").split()
HOLDOUT_AIRPORTS = __import__("os").environ.get("C5_HOLDOUT", "KORD").split()   # never seen in training
LEADS = list(range(3, 13))           # forecast lead times in hours
SEVERE_MIN = 45

SPLITS = {  # by target time (UTC)
    "train": ("2023-01-02", "2024-07-01"),
    "val": ("2024-07-01", "2025-01-01"),
    "test": ("2025-01-01", "2025-07-31"),
}

CAT_CODE = {"VFR": 0, "MVFR": 1, "IFR": 2, "LIFR": 3}

_AP = airportsdata.load("ICAO")
_AP_IATA = airportsdata.load("IATA")
# Palm Beach (PBI) was renamed DJT in 2026 airport data; BTS 2023-2025 still uses PBI
if "PBI" not in _AP_IATA and "DJT" in _AP_IATA:
    _AP_IATA["PBI"] = {**_AP_IATA["DJT"], "iata": "PBI"}


# ------------------------------------------------------------------ airports
def bts_dir(airports_icao) -> Path:
    """Cache folder for BTS monthly files filtered to a given airport set."""
    return EXT / "bts" / "-".join(sorted(iata_of(a) for a in airports_icao))


def iata_of(icao: str) -> str:
    return _AP[icao]["iata"]


def tz_of_iata(code: str) -> str:
    return _AP_IATA[code]["tz"]


def runway_heading(icao: str) -> float:
    if icao in BRIEF_HEADINGS:
        return BRIEF_HEADINGS[icao]
    rw = pd.read_csv(EXT / "ourairports" / "runways.csv", low_memory=False)
    rw = rw[(rw.airport_ident == icao) & (rw.closed == 0)].sort_values("length_ft", ascending=False)
    return float(rw.le_heading_degT.iloc[0])


# ------------------------------------------------------------------ weather helpers
def wind_components(direction, speed, heading):
    """Headwind (+) / tailwind (-) and crosswind (abs) for a runway heading. Direction = wind FROM."""
    ang = np.deg2rad(np.asarray(direction, dtype=float) - heading)
    speed = np.asarray(speed, dtype=float)
    return speed * np.cos(ang), np.abs(speed * np.sin(ang))


def add_wind_columns(df, prefix, direction, speed, gust, heading):
    """Adds head/tail/cross (and gust crosswind) columns, treating calm and variable winds safely."""
    speed = pd.Series(speed, index=df.index).astype(float)
    direction = pd.Series(direction, index=df.index).astype(float)
    gust = pd.Series(gust, index=df.index).astype(float)
    gust = gust.where(gust > 0, speed)
    calm = speed.fillna(0) == 0
    variable = direction.isna() & ~calm          # VRB: no direction, so assume the worst case
    head, cross = wind_components(direction, speed, heading)
    _, gcross = wind_components(direction, gust, heading)
    df[f"{prefix}_wind_kt"] = speed
    df[f"{prefix}_gust_kt"] = gust
    df[f"{prefix}_headwind_kt"] = np.where(calm, 0, np.where(variable, -speed, head))
    df[f"{prefix}_tailwind_kt"] = np.clip(-df[f"{prefix}_headwind_kt"], 0, None) + 0.0
    df[f"{prefix}_crosswind_kt"] = np.where(calm, 0, np.where(variable, speed, cross))
    df[f"{prefix}_gust_crosswind_kt"] = np.where(calm, 0, np.where(variable, gust, gcross))
    return df


def flight_category(ceiling_ft, vis_sm):
    c = pd.Series(ceiling_ft).fillna(1e5).to_numpy()
    v = pd.Series(vis_sm).fillna(10).to_numpy()
    return np.select([(c < 500) | (v < 1), (c < 1000) | (v < 3), (c <= 3000) | (v <= 5)], [3, 2, 1], default=0)


# ------------------------------------------------------------------ METAR
def load_metar_hourly(icao: str, heading: float) -> pd.DataFrame:
    """Hourly METAR table keyed by obs hour (report at hh:52 -> next full hour).

    Includes special reports: worst visibility/ceiling and any thunderstorm within the hour.
    """
    m = pd.read_csv(EXT / "metar" / f"metar_{icao}.csv", na_values=["M"], low_memory=False)
    m["valid"] = pd.to_datetime(m["valid"]).dt.tz_localize("UTC")
    m["hour"] = m.valid.dt.ceil("h")
    layers = [m[f"skyl{i}"].where(m[f"skyc{i}"].isin(["BKN", "OVC", "VV"])) for i in (1, 2, 3)]
    m["ceiling_ft"] = pd.concat(layers, axis=1).min(axis=1)
    wx = m.wxcodes.fillna("")
    m["ts"] = wx.str.contains("TS").astype(int)
    m["snow"] = wx.str.contains("SN|PL|GS").astype(int)          # snow, ice pellets, small hail
    m["fz"] = wx.str.contains("FZ").astype(int)
    m["rain"] = wx.str.contains("RA").astype(int)
    m["p01m"] = pd.to_numeric(m.p01m.replace("T", 0.01), errors="coerce")
    m = m.sort_values("valid")
    last = m.groupby("hour").last(numeric_only=False)
    agg = m.groupby("hour").agg(ts=("ts", "max"), snow=("snow", "max"), fz=("fz", "max"), rain=("rain", "max"),
                                vis_min=("vsby", "min"), ceil_min=("ceiling_ft", "min"), gust_max=("gust", "max"),
                                n_reports=("valid", "size"))
    h = pd.DataFrame(index=last.index)
    h["met_temp_c"] = last.tmpc
    h["met_dewpt_spread"] = last.tmpc - last.dwpc
    h["met_pres_hpa"] = last.mslp
    h["met_vis_sm"] = agg.vis_min
    h["met_ceiling_ft"] = agg.ceil_min
    h["met_cat"] = flight_category(h.met_ceiling_ft, h.met_vis_sm)
    h["met_ceiling_ft"] = h.met_ceiling_ft.where(h.met_ceiling_ft.notna() | h.met_vis_sm.isna(), 30000)  # no ceiling
    h["met_ts"] = agg.ts
    h["met_snow"] = agg.snow
    h["met_fz"] = agg.fz
    h["met_rain"] = agg.rain
    h["met_precip_mm"] = last.p01m
    h["met_specials"] = agg.n_reports - 1          # special reports = rapidly changing weather
    add_wind_columns(h, "met", last.drct, last.sknt, agg.gust_max, heading)
    h["met_wind_dir"] = last.drct
    full = pd.date_range(h.index.min(), h.index.max(), freq="h", name="hour")
    h = h.reindex(full)
    h["met_pres_tend_3h"] = h.met_pres_hpa - h.met_pres_hpa.shift(3)
    h["met_wxtext"] = last.wxcodes.reindex(full)
    return h


# ------------------------------------------------------------------ hourly weather (organisers' file / Meteostat)
CHALLENGE_WX = ROOT / "data" / "challenge" / "challenge-5-hourly-weather-atl-dfw.csv"
MIN_WX_LAG_H = 3     # challenge rule: only weather observed >= 3 h before the scheduled time


def load_hourly_weather(icao: str, heading: float) -> pd.DataFrame:
    """Hourly weather indexed by observation hour (UTC). ATL/DFW come from the organisers' file
    (Meteostat stations 72219/72259); any other airport from the same Meteostat source, fetched by script."""
    code = iata_of(icao)
    w = pd.read_csv(CHALLENGE_WX)
    w = w[w.airport == code]
    if w.empty:
        w = pd.read_parquet(EXT / "meteostat" / f"meteostat_{icao}.parquet")
    w = w.copy()
    w["hour"] = pd.to_datetime(w.time_utc).dt.tz_localize("UTC")
    w = w.drop_duplicates("hour").set_index("hour").sort_index()
    w = w.reindex(pd.date_range(w.index.min(), w.index.max(), freq="h", name="hour"))
    calm = w.wind_speed_kmh.fillna(0) == 0
    head, cross = wind_components(w.wind_dir_deg, w.wind_speed_kmh, heading)
    cc = w.condition_code
    h = pd.DataFrame(index=w.index)
    h["wx_temp_c"] = w.temp_c
    h["wx_dewpt_spread"] = w.temp_c - w.dewpoint_c
    h["wx_rh"] = w.rel_humidity_pct
    h["wx_precip_mm"] = w.precip_mm
    h["wx_precip_3h"] = w.precip_mm.rolling(3, min_periods=1).sum()
    h["wx_wind_kmh"] = w.wind_speed_kmh
    h["wx_headwind_kmh"] = np.where(calm, 0, head)
    h["wx_tailwind_kmh"] = np.clip(-h.wx_headwind_kmh, 0, None) + 0.0
    h["wx_crosswind_kmh"] = np.where(calm, 0, cross)
    h["wx_pres_hpa"] = w.pressure_hpa
    h["wx_pres_tend_3h"] = w.pressure_hpa - w.pressure_hpa.shift(3)
    h["wx_cond"] = cc
    h["wx_thunder"] = cc.between(23, 27).astype(float).where(cc.notna())
    h["wx_rain"] = (cc.between(7, 9) | cc.between(17, 18)).astype(float).where(cc.notna())
    h["wx_fog"] = cc.between(5, 6).astype(float).where(cc.notna())
    h["wx_winter"] = (cc.between(10, 16) | cc.between(19, 22)).astype(float).where(cc.notna())
    h["wx_thunder_6h"] = h.wx_thunder.rolling(6, min_periods=1).max()
    h["wx_source"] = "organisers' hourly file" if code in ("ATL", "DFW") else "Meteostat (fetched)"
    h["wx_wind_dir"] = w.wind_dir_deg          # for display only
    return h


FEATURES_WX = ["wx_temp_c", "wx_dewpt_spread", "wx_rh", "wx_precip_mm", "wx_precip_3h", "wx_wind_kmh", "wx_headwind_kmh",
               "wx_tailwind_kmh", "wx_crosswind_kmh", "wx_pres_hpa", "wx_pres_tend_3h", "wx_cond", "wx_thunder", "wx_rain",
               "wx_fog", "wx_winter", "wx_thunder_6h"]


# ------------------------------------------------------------------ TAF
def _list(s):
    try:
        return ast.literal_eval(s) if isinstance(s, str) else []
    except (ValueError, SyntaxError):
        return []


def _decode_groups(t: pd.DataFrame) -> pd.DataFrame:
    sky_c = t.skyc.map(_list)
    sky_l = t.skyl.map(_list)
    t["ceiling_ft"] = [min([l for c, l in zip(cs, ls) if c in ("BKN", "OVC", "VV") and l is not None], default=np.nan)
                       for cs, ls in zip(sky_c, sky_l)]
    wx = t.presentwx.fillna("").astype(str)
    raw = t.raw.fillna("")
    t["ts"] = wx.str.contains("TS").astype(int)
    t["vcts"] = wx.str.contains("VCTS").astype(int)
    t["shower"] = wx.str.contains("SH").astype(int)
    t["rain"] = wx.str.contains("RA").astype(int)
    t["snow"] = wx.str.contains("SN|PL|GS").astype(int)
    t["fz"] = wx.str.contains("FZ").astype(int)
    t["fog"] = wx.str.contains("FG|BR").astype(int)
    t["cb"] = raw.str.contains(r"\d{3}CB").astype(int)
    t["llws"] = t.ws_level.notna().astype(int) if "ws_level" in t else 0
    t["cat"] = flight_category(t.ceiling_ft, t.visibility)
    return t


def taf_hourly(icao: str, heading: float, max_valid_h: int = 30) -> pd.DataFrame:
    """Expand every TAF into one row per (issue time, target hour) with decoded features.

    Base groups (initial + FM) run until the next FM group. TEMPO and PROB30 groups are overlays.
    """
    t = pd.read_parquet(EXT / "taf" / f"taf_{icao}.parquet")
    t["issue"] = pd.to_datetime(t.valid).dt.tz_localize("UTC")
    t["start"] = pd.to_datetime(t.fx_valid).dt.tz_localize("UTC")
    t["end"] = pd.to_datetime(t.fx_valid_end).dt.tz_localize("UTC")
    t = _decode_groups(t)

    base = t[t.ftype.isin(["Observation", "Forecast"])].sort_values(["product_id", "start"]).copy()
    base["end"] = base.groupby("product_id").start.shift(-1)
    base["end"] = base.end.fillna(base.issue + pd.Timedelta(hours=max_valid_h))
    base = add_wind_columns(base, "taf", base.drct, base.sknt, base.gust, heading)

    def expand(g, start_round):
        s = g.start.dt.ceil("h") if start_round == "ceil" else g.start.dt.floor("h")
        n = ((g.end - s) / pd.Timedelta(hours=1)).apply(np.ceil).clip(lower=0).astype(int)
        idx = np.repeat(g.index.values, n.values)
        offs = np.concatenate([np.arange(k) for k in n.values]) if len(n) else np.array([], int)
        out = g.loc[idx].copy()
        out["target_hour"] = np.repeat(s.values, n.values) + pd.to_timedelta(offs, unit="h")
        out["target_hour"] = pd.to_datetime(out.target_hour, utc=True)
        return out

    b = expand(base, "ceil")
    b = b.sort_values(["product_id", "target_hour", "start"]).drop_duplicates(["product_id", "target_hour"], keep="last")
    cols = {"taf_wind_kt": "taf_wind_kt", "taf_gust_kt": "taf_gust_kt", "taf_headwind_kt": "taf_headwind_kt",
            "taf_tailwind_kt": "taf_tailwind_kt", "taf_crosswind_kt": "taf_crosswind_kt",
            "taf_gust_crosswind_kt": "taf_gust_crosswind_kt", "visibility": "taf_vis_sm", "ceiling_ft": "taf_ceiling_ft",
            "cat": "taf_cat", "ts": "taf_ts", "vcts": "taf_vcts", "shower": "taf_shower", "rain": "taf_rain",
            "snow": "taf_snow", "fz": "taf_fz", "fog": "taf_fog", "cb": "taf_cb", "llws": "taf_llws", "raw": "taf_raw"}
    out = b[["product_id", "issue", "target_hour", "is_amendment"] + list(cols)].rename(columns=cols)
    out["taf_is_amend"] = out.pop("is_amendment").astype(str).str.lower().eq("true").astype(int)
    out["taf_ceiling_ft"] = out.taf_ceiling_ft.fillna(30000)          # no BKN/OVC layer = no ceiling

    ov = t[t.ftype.isin(["Temporary", "Probability 30", "Probability 40"])].dropna(subset=["end"]).copy()
    if len(ov):
        ov = add_wind_columns(ov, "o", ov.drct, ov.sknt, ov.gust, heading)
        ov["is_tempo"] = (ov.ftype == "Temporary").astype(int)
        e = expand(ov, "floor")
        agg = e.groupby(["product_id", "target_hour"]).agg(
            ovl_any=("ftype", "size"), ovl_tempo=("is_tempo", "max"), ovl_ts=("ts", "max"),
            ovl_cat=("cat", "max"), ovl_vis_sm=("visibility", "min"), ovl_ceiling_ft=("ceiling_ft", "min"),
            ovl_gust_crosswind_kt=("o_gust_crosswind_kt", "max"), ovl_raw=("raw", lambda s: " | ".join(s)))
        out = out.merge(agg.reset_index(), on=["product_id", "target_hour"], how="left")
        out["ovl_any"] = out.ovl_any.fillna(0).clip(upper=1)
        out["ovl_ceiling_ft"] = out.ovl_ceiling_ft.where(out.ovl_any == 0, out.ovl_ceiling_ft.fillna(30000))
        for c in ["ovl_tempo", "ovl_ts"]:
            out[c] = out[c].fillna(0)
    out = add_jev_readings(out)
    out["taf_worst_cat"] = np.fmax(out.taf_cat, out.get("ovl_cat", out.taf_cat).fillna(0))
    out["taf_any_ts"] = np.fmax(out.taf_ts, out.get("ovl_ts", 0))
    out.insert(0, "airport", icao)
    return out.sort_values(["issue", "target_hour"]).reset_index(drop=True)


JEV_CACHE = ROOT / "data" / "jev" / "taf_readings.parquet"
JEV_COLS = ["jev_severity", "jev_p_convective", "jev_p_low_visibility", "jev_p_winter", "jev_p_none"]


def add_jev_readings(out: pd.DataFrame) -> pd.DataFrame:
    """Join Jev's cached reading of each TAF group's text (base group + worst TEMPO/PROB overlay)."""
    if not JEV_CACHE.exists():
        return out
    from jev import weather_text
    r = pd.read_parquet(JEV_CACHE).drop_duplicates("text").set_index("text")[JEV_COLS]
    base = r.reindex(out.taf_raw.map(weather_text).values)
    for c in JEV_COLS:
        out[c] = base[c].values
    if "ovl_raw" in out:
        parts = out.ovl_raw.fillna("").str.split(r" \| ")
        ex = parts.explode()
        rr = r.reindex(ex.map(weather_text).values).set_index(ex.index)
        agg = rr.groupby(level=0).max()
        out["ovl_jev_severity"] = agg.jev_severity.reindex(out.index).where(out.ovl_raw.notna())
        out["ovl_jev_p_convective"] = agg.jev_p_convective.reindex(out.index).where(out.ovl_raw.notna())
    out["jev_worst_severity"] = np.fmax(out.jev_severity, out.get("ovl_jev_severity", np.nan))
    return out


def taf_amend_rate(taf_h: pd.DataFrame, hours) -> pd.Series:
    """Number of TAF issuances (incl. amendments) in the 6 h up to each hour: forecaster uncertainty."""
    iss = taf_h.drop_duplicates("product_id").set_index("issue").sort_index()
    s = pd.Series(1, index=iss.index).resample("h").sum()
    s.index = s.index.ceil("h")
    s = s.groupby(level=0).sum().reindex(hours, fill_value=0)
    return s.rolling(6, min_periods=1).sum()


# ------------------------------------------------------------------ LAMP
LAMP_CLD = {"CL": 0, "FW": 1, "SC": 2, "BK": 3, "OV": 4}


def load_lamp(icao: str, heading: float) -> pd.DataFrame:
    l = pd.read_parquet(EXT / "lamp" / f"lamp_{icao}.parquet")
    l["runtime"] = pd.to_datetime(l.runtime).dt.tz_localize("UTC") if l.runtime.dt.tz is None else l.runtime
    l["ftime"] = pd.to_datetime(l.ftime).dt.tz_localize("UTC") if l.ftime.dt.tz is None else l.ftime
    num = lambda c: pd.to_numeric(l[c], errors="coerce") if c in l else np.nan
    out = pd.DataFrame({"airport": icao, "runtime": l.runtime, "target_hour": l.ftime})
    out["lamp_cig_cat"] = num("cig")       # 1 (<200 ft) ... 8 (>12,000 ft / unlimited)
    out["lamp_vis_cat"] = num("vis")       # 1 (<1/2 mi) ... 7 (>6 mi)
    out["lamp_cld"] = l.cld.str.strip().map(LAMP_CLD) if "cld" in l else np.nan
    out["lamp_pop"] = num("ppo")           # probability of precipitation, %
    out["lamp_ltg_prob"] = num("lp1")      # lightning probability, %
    out["lamp_conv_prob"] = num("cp1")     # convection probability, %
    out["lamp_temp_f"] = num("tmp")
    out["lamp_obv_fog"] = l.obv.astype(str).str.strip().isin(["FG", "BR"]).astype(int) if "obv" in l else 0
    add_wind_columns(out, "lamp", num("wdr"), num("wsp"), num("gst"), heading)
    return out.dropna(subset=["target_hour"]).sort_values("runtime").reset_index(drop=True)


# ------------------------------------------------------------------ flights
def prepare_flights(df: pd.DataFrame) -> pd.DataFrame:
    """UTC timestamps for BTS flights (local hhmm -> UTC via each airport's time zone)."""
    df = df.reset_index(drop=True)
    codes = pd.unique(df[["ORIGIN", "DEST"]].values.ravel())
    tz = {c: tz_of_iata(c) for c in codes}
    naive = (pd.to_datetime(df.FL_DATE) + pd.to_timedelta(df.CRS_DEP_TIME // 100, unit="h")
             + pd.to_timedelta(df.CRS_DEP_TIME % 100, unit="m"))
    otz = df.ORIGIN.map(tz)
    dep = pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns, UTC]")
    for z, idx in otz.groupby(otz).groups.items():
        dep.loc[idx] = naive.loc[idx].dt.tz_localize(z, ambiguous=np.zeros(len(idx), bool),
                                                     nonexistent="shift_forward").dt.tz_convert("UTC")
    df["sched_dep_utc"] = dep
    df["sched_arr_utc"] = dep + pd.to_timedelta(df.CRS_ELAPSED_TIME, unit="m")
    df["actual_dep_utc"] = dep + pd.to_timedelta(df.DEP_DELAY, unit="m")
    df["wheels_off_utc"] = df.actual_dep_utc + pd.to_timedelta(df.TAXI_OUT, unit="m")
    arr = df.sched_arr_utc + pd.to_timedelta(df.ARR_DELAY, unit="m")
    df["wheels_on_utc"] = arr - pd.to_timedelta(df.TAXI_IN, unit="m")
    df["disrupted_45"] = ((df.DEP_DELAY > SEVERE_MIN) | (df.CANCELLED == 1) | (df.DIVERTED == 1)).astype(int)
    return df


def hourly_panel(flights: pd.DataFrame, icao: str, hours: pd.DatetimeIndex) -> pd.DataFrame:
    """Airport x UTC-hour table: demand, throughput (AAR proxy) and delay state."""
    code = iata_of(icao)
    arr = flights[flights.DEST == code]
    dep = flights[flights.ORIGIN == code]
    cnt = lambda ts: ts.dt.floor("h").value_counts().reindex(hours, fill_value=0)
    p = pd.DataFrame(index=hours)
    p["arr_sched"] = cnt(arr.sched_arr_utc)
    p["arr_actual"] = cnt(arr.wheels_on_utc.dropna())                       # runway arrivals = AAR proxy
    p["arr_cancel"] = cnt(arr.loc[arr.CANCELLED == 1, "sched_arr_utc"])
    p["dep_sched"] = cnt(dep.sched_dep_utc)
    p["dep_actual"] = cnt(dep.wheels_off_utc.dropna())
    g = dep.groupby(dep.sched_dep_utc.dt.floor("h"))
    p["dep_disrupted_rate"] = g.disrupted_45.mean().reindex(hours)          # label-side, by scheduled hour
    # Known in real time (keyed by when the event happened, so usable after that hour ends)
    gd = dep.dropna(subset=["actual_dep_utc"]).groupby(dep.actual_dep_utc.dt.floor("h"))
    p["dep_delay_rt"] = gd.DEP_DELAY.mean().reindex(hours)
    p["dep_severe_rt"] = gd.DEP_DELAY.apply(lambda s: (s > SEVERE_MIN).mean()).reindex(hours)
    gt = dep.dropna(subset=["wheels_off_utc"]).groupby(dep.wheels_off_utc.dt.floor("h"))
    p["taxi_out_rt"] = gt.TAXI_OUT.mean().reindex(hours)
    ga = arr.dropna(subset=["wheels_on_utc"]).groupby(arr.wheels_on_utc.dt.floor("h"))
    p["arr_delay_rt"] = ga.ARR_DELAY.mean().reindex(hours)
    p["airport"] = icao
    p.index.name = "hour"
    return p


# ------------------------------------------------------------------ the forecast table
def build_aar_table(panel, metar, taf_h, lamp, icao, nominal, leads=LEADS, wx=None):
    """One row per (target hour H, lead k). Issue time T = H - k. Every feature is checked to be <= T."""
    hours = panel.index
    tz = _AP[icao]["tz"]
    local = hours.tz_convert(tz)
    p = panel.copy()
    p["ratio_rt"] = (p.arr_actual / p.arr_sched.replace(0, np.nan)).clip(0, 2)
    amend = taf_amend_rate(taf_h, hours)
    met = metar.reindex(hours)
    met_cols = [c for c in met.columns if c.startswith("met_") and c != "met_wxtext"]

    rows = []
    for k in leads:
        f = pd.DataFrame(index=hours)
        f["airport"] = icao
        f["lead_h"] = k
        f["issue_utc"] = hours - pd.Timedelta(hours=k)
        # schedule for the target hour (published in advance)
        f["sched_arr_n"] = p.arr_sched / nominal
        f["sched_arr_prev_n"] = p.arr_sched.shift(1) / nominal
        f["sched_arr_next_n"] = p.arr_sched.shift(-1) / nominal
        f["sched_dep_n"] = p.dep_sched / nominal
        f["sched_arr_3h_n"] = p.arr_sched.rolling(3, center=True, min_periods=1).sum() / nominal
        f["hour_local"] = local.hour
        f["dow"] = local.dayofweek
        f["month"] = local.month
        # what has already happened by T (last two complete hours before T)
        lag = lambda s, extra=1: s.shift(k + extra)
        f["rt_arr_n"] = (lag(p.arr_actual) + lag(p.arr_actual, 2)) / nominal
        f["rt_ratio"] = lag(p.ratio_rt)
        f["rt_dep_delay"] = lag(p.dep_delay_rt)
        f["rt_dep_severe"] = lag(p.dep_severe_rt)
        f["rt_taxi_out"] = lag(p.taxi_out_rt)
        f["rt_arr_delay"] = lag(p.arr_delay_rt)
        f["taf_issues_6h"] = amend.shift(k)
        # latest METAR at T (obs hour T covers reports up to T)
        for c in met_cols:
            f[c] = met[c].shift(k)
        # organisers' hourly weather, observed at T = H - k (k >= 3: the challenge's 3-hour rule)
        if wx is not None:
            assert k >= MIN_WX_LAG_H
            wxa = wx.reindex(hours)
            for c in FEATURES_WX:
                f[c] = wxa[c].shift(k)
            f["wx_obs_utc"] = hours - pd.Timedelta(hours=k)
        # truth and reference values (not features)
        f["y_arr"] = p.arr_actual
        f["arr_sched"] = p.arr_sched
        f["dep_disrupted_rate"] = p.dep_disrupted_rate
        f["met_cat_at_H"] = met.met_cat
        f["met_ts_at_H"] = met.met_ts
        f["met_winter_at_H"] = np.fmax(met.met_snow, met.met_fz)
        rows.append(f.reset_index())
    tab = pd.concat(rows, ignore_index=True)

    # latest TAF issued <= T that covers H
    tab = tab.sort_values("issue_utc")
    th = taf_h.drop(columns=["airport", "product_id"]).sort_values("issue")
    for d in (tab, th):
        for c in d.columns:
            if str(d[c].dtype).startswith("datetime64"):
                d[c] = d[c].astype("datetime64[ns, UTC]")
    tab = pd.merge_asof(tab, th.rename(columns={"target_hour": "hour"}), left_on="issue_utc", right_on="issue",
                        by="hour", direction="backward", tolerance=pd.Timedelta(hours=30))
    tab["taf_age_h"] = (tab.issue_utc - tab.issue).dt.total_seconds() / 3600
    # latest LAMP run <= T for H
    lp = lamp.drop(columns=["airport"]).rename(columns={"target_hour": "hour"}).sort_values("runtime")
    for c in ["runtime", "hour"]:
        lp[c] = lp[c].astype("datetime64[ns, UTC]")
    tab = tab.sort_values("issue_utc")
    tab = pd.merge_asof(tab, lp, left_on="issue_utc", right_on="runtime", by="hour",
                        direction="backward", tolerance=pd.Timedelta(hours=7))   # runs archived every 6 h
    tab["lamp_age_h"] = (tab.issue_utc - tab.runtime).dt.total_seconds() / 3600
    assert (tab.issue.dropna() <= tab.issue_utc[tab.issue.notna()]).all(), "TAF from the future"
    assert (tab.runtime.dropna() <= tab.issue_utc[tab.runtime.notna()]).all(), "LAMP from the future"
    tab["nominal"] = nominal
    return tab.sort_values(["hour", "lead_h"]).reset_index(drop=True)


FEATURES_SCHEDULE = ["lead_h", "sched_arr_n", "sched_arr_prev_n", "sched_arr_next_n", "sched_dep_n", "sched_arr_3h_n",
                     "hour_local", "dow", "month"]
FEATURES_REALTIME = ["rt_arr_n", "rt_ratio", "rt_dep_delay", "rt_dep_severe", "rt_taxi_out", "rt_arr_delay"]
FEATURES_METAR = ["met_cat", "met_vis_sm", "met_ceiling_ft", "met_ts", "met_snow", "met_fz", "met_rain", "met_precip_mm",
                  "met_specials", "met_headwind_kt", "met_tailwind_kt", "met_crosswind_kt", "met_gust_crosswind_kt",
                  "met_wind_kt", "met_pres_tend_3h", "met_dewpt_spread", "met_temp_c"]
FEATURES_TAF = ["taf_cat", "taf_worst_cat", "taf_vis_sm", "taf_ceiling_ft", "taf_ts", "taf_any_ts", "taf_vcts",
                "taf_shower", "taf_rain", "taf_snow", "taf_fz", "taf_fog", "taf_cb", "taf_llws", "taf_headwind_kt",
                "taf_tailwind_kt", "taf_crosswind_kt", "taf_gust_crosswind_kt", "taf_wind_kt", "ovl_any", "ovl_tempo",
                "ovl_ts", "ovl_cat", "ovl_vis_sm", "ovl_ceiling_ft", "ovl_gust_crosswind_kt", "taf_age_h",
                "taf_is_amend", "taf_issues_6h"]
FEATURES_LAMP = ["lamp_cig_cat", "lamp_vis_cat", "lamp_cld", "lamp_pop", "lamp_ltg_prob", "lamp_conv_prob",
                 "lamp_obv_fog", "lamp_headwind_kt", "lamp_tailwind_kt", "lamp_crosswind_kt", "lamp_gust_crosswind_kt",
                 "lamp_wind_kt", "lamp_age_h"]
FEATURES_JEV = JEV_COLS + ["ovl_jev_severity", "ovl_jev_p_convective", "jev_worst_severity"]
FEATURE_GROUPS = {"schedule": FEATURES_SCHEDULE, "realtime": FEATURES_REALTIME, "wx": FEATURES_WX, "metar": FEATURES_METAR,
                  "taf": FEATURES_TAF, "lamp": FEATURES_LAMP}
if JEV_CACHE.exists():
    FEATURE_GROUPS["jev"] = FEATURES_JEV
AAR_FEATURES = sum(FEATURE_GROUPS.values(), [])

FEATURE_LABELS = {
    "lead_h": "Hours ahead", "sched_arr_n": "Scheduled arrivals (this hour)", "sched_arr_prev_n": "Scheduled arrivals (hour before)",
    "sched_arr_next_n": "Scheduled arrivals (hour after)", "sched_dep_n": "Scheduled departures", "sched_arr_3h_n": "Scheduled arrivals (3 h window)",
    "hour_local": "Local hour", "dow": "Day of week", "month": "Month",
    "rt_arr_n": "Arrivals in last 2 h (at issue)", "rt_ratio": "Arrivals vs schedule (at issue)", "rt_dep_delay": "Avg departure delay (at issue)",
    "rt_dep_severe": "Share of >45 min departures (at issue)", "rt_taxi_out": "Avg taxi-out (at issue)", "rt_arr_delay": "Avg arrival delay (at issue)",
    "taf_issues_6h": "TAF issues/amendments in last 6 h",
    "taf_cat": "TAF flight category", "taf_worst_cat": "TAF worst category incl. TEMPO/PROB", "taf_ts": "TAF thunderstorm",
    "taf_any_ts": "TAF thunderstorm incl. TEMPO/PROB", "taf_vis_sm": "TAF visibility", "taf_ceiling_ft": "TAF ceiling",
    "taf_tailwind_kt": "TAF tailwind on runway", "taf_crosswind_kt": "TAF crosswind on runway", "taf_gust_crosswind_kt": "TAF gust crosswind",
    "taf_headwind_kt": "TAF headwind on runway", "taf_wind_kt": "TAF wind speed", "taf_age_h": "TAF age at issue",
    "ovl_ts": "TEMPO/PROB thunderstorm", "ovl_cat": "TEMPO/PROB flight category", "ovl_any": "TEMPO/PROB group present",
    "lamp_ltg_prob": "LAMP lightning probability", "lamp_conv_prob": "LAMP convection probability", "lamp_pop": "LAMP precip probability",
    "lamp_cig_cat": "LAMP ceiling category", "lamp_vis_cat": "LAMP visibility category",
    "lamp_tailwind_kt": "LAMP tailwind on runway", "lamp_crosswind_kt": "LAMP crosswind on runway",
    "met_cat": "METAR flight category (at issue)", "met_ts": "METAR thunderstorm (at issue)", "met_vis_sm": "METAR visibility (at issue)",
    "met_ceiling_ft": "METAR ceiling (at issue)", "met_tailwind_kt": "METAR tailwind (at issue)", "met_crosswind_kt": "METAR crosswind (at issue)",
    "met_pres_tend_3h": "Pressure change 3 h (at issue)", "met_specials": "METAR special reports (at issue)",
    "met_temp_c": "Temperature (at issue)", "met_dewpt_spread": "Temp–dewpoint spread (at issue)",
    "met_snow": "METAR snow/ice pellets (at issue)", "met_fz": "METAR freezing precip (at issue)",
    "met_rain": "METAR rain (at issue)", "met_precip_mm": "Precipitation last hour (at issue)",
    "met_wind_kt": "METAR wind speed (at issue)", "met_headwind_kt": "METAR headwind (at issue)",
    "met_gust_crosswind_kt": "METAR gust crosswind (at issue)", "taf_snow": "TAF snow/ice pellets", "taf_fz": "TAF freezing precip",
    "taf_rain": "TAF rain", "taf_shower": "TAF showers", "taf_fog": "TAF fog/mist", "taf_cb": "TAF cumulonimbus", "taf_vcts": "TAF TS in vicinity",
    "taf_llws": "TAF low-level wind shear", "taf_is_amend": "TAF is an amendment", "taf_gust_kt": "TAF gust",
    "ovl_tempo": "TEMPO group present", "ovl_vis_sm": "TEMPO/PROB visibility", "ovl_ceiling_ft": "TEMPO/PROB ceiling",
    "ovl_gust_crosswind_kt": "TEMPO/PROB gust crosswind", "lamp_cld": "LAMP cloud cover", "lamp_obv_fog": "LAMP fog/mist",
    "lamp_headwind_kt": "LAMP headwind", "lamp_gust_crosswind_kt": "LAMP gust crosswind", "lamp_wind_kt": "LAMP wind speed",
    "lamp_age_h": "LAMP run age at issue", "lamp_temp_f": "LAMP temperature",
    "wx_temp_c": "Temperature (hourly file, ≥3 h before)", "wx_dewpt_spread": "Temp–dewpoint spread (≥3 h before)",
    "wx_rh": "Humidity (≥3 h before)", "wx_precip_mm": "Precipitation (≥3 h before)", "wx_precip_3h": "Precip, 3 h total (≥3 h before)",
    "wx_wind_kmh": "Wind speed (≥3 h before)", "wx_headwind_kmh": "Headwind on runway (≥3 h before)",
    "wx_tailwind_kmh": "Tailwind on runway (≥3 h before)", "wx_crosswind_kmh": "Crosswind on runway (≥3 h before)",
    "wx_pres_hpa": "Pressure (≥3 h before)", "wx_pres_tend_3h": "Pressure trend (≥3 h before)", "wx_cond": "Condition code (≥3 h before)",
    "wx_thunder": "Thunderstorm observed (≥3 h before)", "wx_rain": "Rain observed (≥3 h before)", "wx_fog": "Fog observed (≥3 h before)",
    "wx_winter": "Snow/ice observed (≥3 h before)", "wx_thunder_6h": "Thunderstorm in prior 6 h (≥3 h before)",
    "jev_severity": "Jev: TAF impact severity", "jev_p_convective": "Jev: P(convective hazard)",
    "jev_p_low_visibility": "Jev: P(low-visibility hazard)", "jev_p_winter": "Jev: P(winter hazard)",
    "jev_p_none": "Jev: P(no hazard)", "ovl_jev_severity": "Jev: TEMPO/PROB severity",
    "ovl_jev_p_convective": "Jev: TEMPO/PROB P(convective)", "jev_worst_severity": "Jev: worst severity in TAF",
}


def label(f):
    return FEATURE_LABELS.get(f, f)


# ------------------------------------------------------------------ impact: hourly queue model
def queue_sim(demand, capacity, planned=None):
    """Fluid queue, one step per hour.

    demand: flights wanting to land each hour; capacity: what the runway actually accepted.
    planned: acceptance rate used to hold flights on the ground at their origin (a GDP); None = no GDP.
    Returns ground-delay minutes, airborne-holding minutes, and the hourly airborne queue.
    """
    demand = np.asarray(demand, float)
    capacity = np.asarray(capacity, float)
    planned = np.full_like(demand, np.inf) if planned is None else np.asarray(planned, float)
    g = a = 0.0
    ground = air = 0.0
    q_air = []
    for d, c, pc in zip(demand, capacity, planned):
        want = g + d
        release = min(want, max(pc, 0))
        g = want - release
        ground += g * 60
        fly = a + release
        land = min(fly, c)
        a = fly - land
        air += a * 60
        q_air.append(a)
    return ground, air, np.array(q_air)


# Cited cost assumptions (see dashboard "Impact" tab)
FUEL_HOLD_KG_MIN = 35.2     # EUROCONTROL Standard Inputs v10, narrow body, arrival management
FUEL_TAXI_KG_MIN = 11.7     # same source, taxi (engines running)
CO2_PER_KG_FUEL = 3.16      # ICAO CORSIA conversion factor for Jet-A
BLOCK_COST_USD_MIN = 100.76 # Airlines for America, 2024 average cost of block time per minute


# ------------------------------------------------------------------ flight-level delay-risk features
CLF_STATIC = ["carrier", "dest", "DISTANCE", "CRS_ELAPSED_TIME", "dep_hour_local", "dow_local", "month_local"]
CLF_ROTATION = ["has_inbound", "sched_turn_min", "in_departed", "in_dep_delay_known", "in_slack_min"]
CLF_AIRPORT = (["sched_arr_n", "sched_dep_n", "sched_arr_3h_n"] + FEATURES_REALTIME + FEATURES_WX + FEATURES_METAR
               + FEATURES_TAF + FEATURES_LAMP + FEATURE_GROUPS.get("jev", []))
CLF_FEATURES = ["lead_h"] + CLF_STATIC + CLF_ROTATION + CLF_AIRPORT
CLF_GROUPS = {
    "schedule": ["lead_h"] + CLF_STATIC + ["sched_arr_n", "sched_dep_n", "sched_arr_3h_n", "has_inbound", "sched_turn_min"],
    "ops": FEATURES_REALTIME + ["in_departed", "in_dep_delay_known", "in_slack_min"],
    "weather": FEATURES_WX + FEATURES_METAR + FEATURES_TAF + FEATURES_LAMP + FEATURE_GROUPS.get("jev", []),
}
FEATURE_LABELS.update({
    "carrier": "Airline", "dest": "Destination", "DISTANCE": "Distance", "CRS_ELAPSED_TIME": "Scheduled block time",
    "dep_hour_local": "Departure hour (local)", "dow_local": "Day of week", "month_local": "Month",
    "has_inbound": "Inbound aircraft found", "sched_turn_min": "Scheduled turn time",
    "in_departed": "Inbound aircraft already departed (at issue)", "in_dep_delay_known": "Inbound departure delay (known at issue)",
    "in_slack_min": "Turn slack after inbound delay",
})


def departures_with_inbound(flights: pd.DataFrame, airports_icao) -> pd.DataFrame:
    """Departures from the given airports plus the previous leg of the same aircraft into that airport."""
    code = {iata_of(a): a for a in airports_icao}
    dep = flights[flights.ORIGIN.isin(code)].copy()
    dep["airport"] = dep.ORIGIN.map(code)
    dep["hour"] = dep.sched_dep_utc.dt.floor("h")
    local = pd.Series(index=dep.index, dtype="object")
    for a in airports_icao:
        idx = dep.index[dep.airport == a]
        local.loc[idx] = dep.loc[idx, "sched_dep_utc"].dt.tz_convert(_AP[a]["tz"]).dt.tz_localize(None)
    local = pd.to_datetime(local)
    dep["dep_hour_local"] = local.dt.hour
    dep["dow_local"] = local.dt.day_of_week
    dep["month_local"] = local.dt.month
    dep["carrier"] = dep.OP_UNIQUE_CARRIER.astype("category")
    dep["dest"] = dep.DEST.astype("category")

    tail = dep.TAIL_NUM.fillna("").astype(str)
    dep["_tail"] = np.where(tail == "", "NA" + dep.index.astype(str), tail)
    arr = flights[flights.DEST.isin(code) & flights.TAIL_NUM.notna()]
    right = pd.DataFrame({"_tail": arr.TAIL_NUM.astype(str), "ORIGIN": arr.DEST,
                          "in_sched_arr": arr.sched_arr_utc.astype("datetime64[ns, UTC]"),
                          "in_actual_dep": arr.actual_dep_utc.astype("datetime64[ns, UTC]"),
                          "in_dep_delay": arr.DEP_DELAY, "in_origin": arr.ORIGIN}).sort_values("in_sched_arr")
    left = dep[["_tail", "ORIGIN", "sched_dep_utc"]].copy()
    left["sched_dep_utc"] = left.sched_dep_utc.astype("datetime64[ns, UTC]")
    left = left.reset_index().sort_values("sched_dep_utc")
    j = pd.merge_asof(left, right, left_on="sched_dep_utc", right_on="in_sched_arr", by=["_tail", "ORIGIN"],
                      direction="backward", tolerance=pd.Timedelta(hours=12), allow_exact_matches=False)
    j = j.set_index("index")
    for c in ["in_sched_arr", "in_actual_dep", "in_dep_delay", "in_origin"]:
        dep[c] = j[c]
    return dep.drop(columns="_tail")


def assemble_flight_rows(dep: pd.DataFrame, aar: pd.DataFrame) -> pd.DataFrame:
    """dep needs airport, hour, lead_h. Adds airport-hour forecast features and rotation info known at issue time."""
    cols = ["airport", "hour", "lead_h"] + CLF_AIRPORT + ["met_cat_at_H", "met_ts_at_H"]
    d = dep.merge(aar[cols], on=["airport", "hour", "lead_h"], how="left")
    d["issue_utc"] = d.hour - pd.to_timedelta(d.lead_h, unit="h")
    known = d.in_actual_dep.notna() & (d.in_actual_dep <= d.issue_utc)
    d["has_inbound"] = d.in_sched_arr.notna().astype(int)
    d["sched_turn_min"] = (d.sched_dep_utc - d.in_sched_arr).dt.total_seconds() / 60
    d["in_departed"] = known.astype(int)
    d["in_dep_delay_known"] = d.in_dep_delay.where(known)
    d["in_slack_min"] = d.sched_turn_min - d.in_dep_delay_known.clip(lower=0)
    return d


# ------------------------------------------------------------------ MAIN TARGET (update 31 Oct): >45 min delay per ATL/DFW flight
# Label: DEP_DELAY > 45 for departures from the hub, ARR_DELAY > 45 for arrivals into the hub.
# Cancelled/diverted flights have no delay value, so they are excluded from the label (stated assumption).
MAIN_STATIC = ["is_arrival", "carrier", "other", "DISTANCE", "CRS_ELAPSED_TIME", "hour_local_f", "dow_local", "month_local"]
MAIN_ROTATION = ["has_inbound", "sched_turn_min", "in_departed", "in_dep_delay_known", "in_slack_min",
                 "own_departed", "own_dep_delay_known"]
MAIN_FEATURES = ["lead_h"] + MAIN_STATIC + MAIN_ROTATION + CLF_AIRPORT
MAIN_GROUPS = {
    "schedule": ["lead_h"] + MAIN_STATIC + ["sched_arr_n", "sched_dep_n", "sched_arr_3h_n", "has_inbound", "sched_turn_min"],
    "ops": FEATURES_REALTIME + ["in_departed", "in_dep_delay_known", "in_slack_min", "own_departed", "own_dep_delay_known"],
    "hourly_wx": FEATURES_WX,
    "forecasts": FEATURES_METAR + FEATURES_TAF + FEATURES_LAMP + FEATURE_GROUPS.get("jev", []),
}
FEATURE_LABELS.update({"is_arrival": "Arriving or departing", "other": "Route (origin / destination)", "hour_local_f": "Scheduled hour (local)",
                       "own_departed": "This flight already departed (at issue)", "own_dep_delay_known": "This flight's departure delay (known at issue)"})


def hub_flight_rows(flights: pd.DataFrame, airports_icao) -> pd.DataFrame:
    """One row per (flight, hub end). Departures from and arrivals into each hub, with the challenge label."""
    dep = departures_with_inbound(flights, airports_icao)
    dep["is_arrival"] = 0
    dep["other"] = dep.DEST
    dep["sched_utc"] = dep.sched_dep_utc
    dep["y45"] = (dep.DEP_DELAY > SEVERE_MIN).astype(float).where(dep.DEP_DELAY.notna())
    dep["own_actual_dep"] = pd.Series(pd.NaT, index=dep.index, dtype="datetime64[ns, UTC]")
    code = {iata_of(a): a for a in airports_icao}
    arr = flights[flights.DEST.isin(code)].copy()
    arr["airport"] = arr.DEST.map(code)
    arr["is_arrival"] = 1
    arr["other"] = arr.ORIGIN
    arr["sched_utc"] = arr.sched_arr_utc
    arr["hour"] = arr.sched_arr_utc.dt.floor("h")
    arr["y45"] = (arr.ARR_DELAY > SEVERE_MIN).astype(float).where(arr.ARR_DELAY.notna())
    arr["own_actual_dep"] = arr.actual_dep_utc.astype("datetime64[ns, UTC]")
    local = pd.Series(index=arr.index, dtype="object")
    for a in airports_icao:
        idx = arr.index[arr.airport == a]
        local.loc[idx] = arr.loc[idx, "sched_arr_utc"].dt.tz_convert(_AP[a]["tz"]).dt.tz_localize(None)
    local = pd.to_datetime(local)
    arr["dep_hour_local"], arr["dow_local"], arr["month_local"] = local.dt.hour, local.dt.day_of_week, local.dt.month
    for c in ["in_sched_arr", "in_actual_dep"]:
        arr[c] = pd.Series(pd.NaT, index=arr.index, dtype="datetime64[ns, UTC]")
    arr["in_dep_delay"] = np.nan
    arr["in_origin"] = None
    rows = pd.concat([dep, arr], ignore_index=True)
    rows["hour_local_f"] = rows.dep_hour_local
    rows["carrier"] = rows.OP_UNIQUE_CARRIER.astype("category")
    rows["other"] = rows.other.astype("category")
    return rows


def assemble_main_rows(rows: pd.DataFrame, aar: pd.DataFrame) -> pd.DataFrame:
    """rows need airport, hour, lead_h. Adds hub-hour forecast features (weather >= 3 h old) and what is known at issue time."""
    d = assemble_flight_rows(rows, aar)
    own = d.own_actual_dep.notna() & (d.own_actual_dep <= d.issue_utc)
    d["own_departed"] = own.astype(int)
    d["own_dep_delay_known"] = d.DEP_DELAY.where(own & (d.is_arrival == 1))
    if "wx_obs_utc" in aar:   # enforce the challenge rule on every row
        obs = d.hour - pd.to_timedelta(d.lead_h, unit="h")
        assert (obs <= d.sched_utc - pd.Timedelta(hours=MIN_WX_LAG_H)).all(), "weather newer than 3 h before schedule"
    return d
