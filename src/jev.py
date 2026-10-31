"""Jev (TypeSafe System One) client: reads aviation forecast text and returns typed, calibrated answers.

Jev does the reading; LightGBM and fixed rules do all the numbers and decisions.
The API key is read from the TYPESAFE_API_KEY environment variable or the project's .env file.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"

HAZARDS = {
    "convective": "Thunderstorms, cumulonimbus (CB) or towering cumulus",
    "low_visibility": "Low cloud ceiling, fog, mist or reduced visibility",
    "winter": "Snow, ice pellets, freezing rain or freezing drizzle",
    "rain": "Rain or showers without thunder, ceiling and visibility mostly fine",
    "none": "No significant weather: good visibility and high or no clouds",
}
SEVERITY = ["No reduction in arrival rate", "Minor reduction", "Moderate reduction", "Severe reduction or stoppage"]

TAF_QUESTIONS = {
    "hazard": {"type": "choice",
               "instructions": "This is a decoded weather forecast for one hour at a major airport (wind not included). "
                               "What is the main weather hazard for arriving aircraft?",
               "criteria": HAZARDS},
    "severity": {"type": "score",
                 "instructions": "How much would these conditions reduce the airport's runway arrival rate?",
                 "criteria": SEVERITY},
}


def api_key() -> str:
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key and (ROOT / ".env").exists():
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith("TYPESAFE_API_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        raise RuntimeError("Set TYPESAFE_API_KEY (or add it to .env)")
    return key


def ask(state, questions, model=MODEL, tries=5, timeout=60):
    body = json.dumps({"model": model, "state": state, "questions": questions}).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(URL, data=body, method="POST", headers={
                "Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:  # rate limits / transient errors
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1) + (10 if "429" in repr(e) else 0))


_PREFIX = re.compile(r"^(FM\d{6}|TEMPO \d{4}/\d{4}|PROB\d0 \d{4}/\d{4}|\d{4}/\d{4})\s*")
_WIND = re.compile(r"\b(VRB|\d{3})\d{2,3}(G\d{2,3})?KT\b|\bWS\d{3}/\d{5}KT\b")


def weather_text(raw: str) -> str:
    """TAF group text without its time prefix and wind (wind is decoded exactly elsewhere)."""
    if not isinstance(raw, str):
        return ""
    return " ".join(_WIND.sub("", _PREFIX.sub("", raw)).split())


_WX = {"TS": "thunderstorm", "SH": "showers of", "FZ": "freezing", "BL": "blowing", "VC": "in the vicinity:",
       "RA": "rain", "SN": "snow", "DZ": "drizzle", "PL": "ice pellets", "GR": "hail", "GS": "small hail",
       "FG": "fog", "BR": "mist", "HZ": "haze", "FU": "smoke", "DU": "dust", "SA": "sand", "UP": "unknown precipitation",
       "SQ": "squalls", "FC": "funnel cloud", "IC": "ice crystals", "MI": "shallow", "BC": "patches of", "PR": "partial"}
_SKY = {"FEW": "few clouds", "SCT": "scattered clouds", "BKN": "broken clouds (ceiling)", "OVC": "overcast (ceiling)"}


def _vis(tok):
    if tok == "P6SM":
        return "visibility more than 6 miles"
    v = tok[:-2]
    try:
        miles = sum(float(__import__("fractions").Fraction(x)) for x in v.split())
    except ValueError:
        return None
    return f"visibility {v} statute miles" + (" (very low)" if miles < 1 else " (reduced)" if miles < 3 else "")


def to_english(text: str) -> str:
    """Decode a TAF weather group into plain English (Jev reads words better than codes)."""
    out, toks, i = [], text.split(), 0
    while i < len(toks):
        t = toks[i]
        if i + 1 < len(toks) and re.fullmatch(r"\d", t) and re.fullmatch(r"\d/\dSM", toks[i + 1]):
            t, i = f"{t} {toks[i + 1]}", i + 1
        m_sky = re.fullmatch(r"(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?", t)
        if t.endswith("SM") and _vis(t):
            out.append(_vis(t))
        elif t in ("SKC", "NSC", "CLR"):
            out.append("sky clear")
        elif t == "NSW":
            out.append("no significant weather")
        elif m_sky:
            ft = int(m_sky.group(2)) * 100
            extra = {"CB": " with cumulonimbus (thunderstorm clouds)", "TCU": " with towering cumulus"}.get(m_sky.group(3), "")
            out.append(f"{_SKY[m_sky.group(1)]} at {ft:,} ft{extra}")
        elif re.fullmatch(r"VV\d{3}", t):
            out.append(f"sky obscured, vertical visibility {int(t[2:]) * 100:,} ft")
        elif re.fullmatch(r"[-+]?(VC)?[A-Z]{2,8}", t):
            inten = {"-": "light ", "+": "heavy "}.get(t[0], "")
            body = t.lstrip("-+")
            words = [_WX.get(body[k:k + 2], body[k:k + 2]) for k in range(0, len(body), 2)]
            out.append(inten + " ".join(words))
        elif t.startswith("WS"):
            out.append("low-level wind shear")
        else:
            out.append(t)
        i += 1
    return "; ".join(out) if out else "no weather information"


def read_taf_group(text: str) -> dict:
    """Jev's reading of one TAF weather text -> flat dict of probabilities and severity."""
    a = ask(to_english(text or "P6SM SKC"), TAF_QUESTIONS)["answers"]
    p = a["hazard"]["probabilities"]
    return {"text": text, "jev_hazard": a["hazard"]["choice"], "jev_hazard_conf": a["hazard"]["confidence"],
            **{f"jev_p_{k}": p.get(k, 0.0) for k in HAZARDS},
            "jev_severity": a["severity"]["score"], "jev_severity_conf": a["severity"]["confidence"]}


BRIEF_QUESTIONS = {
    "hazard": {"type": "choice", "instructions": "Across this whole forecast window, what is the main hazard for arrivals?",
               "criteria": HAZARDS},
    "severity": {"type": "score", "instructions": "Worst reduction in runway arrival rate implied by this forecast window?",
                 "criteria": SEVERITY},
    "timing_uncertain": {"type": "noul", "instructions": "The timing or occurrence of the hazardous weather is uncertain "
                         "(TEMPO or PROB groups, vicinity weather, or changing conditions)."},
    "needs_gdp": {"type": "noul", "instructions": "A traffic manager should consider planning arrival restrictions "
                  "(e.g. a ground delay program) for this window."},
}


def brief(taf_lines: list[str]) -> dict:
    """Jev's typed reading of the full forecast window shown in the dashboard (live call)."""
    a = ask("\n".join(taf_lines), BRIEF_QUESTIONS)
    return {"model": a.get("model"), **a["answers"]}
