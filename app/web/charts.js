/* Small d3 chart kit for the dashboard. Every chart has a legend (>= 2 series) and a hover tooltip. */
const COL = { blue: "#3987e5", orange: "#d95926", aqua: "#199e70", yellow: "#c98500", violet: "#c9a45a", red: "#e66767",
  muted: "#898781", grid: "#241f1a", base: "#3a332b", ink: "#f0efec", ink2: "#c3c2b7", sched: "#3a332b",
  good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };
const STATUS = { ok: [COL.good, "●", "Normal"], watch: [COL.warning, "▲", "Watch"], reduced: [COL.serious, "◆", "Reduced"],
  severe: [COL.critical, "■", "Severe"], withheld: [COL.muted, "⊘", "Withheld"] };

const tip = {
  el: () => document.getElementById("tip"),
  show(html, ev) { const t = this.el(); t.innerHTML = html; t.style.display = "block"; this.move(ev); },
  move(ev) { const t = this.el(); const x = Math.min(ev.clientX + 14, innerWidth - t.offsetWidth - 10);
    t.style.left = x + "px"; t.style.top = (ev.clientY + 14) + "px"; },
  hide() { this.el().style.display = "none"; },
};

function frame(el, height, m = { t: 14, r: 16, b: 34, l: 44 }) {
  el.innerHTML = "";
  const width = el.clientWidth || 600;
  const svg = d3.select(el).append("svg").attr("width", width).attr("height", height);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), w: width - m.l - m.r, h: height - m.t - m.b, m };
}

function legend(el, items) {
  const d = document.createElement("div"); d.className = "legend";
  d.innerHTML = items.map(([name, color, kind = "line"]) =>
    `<span><i class="${kind}" style="background:${color}"></i>${name}</span>`).join("");
  el.prepend(d);
}

