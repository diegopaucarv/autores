/* app.js — orquesta dataset.js + folder-selector.js + Sankey + timeline (D3) */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CY = new Date().getFullYear();
  const MISSING = "(vacío)";
  let color = d3.scaleOrdinal(d3.schemeTableau10);
  function updateColorScale(dims) {
    if (!dims) return;
    const isTime = (c) => c && (c.includes("cohort") || c.includes("century"));
    if (isTime(S.colorKey)) {
      const dim = dims.find((d) => d.key === S.colorKey);
      const domain = dim ? dim.values.map((x) => x.value) : [];
      const L = domain.length;
      color = d3.scaleOrdinal()
        .domain(domain)
        .range(domain.map((_, i) => d3.interpolateRgb("#c6dbef", "#08306b")(i / Math.max(1, L - 1))));
    } else {
      color = d3.scaleOrdinal(d3.schemeTableau10);
    }
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
    const ds = Dataset.load(text, { file: name });
    S.ds = ds; S.file = name;
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
        if (!S.cols.includes(S.colorKey)) { S.colorKey = S.cols[0]; updateColorScale(S.ds.dimensions); }
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

  function renderAll() { renderLegend(); renderSankey(); renderTimeline(); }

  function renderLegend() {
    const lg = $("legend"); lg.innerHTML = ""; if (!S.colorKey) return;
    const d = S.ds.dimensions.find((x) => x.key === S.colorKey);
    (d ? d.values : []).forEach(({ value }) => {
      const s = document.createElement("span"); s.innerHTML = `<i style="background:${color(value)}"></i>`; s.append(value); lg.appendChild(s);
    });
  }

  /* ---------- brushing & linking (con modo sticky) ---------- */
  function highlight(ids, isClick = false) {
    if (isClick) {
      if (pinnedIds && ids && pinnedIds.size === ids.size && [...pinnedIds].every(v => ids.has(v))) {
        pinnedIds = null; // Toggle off if clicked again
      } else {
        pinnedIds = ids;
      }
    }
    
    // If pinned, ignore standard hover events
    if (pinnedIds && !isClick) return;

    const activeIds = pinnedIds || ids;
    const on = activeIds && activeIds.size;
    
    d3.selectAll(".sk-node").style("opacity", (d) => (!on || [...d.ids].some((i) => activeIds.has(i)) ? 1 : 0.15));
    d3.selectAll(".sk-link").style("opacity", (d) => (!on || [...d.ids].some((i) => activeIds.has(i)) ? 1 : 0.06));
    d3.selectAll(".tl-row").style("opacity", (d) => (!on || activeIds.has(d.id) ? 1 : 0.15));
  }

  /* ---------- Sankey ---------- */
  function renderSankey() {
    const host = d3.select("#sankey"); host.selectAll("*").remove();
    const cols = S.cols.filter(Boolean), items = S.ds.items;
    if (cols.length < 2) return;
    const nodes = new Map(), links = new Map();
    const node = (c, v) => { const id = c + "::" + v; if (!nodes.has(id)) nodes.set(id, { id, label: v, col: c, ids: new Set() }); return nodes.get(id); };
    items.forEach((it) => {
      const vs = cols.map((c) => vals(it, c));
      const combos = vs.reduce((acc, a) => acc.flatMap((p) => a.map((v) => [...p, v])), [[]]);
      const w = 1; // 1 unit per branch ensures it behaves as a duplicated entry for Sankey flows
      combos.forEach((combo) => {
        combo.forEach((v, i) => node(cols[i], v).ids.add(it.id));
        for (let i = 0; i < combo.length - 1; i++) {
          const s = cols[i] + "::" + combo[i], t = cols[i + 1] + "::" + combo[i + 1], k = s + ">" + t;
          if (!links.has(k)) links.set(k, { source: s, target: t, value: 0, ids: new Set() });
          const L = links.get(k); L.value += w; L.ids.add(it.id);
        }
      });
    });
    const W = 1100, perCol = d3.max(cols, (c) => [...nodes.values()].filter((n) => n.col === c).length);
    const isName = cols.includes("name");
    const rowH = isName ? 34 : 22;
    const H = Math.max(420, perCol * rowH + 40);
    const svg = host.append("svg").attr("viewBox", [0, 0, W, H]).attr("width", "100%").attr("role", "img");
    const g = d3.sankey().nodeId((d) => d.id).nodeWidth(14).nodePadding(8).nodeSort((a, b) => {
         const isTime = (c) => c && (c.includes("cohort") || c.includes("century"));
         if (a.col === b.col && isTime(a.col)) {
             return Dataset.timeValue(a.label) - Dataset.timeValue(b.label);
         }
         return b.value - a.value;
      })
      .extent([[170, 8], [W - 170, H - 8]])({ nodes: [...nodes.values()], links: [...links.values()] });
    
    svg.append("g").attr("fill", "none").selectAll("path").data(g.links).join("path").attr("class", "sk-link")
      .attr("d", d3.sankeyLinkHorizontal()).attr("stroke", (d) => color(d.source.label)).attr("stroke-opacity", 0.35)
      .attr("stroke-width", (d) => Math.max(1, d.width))
      .on("mouseenter", (_, d) => highlight(d.ids))
      .on("mouseleave", () => highlight(null))
      .on("click", (ev, d) => { ev.stopPropagation(); highlight(d.ids, true); });
      
    const ng = svg.append("g").selectAll("g").data(g.nodes).join("g").attr("class", "sk-node")
      .on("mouseenter", (_, d) => highlight(d.ids))
      .on("mouseleave", () => highlight(null))
      .on("click", (ev, d) => { ev.stopPropagation(); highlight(d.ids, true); });
      
    ng.append("rect").attr("x", (d) => d.x0).attr("y", (d) => d.y0).attr("width", (d) => d.x1 - d.x0)
      .attr("height", (d) => Math.max(2, d.y1 - d.y0)).attr("fill", (d) => color(d.label)).attr("stroke", "#222").attr("stroke-width", 0.5);
    ng.append("title").text((d) => `${d.label} · ${d.ids.size} ítem(s)`);
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
  }

  /* ---------- Timeline ---------- */
  function renderTimeline() {
    const host = d3.select("#timeline"); host.selectAll("*").remove();
    if (S.cols.includes("name")) {
        host.append("p").attr("class", "empty").text("Línea de tiempo oculta (las fechas se muestran bajo los nombres en el Sankey).");
        return;
    }
    const rows = S.ds.items.filter((i) => i.__life.valid)
      .sort((a, b) => (a.__life.birth ?? a.__life.activeStart) - (b.__life.birth ?? b.__life.activeStart));
    if (!rows.length) { host.append("p").attr("class", "empty").text("Sin ítems con fechas válidas."); return; }
    const RH = 15, T = 28, LW = 190, W = 1100, H = T + rows.length * RH + 6;
    const start = (i) => i.__life.birth ?? i.__life.activeStart;
    const x = d3.scaleLinear().domain([d3.min(rows, start), CY]).nice().range([LW, W - 12]);
    const svg = host.append("svg").attr("viewBox", [0, 0, W, H]).attr("width", "100%");
    svg.append("g").attr("transform", `translate(0,${T - 6})`)
      .call(d3.axisTop(x).ticks(12).tickFormat((y) => (y < 0 ? -y + " a.C." : String(y))).tickSize(-(H - T)))
      .call((a) => a.selectAll(".tick line").attr("stroke", "#e6e8ec")).call((a) => a.select(".domain").remove());
    const col = (it) => color(vals(it, S.colorKey)[0]);
    
    const r = svg.append("g").selectAll("g").data(rows).join("g").attr("class", "tl-row")
      .attr("transform", (_, i) => `translate(0,${T + i * RH})`)
      .on("mouseenter", (_, d) => highlight(new Set([d.id])))
      .on("mouseleave", () => highlight(null))
      .on("click", (ev, d) => { ev.stopPropagation(); highlight(new Set([d.id]), true); });
      
    r.append("text").attr("x", LW - 8).attr("y", RH / 2).attr("dy", "0.35em").attr("text-anchor", "end").attr("class", "lbl")
      .text((d) => (d.name || d.id).slice(0, 30));
    r.append("line").attr("x1", (d) => x(start(d))).attr("x2", (d) => x(d.__life.activeEnd)).attr("y1", RH / 2).attr("y2", RH / 2)
      .attr("stroke", col).attr("stroke-width", 1.5).attr("stroke-opacity", (d) => (d.__life.mode === "life" ? 0.6 : 0));
    r.append("rect").attr("x", (d) => x(d.__life.activeStart)).attr("y", 3).attr("height", RH - 6).attr("rx", 2)
      .attr("width", (d) => Math.max(2, x(d.__life.activeEnd) - x(d.__life.activeStart)))
      .attr("fill", col).attr("fill-opacity", (d) => (d.__life.alive ? 0.5 : 0.9))
      .attr("stroke", col).attr("stroke-dasharray", (d) => (d.__life.alive ? "4 2" : null))
      .append("title").text((d) => `${d.name}\n${d.__life.mode === "life" ? "vida " + d.__life.birth + "–" + (d.__life.alive ? "hoy" : d.__life.death) + "\n" : "(sin nacimiento) "}actividad ${d.__life.activeStart}–${d.__life.activeEnd}${d.__life.warnings.length ? "\n⚠ " + d.__life.warnings.map((w) => WARN[w] || w).join(", ") : ""}`);
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
    document.addEventListener("click", () => {
       if (pinnedIds) highlight(null, true);
    });
    
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
  window.__app = S;
})();
