/* app.js — orquesta dataset.js + folder-selector.js + Sankey + timeline (D3) */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CY = new Date().getFullYear();
  const MISSING = "(vacío)";
  const NEUTRAL = "#9aa3ad";
  const PALETTE = ["#3b6ea8", "#d9822b", "#4a9a7b", "#c4504d", "#8a6bb0", "#b8a13a", "#3f9cae", "#c9739c", "#7a8f3c", "#8c6b4f", "#5b6a9a", "#d1a35f"];
  let color = () => NEUTRAL;
  const isTime = (c) => c && (c.includes("cohort") || c.includes("century"));
  // Un color por valor de la variable de color, asignado por orden (sin colisiones por hash); lo desconocido es gris.
  function updateColorScale(dims) {
    const dim = dims && dims.find((d) => d.key === S.colorKey);
    const domain = dim ? dim.values.map((x) => x.value) : [], L = domain.length;
    const range = isTime(S.colorKey)
      ? domain.map((_, i) => d3.interpolateBlues(0.3 + 0.65 * (i / Math.max(1, L - 1))))
      : L <= PALETTE.length ? PALETTE.slice(0, L) : d3.quantize((t) => d3.interpolateSinebow(t), L);
    const m = new Map(domain.map((v, i) => [v, range[i]]));
    color = (v) => m.get(v) || NEUTRAL;
  }
  const WARN = {
    verify_alive: "vivo con ≥95 años: verificar", birth_approx: "nacimiento aproximado",
    death_approx: "muerte aproximada", no_birth: "sin nacimiento (solo intervalo de actividad)",
  };
  const REASON = {
    no_birth: "sin nacimiento", death_before_birth: "muerte < nacimiento", birth_out_of_range: "nacimiento fuera de rango",
    death_in_future: "muerte en el futuro", age_impossible: "edad imposible", active_end_before_start: "actividad: fin < inicio",
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const S = { ds: null, cols: [], colorKey: null, file: "" };
  let pinnedIds = null; // Holds the currently clicked/sticky selection

  /* ---------- carga ---------- */
  function boot(text, name) {
    
    pinnedIds = null;
    S.file = name;
    const ds = Panel.onLoad(Dataset.load(text, { file: name }), name);
    S.ds = ds;
    renderReport(ds);
    if (!ds.items.length) { ["selectors", "legend", "sankey", "timeline"].forEach((i) => ($(i).innerHTML = "")); return; }
    const d = ds.defaults.length >= 2 ? ds.defaults : ds.dimensions.slice(0, 3).map((x) => x.key);
    S.cols = [d[0], d[1], d[2] || null].filter((x, i) => x || i < 2);
    S.colorKey = S.cols[0] || null;
    updateColorScale(ds.dimensions);
    
    // Sync slider with dataset
    $("cohort-val").textContent = Dataset.CFG.COHORT_SIZE;
    $("cohort-slider").value = Dataset.CFG.COHORT_SIZE;
    
    renderSelectors(); renderAll();
  }

  /* ---------- reporte de veracidad / calidad ---------- */
  function renderReport(ds) {
    const r = ds.report, chips = (o, map, cls) => Object.entries(o || {}).map(([k, v]) => `<span class="chip ${cls}">${v}× ${esc(map[k] || k)}</span>`).join("");
    const merged = Object.keys(r.mergedDuplicates || {}).length;
    const nameOf = (id) => (ds.items.find((i) => i.id === id) || {}).name || id;
    $("report").innerHTML = r.error ? `<div class="report bad">⚠ ${esc(r.error)}</div>` : `
      <div class="report">
        <b>${esc(S.file)}</b> <span class="chip">${esc(r.format || "?")}${r.delimiter ? " · delim «" + esc(r.delimiter) + "»" : ""}</span>
        <span class="pill ${r.invalid ? "warn" : "ok"}">${r.valid}/${r.total} con fechas válidas</span>
        <span class="chip">👤 ${r.alive} vivos/activos</span>
        ${r.invalid ? "<div>✗ Descartados: " + chips(r.reasons, REASON, "w") + "</div>" : ""}
        ${Object.keys(r.warnings).length ? "<div>⚠ Avisos: " + chips(r.warnings, WARN, "w") + "</div>" : ""}
        ${r.needsReview.length ? `<div class="w2">Verificar si siguen vivos: ${r.needsReview.map((i) => esc(nameOf(i))).join(" · ")}</div>` : ""}
        ${r.conflicts && r.conflicts.length ? `<details><summary>≠ ${r.conflicts.length} conflictos entre duplicados (se conserva el primero)</summary>${r.conflicts.map((c) => `<div>${esc(c.name)} · ${esc(c.field)}: «${esc(c.kept)}» vs «${esc(c.other)}»</div>`).join("")}</details>` : ""}
        ${r.ignoredColumns.length ? `<div>Columnas ignoradas (derivadas): ${r.ignoredColumns.map(esc).join(", ")}</div>` : ""}
      </div>`;
  }

  /* ---------- selectores ---------- */
  function renderSelectors() {
    const box = $("selectors"); box.innerHTML = "";
    const dims = S.ds.dimensions;
    if (dims.length < 2) { box.textContent = "⚠ Menos de 2 dimensiones categóricas: no hay Sankey posible."; return; }
    const mk = (slot, optional) => {
      const sel = document.createElement("select");
      if (optional) sel.innerHTML = '<option value="">(ninguna)</option>';
      [["Columnas", dims.filter((d) => !d.derived)], ["Derivadas de fechas", dims.filter((d) => d.derived)]].forEach(([lab, list]) => {
        if (!list.length) return;
        const g = document.createElement("optgroup"); g.label = lab;
        list.forEach((d) => { const o = document.createElement("option"); o.value = d.key; o.textContent = `${d.label} · ${d.uniqueCount}`; g.appendChild(o); });
        sel.appendChild(g);
      });
      sel.value = S.cols[slot] || "";
      sel.addEventListener("change", () => {
        const v = sel.value, other = S.cols.findIndex((c, i) => i !== slot && c && c === v);
        if (other >= 0) S.cols[other] = S.cols[slot];
        S.cols[slot] = v || null; S.cols = S.cols.filter((c, i) => c || i < 2);
        
        renderSelectors(); renderAll();
      });
      return sel;
    };
    box.append(mk(0), " → ", mk(1), " → ", mk(2, true));
    const cs = document.createElement("select"); cs.title = "Variable de color";
    dims.forEach((d) => { const o = document.createElement("option"); o.value = d.key; o.textContent = d.label; cs.appendChild(o); });
    cs.value = S.colorKey; 
    cs.addEventListener("change", () => { 
      S.colorKey = cs.value; 
      updateColorScale(S.ds.dimensions);
      renderAll(); 
    });
    const l = document.createElement("label"); l.append("  Color: ", cs); box.appendChild(l);
  }

  const vals = (it, key) => {
    const v = String(it[key] ?? "").trim();
    return v ? v.split(Dataset.CFG.MULTI_SEP).map((x) => x.trim()).filter(Boolean) : [MISSING];
  };

  function renderAll() { renderLegend(); renderSankey(); renderTimeline(); paint(); }
  function reanalyze() {
    S.ds = Dataset.analyze(S.ds.items, { currentYear: CY, file: S.file, format: S.ds.report.format, delimiter: S.ds.report.delimiter });
    const keys = S.ds.dimensions.map((d) => d.key);
    S.cols = S.cols.filter((c, i) => keys.includes(c) || (!c && i >= 2));
    if (S.cols.length < 2) { const d = S.ds.defaults.length >= 2 ? S.ds.defaults : keys.slice(0, 3); S.cols = [d[0], d[1], d[2] || null].filter((x, i) => x || i < 2); }
    if (!keys.includes(S.colorKey)) S.colorKey = S.cols[0];
    updateColorScale(S.ds.dimensions); renderReport(S.ds); renderSelectors(); renderAll();
  }

  function renderLegend() {
    const lg = $("legend"); lg.innerHTML = ""; if (!S.colorKey) return;
    const d = S.ds.dimensions.find((x) => x.key === S.colorKey);
    (d ? d.values : []).forEach(({ value }) => {
      const s = document.createElement("span"); s.innerHTML = `<i style="background:${color(value)}"></i>`; s.append(value); s.style.cursor = "pointer"; s.title = Panel.descOf(S.colorKey, value) || "Clic: ficha y descripción";
      s.onclick = (e) => { e.stopPropagation(); Panel.showNode(S.colorKey, value); }; lg.appendChild(s);
    });
  }

  /* ---------- brushing & linking: fijado > hover > búsqueda ---------- */
  let hoverIds = null, searchIds = null;
  function setPinned(ids) { pinnedIds = ids && ids.size ? ids : null; paint(); }
  function setSearch(ids) { searchIds = ids || null; paint(); }
  function highlight(ids, isClick = false) {
    if (isClick) pinnedIds = pinnedIds && ids && pinnedIds.size === ids.size && [...pinnedIds].every((v) => ids.has(v)) ? null : ids;
    else hoverIds = ids;
    paint();
  }
  function paint() {
    const act = pinnedIds || hoverIds || searchIds, hit = (set) => [...set].some((i) => act.has(i));
    const found = (set) => !!searchIds && searchIds.size > 0 && [...set].some((i) => searchIds.has(i));
    d3.selectAll(".sk-node").classed("dim", (d) => !!act && !hit(d.ids)).classed("match", (d) => found(d.ids));
    d3.selectAll(".sk-link").classed("dim", (d) => !!act && !hit(d.ids)).classed("hot", (d) => !!act && hit(d.ids));
    d3.selectAll(".tl-row").classed("dim", (d) => !!act && !act.has(d.id));
  }

  /* ---------- Sankey ---------- */
  function renderSankey() {
    const host = d3.select("#sankey"); host.selectAll("*").remove();
    const cols = S.cols.filter(Boolean), items = S.ds.items;
    if (cols.length < 2) return;
    const nodes = new Map(), links = new Map();
    const node = (c, v) => { const id = c + "::" + v; if (!nodes.has(id)) nodes.set(id, { id, label: v, col: c, ids: new Set() }); return nodes.get(id); };
    const ck = S.colorKey, ci = cols.indexOf(ck), extra = ci < 0 && !!ck;
    items.forEach((it) => {
      const vs = cols.map((c) => vals(it, c));
      const combos = vs.reduce((acc, a) => acc.flatMap((p) => a.map((v) => [...p, v])), [[]]);
      const cvs = extra ? vals(it, ck) : [null], w = 1 / cvs.length; // peso fraccional: la altura de los nodos no se infla
      cvs.forEach((cv) => combos.forEach((combo) => {
        const cval = ci >= 0 ? combo[ci] : cv;
        combo.forEach((v, i) => node(cols[i], v).ids.add(it.id));
        for (let i = 0; i < combo.length - 1; i++) {
          const s0 = cols[i] + "::" + combo[i], t = cols[i + 1] + "::" + combo[i + 1], k = s0 + ">" + t + ">" + cval;
          if (!links.has(k)) links.set(k, { source: s0, target: t, value: 0, ids: new Set(), cval });
          const L = links.get(k); L.value += w; L.ids.add(it.id);
        }
      }));
    });
    const W = 1100, perCol = d3.max(cols, (c) => [...nodes.values()].filter((n) => n.col === c).length);
    const isName = cols.includes("name");
    const rowH = isName ? (Panel.hasExtra() ? 46 : 34) : 22;
    const H = Math.max(420, perCol * rowH + 60);
    const svg = host.append("svg").attr("viewBox", [0, 0, W, H]).attr("width", "100%").attr("role", "img");
    const g = d3.sankey().nodeId((d) => d.id).nodeWidth(14).nodePadding(8).nodeSort((a, b) => {
         const isTime = (c) => c && (c.includes("cohort") || c.includes("century"));
         if (a.col === b.col && isTime(a.col)) {
             return Dataset.timeValue(a.label) - Dataset.timeValue(b.label);
         }
         return b.value - a.value;
      })
      .extent([[170, 30], [W - 170, H - 8]])({ nodes: [...nodes.values()], links: [...links.values()] });
    cols.forEach((c) => {
      const ns = g.nodes.filter((n) => n.col === c); if (!ns.length) return;
      const dm = S.ds.dimensions.find((d) => d.key === c), first = c === cols[0];
      svg.append("text").attr("class", "colhead").attr("y", 16).attr("x", first ? ns[0].x0 - 6 : ns[0].x1 + 6)
        .attr("text-anchor", first ? "end" : "start").text(dm ? dm.label : c);
    });
    
    svg.append("g").attr("fill", "none").selectAll("path").data(g.links).join("path").attr("class", "sk-link")
      .attr("d", d3.sankeyLinkHorizontal()).attr("stroke", (d) => color(d.cval))
      .attr("stroke-width", (d) => Math.max(1, d.width))
      .on("mouseenter", (_, d) => highlight(d.ids))
      .on("mouseleave", () => highlight(null))
      .on("click", (ev, d) => { ev.stopPropagation(); highlight(d.ids, true); })
      .on("mousemove.tip", (ev, d) => Panel.tipLink(ev, d)).on("mouseleave.tip", Panel.tipHide);

    const ng = svg.append("g").selectAll("g").data(g.nodes).join("g").attr("class", "sk-node")
      .on("mouseenter", (_, d) => highlight(d.ids))
      .on("mouseleave", () => highlight(null))
      .on("click", (ev, d) => { ev.stopPropagation(); Panel.showNode(d.col, d.label); })
      .on("mousemove.tip", (ev, d) => Panel.tipNode(ev, d)).on("mouseleave.tip", Panel.tipHide);

    ng.append("rect").attr("x", (d) => d.x0).attr("y", (d) => d.y0).attr("width", (d) => d.x1 - d.x0)
      .attr("height", (d) => Math.max(2, d.y1 - d.y0)).attr("fill", (d) => (d.col === ck ? color(d.label) : NEUTRAL));
    const txt = ng.append("text").attr("class", "lbl")
      .attr("text-anchor", (d) => (d.col === cols[0] ? "end" : "start"));
      
    txt.append("tspan")
      .attr("x", (d) => (d.col === cols[0] ? d.x0 - 6 : d.x1 + 6))
      .attr("y", (d) => (d.y0 + d.y1) / 2)
      .attr("dy", (d) => (d.col === 'name' ? "-0.4em" : "0.35em"))
      .text((d) => (d.label.length > 30 ? d.label.slice(0, 29) + "…" : d.label) + (d.col === 'name' ? "" : ` (${d.ids.size})`));

    txt.filter(d => d.col === 'name').append("tspan")
      .attr("x", (d) => (d.col === cols[0] ? d.x0 - 6 : d.x1 + 6))
      .attr("y", (d) => (d.y0 + d.y1) / 2)
      .attr("dy", "1.3em")
      .attr("fill", "var(--muted)")
      .style("font-size", "9.5px")
      .style("font-weight", "500")
      .text(d => {
          const it = items.find(i => i.id === [...d.ids][0]);
          if (!it || !it.__life || !it.__life.valid) return "";
          const L = it.__life;
          return L.mode === 'life' 
            ? `${L.birth} – ${L.alive ? 'hoy' : L.death}`
            : `act. ${L.activeStart} – ${L.activeEnd}`;
      });
    if (Panel.hasExtra()) txt.filter((d) => d.col === "name").append("tspan")
      .attr("x", (d) => (d.col === cols[0] ? d.x0 - 6 : d.x1 + 6)).attr("y", (d) => (d.y0 + d.y1) / 2).attr("dy", "2.5em")
      .attr("fill", "var(--ink-3)").style("font-size", "9px").style("font-weight", "400")
      .text((d) => Panel.extra(items.find((i) => i.id === [...d.ids][0]) || {}));
  }

  /* ---------- Timeline ---------- */
  let gOrd = () => 0;
  const gKey = (it) => vals(it, S.colorKey)[0];
  function tlCmp(a, b) {
    const L = (i) => i.__life, st = (i) => L(i).birth ?? L(i).activeStart, nm = (i) => String(i.name || i.id), m = S.tlSort || "start";
    const c = m === "end" ? L(a).activeEnd - L(b).activeEnd : m === "length" ? L(a).activeYears - L(b).activeYears
      : m === "name" ? nm(a).localeCompare(nm(b), "es") : m === "group" ? gOrd(a) - gOrd(b) : 0;
    return c || st(a) - st(b) || nm(a).localeCompare(nm(b), "es");
  }
  function renderTimeline(animate) {
    const host = d3.select("#timeline"), prev = new Map();
    host.selectAll(".tl-row").each(function (d) { prev.set(d.id, this.__y); });
    host.selectAll("*").remove();
    const rows = S.ds.items.filter((i) => i.__life.valid);
    if (!rows.length) { host.append("p").attr("class", "empty").text("Sin ítems con fechas válidas."); return; }
    const dim = S.ds.dimensions.find((x) => x.key === S.colorKey), ord = new Map((dim ? dim.values : []).map((v, i) => [v.value, i]));
    gOrd = (it) => (ord.has(gKey(it)) ? ord.get(gKey(it)) : 1e6);
    rows.sort(tlCmp); if (S.tlDesc) rows.reverse();
    const grouped = S.tlSort === "group", RH = 16, T = 30, LW = 200, W = 1100, GAP = 22;
    const yOf = new Map(), heads = []; let y = T, last;
    rows.forEach((it) => {
      if (grouped && gKey(it) !== last) { last = gKey(it); heads.push({ y, label: last }); y += GAP; }
      yOf.set(it.id, y); y += RH;
    });
    const H = y + 6, start = (i) => i.__life.birth ?? i.__life.activeStart;
    const x = d3.scaleLinear().domain([d3.min(rows, start), CY]).nice().range([LW, W - 12]);
    const svg = host.append("svg").attr("viewBox", [0, 0, W, H]).attr("width", "100%");
    svg.append("g").attr("transform", `translate(0,${T - 6})`)
      .call(d3.axisTop(x).ticks(12).tickFormat((v) => (v < 0 ? -v + " a.C." : String(v))).tickSize(-(H - T)))
      .call((a) => a.selectAll(".tick line").attr("stroke", "#e6e8ec")).call((a) => a.select(".domain").remove());
    const col = (it) => color(gKey(it));
    const hg = svg.append("g").selectAll("g").data(heads).join("g").attr("transform", (h) => `translate(8,${h.y})`);
    hg.append("rect").attr("y", 3).attr("width", 12).attr("height", 12).attr("rx", 3).attr("fill", (h) => color(h.label));
    hg.append("text").attr("class", "tl-head").attr("x", 20).attr("y", 13).text((h) => h.label);
    const r = svg.append("g").selectAll("g").data(rows, (d) => d.id).join("g").attr("class", "tl-row")
      .each(function (d) { this.__y = yOf.get(d.id); })
      .attr("transform", (d) => `translate(0,${yOf.get(d.id)})`)
      .on("mouseenter", (_, d) => highlight(new Set([d.id])))
      .on("mouseleave", () => highlight(null))
      .on("click", (ev, d) => { ev.stopPropagation(); Panel.showItem(d.id); })
      .on("mousemove.tip", (ev, d) => Panel.tipItem(ev, d)).on("mouseleave.tip", Panel.tipHide);
    r.append("text").attr("x", LW - 8).attr("y", RH / 2).attr("dy", "0.35em").attr("text-anchor", "end").attr("class", "lbl")
      .text((d) => (d.name || d.id).slice(0, 30));
    r.append("line").attr("x1", (d) => x(start(d))).attr("x2", (d) => x(d.__life.activeEnd)).attr("y1", RH / 2).attr("y2", RH / 2)
      .attr("stroke", col).attr("stroke-width", 1.5).attr("stroke-opacity", (d) => (d.__life.mode === "life" ? 0.6 : 0));
    r.append("rect").attr("x", (d) => x(d.__life.activeStart)).attr("y", 3).attr("height", RH - 6).attr("rx", 2)
      .attr("width", (d) => Math.max(2, x(d.__life.activeEnd) - x(d.__life.activeStart)))
      .attr("fill", col).attr("fill-opacity", (d) => (d.__life.alive ? 0.5 : 0.9))
      .attr("stroke", col).attr("stroke-dasharray", (d) => (d.__life.alive ? "4 2" : null));
    if (animate && prev.size && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      r.attr("transform", (d) => `translate(0,${prev.has(d.id) ? prev.get(d.id) : yOf.get(d.id)})`)
        .transition().duration(500).attr("transform", (d) => `translate(0,${yOf.get(d.id)})`);
    paint();
  }

  /* ---------- exportar ---------- */
  function download(kind) {
    if (!S.ds || !S.ds.items.length) return;
    const body = kind === "csv" ? Dataset.toCSV(S.ds.items) : JSON.stringify(Dataset.toJSON(S.ds.items), null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: kind === "csv" ? "text/csv;charset=utf-8" : "application/json" }));
    a.download = S.file.replace(/\.(csv|json)$/i, "") + "." + kind; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("dl-csv").onclick = () => download("csv"); $("dl-json").onclick = () => download("json");
    
    // Clear pinned elements when clicking on the background
    document.addEventListener("click", (e) => {
       if (e.target.closest && e.target.closest("#detail,.top,.panel-head,.legend,#report")) return;
       if (pinnedIds) { highlight(null, true); Panel.close(); }
    });
    $("tl-sort").addEventListener("change", (e) => { S.tlSort = e.target.value; renderTimeline(true); });
    $("tl-dir").addEventListener("click", (e) => {
      S.tlDesc = !S.tlDesc; e.currentTarget.textContent = S.tlDesc ? "↓" : "↑";
      e.currentTarget.setAttribute("aria-label", S.tlDesc ? "Orden descendente" : "Orden ascendente"); renderTimeline(true);
    });
    Panel.init(S, S.api);
    
    // Dynamic Cohort Slider
    $("cohort-slider").addEventListener("input", (e) => {
        $("cohort-val").textContent = e.target.value;
    });
    $("cohort-slider").addEventListener("change", (e) => {
        Dataset.CFG.COHORT_SIZE = parseInt(e.target.value, 10);
        if (S.ds && S.ds.items) {
           // Re-run analyze to regenerate all cohort bins with the new size
           S.ds = Dataset.analyze(S.ds.items, { currentYear: CY, file: S.file });
           updateColorScale(S.ds.dimensions);
           renderSelectors();
           renderAll();
        }
    });

    FolderSelector.setup({ container: $("fs"), dataDir: "data/", onText: boot });
  });
  S.api = { CY, WARN, color: () => color, cols: () => S.cols, renderAll, reanalyze, setPinned, setSearch };
  window.__app = S;
})();
