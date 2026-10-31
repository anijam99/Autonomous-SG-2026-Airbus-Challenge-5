# Challenge 5 build plan: Predictive Airport Capacity & Delay Risk

> **Status (31 Oct):** sections 4.1–4.7 are built. See README.md for how to run, and the dashboard's Model performance tab for results. Section 8 lists ideas from research.

## 1. Who it's for and what they do today

**User:** the Traffic Management Coordinator (TMC) at the ATL or DFW approach/en-route traffic unit, plus the airline operations-control duty manager who reacts to their decisions.

**Today:** the TMC sets the hourly Arrival Acceptance Rate (AAR) from current conditions and the latest terminal forecast (TAF). When storms, low ceilings or strong winds show up, the rate is cut, often once the weather has already arrived. Aircraft then hold in the air or sit on taxiways with engines running. Ground Delay Programs (GDPs) that would hold flights at their origin instead need several hours of lead time to work.

**Our tool:** forecasts hourly AAR and the share of flights facing a severe (>45 min) delay **3 to 12 hours ahead**. It shows the evidence behind each number and suggests actions. The TMC decides.

## 2. What the provided data can and can't do (from `01_clean_and_export.ipynb`)

| Finding | Consequence |
|---|---|
| 148k flights from Jan 2023 to Jul 2025, but only 25k touch ATL/DFW, about **1% of real traffic** (ATL: 9 departures/day in the file vs ~1,000 real) | Fine for training a flight-level delay classifier. **Too sparse to measure hourly arrival rates**, so we need the full BTS data |
| Weather is Meteostat hourly data in **UTC**, joined on **local** clock hour. Checked against real METARs: 99.9% match when read as UTC, 15.6% when read as local | Every weather value is **4–30 h older** than its flight. It is not future information, but it is not "weather at departure" either. True time and age are now stored per row |
| No wind direction column | Can't compute crosswind or tailwind from the file. Added from IEM METARs |
| Gust is 0 in 98% of rows (0% in 2023 → 9% in 2025); snow is always 0; `coco = 0` appears | Sentinel zeros, now set to missing |
| Delay-cause minutes are only filled when arrival delay is 15 min or more | Filled with 0 for on-time completed flights |

Outputs are in `data/processed/` (see `data_dictionary.csv` for every column and its role: id / schedule / weather / target / outcome).

## 3. External data: what to add and why

The brief explicitly asks us to ingest public METARs/TAFs, NOAA storm logs and flight performance data, and to download them with scripts. All sources below are free and scriptable.

| Priority | Source | What it adds | Why it matters | Access |
|---|---|---|---|---|
| **P0** | **BTS On-Time Performance, full monthly files**<br>`transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{YYYY}_{M}.zip` | Every flight at ATL/DFW (~2.5M rows for 31 months) | **Required for the AAR label.** Hourly wheels-on counts, scheduled demand, volume-normalised delay rates, and congestion state at issue time (recent taxi-out, delay rate) | Verified working. ~35 MB per month, ~1 GB total. Column names are CamelCase (`FlightDate`, `Reporting_Airline`, `WheelsOn`), so map them to the uppercase names the notebook uses |
| **P0** | **IEM ASOS METAR archive**<br>`mesonet.agron.iastate.edu/cgi-bin/request/asos.py` | Wind direction, gusts, visibility, ceiling, thunderstorm/freezing codes | Runway crosswind and tailwind (a brief requirement), flight category (IFR/LIFR drives AAR cuts) | Already used in the notebook, cached |
| **P0** | **IEM TAF archive** (parsed)<br>`mesonet.agron.iastate.edu/cgi-bin/request/taf.py?station=KATL&sts=…&ets=…&fmt=csv` | The forecast that was **actually available** at issue time, for each hour 3–12 h out: wind, visibility, sky, `TS`/`VCTS`, TEMPO groups | **This is how we avoid leakage.** It is what the TMC sees today, so it doubles as the baseline to beat | Verified working |
| **P1** | **NOAA Storm Events database**<br>`ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/` | Logged severe events (thunderstorm wind, hail, winter storm, flash flood) by county and time | Evaluation labels: "how many hours of warning did we give before each storm?" Lets us slice errors by event type | Verified. **Compiled after the fact, so never a model input** |
| **P1** | **OurAirports `runways.csv`** | Real runway headings for every airport | Generalising beyond the brief's fixed headings (ATL 80°, DFW 180°); best-runway crosswind | Verified |
| **P1** | **FAA ATCSCC advisory database**<br>`fly.faa.gov/adv/advADB.jsp` | Historical Ground Delay Programs and ground stops, including **program rate** (the reduced AAR) | Ground-truth "capacity was cut" events and rates, to validate the throughput proxy | Redirects; check access. Probably needs scraping |
| **P2** | **FAA ASPM** | Official hourly called AAR/ADR and runway configuration | Best possible AAR label | Login required. Use it if a team member already has access |
| **P2** | NWS LAMP / MOS (IEM MOS archive), SPC convective outlooks | Hourly thunderstorm probability, ceiling/visibility forecasts | Catches convection the TAF misses (our expected main failure case) | Check archive coverage |

