/* dataset.js — capa de datos única: CSV + JSON → items normalizados */
(function (root) {
  "use strict";

  /* 0. Configuración */
  const CFG = {
    ACTIVE_START_AGE: 25,
    VERIFY_ALIVE_AGE: 95,
    MAX_AGE: 120,
    MIN_YEAR: -3000,
    COHORT_SIZE: 50,
    MULTI_SEP: "|",
    MIN_UNIQUE: 2,
    MAX_UNIQUE: 100,
    MAX_AVG_LEN: 45,
    MIN_COVERAGE: 0.5,
  };

  const strip = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

  const ALIASES = {
    name: ["nombre", "autor", "author", "title", "label"],
    birth: ["nacimiento", "born", "birth_year", "birthyear", "year_birth", "fecha_nacimiento"],
    death: ["muerte", "died", "death_year", "deathyear", "year_death", "fecha_muerte", "fallecimiento"],
    category: ["categoria"],
    tradition: ["tradicion"],
    gender: ["genero", "sexo"],
    country: ["pais"],
    lifespan: ["vida", "years", "anos"],
    active: ["anos_actividad", "years_active", "activity", "period", "active_years"],
  };
  const LEGACY_IGNORED = new Set(["span"]);

  const NON_DIMENSION = new Set([
    "id", "uuid", "url", "link", "image", "img", "photo", "avatar", "active", "concepto_clave", "obra_emblematica",
    "birth", "death", "lifespan", "highlight", "description", "descripcion", "bio",
    "summary", "resumen", "dates_note", "dates_verified", "country_note", "notes", "nota", "notas",
  ]);

  function sniffDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || "";
    let best = ",", bestN = -1;
    for (const d of [",", ";", "\t"]) {
      let n = 0, q = false;
      for (const ch of firstLine) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
      if (n > bestN) { best = d; bestN = n; }
    }
    return best;
  }

  function parseCSV(text, delimiter) {
    text = String(text).replace(/^\uFEFF/, "");
    const d = delimiter || sniffDelimiter(text);
    const rows = [];
    let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === d) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((v) => v.trim() !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    if (!rows.length) return { header: [], records: [], delimiter: d };
    const header = rows[0].map((h) => h.trim());
    const records = rows.slice(1).map((r) => {
      const o = {};
      header.forEach((h, i) => { if (h) o[h] = (r[i] ?? "").trim(); });
      return o;
    });
    return { header, records, delimiter: d };
  }

  function toCSV(items, columns, opts) {
    const cols = columns || publicColumns(items);
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\r\n;]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map(esc).join(",")];
    items.forEach((it) => lines.push(cols.map((c) => esc(it[c])).join(",")));
    return ((opts && opts.bom === false) ? "" : "\uFEFF") + lines.join("\n") + "\n";
  }

  function toJSON(items, columns) {
    const cols = columns || publicColumns(items);
    return items.map((it) => {
      const o = {};
      cols.forEach((c) => { o[c] = it[c] === "" ? null : it[c]; });
      return o;
    });
  }

  const isPublic = (k) => !k.startsWith("__") && !k.startsWith("d_");
  function publicColumns(items) {
    const seen = [];
    items.forEach((it) => Object.keys(it).forEach((k) => { if (isPublic(k) && !seen.includes(k)) seen.push(k); }));
    return seen;
  }

  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

  function flattenJSON(raw) {
    if (Array.isArray(raw)) return raw.filter(isObj);
    if (!isObj(raw)) return [];
    for (const k of ["authors", "data", "items", "records", "nodes", "entries"])
      if (Array.isArray(raw[k]) && raw[k].some(isObj)) return raw[k].filter(isObj);
    const keys = Object.keys(raw);
    const arrKeys = keys.filter((k) => Array.isArray(raw[k]) && raw[k].some(isObj));
    if (arrKeys.length && arrKeys.length === keys.length)
      return arrKeys.flatMap((k) => raw[k].filter(isObj).map((it) => ({ ...it, group: k })));
    for (const k of keys) {
      if (isObj(raw[k])) { const n = flattenJSON(raw[k]); if (n.length) return n; }
      if (Array.isArray(raw[k]) && raw[k].some(isObj)) return raw[k].filter(isObj);
    }
    return [];
  }

  function flattenRecord(rec) {
    const o = {};
    for (const [k, v] of Object.entries(rec)) {
      if (v === null || v === undefined) o[k] = "";
      else if (Array.isArray(v)) o[k] = v.filter((x) => x !== null && typeof x !== "object").join(CFG.MULTI_SEP);
      else if (typeof v === "object") continue;
      else o[k] = v;
    }
    return o;
  }

  const PRESENT = /^(present|presente|actual|current|now|hoy|vivo|vive|alive)$/i;

  function parseYear(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? { year: Math.trunc(raw), approx: false } : null;
    const s = String(raw).trim();
    if (!s) return null;
    if (PRESENT.test(s)) return { present: true };
    const m = s.match(/(\d{1,4})/);
    if (!m) return null;
    let year = parseInt(m[1], 10);
    const bce = /\b(a\.?\s?c\.?|bce|b\.c\.?)\b/i.test(s) || /^-/.test(s);
    if (bce) year = -year;
    const approx = /\b(c|ca|circa)\.?\s*\d/i.test(s) || /[?~]/.test(s);
    return { year, approx };
  }

  const century = (y) => (y === null ? null : y > 0 ? Math.ceil(y / 100) : -Math.ceil(Math.abs(y) / 100));

  function lifespan(item, currentYear) {
    const CY = currentYear || new Date().getFullYear();
    let b = parseYear(item.birth), d = parseYear(item.death);

    if (!b && typeof item.lifespan === "string" && item.lifespan.trim()) {
      const parts = item.lifespan.split(/\s*[–—-]\s*/);
      b = parseYear(parts[0]);
      if (parts.length > 1 && parts[1].trim()) d = parseYear(parts[1]);
    }

    const fail = (reason) => ({ valid: false, reason, warnings: [] });
    if (!b || b.present) {
      const act = typeof item.active === "string" ? item.active.split(/\s*[–—-]\s*/) : null;
      const a0 = act && parseYear(act[0]), a1 = act && act[1] ? parseYear(act[1]) : null;
      if (a0 && !a0.present) {
        const open = !a1 || a1.present, end = open ? CY : a1.year;
        if (end < a0.year) return fail("active_end_before_start");
        if (end > CY) return fail("death_in_future");
        return {
          valid: true, reason: null, mode: "active", warnings: ["no_birth"],
          birth: null, death: open ? null : end, alive: open, age: null, birthApprox: false,
          activeStart: a0.year, activeEnd: end, activeYears: end - a0.year,
          meanActive: a0.year + (end - a0.year) / 2,
          centuryBirth: null, centuryDeath: open ? null : century(end), century: century(end),
        };
      }
      return fail("no_birth");
    }
    if (b.year < CFG.MIN_YEAR || b.year > CY) return fail("birth_out_of_range");

    const warnings = [];
    const alive = !d || !!d.present;
    const deathYear = alive ? null : d.year;
    if (!alive && deathYear < b.year) return fail("death_before_birth");
    if (!alive && deathYear > CY) return fail("death_in_future");
    const end = alive ? CY : deathYear;
    const age = end - b.year;
    if (age > CFG.MAX_AGE) return fail("age_impossible");
    if (alive && age >= CFG.VERIFY_ALIVE_AGE && !String(item.dates_verified || "").trim()) warnings.push("verify_alive");
    if (b.approx) warnings.push("birth_approx");
    if (!alive && d.approx) warnings.push("death_approx");

    const activeStart = b.year + CFG.ACTIVE_START_AGE;
    const activeYears = Math.max(0, end - activeStart);
    return {
      valid: true, reason: null, mode: "life", warnings,
      birth: b.year, death: deathYear, alive, age, birthApprox: !!b.approx,
      activeStart, activeEnd: end, activeYears,
      meanActive: activeStart + activeYears / 2,
      centuryBirth: century(b.year), centuryDeath: alive ? null : century(deathYear),
      century: century(end),
    };
  }

  const ROMAN = (n) => {
    const m = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let r = "", x = Math.abs(n);
    for (const [v, s] of m) while (x >= v) { r += s; x -= v; }
    return n < 0 ? r + " a.C." : r;
  };

  const romanToInt = (s) => {
    const rom = { I:1, V:5, X:10, L:50, C:100, D:500, M:1000 };
    let num = 0;
    for (let i = 0; i < s.length; i++) {
      if (i < s.length - 1 && rom[s[i]] < rom[s[i+1]]) num -= rom[s[i]];
      else num += rom[s[i]];
    }
    return num;
  };

  const timeValue = (v) => {
    if (typeof v !== "string") return 0;
    if (/vivo|activo/i.test(v)) return 999999;
    const mCoh = v.match(/^(-?\d+)/);
    if (mCoh) return parseInt(mCoh[1], 10);
    const mCent = v.match(/S\. ([IVXLCDM]+)( a\.C\.)?/);
    if (mCent) {
       let val = romanToInt(mCent[1]);
       if (mCent[2]) val = -val;
       return val;
    }
    return 0;
  };


  function applyDerived(item) {
    const L = item.__life;
    ["d_status", "d_birth_century", "d_birth_cohort", "d_death_century", "d_active_cohort"].forEach((k) => delete item[k]);
    if (!L || !L.valid) return;
    
    // USAMOS LA VARIABLE CONFIGURADA DINAMICAMENTE AHORA
    const lo25 = Math.floor(L.activeStart / CFG.COHORT_SIZE) * CFG.COHORT_SIZE;
    item.d_active_cohort = `${lo25}–${lo25 + CFG.COHORT_SIZE - 1}`;
    
    if (L.mode === "active") { item.d_status = L.alive ? "Activo hasta hoy" : "Actividad cerrada"; item.d_death_century = L.alive ? "Activo hasta hoy" : "S. " + ROMAN(L.centuryDeath); return; }
    item.d_status = L.alive ? "Vivo" : "Fallecido";
    item.d_birth_century = "S. " + ROMAN(L.centuryBirth);
    const lo = Math.floor(L.birth / CFG.COHORT_SIZE) * CFG.COHORT_SIZE;
    item.d_birth_cohort = `${lo}–${lo + CFG.COHORT_SIZE - 1}`;
    item.d_death_century = L.alive ? "Vivo" : "S. " + ROMAN(L.centuryDeath);
  }
  const DERIVED_LABELS = {
    d_status: "Estado (vivo/fallecido)", d_birth_century: "Siglo de nacimiento",
    d_birth_cohort: "Cohorte de nacimiento", d_death_century: "Siglo de muerte", d_active_cohort: "Inicio de actividad (cohorte)",
  };

  const prettify = (k) => DERIVED_LABELS[k] ||
    k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^\w/, (c) => c.toUpperCase());

  const valuesOf = (item, key, multi) => {
    const v = item[key];
    if (v === null || v === undefined || String(v).trim() === "") return [];
    const s = String(v).trim();
    return multi ? s.split(CFG.MULTI_SEP).map((x) => x.trim()).filter(Boolean) : [s];
  };

  function detectDimensions(items) {
    const keys = new Set();
    items.forEach((it) => Object.keys(it).forEach((k) => { if (!k.startsWith("__")) keys.add(k); }));
    const dims = [];
    keys.forEach((k) => {
      if (k !== "name" && (NON_DIMENSION.has(strip(k)) || LEGACY_IGNORED.has(strip(k)))) return;
      const multi = items.some((it) => String(it[k] ?? "").includes(CFG.MULTI_SEP));
      const counts = new Map();
      let filled = 0, totalLen = 0, numeric = 0;
      items.forEach((it) => {
        const vs = valuesOf(it, k, multi);
        if (vs.length) filled++;
        vs.forEach((v) => { counts.set(v, (counts.get(v) || 0) + 1); totalLen += v.length; if (/^-?\d+(\.\d+)?$/.test(v)) numeric++; });
      });
      const n = counts.size, nVals = [...counts.values()].reduce((a, b) => a + b, 0);
      
      if (k !== "name") {
          if (n < CFG.MIN_UNIQUE || n > CFG.MAX_UNIQUE) return;
          if (nVals && totalLen / nVals > CFG.MAX_AVG_LEN) return;
          if (filled < items.length * CFG.MIN_COVERAGE) return;
          if (nVals && numeric / nVals > 0.9 && n > 12) return;
          if (n === filled && filled > 12 && !multi) return;
      } else if (n === 0) {
          return;
      }
      
      const fit = Math.exp(-Math.pow(Math.log(n / 7), 2) / (2 * 0.6 * 0.6));
      const score = k === "name" ? 0 : fit * (filled / items.length);
      
      const isTime = k.includes("cohort") || k.includes("century");
      let valsArr = [...counts.entries()].map(([v, c]) => ({ value: v, count: c }));
      if (isTime) {
          valsArr.sort((a, b) => timeValue(a.value) - timeValue(b.value));
      } else {
          valsArr.sort((a, b) => b.count - a.count);
      }

      dims.push({
        key: k, label: k === "name" ? "Nombre (Autor)" : prettify(k), derived: k.startsWith("d_"), multi,
        uniqueCount: n, coverage: filled / items.length, score: score,
        values: valsArr,
      });
    });
    return dims.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  }

  function entropy(counts, N) { let h = 0; counts.forEach((c) => { const p = c / N; h -= p * Math.log(p); }); return h; }
  function nmi(items, a, b) {
    const ca = new Map(), cb = new Map(), cab = new Map(); let N = 0;
    items.forEach((it) => {
      const x = String(it[a] ?? "").split(CFG.MULTI_SEP)[0].trim(), y = String(it[b] ?? "").split(CFG.MULTI_SEP)[0].trim();
      if (!x || !y) return; N++;
      ca.set(x, (ca.get(x) || 0) + 1); cb.set(y, (cb.get(y) || 0) + 1);
      const k = x + "\u0001" + y; cab.set(k, (cab.get(k) || 0) + 1);
    });
    if (!N) return 0;
    const ha = entropy(ca, N), hb = entropy(cb, N), hab = entropy(cab, N);
    const denom = Math.min(ha, hb);
    return denom ? Math.max(0, (ha + hb - hab) / denom) : 0;
  }

  function pickDefaults(items, dims, n = 3) {
    const pool = dims.filter((d) => !d.derived);
    const chosen = [];
    const take = (cands) => {
      while (chosen.length < n && cands.length) {
        let best = null, bestS = -1;
        cands.forEach((d) => {
          if (chosen.includes(d.key)) return;
          const red = chosen.length ? Math.max(...chosen.map((c) => nmi(items, c, d.key))) : 0;
          const s = d.score * (1 - 0.8 * red);
          if (s > bestS) { bestS = s; best = d; }
        });
        if (!best) break;
        chosen.push(best.key);
      }
    };
    take(pool);
    if (chosen.length < n) take(dims.filter((d) => d.derived));
    return chosen;
  }

  function slug(s) {
    return strip(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function canonicalize(records) {
    const renamed = {}, ignored = new Set();
    const present = new Set(records.flatMap((r) => Object.keys(r)));
    const map = {};
    for (const [canon, alts] of Object.entries(ALIASES)) {
      if (present.has(canon)) continue;
      for (const k of present) if (alts.includes(strip(k))) { map[k] = canon; renamed[k] = canon; break; }
    }
    const out = records.map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) {
        if (LEGACY_IGNORED.has(strip(k))) { ignored.add(k); continue; }
        o[map[k] || k] = v;
      }
      return o;
    });
    return { items: out, renamed, ignored: [...ignored] };
  }

  function mergeDuplicates(items) {
    const byKey = new Map(), out = [], merged = {}, conflicts = [];
    items.forEach((it) => {
      const k = it.name ? slug(it.name) : null;
      const prev = k && byKey.get(k);
      if (prev && (String(prev.birth ?? "") === String(it.birth ?? "") || !prev.birth || !it.birth)) {
        merged[prev.name] = (merged[prev.name] || 1) + 1;
        for (const [f, v] of Object.entries(it)) {
          if (v === "" || v === prev[f]) continue;
          if (f === "group") { const set = new Set(String(prev[f] || "").split(CFG.MULTI_SEP).filter(Boolean)); set.add(v); prev[f] = [...set].join(CFG.MULTI_SEP); }
          else if (prev[f] === "" || prev[f] === undefined) prev[f] = v;
          else if (!["highlight", "concepto_clave", "obra_emblematica"].includes(f))
            conflicts.push({ name: prev.name, field: f, kept: prev[f], other: v });
        }
      } else { if (k) byKey.set(k, it); out.push(it); }
    });
    return { items: out, merged, conflicts };
  }

  function refresh(items, currentYear) {
    items.forEach((it) => { it.__life = lifespan(it, currentYear); applyDerived(it); });
    return items;
  }

  function analyze(records, meta) {
    meta = meta || {};
    const canon = canonicalize(records);
    const { renamed, ignored } = canon;
    const mg = mergeDuplicates(canon.items);
    const items = mg.items;
    const used = new Set();
    items.forEach((it, i) => {
      let id = String(it.id || "").trim() || slug(it.name || "") || "row-" + (i + 1);
      let u = id, n = 2; while (used.has(u)) u = id + "-" + n++;
      used.add(u); it.id = u;
    });
    refresh(items, meta.currentYear);

    const dimensions = detectDimensions(items);
    const defaults = pickDefaults(items, dimensions);

    const invalid = items.filter((i) => !i.__life.valid);
    const valid = items.filter((i) => i.__life.valid);
    const tally = (arr) => arr.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {});
    return {
      items, dimensions, defaults, columns: publicColumns(items),
      report: {
        format: meta.format, delimiter: meta.delimiter, file: meta.file,
        total: items.length, valid: valid.length, invalid: invalid.length,
        reasons: tally(invalid.map((i) => i.__life.reason)),
        warnings: tally(valid.flatMap((i) => i.__life.warnings)),
        alive: valid.filter((i) => i.__life.alive).length,
        centuries: tally(valid.map((i) => i.__life.century)),
        renamedColumns: renamed, ignoredColumns: ignored,
        mergedDuplicates: mg.merged, conflicts: mg.conflicts,
        activeOnly: valid.filter((i) => i.__life.mode === "active").length,
        needsReview: valid.filter((i) => i.__life.warnings.includes("verify_alive")).map((i) => i.id),
      },
    };
  }

  function load(input, meta) {
    meta = meta || {};
    try {
      if (typeof input === "string") {
        const t = input.replace(/^\uFEFF/, "").trim();
        const ext = (meta.file || "").toLowerCase().split(".").pop();
        const looksJSON = /^[\[{]/.test(t) && ext !== "csv";
        if (looksJSON || ext === "json") return load(JSON.parse(t), { ...meta, format: "json" });
        const { records, delimiter } = parseCSV(t);
        return analyze(records, { ...meta, format: "csv", delimiter });
      }
      const records = flattenJSON(input).map(flattenRecord);
      return analyze(records, { ...meta, format: meta.format || "json" });
    } catch (e) {
      const empty = analyze([], meta);
      empty.report.error = String(e.message || e);
      return empty;
    }
  }

  const api = { load, analyze, refresh, parseCSV, toCSV, toJSON, parseYear, lifespan, flattenJSON, nmi, timeValue, CFG, DERIVED_LABELS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Dataset = api;
})(typeof window !== "undefined" ? window : globalThis);
