/* app.js — orquesta dataset.js + folder-selector.js + Sankey + timeline (D3) */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CY = new Date().getFullYear();
  const MISSING = "(vacío)";
  const dark = () => document.documentElement.dataset.theme === "dark";
  let NEUTRAL = "#9aa3ad";
  const PALETTE = ["#3b6ea8", "#d9822b", "#4a9a7b", "#c4504d", "#8a6bb0", "#b8a13a", "#3f9cae", "#c9739c", "#7a8f3c", "#8c6b4f", "#5b6a9a", "#d1a35f"];
  let color = () => NEUTRAL;
  const isTime = (c) => c && (c.includes("cohort") || c.includes("century"));
  // Un color por valor (por orden, sin colisiones); lo desconocido es gris. Se recalcula al cambiar de tema.
  function updateColorScale(dims) {
    NEUTRAL = dark() ? "#6f7a86" : "#9aa3ad";
    const dim = dims && dims.find((d) => d.key === S.colorKey);
    const domain = dim ? dim.values.map((x) => x.value) : [], L = domain.length, f = (i) => i / Math.max(1, L - 1);
    const range = isTime(S.colorKey)
      ? domain.map((_, i) => d3.interpolateBlues(dark() ? 0.55 + 0.4 * f(i) : 0.3 + 0.65 * f(i)))
      : (L <= PALETTE.length ? PALETTE : d3.quantize((t) => d3.interpolateSinebow(t), L)).slice(0, L).map((c) => (dark() ? d3.color(c).brighter(0.35).formatHex() : c));
    const m = new Map(domain.map((v, i) => [v, range[i]]));
    color = (v) => m.get(v) || NEUTRAL;
  }
  const WARN = {
    verify_alive: "vivo con ≥95 años", birth_approx: "nacimiento aproximado",
    death_approx: "muerte aproximada", no_birth: "sin nacimiento (solo intervalo de actividad)",
  };
  const REASON = {
    no_birth: "sin nacimiento", death_before_birth: "muerte < nacimiento", birth_out_of_range: "nacimiento fuera de rango",
    death_in_future: "muerte en el futuro", age_impossible: "edad imposible", active_end_before_start: "actividad: fin < inicio",
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- medición de texto para ajuste de etiquetas (Sankey) ---------- */
  const LINE_H = 12, LBL_FONT = '600 11px "Atkinson Hyperlegible Next","Atkinson Hyperlegible",system-ui,sans-serif';
  const DATE_FONT = '500 9.5px "Atkinson Hyperlegible Next","Atkinson Hyperlegible",system-ui,sans-serif';
  const EXTRA_FONT = '400 9px "Atkinson Hyperlegible Next","Atkinson Hyperlegible",system-ui,sans-serif';
  let _mctx = null;
  function measureCtx() {
    if (!_mctx) { _mctx = document.createElement("canvas").getContext("2d"); _mctx.font = LBL_FONT; }
    return _mctx;
  }
  // Envuelve `text` en hasta `maxLines` líneas que quepan en `maxW` px; recorta la última con "…" si sobra texto.
  function wrapLabel(text, maxW, maxLines) {
    const ctx = measureCtx(); ctx.font = LBL_FONT;
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines = []; let cur = "", wi = 0;
    while (wi < words.length) {
      const test = cur ? cur + " " + words[wi] : words[wi];
      if (!cur || ctx.measureText(test).width <= maxW) { cur = test; wi++; }
      else { lines.push(cur); cur = ""; if (lines.length >= maxLines) break; }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (wi < words.length || !lines.length) {
      let last = lines[lines.length - 1] || "";
      if (!lines.length) lines.push("");
      while (last.length && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last.replace(/\s+$/, "") + "…";
    }
    return lines.slice(0, maxLines);
  }
  // Recorta `text` con «…» cuando no cabe en `maxW` con la tipografía que se va a renderizar.
  function fitText(text, maxW, font) {
    const ctx = measureCtx(); ctx.font = font || LBL_FONT;
    const s = String(text == null ? "" : text);
    if (!s || ctx.measureText(s).width <= maxW) return s;
    let cut = s;
    while (cut.length && ctx.measureText(cut + "…").width > maxW) cut = cut.slice(0, -1);
    return cut.replace(/\s+$/, "") + "…";
  }

  const S = { ds: null, cols: [], colorKey: null, file: "" };
  let pinnedIds = null; // Holds the currently clicked/sticky selection

  /* ---------- carga ---------- */
  function boot(text, name) {

    pinnedIds = null;
    S.file = name;
    const ds = Panel.onLoad(Dataset.load(text, { file: name }), name);
    S.ds = ds;
    $("add-author").disabled = false;
    renderReport(ds);
    if (!ds.items.length) { ["selectors", "legend", "sankey", "timeline"].forEach((i) => ($(i).innerHTML = "")); return; }
    const d = ds.defaults.length >= 2 ? ds.defaults : ds.dimensions.slice(0, 3).map((x) => x.key);
    S.cols = [d[0], d[1], d[2] || null].filter((x, i) => x || i < 2);
    S.colorKey = S.cols[0] || null;
    updateColorScale(ds.dimensions);

    // Sync slider with dataset
    $("cohort-val").textContent = Dataset.CFG.COHORT_SIZE;
    $("cohort-slider").value = Dataset.CFG.COHORT_SIZE;

    S.tlSort = $("tl-sort").value = "start"; S.tlDesc = false; $("tl-dir").classList.remove("desc");
    S.skSort = $("sk-sort").value = "value"; S.skDesc = false; $("sk-dir").classList.remove("desc");
    renderSelectors(); renderAll(); VH.length = 0; pushView();
  }

  /* ---------- reporte de veracidad / calidad ---------- */
  function renderReport(ds) {
    const r = ds.report, chips = (o, map, cls, extra) => Object.entries(o || {}).map(([k, v]) => `<span class="chip ${cls}">${v}× ${esc(map[k] || k)}${extra && extra[k] ? ": " + extra[k] : ""}</span>`).join(" ");
    const merged = Object.keys(r.mergedDuplicates || {}).length;
    const nameOf = (id) => (ds.items.find((i) => i.id === id) || {}).name || id;
    $("report").innerHTML = r.error ? `<div class="report bad">${esc(r.error)}</div>` : `
      <div class="report">
        <b>${esc(S.file)}</b> <span class="chip">${esc(r.format || "?")}${r.delimiter ? " · delim «" + esc(r.delimiter) + "»" : ""}</span>
        <span class="pill ${r.invalid ? "warn" : "ok"}">${r.valid}/${r.total} con fechas válidas</span>
        <span class="chip">${r.alive} vivos/activos</span>
        ${r.invalid ? "<div>Descartados: " + chips(r.reasons, REASON, "w") + "</div>" : ""}
        ${Object.keys(r.warnings).length ? "<div>Avisos: " + chips(r.warnings, WARN, "w", { verify_alive: r.needsReview.map((i) => esc(nameOf(i))).join(" · ") }) + "</div>" : ""}
        ${r.conflicts && r.conflicts.length ? `<details><summary>${r.conflicts.length} conflictos entre duplicados (se conserva el primero)</summary>${r.conflicts.map((c) => `<div>${esc(c.name)} · ${esc(c.field)}: «${esc(c.kept)}» vs «${esc(c.other)}»</div>`).join("")}</details>` : ""}
        ${r.ignoredColumns.length ? `<div>Columnas ignoradas (derivadas): ${r.ignoredColumns.map(esc).join(", ")}</div>` : ""}
      </div>`;
  }

  /* ---------- selectores ---------- */
  function renderSelectors() {
    const box = $("selectors"); box.innerHTML = "";
    const dims = S.ds.dimensions;
    if (dims.length < 2) { box.textContent = "Menos de 2 dimensiones categóricas: no hay Sankey posible."; return; }
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

        renderSelectors(); renderAll(); pushView();
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
      renderAll(); pushView();
    });
    const l = document.createElement("label"); l.append("Color", cs); box.appendChild(l);
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
      s.onclick = (e) => { e.stopPropagation(); Panel.toggleNode(S.colorKey, value); }; lg.appendChild(s);
    });
  }

  /* ---------- brushing & linking: fijado > hover > búsqueda ---------- */
  let hoverIds = null, searchIds = null;
  function setPinned(ids) { pinnedIds = ids && ids.size ? ids : null; paint(); }
  function setSearch(ids) { searchIds = ids || null; paint(); }
  // Filtrar: fija (o libera, si es la misma) la selección sin abrir la ficha; cierra la que estuviera abierta.
  function pin(ids) {
    const same = pinnedIds && ids && pinnedIds.size === ids.size && [...pinnedIds].every((v) => ids.has(v));
    Panel.close(); if (!same) setPinned(ids);
  }
  const onLabel = (ev) => !!(ev.target.closest && ev.target.closest(".lbl"));
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

    // --- «Orden»: solo las variables presentes en el color o en las columnas del sankey ---
    const sortDims = [];
    [...cols, S.colorKey].forEach((k) => {
      const d = k && S.ds.dimensions.find((x) => x.key === k);
      if (d && !sortDims.some((x) => x.key === d.key)) sortDims.push(d);
    });
    const sortOpts = [{ key: "value", label: "valor" }, ...sortDims.map((d) => ({ key: d.key, label: d.label }))];
    if (!sortOpts.some((o) => o.key === S.skSort)) S.skSort = "value";
    const sortSel = $("sk-sort");
    if (sortSel) {
      const sig = sortOpts.map((o) => o.key).join("|");
      if (sortSel.dataset.sig !== sig) {
        sortSel.innerHTML = sortOpts.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join("");
        sortSel.dataset.sig = sig;
      }
      if (sortSel.value !== S.skSort) sortSel.value = S.skSort;
    }
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
    const MARGIN = 170, TOP = 30, BOTTOM = 8, NODE_PAD = 12, LABEL_GAP = 4;

    // --- posiciones X aproximadas por columna (antes del layout) para dimensionar las etiquetas ---
    const colStep = cols.length > 1 ? (W - 2 * MARGIN) / (cols.length - 1) : 0;
    const approxX0 = (i) => MARGIN + i * colStep;

    // --- ajustar cada etiqueta a su ancho disponible y calcular la altura de su bloque ---
    [...nodes.values()].forEach((n) => {
      const idx = cols.indexOf(n.col), first = idx === 0, nameCol = n.col === "name";
      const x0 = approxX0(idx), x1 = x0 + 14;
      const labelX = first ? x0 - 6 : x1 + 6;
      const nextX0 = idx + 1 < cols.length ? approxX0(idx + 1) : null;
      let availW = first ? (x0 - 10) : (nextX0 != null ? nextX0 - 14 - labelX : (W - 10) - labelX);
      availW = Math.max(70, Math.min(260, availW));
      n.__lines = wrapLabel(n.label, availW, 1).map((ln) => fitText(ln, availW)); // una sola línea (la ficha muestra el resto)
      n.__availW = availW;
      n.__anchor = first ? "end" : "start";
      let extraLines = nameCol ? 1 + (Panel.hasExtra() ? 1 : 0) : 0;
      n.__blockLines = n.__lines.length + extraLines;
      n.__blockHeight = n.__blockLines * LINE_H;
    });

    // --- altura del gráfico: la base por filas, o la que exija TODA la pila de etiquetas de la
    //     columna más alta (las de dos líneas cuentan doble), con el padding que usa d3.sankey ---
    let labelReq = 0;
    cols.forEach((c) => {
      const ns = [...nodes.values()].filter((n) => n.col === c);
      const h = ns.reduce((a, n) => a + n.__blockHeight, 0) + Math.max(0, ns.length - 1) * NODE_PAD;
      labelReq = Math.max(labelReq, h);
    });
    let H = Math.max(420, perCol * rowH + 60, labelReq + TOP + BOTTOM);

    // --- orden de los nodos dentro de cada columna (control «Orden») ---
    const skMode = S.skSort || "value", reverse = !!S.skDesc;
    const dimOrder = new Map(((S.ds.dimensions.find((d) => d.key === skMode) || {}).values || []).map((v, i) => [v.value, i]));
    const nodeCmp = (a, b) => {
      if (a.col !== b.col) return 0;
      let c;
      if (skMode === "value") c = isTime(a.col) ? Dataset.timeValue(a.label) - Dataset.timeValue(b.label) // fechas cronológicas
        : b.value - a.value;                                                                              // mayor primero
      else if (skMode === "name") c = String(a.label).localeCompare(String(b.label), "es");
      else if (isTime(skMode)) {
        const ta = Dataset.timeValue(a.label), tb = Dataset.timeValue(b.label);
        c = ta !== tb ? ta - tb : String(a.label).localeCompare(String(b.label), "es");
      }
      else {
        // orden propio de la variable (el mismo que usa la leyenda)
        const ia = dimOrder.has(a.label) ? dimOrder.get(a.label) : 1e6;
        const ib = dimOrder.has(b.label) ? dimOrder.get(b.label) : 1e6;
        c = ia - ib || String(a.label).localeCompare(String(b.label), "es");
      }
      return reverse ? -c : c;
    };

    // Maqueta el sankey. `pad` reserva en cada borde el medio bloque que la etiqueta más alta
    // sobresale de su barra (d3 fija el primer y el último nodo a los bordes), para que la
    // primera y la última etiqueta quepan centradas en su nodo.
    const layout = (h, pad) => d3.sankey().nodeId((d) => d.id).nodeWidth(14).nodePadding(NODE_PAD)
      .nodeSort(nodeCmp)
      .extent([[MARGIN, TOP + pad.top], [W - MARGIN, h - BOTTOM - pad.bottom]])({ nodes: [...nodes.values()], links: [...links.values()] });

    // Etiquetas: cada una centrada en su barra. Si choca con la anterior, baja la BARRA junto con
    // su etiqueta (las alturas no cambian y los lazos se redibujan con la barra). Nunca se separan
    // una de otra: lo que no quepa se devuelve y el gráfico crece y se remaqueta.
    const placeLabels = (graph) => {
      const pad = { top: 0, bottom: 0 };
      let need = 0;
      cols.forEach((c) => {
        const arr = graph.nodes.filter((n) => n.col === c).sort((a, b) => a.y0 - b.y0);
        if (!arr.length) return;
        const first = arr[0], last = arr[arr.length - 1];
        pad.top = Math.max(pad.top, (first.__blockHeight - (first.y1 - first.y0)) / 2);
        pad.bottom = Math.max(pad.bottom, (last.__blockHeight - (last.y1 - last.y0)) / 2);
        let prev = -Infinity;
        arr.forEach((n) => {
          const bh = n.__blockHeight;
          let top = (n.y0 + n.y1 - bh) / 2;
          if (top < prev + LABEL_GAP) {
            const d = prev + LABEL_GAP - top;
            n.y0 += d; n.y1 += d; top += d;
          }
          n.__labelTop = top; prev = top + bh;
        });
        need = Math.max(need, prev - (H - BOTTOM));
      });
      return { top: Math.max(0, pad.top), bottom: Math.max(0, pad.bottom), need: Math.max(0, need) };
    };

    // Repite la maqueta hasta que los márgenes quedan estables y no falta altura.
    let g, pad = { top: 0, bottom: 0 };
    for (let pass = 0; ; pass++) {
      g = layout(H, pad);
      const r = placeLabels(g);
      const stable = Math.abs(r.top - pad.top) < 0.5 && Math.abs(r.bottom - pad.bottom) < 0.5;
      if (r.need < 1 && (stable || pass >= 4)) break;
      pad = { top: r.top, bottom: r.bottom };
      if (r.need > 0) H += r.need + 1;
    }

    const svg = host.append("svg").attr("viewBox", [0, 0, W, H]).attr("width", "100%")
      .style("aspect-ratio", `${W} / ${H}`).attr("role", "img");
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
      .on("click", (ev, d) => { ev.stopPropagation(); pin(d.ids); })
      .on("mousemove.tip", (ev, d) => Panel.tipLink(ev, d)).on("mouseleave.tip", Panel.tipHide);

    const ng = svg.append("g").selectAll("g").data(g.nodes).join("g").attr("class", "sk-node")
      .on("mouseenter", (_, d) => highlight(d.ids))
      .on("mouseleave", () => highlight(null))
      .on("click", (ev, d) => { ev.stopPropagation(); if (onLabel(ev)) Panel.toggleNode(d.col, d.label); else pin(d.ids); })
      .on("mousemove.tip", (ev, d) => Panel.tipNode(ev, d)).on("mouseleave.tip", Panel.tipHide);

    ng.append("rect").attr("x", (d) => d.x0).attr("y", (d) => d.y0).attr("width", (d) => d.x1 - d.x0)
      .attr("height", (d) => Math.max(2, d.y1 - d.y0)).attr("fill", (d) => (d.col === ck ? color(d.label) : NEUTRAL));

    const txt = ng.append("text").attr("class", "lbl").attr("text-anchor", (d) => d.__anchor);
    txt.each(function (d) {
      const sel = d3.select(this), labelX = d.__anchor === "end" ? d.x0 - 6 : d.x1 + 6;
      d.__lines.forEach((line, i) => {
        sel.append("tspan").attr("x", labelX).attr("y", d.__labelTop + i * LINE_H + LINE_H * 0.78).text(line);
      });
      let y = d.__labelTop + d.__lines.length * LINE_H;
      if (d.col !== "name") return;
      const it = items.find((i2) => i2.id === [...d.ids][0]);
      let dateText = "";
      if (it && it.__life && it.__life.valid) {
        const L = it.__life;
        dateText = L.mode === "life" ? `${L.birth} – ${L.alive ? "hoy" : L.death}` : `act. ${L.activeStart} – ${L.activeEnd}`;
      }
      sel.append("tspan").attr("x", labelX).attr("y", y + LINE_H * 0.78)
        .attr("fill", "var(--muted)").style("font-size", "9.5px").style("font-weight", "500").text(fitText(dateText, d.__availW, DATE_FONT));
      y += LINE_H;
      if (Panel.hasExtra()) sel.append("tspan").attr("x", labelX).attr("y", y + LINE_H * 0.78)
        .attr("fill", "var(--ink-3)").style("font-size", "9px").style("font-weight", "400").text(fitText(Panel.extra(it || {}), d.__availW, EXTRA_FONT));
    });
  }

  /* ---------- Timeline ---------- */
  const TL_FIXED = ["start", "end", "length", "name"];
  let gOrd = () => 0, gVal = () => "";
  const gKey = (it) => vals(it, S.colorKey)[0];
  function tlCmp(a, b) {
    const L = (i) => i.__life, st = (i) => L(i).birth ?? L(i).activeStart, nm = (i) => String(i.name || i.id), m = S.tlSort || "start";
    const c = m === "end" ? L(a).activeEnd - L(b).activeEnd : m === "length" ? L(a).activeYears - L(b).activeYears
      : m === "name" ? nm(a).localeCompare(nm(b), "es") : TL_FIXED.includes(m) ? 0 : gOrd(a) - gOrd(b);
    return c || st(a) - st(b) || nm(a).localeCompare(nm(b), "es");
  }
  // «Orden» de la timeline: nombre + variables activas (columnas o color) + variables temporales.
  function tlSortOpts() {
    const active = [], temp = [], has = (l, k) => l.some((x) => x.key === k);
    [...S.cols.filter(Boolean), S.colorKey].forEach((k) => {
      const d = k && k !== "name" ? S.ds.dimensions.find((x) => x.key === k) : null;
      if (d && !has(active, d.key) && !has(temp, d.key)) active.push(d);
    });
    S.ds.dimensions.filter((d) => d.derived).forEach((d) => {
      if (!has(active, d.key) && !has(temp, d.key)) temp.push(d);
    });
    const opts = [
      { key: "name", label: "nombre" },
      ...active.map((d) => ({ key: d.key, label: d.label })),
      { key: "start", label: "inicio" }, { key: "end", label: "fin" }, { key: "length", label: "duración" },
      ...temp.map((d) => ({ key: d.key, label: d.label })),
    ];
    if (!opts.some((o) => o.key === S.tlSort)) S.tlSort = "start";
    const sel = $("tl-sort");
    if (sel) {
      const sig = opts.map((o) => o.key).join("|");
      if (sel.dataset.sig !== sig) {
        sel.innerHTML = opts.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join("");
        sel.dataset.sig = sig;
      }
      if (sel.value !== S.tlSort) sel.value = S.tlSort;
    }
    return opts;
  }
  function renderTimeline(animate) {
    tlSortOpts();
    const host = d3.select("#timeline"), prev = new Map();
    host.selectAll(".tl-row").each(function (d) { prev.set(d.id, this.__y); });
    host.selectAll("*").remove();
    const rows = S.ds.items.filter((i) => i.__life.valid);
    if (!rows.length) { host.append("p").attr("class", "empty").text("Sin ítems con fechas válidas."); return; }
    const dimKey = TL_FIXED.includes(S.tlSort) ? null : S.tlSort;
    const dim = S.ds.dimensions.find((x) => x.key === dimKey), ord = new Map((dim ? dim.values : []).map((v, i) => [v.value, i]));
    gVal = (it) => vals(it, dimKey)[0];
    gOrd = (it) => (ord.has(gVal(it)) ? ord.get(gVal(it)) : 1e6);
    rows.sort(tlCmp); if (S.tlDesc) rows.reverse();
    const grouped = S.tlSort === S.colorKey && S.tlSort !== "name", RH = 16, T = 30, LW = 200, W = 1100, GAP = 22;
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
      .on("click", (ev, d) => { ev.stopPropagation(); if (onLabel(ev)) Panel.toggleItem(d.id); else pin(new Set([d.id])); })
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

  /* ---------- historial de vistas: Volver / Restablecer ---------- */
  const VH = [];
  const snap = () => JSON.stringify({ cols: S.cols, colorKey: S.colorKey, tlSort: S.tlSort || "start", tlDesc: !!S.tlDesc, skSort: S.skSort || "value", skDesc: !!S.skDesc, cohort: Dataset.CFG.COHORT_SIZE });
  function updateNav() { $("view-back").disabled = VH.length < 2; }
  function pushView() { const v = snap(); if (VH[VH.length - 1] !== v) VH.push(v); if (VH.length > 50) VH.shift(); updateNav(); }
  function applyView(json) {
    const v = JSON.parse(json);
    S.cols = v.cols; S.colorKey = v.colorKey; S.tlSort = v.tlSort; S.tlDesc = v.tlDesc;
    S.skSort = v.skSort || "value"; S.skDesc = !!v.skDesc;
    $("tl-sort").value = v.tlSort; $("tl-dir").classList.toggle("desc", v.tlDesc);
    $("sk-sort").value = S.skSort; $("sk-dir").classList.toggle("desc", S.skDesc);
    if (v.cohort !== Dataset.CFG.COHORT_SIZE) {
      Dataset.CFG.COHORT_SIZE = v.cohort; $("cohort-slider").value = v.cohort; $("cohort-val").textContent = v.cohort;
      S.ds = Dataset.analyze(S.ds.items, { currentYear: CY, file: S.file, format: S.ds.report.format, delimiter: S.ds.report.delimiter });
    }
    updateColorScale(S.ds.dimensions); renderSelectors(); renderAll(); updateNav();
  }
  function back() { if (VH.length < 2) return; VH.pop(); applyView(VH[VH.length - 1]); }
  function resetView() {
    if (!S.ds || !S.ds.items.length) return;
    const d = S.ds.defaults.length >= 2 ? S.ds.defaults : S.ds.dimensions.slice(0, 3).map((x) => x.key);
    const cols = [d[0], d[1], d[2] || null].filter((x, i) => x || i < 2);
    applyView(JSON.stringify({ cols, colorKey: cols[0] || null, tlSort: "start", tlDesc: false, skSort: "value", skDesc: false, cohort: 50 }));
    const q = $("search"); q.value = ""; q.dispatchEvent(new Event("input"));
    Panel.close(); pushView();
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
      S.tlDesc = !S.tlDesc; e.currentTarget.classList.toggle("desc", S.tlDesc);
      e.currentTarget.setAttribute("aria-label", S.tlDesc ? "Orden descendente" : "Orden ascendente"); renderTimeline(true);
    });
    $("sk-sort").addEventListener("change", (e) => { S.skSort = e.target.value; renderSankey(); paint(); pushView(); });
    $("sk-dir").addEventListener("click", (e) => {
      S.skDesc = !S.skDesc; e.currentTarget.classList.toggle("desc", S.skDesc);
      renderSankey(); paint(); pushView();
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

    $("view-back").onclick = back; $("view-reset").onclick = resetView;
    $("tl-sort").addEventListener("change", pushView); $("tl-dir").addEventListener("click", pushView);
    $("cohort-slider").addEventListener("change", pushView);
    document.addEventListener("keydown", (e) => { if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); if (!Panel.back()) back(); } });
    const setTheme = (t, save) => {
      document.documentElement.dataset.theme = t;
      $("theme").title = t === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
      if (save) try { localStorage.setItem("theme", t); } catch (x) { /* ignore */ }
      if (S.ds) { updateColorScale(S.ds.dimensions); renderAll(); }
    };
    $("theme").title = dark() ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
    $("theme").onclick = () => setTheme(dark() ? "light" : "dark", true);
    // Sin seguimiento del tema del sistema: el valor por defecto es claro y solo cambia con el botón.

    const fsCtl = FolderSelector.setup({ container: $("fs"), dataDir: "data/", onText: boot });
    S.api.reloadFile = () => { if (S.file) fsCtl.select(S.file); };

    $("add-author").onclick = () => Panel.addAuthor();
  });
  S.api = { CY, WARN, color: () => color, cols: () => S.cols, renderAll, reanalyze, setPinned, setSearch };
  window.__app = S;
})();
