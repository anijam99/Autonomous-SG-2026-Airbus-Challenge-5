/* Front page: the system in one picture. Four columns, one line per box, one accent colour. */
function flowDiagram(m) {
  const N = {}, nodes = [], edges = [];
  const node = (id, x, y, w, h, title, sub, opt = {}) => { N[id] = { x, y, w, h }; nodes.push({ id, x, y, w, h, title, sub, ...opt }); };
  const edge = (a, b, opt = {}) => edges.push({ a, b, ...opt });

  // data in
  node("bts", 20, 50, 250, 76, "Flight records", `${m.flights} million flights (US DOT)`);
  node("wx", 20, 146, 250, 76, "Weather reports", "hourly, from each airport");
  node("fc", 20, 242, 250, 76, "Weather forecasts", "TAF and LAMP, as issued");
  // only what was known
  node("feat", 350, 98, 270, 172, "Only what was known", "", { lines: ["forecast made 3–12 h before", "departure; anything newer", "is refused"] });
  // models
  node("risk", 700, 50, 250, 112, "Delay model", "", { lines: ["chance each flight runs", "45 minutes late"] });
  node("aar", 700, 206, 250, 112, "Capacity model", "", { lines: ["landings per hour,", "with a range"] });
  // people decide
  node("tmc", 1030, 128, 190, 112, "Traffic manager", "", { lines: ["accepts or", "dismisses"], strong: true });

  ["bts", "wx", "fc"].forEach(s => edge(s, "feat"));
  edge("feat", "risk"); edge("feat", "aar"); edge("risk", "tmc"); edge("aar", "tmc");

  const path = e => {
    const A = N[e.a], B = N[e.b];
    const x1 = A.x + A.w, y1 = A.y + A.h / 2, x2 = B.x, y2 = Math.min(Math.max(y1, B.y + 24), B.y + B.h - 24);
    return `M${x1},${y1} C${x1 + 45},${y1} ${x2 - 45},${y2} ${x2},${y2}`;
  };
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const E = edges.map((e, i) => { const d = path(e);
    return `<path d="${d}" class="fl-line"/><path d="${d}" class="fl-flow" style="animation-delay:${-(i * 0.37) % 2}s"/>`; }).join("");
  const V = nodes.map(n => {
    const lines = (n.lines || [n.sub]).map((l, i) => `<text x="${n.x + 20}" y="${n.y + 58 + i * 22}" class="fl-sub">${esc(l)}</text>`).join("");
    return `<g class="fl-node${n.strong ? " strong" : ""}"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" class="fl-box"/>
      <text x="${n.x + 20}" y="${n.y + 32}" class="fl-title">${esc(n.title)}</text>${lines}</g>`; }).join("");
  const cols = [["Data in", 20], ["No peeking ahead", 350], ["Models", 700], ["Decision", 1030]]
    .map(([t, x]) => `<text x="${x}" y="22" class="fl-col">${t}</text>`).join("");
  return `<div class="fl-scroll"><svg class="fl-svg" viewBox="0 0 1240 340" role="img" aria-label="Flight records, weather reports and forecasts feed a step that keeps only what was known at forecast time. A delay model and a capacity model use it; a traffic manager accepts or dismisses what they suggest.">
    ${cols}${E}${V}</svg></div>
  <ol class="fl-list">
    <li><b>Data in</b>${m.flights} million flight records, hourly weather reports, and the TAF and LAMP forecasts as issued.</li>
    <li><b>No peeking ahead</b>The forecast is made 3 to 12 hours before departure. Anything newer is refused.</li>
    <li><b>Models</b>One gives each flight's chance of a 45-minute delay; one gives landings per hour, with a range.</li>
    <li class="strong"><b>Decision</b>A traffic manager accepts or dismisses each suggestion.</li></ol>`;
}