Airport time zones and IATA↔ICAO mapping come from the `airportsdata` package (already used).

## 4. What to build

### 4.1 Ingestion scripts: `scripts/` (P0)
One script per source, each taking `--icao KATL KDFW --start --end`. Each one caches raw files in `data/external/`, skips anything already downloaded, and runs with no manual steps. A `make data` (or `python -m pipeline.run`) target chains them. **Nothing in the scripts is specific to ATL or DFW**: an airport is a config entry (ICAO code + runway headings).

### 4.2 Cleaning (done: `01_clean_and_export.ipynb`)
Move the functions into `src/clean.py` so the full BTS files go through the same steps.

### 4.3 Airport-hour panel: `src/panel.py` (P0)
One row per airport × UTC hour:
- `arrivals_actual`: wheels-on count. This is the **AAR proxy** (observed throughput).
- `arrivals_scheduled`: demand, including flights delayed into this hour.
- `departures_actual` / `departures_scheduled`, `dep_disrupted_rate` (share of flights >45 min late, cancelled or diverted), `delay_min_per_flight`. **Rates, never raw totals**, so hubs and small airports compare fairly.
- `saturated`: demand ≥ throughput for this hour. Throughput only equals capacity when demand exceeds it, so we report AAR error on saturated hours separately and say so.
- `capacity_ratio = arrivals_actual / airport's nominal rate` (95th-percentile clear-weather throughput). This is a scale-free target that transfers across airports.

### 4.4 Feature builder with an issue time: `src/features.py` (P0)
For each target hour `H` and lead time `k ∈ {3..12}`, set issue time `T = H − k`. **Only data timestamped ≤ T may be used.** The cleaning notebook has an `asof_weather()` helper with an assert that enforces this.
- **TAF issued ≤ T, valid at H:** flight category, wind components against the runway heading (head/tail/cross, including gusts), `TS`/`VCTS`, whether a TEMPO group applies, hours since issue.
- **METAR at T:** current state plus 3 h trend in pressure and wind.
- **Schedule (known in advance, allowed):** scheduled arrivals and departures at H, hour, weekday, month.
- **Congestion at T:** throughput over the last 2 h, disrupted rate, average taxi-out.
- **Climatology:** median capacity ratio for airport × hour × month.

### 4.5 Models: `src/models/` (P0)
| Task | Model | Baselines it must beat | Metric |
|---|---|---|---|
| Hourly AAR, 3–12 h ahead | LightGBM regressor on `capacity_ratio` with lead time as a feature; quantile models for a P10–P90 band | (a) climatology, (b) persistence (the rate at issue time), (c) a TAF rule: flight category → typical rate | **RMSE** (arrivals/hour) per lead time; also on saturated and bad-weather hours only |
| Flight severe-delay risk (>45 min) | LightGBM classifier on `disrupted_45` using the features above plus predicted capacity gap (demand − predicted AAR) at the flight's hour; calibrated (isotonic) | Hub × hour × month historical rate; logistic regression on TAF features | PR-AUC, recall/precision at a fixed alert rate, Brier score, calibration plot |

**Data splits:** train Jan 2023–Jun 2024, validate Jul–Dec 2024, **test Jan–Jul 2025, untouched until the end**.
**Generalisation test:** train on ATL and test on DFW, then the reverse. Then add a third airport (e.g. ORD) by config alone to show "any ICAO code".

### 4.6 Evaluation and failure cases: `notebooks/03_evaluation.ipynb` (P0)
- RMSE vs lead time for model and baselines (error should rise with lead time; show it honestly).
- Results by weather type: convective, IFR, wind, winter (use NOAA Storm Events windows).
- **At least one failure shown in full:** e.g. a pop-up afternoon thunderstorm that the TAF didn't forecast, so the model missed the AAR drop. Explain why (no convective-probability input) and what would fix it (LAMP or SPC thunderstorm probability).
- Lead-time analysis: for each Storm Events window, how many hours ahead did the risk first cross the alert threshold?

