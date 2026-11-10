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
  // Ancho mínimo/máximo del lienzo; el mínimo debe coincidir con --chart-min del CSS.
  const CHART_MIN = 560, CHART_MAX = 1500;
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
    // El ancho interno sigue el ancho real del contenedor (se adapta al visor/ventana), con un piso
    // que coincide con el min-width del CSS: por debajo de ese piso, el panel se desplaza en horizontal
    // en vez de aplastar las etiquetas hasta volverlas ilegibles.
    const CW = host.node() && host.node().clientWidth;
    const W = Math.max(CHART_MIN, Math.min(CHART_MAX, CW || 1100));
    const perCol = d3.max(cols, (c) => [...nodes.values()].filter((n) => n.col === c).length);
    const isName = cols.includes("name");
    const rowH = isName ? (Panel.hasExtra() ? 46 : 34) : 22;
    const MARGIN = Math.max(90, Math.round(W * (170 / 1100))), TOP = 30, BOTTOM = 18, NODE_PAD = 12, LABEL_GAP = 4;

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

    // --- orden de los nodos dentro de cada columna (control «Orden»): la variable elegida manda en
    //     SU columna (alfabética; cronológica si es de fechas; por valor si se elige «valor») y las
    //     demás columnas se reordenan según la posición de sus lazos, para que se crucen lo menos
    //     posible. Se prueban varios órdenes (media y mediana, en los dos sentidos), gana el de menos
    //     cruces y se afina con sifting. ---
    const skMode = S.skSort || "value", reverse = !!S.skDesc, colMode = cols.includes(skMode);
    const cmpText = (a, b) => String(a).localeCompare(String(b), "es");

    // Color dominante de cada nodo (la categoría con más flujo entre sus lazos). Sólo se usa cuando
    // la variable elegida en «Orden» está en el color y no como columna: entonces no hay columna que
    // alfabetizar y lo que se ordena son las bandas de color de TODAS las columnas.
    const cw = new Map();
    [...links.values()].forEach((L) => {
      [L.source, L.target].forEach((id) => {
        if (!cw.has(id)) cw.set(id, new Map());
        const m2 = cw.get(id), v = L.cval == null ? "" : String(L.cval);
        m2.set(v, (m2.get(v) || 0) + L.value);
      });
    });
    const domOf = (id) => {
      const m2 = cw.get(id);
      if (!m2) return "";
      let best = "", bw = -1;
      m2.forEach((w, v) => { if (w > bw) { bw = w; best = v; } });
      return best;
    };

    const ownCmp = (a, b) => {
      let c;
      if (skMode === "value") c = isTime(a.col) ? Dataset.timeValue(a.label) - Dataset.timeValue(b.label) // fechas cronológicas
        : b.value - a.value;                                                                              // mayor primero
      else if (!colMode) { // variable de color: bandas por color dominante, y dentro de la banda, alfabético
        const ca = domOf(a.id), cb = domOf(b.id);
        c = ca === cb ? cmpText(a.label, b.label) : cmpText(ca, cb);
      }
      else if (isTime(skMode)) {
        const ta = Dataset.timeValue(a.label), tb = Dataset.timeValue(b.label);
        c = ta !== tb ? ta - tb : cmpText(a.label, b.label);
      }
      else c = cmpText(a.label, b.label); // alfabético
      return reverse ? -c : c;
    };

    // columna ancla: la de la variable elegida. En «valor», la del color (o la primera). Si la variable
    // elegida está sólo en el color no hay ancla fija y se reordena todo (por bandas de color).
    let anchor;
    if (skMode === "value") { anchor = cols.indexOf(S.colorKey); if (anchor < 0) anchor = 0; }
    else anchor = cols.indexOf(skMode);

    const colNodes = new Map(cols.map((c) => [c, [...nodes.values()].filter((n) => n.col === c)]));
    const own = new Map(cols.map((c) => [c, [...colNodes.get(c)].sort(ownCmp).map((n) => n.id)]));
    const outL = new Map(), inL = new Map(), pushL = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    [...links.values()].forEach((L) => {
      const s = nodes.get(L.source), t = nodes.get(L.target);
      if (!s || !t) return;
      pushL(outL, s.id, { id: t.id, w: L.value });
      pushL(inL, t.id, { id: s.id, w: L.value });
    });
    const relRank = (ids) => new Map(ids.map((id, i) => [id, ids.length > 1 ? i / (ids.length - 1) : 0.5]));

    // Reordena la columna `c` por la posición (media o mediana, ponderadas por flujo) de sus lazos en
    // la columna vecina ya ordenada (`via` dice si miramos los que entran o los que salen). La mediana
    // es más robusta cuando un lazo domina; la media, más suave. Se prueban las dos.
    const flowOrder = (c, near, via, median) => {
      const adj = via === "in" ? inL : outL, score = new Map();
      colNodes.get(c).forEach((n) => {
        const ws = [];
        (adj.get(n.id) || []).forEach((L2) => {
          const r = near.get(L2.id);
          if (r != null) ws.push([r, L2.w]);
        });
        if (!ws.length) { score.set(n.id, null); return; }
        if (!median) { let s = 0, w = 0; ws.forEach(([r, w2]) => { s += r * w2; w += w2; }); score.set(n.id, w > 0 ? s / w : null); return; }
        ws.sort((a, b) => a[0] - b[0]);
        let acc = 0, med = ws[ws.length - 1][0];
        const half = ws.reduce((s, x) => s + x[1], 0) / 2;
        for (const [r, w2] of ws) { acc += w2; if (acc >= half) { med = r; break; } }
        score.set(n.id, med);
      });
      return [...colNodes.get(c)].sort((a, b) => {
        const A = score.get(a.id), B = score.get(b.id);
        if (A != null && B != null && Math.abs(A - B) > 1e-6) return A - B;
        if (A != null && B == null) return -1;
        if (A == null && B != null) return 1;
        return ownCmp(a, b); // desempate: el orden propio de la columna
      }).map((n) => n.id);
    };

    // Una pasada desde la columna ancla: hacia la derecha (de padre a ramas) o hacia la izquierda
    // (de ramas a padre). Sin ancla (anchor = -1) se barren todas las columnas.
    const sweep = (ord, dir, median) => {
      if (dir > 0) for (let i = Math.max(0, anchor + 1); i < cols.length; i++) ord.set(cols[i], flowOrder(cols[i], i > 0 ? relRank(ord.get(cols[i - 1])) : new Map(), "in", median));
      else for (let i = Math.min(cols.length - 1, anchor - 1); i >= 0; i--) ord.set(cols[i], flowOrder(cols[i], i + 1 < cols.length ? relRank(ord.get(cols[i + 1])) : new Map(), "out", median));
      return ord;
    };

    // Cruces reales entre columnas vecinas para un orden dado (aquí hay pocas decenas de lazos).
    const crossings = (ord) => {
      let total = 0;
      for (let i = 0; i + 1 < cols.length; i++) {
        const pa = new Map(ord.get(cols[i]).map((id, k) => [id, k])), pb = new Map(ord.get(cols[i + 1]).map((id, k) => [id, k])), e = [];
        [...links.values()].forEach((L) => {
          const s = nodes.get(L.source), t = nodes.get(L.target);
          if (!s || !t || s.col !== cols[i] || t.col !== cols[i + 1]) return;
          const a = pa.get(s.id), b = pb.get(t.id);
          if (a != null && b != null) e.push([a, b]);
        });
        e.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        for (let m = 0; m < e.length; m++) for (let k = m + 1; k < e.length; k++) if (e[k][1] < e[m][1]) total++;
      }
      return total;
    };

    // Sifting: mueve cada nodo de su columna a la posición que deja menos cruces con sus vecinas
    // (lazos que entran y que salen). Al mover un nodo sólo cambia su orden respecto a los demás de
    // su propia columna, así que cada prueba cuesta O(grado²) y una pasada completa es barata.
    // La columna ancla NO se toca: ahí manda el orden elegido en el desplegable.
    const sift = (ord) => {
      const o = new Map(cols.map((c) => [c, [...ord.get(c)]]));
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        for (let ci = 0; ci < cols.length; ci++) {
          if (ci === anchor) continue;
          const c = cols[ci], cL = ci > 0 ? cols[ci - 1] : null, cR = ci + 1 < cols.length ? cols[ci + 1] : null;
          const pL = cL ? new Map(o.get(cL).map((id, i) => [id, i])) : null;
          const pR = cR ? new Map(o.get(cR).map((id, i) => [id, i])) : null;
          const li = new Map(), ri = new Map(); // nodo → índices de sus lazos en la columna vecina
          [...links.values()].forEach((L) => {
            const s = nodes.get(L.source), t = nodes.get(L.target);
            if (!s || !t) return;
            if (pL && s.col === cL && t.col === c) pushL(li, t.id, pL.get(s.id));
            if (pR && s.col === c && t.col === cR) pushL(ri, s.id, pR.get(t.id));
          });
          // cruces entre los lazos de `n` y los de `m` según quién va primero
          const crossNM = (n, m, nFirst) => {
            const sgn = nFirst ? 1 : -1;
            let k = 0;
            const A = li.get(n) || [], B = li.get(m) || [], A2 = ri.get(n) || [], B2 = ri.get(m) || [];
            for (const a of A) for (const b of B) if ((a - b) * sgn > 0) k++;
            for (const a of A2) for (const b of B2) if ((a - b) * sgn > 0) k++;
            return k;
          };
          const order = o.get(c);
          for (let k = 0; k < order.length; k++) {
            const id = order[k], others = order.filter((x) => x !== id);
            const pre = new Array(others.length + 1).fill(0), post = new Array(others.length + 1).fill(0);
            for (let m = 0; m < others.length; m++) pre[m + 1] = pre[m] + crossNM(id, others[m], false); // id detrás
            for (let m = others.length - 1; m >= 0; m--) post[m] = post[m + 1] + crossNM(id, others[m], true); // id delante
            let bk = 0, bc = Infinity;
            for (let p2 = 0; p2 <= others.length; p2++) { const v = pre[p2] + post[p2]; if (v < bc) { bc = v; bk = p2; } }
            if (bk !== k) { others.splice(bk, 0, id); order.length = 0; order.push(...others); moved = true; }
          }
        }
        if (!moved) break;
      }
      return o;
    };

    // Candidatos: media y mediana, cada una barriendo en los dos sentidos, más el orden propio (así
    // nunca queda peor que el orden de la variable). Gana el de menos cruces y luego se afina.
    const cands = [
      sweep(sweep(new Map(own), +1, false), -1, false), // media, padre → ramas → padre
      sweep(sweep(new Map(own), -1, false), +1, false), // media, ramas → padre → ramas
      sweep(sweep(new Map(own), +1, true), -1, true),   // mediana, padre → ramas → padre
      sweep(sweep(new Map(own), -1, true), +1, true),   // mediana, ramas → padre → ramas
      own,
    ];
    let best = cands[0], bestX = Infinity;
    cands.forEach((o) => { const x = crossings(o); if (x < bestX) { best = o; bestX = x; } });
    const refined = sift(best);
    if (crossings(refined) < bestX) best = refined;
    cols.forEach((c) => best.get(c).forEach((id, i) => { const n = nodes.get(id); if (n) n.__rank = i; }));
    const nodeCmp = (a, b) => (a.col !== b.col ? 0 : (a.__rank ?? 0) - (b.__rank ?? 0));

    // Maqueta el sankey. El marco no reserva márgenes extra: el reparto vertical de abajo ya deja
    // entrar la primera y la última etiqueta.
    const layout = (h) => d3.sankey().nodeId((d) => d.id).nodeWidth(14).nodePadding(NODE_PAD)
      .nodeSort(nodeCmp)
      .extent([[MARGIN, TOP], [W - MARGIN, h - BOTTOM]])({ nodes: [...nodes.values()], links: [...links.values()] });

    // Reparto vertical de cada columna en UNA pasada: se buscan los centros de barra más cercanos a
    // los del layout que dejen sitio a cada bloque (etiqueta o barra, el mayor de los dos), o sea una
    // regresión isotónica (PAVA), exacta y O(n). Antes se crecía H y se remaquetaba en bucle y no
    // convergía: d3 estira las alturas de las barras para llenar el marco, así que agrandar el
    // gráfico se comía justo el hueco que necesitaban las etiquetas (~20 pasadas por render).
    const placeLabels = (graph) => {
      let need = 0;
      cols.forEach((c) => {
        const arr = graph.nodes.filter((n) => n.col === c).sort((a, b) => a.y0 - b.y0);
        const cnt = arr.length;
        if (!cnt) return;
        const m = arr.map((n) => Math.max(n.__blockHeight, n.y1 - n.y0)); // alto a respetar
        const off = [0]; // separación mínima acumulada respecto al primer bloque
        for (let i = 1; i < cnt; i++) off.push(off[i - 1] + (m[i - 1] + m[i]) / 2 + LABEL_GAP);
        // PAVA sobre u = centro - off: z no decreciente que minimiza Σ (z - u)²
        const z = [], w = [];
        for (let i = 0; i < cnt; i++) {
          z.push((arr[i].y0 + arr[i].y1) / 2 - off[i]); w.push(1);
          while (z.length > 1 && z[z.length - 2] > z[z.length - 1]) {
            const a = z.length - 2, W = w[a] + w[a + 1], S = z[a] * w[a] + z[a + 1] * w[a + 1];
            z[a] = S / W; w[a] = W; z.length--; w.length--;
          }
        }
        const zz = [];
        z.forEach((v, k) => { for (let j = 0; j < w[k]; j++) zz.push(v); });
        // Desplazamiento de la pila para entrar en el marco: si cabe, el mínimo que la deja dentro;
        // si no cabe (barras más altas que sus etiquetas), se ancla arriba y el sobrante se come el
        // margen inferior. Sólo si lo desborda se remaqueta con más alto.
        const top0 = zz[0] - m[0] / 2, bot0 = zz[cnt - 1] + off[cnt - 1] + m[cnt - 1] / 2;
        const span = bot0 - top0, avail = H - BOTTOM - TOP, fits = span <= avail;
        const shift = fits ? Math.min(Math.max(0, TOP - top0), H - BOTTOM - bot0) : TOP - top0;
        if (!fits) need = Math.max(need, span - avail);
        arr.forEach((n, i) => {
          const ctr = zz[i] + off[i] + shift, h = n.y1 - n.y0;
          n.y0 = ctr - h / 2; n.y1 = ctr + h / 2;
          n.__labelTop = ctr - n.__blockHeight / 2;
        });
      });
      return Math.max(0, need);
    };

    // Al mover las barras hay que reanudar los extremos de los lazos (d3 los fija en el layout).
    const syncLinks = (graph) => graph.nodes.forEach((n) => {
      n.sourceLinks.sort((a, b) => a.target.y0 - b.target.y0);
      n.targetLinks.sort((a, b) => a.source.y0 - b.source.y0);
      let sy = n.y0, ty = n.y0;
      n.sourceLinks.forEach((L) => { L.y0 = sy + L.width / 2; sy += L.width; });
      n.targetLinks.forEach((L) => { L.y1 = ty + L.width / 2; ty += L.width; });
    });

    // Una maqueta (y una segunda sólo si el sobrante no cabe en el margen inferior).
    let g = layout(H), needH = placeLabels(g);
    if (needH > BOTTOM) { H += Math.ceil(needH); g = layout(H); placeLabels(g); }
    syncLinks(g);

    // Tamaño natural 1:1: las etiquetas conservan sus 11px reales y el panel se
    // desplaza en horizontal cuando el SVG es más ancho que su contenedor.
    const svg = host.append("svg").attr("viewBox", [0, 0, W, H])
      .attr("width", W).attr("height", H).attr("role", "img");
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
    const hostEl = host.node(), CW = hostEl && hostEl.clientWidth;
    const W = Math.max(CHART_MIN, Math.min(CHART_MAX, CW || 1100));
    const grouped = S.tlSort === S.colorKey && S.tlSort !== "name", RH = 16, T = 30, LW = Math.min(200, Math.max(110, Math.round(W * 0.18))), GAP = 22;
    const yOf = new Map(), heads = []; let y = T, last;
    rows.forEach((it) => {
      if (grouped && gKey(it) !== last) { last = gKey(it); heads.push({ y, label: last }); y += GAP; }
      yOf.set(it.id, y); y += RH;
    });
    const H = y + 6, start = (i) => i.__life.birth ?? i.__life.activeStart;
    const x = d3.scaleLinear().domain([d3.min(rows, start), CY]).nice().range([LW, W - 12]);
    const svg = host.append("svg").attr("viewBox", [0, 0, W, H])
      .attr("width", W).attr("height", H);
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

    // Los gráficos usan el ancho real del contenedor: si la ventana cambia de tamaño (o el móvil
    // gira), se vuelven a maquetar para que las etiquetas se reajusten en vez de quedar desfasadas.
    let rTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(rTimer);
      rTimer = setTimeout(() => { if (S.ds) { renderSankey(); renderTimeline(); paint(); } }, 150);
    });
  });
  S.api = { CY, WARN, color: () => color, cols: () => S.cols, renderAll, reanalyze, setPinned, setSearch };
  window.__app = S;
})();
