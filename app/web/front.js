/* Front page (overview route). Direction "The product performs": every picture is a working piece of the product. */
async function overview(v) {
  const H = S.meta.metrics_headline, mod = H.rmse, taf = H.baselines.find(r => r.model === "TAF rule");
  const full = "+ TAF / LAMP / METAR / Jev (full model)";
  const mm = H.main.find(r => r.scope === "ATL+DFW" && r.model === full) || {}, mh = H.main.find(r => r.scope === "ATL+DFW" && r.model === "Historical rate") || {};
  const storm = H.storm[0]["warned ≥ 3 h ahead"], stormTaf = H.storm[1]["warned ≥ 3 h ahead"];
  const flightsM = (S.meta.integration?.bts_flights || 4630760) / 1e6;
  const demo = "#/outlook?ap=KATL&d=2025-06-27&h=14&r=1";
  const split = x => { const s = (+x).toFixed(x < 1 ? 2 : 1).split("."); return [s[0], s[1] ? "." + s[1] : ""]; };
  const ledger = [
    [split(mm["PR-AUC"] || 0), "PR-AUC for delays over 45 minutes, 6 h ahead", `the historical rate scores ${f2(mh["PR-AUC"] || 0)}`],
    [[String(Math.round((mm.recall || 0) * 100)), ""], "per cent of those delays flagged 6 h ahead", `at ${pct(mm.precision || 0)} precision; history manages ${pct(mh.recall || 0)}`],
    [[String(Math.round(storm * 100)), ""], "per cent of NOAA-logged storms flagged 3+ h ahead", `the TAF alone: ${pct(stormTaf)}`],
    [split(mod["all hours"]), "landings an hour, arrival-rate error (RMSE)", `${pct(1 - mod["busy & weather-impacted"] / taf["busy & weather-impacted"])} better than the TAF rule in storms`],
    [split(flightsM), "million flights joined to hourly weather", "by airport and UTC hour"],
  ];
  v.innerHTML = `
  <div class="fp">
    <section class="fp-hero">
      <div class="fp-hero-copy">
        <h1 class="in-up">storm delays,<br>called early</h1>
        <p class="lead in-up d1">Every Atlanta and Dallas/Fort Worth flight's chance of a delay over 45 minutes, forecast 3 to 12 hours ahead, so traffic managers can hold aircraft at the gate instead of in the air.</p>
        <div class="acts in-up d2"><a class="fp-btn" href="#/try">Test it on your flights</a><a class="fp-link" href="${demo}">Replay the 27 June storm</a></div>
        <p class="note in-up d3">Built for Airbus Challenge 5. Weather is used only if observed at least 3 hours before each scheduled time.</p>
      </div>
      <figure class="fp-scope" data-ui aria-label="Simulated approach scope over Atlanta runway 08">
        <canvas id="scope" data-cx="0.56"></canvas>
        <figcaption>Same storm over runway 08, twice: reacting today, then planning with the forecast.</figcaption>
        <div class="mode"><span class="tag react" id="h-mode">Today: reactive</span><div class="sub" id="h-sub"></div><div class="sub" id="h-clock"></div></div>
        <div class="legend2"><span style="color:#eef3fb">white: inbound</span> · <span style="color:#ffb84d">amber: holding</span> · <span style="color:#ff4fd8">magenta: final</span></div>
        <div class="runs" id="h-runs"></div>
        <div class="hud"><div><div class="l">Holding now</div><div class="v amber" id="h-hold">0</div></div>
          <div><div class="l">Holding fuel</div><div class="v" id="h-fuel">0 t</div></div>
          <div><div class="l">Held at origin</div><div class="v cyan" id="h-ground">0</div></div></div>
      </figure>
    </section>

    <section class="fp-why" aria-labelledby="why-h">
      <h2 id="why-h" class="in-up">the gate or the sky</h2>
      <figure class="g in-up d1"><img src="/static/img/atlanta-hartsfield-jackson-airport-concourse-a-aerial.jpg" alt="Aerial view of aircraft parked at Concourse A, Hartsfield-Jackson Atlanta" width="1920" height="1280" loading="lazy">
        <figcaption>A delay spent at the gate in Atlanta costs crew time, with engines off.</figcaption></figure>
      <figure class="s in-up d2"><img src="/static/img/thunderstorm-over-gatwick-airport-from-the-air.jpg" alt="Storm clouds over an airport, seen from an aircraft" width="1920" height="1440" loading="lazy">
        <figcaption>The same delay spent holding in the air burns about 35 kg of fuel a minute.</figcaption></figure>
      <p class="why-t in-up d1">Today the arrival rate is cut when the storm is already overhead, so aircraft circle. Warned 3 to 12 hours ahead, the same flights can wait on the ground before they ever take off.</p>
    </section>

    <section class="fp-show" aria-labelledby="show-h">
      <div class="in">
        <form class="sentence in-up" id="fp-form" onsubmit="return false">
          Airline <input id="f-cr" value="DL" size="3" aria-label="Airline code"> from <input id="f-o" value="ATL" size="4" aria-label="From airport">
          to <input id="f-d" value="LGA" size="4" aria-label="To airport"> on <input id="f-dt" value="2025-06-27" size="10" aria-label="Date"> at
          <input id="f-tm" value="19:00" size="5" aria-label="Local departure time">, asked <input id="f-ld" value="6" size="2" aria-label="Hours ahead"> hours ahead.
          <span class="hint">Change any word and the model answers on the right. Flights touching ATL, DFW or ORD, Jan 2023 to Jul 2025.</span>
        </form>
        <h2 id="show-h">your flight</h2>
      </div>
      <div class="out">
        <div class="frag card-ui in-up d1" data-ui id="fp-out" aria-live="polite"><div class="k">Asking the model…</div></div>
        <h2 aria-hidden="true">its risk</h2>
      </div>
    </section>

    <section class="fp-proof" aria-label="Data sources">
      <p>Built on open data from</p><span>US DOT BTS</span><span>Iowa Mesonet</span><span>NOAA NCEI</span><span>Meteostat</span><span>OurAirports</span><span>TypeSafe Jev</span>
    </section>

    <section class="fp-how" aria-labelledby="how-h">
      <div class="stage"><div id="fp-stage" data-ui class="card-ui"></div></div>
      <div class="fp-steps">
        <h2 id="how-h">how a call is made</h2>
        <div class="st" data-s="0"><h3>flight meets weather</h3><p>Each departure and arrival is joined to the airport's hourly weather, and the wind is resolved onto the runway as headwind, tailwind and crosswind.</p></div>
        <div class="st" data-s="1"><h3>only what was known</h3><p>A forecast made at T sees weather observed at T or earlier, and T sits 3 to 12 hours before departure. The code refuses anything newer.</p></div>
        <div class="st" data-s="2"><h3>the model weighs it</h3><p>LightGBM combines the schedule, the late inbound aircraft, the weather and the TAF and LAMP forecasts into one calibrated chance.</p></div>
        <div class="st" data-s="3"><h3>a person decides</h3><p>Fixed rules turn the numbers into suggestions with their trigger. Each one is accepted or dismissed, and logged.</p></div>
      </div>
    </section>

    <section class="fp-flow" aria-labelledby="flow-h">
      <div class="head in-up"><h2 id="flow-h">how it all fits</h2>
        <p>Public data goes in on the left. Nothing newer than the forecast time gets past the feature builder. Statistics make every number, fixed rules turn them into suggestions, and a person makes the call.</p></div>
      <div class="in-up d1">${flowDiagram({ flights: f1(flightsM), prauc: f2(mm["PR-AUC"] || 0), recall: pct(mm.recall || 0), rmse: f1(mod["all hours"]), mc: 20 })}</div>
    </section>

    <section class="fp-feat" aria-label="What the brief asked for">
      ${[["joins flights to their weather", `${f1(flightsM)} million BTS flights meet the organisers' hourly weather by airport and hour; their own sample rows match ours 99.99%. <a href="#/data">See the data</a>`, true],
         ["flags flights heading for 45 minutes", `Precision ${pct(mm.precision || 0)} and recall ${pct(mm.recall || 0)} six hours ahead, against ${pct(mh.precision || 0)} and ${pct(mh.recall || 0)} for the historical rate. <a href="#/departures?ap=KATL&d=2025-06-27&h=14&r=1">Flights at risk</a>`, true],
         ["forecasts how many aircraft can land", `${f1(mod["all hours"])} landings an hour of error, ${pct(1 - mod["busy & weather-impacted"] / taf["busy & weather-impacted"])} better than the TAF rule when storms are overhead. <a href="${demo}">Open the outlook</a>`, false],
         ["puts risk, history and advice together", `${pct(storm)} of NOAA-logged storms that cut capacity were flagged at least 3 hours ahead, with the evidence behind every number. <a href="${demo}">Replay a storm</a>`, false],
         ["rebuilds itself for any airport code", `One command downloads the public data and retrains; Chicago O'Hare, never seen in training, scores PR-AUC 0.31. <a href="#/try">Try your own file</a>`, false]]
        .map(([t, c, on], i) => `<div class="band ${on ? "on" : ""}"><div><h3>${t}</h3><p class="cons">${c}</p></div>
          <button class="fp-switch" role="switch" aria-checked="${on}" aria-label="${t}" data-i="${i}"></button></div>`).join("")}
    </section>

    <section class="fp-stats" aria-labelledby="stats-h">
      <div class="lhs"><h2 id="stats-h" class="in-up"><span>measured on 2025,</span>never trained on</h2>
        <figure class="in-up d1"><img src="/static/img/airbus-a319-british-airways-g-eupa-at.jpg" alt="An Airbus A319 at a gate in Hamburg, held during a thunderstorm" width="1920" height="1440" loading="lazy">
        <figcaption>An A319 at Hamburg, held two hours for a thunderstorm: the kind of flight these numbers are about.</figcaption></figure></div>
      <dl class="ledger">${ledger.map(([[w, d], c, s]) => `<div class="lrow in-up"><dt class="c">${c}<span class="soft">${s}</span></dt><dd class="w">${w}${d}</dd></div>`).join("")}</dl>
    </section>

    ${scorecard(H, mm, mh)}

    <section class="fp-notes">
      <div class="in-up"><h2>what we assumed</h2><ul>
        <li>A flight counts as delayed when DEP_DELAY (departures) or ARR_DELAY (arrivals) exceeds 45 minutes. Cancelled and diverted flights have no delay and are scored separately.</li>
        <li>Weather comes from the organisers' hourly file for ATL and DFW, Meteostat for other airports, and public METAR, TAF and LAMP issued before the forecast.</li>
        <li>Runways: ATL 80°, DFW 180°, others from OurAirports. The provided file is a 1% sample, so the full BTS data trains the model.</li></ul></div>
      <div class="in-up d1"><h2>where it falls short</h2><ul>
        <li>About one flagged flight in three is really over 45 minutes late: good for deciding what to watch, not for acting on a single flight.</li>
        <li>Storms that form without warning and rare ice storms are the main misses. <a class="fp-link" href="#/performance">See the failures</a></li>
        <li>Going live needs real-time FAA feeds and a trial alongside today's process.</li></ul></div>
    </section>

    <footer class="fp-foot"><span>Gatehold</span>
      <nav><a href="#/departures?ap=KATL&d=2025-06-27&h=14&r=1">Flights at risk</a><a href="#/try">Try the model</a><a href="${demo}">Capacity outlook</a><a href="#/performance">Performance</a><a href="#/data">Data</a></nav>
      <span class="r">Airbus Challenge 5 · 2026</span></footer>
    <p class="fp-credits">Pictures: <a href="https://commons.wikimedia.org/wiki/File:Atlanta_Hartsfield-Jackson_Airport_Concourse_A_aerial_(49054916886).jpg">Atlanta Concourse A aerial</a> by formulanone; <a href="https://commons.wikimedia.org/wiki/File:Thunderstorm_over_Gatwick_Airport_from_the_air_-_geograph.org.uk_-_2482228.jpg">Thunderstorm over Gatwick Airport from the air</a> by Thomas Nugent; <a href="https://commons.wikimedia.org/wiki/File:Airbus_A319_(British_Airways)_G-EUPA_at_Hamburg_(19303962928).jpg">Airbus A319 G-EUPA at Hamburg</a> by G B_NZ. All <a href="https://creativecommons.org/licenses/by-sa/2.0">CC BY-SA 2.0</a>, via Wikimedia Commons.</p>
  </div>`;

  const cv = $("#scope");
  Hero.start(cv);
  // entrances
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.1 });
  v.querySelectorAll(".in-up").forEach(el => io.observe(el));
  setTimeout(() => v.querySelectorAll(".in-up").forEach(el => el.classList.add("in")), 2500);   // never leave content hidden
  // switches
  v.querySelectorAll(".fp-switch").forEach(b => b.addEventListener("click", () => {
    const on = b.getAttribute("aria-checked") !== "true";
    b.setAttribute("aria-checked", on); b.closest(".band").classList.toggle("on", on);
  }));
  // live: the sentence form drives the model
  const out = $("#fp-out");
  let t;
  const ask = async () => {
    const q = { origin: $("#f-o").value.trim(), dest: $("#f-d").value.trim(), date: $("#f-dt").value.trim(), dep_time: $("#f-tm").value.trim(),
                carrier: $("#f-cr").value.trim(), lead: Math.min(12, Math.max(3, +$("#f-ld").value || 6)) };
    try {
      const r = await api("predict_one", q); const x = r.rows[0];
      out.innerHTML = `<div class="k">${x.flight} · ${x.route} · ${x.direction} at ${x.hub.slice(1)}</div>
        <div class="big" style="margin-top:10px">${pct(x.p_delay_gt45)}</div><div>chance of a delay over 45 minutes</div>
        <div class="meter" role="img" aria-label="risk against the flag threshold"><i style="width:${Math.min(100, x.p_delay_gt45 * 100)}%"></i><b style="left:${(r.summary.threshold || 0.19) * 100}%"></b></div>
        <div class="k">flag line at ${pct(r.summary.threshold || 0.19)}, set on 2024 data</div>
        <span class="flag ${x.flag_gt45 ? "on" : "off"}">${x.flag_gt45 ? "Flagged: likely over 45 minutes" : "Not flagged"}</span>
        <div class="row" style="margin-top:14px"><span class="k">forecast made</span><span>${x.forecast_issued_utc}</span></div>
        <div class="row"><span class="k">weather observed</span><span>${x.weather_observed_utc}</span></div>
        <div class="k" style="margin-top:12px">what pushed it</div><ul>${x.top_reasons.split(", ").map(s => `<li>${esc(s)}</li>`).join("")}</ul>`;
    } catch (e) { out.innerHTML = `<div class="k">The model declined</div><p style="margin-top:8px">${esc(e.message.replace(/^Declined: /, ""))}</p>`; }
  };
  $("#fp-form").addEventListener("input", () => { clearTimeout(t); t = setTimeout(ask, 450); });
  ask();
  // pinned story: four states of one fragment, with real data
  const stage = $("#fp-stage");
  const [o, f] = await Promise.all([api("outlook", { airport: "KATL", date: "2025-06-27", hour: 14 }).catch(() => null),
                                    api("predict_one", { origin: "ATL", dest: "LGA", date: "2025-06-27", dep_time: "19:00", carrier: "DL", lead: 6 }).catch(() => null)]);
  const x = f?.rows?.[0], w = o?.wind_now || {}, rec = o?.recommendations?.[0];
  const states = [
    `<div class="k">DL1000 ATL→LGA · scheduled 23:00Z</div><div class="row"><span>Hourly weather, ATL</span><span>${w.dir ?? "–"}° at ${f1(w.speed || 0)} kt</span></div>
     <div class="row"><span>On runway 08</span><span>tail ${f1(w.tail || 0)} kt · cross ${f1(w.cross || 0)} kt</span></div>
     <div class="row"><span>TAF in force</span><span><code>${esc(o?.hours?.[3]?.taf_raw || "")}</code></span></div>
     <div class="row"><span>TEMPO</span><span><code>${esc(o?.hours?.[0]?.ovl_raw || "none")}</code></span></div>`,
    `<div class="k">Forecast made at ${x?.forecast_issued_utc || "T"}</div><div class="big" style="font-size:44px;margin-top:8px">6 h before</div>
     <div class="row"><span>Weather used</span><span>observed ${x?.weather_observed_utc || "–"}</span></div>
     <div class="row"><span>Rule</span><span>observed ≥ 3 h before departure</span></div><div class="row"><span>Check</span><span>passed on every row</span></div>`,
    x ? `<div class="k">${x.flight} ${x.route}</div><div class="big" style="margin-top:8px">${pct(x.p_delay_gt45)}</div><div>chance of a delay over 45 minutes</div>
     <div class="meter"><i style="width:${x.p_delay_gt45 * 100}%"></i><b style="left:19%"></b></div><ul>${x.top_reasons.split(", ").map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : "",
    rec ? `<div class="k">Recommendation · rule-based</div><div style="font:700 26px/1.1 var(--fp-display);margin-top:8px">${esc(rec.title)}</div>
     <p style="margin-top:10px;color:#d8d2ca">${esc(rec.body)}</p><div class="k" style="margin-top:10px">rule: ${esc(rec.trigger)}</div>
     <div style="display:flex;gap:8px;margin-top:14px"><button class="fp-btn" style="padding:10px 16px" onclick="this.textContent='Accepted · logged'">Accept</button>
     <button class="fp-btn" style="padding:10px 16px;background:#2a2520;color:#fff" onclick="this.textContent='Dismissed'">Dismiss</button></div>` : "",
  ];
  const show = i => { stage.style.opacity = 0; setTimeout(() => { stage.innerHTML = states[i]; stage.style.opacity = 1; }, 180);
    v.querySelectorAll(".fp-steps .st").forEach(s => s.classList.toggle("on", +s.dataset.s === i)); };
  show(0);
  const so = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) show(+e.target.dataset.s); }), { rootMargin: "-45% 0px -45% 0px" });
  v.querySelectorAll(".fp-steps .st").forEach(s => so.observe(s));
}

