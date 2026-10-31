/* Gatehold: single-page front end. All numbers come from the API (models + fixed rules). */
const S = { airport: "KATL", date: "2025-06-27", hour: 12, reveal: true, stale: false, route: "overview", sel: null, meta: null, filter: "all", lead: 6, impLead: 3, policy: "model_confident" };
const $ = s => document.querySelector(s);
const pct = d3.format(".0%"), f1 = d3.format(".1f"), f2 = d3.format(".2f"), f3 = d3.format(".3f"), comma = d3.format(",.0f");
const CAT = { 0: "VFR", 1: "MVFR", 2: "IFR", 3: "LIFR" };
const pill = s => `<span class="pill st-${s}">${STATUS[s][1]} ${STATUS[s][2]}</span>`;
const esc = s => (s ?? "").toString().replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function api(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`/api/${path}${q ? "?" + q : ""}`);
  if (!r.ok) { const e = new Error((await r.json()).detail || r.statusText); e.declined = r.status === 404; throw e; }
  return r.json();
}
const P = () => ({ airport: S.airport, date: S.date, hour: S.hour });
const PO = () => ({ ...P(), stale: S.stale ? 1 : 0 });

/* ---------------- state <-> URL ---------------- */
function readHash() {
  const [route, q] = location.hash.replace(/^#\//, "").split("?");
  S.route = route || "overview";
  const p = new URLSearchParams(q || "");
  if (p.get("run") === "sample") S.autoSample = true;
  if (p.get("ap")) S.airport = p.get("ap");
  if (p.get("d")) S.date = p.get("d");
  if (p.get("h")) S.hour = +p.get("h");
  if (p.get("r")) S.reveal = p.get("r") === "1";
}
function writeHash() {
  const h = `#/${S.route}?ap=${S.airport}&d=${S.date}&h=${S.hour}&r=${S.reveal ? 1 : 0}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

/* ---------------- chrome ---------------- */
function renderChrome() {
  $("#airports").innerHTML = S.meta.airports.map(a => `<button class="chip ${a.icao === S.airport ? "active" : ""}" data-ap="${a.icao}">
    ${a.icao}${a.trained ? "" : '<span class="tag">unseen</span>'}</button>`).join("");
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.r === S.route));
  $("#date").value = S.date; $("#date").min = S.meta.range.min; $("#date").max = S.meta.range.max;
  $("#hour").value = S.hour; $("#hourlbl").textContent = String(S.hour).padStart(2, "0") + ":00 local";
  $("#reveal").checked = S.reveal;
  const pres = S.meta.presets[S.airport] || [];
  $("#preset").innerHTML = `<option value="">NOAA-logged storms (${pres.length})…</option>` +
    pres.map((p, i) => `<option value="${i}">${esc(p.label)} · storm ${p.begin_local}</option>`).join("");
  const ap = S.meta.airports.find(a => a.icao === S.airport);
  $("#issued").textContent = `${S.airport} · ${S.date} ${String(S.hour).padStart(2, "0")}:00 ${ap.tz.split("/")[1].replace("_", " ")}`;
  $("#replay").style.display = ["outlook", "departures"].includes(S.route) ? "flex" : "none";
}

function bindChrome() {
  $("#airports").addEventListener("click", e => { const b = e.target.closest("[data-ap]"); if (b) { S.airport = b.dataset.ap; S.sel = null; go(); } });
  $("#date").addEventListener("change", e => { S.date = e.target.value; S.sel = null; go(); });
  $("#hour").addEventListener("input", e => { S.hour = +e.target.value; $("#hourlbl").textContent = String(S.hour).padStart(2, "0") + ":00 local"; });
  $("#hour").addEventListener("change", () => { S.sel = null; go(); });
  $("#reveal").addEventListener("change", e => { S.reveal = e.target.checked; go(); });
  $("#stale").addEventListener("change", e => { S.stale = e.target.checked; go(); });
  $("#preset").addEventListener("change", e => {
    const p = (S.meta.presets[S.airport] || [])[+e.target.value]; if (!p) return;
    S.date = p.date; S.hour = p.hour; S.sel = null; S.route = "outlook"; go();
  });
  addEventListener("hashchange", () => { readHash(); go(false); });
  let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => go(false), 250); });
}

async function go(push = true) {
  if (push) writeHash();
  document.body.classList.toggle("front", S.route === "overview");
  if (S.route !== "overview") window.scrollTo(0, 0);
  renderChrome();
  const v = $("#view");
  try {
    await ({ overview, try: tryPage, outlook, departures, performance: perfPage, impact, trends: dataStory, data: dataStory }[S.route] || overview)(v);
  } catch (e) {
    v.innerHTML = e.declined ? `<div class="card declined"><div class="eyebrow">⊘ The system declined</div><h2>No forecast shown</h2><p>${esc(e.message)}</p>
    <p class="note">The tool refuses rather than guessing outside the conditions it was tested on.</p></div>`
      : `<div class="card"><h2>Something went wrong</h2><p class="note">${esc(e.message)}</p></div>`; console.error(e); }
}

/* ================= OUTLOOK ================= */
async function outlook(v) {
  v.innerHTML = `<div class="loading">Loading forecast…</div>`;
  const o = await api("outlook", PO());
  const hrs = o.hours;
  if (!S.sel || !hrs.find(h => h.label === S.sel)) {
    const busy = hrs.filter(h => h.busy && !h.withheld); const worst = (busy.length ? busy : hrs).reduce((a, b) => (b.pred / Math.max(b.sched, 1) < a.pred / Math.max(a.sched, 1) ? b : a));
    S.sel = worst.label;
  }
  const red = hrs.filter(h => ["reduced", "severe"].includes(h.status));
  const worstStatus = ["severe", "reduced", "watch", "ok"].find(s => hrs.some(h => h.status === s));
  const headline = red.length ? `${red.length} hour${red.length > 1 ? "s" : ""} of reduced arrival capacity, ${red[0].label}–${red[red.length - 1].label}`
    : worstStatus === "watch" ? "Capacity near schedule, with risk in some hours" : "Arrival capacity on schedule for the next 12 hours";
  const k = o.kpi;
  v.innerHTML = `
  <div class="grid">
    <div class="card span-8">
      <div class="eyebrow" style="justify-content:space-between"><span>${o.name} · issued ${o.issue_local} (${o.issue_utc}) · runway heading ${o.heading}° · model ${o.model_version}</span>
        <button class="btn" id="brief">⤓ Download briefing</button></div>
      <div class="headline"><div class="icon" style="color:${STATUS[worstStatus][0]}">${STATUS[worstStatus][1]}</div>
        <div><h1>${headline}</h1><p>Forecast for each hour 3–12 h ahead from the TAF and LAMP issued before now, current METAR, the published schedule and traffic so far.</p></div></div>
      <div class="kpis">
        <div class="kpi"><div class="l">Reduced hours</div><div class="v">${k.reduced_hours}<span class="muted" style="font-size:14px"> / ${k.n_hours}</span></div><div class="d">forecast &lt; ${pct(S.meta.alert_ratio)} of schedule</div></div>
        <div class="kpi"><div class="l">Tightest hour</div><div class="v">${k.worst_label ?? (o.withheld_hours ? "⊘" : "–")}</div><div class="d">${k.worst_ratio != null ? d3.format("+.0%")(k.worst_ratio - 1) + " vs schedule" : (o.withheld_hours ? "withheld" : "")}</div></div>
        <div class="kpi"><div class="l">Landings, next 12 h</div><div class="v">${k.pred_total == null ? "⊘" : comma(k.pred_total)}</div><div class="d">schedule ${comma(k.sched_total)}${S.reveal ? ` · actual ${comma(k.actual_total)}` : ""}</div></div>
        <div class="kpi"><div class="l">TAF age at issue</div><div class="v">${k.taf_age != null ? f1(k.taf_age) + " h" : "–"}</div><div class="d">older forecasts → lower confidence</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:12px">
        <div><div class="note">Last 14 days at ${o.airport}: share of departures disrupted (history known at issue time)</div>
          <div class="recent" id="recent"></div></div>
        <div><div class="note">Last 14 days: landings as % of schedule in busy hours</div><div class="recent" id="recent2"></div></div></div>
      ${o.withheld_hours ? `<div class="banner">⊘ ${o.withheld_hours} hour(s) withheld: the TAF is missing or more than 6 h old, so the system shows no number for them rather than guess.</div>` : ""}
      ${o.trained ? "" : `<div class="banner">◆ ${o.airport} was <b>never used in training</b>. Same pipeline, given only its ICAO code, runway heading (OurAirports) and published schedule.</div>`}
    </div>
    <div class="card span-4">
      <div class="eyebrow">Runway wind at issue time · ${esc(o.wind_now.source || "")} · ≥ 3 h before every forecast hour</div>
      <div style="display:flex;gap:14px;align-items:center">
        <div id="dial"></div>
        <div style="flex:1">${windReadout(o)}</div>
      </div>
    </div>
    <div class="card span-12">
      <div class="eyebrow">Arrival capacity (AAR proxy: runway landings/h) · next 3–12 h · risk vs history · click an hour for evidence</div>
      <div id="cap"></div>
      <div class="strip" id="strip"></div>
    </div>
    <div class="card span-7"><div class="eyebrow">Recommendations · fixed, auditable rules · you decide</div><div id="recs"></div>
      <details style="margin-top:8px"><summary class="note" style="cursor:pointer">Decision log</summary><div id="log" class="note"></div></details></div>
    <div class="card span-5 jev"><div class="eyebrow">Jev reads the forecast <span class="jev-badge">TypeSafe System One · typed answers</span></div><div id="jev"><div class="shimmer"></div><div class="shimmer"></div><div class="shimmer"></div></div></div>
    <div class="card span-12" id="evidence"><div class="loading">Select an hour</div></div>
  </div>`;
  windDial($("#dial"), o.wind_now, o.heading, o.max_fc);
  const rmax = d3.max(o.recent, r => r.disrupted) || 1;
  $("#recent").innerHTML = o.recent.map(r => `<i title="${r.day}: ${pct(r.disrupted)} disrupted, ${r.ts_hours} thunderstorm h" style="height:${Math.max(4, r.disrupted / rmax * 100)}%;${r.ts_hours ? "background:" + COL.serious : ""}"></i>`).join("");
  $("#recent2").innerHTML = o.recent.map(r => `<i title="${r.day}: ${pct(r.landed_ratio)} of schedule landed" style="height:${Math.max(4, Math.min(1.1, r.landed_ratio) / 1.1 * 100)}%;background:${r.landed_ratio < 0.85 ? COL.serious : COL.aqua}"></i>`).join("");
  $("#brief").onclick = () => downloadBriefing(o);
  capacityChart($("#cap"), hrs, { reveal: S.reveal, selected: S.sel, onSelect: l => { S.sel = l; refreshSel(o); } });
  renderStrip(hrs);
  renderRecs(o);
  loadLog();
  renderEvidence();
  renderJev();
}
function refreshSel(o) { capacityChart($("#cap"), o.hours, { reveal: S.reveal, selected: S.sel, onSelect: l => { S.sel = l; refreshSel(o); } }); renderStrip(o.hours); renderEvidence(); }

function windReadout(o) {
  const w = o.wind_now, mf = o.max_fc;
  const bar = (v, lim, col) => `<div class="riskbar" style="margin:3px 0 8px"><i style="width:${Math.min(100, (v || 0) / lim * 100)}%;background:${(v || 0) > lim ? COL.critical : col}"></i></div>`;
  return `<div class="note">Observed at issue time (km/h converted to kt)</div>
    <div class="mono" style="font-size:13px">Tailwind <b>${f1(w.tail ?? 0)}</b> kt</div>${bar(w.tail, 10, COL.yellow)}
    <div class="mono" style="font-size:13px">Crosswind <b>${f1(w.cross ?? 0)}</b> kt</div>${bar(w.cross, 20, COL.yellow)}
    <div class="note">${CAT[w.cat] ?? "?"}${w.wx ? " · " + esc(w.wx) : ""}${w.vis != null ? ` · vis ${f1(w.vis)} mi` : ""}</div>
    <div class="note" style="margin-top:8px">Worst forecast in window (TAF): tail <b>${f1(mf.tail)}</b> kt · cross <b>${f1(mf.cross)}</b> kt · gust cross <b>${f1(mf.gust_cross)}</b> kt</div>
    <div class="note">Limits shown: tailwind 10 kt, crosswind 20 kt.</div>`;
}

function renderStrip(hrs) {
  $("#strip").innerHTML = hrs.map(h => {
    const r = h.pred / Math.max(h.sched, 1), col = STATUS[h.status][0];
    if (h.withheld) return `<div class="hour" data-l="${h.label}"><div class="edge" style="background:${col}"></div>
      <div style="display:flex;justify-content:space-between"><span class="t">${h.label}</span><span class="lead">+${h.lead}h</span></div>
      <div class="n">—<span class="s"> / ${h.sched}</span></div><div class="s">typical ${Math.round(h.typical ?? 0)}</div>
      <div class="s" style="margin-top:14px">⊘ withheld: TAF ${h.taf_age ?? "?"} h old</div></div>`;
    return `<div class="hour ${h.label === S.sel ? "sel" : ""}" data-l="${h.label}"><div class="edge" style="background:${col}"></div>
      <div style="display:flex;justify-content:space-between"><span class="t">${h.label}</span><span class="lead">+${h.lead}h</span></div>
      <div class="n">${Math.round(h.pred)}<span class="s"> / ${h.sched}</span></div>
      <div class="s">${Math.round(h.lo)}–${Math.round(h.hi)}${S.reveal ? ` · act ${h.actual}` : ""}</div>
      <div class="bar"><i style="width:${Math.min(100, r * 100)}%;background:${col}"></i></div>
      <div class="s" style="margin-top:6px">${STATUS[h.status][1]} ${h.taf_class}${h.lamp_ltg >= 20 ? " · lightning " + Math.round(h.lamp_ltg) + "%" : ""}</div></div>`;
  }).join("");
  $("#strip").onclick = e => { const c = e.target.closest(".hour"); if (c) { S.sel = c.dataset.l; go(false); } };
}

function renderRecs(o) {
  $("#recs").innerHTML = o.recommendations.map((r, i) => `<div class="rec" id="rec${i}" style="border-left-color:${STATUS[r.level][0]}">
    <div><div class="title">${STATUS[r.level][1]} ${esc(r.title)}</div><div class="body">${esc(r.body)}</div><div class="trig">rule: ${esc(r.trigger)}</div></div>
    <div class="btns">${r.id === "none" ? "" : `<button class="btn primary" data-i="${i}" data-d="accepted">Accept</button><button class="btn" data-i="${i}" data-d="dismissed">Dismiss</button>`}</div></div>`).join("");
  $("#recs").onclick = async e => {
    const b = e.target.closest("button[data-d]"); if (!b) return;
    const r = o.recommendations[+b.dataset.i];
    await fetch("/api/decision", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ airport: S.airport, issued: `${S.date} ${S.hour}:00`, recommendation: r.title, rule: r.trigger, decision: b.dataset.d }) });
    const card = $("#rec" + b.dataset.i); card.classList.add("decided");
    card.querySelector(".btns").innerHTML = `<span class="decided-tag">${b.dataset.d}</span>`;
    loadLog();
  };
}
async function loadLog() {
  const l = await api("decisions");
  $("#log").innerHTML = l.length ? table(l.slice(0, 12), [{ key: "logged_utc", label: "Logged (UTC)" }, { key: "airport", label: "Airport" },
    { key: "issued", label: "Forecast issued" }, { key: "recommendation", label: "Recommendation" }, { key: "decision", label: "Decision" }]) : "No decisions yet.";
}

async function renderJev() {
  const el = $("#jev");
  if (!S.meta.jev_enabled) { el.innerHTML = `<p class="note">Add TYPESAFE_API_KEY to .env to enable Jev.</p>`; return; }
  try {
    const j = await api("jev_brief", P());
    S.lastJev = j;
    if (!j.ok) { el.innerHTML = `<p class="note">Jev unavailable: ${esc(j.error)}. The forecast above does not depend on it.</p>`; return; }
    const hz = Object.entries(j.hazard.probabilities).sort((a, b) => b[1] - a[1]);
    const names = { convective: "Convective", low_visibility: "Low visibility", winter: "Winter / icing", rain: "Rain", none: "No hazard" };
    const sev = j.severity, sevLab = sev.legend[String(Math.round(sev.score))];
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline"><h2 style="margin:0">${names[j.hazard.choice] || j.hazard.choice}</h2>
        <span class="note">confidence ${pct(j.hazard.confidence)} · ${esc(j.model)}</span></div>
      ${hz.map(([k, p]) => `<div class="prob-row"><span>${names[k] || k}</span><div class="track"><i style="width:${p * 100}%"></i></div><span class="pct">${pct(p)}</span></div>`).join("")}
      <h3>Implied capacity impact: <span style="color:${["#3fc07a", "#fab219", "#ec835a", "#e5566f"][Math.round(sev.score)]}">${esc(sevLab)}</span> <span class="note">(score ${f2(sev.score)} / 3)</span></h3>
      <div class="prob-row"><span>Timing uncertain</span><div class="track"><i style="width:${j.timing_uncertain.noul * 100}%;background:${COL.yellow}"></i></div><span class="pct">${pct(j.timing_uncertain.noul)}</span></div>
      <div class="prob-row"><span>Consider restrictions</span><div class="track"><i style="width:${j.needs_gdp.noul * 100}%;background:${COL.serious}"></i></div><span class="pct">${pct(j.needs_gdp.noul)}</span></div>
      <details style="margin-top:8px"><summary class="note" style="cursor:pointer">What Jev read (decoded TAF groups, ${j.lines.length})</summary><div class="jev-lines">${j.lines.map(esc).join("<br>")}</div></details>
      <p class="note" style="margin-top:8px">Jev only reads the forecast text and returns typed probabilities. It does not set the arrival rate. Use it as a second reading of the TAF; the models and rules above make the numbers.</p>`;
  } catch (e) { el.innerHTML = `<p class="note">Jev unavailable: ${esc(e.message)}</p>`; }
}

