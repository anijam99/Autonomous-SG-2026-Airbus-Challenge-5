# Self-assessment against the judging rubric and the Challenge 5 brief (updated 31 Oct, 12:45)

Scores are our honest estimate (1–5) after the latest round of changes.

| Criterion (weight) | Score | Evidence | Remaining weakness |
|---|---|---|---|
| Problem realism (20%) | 4 | Named user (TMC, plus airline ops duty manager), today's workflow and its cost on the **Overview** page; GDP lead-time constraint | No interview with a real TMC; cost per minute uses published averages |
| Technical soundness (25%) | 4 | One command (`scripts/run_pipeline.py`) from public data to trained models, for any ICAO codes; leak-free as-of joins with asserts; LightGBM for numbers, fixed rules for actions, Jev only reads text; works on any date and airport in range | Label is runway throughput, not the FAA-called AAR |
| Honest evaluation (20%) | 4.5 | Scorecard with bootstrap 95% intervals; 20-run Monte Carlo cross-validation (train-vs-held-out gap reported, not hidden); XGBoost head-to-head; 4 baselines, ablation by source, time split, unseen airport (ORD) and leave-one-airport-out, conformal coverage (incl. where it under-covers), strict > 45 min label, worst-miss narrative, failure-cause breakdown, NOAA storm lead time, false-alarm rate | 73% band coverage in bad weather (below 80%) |
| Trust & traceability (20%) | 4.5 | Every hour shows the TAF and its issue time, LAMP run, METAR hour, drivers and similar past days; recommendations show the rule that fired; Accept/Dismiss audit log; downloadable briefing; **withholds** numbers when the TAF is stale; **declines** untested dates and airports | Briefing is markdown, not signed |
| Impact (10%) | 3.5 | Measured improvements kept separate from queue-model estimates; cited fuel and cost rates; adjustable assumptions; adoption constraints listed | Fuel/CO₂ figures are estimates against a no-GDP counterfactual |
| Time discipline (5%) | – | 3-minute script in `PITCH.md` | Depends on submission time |

## Brief: "want to see"
| Item | Where |
|---|---|
| Multi-source integration on timestamps + station IDs | BTS ⇄ METAR/TAF/LAMP by ICAO and UTC hour; provided file cross-checked (99.99% matched) |
| AAR accuracy by RMSE | Model performance page: RMSE vs 4 baselines, by lead time and weather |
| **Severe-delay (> 45 min) classification (main target after the 31 Oct update)** | ATL/DFW arrivals (ARR_DELAY) and departures (DEP_DELAY); precision 31% / recall 54% / PR-AUC 0.35 at 6 h; scored on 2025, on the organisers' sample rows, and on unseen ORD; **Try the model** upload and `scripts/predict.py` |
| Dashboard: risk scores + historical trends + recommendations | Outlook: typical-hour line, 14-day history, rule-based recommendations; Flights at risk: per-flight risk + 30-day route rate; Data page: fair airport comparison |
| Automatic processing of public datasets | `scripts/download_data.py`, `scripts/run_pipeline.py` |

## Brief: "want to avoid"
| Item | How it's avoided |
|---|---|
| Data leakage across time steps | Organisers' 3-hour rule asserted on every row; issue time T = target − lead; asserts on TAF issue, LAMP run and METAR hour; provided file's mistimed weather documented and not used as "current weather" |
| Ignoring runway directionality | Head/tail/crosswind on the brief's headings (ATL 80°, DFW 180°) for METAR, TAF and LAMP |
| Over-fitting to one airport | Airport-agnostic features scaled by each airport's nominal rate; ORD never trained on; any ICAO via `--train/--holdout` |
| Un-normalised delays | Rates per flight and per busy hour; delay minutes *per departure*; no raw-minute comparisons |