/* Capacity chart: schedule bars, 80% band, forecast line, actual diamonds, status marks. */
function capacityChart(el, hours, { reveal, selected, onSelect }) {
  const H = 300; const f = frame(el, H, { t: 26, r: 14, b: 30, l: 40 });
  const x = d3.scaleBand().domain(hours.map(d => d.label)).range([0, f.w]).padding(0.28);
  const ymax = d3.max(hours, d => Math.max(d.sched, d.hi || 0, reveal ? d.actual || 0 : 0)) * 1.12;
  const y = d3.scaleLinear().domain([0, ymax]).nice().range([f.h, 0]);
  f.g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-f.w).tickFormat("")).select(".domain").remove();
  f.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5)).select(".domain").remove();
  f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.h})`).call(d3.axisBottom(x).tickSizeOuter(0));
  const cx = d => x(d.label) + x.bandwidth() / 2;
  f.g.selectAll(".sb").data(hours).join("rect").attr("x", d => x(d.label)).attr("width", x.bandwidth())
    .attr("y", f.h).attr("height", 0).attr("rx", 4).attr("fill", COL.sched)
    .attr("stroke", d => d.label === selected ? COL.blue : "none").attr("stroke-width", 2)
    .transition().duration(700).delay((d, i) => i * 40).attr("y", d => y(d.sched)).attr("height", d => f.h - y(d.sched));
  const ok = d => !d.withheld;
  const area = d3.area().defined(ok).x(cx).y0(d => y(d.lo)).y1(d => y(d.hi)).curve(d3.curveMonotoneX);
  f.g.append("path").datum(hours).attr("d", area).attr("fill", COL.blue).attr("opacity", 0.22);
  f.g.append("path").datum(hours.filter(d => d.typical != null)).attr("d", d3.line().x(cx).y(d => y(d.typical)).curve(d3.curveMonotoneX))
    .attr("fill", "none").attr("stroke", COL.ink2).attr("stroke-width", 1.5).attr("stroke-dasharray", "2 4");
  f.g.append("path").datum(hours).attr("d", d3.line().defined(ok).x(cx).y(d => y(d.pred)).curve(d3.curveMonotoneX))
    .attr("fill", "none").attr("stroke", COL.blue).attr("stroke-width", 2.5).attr("pathLength", 1).attr("class", "draw");
  f.g.selectAll(".wh").data(hours.filter(d => d.withheld)).join("text").attr("x", cx).attr("y", f.h - 8).attr("text-anchor", "middle")
    .style("fill", COL.ink2).style("font-size", "10px").text("withheld");
  f.g.selectAll(".pp").data(hours.filter(ok)).join("circle").attr("cx", cx).attr("cy", d => y(d.pred)).attr("r", 4.5)
    .attr("fill", COL.blue).attr("stroke", "#0a1324").attr("stroke-width", 2);
  if (reveal) f.g.selectAll(".ac").data(hours).join("path")
    .attr("d", d3.symbol(d3.symbolDiamond, 90)).attr("transform", d => `translate(${cx(d)},${y(d.actual)})`)
    .attr("fill", COL.orange).attr("stroke", "#0a1324").attr("stroke-width", 2);
  f.g.selectAll(".sm").data(hours.filter(d => d.status !== "ok")).join("text").attr("x", cx).attr("y", -8)
    .attr("text-anchor", "middle").style("fill", d => STATUS[d.status][0]).style("font-size", "13px").text(d => STATUS[d.status][1]);
  f.g.selectAll(".hit").data(hours).join("rect").attr("x", d => x(d.label) - x.step() * x.paddingInner() / 2).attr("width", x.step())
    .attr("y", -20).attr("height", f.h + 20).attr("fill", "transparent").style("cursor", "pointer")
    .on("mousemove", (ev, d) => tip.show(`<b>${d.label} local</b> · ${d.lead} h ahead<br>Scheduled <b>${d.sched}</b><br>
      ${d.withheld ? `<b>Forecast withheld</b>: TAF ${d.taf_age == null ? "missing" : d.taf_age + " h old"}` : `Forecast <b>${Math.round(d.pred)}</b> (80% band ${Math.round(d.lo)}–${Math.round(d.hi)})`}
      <br>Typical for this hour: ${d.typical == null ? "–" : Math.round(d.typical)}` +
      (reveal ? `<br>Actually landed <b>${d.actual}</b>` : "") + `<br>${STATUS[d.status][1]} ${STATUS[d.status][2]} · TAF ${d.taf_class}`, ev))
    .on("mouseleave", () => tip.hide()).on("click", (ev, d) => onSelect && onSelect(d.label));
  legend(el, [["Scheduled arrivals", COL.sched, "box"], ["Forecast landings (AAR proxy)", COL.blue], ["80% band", "rgba(57,135,229,0.35)", "box"], ["Typical for this hour (2023–24)", COL.ink2]]
    .concat(reveal ? [["Actually landed", COL.orange, "dia"]] : []));
}

/* Runway + wind dial */
function windDial(el, wind, heading, maxfc) {
  el.innerHTML = "";
  const S = 240, R = 92, c = 112;
  const svg = d3.select(el).append("svg").attr("width", S).attr("height", S).attr("viewBox", `0 0 ${S} ${S}`);
  svg.append("circle").attr("cx", c).attr("cy", c).attr("r", R).attr("fill", "#120f0c").attr("stroke", COL.base);
  for (let a = 0; a < 360; a += 10) {
    const r1 = a % 30 === 0 ? R - 10 : R - 5, rad = (a - 90) * Math.PI / 180;
    svg.append("line").attr("x1", c + r1 * Math.cos(rad)).attr("y1", c + r1 * Math.sin(rad))
      .attr("x2", c + R * Math.cos(rad)).attr("y2", c + R * Math.sin(rad)).attr("stroke", a % 90 === 0 ? COL.ink2 : COL.base);
  }
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([t, a]) => {
    const rad = (a - 90) * Math.PI / 180;
    svg.append("text").attr("x", c + (R + 12) * Math.cos(rad)).attr("y", c + (R + 12) * Math.sin(rad) + 4)
      .attr("text-anchor", "middle").style("fill", COL.ink2).style("font-weight", 600).text(t);
  });
  const rw = svg.append("g").attr("transform", `rotate(${heading} ${c} ${c})`);
  rw.append("rect").attr("x", c - 9).attr("y", c - R + 16).attr("width", 18).attr("height", 2 * R - 32).attr("rx", 2).attr("fill", "#2f2f2c").attr("stroke", COL.ink2).attr("stroke-width", 0.6);
  for (let i = -3; i <= 3; i++) rw.append("rect").attr("x", c - 0.8).attr("y", c + i * 16 - 5).attr("width", 1.6).attr("height", 9).attr("fill", COL.ink);
  const num = h => String(Math.round(h / 10) % 36 || 36).padStart(2, "0");
  rw.append("text").attr("x", c).attr("y", c + R - 22).attr("text-anchor", "middle").style("fill", COL.ink).style("font-family", "var(--mono)").style("font-size", "10px").text(num(heading));
  rw.append("text").attr("x", c).attr("y", c - R + 30).attr("text-anchor", "middle").attr("transform", `rotate(180 ${c} ${c - R + 27})`).style("fill", COL.ink).style("font-family", "var(--mono)").style("font-size", "10px").text(num(heading + 180));
  // heading arrow (direction of landing)
  rw.append("path").attr("d", `M${c},${c - R + 4} l-5,9 h10 z`).attr("fill", COL.blue);
  if (wind && wind.speed > 0 && wind.dir != null) {
    const rad = (wind.dir - 90) * Math.PI / 180, L = Math.min(R - 6, 28 + wind.speed * 2.6);
    const x1 = c + (R - 2) * Math.cos(rad), y1 = c + (R - 2) * Math.sin(rad);
    const x2 = c + (R - 2 - L) * Math.cos(rad), y2 = c + (R - 2 - L) * Math.sin(rad);
    svg.append("defs").html(`<marker id="ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${COL.yellow}"/></marker>`);
    svg.append("line").attr("x1", x1).attr("y1", y1).attr("x2", x2).attr("y2", y2).attr("stroke", COL.yellow).attr("stroke-width", 3.5).attr("marker-end", "url(#ah)");
  }
  svg.append("rect").attr("x", c - 46).attr("y", S - 22).attr("width", 92).attr("height", 18).attr("rx", 9).attr("fill", "#0b0c0c").attr("stroke", COL.base);
  svg.append("text").attr("x", c).attr("y", S - 9).attr("text-anchor", "middle").style("fill", COL.ink).style("font-family", "var(--mono)").style("font-size", "11px")
    .text(wind && wind.speed != null ? (wind.speed === 0 ? "CALM" : `${wind.dir == null ? "VRB " : String(Math.round(wind.dir)).padStart(3, "0") + "°/"}${Math.round(wind.speed)}${wind.gust && wind.gust > wind.speed ? "G" + Math.round(wind.gust) : ""}kt`) : "no obs");
}

function hbars(el, rows, { color = COL.blue, fmt = d3.format(".1f"), height, diverging = false, labelW = 230 } = {}) {
  const H = height || Math.max(120, rows.length * 28 + 30);
  const f = frame(el, H, { t: 6, r: 50, b: 22, l: labelW });
  const ext = d3.extent(rows.map(r => r.value).concat([0]));
  const x = d3.scaleLinear().domain(diverging ? [-d3.max(ext.map(Math.abs)), d3.max(ext.map(Math.abs))] : [0, ext[1]]).nice().range([0, f.w]);
  const y = d3.scaleBand().domain(rows.map(r => r.label)).range([0, f.h]).padding(0.3);
  f.g.append("g").attr("class", "gridline").attr("transform", `translate(0,${f.h})`).call(d3.axisBottom(x).ticks(5).tickSize(-f.h).tickFormat("")).select(".domain").remove();
  f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.h})`).call(d3.axisBottom(x).ticks(5)).select(".domain").remove();
  f.g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickSize(0)).select(".domain").remove();
  f.g.selectAll(".axis text").style("fill", COL.ink2).style("font-size", "11.5px");
  f.g.selectAll(".b").data(rows).join("rect").attr("y", d => y(d.label)).attr("height", y.bandwidth())
    .attr("x", x(0)).attr("width", 0).attr("rx", 3)
    .attr("fill", d => d.color || (diverging ? (d.value >= 0 ? COL.blue : COL.orange) : color))
    .on("mousemove", (ev, d) => tip.show(`<b>${d.label}</b><br>${d.tip || fmt(d.value)}`, ev)).on("mouseleave", () => tip.hide())
    .transition().duration(800).delay((d, i) => i * 50).attr("x", d => x(Math.min(0, d.value))).attr("width", d => Math.abs(x(d.value) - x(0)));
  f.g.selectAll(".v").data(rows).join("text").attr("y", d => y(d.label) + y.bandwidth() / 2 + 4)
    .attr("x", d => d.value >= 0 ? x(d.value) + 5 : x(d.value) - 5).attr("text-anchor", d => d.value >= 0 ? "start" : "end")
    .style("fill", COL.ink2).text(d => fmt(d.value));
  if (diverging) f.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", f.h).attr("stroke", COL.ink2);
}