### 4.7 Dashboard: Streamlit `app/` (P0 core, P1 extras)
- **Airport picker** by ICAO.
- **Next 12 h timeline:** predicted AAR with P10–P90 band against scheduled demand. Hours where demand is above the P10 capacity are highlighted.
- **Risk panel:** hourly share of flights expected to be severely disrupted, plus a sortable list of the highest-risk flights.
- **Evidence panel (traceability):** the raw and decoded TAF segment behind each hour with its issue time, the latest METAR, runway crosswind/tailwind against limits, top feature contributions (SHAP), and similar past days with what actually happened.
- **Recommendations from deterministic rules** that show their trigger. For example: *"P10 AAR < demand for 2+ hours starting 16Z (issued 10Z) → consider a GDP at about {P50 AAR}/h."* Or: *"Forecast tailwind 12 kt on RWY 08 at 18Z → expect a configuration change or reduced rate."* Each one has **Accept / Dismiss** with a log entry, so the human decides.
- **Uncertainty and refusal:** if the TAF is missing or more than 6 h old, or inputs fall outside the training range, show *"Low confidence: showing climatology"* instead of a model number.
- **History tab:** past 30 days of predicted vs actual throughput and disruption rate.

### 4.8 Where an LLM fits (optional, P2)
Only to turn the computed evidence (JSON) into a plain-language briefing for the TMC. The models and rules do all the numbers and decisions; the LLM never calculates or decides anything. This is the LLM/non-LLM split the rubric asks for.

## 5. How this maps to the judging rubric

| Criterion (weight) | What covers it |
|---|---|
| Problem realism (20%) | Named user (TMC / airline ops duty manager), reactive AAR cuts as the status quo, GDP lead-time constraint |
| Technical soundness (25%) | End-to-end scripts → panel → as-of features → models → dashboard; statistics and rules for decisions, LLM only for explanation; works for any configured ICAO code |
| Honest evaluation (20%) | Time-split test set, three baselines, RMSE by lead time, airport-transfer test, a documented failure case, AAR-proxy limitation stated up front |
| Trust and traceability (20%) | TAF/METAR evidence with timestamps per prediction, rule that triggered each recommendation, P10–P90 band, low-confidence fallback, Accept/Dismiss log |
| Impact (10%) | Hours of capacity shortfall flagged ≥3 h ahead vs the persistence baseline (what TMCs react to today). Convert to holding minutes avoided using **stated, cited** assumptions; keep measured and estimated numbers separate |
| Time discipline (5%) | Build in the order below; cut P2 first |

## 6. Build order for today

1. **BTS full download for ATL/DFW → hourly panel → AAR proxy label** (unblocks everything).
2. **TAF ingest + as-of feature builder** (the anti-leakage core).
3. **Baselines, then the LightGBM AAR model; RMSE by lead time.**
4. **Delay classifier on `disrupted_45`.**
5. **Streamlit dashboard:** timeline, evidence, rule-based recommendations.
6. **Evaluation notebook with a failure case**, then slides.
7. Stretch: Storm Events lead-time analysis, ATCSCC GDP validation, third airport, LLM briefing.

## 7. Risks to state up front
- **The AAR label is observed throughput, not the FAA-called rate.** It underestimates capacity in hours with low demand, so we report saturated hours separately. If ASPM or ATCSCC data become available, use them to validate.
- The brief fixes one runway heading per hub. Real operations switch runway direction to avoid tailwind. We follow the brief and can show the "best runway" variant using OurAirports data.
- TAF quality limits how far ahead we can see. Expect skill to fall with lead time and to be weakest for convection.

## 8. Ideas from research that make this stand out (implemented ✅ / possible next ⏭)
- ✅ **LAMP lightning and convection probabilities** as a "second opinion" next to the TAF. The TAF catches 56% of thunderstorm hours 6 h ahead, but 77% of its thunderstorm calls are false alarms; LAMP misses different storms.
- ✅ **Conformalized quantile bands** (Mondrian by lead × busy × weather signal): an 80% band the TMC can trust, with coverage checked on 2025 data.
- ✅ **Band-aware GDP policy:** the uncertainty band sets the GDP rate, trading fuel saved against unnecessary ground delay.
- ✅ **Queue-model impact estimate** with cited fuel and cost rates (EUROCONTROL Standard Inputs v10; A4A 2024).
- ✅ **"Similar past forecasts" analog panel:** shows what actually happened the last 5 times the TAF and LAMP looked like this (the analog approach used in KBR's TAF-based tool).
- ✅ **NOAA Storm Events warning lead time**, plus zero-shot transfer to ORD.
- ⏭ **Jev (TypeSafe)** or another text classifier for the text parts only: tagging TAF/METAR remarks or Storm Event narratives into impact types. The numeric models stay with LightGBM.
- ⏭ MRMS radar nowcasts or HRRR for pop-up convection (our main failure mode); MIT Lincoln Lab's Convective Weather Avoidance Model idea for terminal airspace.
- ⏭ Cost-loss decision threshold: issue a GDP when P(shortfall) > cost of ground delay / cost of airborne delay.
