/* panel.js — ficha lateral, tooltips, columnas de texto, descripciones de categorías y edición con deshacer.
   Se enchufa a app.js mediante S.api. Persistencia en localStorage por archivo; exportable como <archivo>.meta.json */
(function (root) {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CORE = new Set(["id", "name", "birth", "death", "lifespan", "active"]);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  let S, A, file = "", desc = {}, edits = {}, hist = [], redoS = [], showText = new Set(), sel = null, descTimer = null;
  const SEP = () => Dataset.CFG.MULTI_SEP;
  const item = (id) => S.ds.items.find((i) => i.id === id);
  const toks = (it, k) => String(it[k] ?? "").split(SEP()).map((x) => x.trim()).filter(Boolean);
  const nameOf = (it) => (it && (it.name || it.id)) || "";
  const dimOf = (k) => S.ds.dimensions.find((d) => d.key === k);
  const editableDims = () => S.ds.dimensions.filter((d) => !d.derived && d.key !== "name");
  const descOf = (dim, v) => (desc[dim] && desc[dim][v]) || "";
  const idsOf = (dim, v) => new Set(S.ds.items.filter((it) => { const t = toks(it, dim); return v === "(vacío)" ? !t.length : t.includes(v); }).map((i) => i.id));

  function textCols() {
    const dk = new Set(S.ds.dimensions.map((d) => d.key)), seen = [];
    S.ds.items.forEach((it) => Object.keys(it).forEach((k) => {
      if (k.startsWith("__") || k.startsWith("d_") || CORE.has(k) || dk.has(k) || seen.includes(k)) return; seen.push(k);
    }));
    return seen;
  }

  /* ---------------- carga: aplica ediciones y descripciones guardadas ---------------- */
  function onLoad(ds, name) {
    file = name; desc = lsGet("desc:" + name, {}); edits = lsGet("ed:" + name, {}); hist = []; redoS = []; sel = null;
    let changed = false;
    ds.items.forEach((it) => { const e = edits[it.id]; if (e) for (const f in e) { it[f] = e[f].to; changed = true; } });
    if (changed) ds = Dataset.analyze(ds.items, { currentYear: A.CY, file: name, format: ds.report.format, delimiter: ds.report.delimiter });
    S.ds = ds;
    const tcs = textCols(); showText = new Set(lsGet("txt:" + name, tcs.slice(0, 1)).filter((c) => tcs.includes(c)));
    renderTextSel(); badge(); $("detail").classList.remove("open");
    return ds;
  }

  /* ---------------- edición con historial ---------------- */
  function record(id, field, old, value) {
    const e = (edits[id] = edits[id] || {}), from = e[field] ? e[field].from : old;
    if (from === value) delete e[field]; else e[field] = { from, to: value };
    if (!Object.keys(e).length) delete edits[id];
  }
  function setField(id, field, value, g) {
    const it = item(id); if (!it) return;
    const old = it[field] === undefined || it[field] === null ? "" : String(it[field]); value = String(value).trim();
    if (old === value) return;
    hist.push({ id, field, old, value, g }); redoS = []; record(id, field, old, value); it[field] = value;
  }
  function step(from, to, dirOld) {                       // deshacer / rehacer (con agrupación para renombrados)
    if (!from.length) return;
    const g = from[from.length - 1].g;
    do {
      const h = from.pop(); to.push(h); const it = item(h.id), a = dirOld ? h.value : h.old, b = dirOld ? h.old : h.value;
      record(h.id, h.field, a, b); if (it) it[h.field] = b;
    } while (g !== undefined && from.length && from[from.length - 1].g === g);
    commit();
  }
  const undo = () => step(hist, redoS, true), redo = () => step(redoS, hist, false);
  function discard() {
    if (!Object.keys(edits).length || !confirm("¿Descartar todos los cambios de este archivo?")) return;
    Object.entries(edits).forEach(([id, fs]) => { const it = item(id); if (it) Object.entries(fs).forEach(([f, e]) => { it[f] = e.from; }); });
    edits = {}; hist = []; redoS = []; commit();
  }
  function commit() { lsSet("ed:" + file, edits); badge(); A.reanalyze(); refreshSel(); }
  function badge() {
    const n = Object.values(edits).reduce((a, e) => a + Object.keys(e).length, 0);
    $("edit-badge").textContent = n ? `✎ ${n} cambio(s)` : "";
    $("undo").disabled = !hist.length; $("redo").disabled = !redoS.length; $("discard").disabled = !n;
  }

  /* ---------------- selección y ficha ---------------- */
  function showItem(id) { sel = { t: "item", id }; A.setPinned(new Set([id])); render(); }
  function showNode(dim, value) {
    const ids = idsOf(dim, value);
    if (dim === "name" && ids.size === 1) return showItem([...ids][0]);
    sel = { t: "node", dim, value }; A.setPinned(ids); render();
  }
  function close() { sel = null; $("detail").classList.remove("open"); A.setPinned(null); }
  function refreshSel() {
    if (!sel) return;
    if (sel.t === "item") { if (!item(sel.id)) return close(); A.setPinned(new Set([sel.id])); }
    else A.setPinned(idsOf(sel.dim, sel.value));
    render();
  }
  function render() { $("detail").classList.add("open"); sel.t === "item" ? renderItem() : renderNode(); wire(); }

  function lifeText(it) {
    const L = it.__life || {};
    if (!L.valid) return "sin fechas válidas" + (L.reason ? " (" + L.reason + ")" : "");
    return L.mode === "life" ? `${L.birth} – ${L.alive ? "hoy" : L.death} · ${L.age} años` : `actividad ${L.activeStart} – ${L.activeEnd}`;
  }

  function renderItem() {
    const it = item(sel.id), L = it.__life || {};
    const dimField = (d) => {
      const cur = toks(it, d.key), vals = d.values.map((v) => v.value).filter((v) => v !== "(vacío)");
      let ctl;
      if (d.multi) ctl = `<div class="chips">${vals.map((v) => `<label class="ck"><input type="checkbox" data-f="${esc(d.key)}" data-v="${esc(v)}" ${cur.includes(v) ? "checked" : ""}>${esc(v)}</label>`).join("")}<button class="mini" data-new="${esc(d.key)}" title="Nueva categoría">＋</button></div>`;
      else {
        const all = !cur[0] || vals.includes(cur[0]) ? vals : [cur[0], ...vals];
        ctl = `<select data-f="${esc(d.key)}"><option value="">(vacío)</option>${all.map((v) => `<option ${v === cur[0] ? "selected" : ""}>${esc(v)}</option>`).join("")}<option value="__new">➕ nueva categoría…</option></select>`;
      }
      const ds = cur.map((v) => descOf(d.key, v)).filter(Boolean).join(" · ");
      return `<div class="fld"><label>${esc(d.label)}</label>${ctl}${ds ? `<div class="hint">${esc(trunc(ds, 260))}</div>` : ""}</div>`;
    };
    $("detail").innerHTML = `<button class="x" data-act="close" title="Cerrar (Esc)">✕</button>
      <input class="title" data-f="name" value="${esc(it.name || "")}" aria-label="Nombre">
      <div class="sub">${esc(lifeText(it))}</div>
      ${(L.warnings || []).map((w) => `<span class="chip w">${esc(A.WARN[w] || w)}</span>`).join("")}
      <div class="row2"><div class="fld"><label>Nacimiento</label><input data-f="birth" value="${esc(it.birth)}"></div>
        <div class="fld"><label>Muerte <small>(vacío = vivo)</small></label><input data-f="death" value="${esc(it.death)}"></div></div>
      <h3>Categorías</h3>${editableDims().map(dimField).join("") || '<div class="hint">Sin dimensiones editables.</div>'}
      ${textCols().length ? "<h3>Texto</h3>" : ""}${textCols().map((c) => `<div class="fld"><label>${esc(c)}</label><textarea data-f="${esc(c)}" rows="3">${esc(it[c])}</textarea></div>`).join("")}`;
  }

  function renderNode() {
    const d = dimOf(sel.dim), ids = idsOf(sel.dim, sel.value);
    const members = S.ds.items.filter((i) => ids.has(i.id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b), "es"));
    $("detail").innerHTML = `<button class="x" data-act="close" title="Cerrar (Esc)">✕</button>
      <div class="sub">${esc(d ? d.label : sel.dim)}</div>
      <h2><i class="dot" style="background:${A.color()(sel.value)}"></i>${esc(sel.value)}</h2>
      <div class="sub">${ids.size} ítem(s)</div>
      <div class="fld"><label>Descripción de la categoría</label>
        <textarea data-desc rows="5" placeholder="Qué significa, criterios de pertenencia…">${esc(descOf(sel.dim, sel.value))}</textarea></div>
      ${d && !d.derived ? `<div class="fld"><label>Renombrar (afecta a todos sus ítems)</label><div class="row2"><input data-rename value="${esc(sel.value)}"><button class="mini" data-act="rename">Aplicar</button></div></div>` : ""}
      <h3>Miembros</h3><div class="members">${members.map((m) => `<button class="mem" data-id="${esc(m.id)}">${esc(nameOf(m))}</button>`).join("")}</div>`;
  }

  function wire() {
    const box = $("detail");
    box.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", () => onField(el)));
    box.querySelectorAll("[data-new]").forEach((b) => b.addEventListener("click", () => {
      const v = prompt("Nueva categoría para «" + ((dimOf(b.dataset.new) || {}).label || b.dataset.new) + "»");
      if (v && v.trim()) { setField(sel.id, b.dataset.new, [...toks(item(sel.id), b.dataset.new), v.trim()].join(SEP())); commit(); }
    }));
    box.querySelectorAll("[data-act=close]").forEach((b) => b.addEventListener("click", close));
    box.querySelectorAll(".mem").forEach((b) => b.addEventListener("click", () => showItem(b.dataset.id)));
    const ta = box.querySelector("[data-desc]");
    if (ta) ta.addEventListener("input", () => {
      clearTimeout(descTimer);
      descTimer = setTimeout(() => { (desc[sel.dim] = desc[sel.dim] || {})[sel.value] = ta.value; if (!ta.value.trim()) delete desc[sel.dim][sel.value]; lsSet("desc:" + file, desc); }, 300);
    });
    const rb = box.querySelector("[data-act=rename]");
    if (rb) rb.addEventListener("click", () => rename(sel.dim, sel.value, box.querySelector("[data-rename]").value));
  }

  function onField(el) {
    const f = el.dataset.f, id = sel.id;
    if (el.type === "checkbox") {
      const t = toks(item(id), f), v = el.dataset.v;
      setField(id, f, (el.checked ? [...new Set([...t, v])] : t.filter((x) => x !== v)).join(SEP()));
    } else if (el.value === "__new") {
      const v = prompt("Nombre de la nueva categoría");
      if (!v || !v.trim()) return refreshSel();
      setField(id, f, v.trim());
    } else setField(id, f, el.value);
    commit();
  }

  function rename(dim, from, to) {
    to = String(to).trim(); if (!to || to === from) return;
    const g = Date.now();
    S.ds.items.forEach((it) => {
      const t = toks(it, dim); if (!t.includes(from)) return;
      setField(it.id, dim, t.map((x) => (x === from ? to : x)).filter((x, i, a) => a.indexOf(x) === i).join(SEP()), g);
    });
    if (desc[dim] && desc[dim][from] !== undefined) { desc[dim][to] = desc[dim][to] || desc[dim][from]; delete desc[dim][from]; lsSet("desc:" + file, desc); }
    sel.value = to; commit();
  }

  /* ---------------- tooltips ---------------- */
  function tip(ev, html) { const t = $("tip"); t.innerHTML = html; t.classList.add("show"); place(ev); }
  function place(ev) {
    const t = $("tip"), pad = 14, w = t.offsetWidth, h = t.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > innerWidth - pad) x = ev.clientX - w - pad; if (y + h > innerHeight - pad) y = ev.clientY - h - pad;
    t.style.left = x + "px"; t.style.top = y + "px";
  }
  const tipHide = () => $("tip").classList.remove("show");
  function tipItem(ev, it) {
    if (!it) return;
    const texts = [...showText].map((c) => it[c] ? `<div><span class="m">${esc(c)}:</span> ${esc(trunc(it[c], 170))}</div>` : "").join("");
    const cats = A.cols().filter((c) => c !== "name").map((c) => toks(it, c).join(", ")).filter(Boolean).join(" · ");
    const w = ((it.__life || {}).warnings || []).map((x) => A.WARN[x] || x);
    tip(ev, `<b>${esc(nameOf(it))}</b><div class="m">${esc(lifeText(it))}</div>${cats ? `<div>${esc(cats)}</div>` : ""}${texts}${w.length ? `<div class="warn">⚠ ${esc(w.join(", "))}</div>` : ""}<div class="m">clic: ficha</div>`);
  }
  function tipNode(ev, d) {
    if (d.col === "name") { const id = [...d.ids][0]; return tipItem(ev, item(id)); }
    const de = descOf(d.col, d.label), dm = dimOf(d.col);
    tip(ev, `<b>${esc(d.label)}</b><div class="m">${esc(dm ? dm.label : d.col)} · ${d.ids.size} ítem(s)</div>${de ? `<div>${esc(trunc(de, 240))}</div>` : ""}<div class="m">clic: ficha y descripción</div>`);
  }
  function tipLink(ev, d) {
    const names = [...d.ids].map((i) => nameOf(item(i))).slice(0, 6).join(", ");
    tip(ev, `<b>${esc(d.source.label)} → ${esc(d.target.label)}</b><div class="m">${d.ids.size} ítem(s)</div><div>${esc(names)}${d.ids.size > 6 ? "…" : ""}</div>`);
  }
  const extra = (it) => { for (const c of showText) if (it[c]) return trunc(it[c], 70); return ""; };

  /* ---------------- barra superior: texto, búsqueda, notas ---------------- */
  function renderTextSel() {
    const tcs = textCols(), box = $("textsel");
    box.hidden = !tcs.length; $("textsel-n").textContent = showText.size;
    $("textsel-list").innerHTML = tcs.map((c) => `<label><input type="checkbox" value="${esc(c)}" ${showText.has(c) ? "checked" : ""}> ${esc(c)}</label>`).join("");
  }
  function search(q) {
    q = norm(q).trim();
    if (!q) { $("search-n").textContent = ""; return A.setPinned(null); }
    const tcs = textCols(), ds = S.ds.dimensions.map((d) => d.key);
    const ids = new Set(S.ds.items.filter((it) => [it.name, ...tcs.map((c) => it[c]), ...ds.map((k) => it[k])].some((v) => norm(v).includes(q))).map((i) => i.id));
    $("search-n").textContent = ids.size + " resultado(s)"; A.setPinned(ids);
  }
  function download(name, body, type) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function importMeta(f) {
    f.text().then((t) => {
      const m = JSON.parse(t), g = Date.now();
      if (m.descriptions) { Object.entries(m.descriptions).forEach(([d, o]) => { desc[d] = Object.assign(desc[d] || {}, o); }); lsSet("desc:" + file, desc); }
      if (m.edits) Object.entries(m.edits).forEach(([id, fs]) => Object.entries(fs).forEach(([fld, e]) => setField(id, fld, e.to, g)));
      commit();
    }).catch((e) => alert("Archivo .meta.json inválido: " + e.message));
  }

  function init(state, api) {
    S = state; A = api;
    $("detail").addEventListener("click", (e) => e.stopPropagation());
    $("undo").onclick = undo; $("redo").onclick = redo; $("discard").onclick = discard;
    $("search").addEventListener("input", (e) => search(e.target.value));
    $("textsel-list").addEventListener("change", () => {
      showText = new Set([...$("textsel-list").querySelectorAll("input:checked")].map((i) => i.value));
      lsSet("txt:" + file, [...showText]); $("textsel-n").textContent = showText.size; A.renderAll();
    });
    $("meta-out").onclick = () => download(file.replace(/\.(csv|json)$/i, "") + ".meta.json", JSON.stringify({ file, descriptions: desc, edits }, null, 2), "application/json");
    $("meta-in").addEventListener("change", (e) => { if (e.target.files[0]) importMeta(e.target.files[0]); e.target.value = ""; });
    document.addEventListener("keydown", (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ""));
      if (e.key === "Escape" && sel) close();
      if (typing || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    });
  }

  root.Panel = { init, onLoad, showItem, showNode, close, tipItem, tipNode, tipLink, tipHide, place, extra, hasExtra: () => showText.size > 0, descOf };
})(typeof window !== "undefined" ? window : globalThis);
