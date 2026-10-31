/* Front page: animated system-flow diagram (SVG). Pure layout; numbers are passed in from live metrics. */
function flowDiagram(m) {
  const C = { cyan: "#3ee0ff", gold: "#c9a45a", green: "#3dff8b", magenta: "#ff4fd8", amber: "#ffb84d", mute: "#6f6a64" };
  const N = {}, nodes = [], edges = [];
  const node = (id, x, y, w, h, title, lines, col, opt = {}) => { N[id] = { x, y, w, h }; nodes.push({ id, x, y, w, h, title, lines, col, ...opt }); };
  const edge = (a, b, col, opt = {}) => edges.push({ a, b, col, ...opt });

  // column 1: sources
  const src = [["bts", "BTS on-time data", `${m.flights}M flights, aircraft rotation`],
               ["wx", "Organisers' hourly weather", "observed ≥ 3 h before"],
               ["metar", "METAR", "conditions at forecast time"],
               ["taf", "TAF", "official forecast in force"],
               ["lamp", "LAMP", "lightning & convection odds"],
               ["noaa", "NOAA Storm Events", "scoring only, never an input"]];
  src.forEach(([id, t, s], i) => node(id, 20, 40 + i * 84, 240, 64, t, [s], id === "noaa" ? C.mute : C.cyan, { dashed: id === "noaa" }));
  // column 2: the leak-free builder + Jev
  node("jev", 340, 40, 250, 76, "Jev reads the TAF text", ["typed hazard & severity", "never computes a number"], C.magenta);
  node("feat", 340, 160, 250, 220, "As-of feature builder", ["T = scheduled time − lead", "lead 3 to 12 h", "every input checked ≤ T", "wind → head / tail / cross", "on runway 08 (ATL), 18 (DFW)", "rates, never raw minutes"], C.cyan, { big: true });
  // column 3: models
  node("risk", 670, 120, 250, 104, "LightGBM · flight risk", ["P(delay > 45 min), calibrated", `PR-AUC ${m.prauc} · recall ${m.recall}`, "main target"], C.gold, { big: true });
  node("aar", 670, 268, 250, 104, "LightGBM · capacity", ["landings per hour + 80% band", `RMSE ${m.rmse} landings/h`, "bonus target"], C.cyan);
  // column 4: rules → human
  node("rules", 1000, 120, 220, 104, "Fixed rules", ["GDP · contingency · convective", "runway wind · withhold", "each shows its trigger"], C.amber);
  node("tmc", 1000, 268, 220, 104, "Traffic manager decides", ["accept or dismiss", "logged, briefing export"], C.green, { big: true });
  // evaluation strip
  node("eval", 340, 448, 880, 72, "Tested where it can fail", [`2025 never seen · Chicago O'Hare never trained on · ${m.mc} Monte Carlo refits · bootstrap intervals · worst miss shown`], C.mute, { wide: true });

  ["bts", "wx", "metar", "lamp"].forEach(s => edge(s, "feat", C.cyan));
  edge("taf", "feat", C.cyan); edge("taf", "jev", C.magenta); edge("jev", "feat", C.magenta, { down: true });
  edge("feat", "risk", C.gold); edge("feat", "aar", C.cyan);
  edge("risk", "rules", C.gold); edge("aar", "rules", C.cyan); edge("rules", "tmc", C.green, { down: true });
  edge("noaa", "eval", C.mute, { dashed: true, bottom: true }); edge("risk", "eval", C.mute, { dashed: true, toTop: true }); edge("aar", "eval", C.mute, { dashed: true, toTop: true });

  const path = e => {
    const A = N[e.a], B = N[e.b];
    if (e.down) { const x = A.x + A.w / 2, y1 = A.y + A.h, y2 = B.y; return `M${x},${y1} L${x},${y2}`; }
    if (e.bottom) { const x1 = A.x + A.w, y1 = A.y + A.h / 2, x2 = B.x, y2 = B.y + B.h / 2; return `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 60},${y2} ${x2},${y2}`; }
    if (e.toTop) { const x1 = A.x + A.w / 2, y1 = A.y + A.h, x2 = x1, y2 = B.y; return `M${x1},${y1} L${x2},${y2}`; }
    const x1 = A.x + A.w, y1 = A.y + A.h / 2, x2 = B.x, y2 = Math.min(Math.max(y1, B.y + 18), B.y + B.h - 18);
    return `M${x1},${y1} C${x1 + 45},${y1} ${x2 - 45},${y2} ${x2},${y2}`;
  };
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const E = edges.map((e, i) => { const d = path(e);
    return `<path d="${d}" class="fl-line${e.dashed ? " dash" : ""}" stroke="${e.col}"/>` +
      (e.dashed ? "" : `<path d="${d}" class="fl-flow" stroke="${e.col}" style="animation-delay:${-(i * 0.37) % 2}s"/>
      <circle r="3.2" fill="${e.col}" class="fl-dot"><animateMotion dur="${2.4 + (i % 4) * 0.35}s" begin="${-(i * 0.6)}s" repeatCount="indefinite" path="${d}"/></circle>`); }).join("");
  const V = nodes.map(n => {
    const lines = n.lines.map((l, i) => `<text x="${n.x + 16}" y="${n.y + 46 + i * 19}" class="fl-sub">${esc(l)}</text>`).join("");
    return `<g class="fl-node${n.big ? " big" : ""}">
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" class="fl-box${n.dashed ? " dash" : ""}" stroke="${n.col}"/>
      <rect x="${n.x}" y="${n.y}" width="4" height="${n.h}" fill="${n.col}"/>
      <text x="${n.x + 16}" y="${n.y + 26}" class="fl-title" fill="${n.big ? n.col : "#fff"}">${esc(n.title)}</text>${lines}</g>`; }).join("");
  const cols = [["data in", 20], ["no leakage", 340], ["statistics", 670], ["people decide", 1000]]
    .map(([t, x]) => `<text x="${x}" y="20" class="fl-col">${t}</text>`).join("");
  return `<div class="fl-scroll"><svg class="fl-svg" viewBox="0 0 1240 540" role="img" aria-label="System flow: public data sources feed a leak-free feature builder; LightGBM models forecast flight delay risk and arrival capacity; fixed rules turn forecasts into suggestions; the traffic manager accepts or dismisses each one. Evaluation runs on 2025 data, an unseen airport and Monte Carlo refits.">
    ${cols}${E}${V}</svg></div>`;
}