const TOKEN_EN = t => {
  let m;
  if ((m = t.match(/^FM(\d{2})(\d{2})(\d{2})$/))) return `From day ${m[1]} at ${m[2]}:${m[3]} UTC`;
  if (t === "TEMPO") return "Temporarily (for less than half the period)";
  if ((m = t.match(/^PROB(\d0)$/))) return `${m[1]}% probability`;
  if ((m = t.match(/^(\d{2})(\d{2})\/(\d{2})(\d{2})$/))) return `Between day ${m[1]} ${m[2]}:00 and day ${m[3]} ${m[4]}:00 UTC`;
  if ((m = t.match(/^(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?KT$/))) return `Wind ${m[1] === "VRB" ? "variable" : "from " + m[1] + "°"} at ${+m[2]} kt${m[4] ? ", gusting " + +m[4] : ""}`;
  return null;
};
const HAZ = /TS|CB|FZ|SN|PL|GR|\+|VV00|^(0|1\/|1\/4|1\/2|3\/4)|OVC00|BKN00|FG/;

async function renderEvidence() {
  const el = $("#evidence");
  el.innerHTML = `<div class="loading">Explaining ${S.sel}…</div>`;
  const e = await api("explain", { ...P(), target: S.sel });
  const tokens = e.taf.map(g => `<div class="ticker">${g.raw.split(" ").map(t => {
      const en = TOKEN_EN(t) || g.en.split("; ").find(x => x) && null;
      return `<span class="tok ${HAZ.test(t) ? "hz" : ""}" data-en="${esc(TOKEN_EN(t) || "")}" data-raw="${esc(t)}">${esc(t)}</span>`;
    }).join("")}</div><div class="english">↳ ${esc(g.en)}</div>`).join("");
  el.innerHTML = `
    <div class="eyebrow">Evidence for ${e.label} local · forecast issued ${e.lead} h ahead</div>
    <div class="grid" style="gap:18px">
      <div class="span-5">
        <h2>Forecast ${Math.round(e.pred)} landings <span class="muted" style="font-weight:400">(band ${Math.round(e.lo)}–${Math.round(e.hi)}) vs ${e.sched} scheduled</span></h2>
        ${S.reveal ? `<p>What happened: <b>${e.actual}</b> landed · observed ${CAT[e.observed.cat] ?? "?"}${e.observed.ts ? ", thunderstorm" : ""}</p>` : ""}
        <h3>TAF in force at issue time (hover a code to decode)</h3>${tokens || '<p class="note">No TAF available.</p>'}
        <h3>LAMP guidance</h3>
        <div class="meters">
          <div class="meter"><div class="l">Lightning prob.</div><div class="v">${e.lamp.ltg ?? "–"}%</div></div>
          <div class="meter"><div class="l">Convection prob.</div><div class="v">${e.lamp.conv ?? "–"}%</div></div>
          <div class="meter"><div class="l">Precip prob.</div><div class="v">${e.lamp.pop ?? "–"}%</div></div>
        </div>
        <p class="note">METAR at issue: ${CAT[e.metar_at_issue.cat] ?? "?"}${e.metar_at_issue.ts ? ", thunderstorm" : ""} · tailwind ${f1(e.metar_at_issue.tail ?? 0)} kt · crosswind ${f1(e.metar_at_issue.cross ?? 0)} kt</p>
      </div>
      <div class="span-7">
        <h3 style="margin-top:0">What moved the forecast (arrivals/h vs. a typical hour of ${f1(e.baseline)})</h3>
        <div id="drivers"></div>
        <h3>Similar past forecasts at this airport, and what actually happened</h3>
        ${table(e.analogs, [{ key: "when", label: "When (local)" }, { key: "sched", label: "Sched" }, { key: "landed", label: "Landed" },
          { key: "landed", label: "vs sched", fmt: (v, r) => { const x = v / Math.max(r.sched, 1) - 1; return `<span style="color:${x < -0.2 ? COL.serious : COL.ink2}">${d3.format("+.0%")(x)}</span>`; } },
          { key: "taf", label: "TAF then", fmt: v => `<span class="mono" style="font-size:11px">${esc(v)}</span>` }])}
      </div>
    </div>`;
  hbars($("#drivers"), e.drivers.map(d => ({ label: d.label, value: d.value, tip: `${d.value >= 0 ? "+" : ""}${f1(d.value)} arrivals/h<br>input value: ${d.input == null ? "missing" : f2(d.input)}<br>source: ${d.group}` })),
    { diverging: true, fmt: v => (v >= 0 ? "+" : "") + f1(v), labelW: 250 });
  el.querySelectorAll(".tok").forEach(t => {
    t.addEventListener("mousemove", ev => tip.show(`<b class="mono">${t.dataset.raw}</b><br>${t.dataset.en || "see plain-English line below"}`, ev));
    t.addEventListener("mouseleave", () => tip.hide());
  });
}

/* ================= FLIGHTS AT RISK (main target) ================= */
async function departures(v) {
  v.innerHTML = `<div class="loading">Scoring flights…</div>`;
  const d = await api("flights", P());
  const thr = d.threshold;
  const lvl = r => r >= thr ? ["Over 45 min", "#e5566f"] : r >= thr * 0.6 ? ["Watch", COL.warning] : ["On time", COL.good];
  const labelled = d.flights.filter(f => f.y45 != null);
  const prec = d.flagged ? d.tp / d.flagged : null, rec = d.actual ? d.tp / d.actual : null;
  v.innerHTML = `
  <div class="grid">
    <div class="card span-4"><div class="eyebrow">Main target · ${S.airport} · flights 3–12 h ahead</div>
      <h1>${d.flagged} of ${d.n} flights</h1><p>flagged as likely to be delayed <b>more than 45 minutes</b> (departures: DEP_DELAY, arrivals: ARR_DELAY). Expected total ${comma(d.expected)}; the 2025 average is ${pct(d.base_rate)} of flights.</p>
      ${S.reveal ? `<p>What happened: <b>${d.actual}</b> of ${d.labelled} operated flights were &gt; 45 min late. In this window the flags caught <b>${d.tp}</b>: precision ${prec == null ? "–" : pct(prec)}, recall ${rec == null ? "–" : pct(rec)}.</p>` : ""}
      <p class="note">Flag threshold ${f2(thr)}, chosen on 2024 validation data (best F1) and frozen. Only weather observed ≥ 3 h before each scheduled time is used. Rates per flight, never raw minutes.</p></div>
    <div class="card span-8"><div class="eyebrow">Share of flights &gt; 45 min late, by scheduled hour</div><div id="riskhr"></div></div>
    <div class="card span-12"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div class="eyebrow">Flights board · sorted by risk · hover "why" for the reasons</div>
      <div style="display:flex;gap:8px"><div class="segs" id="dirf">${["all", "DEP", "ARR"].map(k => `<button class="${(S.dir || "all") === k ? "on" : ""}" data-k="${k}">${{ all: "All", DEP: "Departures", ARR: "Arrivals" }[k]}</button>`).join("")}</div>
      <div class="segs" id="flt">${["all", "high"].map(k => `<button class="${S.filter === k ? "on" : ""}" data-f="${k}">${{ all: "All", high: "Flagged" }[k]}</button>`).join("")}</div></div></div>
      <div class="board"><div class="board-head"><span>Time</span><span>Flight</span><span>Dir · ↔</span><span>Tail</span><span>Risk</span><span>Status</span><span>30-day route</span><span>Main driver (hover)</span><span>Aircraft status at issue</span><span>${S.reveal ? "Actual delay" : ""}</span></div><div id="rows"></div></div></div>
  </div>`;
  const hr = d.by_hour;
  vbars($("#riskhr"), hr.map(h => h.hour), [{ name: "Forecast", color: COL.blue, values: hr.map(h => h.forecast) }].concat(S.reveal ? [{ name: "Actual", color: COL.orange, values: hr.map(h => h.actual ?? 0) }] : []),
    { yfmt: pct, height: 230, yLabel: "% > 45 min late" });
  const flap = s => `<span class="flap">${[...String(s)].map((c, i) => `<b style="animation-delay:${i * 25}ms">${c === " " ? "&nbsp;" : esc(c)}</b>`).join("")}</span>`;
  const draw = () => {
    let fl = [...d.flights].sort((a, b) => b.risk - a.risk);
    if ((S.dir || "all") !== "all") fl = fl.filter(f => f.dir === S.dir);
    if (S.filter === "high") fl = fl.filter(f => f.flag);
    $("#rows").innerHTML = fl.slice(0, 60).map(f => { const [t, c] = lvl(f.risk);
      const act = f.cancelled ? '<b style="color:#e5566f">Cancelled</b>' : f.actual_delay == null ? "–" :
        (f.actual_delay > 45 ? `<b style="color:#ec835a">+${Math.round(f.actual_delay)} min</b>` : `${f.actual_delay > 0 ? "+" : ""}${Math.round(f.actual_delay)} min`);
      return `<div class="board-row"><span>${flap(f.time)}</span><span>${flap(f.flight.padEnd(6))}</span><span>${flap(f.dir === "ARR" ? "◀" + f.other : "▶" + f.other)}</span><span style="font-size:12px;color:#b9b5aa">${esc(f.tail)}</span>
        <span style="display:flex;gap:8px;align-items:center"><div class="riskbar" style="flex:1"><i style="width:${f.risk * 100}%;background:${c}"></i></div><span style="width:34px;text-align:right">${Math.round(f.risk * 100)}%</span></span>
        <span class="lvl" style="color:${c}">${t}</span><span class="why">${f.route_rate == null ? "–" : pct(f.route_rate)}</span>
        <span class="why drv" data-why="${esc(f.why)}" style="cursor:help;border-bottom:1px dotted #555">${esc(f.driver)}</span><span class="inb">${esc(f.status)}</span>
        <span class="inb">${S.reveal ? act : ""}</span></div>`; }).join("") + (fl.length > 60 ? `<div class="board-row" style="color:#7d7a72">… ${fl.length - 60} more (lower risk)</div>` : "");
  };
  draw();
  $("#rows").addEventListener("mousemove", ev => { const t = ev.target.closest(".drv"); if (t) tip.show(`<b>Top factors for this flight</b><br>${t.dataset.why.split(", ").join("<br>")}<br><span class="muted">↑ raises risk · ↓ lowers risk</span>`, ev); else tip.hide(); });
  $("#rows").addEventListener("mouseleave", () => tip.hide());
  $("#flt").onclick = e => { const b = e.target.closest("[data-f]"); if (!b) return; S.filter = b.dataset.f; $("#flt").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); draw(); };
  $("#dirf").onclick = e => { const b = e.target.closest("[data-k]"); if (!b) return; S.dir = b.dataset.k; $("#dirf").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); draw(); };
}

