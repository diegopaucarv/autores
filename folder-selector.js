/* folder-selector.js — selector de archivos .csv/.json de una carpeta */
(function (root) {
  "use strict";
  const EXT = /\.(csv|json)$/i;

  function setup({ container, dataDir = "data/", onText, onStatus }) {
    const files = new Map();
    const wrap = document.createElement("div");
    wrap.className = "fs";
    wrap.innerHTML = `
      <label>Dataset <select aria-label="Archivo de datos"></select></label>
      <button type="button" data-act="reload" title="Volver a listar ${dataDir}">↻</button>
      <button type="button" data-act="folder">📁 Carpeta…</button>
      <button type="button" data-act="files">＋ Archivo…</button>
      <span class="fs-msg"></span>
      <input type="file" accept=".csv,.json,text/csv,application/json" multiple hidden data-in="files">
      <input type="file" webkitdirectory multiple hidden data-in="folder">`;
    container.appendChild(wrap);
    const sel = wrap.querySelector("select"), msg = wrap.querySelector(".fs-msg");
    const say = (t) => { msg.textContent = t || ""; onStatus && onStatus(t); };

    function fill(keepName) {
      sel.innerHTML = "";
      const names = [...files.keys()].sort((a, b) => a.localeCompare(b, "es"));
      if (!names.length) { sel.innerHTML = '<option value="">(sin archivos)</option>'; return; }
      names.forEach((n) => { const o = document.createElement("option"); o.value = o.textContent = n; sel.appendChild(o); });
      if (keepName && files.has(keepName)) sel.value = keepName;
    }

    async function listServer() {
      const base = new URL(dataDir, document.baseURI);
      let names = null;
      try {
        const r = await fetch(new URL("manifest.json", base), { cache: "no-store" });
        if (r.ok) { const j = await r.json(); names = Array.isArray(j) ? j : j.files; }
      } catch (e) { /* sigue */ }
      if (!names) {
        try {
          const r = await fetch(base, { cache: "no-store" });
          if (r.ok) {
            const doc = new DOMParser().parseFromString(await r.text(), "text/html");
            names = [...doc.querySelectorAll("a[href]")]
              .map((a) => decodeURIComponent((a.getAttribute("href") || "").split(/[?#]/)[0].split("/").pop()))
              .filter((n) => n && n.toLowerCase() !== "manifest.json");
          }
        } catch (e) { /* sigue */ }
      }
      if (!names) return false;
      names.filter((n) => EXT.test(n)).forEach((n) => files.set(n, { url: new URL(encodeURIComponent(n), base).href }));
      return true;
    }

    async function refresh() {
      files.forEach((v, k) => { if (v.url) files.delete(k); });
      const keep = sel.value || localGet();
      const ok = await listServer();
      
      // FALLBACK TO DEFAULT DATA IF LOCAL file:// BLOCKED FETCH
      if (!ok && typeof window.DEFAULT_DATA !== "undefined") {
          files.set("data.js (integrado)", { isDefault: true });
          fill(keep || "data.js (integrado)");
          say(`Usando datos de data.js integrados (sin servidor).`);
          if (sel.value) load(sel.value);
          return;
      }

      fill(keep);
      if (!ok) say(`No pude listar ${dataDir} (¿file://?). Usa «Carpeta…» o «Archivo…».`);
      else if (!files.size) say(`${dataDir} no tiene .csv/.json.`);
      else say(`${files.size} archivo(s) en ${dataDir}`);
      if (sel.value) load(sel.value);
    }

    async function load(name) {
      const e = files.get(name); if (!e) return;
      try {
        say("Cargando " + name + "…");
        let text;
        if (e.isDefault) {
           text = window.DEFAULT_DATA;
        } else if (e.file) {
           text = await e.file.text();
        } else { 
           const r = await fetch(e.url, { cache: "no-store" }); 
           if (!r.ok) throw new Error("HTTP " + r.status); 
           text = await r.text(); 
        }
        localSet(name); say(name);
        onText(text, name);
      } catch (err) { say("Error: " + err.message); }
    }

    function addLocal(fileList) {
      const arr = [...fileList].filter((f) => EXT.test(f.name));
      arr.forEach((f) => files.set(f.name, { file: f }));
      fill(arr[0] && arr[0].name);
      if (!arr.length) return say("La selección no contiene .csv/.json");
      say(`${arr.length} archivo(s) local(es)`); load(sel.value);
    }

    async function pickFolder() {
      if (root.showDirectoryPicker) {
        try {
          const dir = await root.showDirectoryPicker();
          const found = [];
          for await (const [name, h] of dir.entries()) if (h.kind === "file" && EXT.test(name)) found.push(await h.getFile());
          return addLocal(found);
        } catch (e) { if (e.name === "AbortError") return; }
      }
      wrap.querySelector('[data-in="folder"]').click();
    }

    const localGet = () => { try { return localStorage.getItem("fs:last") || ""; } catch (e) { return ""; } };
    const localSet = (v) => { try { localStorage.setItem("fs:last", v); } catch (e) { /* ignore */ } };

    sel.addEventListener("change", () => load(sel.value));
    wrap.addEventListener("click", (ev) => {
      const act = ev.target.dataset && ev.target.dataset.act;
      if (act === "reload") refresh();
      if (act === "folder") pickFolder();
      if (act === "files") wrap.querySelector('[data-in="files"]').click();
    });
    wrap.querySelectorAll("input[type=file]").forEach((i) => i.addEventListener("change", () => { addLocal(i.files); i.value = ""; }));

    refresh();
    return { refresh, select: (n) => { sel.value = n; load(n); }, destroy: () => wrap.remove() };
  }

  root.FolderSelector = { setup };
})(typeof window !== "undefined" ? window : globalThis);