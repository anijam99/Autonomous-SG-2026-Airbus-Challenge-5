"""Download every public dataset the project uses, with no manual steps.

Usage:
    python scripts/download_data.py                       # everything, default airports and dates
    python scripts/download_data.py --only bts taf        # a subset
    python scripts/download_data.py --airports KATL KDFW KORD --start 2023-01 --end 2025-07

Each source is cached under data/external/<source>/ and skipped if already there, so re-running is cheap.
Outputs are tidy Parquet files that the modelling notebook reads directly.

Sources:
    bts      US DOT BTS On-Time Performance, full monthly files, filtered to the chosen airports
    metar    Iowa Environmental Mesonet (IEM) ASOS hourly METAR observations
    taf      IEM archive of NWS Terminal Aerodrome Forecasts (parsed into forecast groups)
    lamp     IEM archive of NWS LAMP guidance: hourly forecasts incl. lightning/convection probability
    storms   NOAA NCEI Storm Events database (severe weather log, used for evaluation only)
    runways  OurAirports runway and airport tables (runway headings for any airport)
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "data" / "external"
UA = {"User-Agent": "AutonomousSG2026-Challenge5/1.0 (hackathon research)"}

BTS_URL = "https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{y}_{m}.zip"
IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request"
STORMS_DIR = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/"

# BTS PREZIP CamelCase names -> the uppercase names used in the provided challenge file
BTS_COLUMNS = {
    "FlightDate": "FL_DATE", "Reporting_Airline": "OP_UNIQUE_CARRIER", "Tail_Number": "TAIL_NUM",
    "Flight_Number_Reporting_Airline": "OP_CARRIER_FL_NUM", "Origin": "ORIGIN", "Dest": "DEST",
    "CRSDepTime": "CRS_DEP_TIME", "DepTime": "DEP_TIME", "DepDelay": "DEP_DELAY", "TaxiOut": "TAXI_OUT",
    "WheelsOff": "WHEELS_OFF", "WheelsOn": "WHEELS_ON", "TaxiIn": "TAXI_IN", "CRSArrTime": "CRS_ARR_TIME",
    "ArrTime": "ARR_TIME", "ArrDelay": "ARR_DELAY", "Cancelled": "CANCELLED", "CancellationCode": "CANCELLATION_CODE",
    "Diverted": "DIVERTED", "CRSElapsedTime": "CRS_ELAPSED_TIME", "ActualElapsedTime": "ACTUAL_ELAPSED_TIME",
    "AirTime": "AIR_TIME", "Distance": "DISTANCE", "CarrierDelay": "CARRIER_DELAY", "WeatherDelay": "WEATHER_DELAY",
    "NASDelay": "NAS_DELAY", "SecurityDelay": "SECURITY_DELAY", "LateAircraftDelay": "LATE_AIRCRAFT_DELAY",
}

# County names used to match NOAA Storm Events to each airport (plus a radius check on event coordinates)
AIRPORT_COUNTIES = {
    "KATL": ("GEORGIA", ["FULTON", "CLAYTON", "DEKALB", "COBB", "HENRY", "FAYETTE", "SOUTH FULTON", "NORTH FULTON"]),
    "KDFW": ("TEXAS", ["TARRANT", "DALLAS", "DENTON", "COLLIN", "ELLIS", "JOHNSON"]),
    "KORD": ("ILLINOIS", ["COOK", "DUPAGE", "NORTHERN COOK", "CENTRAL COOK", "LAKE", "KANE"]),
}
STORM_RADIUS_KM = 50


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def fetch(url, timeout=600, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # network hiccups: back off and retry
            if i == tries - 1:
                raise
            log(f"  retry {i + 1} after {e!r}")
            time.sleep((30 if "429" in repr(e) else 5) * (i + 1))   # IEM rate-limits: back off harder


def months(start, end):
    return pd.period_range(start, end, freq="M")


def iata(icao):
    return icao[1:] if icao.startswith("K") and len(icao) == 4 else icao


# ---------------------------------------------------------------- BTS
def bts_month(period, airports_iata, out_dir):
    out = out_dir / f"bts_{period.year}_{period.month:02d}.parquet"
    if out.exists():
        return out, "cached"
    raw = fetch(BTS_URL.format(y=period.year, m=period.month))
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        with z.open(name) as f:
            df = pd.read_csv(f, usecols=list(BTS_COLUMNS), dtype={"CRSDepTime": str, "CRSArrTime": str,
                             "DepTime": str, "ArrTime": str, "WheelsOff": str, "WheelsOn": str,
                             "Tail_Number": str, "CancellationCode": str, "Flight_Number_Reporting_Airline": str},
                             low_memory=False)
    df = df.rename(columns=BTS_COLUMNS)
    df = df[df.ORIGIN.isin(airports_iata) | df.DEST.isin(airports_iata)]
    for c in ["CRS_DEP_TIME", "CRS_ARR_TIME", "DEP_TIME", "ARR_TIME", "WHEELS_OFF", "WHEELS_ON", "OP_CARRIER_FL_NUM"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df.to_parquet(out, index=False)
    return out, f"{len(df):,} rows"


def download_bts(airports, start, end, workers=4):
    ap = [iata(a) for a in airports]
    out_dir = EXT / "bts" / "-".join(sorted(ap))      # one cache per airport set
    out_dir.mkdir(parents=True, exist_ok=True)
    log(f"BTS: {len(months(start, end))} months for {ap}")
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(bts_month, p, ap, out_dir): p for p in months(start, end)}
        for f in cf.as_completed(futs):
            p = futs[f]
            try:
                _, msg = f.result()
                log(f"  BTS {p}: {msg}")
            except Exception as e:
                log(f"  BTS {p}: FAILED {e!r}")


# ---------------------------------------------------------------- METAR
def download_metar(airports, start, end):
    out_dir = EXT / "metar"
    out_dir.mkdir(parents=True, exist_ok=True)
    s, e = pd.Period(start).start_time - pd.Timedelta(days=2), pd.Period(end).end_time + pd.Timedelta(days=2)
    fields = ["tmpc", "dwpc", "drct", "sknt", "gust", "vsby", "skyc1", "skyl1", "skyc2", "skyl2", "skyc3",
              "skyl3", "wxcodes", "p01m", "mslp"]
    for a in airports:
        out = out_dir / f"metar_{a}.csv"
        if out.exists():
            log(f"METAR {a}: cached")
            continue
        params = [("station", iata(a)), *[("data", f) for f in fields],
                  ("year1", s.year), ("month1", s.month), ("day1", s.day),
                  ("year2", e.year), ("month2", e.month), ("day2", e.day),
                  ("tz", "Etc/UTC"), ("format", "onlycomma"), ("latlon", "no"), ("missing", "M"),
                  ("trace", "T"), ("report_type", 3), ("report_type", 4)]   # routine + special reports
        out.write_bytes(fetch(f"{IEM}/asos.py?" + urllib.parse.urlencode(params)))
        log(f"METAR {a}: {out.stat().st_size / 1e6:.1f} MB")


# ---------------------------------------------------------------- TAF
def download_taf(airports, start, end):
    out_dir = EXT / "taf"
    out_dir.mkdir(parents=True, exist_ok=True)
    for a in airports:
        out = out_dir / f"taf_{a}.parquet"
        if out.exists():
            log(f"TAF {a}: cached")
            continue
        parts = []
        # TAFs issued up to 30 h before a target hour matter, so start a little early
        for p in months(pd.Period(start) - 1, end):
            url = (f"{IEM}/taf.py?station={a}&sts={p.start_time:%Y-%m-%dT00:00Z}"
                   f"&ets={(p.end_time + pd.Timedelta(seconds=1)):%Y-%m-%dT00:00Z}&fmt=csv")
            txt = fetch(url).decode()
            if txt.count("\n") > 1:
                parts.append(pd.read_csv(io.StringIO(txt)))
        taf = pd.concat(parts, ignore_index=True).drop_duplicates()
        taf.to_parquet(out, index=False)
        log(f"TAF {a}: {len(taf):,} forecast groups, {taf.product_id.nunique():,} TAFs")


# ---------------------------------------------------------------- LAMP
def lamp_month(a, p):
    # IEM archives the 00/06/12/18Z LAMP runs; keep whole-hour runs and leads 1-25 h
    url = (f"{IEM}/mos.py?station={a}&model=LAV&sts={p.start_time:%Y-%m-%dT00:00Z}"
           f"&ets={(p.end_time + pd.Timedelta(seconds=1)):%Y-%m-%dT00:00Z}&format=csv")
    df = pd.read_csv(io.BytesIO(fetch(url)), low_memory=False)
    if df.empty:
        return df
    df["runtime"] = pd.to_datetime(df.runtime)
    df["ftime"] = pd.to_datetime(df.ftime)
    lead = (df.ftime - df.runtime).dt.total_seconds() / 3600
    return df[(df.runtime.dt.minute == 0) & lead.between(1, 25)]


def download_lamp(airports, start, end):
    out_dir = EXT / "lamp"
    (out_dir / "monthly").mkdir(parents=True, exist_ok=True)
    for a in airports:
        out = out_dir / f"lamp_{a}.parquet"
        if out.exists():
            log(f"LAMP {a}: cached")
            continue
        parts = []
        for p in months(pd.Period(start) - 1, end):   # one request at a time: IEM rate-limits this endpoint
            part = out_dir / "monthly" / f"lamp_{a}_{p}.parquet"
            if not part.exists():
                lamp_month(a, p).to_parquet(part, index=False)
                time.sleep(1)
            parts.append(pd.read_parquet(part))
        lamp = pd.concat(parts, ignore_index=True)
        lamp.to_parquet(out, index=False)
        log(f"LAMP {a}: {len(lamp):,} rows")


# ---------------------------------------------------------------- NOAA Storm Events
def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * np.arcsin(np.sqrt(a))


def download_storms(airports, start, end):
    out_dir = EXT / "storms"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "storm_events_airports.parquet"
    if out.exists():
        log("Storms: cached")
        return
    listing = fetch(STORMS_DIR).decode()
    import airportsdata
    apdb = airportsdata.load("ICAO")
    frames = []
    for year in range(pd.Period(start).year, pd.Period(end).year + 1):
        names = sorted(set(re.findall(rf"StormEvents_details-ftp_v1\.0_d{year}_c\d+\.csv\.gz", listing)))
        if not names:
            log(f"  Storms {year}: not published")
            continue
        raw = out_dir / names[-1]
        if not raw.exists():
            raw.write_bytes(fetch(STORMS_DIR + names[-1]))
        frames.append(pd.read_csv(raw, low_memory=False))
    ev = pd.concat(frames, ignore_index=True)

    # Local times with a "CST-6" style zone -> UTC
    offset_h = ev.CZ_TIMEZONE.str.extract(r"(-?\d+)$")[0].astype(float)
    for side in ["BEGIN", "END"]:
        local = pd.to_datetime(ev[f"{side}_DATE_TIME"], format="%d-%b-%y %H:%M:%S")
        ev[f"{side.lower()}_utc"] = (local - pd.to_timedelta(offset_h, unit="h")).dt.tz_localize("UTC")

    keep = []
    for a in airports:
        state, counties = AIRPORT_COUNTIES.get(a, (None, []))
        lat, lon = apdb[a]["lat"], apdb[a]["lon"]
        near = haversine_km(lat, lon, ev.BEGIN_LAT, ev.BEGIN_LON) <= STORM_RADIUS_KM
        county = (ev.STATE == state) & ev.CZ_NAME.str.upper().isin(counties)
        sel = ev[near.fillna(False) | county].copy()
        sel.insert(0, "airport", a)
        keep.append(sel)
    cols = ["airport", "EVENT_ID", "EPISODE_ID", "EVENT_TYPE", "STATE", "CZ_TYPE", "CZ_NAME", "begin_utc", "end_utc",
            "MAGNITUDE", "MAGNITUDE_TYPE", "BEGIN_LAT", "BEGIN_LON", "DAMAGE_PROPERTY", "EVENT_NARRATIVE", "EPISODE_NARRATIVE"]
    storms = pd.concat(keep, ignore_index=True)[cols]
    storms.to_parquet(out, index=False)
    log(f"Storms: {len(storms):,} events near {airports}; types: {storms.EVENT_TYPE.value_counts().head(6).to_dict()}")


# ---------------------------------------------------------------- OurAirports
def download_runways(*_):
    out_dir = EXT / "ourairports"
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ["runways.csv", "airports.csv"]:
        p = out_dir / name
        if not p.exists():
            p.write_bytes(fetch(OURAIRPORTS + name))
    log("OurAirports: runways.csv, airports.csv ready")


# Organiser-provided files (update of 31 Oct 2026, 12:45): fetched by script as the rules require
CHALLENGE_BASE = "https://jpvccqhcdjfupuquwnwc.supabase.co/storage/v1/object/public/experience-datasets/autonomous-sg-2026/"
CHALLENGE_FILES = ["challenge-5-hourly-weather-atl-dfw.csv", "challenge-5-data-guide.xlsx", "airbus-problem-statements-updated.pdf"]


def download_challenge(*_):
    out_dir = ROOT / "data" / "challenge"
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in CHALLENGE_FILES:
        p = out_dir / name
        if not p.exists():
            p.write_bytes(fetch(CHALLENGE_BASE + name))
        log(f"Challenge file {name}: {p.stat().st_size / 1e6:.2f} MB")


METEOSTAT = "https://bulk.meteostat.net/v2/"


def download_meteostat(airports, start, end):
    """Hourly Meteostat (NOAA ISD) weather for airports not in the organisers' file, in the same schema."""
    out_dir = EXT / "meteostat"
    out_dir.mkdir(parents=True, exist_ok=True)
    import gzip, json
    stations = None
    for a in airports:
        if iata(a) in ("ATL", "DFW"):
            continue    # provided by the organisers (challenge-5-hourly-weather-atl-dfw.csv)
        out = out_dir / f"meteostat_{a}.parquet"
        if out.exists():
            log(f"Meteostat {a}: cached"); continue
        if stations is None:
            stations = json.loads(gzip.decompress(fetch(METEOSTAT + "stations/lite.json.gz")))
        sid = next(s["id"] for s in stations if s["identifiers"].get("icao") == a)
        parts = []
        for y in range(pd.Period(start).year, pd.Period(end).year + 1):
            raw = gzip.decompress(fetch(f"{METEOSTAT}hourly/{y}/{sid}.csv.gz")).decode()
            parts.append(pd.read_csv(io.StringIO(raw), header=None, names=["date", "hour", "temp", "dwpt", "rhum", "prcp", "snow",
                                                                           "wdir", "wspd", "wpgt", "pres", "tsun", "coco"]))
        m = pd.concat(parts, ignore_index=True)
        m["time_utc"] = pd.to_datetime(m.date) + pd.to_timedelta(m.hour, unit="h")
        m = m.rename(columns={"temp": "temp_c", "dwpt": "dewpoint_c", "rhum": "rel_humidity_pct", "prcp": "precip_mm",
                              "wdir": "wind_dir_deg", "wspd": "wind_speed_kmh", "wpgt": "wind_gust_kmh", "pres": "pressure_hpa",
                              "coco": "condition_code"})
        m.insert(0, "airport", iata(a))
        m.drop(columns=["date", "hour", "snow", "tsun"]).to_parquet(out, index=False)
        log(f"Meteostat {a} (station {sid}): {len(m):,} hours")


SOURCES = {"challenge": download_challenge, "meteostat": download_meteostat, "runways": download_runways, "metar": download_metar, "taf": download_taf,
           "lamp": download_lamp, "storms": download_storms, "bts": download_bts}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--airports", nargs="+", default=["KATL", "KDFW", "KORD"], help="ICAO codes")
    ap.add_argument("--start", default="2023-01")
    ap.add_argument("--end", default="2025-07")
    ap.add_argument("--only", nargs="+", choices=list(SOURCES), default=list(SOURCES))
    args = ap.parse_args(argv)
    failed = []
    for name in args.only:
        try:
            SOURCES[name](args.airports, args.start, args.end)
        except Exception as e:
            failed.append(name)
            log(f"{name}: FAILED {e!r}")
    log("DONE" + (f" with failures: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