/* ================= PERFORMANCE ================= */
async function perfPage(v) {
  v.innerHTML = `<div class="loading">Loading metrics…</div>`;
  const { metrics: M, worst_case: W, failures } = await api("performance");
  const rm = M.aar_rmse_test, model = rm[rm.length - 1];
  const bestBase = rm.slice(0, 4).reduce((a, b) => a["busy & weather-impacted"] < b["busy & weather-impacted"] ? a : b);
  const det6 = M.aar_detection.filter(r => r.lead_h === 6);
  const csi = m => det6.find(r => r.method === m)?.CSI;
  const storm = M.storm_lead_time;
  const clf6 = M.clf_test.filter(r => r.lead_h === 6 && r.airports === "ATL+DFW");
  const MT = M.main_test || [], m6 = MT.filter(r => r.lead_h === 6);
  const mrow = (scope, model) => m6.find(r => r.scope === scope && r.model === model) || {};
  const full = "+ TAF / LAMP / METAR / Jev (full model)";
  v.innerHTML = `
  <h1 style="margin:0 0 4px">Model performance</h1><p class="muted" style="margin:0 0 16px">Every number below is measured on Jan–Jul 2025, data the models never trained on.</p>
  <div class="card" style="margin-bottom:16px"><div class="eyebrow"><span class="tagm meas">Main target</span> Will this ATL/DFW flight be delayed &gt; 45 min? · 2025 test · 6 h ahead · threshold ${f2(M.main_threshold)} (set on 2024 validation)</div>
    <div class="statgrid" style="margin:10px 0 14px">
      ${[["precision", "of flagged flights really were > 45 min late"], ["recall", "of > 45 min delays were flagged 6 h ahead"], ["F1", "balance of precision and recall"], ["PR-AUC", "ranking quality (base rate " + pct(mrow("ATL+DFW", full)["base rate"] || 0) + ")"]]
        .map(([k, l]) => `<div class="stat" style="background:var(--surface-2)"><div class="v">${k === "PR-AUC" || k === "F1" ? f2(mrow("ATL+DFW", full)[k] || 0) : pct(mrow("ATL+DFW", full)[k] || 0)}</div><div class="l">${l}</div><div class="c">historical rate: ${k === "PR-AUC" || k === "F1" ? f2(mrow("ATL+DFW", "Historical rate")[k] || 0) : pct(mrow("ATL+DFW", "Historical rate")[k] || 0)}</div></div>`).join("")}
    </div>
    <div class="segs" id="mlead">${[3, 6, 12].map(k => `<button class="${k === 6 ? "on" : ""}" data-k="${k}">${k} h ahead</button>`).join("")}</div>
    <div id="mtab" style="margin-top:8px"></div>
    <p class="note">"Always on time" scores high accuracy and zero recall, which is why accuracy alone is misleading. The ablation models are compared at the same alert rate as the full model. The <b>organisers' sample rows</b> are the flights in Flight_Data_With_Weather_Final.csv during the test period. Cancelled and diverted flights (${pct(M.main_excluded_cancelled_diverted || 0)}) have no delay value and are excluded from this label (assumption).</p>
    <div class="grid" style="margin-top:6px"><div class="span-6"><h3>By airport and direction (6 h)</h3>${table(M.main_by_airport_direction || [], [{ key: "index", label: "Group" }, { key: "base rate", label: "Base rate", fmt: pct }, { key: "precision", label: "Precision", fmt: pct }, { key: "recall", label: "Recall", fmt: pct }, { key: "F1", label: "F1", fmt: f2 }, { key: "PR-AUC", label: "PR-AUC", fmt: f2 }])}
      <h3>Fair vs bad weather at the scheduled hour</h3>${table(M.main_by_weather || [], [{ key: "index", label: "Conditions" }, { key: "base rate", label: "Base rate", fmt: pct }, { key: "precision", label: "Precision", fmt: pct }, { key: "recall", label: "Recall", fmt: pct }, { key: "PR-AUC", label: "PR-AUC", fmt: f2 }])}</div>
      <div class="span-6"><h3>What the classifier relies on</h3><div id="mimp"></div><h3>Calibration (6 h)</h3><div id="mcal"></div></div></div>
  </div>
  <div class="eyebrow" style="margin:6px 0 10px"><span class="tagm est">Bonus</span> Arrival acceptance rate (AAR), measured from full BTS data</div>
  <div class="statgrid">
    <div class="stat"><div class="v">${f1(model["all hours"])}</div><div class="l">arrivals/h RMSE, all 2025 test hours</div><div class="c">best baseline ${f1(Math.min(...rm.slice(0, 4).map(r => r["all hours"])))} · schedule ${f1(rm[0]["all hours"])}</div></div>
    <div class="stat"><div class="v">${f1(model["busy & weather-impacted"])}</div><div class="l">RMSE in busy, bad-weather hours</div><div class="c">${bestBase.model} ${f1(bestBase["busy & weather-impacted"])} (${d3.format(".0%")(1 - model["busy & weather-impacted"] / bestBase["busy & weather-impacted"])} lower)</div></div>
    <div class="stat"><div class="v">${f2(csi("Model"))}</div><div class="l">CSI for capacity drops 6 h ahead</div><div class="c">TAF says TS/IFR: ${f2(csi("TAF says TS or IFR"))} · persistence ${f2(csi("Persistence"))}</div></div>
    <div class="stat"><div class="v">${pct(storm[0]["warned ≥ 3 h ahead"])}</div><div class="l">of NOAA-logged storms that cut capacity were flagged ≥ 3 h ahead</div><div class="c">TAF alone: ${pct(storm[1]["warned ≥ 3 h ahead"])} (${storm[0]["episodes with a capacity drop"]} episodes)</div></div>
  </div>
  <div class="grid" style="margin-top:16px">
    <div class="card span-6"><div class="eyebrow">Ablation · each data source must earn its place</div><h2>RMSE by input set (arrivals/h)</h2>
      <div class="segs" id="abl">${["all hours", "busy hours", "weather-impacted hours", "busy & weather-impacted"].map((k, i) => `<button class="${i === 3 ? "on" : ""}" data-k="${k}">${k}</button>`).join("")}</div><div id="ablc"></div></div>
    <div class="card span-6"><div class="eyebrow">Error vs lead time</div><h2>RMSE 3 → 12 h ahead</h2>
      <div class="segs" id="leadsel"><button class="on" data-k="aar_rmse_by_lead">All hours</button><button data-k="aar_rmse_by_lead_impacted">Weather-impacted</button></div><div id="leadc"></div></div>
    <div class="card span-6"><div class="eyebrow">Uncertainty · conformalized 80% bands</div>${table(M.aar_coverage, [{ key: "index", label: "Hours" }, { key: "coverage (target 80%)", label: "Coverage", fmt: v => `<b style="color:${v >= 0.78 ? COL.good : COL.warning}">${pct(v)}</b>` }, { key: "mean band width (arrivals/h)", label: "Band width", fmt: f1 }])}
      <p class="note">Coverage dips below 80% in bad weather, so the band understates risk exactly when it matters. The dashboard flags convective windows as lower confidence for this reason.</p>
      <h3>Detecting capacity drops (busy hours, landings &gt; 20% below schedule)</h3>
      ${table(M.aar_detection.filter(r => [3, 6, 12].includes(r.lead_h)), [{ key: "lead_h", label: "Lead" }, { key: "method", label: "Method" }, { key: "POD (share of events forecast)", label: "Hit rate", fmt: pct }, { key: "FAR (false alarm ratio)", label: "False alarm ratio", fmt: pct }, { key: "CSI", label: "CSI", fmt: f3 }])}</div>
    <div class="card span-6"><div class="eyebrow">Generalisation · airports not used in training</div>
      ${table(M.aar_generalisation, [{ key: "test", label: "Test" }, { key: "Model", label: "Model", fmt: f2 }, { key: "Climatology", label: "Clim.", fmt: f2 }, { key: "TAF rule", label: "TAF rule", fmt: f2 }, { key: "Model (weather-impacted)", label: "Model (wx)", fmt: f2 }, { key: "TAF rule (weather-impacted)", label: "TAF (wx)", fmt: f2 }])}
      <p class="note">ORD, never seen in training, scores better than every baseline. But a model trained on DFW alone loses to the TAF rule at ATL, so one airport is not enough to learn from.</p>
      <h3>What the arrival model relies on</h3><div id="impg"></div></div>
    <div class="card span-7"><div class="eyebrow">Flight severe-delay classifier</div><h2>Ablation by lead time</h2>
      <div class="segs" id="clfl">${[3, 6, 12].map(k => `<button class="${k === S.lead ? "on" : ""}" data-k="${k}">${k} h</button>`).join("")}</div><div id="clft"></div>
      <p class="note">Base rate ${pct(M.clf_base_rate_test)}. Precision/recall when the 10% riskiest flights are flagged, which is how an operations desk would use it. ORD's climatology uses ORD's own history; the model uses none.</p></div>
    <div class="card span-12"><div class="eyebrow">The brief's exact label · departure delay &gt; 45 min (flights that departed)</div>
      ${M.clf_strict_dep45 ? table(M.clf_strict_dep45, [{ key: "lead_h", label: "Lead (h)" }, { key: "base rate", label: "Base rate", fmt: pct }, { key: "ROC-AUC", label: "ROC-AUC", fmt: f3 }, { key: "PR-AUC", label: "PR-AUC", fmt: f3 },
        { key: "Brier", label: "Brier", fmt: f3 }, { key: "precision@10% alerts", label: "Precision@10%", fmt: pct }, { key: "recall@10% alerts", label: "Recall@10%", fmt: pct }]) : ""}
      <p class="note">The main model is trained on "disrupted" (&gt; 45 min late <i>or</i> cancelled or diverted), because a cancellation is the worst delay of all. This table scores the same model on the strict &gt; 45 min departure-delay label.</p></div>
    <div class="card span-5"><div class="eyebrow">Calibration at 6 h</div><h2>Does 30% mean 30%?</h2><div id="cal"></div></div>
    <div class="card span-5"><div class="eyebrow">Inputs · 6 h ahead vs what was then observed</div>${table(M.input_skill_lead6, [{ key: "index", label: "Signal" }, { key: "POD (share of events forecast)", label: "Hit rate", fmt: pct }, { key: "FAR (false alarm ratio)", label: "False alarms", fmt: pct }, { key: "CSI", label: "CSI", fmt: f3 }])}
      <p class="note">The TAF catches more storms but raises far more false alarms; LAMP is the reverse. That is why the model uses both.</p></div>
    <div class="card span-7"><div class="eyebrow">Where it fails</div><h2>Likely cause of the 100 most over-optimistic busy hours (6 h ahead)</h2><div id="failc"></div>
      <h3>Worst miss: ${W.airport}, ${W.when}</h3>
      <p>Forecast <b>${Math.round(W.pred)}</b> (band ${Math.round(W.lo)}–${Math.round(W.hi)}), actually <b>${W.actual}</b> of ${W.sched} scheduled. Likely cause: <i>${esc(W.cause)}</i>.</p>
      <div class="ticker" style="font-size:12.5px">${esc(W.taf)}${W.tempo ? " + " + esc(W.tempo) : ""}</div>
      <p class="note">How the user would know: the band and the "convective / winter" recommendation flag lower confidence whenever any signal exists. Rare high-impact events (ice storms, ground stops) are under-represented in training, so their impact is under-estimated. Fix: more seasons of data, and radar or HRRR inputs for storms that appear without warning.</p></div>
  </div>`;
  const mdraw = k => $("#mtab").innerHTML = table(MT.filter(r => r.lead_h === k), [{ key: "scope", label: "Scored on" }, { key: "model", label: "Model" },
    { key: "base rate", label: "Base rate", fmt: pct }, { key: "accuracy", label: "Accuracy", fmt: pct }, { key: "precision", label: "Precision", fmt: pct },
    { key: "recall", label: "Recall", fmt: pct }, { key: "F1", label: "F1", fmt: f2 }, { key: "PR-AUC", label: "PR-AUC", fmt: f3 }, { key: "ROC-AUC", label: "ROC-AUC", fmt: f3 }]);
  mdraw(6);
  $("#mlead").onclick = e => { const b = e.target.closest("button"); if (!b) return; $("#mlead").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); mdraw(+b.dataset.k); };
  if (M.main_importance_groups) hbars($("#mimp"), Object.entries(M.main_importance_groups).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: { schedule: "Schedule & route", ops: "Aircraft & congestion", hourly_wx: "Hourly weather (≥3 h old)", forecasts: "TAF/LAMP/METAR/Jev" }[k] || k, value: v * 100 })), { fmt: v => f1(v) + "%", labelW: 180, height: 160 });
  if (M.main_calibration_lead6) { const c = M.main_calibration_lead6; lines($("#mcal"), c.map(x => f2(x.predicted)), [{ name: "Observed", color: COL.blue, values: c.map(x => x.observed) }, { name: "Perfect", color: COL.muted, values: c.map(x => x.predicted), dash: "4 4", noDots: true }], { yLabel: "observed", height: 220, yfmt: f3 }); }
  const ablDraw = k => hbars($("#ablc"), rm.map((r, i) => ({ label: r.model, value: r[k], color: i < 4 ? COL.muted : (i === rm.length - 1 ? COL.blue : "#5e8fca") })), { fmt: f2, labelW: 230 });
  ablDraw("busy & weather-impacted");
  $("#abl").onclick = e => { const b = e.target.closest("button"); if (!b) return; $("#abl").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); ablDraw(b.dataset.k); };
  const leadDraw = k => { const d = M[k]; const names = Object.keys(d[0]).filter(c => c !== "lead_h");
    const cmap = { Model: COL.blue, "TAF rule": COL.orange, Persistence: COL.aqua, Schedule: COL.yellow, Climatology: COL.muted };
    lines($("#leadc"), d.map(r => r.lead_h), names.map(n => ({ name: n, color: cmap[n], values: d.map(r => r[n]), width: n === "Model" ? 3 : 2 })), { yLabel: "RMSE", xLabel: "hours ahead", height: 270, yfmt: f2 }); };
  leadDraw("aar_rmse_by_lead");
  $("#leadsel").onclick = e => { const b = e.target.closest("button"); if (!b) return; $("#leadsel").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); leadDraw(b.dataset.k); };
  hbars($("#impg"), Object.entries(M.aar_importance_groups).map(([k, v]) => ({ label: k, value: v * 100 })), { fmt: v => f1(v) + "%", labelW: 90, height: 170 });
  const clfDraw = () => $("#clft").innerHTML = table(M.clf_test.filter(r => r.lead_h === S.lead), [{ key: "airports", label: "Airports" }, { key: "model", label: "Model" },
    { key: "ROC-AUC", label: "ROC-AUC", fmt: f3 }, { key: "PR-AUC", label: "PR-AUC", fmt: f3 }, { key: "Brier", label: "Brier", fmt: f3 }, { key: "precision@10% alerts", label: "Precision@10%", fmt: pct }, { key: "recall@10% alerts", label: "Recall@10%", fmt: pct }]);
  clfDraw();
  $("#clfl").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.lead = +b.dataset.k; $("#clfl").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); clfDraw(); };
  const cal = M.clf_calibration_lead6;
  lines($("#cal"), cal.map(c => f2(c.predicted)), [{ name: "Observed share disrupted", color: COL.blue, values: cal.map(c => c.observed) }, { name: "Perfect", color: COL.muted, values: cal.map(c => c.predicted), dash: "4 4", noDots: true }],
    { yLabel: "observed", xLabel: "predicted risk (bin mean)", height: 260, yfmt: f3 });
  hbars($("#failc"), Object.entries(M.failure_causes_top100).map(([k, v]) => ({ label: k, value: v, color: COL.orange })), { fmt: d3.format("d"), labelW: 440 });
}