function lines(el, xs, series, { yLabel = "", xLabel = "", height = 260, yfmt = d3.format(".1f"), xfmt = d => d, ymin = null } = {}) {
  const f = frame(el, height, { t: 10, r: 18, b: 40, l: 48 });
  const x = d3.scalePoint().domain(xs).range([0, f.w]).padding(0.3);
  const all = series.flatMap(s => s.values).filter(v => v != null);
  const y = d3.scaleLinear().domain([ymin ?? Math.min(0, d3.min(all)), d3.max(all) * 1.08]).nice().range([f.h, 0]);
  f.g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-f.w).tickFormat("")).select(".domain").remove();
  f.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5)).select(".domain").remove();
  const ax = f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.h})`).call(d3.axisBottom(x).tickFormat(xfmt));
  const step = Math.ceil(xs.length / Math.max(2, Math.floor(f.w / 70))); ax.selectAll(".tick").attr("opacity", (d, i) => i % step ? 0 : 1);
  f.svg.append("text").attr("x", f.m.l).attr("y", height - 4).text(xLabel);
  f.svg.append("text").attr("transform", "rotate(-90)").attr("x", -f.m.t - f.h / 2).attr("y", 12).attr("text-anchor", "middle").text(yLabel);
  series.forEach(s => {
    const pts = xs.map((xv, i) => [xv, s.values[i]]).filter(p => p[1] != null);
    f.g.append("path").datum(pts).attr("d", d3.line().x(p => x(p[0])).y(p => y(p[1]))).attr("fill", "none")
      .attr("stroke", s.color).attr("stroke-width", s.width || 2).attr("stroke-dasharray", s.dash || null)
      .attr("pathLength", s.dash ? null : 1).attr("class", s.dash ? null : "draw");
    if (!s.noDots) f.g.selectAll(null).data(pts).join("circle").attr("cx", p => x(p[0])).attr("cy", p => y(p[1])).attr("r", 4).attr("fill", s.color).attr("stroke", "#0a1324").attr("stroke-width", 1.5);
  });
  const hl = f.g.append("line").attr("y1", 0).attr("y2", f.h).attr("stroke", COL.ink2).attr("opacity", 0);
  f.g.append("rect").attr("width", f.w).attr("height", f.h).attr("fill", "transparent")
    .on("mousemove", ev => {
      const [mx] = d3.pointer(ev); const i = Math.max(0, Math.min(xs.length - 1, Math.round((mx - x(xs[0])) / x.step())));
      hl.attr("x1", x(xs[i])).attr("x2", x(xs[i])).attr("opacity", 0.4);
      tip.show(`<b>${xfmt(xs[i])}</b><br>` + series.map(s => `<span style="color:${s.color}">●</span> ${s.name}: <b>${s.values[i] == null ? "–" : yfmt(s.values[i])}</b>`).join("<br>"), ev);
    }).on("mouseleave", () => { hl.attr("opacity", 0); tip.hide(); });
  legend(el, series.map(s => [s.name, s.color]));
}

function vbars(el, cats, series, { height = 260, yLabel = "", yfmt = d3.format(".1f"), xfmt = d => d } = {}) {
  const f = frame(el, height, { t: 10, r: 14, b: 44, l: 64 });
  const x0 = d3.scaleBand().domain(cats).range([0, f.w]).padding(0.22);
  const x1 = d3.scaleBand().domain(series.map(s => s.name)).range([0, x0.bandwidth()]).padding(0.08);
  const all = series.flatMap(s => s.values);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(all)), d3.max(all) * 1.1 || 1]).nice().range([f.h, 0]);
  f.g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-f.w).tickFormat("")).select(".domain").remove();
  f.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(yfmt)).select(".domain").remove();
  const ax = f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.h})`).call(d3.axisBottom(x0).tickFormat(xfmt).tickSizeOuter(0));
  f.g.append("line").attr("x1", 0).attr("x2", f.w).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", COL.ink2).attr("opacity", 0.5);
  const step = Math.ceil(cats.length / Math.max(2, Math.floor(f.w / 60))); ax.selectAll(".tick").attr("opacity", (d, i) => i % step ? 0 : 1);
  f.svg.append("text").attr("transform", "rotate(-90)").attr("x", -f.m.t - f.h / 2).attr("y", 13).attr("text-anchor", "middle").text(yLabel);
  series.forEach(s => f.g.selectAll(null).data(cats.map((c, i) => [c, s.values[i]])).join("rect")
    .attr("x", d => x0(d[0]) + x1(s.name)).attr("width", x1.bandwidth()).attr("y", y(0))
    .attr("height", 0).attr("rx", 3).attr("fill", s.color)
    .on("mousemove", (ev, d) => tip.show(`<b>${xfmt(d[0])}</b><br>${s.name}: <b>${yfmt(d[1])}</b>`, ev)).on("mouseleave", () => tip.hide())
    .transition().duration(700).delay((d, i) => i * 25).attr("y", d => y(Math.max(0, d[1]))).attr("height", d => Math.abs(y(d[1]) - y(0))));
  if (series.length > 1) legend(el, series.map(s => [s.name, s.color, "box"]));
}

