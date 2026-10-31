/* Front page (overview route). Direction "The product performs": every picture is a working piece of the product. */
async function overview(v) {
  const H = S.meta.metrics_headline, mod = H.rmse, taf = H.baselines.find(r => r.model === "TAF rule");
  const full = "+ TAF / LAMP / METAR / Jev (full model)";
  const mm = H.main.find(r => r.scope === "ATL+DFW" && r.model === full) || {}, mh = H.main.find(r => r.scope === "ATL+DFW" && r.model === "Historical rate") || {};
  const st = H.storm[0], storm = st["warned ≥ 3 h ahead"], stormTaf = H.storm[1]["warned ≥ 3 h ahead"];
  const flightsM = (S.meta.integration?.bts_flights || 4630760) / 1e6;
  const better = 1 - mod["busy & weather-impacted"] / taf["busy & weather-impacted"];
  const demo = "#/outlook?ap=KATL&d=2025-06-27&h=14&r=1";
  v.innerHTML = `
  <div class="fp">
    <section class="fp-hero">
      <div class="fp-hero-copy">
        <h1 class="in-up">storm delays,<br>called early</h1>
        <p class="lead in-up d1">The chance that each Atlanta or Dallas/Fort Worth flight runs 45&nbsp;minutes late, 3 to 12 hours ahead. Early enough to hold aircraft at the gate, not in the air.</p>
        <div class="acts in-up d2"><a class="fp-btn" href="#check" data-jump>Check a flight</a><a class="fp-link" href="${demo}">Replay the 27 June storm</a></div>
      </div>
      <figure class="fp-scope" data-ui aria-label="Simulated approach scope over Atlanta runway 08: the same storm handled reactively, then with the forecast">
        <canvas id="scope" data-cx="0.56"></canvas>
        <div class="mode"><span class="tag react" id="h-mode">Today: reactive</span><div class="sub" id="h-sub"></div><div class="sub" id="h-clock" hidden></div></div>
        <div class="runs" id="h-runs"></div>
        <div class="hud"><div><div class="l">Holding now</div><div class="v amber" id="h-hold">0</div></div>
          <div><div class="l">Holding fuel</div><div class="v" id="h-fuel">0 t</div></div>
          <div><div class="l">Held at origin</div><div class="v cyan" id="h-ground">0</div></div></div>
      </figure>
    </section>

    <section class="fp-kpi" aria-labelledby="kpi-h">
      <h2 id="kpi-h" class="in-up">tested on 2025, a year it never saw</h2>
      <div class="kpi-main in-up d1">
        <div class="n">${Math.round(storm * 100)}<small>%</small></div>
        <p>of the storms that cut arrival capacity were flagged at least 3&nbsp;hours ahead.</p>
        <p class="soft">The official airport forecast alone caught ${pct(stormTaf)}. ${st["episodes with a capacity drop"]} storms, January to July 2025.</p>
      </div>
      <div class="kpi-side in-up d2">
        <div><div class="n2">${Math.round((mm.recall || 0) * 100)}<small>%</small></div>
          <p>of flights later delayed over 45 minutes were flagged 6 hours before. Going by each route's history catches ${pct(mh.recall || 0)}.</p></div>
        <div><div class="n2">${f1(mod["all hours"])}</div>
          <p>landings an hour: the typical error in the arrival-rate forecast, ${pct(better)} smaller than the forecast rule in storms.</p></div>
        <a class="fp-link" href="#/performance">Full scorecard and over-fitting check</a>
      </div>
    </section>

    <section class="fp-show" id="check" aria-labelledby="show-h">
      <div class="ask">
        <h2 id="show-h" class="in-up">check a flight</h2>
        <form class="sentence in-up d1" id="fp-form" onsubmit="return false">
          Airline <input id="f-cr" value="DL" size="3" aria-label="Airline code"> from <input id="f-o" value="ATL" size="4" aria-label="From airport">
          to <input id="f-d" value="LGA" size="4" aria-label="To airport"> on <input id="f-dt" value="2025-06-27" size="10" aria-label="Date"> at
          <input id="f-tm" value="19:00" size="5" aria-label="Local departure time">, asked <input id="f-ld" value="6" size="2" aria-label="Hours ahead"> hours ahead.
        </form>
        <p class="hint in-up d2">Any flight to or from ATL, DFW or ORD between January 2023 and July 2025. The model only sees weather reported at least 3 hours before departure.</p>
      </div>
      <div class="ans">
        <div class="frag card-ui in-up d1" data-ui id="fp-out" aria-live="polite"><div class="k">Asking the model…</div></div>
      </div>
    </section>

    <section class="fp-flow" aria-labelledby="flow-h">
      <div class="head in-up"><h2 id="flow-h">how it works</h2>
        <p>Public flight and weather data goes in. Nothing newer than the forecast time gets through. The models produce the numbers, and a traffic manager decides what to do with them.</p></div>
      <div class="in-up d1">${flowDiagram({ flights: f1(flightsM), prauc: f2(mm["PR-AUC"] || 0), recall: pct(mm.recall || 0), rmse: f1(mod["all hours"]), mc: 20 })}</div>
    </section>

    <footer class="fp-foot"><span class="name">gatehold</span>
      <nav><a href="#/departures?ap=KATL&d=2025-06-27&h=14&r=1">Flights at risk</a><a href="${demo}">Capacity outlook</a><a href="#/performance">Performance</a><a href="#/data">Data</a><a href="#/try">Try your own file</a></nav>
      <p>Airbus Challenge 5, 2026. Data from US DOT BTS, Iowa Environmental Mesonet, NOAA and OurAirports.</p></footer>
  </div>`;

  Hero.start($("#scope"));
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.1 });
  v.querySelectorAll(".in-up").forEach(el => io.observe(el));
  setTimeout(() => v.querySelectorAll(".in-up").forEach(el => el.classList.add("in")), 2500);   // never leave content hidden
  v.querySelector("[data-jump]").addEventListener("click", e => { e.preventDefault(); $("#check").scrollIntoView({ behavior: "smooth" }); });

  // the live thing: the sentence drives the model
  const out = $("#fp-out");
  let t;
  const ask = async () => {
    const q = { origin: $("#f-o").value.trim(), dest: $("#f-d").value.trim(), date: $("#f-dt").value.trim(), dep_time: $("#f-tm").value.trim(),
                carrier: $("#f-cr").value.trim(), lead: Math.min(12, Math.max(3, +$("#f-ld").value || 6)) };
    try {
      const r = await api("predict_one", q); const x = r.rows[0], thr = r.summary.threshold || 0.19;
      out.innerHTML = `<div class="k">${x.flight} · ${x.route}</div>
        <div class="big">${pct(x.p_delay_gt45)}</div><div>chance of a delay over 45 minutes</div>
        <div class="meter" role="img" aria-label="${pct(x.p_delay_gt45)} against the ${pct(thr)} flag line"><i style="width:${Math.min(100, x.p_delay_gt45 * 100)}%"></i><b style="left:${thr * 100}%"></b></div>
        <span class="flag ${x.flag_gt45 ? "on" : "off"}">${x.flag_gt45 ? "Flagged" : "Not flagged"}</span><span class="k" style="margin-left:10px">flag line ${pct(thr)}</span>
        <div class="k" style="margin-top:18px">Main reasons</div><ul>${x.top_reasons.split(", ").slice(0, 3).map(s => `<li>${esc(s.replace(/ [↑↓]$/, ""))} <span class="k">${s.endsWith("↓") ? "lowers" : "raises"} the risk</span></li>`).join("")}</ul>`;
    } catch (e) { out.innerHTML = `<div class="k">No answer for this flight</div><p style="margin-top:8px">${esc(e.message.replace(/^Declined: /, ""))}</p>`; }
  };
  $("#fp-form").addEventListener("input", () => { clearTimeout(t); t = setTimeout(ask, 450); });
  ask();
}