/* ================= IMPACT ================= */
async function impact(v) {
  const { metrics: M } = await api("performance");
  const A = M.impact_assumptions;
  v.innerHTML = `
  <div class="grid">
    <div class="card span-5"><div class="eyebrow">Impact estimate · ATL + DFW · Jan–Jul 2025</div><h1>Move holding from the air to the ground</h1>
      <p>A queue model replays every 2025 test hour. <b>Reactive</b>: flights depart on schedule and excess arrivals hold in the air. <b>Proactive</b>: when the forecast issued earlier is &gt; 15% below schedule, flights wait at their origin (a Ground Delay Program) at the forecast rate.</p>
      <div class="slider-row"><span>Forecast issued</span><div class="segs" id="il">${[3, 6].map(k => `<button class="${S.impLead === k ? "on" : ""}" data-k="${k}">${k} h ahead</button>`).join("")}</div><span></span></div>
      <div class="slider-row"><span>GDP rate policy</span><div class="segs" id="ip"><button class="${S.policy === "model_confident" ? "on" : ""}" data-k="model_confident">Cautious (band top)</button><button class="${S.policy === "model" ? "on" : ""}" data-k="model">Aggressive (forecast rate)</button></div><span></span></div>
      <div class="slider-row"><span>Holding fuel burn (kg/min)</span><input type="range" id="fuel" min="15" max="90" step="0.1" value="${A.fuel_hold_kg_min}"><span class="mono" id="fuelv"></span></div>
      <div class="slider-row"><span>Airborne cost (USD/min)</span><input type="range" id="cost" min="40" max="200" step="1" value="${A.block_cost_usd_min}"><span class="mono" id="costv"></span></div>
      <div class="slider-row"><span>Ground delay at gate (USD/min)</span><input type="range" id="gate" min="0" max="80" step="1" value="25"><span class="mono" id="gatev"></span></div>
      <p class="note">Sources: fuel <a href="https://ansperformance.eu/economics/cba/standard-inputs/chapters/rate_of_fuel_burn.html" target="_blank">EUROCONTROL Standard Inputs v10</a> (narrow body, arrival management 35.2 kg/min) · cost <a href="https://www.airlines.org/dataset/u-s-passenger-carrier-delay-costs/" target="_blank">Airlines for America</a> ($100.76 per block minute, 2024) · CO₂ 3.16 kg per kg fuel (ICAO). Gate cost is an assumption; move it to test sensitivity.</p></div>
    <div class="span-7" style="display:flex;flex-direction:column;gap:16px">
      <div class="card"><div class="eyebrow"><span class="tagm meas">Measured</span> on Jan–Jul 2025 test data</div><div class="statgrid" id="im"></div></div>
      <div class="eyebrow" style="margin:0"><span class="tagm est">Estimated</span> queue-model replay · depends on the assumptions on the left</div>
      <div class="statgrid" id="ik"></div>
      <div class="card"><div class="eyebrow">Hours of holding moved, by policy</div><div id="ib"></div>
        <p class="note"><b>Reading this honestly:</b> a GDP triggered by the TAF rule <i>adds</i> holding, because the TAF flags many harmless hours and misses real drops. Our model captures part of the perfect-foresight ceiling. Its false alarms cost ground delay: the aggressive policy adds about 3 minutes at the gate for every airborne minute it saves, so we recommend the cautious policy (about 1.3 to 1). Break-even gate cost: about $32/min aggressive, $75/min cautious. Today's ATC already runs GDPs on many bad days, so the real gain over current practice is smaller than the gap to "reactive". This is a model estimate, not a measured outcome.</p></div>
    </div>
  </div>`;
  const draw = () => {
    const fuel = +$("#fuel").value, cost = +$("#cost").value, gate = +$("#gate").value;
    $("#fuelv").textContent = f1(fuel); $("#costv").textContent = "$" + cost; $("#gatev").textContent = "$" + gate;
    const rows = M.impact.filter(r => r.lead_h === S.impLead);
    const agg = sc => { const rr = rows.filter(r => r.scenario === sc); const base = rows.filter(r => r.scenario === "reactive");
      const air = d3.sum(rr, r => r.airborne_saved_min), gnd = d3.sum(rr, r => r.ground_min) - d3.sum(base, r => r.ground_min);
      return { air, gnd, fuel: air * fuel / 1000, co2: air * fuel / 1000 * 3.16, net: air * cost - gnd * gate }; };
    const m = agg(S.policy), p = agg("perfect");
    $("#ik").innerHTML = [[comma(m.air / 60) + " h", "airborne holding avoided"], [comma(m.fuel) + " t", `fuel saved · ${pct(m.fuel / p.fuel)} of the perfect-foresight ceiling`],
      [comma(m.co2) + " t", "CO₂ avoided"], ["$" + f1(m.net / 1e6) + "M", `net · ${comma(m.gnd / 60)} h of ground delay added`]]
      .map(([a, b]) => `<div class="stat"><div class="v">${a}</div><div class="l">${b}</div></div>`).join("");
    const sc = ["taf_rule", "model", "model_confident", "perfect"], lab = { taf_rule: "TAF-rule GDP", model: "Model: aggressive", model_confident: "Model: cautious", perfect: "Perfect foresight" };
    const vals = sc.map(agg);
    vbars($("#ib"), sc.map(s => lab[s]), [{ name: "Airborne holding avoided (h)", color: COL.blue, values: vals.map(x => x.air / 60) }, { name: "Ground delay added (h)", color: COL.orange, values: vals.map(x => x.gnd / 60) }], { height: 280, yfmt: comma, yLabel: "hours" });
  };
  const rm = M.aar_rmse_test, mod = rm[rm.length - 1], taf = rm.find(r => r.model === "TAF rule"), st = M.storm_lead_time;
  const d6 = M.aar_detection.filter(r => r.lead_h === 6);
  $("#im").innerHTML = [[d3.format(".0%")(1 - mod["busy & weather-impacted"] / taf["busy & weather-impacted"]), "lower forecast error than the TAF rule in busy, bad-weather hours"],
    [f2(d6.find(r => r.method === "Model").CSI) + " vs " + f2(d6.find(r => r.method === "TAF says TS or IFR").CSI), "CSI for capacity drops 6 h ahead: model vs TAF"],
    [pct(st[0]["warned ≥ 3 h ahead"]) + " vs " + pct(st[1]["warned ≥ 3 h ahead"]), "storms flagged ≥ 3 h ahead: model vs TAF"],
    [pct(M.false_alarm_share_busy_lead6), "of busy hours are false alarms (forecast a > 20% drop that never came)"]]
    .map(([a, b]) => `<div class="stat" style="background:var(--surface-2)"><div class="v">${a}</div><div class="l">${b}</div></div>`).join("");
  draw();
  ["fuel", "cost", "gate"].forEach(id => $("#" + id).addEventListener("input", draw));
  $("#il").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.impLead = +b.dataset.k; $("#il").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); draw(); };
  $("#ip").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.policy = b.dataset.k; $("#ip").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); draw(); };
}

