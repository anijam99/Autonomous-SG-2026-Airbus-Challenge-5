/* Front-page "approach scope": an illustrative simulation of arrivals into a hub as a storm crosses the field.
   Run 1 is reactive (today): the arrival rate is cut when the storm arrives, so aircraft hold in the air.
   Run 2 uses a 3–12 h forecast: flights are held at their origin before departure, so few aircraft hold.
   Styled after a cockpit navigation display (cyan range rings, green labels, magenta active path). */
const Hero = (() => {
  const CYAN = "#3ee0ff", GREEN = "#3dff8b", MAGENTA = "#ff4fd8", AMBER = "#ffb84d", WHITE = "#eef3fb";
  const HEADING = 80, FUEL_KG_MIN = 35.2;          // runway 08 (brief); EUROCONTROL narrow-body arrival-management burn
  const CYCLE = 200, DEMAND = 1.05;                // sim minutes per run; arrivals per minute (≈ 63/h)
  const CAP_OK = 1.2, CAP_STORM = 0.32;            // runway acceptance per minute, normal vs storm overhead
  const SPEED = 9, SIM_PER_SEC = 7.5;              // px per sim-minute along paths; sim minutes per real second
  let raf, st;

  const KEY = "scopeRuns.v1";
  const load = () => { try { const r = JSON.parse(localStorage.getItem(KEY)); return r && r.react && r.fc ? r : null; } catch { return null; } };
  const save = r => { try { localStorage.setItem(KEY, JSON.stringify(r)); } catch {} };

  function reset(mode, keepRuns) {
    st = { ...st, mode, t: 0, planes: [], nextFree: 0, acc: 0, backlog: 0, held: 0, holdMin: 0, groundMin: 0, landed: 0,
           runs: keepRuns ? st.runs : { react: null, fc: null } };
  }

  // storm passes over the field between ~t=60 and ~t=140
  const stormPos = (t, W, H, c) => {
    const k = t / CYCLE;
    return { x: c.x - 0.55 * c.R + k * 1.25 * c.R, y: c.y - 0.75 * c.R + k * 1.25 * c.R };
  };
  const stormOverField = (t, g) => { const s = stormPos(t, g.W, g.H, g.c); return Math.hypot(s.x - g.c.x, s.y - g.c.y) < g.c.R * 0.3; };
  const cap = (t, g) => stormOverField(t, g) ? CAP_STORM : CAP_OK;

  function geom(cv) {
    const W = cv.clientWidth, H = cv.clientHeight;
    const cxr = +(cv.dataset.cx || 0.69);
    const c = { x: W * cxr, y: H * 0.5, R: Math.min(H * 0.42, W * (cxr < 0.6 ? 0.4 : 0.3)) };
    const rad = d => (d - 90) * Math.PI / 180;
    const pt = (b, r) => ({ x: c.x + r * Math.cos(rad(b)), y: c.y + r * Math.sin(rad(b)) });
    const dir = { x: Math.cos(rad(HEADING)), y: Math.sin(rad(HEADING)) };
    const L = c.R * 0.22;
    const thr = { x: c.x - dir.x * L / 2, y: c.y - dir.y * L / 2 };
    const ff = { x: thr.x - dir.x * c.R * 0.42, y: thr.y - dir.y * c.R * 0.42 };
    const gates = [25, 115, 205, 300].map(b => ({ b, entry: pt(b, c.R * 1.02), hold: pt(b, c.R * 0.66) }));
    const appB = (HEADING + 180) % 360;   // aircraft join the extended centreline on this bearing
    return { W, H, c, pt, dir, L, thr, ff, gates, appB, rDown: c.R * 0.66 };
  }

  function spawn(g) {
    const gate = g.gates[Math.floor(Math.random() * g.gates.length)];
    st.planes.push({ gate, phase: "in", x: gate.entry.x, y: gate.entry.y, ang: 0, s: 0, hold: 0, release: 0, trail: [], seed: Math.random() * 6.3, bear: gate.b });
  }

  const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  function bez(p0, p1, p2, k) { const a = lerp(p0, p1, k), b = lerp(p1, p2, k); return lerp(a, b, k); }

  function step(dt, g) {
    st.t += dt;
    // demand: in forecast mode, flights whose arrival would meet the storm wait at origin (ground delay)
    st.acc += DEMAND * dt;
    const eta = st.t + 22;   // ~22 sim-min from entering the scope to landing
    while (st.acc >= 1) {
      st.acc -= 1;
      if (st.mode === "fc" && cap(eta, g) < DEMAND && Math.random() > cap(eta, g) / DEMAND) { st.backlog++; continue; }
      spawn(g);
    }
    if (st.mode === "fc" && st.backlog > 0 && cap(eta, g) > DEMAND) {
      const extra = (cap(eta, g) - DEMAND) * dt;
      if (Math.random() < extra * 1.6) { st.backlog--; spawn(g); }
    }
    st.groundMin += st.backlog * dt;
    let holding = 0;
    for (const p of st.planes) {
      const mv = SPEED * dt;
      if (p.phase === "in") {
        const dx = p.gate.hold.x - p.x, dy = p.gate.hold.y - p.y, d = Math.hypot(dx, dy);
        p.ang = Math.atan2(dy, dx);
        if (d <= mv) {   // reached the holding fix: get a landing slot
          const slot = Math.max(st.nextFree, st.t);
          st.nextFree = slot + 1 / cap(slot, g);
          p.release = slot; p.phase = slot - st.t > 0.6 ? "hold" : "arc"; p.bear = p.gate.b;
        } else { p.x += dx / d * mv; p.y += dy / d * mv; }
      } else if (p.phase === "hold") {
        holding++; p.hold += dt;
        // racetrack: an ellipse around the fix, oriented tangentially
        const a = p.hold * 1.1 + p.seed, cx = p.gate.hold.x, cy = p.gate.hold.y, tb = Math.atan2(cy - g.c.y, cx - g.c.x) + Math.PI / 2;
        const k = 1 + (p.seed % 1.5) * 0.35, ex = 22 * k * Math.cos(a), ey = 9 * k * Math.sin(a);
        const nx = cx + ex * Math.cos(tb) - ey * Math.sin(tb), ny = cy + ex * Math.sin(tb) + ey * Math.cos(tb);
        p.ang = Math.atan2(ny - p.y, nx - p.x); p.x = nx; p.y = ny;
        if (st.t >= p.release) { p.phase = "arc"; p.bear = p.gate.b; }
      } else if (p.phase === "arc") {
        // fly around the field on a downwind arc (never across it) to the extended centreline
        let d = ((g.appB - p.bear + 540) % 360) - 180;
        const stepDeg = mv / g.rDown * 180 / Math.PI;
        if (Math.abs(d) <= stepDeg) { p.bear = g.appB; p.phase = "app"; p.from = { x: p.x, y: p.y }; p.s = 0; }
        else p.bear += Math.sign(d) * stepDeg;
        const q = g.pt(p.bear, g.rDown); p.ang = Math.atan2(q.y - p.y, q.x - p.x); p.x = q.x; p.y = q.y;
      } else if (p.phase === "app") {
        // straight in along the centreline to the final approach fix
        const len = Math.hypot(g.ff.x - p.from.x, g.ff.y - p.from.y) || 1;
        p.s += mv / len;
        const q = lerp(p.from, g.ff, Math.min(1, p.s)); p.ang = Math.atan2(g.dir.y, g.dir.x); p.x = q.x; p.y = q.y;
        if (p.s >= 1) { p.phase = "fin"; p.s = 0; }
      } else if (p.phase === "fin") {
        const len = Math.hypot(g.thr.x - g.ff.x, g.thr.y - g.ff.y);
        p.s += mv / len;
        const q = lerp(g.ff, g.thr, Math.min(1, p.s)); p.ang = Math.atan2(g.dir.y, g.dir.x); p.x = q.x; p.y = q.y;
        if (p.s >= 1) { p.phase = "done"; st.landed++; }
      }
      if (p.phase !== p.lastPhase) { p.trail = []; p.lastPhase = p.phase; }   // no chords across a phase change
      const lt = p.trail[p.trail.length - 1];
      if (lt && Math.hypot(p.x - lt.x, p.y - lt.y) > 20) p.trail = [];
      if (Math.random() < 0.5) { p.trail.push({ x: p.x, y: p.y }); if (p.trail.length > 14) p.trail.shift(); }
    }
    st.holdMin += holding * dt; st.held = holding;
    st.planes = st.planes.filter(p => p.phase !== "done");
    if (st.t >= CYCLE) {
      if (!st.done) {
        st.runs[st.mode] = { hold: st.holdMin, ground: st.groundMin, landed: st.landed };
        if (st.runs.react && st.runs.fc) { st.done = true; save(st.runs); }
      }
      reset(st.mode === "react" ? "fc" : "react", true);   // the scope keeps playing; finished results stay fixed
    }
  }

  function plane(ctx, x, y, ang, color, s = 1) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.scale(s, s); ctx.fillStyle = color;
    ctx.beginPath();   // generic twin-jet airliner, nose at +x
    ctx.moveTo(9, 0); ctx.quadraticCurveTo(8, -1.3, 5, -1.3); ctx.lineTo(1.5, -1.3); ctx.lineTo(-3, -8.5); ctx.lineTo(-5, -8.5);
    ctx.lineTo(-2.2, -1.3); ctx.lineTo(-6.5, -1.1); ctx.lineTo(-8.6, -4); ctx.lineTo(-9.8, -4); ctx.lineTo(-8.8, 0);
    ctx.lineTo(-9.8, 4); ctx.lineTo(-8.6, 4); ctx.lineTo(-6.5, 1.1); ctx.lineTo(-2.2, 1.3); ctx.lineTo(-5, 8.5); ctx.lineTo(-3, 8.5);
    ctx.lineTo(1.5, 1.3); ctx.lineTo(5, 1.3); ctx.quadraticCurveTo(8, 1.3, 9, 0); ctx.fill();
    ctx.restore();
  }

  function draw(ctx, g, sweep) {
    const { c } = g;
    ctx.clearRect(0, 0, g.W, g.H);
    // dot grid
    ctx.fillStyle = "rgba(62,224,255,0.06)";
    for (let x = 12; x < g.W; x += 26) for (let y = 12; y < g.H; y += 26) ctx.fillRect(x, y, 1.2, 1.2);
    // weather radar returns
    const sp = stormPos(st.t, g.W, g.H, c);
    const cells = [[0, 0, 0.42, "rgba(30,200,90,0.30)"], [-40, 26, 0.26, "rgba(30,200,90,0.26)"], [44, -30, 0.24, "rgba(30,200,90,0.24)"],
      [10, -8, 0.27, "rgba(240,210,40,0.38)"], [-22, 18, 0.15, "rgba(240,210,40,0.32)"], [16, -6, 0.14, "rgba(240,70,60,0.55)"],
      [-14, 12, 0.07, "rgba(255,60,200,0.45)"], [38, -24, 0.1, "rgba(240,210,40,0.3)"]];
    for (const [ox, oy, r, col] of cells) {
      const rr = r * c.R * (1 + 0.07 * Math.sin(st.t / 5 + ox));
      const gr = ctx.createRadialGradient(sp.x + ox, sp.y + oy, 0, sp.x + ox, sp.y + oy, rr);
      gr.addColorStop(0, col); gr.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sp.x + ox, sp.y + oy, rr, 0, 7); ctx.fill();
    }
    ctx.font = "600 10px JetBrains Mono, monospace"; ctx.fillStyle = "rgba(255,120,90,0.9)"; ctx.textAlign = "center";
    ctx.fillText("CB · TSRA", sp.x + 10, sp.y - c.R * 0.3);
    // range rings + compass rose (navigation-display look)
    ctx.strokeStyle = "rgba(62,224,255,0.22)"; ctx.lineWidth = 1;
    [0.33, 0.66, 1].forEach((k, i) => { ctx.setLineDash(i < 2 ? [2, 6] : []); ctx.beginPath(); ctx.arc(c.x, c.y, c.R * k, 0, 7); ctx.stroke(); });
    ctx.setLineDash([]);
    ctx.font = "10px JetBrains Mono, monospace"; ctx.fillStyle = "rgba(62,224,255,0.7)";
    for (let b = 0; b < 360; b += 10) {
      const a = (b - 90) * Math.PI / 180, r1 = c.R * (b % 30 ? 0.975 : 0.95);
      ctx.beginPath(); ctx.moveTo(c.x + r1 * Math.cos(a), c.y + r1 * Math.sin(a)); ctx.lineTo(c.x + c.R * Math.cos(a), c.y + c.R * Math.sin(a)); ctx.stroke();
      if (b % 30 === 0) { ctx.textAlign = "center"; ctx.fillText(String(b / 10).padStart(2, "0"), c.x + (c.R + 14) * Math.cos(a), c.y + (c.R + 14) * Math.sin(a) + 3); }
    }
    ctx.fillStyle = GREEN; ctx.textAlign = "left";
    ctx.fillText("10", c.x + c.R * 0.33 + 4, c.y - 4); ctx.fillText("20", c.x + c.R * 0.66 + 4, c.y - 4); ctx.fillText("30 NM", c.x + c.R + 4, c.y - 4);
    // radar sweep
    if (ctx.createConicGradient) {
      const cg = ctx.createConicGradient(sweep, c.x, c.y);
      cg.addColorStop(0, "rgba(62,224,255,0.16)"); cg.addColorStop(0.08, "rgba(62,224,255,0)"); cg.addColorStop(1, "rgba(62,224,255,0)");
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(c.x, c.y, c.R, 0, 7); ctx.fill();
    }
    // arrival gates and holding fixes
    g.gates.forEach(gt => {
      ctx.strokeStyle = "rgba(62,224,255,0.25)"; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(gt.entry.x, gt.entry.y); ctx.lineTo(gt.hold.x, gt.hold.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = GREEN; ctx.beginPath();
      ctx.moveTo(gt.hold.x, gt.hold.y - 5); ctx.lineTo(gt.hold.x + 5, gt.hold.y + 4); ctx.lineTo(gt.hold.x - 5, gt.hold.y + 4); ctx.closePath(); ctx.stroke();
    });
    // final approach course (magenta) and runway
    ctx.strokeStyle = MAGENTA; ctx.lineWidth = 1.2; ctx.setLineDash([2, 6]);
    const ap = g.pt(g.appB, g.rDown); ctx.beginPath(); ctx.moveTo(ap.x, ap.y); ctx.lineTo(g.ff.x, g.ff.y); ctx.stroke();
    ctx.strokeStyle = MAGENTA; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(g.ff.x, g.ff.y); ctx.lineTo(g.thr.x, g.thr.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate((HEADING - 90) * Math.PI / 180);
    ctx.fillStyle = "#1b2a44"; ctx.fillRect(-g.L / 2, -4, g.L, 8); ctx.fillStyle = WHITE;
    for (let x = -g.L / 2 + 6; x < g.L / 2 - 6; x += 9) ctx.fillRect(x, -0.6, 5, 1.2);
    ctx.restore();
    ctx.fillStyle = WHITE; ctx.font = "600 11px JetBrains Mono, monospace"; ctx.textAlign = "center";
    ctx.fillText("KATL · RWY 08", c.x + 4, c.y + 30);
    const overField = stormOverField(st.t, g);
    ctx.fillStyle = overField ? AMBER : GREEN; ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillText(overField ? "ACCEPTANCE ↓ " + Math.round(CAP_STORM * 60) + "/h" : "ACCEPTANCE " + Math.round(CAP_OK * 60) + "/h", c.x + 4, c.y + 44);
    // aircraft
    for (const p of st.planes) {
      const col = p.phase === "hold" ? AMBER : (p.phase === "fin" || p.phase === "app" ? MAGENTA : WHITE);
      ctx.strokeStyle = p.phase === "hold" ? "rgba(255,184,77,0.35)" : "rgba(238,243,251,0.18)"; ctx.lineWidth = 1;
      ctx.beginPath(); p.trail.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.stroke();
      plane(ctx, p.x, p.y, p.ang, col, 0.95);
    }
  }

  function hud() {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set("h-hold", st.held);
    set("h-fuel", (st.holdMin * FUEL_KG_MIN / 1000).toFixed(1) + " t");
    set("h-ground", st.backlog);
    const tag = document.getElementById("h-mode");
    if (tag) {
      tag.className = "tag " + (st.mode === "react" ? "react" : "fc");
      tag.textContent = st.mode === "react" ? "Today: reactive" : "With the 3–12 h forecast";
      document.getElementById("h-sub").textContent = st.mode === "react"
        ? "rate cut when the storm is overhead → airborne holding" : "flights held at origin before departure → little holding";
      const clock = Math.floor(st.t / CYCLE * 100);
      document.getElementById("h-clock").textContent = `replay ${clock}% through`;
    }
    const R = st.runs, el = document.getElementById("h-runs");
    if (el) {
      const r = R.react, f = R.fc, mx = Math.max(r?.hold || 1, f?.hold || 1);
      const prog = Math.min(100, st.t / CYCLE * 100);
      const row = (lab, x, col, mode) => {
        if (x) return `<div>${lab}: <b style="color:${col}">${Math.round(x.hold)} min</b> airborne holding · ${(x.hold * FUEL_KG_MIN / 1000).toFixed(1)} t fuel</div>
          <div class="bar" style="width:${Math.max(2, x.hold / mx * 100)}%;background:${col}"></div>`;
        const active = st.mode === mode, p = active ? prog : 0;
        return `<div style="display:flex;justify-content:space-between;color:var(--muted)"><span>${lab}: ${active ? "simulating…" : "waiting to simulate"}</span><span>${active ? Math.floor(p) + "%" : ""}</span></div>
          <div class="sim-track"><div class="sim-fill" style="width:${p}%;background:${col}"></div></div>`;
      };
      const html = `<div style="margin-bottom:6px;color:#a39d96;display:flex;justify-content:space-between;gap:12px"><span>Same storm, two strategies${st.done ? " · complete" : ""}</span>${st.done ? '<button type="button" class="sim-restart" data-act="restart">↻ Restart simulation</button>' : ""}</div>`
        + row("Reactive (today)", r, AMBER, "react") + row("With forecast", f, GREEN, "fc");
      if (html !== st.panel) { el.innerHTML = html; st.panel = html; }
    }
  }

  function start(cv) {
    stop();
    st = {}; reset("react");
    const cached = load();
    if (cached) { st.runs = cached; st.done = true; }
    const panel = document.getElementById("h-runs");
    if (panel) panel.onclick = e => {
      if (!e.target.closest("[data-act=restart]")) return;
      try { localStorage.removeItem(KEY); } catch {}
      st.done = false; st.panel = null; reset("react"); st.runs = { react: null, fc: null };
    };
    const ctx = cv.getContext("2d");
    let last = performance.now(), sweep = 0, g;
    const fit = () => { const d = devicePixelRatio || 1; cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0); g = geom(cv); };
    fit(); addEventListener("resize", fit);
    const q = new URLSearchParams(location.search);
    if (q.get("scopemode") === "fc") reset("fc");
    const warm = +(q.get("scope") || 20);         // ?scope=110 fast-forwards (used for screenshots)
    while (st.t < warm) step(0.5, g);
    const loop = now => {
      if (!document.body.contains(cv)) { removeEventListener("resize", fit); return; }
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      step(dt * SIM_PER_SEC, g); sweep = (sweep + dt * 1.2) % (Math.PI * 2);
      draw(ctx, g, sweep); hud();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
  function stop() { if (raf) cancelAnimationFrame(raf); }
  return { start, stop };
})();