/* Performance page: the over-fitting check (Monte Carlo refits) and the LightGBM vs XGBoost comparison */
function fitChecks(H) {
  const mc = H.monte_carlo, xg = H.xgb;
  let mcHtml = "";
  if (mc) {
    const runs = mc.runs_table, keys = [["PR-AUC fitted", "Days it trained on", "#a39d96"], ["PR-AUC held-out days", "Days it never saw", "#3987e5"], ["PR-AUC 2025 test", "2025", "#c9a45a"]];
    const vals = runs.flatMap(r => keys.map(k => r[k[0]])), lo = Math.floor(Math.min(...vals) * 50) / 50, hi = Math.ceil(Math.max(...vals) * 50) / 50;
    const X = v => 170 + (v - lo) / (hi - lo) * 500;
    const mean = k => runs.reduce((a, r) => a + r[k], 0) / runs.length;
    const strips = keys.map(([k, lab, col], i) => `<text x="0" y="${34 + i * 38}" class="sc-lab">${lab}</text>` +
      runs.map(r => `<circle cx="${X(r[k])}" cy="${30 + i * 38}" r="5" fill="${col}" fill-opacity=".8"/>`).join("") +
      `<text x="700" y="${34 + i * 38}" class="sc-v">${f3(mean(k))}</text>`).join("");
    const ticks = d3.range(lo, hi + 1e-9, (hi - lo) / 4).map(t => `<text x="${X(t)}" y="140" class="sc-t" text-anchor="middle">${f2(t)}</text>`).join("");
    const sd = mc.summary.find(r => r.metric === "PR-AUC 2025 test")?.std || 0;
    mcHtml = `<div class="card span-7"><h2>Is it over-fitting?</h2>
      <p class="note">${mc.runs} refits, each trained on a random 70% of 2023–24 days. Each dot is one refit's PR-AUC.</p>
      <svg viewBox="0 0 760 152" class="sc-svg" role="img" aria-label="PR-AUC of ${mc.runs} refits on days trained on, days never seen, and 2025">${strips}${ticks}</svg>
      <p>The trees fit their own training days best (${f3(mean("PR-AUC fitted"))}), so training scores are never quoted. Days they never saw (${f3(mean("PR-AUC held-out days"))}) and 2025 (${f3(mean("PR-AUC 2025 test"))}) agree, and 2025 moves only ±${f3(sd)} between refits. The reported numbers are what to expect on new data.</p></div>`;
  }
  const xgHtml = xg ? `<div class="card span-5"><h2>Why LightGBM, not XGBoost</h2>
      ${table(xg.map(r => ({ ...r, s: Math.round(r["train seconds"]) + " s" })), [{ key: "model", label: "Model" }, { key: "PR-AUC", label: "PR-AUC", fmt: f3 }, { key: "ROC-AUC", label: "ROC-AUC", fmt: f3 }, { key: "s", label: "Training" }])}
      <p class="note">Same rows, features and early stopping. ${xgVerdict(xg)}</p></div>` : "";
  return mcHtml + xgHtml;
}

function xgVerdict(xg) {
  const l = xg.find(r => r.model.startsWith("LightGBM")), x = xg.find(r => r.model.startsWith("XGBoost"));
  if (!l || !x) return "";
  const d = x["PR-AUC"] - l["PR-AUC"], speed = x["train seconds"] / Math.max(l["train seconds"], 1);
  const acc = Math.abs(d) < 0.005 ? "Accuracy is a tie" : d > 0 ? `XGBoost is ${f3(d)} PR-AUC better, a small margin` : `LightGBM is ${f3(-d)} PR-AUC better`;
  return `${acc}. LightGBM trains ${speed >= 1.2 ? `${f1(speed)}× faster` : "about as fast"}, handles the airline and airport categories natively, and gives the per-flight reasons the board shows.`;
}