/* ================= DATA STORY ================= */
async function dataStory(v) {
  v.innerHTML = `<div class="loading">Loading data story…</div>`;
  const [d, t] = await Promise.all([api("data_story"), api("trends", { airport: S.airport })]);
  const I = d.integration;
  const issues = [
    ["Critical", "Weather joined at the wrong time", "Meteostat weather is indexed in UTC but was joined on each flight's local scheduled hour, so every value is 4–30 h older than its flight (ATL ≈ 5 h, DFW ≈ 6 h). Checked against real METARs: 99.9% match when read as UTC, 15.6% as local.", "Stored the true observation time and age per row. The organisers' update confirms the attached weather must not be used; models use the hourly file observed ≥ 3 h before the scheduled time."],
    ["Critical", "Only about 1% of flights", "ATL has about 9 departures a day in the file against about 1,000 in reality. Hourly arrival rates can't be measured from it.", `Downloaded the full BTS on-time data: ${comma(I.bts_flights)} flights. ${d3.format(".2%")(I.provided_rows_found)} of the provided rows were found in it, with identical delays.`],
    ["Warning", "No wind direction", "Only wind speed is given, so crosswind and tailwind on the runway can't be computed (a brief requirement).", "Now from the organisers' hourly file (31 Oct update). Our wind formula matches theirs exactly. METAR, TAF and LAMP winds are also resolved onto each runway heading."],
    ["Warning", "Sentinel zeros", "Gust is 0 in 98% of rows (no gusts at all in 2023), snow is always 0, condition code 0 is invalid.", "Treated as missing; snow dropped."],
    ["Warning", "Overnight arrivals use the departure date", "Destination weather for overnight flights comes from the wrong day.", "Covered by the true-observation-time fix."],
    ["Note", "Delay causes only filled when ≥ 15 min late", "BTS convention: blank does not mean unknown for on-time flights.", "Filled 0 for completed flights under 15 min; left missing for cancelled or diverted."],
    ["Note", `${d3.sum(d.dropped, g => g.columns.length)} of ${d.report.raw_columns} columns redundant or empty`, "Diversion detail more than 99.7% empty, duplicate IDs, derived fields.", "Dropped, each with a written reason (below)."],
  ];
  v.innerHTML = `
  <div class="grid">
    <div class="card span-12"><div class="eyebrow">The dataset, honestly</div><h1>The provided file, fixed</h1><p class="muted" style="margin-top:4px">What was wrong with it, the evidence, and what we did about each problem.</p>
      <div class="statgrid" style="margin-top:12px">
        <div class="stat"><div class="v">${comma(d.report.raw_rows)}</div><div class="l">rows in the provided file, ${d.report.raw_columns} columns</div></div>
        <div class="stat"><div class="v">${comma(d.report.clean_rows_hubs)}</div><div class="l">touch ATL or DFW (17%)</div></div>
        <div class="stat"><div class="v">${(I.bts_flights / 1e6).toFixed(2)}M</div><div class="l">flights downloaded from BTS (ATL, DFW, ORD)</div></div>
        <div class="stat"><div class="v">${d3.format(".2%")(I.provided_rows_found)}</div><div class="l">of provided rows matched in BTS; delays identical ${pct(I.dep_delay_identical)}</div></div>
      </div></div>
    <div class="card span-7"><div class="eyebrow">Issues found</div>${issues.map(([ic, t, w, fx]) => `<div class="issue"><div class="ic"><span class="pill ${{ Critical: "st-severe", Warning: "st-watch", Note: "st-ok" }[ic]}">${ic}</span></div><div><div class="t">${t}</div><p>${w}</p><div class="fix">Fix: ${fx}</div></div></div>`).join("")}</div>
    <div class="span-5" style="display:flex;flex-direction:column;gap:16px">
      <div class="card"><div class="eyebrow">Evidence · timezone mislabel</div><h2>Mean temperature by the file's "local" hour label</h2><div id="diur"></div>
        <p class="note">Real temperatures bottom out around sunrise and peak mid-afternoon. In the file, LAX is coldest at "13:00" and warmest at "21:00": exactly the 7–8 h UTC offset.</p></div>
      <div class="card"><div class="eyebrow">Evidence · the 1% sample</div><h2>ATL departures per day</h2><div id="samp"></div></div>
    </div>
    <div class="card span-7"><div class="eyebrow">Public data added · all downloaded by scripts/download_data.py</div>
      ${table([
        ["Organisers' hourly weather ATL/DFW (update 31 Oct)", "Challenge (Meteostat / NOAA ISD)", "Main weather input; wind resolved onto runway; joined ≥ 3 h before each scheduled time"],
        ["Meteostat hourly (other airports)", "Meteostat bulk API", "Same weather schema for any ICAO code (e.g. ORD station 72530)"],
        ["BTS On-Time Performance (full)", "US DOT", "AAR label (wheels-on/hour), demand, delay state, aircraft rotation"],
        ["METAR (ASOS) incl. specials", "Iowa Environmental Mesonet", "Conditions at issue time; wind direction → runway components"],
        ["TAF archive", "Iowa Environmental Mesonet", "The official forecast at issue time, incl. TEMPO/PROB30 and amendments"],
        ["LAMP guidance", "NWS MDL via IEM", "Lightning and convection probabilities"],
        ["NOAA Storm Events", "NCEI", "Evaluation only (compiled after the fact)"],
        ["OurAirports runways", "ourairports.com", "Runway heading for any airport"],
        ["Jev readings of 11.5k TAF texts", "TypeSafe (API)", "Typed hazard and severity reading of forecast text"]].map(([a, b, c]) => ({ a, b, c })),
        [{ key: "a", label: "Source" }, { key: "b", label: "Provider" }, { key: "c", label: "Used for" }])}</div>
    <div class="card span-5"><div class="eyebrow">Leakage controls</div>
      <p>• Every forecast row has an issue time <span class="mono">T = target − lead</span>. Inputs are joined <i>as of T</i>, with asserts on TAF issue time, LAMP run time and METAR hour.</p>
      <p>• Real-time features (recent landings, delays, taxi-out) are keyed by when they happened, and only the two complete hours before T are used.</p>
      <p>• An inbound aircraft's delay is used only if it had already departed by T.</p>
      <p>• NOAA Storm Events are for scoring only. Time split: train 2023 → mid-2024, validate H2 2024, <b>test Jan–Jul 2025</b>.</p></div>
    <div class="card span-7"><div class="eyebrow">Comparing airports fairly · rates, never raw delay minutes</div><h2>Jan 2023 – Jul 2025, full BTS data</h2>
      ${table(t.compare, [{ key: "airport", label: "Airport" }, { key: "flights_per_day", label: "Flights/day", fmt: comma }, { key: "disrupted_share", label: "Departures > 45 min / cancelled", fmt: d3.format(".1%") }, { key: "delay_min_per_dep", label: "Delay per departure (min)", fmt: f1 },
        { key: "drop_share", label: "Busy hours with capacity drop", fmt: d3.format(".1%") }, { key: "ts_hours_per_year", label: "Thunderstorm h / year", fmt: comma }])}
      <p class="note">Every comparison between airports is a rate per flight or per busy hour, so a small airport and a hub are on the same scale.</p></div>
    <div class="card span-5"><div class="eyebrow">Why runway direction matters · ${S.airport}, busy hours</div><h2>Landings as % of schedule</h2><div id="wxb"></div>
      <p class="note">Wind is resolved onto the runway heading (ATL 80°, DFW 180°). Raw wind speed hides the tailwind and crosswind hours that cut throughput.</p></div>
    <details class="card span-12"><summary class="eyebrow" style="cursor:pointer">Column decisions for the provided file (${d.report.raw_columns} columns)</summary>
      ${d.dropped.map(g => `<p><b>${esc(g.reason)}</b> <span class="muted">(${g.columns.length})</span><br>${g.columns.slice(0, 14).map(c => `<span class="tagchip">${c}</span>`).join("")}${g.columns.length > 14 ? ` <span class="muted">+${g.columns.length - 14} more</span>` : ""}</p>`).join("")}
      <h3>Kept columns and their role</h3><div class="segs" id="roles"></div><div id="dict" style="margin-top:10px;max-height:380px;overflow:auto"></div></details>
  </div>`;
  hbars($("#wxb"), t.by_weather.sort((a, b) => a.ratio - b.ratio).map(b => ({ label: `${b.wx} (${comma(b.hours)} h)`, value: b.ratio * 100, color: b.wx === "Fair weather" ? COL.muted : COL.blue,
    tip: `${f1(b.ratio * 100)}% of scheduled landed<br>${pct(b.disrupted)} of departures disrupted` })), { fmt: v => f1(v) + "%", labelW: 190, height: 220 });
  const hrs = d.diurnal.hours;
  lines($("#diur"), hrs, [["ATL", COL.blue], ["DFW", COL.orange], ["LAX", COL.aqua]].map(([k, c]) => ({ name: k, color: c, values: d.diurnal[k] })), { yLabel: "°C", xLabel: "hour label in provided file", height: 240, xfmt: h => String(h).padStart(2, "0") });
  const step = 7, idx = d.sample.dates.map((x, i) => i).filter(i => i % step === 0);
  lines($("#samp"), idx.map(i => d.sample.dates[i]), [{ name: "Full BTS", color: COL.blue, values: idx.map(i => d.sample.full[i]), noDots: true },
    { name: "Provided file", color: COL.orange, values: idx.map(i => d.sample.prov[i]), noDots: true }], { yLabel: "departures/day", height: 220, xfmt: s => s.slice(0, 7), yfmt: comma });
  const roles = [...new Set(d.dictionary.map(r => r.role))]; let role = "all";
  const drawDict = () => { $("#roles").innerHTML = ["all", ...roles].map(r => `<button class="${r === role ? "on" : ""}" data-r="${r}">${r}</button>`).join("");
    $("#dict").innerHTML = table(d.dictionary.filter(r => role === "all" || r.role === role), [{ key: "column", label: "Column", fmt: v => `<span class="mono">${v}</span>` }, { key: "role", label: "Role" }, { key: "null_frac", label: "Missing", fmt: pct }, { key: "description", label: "Description" }]); };
  drawDict();
  $("#roles").onclick = e => { const b = e.target.closest("button"); if (b) { role = b.dataset.r; drawDict(); } };
}