function heatmap(el, rowsLab, colsLab, z, { height = 300, fmt = d3.format(".0%") } = {}) {
  const f = frame(el, height, { t: 6, r: 10, b: 26, l: 40 });
  const x = d3.scaleBand().domain(colsLab).range([0, f.w]).padding(0.04);
  const y = d3.scaleBand().domain(rowsLab).range([0, f.h]).padding(0.04);
  const vals = z.flat().filter(v => v != null);
  const c = d3.scaleLinear().domain([d3.min(vals), d3.max(vals)]).range(["#cde2fb", "#0d366b"]).interpolate(d3.interpolateLab);
  const c2 = d3.scaleSequential().domain([d3.min(vals), d3.max(vals)]).interpolator(d3.interpolateRgbBasis(["#1c2733", "#1c5cab", "#3987e5", "#86b6ef"]));
  rowsLab.forEach((r, i) => colsLab.forEach((cl, j) => {
    const v = z[i][j]; if (v == null) return;
    f.g.append("rect").attr("x", x(cl)).attr("y", y(r)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 2).attr("fill", c2(v))
      .on("mousemove", ev => tip.show(`<b>${cl}, ${r}:00</b><br>${fmt(v)} of departures disrupted`, ev)).on("mouseleave", () => tip.hide());
  }));
  f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.h})`).call(d3.axisBottom(x).tickSize(0)).select(".domain").remove();
  f.g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickSize(0).tickValues(rowsLab.filter((d, i) => i % 3 === 0))).select(".domain").remove();
}

function table(rows, cols, { best = {} } = {}) {
  const isNum = c => rows.length && rows.every(r => r[c.key] == null || typeof r[c.key] === "number");
  const numCol = Object.fromEntries(cols.map(c => [c.label, isNum(c)]));
  const head = cols.map(c => `<th class="${numCol[c.label] ? "num" : ""}">${c.label}</th>`).join("");
  const body = rows.map(r => "<tr>" + cols.map(c => {
    const v = r[c.key]; const s = c.fmt ? c.fmt(v, r) : (v ?? "–");
    return `<td class="${numCol[c.label] ? "num " : ""}${best[c.key] != null && v === best[c.key] ? "best" : ""}">${s}</td>`;
  }).join("") + "</tr>").join("");
  return `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