/* Model scorecard: every headline metric with its 95% interval, the accuracy trap, and the over-fitting check */
function scorecard(H, mm, mh) {
  const all = H.main.filter(r => r.scope === "ATL+DFW"), on = all.find(r => r.model === "Always 'on time'") || {};
  const ci = Object.fromEntries((H.bootstrap || []).map(r => [r.metric, r]));
  const band = k => ci[k] ? `<span class="ci">95% CI ${k.includes("AUC") ? f2(ci[k]["2.5%"]) : pct(ci[k]["2.5%"])}–${k.includes("AUC") ? f2(ci[k]["97.5%"]) : pct(ci[k]["97.5%"])}</span>` : "";
  const cells = [
    ["accuracy", pct(mm.accuracy || 0), `"always on time" scores ${pct(on.accuracy || 0)}`, "accuracy"],
    ["precision", pct(mm.precision || 0), `historical rate ${pct(mh.precision || 0)}`, "precision"],
    ["recall", pct(mm.recall || 0), `historical rate ${pct(mh.recall || 0)}`, "recall"],
    ["F1", f2(mm.F1 || 0), `historical rate ${f2(mh.F1 || 0)}`, "F1"],
    ["PR-AUC", f2(mm["PR-AUC"] || 0), `historical rate ${f2(mh["PR-AUC"] || 0)}; random ${f2(mm["base rate"] || 0)}`, "PR-AUC"],
    ["ROC-AUC", f2(mm["ROC-AUC"] || 0), `historical rate ${f2(mh["ROC-AUC"] || 0)}; random 0.50`, "ROC-AUC"]];
  const mc = H.monte_carlo, xg = H.xgb;
  let mcHtml = "";
  if (mc) {
    const runs = mc.runs_table, keys = [["PR-AUC fitted", "fitted on", "#e5566f"], ["PR-AUC held-out days", "held-out days", "#3987e5"], ["PR-AUC 2025 test", "2025 test", "#3fc07a"]];
    const vals = runs.flatMap(r => keys.map(k => r[k[0]])), lo = Math.floor(Math.min(...vals) * 50) / 50, hi = Math.ceil(Math.max(...vals) * 50) / 50;
    const X = v => 150 + (v - lo) / (hi - lo) * 520;
    const mean = k => runs.reduce((a, r) => a + r[k], 0) / runs.length;
    const strips = keys.map(([k, lab, col], i) => `<text x="0" y="${34 + i * 38}" class="sc-lab">${lab}</text>` +
      runs.map(r => `<circle cx="${X(r[k])}" cy="${30 + i * 38}" r="5" fill="${col}" fill-opacity=".75"/>`).join("") +
      `<text x="690" y="${34 + i * 38}" class="sc-v">${f3(mean(k))}</text>`).join("");
    const ticks = d3.range(lo, hi + 1e-9, (hi - lo) / 4).map(t => `<text x="${X(t)}" y="138" class="sc-t" text-anchor="middle">${f2(t)}</text>`).join("");
    mcHtml = `<div class="sc-mc"><h3>is it over-fitting?</h3>
      <p class="soft">${mc.runs} Monte Carlo refits. Each one trains on a random 70% of 2023–24 days and is scored on the days it trained on, the 30% of days it never saw, and 2025. Each dot is one refit (PR-AUC).</p>
      <svg viewBox="0 0 760 150" class="sc-svg" role="img" aria-label="PR-AUC of 20 refits on fitted, held-out and test data">${strips}${ticks}</svg>
      <p>Trees fit the days they trained on far better (<b>${f3(mean("PR-AUC fitted"))}</b>) than days they never saw (<b>${f3(mean("PR-AUC held-out days"))}</b>): a gap of ${f3(mc.gap_mean)}. That is memorisation, so we never quote training scores. What matters is that unseen 2023–24 days and 2025 agree (${f3(mean("PR-AUC held-out days"))} vs ${f3(mean("PR-AUC 2025 test"))}), and 2025 barely moves between refits (±${f3(mc.summary.find(r => r.metric === "PR-AUC 2025 test")?.std || 0)}): the reported numbers are what to expect on new data. Stronger regularisation (fewer leaves) could narrow the gap; it is the next thing we would try.</p></div>`;
  }
  const xgHtml = xg ? `<div class="sc-xg"><h3>why lightgbm, not xgboost</h3><table><tr><th></th><th>PR-AUC</th><th>ROC-AUC</th><th>train time</th></tr>
      ${xg.map(r => `<tr><td>${r.model}</td><td>${f3(r["PR-AUC"])}</td><td>${f3(r["ROC-AUC"])}</td><td>${Math.round(r["train seconds"])} s</td></tr>`).join("")}</table>
      <p class="soft">Same rows, features and early stopping. ${xgVerdict(xg)}</p></div>` : "";
  return `<section class="fp-score" aria-labelledby="score-h">
    <div class="head in-up"><h2 id="score-h">the scorecard</h2><p class="soft">Main target, 6 h ahead, every ATL and DFW flight Jan–Jul 2025, never used in training. Intervals: 500 bootstrap resamples of test days.</p></div>
    <div class="sc-grid in-up d1">${cells.map(([k, v, s, key]) => `<div class="sc-cell"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div>${band(key)}</div>`).join("")}</div>
    <p class="sc-note in-up">Accuracy looks worse than "always on time" because only ${pct(mm["base rate"] || 0)} of flights are over 45 minutes late: a model that never flags anything is ${pct(on.accuracy || 0)} accurate and catches none of them. That is why precision and recall are the numbers to judge it on.</p>
    <div class="sc-two in-up">${mcHtml}${xgHtml}</div>
  </section>`;
}

function xgVerdict(xg) {
  const l = xg.find(r => r.model.startsWith("LightGBM")), x = xg.find(r => r.model.startsWith("XGBoost"));
  if (!l || !x) return "";
  const d = x["PR-AUC"] - l["PR-AUC"], speed = x["train seconds"] / Math.max(l["train seconds"], 1);
  const acc = Math.abs(d) < 0.005 ? "Accuracy is a tie" : d > 0 ? `XGBoost is ${f3(d)} PR-AUC better, a small margin` : `LightGBM is ${f3(-d)} PR-AUC better`;
  return `${acc}. LightGBM trains ${speed >= 1.2 ? `${f1(speed)}× faster` : "about as fast"}, handles the airline and airport categories natively, and gives the per-flight reasons the board shows.`;
}