/* ================= motion helpers ================= */
function animateIn(root = document) {
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 });
  root.querySelectorAll(".reveal:not(.in)").forEach(el => io.observe(el));
  root.querySelectorAll("[data-count]").forEach(el => {
    const to = +el.dataset.count, fmt = { pct: pct, f2: f2, f1: f1, int: comma }[el.dataset.fmt || "int"]; let t0;
    const tick = t => { t0 ??= t; const k = Math.min(1, (t - t0) / 1100), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(to * e); if (k < 1) requestAnimationFrame(tick); };
    const o2 = new IntersectionObserver(es => { if (es[0].isIntersecting) { requestAnimationFrame(tick); o2.disconnect(); } }); o2.observe(el);
    setTimeout(() => { el.textContent = fmt(to); }, 1600);   // always land on the true value
  });
}

function pipelineSVG(el) {
  const W = el.clientWidth || 1200, H = 150, n = 6, gap = W / n;
  const st = [["DATA", "Flights + hourly weather", "organisers' files · BTS · TAF · LAMP"], ["3-HOUR RULE", "Join as of T", "weather observed ≥ 3 h before"],
    ["FEATURES", "Runway wind · rotation", "head/tail/crosswind · late aircraft"], ["MODEL", "LightGBM + calibration", "P(delay > 45 min) · AAR band"],
    ["RULES", "Fixed, auditable", "GDP · contingency · withhold"], ["HUMAN", "TMC decides", "accept / dismiss · logged"]];
  const cx = i => gap * i + gap / 2;
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="pg" x1="0" x2="1"><stop offset="0" stop-color="#3ee0ff"/><stop offset="1" stop-color="#3987e5"/></linearGradient></defs>`;
  svg += `<path id="pl" d="M ${cx(0)} 52 L ${cx(n - 1)} 52" stroke="#26385a" stroke-width="2" fill="none"/>`;
  svg += `<path d="M ${cx(0)} 52 L ${cx(n - 1)} 52" stroke="url(#pg)" stroke-width="2" fill="none" pathLength="1" class="draw"/>`;
  for (let k = 0; k < 7; k++) svg += `<circle r="3.2" fill="${k % 3 ? "#3ee0ff" : "#3dff8b"}"><animateMotion dur="${5 + (k % 3)}s" begin="${k * 0.7}s" repeatCount="indefinite" path="M ${cx(0)} 52 L ${cx(n - 1)} 52"/></circle>`;
  st.forEach(([k, t, d], i) => {
    const col = i === 3 ? "#3ee0ff" : i === 5 ? "#3dff8b" : "#9fb3d6";
    svg += `<g class="pnode"><circle cx="${cx(i)}" cy="52" r="20" fill="#0f1b31" stroke="${col}" stroke-width="1.6"/>
      <circle cx="${cx(i)}" cy="52" r="20" fill="none" stroke="${col}" opacity=".5"><animate attributeName="r" values="20;30;20" dur="3s" begin="${i * 0.5}s" repeatCount="indefinite"/><animate attributeName="opacity" values=".5;0;.5" dur="3s" begin="${i * 0.5}s" repeatCount="indefinite"/></circle>
      <text x="${cx(i)}" y="56" text-anchor="middle" style="fill:${col};font:700 11px JetBrains Mono">${i + 1}</text>
      <text x="${cx(i)}" y="16" text-anchor="middle" style="fill:#7d8ba5;font:600 10px JetBrains Mono;letter-spacing:.12em">${k}</text>
      <text x="${cx(i)}" y="96" text-anchor="middle" style="fill:#eef3fb;font:600 13px Inter">${t}</text>
      <text x="${cx(i)}" y="114" text-anchor="middle" style="fill:#7d8ba5;font:11.5px Inter">${d}</text></g>`;
  });
  el.innerHTML = svg + "</svg>";
}

/* front page: see front.js */

/* ================= TRY THE MODEL ================= */
async function tryPage(v) {
  const hubs = S.meta.airports.map(a => a.icao.slice(1));
  v.innerHTML = `
  <div class="card reveal" style="padding:24px 26px"><div class="eyebrow">Test the model with your own data</div>
    <h1 style="margin:2px 0 6px">Upload flights → get each one's risk of a &gt; 45-min delay</h1>
    <p class="lead-s">Use the organisers' format (<span class="mono">Flight_Data_With_Weather_Final.csv</span>) or BTS format. The same pipeline as the dashboard runs on your rows: time zones → weather observed ≥ 3 h before → features → LightGBM → reasons. If your file has <span class="mono">DEP_DELAY</span>/<span class="mono">ARR_DELAY</span>, you also get precision and recall.</p></div>
  <div class="grid" style="margin-top:16px">
    <div class="card span-7 reveal">
      <div class="drop" id="drop"><div class="big">⇪ Drop a CSV here or click to choose</div><div class="note" style="margin-top:6px">Needs: FL_DATE, OP_UNIQUE_CARRIER, OP_CARRIER_FL_NUM, ORIGIN, DEST, CRS_DEP_TIME (+ CRS_ELAPSED_TIME or CRS_ARR_TIME). Flights touching ${hubs.join(", ")}; dates 2023 – Jul 2025.</div>
        <input type="file" id="file" accept=".csv,text/csv" style="display:none"></div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">
        <button class="btn primary" id="sample">Use 300 rows of the organisers' file</button>
        <a class="btn" href="/api/sample_csv?n=300" download="sample_flights.csv" style="text-decoration:none">⤓ Download that sample / template</a>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px;margin-left:auto">Predict <input type="range" id="tlead" min="3" max="12" value="6" style="width:120px"> <b class="mono" id="tleadv">6 h</b> ahead</label>
      </div>
      <div class="steps" id="steps">${[["1 PARSE", "Validate columns"], ["2 TIME", "Local → UTC"], ["3 WEATHER", "Join ≥ 3 h before"], ["4 FEATURES", "Wind · rotation · TAF"], ["5 MODEL", "LightGBM + calibration"], ["6 EXPLAIN", "Top reasons"]]
        .map(([k, b]) => `<div class="step"><span class="k">${k}</span><b>${b}</b><span class="t"></span></div>`).join("")}</div>
      <div id="tres"><p class="note">Results appear here. Nothing is stored.</p></div>
    </div>
    <div class="card span-5 reveal d1"><div class="eyebrow">Or score a single flight</div>
      <div class="formgrid">
        <label class="field">From<input id="o" value="ATL"></label><label class="field">To<input id="d" value="LGA"></label>
        <label class="field">Date (local)<input id="dt" type="date" value="2025-06-27" min="2023-01-02" max="2025-07-31"></label><label class="field">Departure (local)<input id="tm" type="time" value="19:00"></label>
        <label class="field">Airline<input id="cr" value="DL"></label><label class="field">Hours ahead<select id="ld">${[3, 4, 5, 6, 8, 10, 12].map(k => `<option ${k === 6 ? "selected" : ""}>${k}</option>`).join("")}</select></label>
      </div>
      <button class="btn primary" id="one" style="margin-top:12px;width:100%">Predict</button>
      <div id="oneres"></div>
      <p class="note" style="margin-top:12px">From the command line: <span class="mono">python scripts/predict.py your.csv --lead 6</span></p></div>
  </div>`;
  animateIn(v);
  $("#tlead").oninput = e => $("#tleadv").textContent = e.target.value + " h";
  const drop = $("#drop"), fileIn = $("#file");
  drop.onclick = () => fileIn.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) f.text().then(t => run(t, f.name)); };
  fileIn.onchange = () => { const f = fileIn.files[0]; if (f) f.text().then(t => run(t, f.name)); };
  $("#sample").onclick = async () => run(await (await fetch("/api/sample_csv?n=300")).text(), "organisers' sample (300 rows)");
  if (S.autoSample) { S.autoSample = false; $("#sample").click(); }
  async function run(text, name) {
    const steps = [...document.querySelectorAll("#steps .step")];
    steps.forEach(s => s.className = "step"); let k = 0;
    const timer = setInterval(() => { if (k > 0) steps[k - 1].className = "step done"; if (k < steps.length) steps[k].className = "step run"; k = Math.min(k + 1, steps.length - 1); }, 350);
    $("#tres").innerHTML = `<p class="note">Running on ${esc(name)}…</p>`;
    let r;
    try { const res = await fetch(`/api/predict?lead=${$("#tlead").value}`, { method: "POST", body: text, headers: { "Content-Type": "text/csv" } });
      r = await res.json(); if (!res.ok) throw new Error(r.detail); }
    catch (e) { clearInterval(timer); steps.forEach(s => s.className = "step"); $("#tres").innerHTML = `<div class="banner">⊘ ${esc(e.message)}</div>`; return; }
    clearInterval(timer); steps.forEach(s => s.className = "step done");
    const m = r.summary;
    const has = m.precision != null;
    $("#tres").innerHTML = `
      <div class="statgrid" style="grid-template-columns:repeat(${has ? 4 : 2},1fr)">
        <div class="stat"><div class="v" data-count="${m.scored || 0}">0</div><div class="l">flight-ends scored in ${r.seconds}s (${r.input_rows} rows in)</div></div>
        <div class="stat"><div class="v" data-count="${m.flagged || 0}">0</div><div class="l">flagged likely &gt; 45 min late (threshold ${f2(m.threshold || 0)})</div></div>
        ${has ? `<div class="stat"><div class="v"><span data-count="${m.precision}" data-fmt="pct">0</span> / <span data-count="${m.recall}" data-fmt="pct">0</span></div><div class="l">precision / recall on your labelled 2025 rows (${m.labelled}, base rate ${pct(m.base_rate)})</div></div>
        <div class="stat"><div class="v" data-count="${m.pr_auc}" data-fmt="f2">0</div><div class="l">PR-AUC · ROC-AUC ${f2(m.roc_auc)}</div></div>` : ""}
      </div>
      ${r.notes.length ? `<div class="banner" style="margin-top:10px">${r.notes.map(esc).join("<br>")}</div>` : ""}
      <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 6px"><h3 style="margin:0">Highest-risk flights</h3><button class="btn" id="dl">⤓ Download all predictions (CSV)</button></div>
      ${table(r.rows.slice(0, 25), [{ key: "flight", label: "Flight" }, { key: "direction", label: "Dir" }, { key: "route", label: "Route" }, { key: "sched_utc", label: "Scheduled (UTC)" },
        { key: "p_delay_gt45", label: "P(>45 min)", fmt: (x, row) => `<div style="display:flex;gap:6px;align-items:center"><div class="riskbar" style="width:70px"><i style="width:${x * 100}%;background:${row.flag_gt45 ? COL.critical : COL.warning}"></i></div>${pct(x)}</div>` },
        { key: "top_reasons", label: "Top reasons", fmt: x => `<span class="note">${esc(x)}</span>` },
        { key: "actual_delay", label: "Actual", fmt: x => x == null ? "–" : (x > 45 ? `<b style="color:${COL.serious}">+${Math.round(x)}</b>` : Math.round(x)) }])}`;
    animateIn($("#tres"));
    $("#dl").onclick = () => { const cols = Object.keys(r.rows[0] || {}); const csv = [cols.join(",")].concat(r.rows.map(x => cols.map(c => JSON.stringify(x[c] ?? "")).join(","))).join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "predictions.csv"; a.click(); };
  }
  $("#one").onclick = async () => {
    $("#oneres").innerHTML = `<div class="shimmer"></div>`;
    try {
      const r = await api("predict_one", { origin: $("#o").value, dest: $("#d").value, date: $("#dt").value, dep_time: $("#tm").value, carrier: $("#cr").value, lead: $("#ld").value });
      $("#oneres").innerHTML = r.rows.map(x => `<div class="gauge"><svg width="120" height="70" viewBox="0 0 120 70"><path d="M10 64 A50 50 0 0 1 110 64" stroke="#26385a" stroke-width="10" fill="none" stroke-linecap="round"/>
        <path d="M10 64 A50 50 0 0 1 110 64" stroke="${x.flag_gt45 ? COL.critical : x.p_delay_gt45 > 0.12 ? COL.warning : COL.good}" stroke-width="10" fill="none" stroke-linecap="round" pathLength="1" stroke-dasharray="${x.p_delay_gt45} 1" class="drawg"/>
        <text x="60" y="58" text-anchor="middle" style="fill:#eef3fb;font:700 20px Space Grotesk">${pct(x.p_delay_gt45)}</text></svg>
        <div><b>${x.flight} ${x.route}</b> (${x.direction} at ${x.hub})<br><span class="note">${x.flag_gt45 ? "Flagged: likely > 45 min late" : "Not flagged"} · forecast issued ${x.forecast_issued_utc}</span><br><span class="note">${esc(x.top_reasons)}</span></div></div>`).join("")
        + (r.notes.length ? `<p class="note">${r.notes.map(esc).join(" · ")}</p>` : "");
    } catch (e) { $("#oneres").innerHTML = `<div class="banner">⊘ ${esc(e.message)}</div>`; }
  };
}

function downloadBriefing(o) {
  const L = [];
  L.push(`# Arrival capacity briefing: ${o.airport} (${o.name})`, "",
    `- Issued: ${o.issue_local} local (${o.issue_utc})`, `- Model version: ${o.model_version} · runway heading ${o.heading}°`,
    `- METAR used: ${o.metar_hour}`, `- Generated: ${new Date().toISOString()}`, "",
    "| Hour (local) | Lead | Scheduled | Forecast | 80% band | Status | TAF (worst) | TAF issued | LAMP run | LAMP lightning |", "|---|---|---|---|---|---|---|---|---|---|");
  o.hours.forEach(h => L.push(`| ${h.label} | ${h.lead} h | ${h.sched} | ${h.withheld ? "withheld" : Math.round(h.pred)} | ${h.withheld ? "–" : Math.round(h.lo) + "–" + Math.round(h.hi)} | ${STATUS[h.status][2]} | ${h.taf_class} | ${h.taf_issue ?? "–"} | ${h.lamp_run ?? "–"} | ${h.lamp_ltg ?? "–"}% |`));
  L.push("", "## Recommendations (fixed rules)");
  o.recommendations.forEach(r => L.push(`- **${r.title}**: ${r.body}  \n  _Rule:_ ${r.trigger}`));
  if (S.lastJev && S.lastJev.ok) L.push("", "## Jev reading of the TAF (text only)", `- Main hazard: ${S.lastJev.hazard.choice} (${pct(S.lastJev.hazard.confidence)} confidence) · implied impact score ${f2(S.lastJev.severity.score)}/3 · model ${S.lastJev.model}`);
  L.push("", "## TAF groups in force", ...o.hours.map(h => `- ${h.label}: ${h.taf_raw ?? "none"}${h.ovl_raw ? " + " + h.ovl_raw : ""}`),
    "", "_Decision support only. Numbers come from statistical models and fixed rules; the traffic manager decides._");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([L.join("\n")], { type: "text/markdown" }));
  a.download = `briefing_${o.airport}_${S.date}_${String(S.hour).padStart(2, "0")}00.md`; a.click();
}

/* ---------------- boot ---------------- */
(async () => {
  S.meta = await api("meta");
  readHash();
  bindChrome();
  go();
})();
