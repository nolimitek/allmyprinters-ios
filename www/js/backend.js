/* AllMyPrinters — lokales Backend. Dieselben Aktionen und Antworten wie 3DSEARCH filament/api.php, nur liegen die Daten
 * auf dem Handy (eine JSON-Datei über AMPNative) und die Drucker werden direkt im Heimnetz gefragt (HTTP über AMPNative).
 * app.js (Oberfläche von /filament) ruft nur AMP.api(aktion, body, params) — sonst ändert sich dort fast nichts.
 * Zeiten wie auf dem Server: 'JJJJ-MM-TT HH:MM:SS' in UTC (die Oberfläche hängt 'Z' an).
 */
(() => {
'use strict';

// ── Brücke zum Handy ───────────────────────────────────────────────────────
let nseq = 0;
const waits = {}, evs = {};
window.AMP_cb = (id, ok, json) => {
  const w = waits[id]; if (!w) return; delete waits[id];
  let d = null; try { d = JSON.parse(json); } catch (e) { d = { error: 'bad_json' }; }
  if (ok) w.res(d); else { const e = new Error((d && d.error) || 'native'); e.data = d; w.rej(e); }
};
window.AMP_ev = (n, d) => (evs[n] || []).slice().forEach(f => { try { f(d); } catch (e) { console.error(e); } });
const on = (n, f) => { (evs[n] = evs[n] || []).push(f); return () => { evs[n] = evs[n].filter(x => x !== f); }; };
const native = (m, a = {}) => new Promise((res, rej) => {
  if (!window.AMPNative) { rej(new Error('no_native')); return; }
  const id = 'n' + (++nseq); waits[id] = { res, rej }; window.AMPNative.call(id, m, JSON.stringify(a));
});

// ── Hilfen ─────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const ts = s => s ? Date.parse(s.replace(' ', 'T') + 'Z') || 0 : 0;
const fromUnix = u => u ? new Date(u * 1000).toISOString().slice(0, 19).replace('T', ' ') : null;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, a, b) => { if (v === '' || v === null || v === undefined) return null; const n = +v; return Number.isFinite(n) ? clamp(n, a, b) : null; };
const int = (v, a, b) => { const n = num(v, a, b); return n === null ? null : Math.round(n); };
const str = (v, len) => { const s = String(v ?? '').trim(); return s ? s.slice(0, len) : null; };
const hex = v => { const m = /^#?([0-9a-f]{6})$/i.exec(String(v || '').trim()); return m ? '#' + m[1].toLowerCase() : '#888888'; };
const hexes = v => { const ok = String(v || '').split(',').map(h => h.trim().replace(/^#/, '').toLowerCase()).filter(h => /^[0-9a-f]{6}$/.test(h)); return ok.length ? ok.slice(0, 16).join(',') : null; };
const mrColor = c => { const m = /^#?([0-9a-f]{6})/i.exec(String(c || '').trim()); return m ? '#' + m[1].toLowerCase() : null; };
/** Happy Hare: gate_color darf ein Farbname sein („red“) — dann gate_color_rgb ([r,g,b] 0…1) nehmen (mmu_utils validate_color). */
const hhColor = (mmu, gI) => {
  const c = mrColor((mmu.gate_color || [])[gI]); if (c) return c;
  const f = (mmu.gate_color_rgb || [])[gI];
  return Array.isArray(f) && f.length >= 3 && f.every(v => Number.isFinite(+v)) ? '#' + f.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, +v)) * 255).toString(16).padStart(2, '0')).join('') : null;
};
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const LOW_G = 100;
// Warnschwellen (10.11.2026, Donnie: „3D Clean“-Reinigungsstäbchen 50 × 0,3 g = 15 g zeigten immer „fast leer“):
// zwei Stufen „bald leer“ / „kritisch“, in Gramm oder Prozent (db.settings.lowcfg), je Spule überschreibbar oder aus (spool.warn).
const LOW_DEF = { mode: 'g', low: 100, crit: 30 };
const lowCfg = () => Object.assign({}, LOW_DEF, db.settings.lowcfg || {});
/** 0 = genug, 1 = bald leer, 2 = kritisch */
function warnLvl(r, left) {
  if (r.archived_at) return 0;
  const w = r.warn || null;
  if (w && w.off) return 0;
  const c = w && w.mode ? w : lowCfg(), total = r.weight_total | 0;
  const v = c.mode === 'pct' ? (total > 0 ? left * 100 / total : 0) : left;
  if (c.crit != null && c.crit !== '' && v < +c.crit) return 2;
  if (c.low != null && c.low !== '' && v < +c.low) return 1;
  return 0;
}
let MACH = null;
/** Kosten eines Plans aus dem Preis der Spulen in den Fächern. */
function planCost(pid, plan) {
  let c = 0, any = false;
  for (const pl of plan || []) { const sl = db.slots.find(s => s.printer_id === pid && s.index === (pl.slot < 0 ? 0 : pl.slot)); const sp = sl && sl.spool_id ? db.spools.find(s => s.id === sl.spool_id) : null; if (sp && sp.price_per_kg != null) { c += pl.g * sp.price_per_kg / 1000; any = true; } }
  return any ? Math.round(c * 100) / 100 : null;
}
/**
 * Reicht die Spule? (16.11.2026, wie fmp_short in /filament print_api.php) Gramm je Fach gegen den Rest der Spule im Fach,
 * mit dem Verbrauchsausgleich des Druckers (so wird später auch abgebucht) und 5 g Reserve. Fach ohne Spule: keine Aussage.
 * items = [{ slot, g }] mit Slicer-Gramm; gleiche Fächer werden zusammengezählt. buy/shop bleiben leer — die App zeigt keine Werbung.
 */
function shortList(pid, items) {
  const fa = adjOf(pid), need = new Map();
  for (const it of items || []) {
    const g = +it.g; if (!(g > 0)) continue;
    const slot = +it.slot < 0 ? 0 : +it.slot || 0;
    need.set(slot, (need.get(slot) || 0) + g * fa);
  }
  const es = (live[pid] && live[pid].entry && live[pid].entry.slots) || [];
  const out = [];
  for (const [slot, g] of need) {
    const sl = db.slots.find(s => s.printer_id === pid && s.index === slot);
    const sp = sl && sl.spool_id ? db.spools.find(s => s.id === sl.spool_id && !s.archived_at) : null;
    if (!sp || !(sp.weight_total > 0)) continue;
    const left = leftOf(sp);
    if (left >= g + 5) continue;
    const e = es.find(x => x.index === slot);
    out.push({ slot: e && e.label ? String(e.label) : String(slot + 1), need: Math.round(g), left: Math.round(left),
               spool: [sp.brand, sp.color_name || sp.material].filter(Boolean).join(' '), buy: '', shop: '' });
  }
  return out;
}
/** Ein Kopf ohne Fächer (oder noch kein Stand)? Dann geht alles auf Fach 0 — wie printSend. */
const singleHead = pid => { const e = live[pid] && live[pid].entry; return !e || e.slots.every(s => s.single); };
/** Plan des Slicer-Servers → Fächer wie beim Abbuchen in printSend. */
const slicePlanItems = (pid, plan) => { const one = singleHead(pid); return (plan || []).map(pl => ({ slot: one || pl.slot < 0 ? 0 : +pl.slot, g: +pl.g })); };
/** Gramm je Werkzeug aus dem G-Code → Fächer wie in printSend (Zuordnung map, sonst ttg_map, sonst gleiche Nummer). */
/** Klipper-Drucker für „Dateien am Drucker“ (andere Arten: unsupported) */
function pfPrinter(id) {
  const p = db.printers.find(x => x.id === id) || fail('not_found');
  if (kindOf(p) !== 'moonraker') fail('unsupported');
  return p;
}
/** Zeitraffer am Drucker (27.11.2026, amp_cam_tl): Moonraker-Wurzeln in dieser Reihenfolge, Videoformate, Adresse einer Datei */
const TL_ROOTS = ['timelapse', 'camera'];
const TL_VIDEO = /\.(mp4|m4v|mov|mkv|webm)$/i;
const tlUrl = (p, root, path) => mrUrl(p, '/server/files/' + root + '/' + String(path).split('/').map(encodeURIComponent).join('/'));
/** Gramm je Werkzeug aus Moonraker-Metadaten (U1: filament_weight, Orca-Patch: filament_weights, sonst Summe) */
function pfWeights(md) {
  const fwl = Array.isArray(md.filament_weights) ? md.filament_weights : Array.isArray(md.filament_weight) ? md.filament_weight : null;
  if (fwl && fwl.some(x => +x > 0)) return fwl.map(Number);
  return +md.filament_weight_total > 0 ? [+md.filament_weight_total] : null;
}
function gcodeItems(pid, weights, map) {
  const one = singleHead(pid), e = live[pid] && live[pid].entry, ttg = (e && e.ttg_map) || [];
  return (Array.isArray(weights) ? weights : []).map((w, tI) => ({ slot: one ? 0 : (map && map[tI] != null ? +map[tI] : (ttg[tI] ?? tI)), g: +w }));
}
const DENSITY = { PLA: 1.24, 'PLA+': 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, PA: 1.14, PC: 1.2 };
const mmToG = (mm, dia = 1.75, dens = 1.24) => mm * Math.PI * Math.pow(dia / 2, 2) * dens / 1000;
// Drucktitel aus dem Dateinamen (wie pc_job_title): Endung, Slicer-Anhänge, Unterstriche weg
const jobTitle = n => String(n || '').split('/').pop().replace(/\.(gcode|bgcode|3mf|gco|g)$/i, '').replace(/\.gcode$/i, '')
  .replace(/_(PLA|PETG|ABS|ASA|TPU|PA|PC)[^_]*_\d+h\d+m(\d+s)?$/i, '').replace(/_plate_?\d+$/i, '').replace(/^3DSEARCH_|^AMP_/, '').replace(/_/g, ' ').trim() || String(n || '?');

// ── Speicher ───────────────────────────────────────────────────────────────
const FRESH = () => ({ v: 1, seq: {}, spools: [], locations: [], usage: [], printers: [], slots: [], jobs: [], filaments: [], profiles: [], clouds: [], settings: {}, created_at: now() });
let db = null, saveT = null, ready = null;
const nextId = k => (db.seq[k] = (db.seq[k] || 0) + 1);
function persist(immediate) {
  clearTimeout(saveT);
  const go = () => native('save', { key: 'data', text: JSON.stringify(db) }).catch(e => console.error('save', e));
  if (immediate) return go();
  saveT = setTimeout(go, 400);
}
async function init() {
  let txt = null;
  try { txt = (await native('load', { key: 'data' })).text; } catch (e) { console.error('load', e); }
  try { db = txt ? JSON.parse(txt) : FRESH(); } catch (e) { db = FRESH(); }
  const f = FRESH();
  for (const k of Object.keys(f)) if (db[k] === undefined) db[k] = f[k];
  // 0.6.2: vor 0.6.2 aus Spoolman übernommene Spulen auf Spoolmans Nummer umstellen (einmal; neue Übernahmen machen es selbst)
  if (!db.settings.sm_ids) { db.settings.sm_ids = 1; if (smRenumber()) diag({ a: 'spoolman', d: 'renumber' }); persist(); }
  setTimeout(() => { davBackup(false).catch(() => {}); }, 20000);   // tägliche Sicherung aufs NAS (falls eingerichtet)
}
const boot = () => ready || (ready = init());

// ── Filamentkatalog (SpoolmanDB, liegt in der App) ─────────────────────────
let CAT = null;
async function catalog() {
  if (CAT) return CAT;
  const raw = await (await fetch('data/catalog.json')).json();
  const vend = new Map(raw.vendors.map(([id, name, es]) => [id, { id, name, empty_spool_g: es }]));
  const items = raw.items.map(r => {
    const v = vend.get(r[1]) || { name: '?' };
    return { id: r[0], vendor_id: r[1], vendor: v.name, vendor_spool: v.empty_spool_g, name: r[2], material: r[3], color: r[4] ? '#' + r[4] : null,
             colors: r[5] ? r[5].split(',').map(h => '#' + h) : null, diameter: r[6], density: r[7], weight_g: r[8], spool_weight_g: r[9],
             extruder_temp: r[10], bed_temp: r[11], finish: r[12], source: 'spoolmandb', mine: false };
  });
  CAT = { vendors: [...vend.values()], items, byId: new Map(items.map(i => [i.id, i])) };
  return CAT;
}
// Eigene Filamente (filament_save) bekommen Nummern ab 10.000.000, damit sie nie mit dem Katalog zusammenstoßen
const OWN_BASE = 10000000;
async function filamentById(id) {
  if (!id) return null;
  if (id >= OWN_BASE) return db.filaments.find(f => f.id === id) || null;
  return (await catalog()).byId.get(id) || null;
}

// ── Spulen ─────────────────────────────────────────────────────────────────
function dryDays(material) {
  const m = String(material || '').toUpperCase();
  if (/\b(PVA|BVOH)\b/.test(m)) return 3;
  if (/\b(PA|PA\d+|PAHT|PPA|PA6|PA12|NYLON)\b|^PA[-\s]/.test(m)) return 7;
  if (/TPU|TPE|PEBA|FLEX/.test(m)) return 14;
  if (/PETG|PCTG|COPE|\bCPE\b|\bPET\b/.test(m)) return 30;
  if (/\bPC\b|^PC[-\s]|PC-?(CF|GF|ABS)/.test(m)) return 14;
  return null;
}
function dryAdvice(r, left) {
  if (r.archived_at || left <= 0) return null;
  const limit = dryDays(r.material);
  const opened = r.opened_at || (r.first_used_at ? r.first_used_at.slice(0, 10) : null);
  const ref = [r.dried_at || '', opened || ''].sort().pop();
  if (!ref) return null;
  const days = Math.floor((Date.now() - Date.parse(ref.length > 10 ? ref.replace(' ', 'T') + 'Z' : ref + 'T00:00:00Z')) / 864e5);
  return { days: Math.max(0, days), limit, since: r.dried_at && r.dried_at >= (opened || '') ? 'dried' : 'opened', due: limit !== null && days >= limit };
}
function forecast() {
  const from = Date.now() - 60 * 864e5, by = {};
  for (const u of db.usage) {
    if ((u.kind !== 'print' && u.kind !== 'queue') || u.grams <= 0 || ts(u.created_at) < from) continue;
    const b = by[u.spool_id] || (by[u.spool_id] = { g: 0, a: Infinity, z: 0, d: new Set() });
    b.g += u.grams; b.a = Math.min(b.a, ts(u.created_at)); b.z = Math.max(b.z, ts(u.created_at)); b.d.add(u.created_at.slice(0, 10));
  }
  const out = {};
  for (const [id, b] of Object.entries(by)) {
    if (b.d.size < 3 || b.z < Date.now() - 21 * 864e5) continue;
    const gpd = b.g / Math.max(14, (Date.now() - b.a) / 864e5);
    if (gpd >= 0.5) out[id] = gpd;
  }
  return out;
}
function slotMap() {
  const m = {};
  for (const sl of db.slots) {
    if (!sl.spool_id) continue;
    const p = db.printers.find(x => x.id === sl.printer_id);
    if (!p) continue;
    (m[sl.spool_id] = m[sl.spool_id] || []).push({ printer: p.name, provider: 'moonraker', pid: p.id, index: sl.index, slot: sl.index >= 100 ? 'ext' : String(sl.index + 1) });
  }
  return m;
}
async function spoolOut(r, slots, fc) {
  const total = r.weight_total | 0, left = Math.round(leftOf(r));
  const fil = r.fm_filament_id ? await filamentById(r.fm_filament_id) : null;
  return {
    id: r.id, name: r.name, brand: r.brand, material: r.material, color_name: r.color_name, color: r.color_hex || '#888888',
    colors: hexes(r.color_hexes) ? hexes(r.color_hexes).split(',').map(h => '#' + h) : (fil && fil.colors ? fil.colors : null),
    total, used: Math.round(+r.weight_used || 0), left, over: left < 1 && !r.archived_at ? Math.round(r.over_g || 0) : 0,
    pct: total > 0 ? Math.round(left * 100 / total) : 0,
    price_per_kg: r.price_per_kg ?? null, value: r.price_per_kg != null ? Math.round(left * r.price_per_kg / 10) / 100 : null,
    location: r.location, lot_nr: r.lot_nr, notes: r.notes, empty_spool_g: r.empty_spool_g ?? null,
    cat_spool_g: fil ? (fil.spool_weight_g || fil.vendor_spool || null) : null,
    diameter: r.diameter || 1.75, density: fil ? fil.density : (r.density ?? null),
    extruder_temp: fil ? fil.extruder_temp : null, bed_temp: fil ? fil.bed_temp : null, finish: fil ? fil.finish : null,
    fm_filament_id: r.fm_filament_id || null, created_at: r.created_at, first_used_at: r.first_used_at || null, last_used_at: r.last_used_at || null,
    opened_at: r.opened_at || null, dried_at: r.dried_at || null, dry: dryAdvice(r, left), archived: !!r.archived_at, slots: slots[r.id] || [],
    fc: !r.archived_at && left > 0 && fc[r.id] && left / fc[r.id] <= 365 ? { days: Math.ceil(left / fc[r.id]), gpd: Math.max(1, Math.round(fc[r.id])) } : null,
    custom: {}, ext_ref: r.ext_ref || null,   // „Spoolman #177“ zeigen und danach suchen (smNo in app.js)
    lvl: warnLvl(r, left), warn: r.warn || null,   // Warnstufe (app.js isLow/isCrit) und eigene Schwelle dieser Spule
    nfc: (r.nfc || []).map(x => x.uid),       // verknüpfte NFC-Tags (UID)
  };
}
async function spools(only) {
  const slots = slotMap(), fc = forecast();
  const rows = db.spools.filter(r => !only || r.id === only).slice()
    .sort((a, b) => !!a.archived_at - !!b.archived_at || String(a.location || '').localeCompare(String(b.location || '')) || String(a.material).localeCompare(String(b.material)) || a.id - b.id);
  const out = [];
  for (const r of rows) out.push(await spoolOut(r, slots, fc));
  return out;
}
const own = id => db.spools.find(s => s.id === +id) || fail('not_found');
// Bestand mit Nachkommastellen (10.11.2026): vorher rundete jede Buchung auf ganze Gramm — bei vielen kleinen Drucken
// desselben Modells (8× „Star“ à 5,4 g → je 5 g) ein Fehler, der sich in eine Richtung aufsummiert
const leftOf = s => Math.max(0, (s.weight_total | 0) - (+s.weight_used || 0));
async function reply(id) { persist(); return { ok: true, spool: (await spools(id))[0] || null }; }
/** Verbrauch buchen (wie fm_log_usage + Bestandsänderung). Positiv = verbraucht, negativ = zurück.
 *  meta bei Drucken: { pid, raw } = Drucker und Slicer-Gewicht vor dem Verbrauchsausgleich (für adjLearn). */
function book(spool, g, kind, note = '', ref = '', printer = null, setLeft = true, meta = null) {
  if (!spool || Math.abs(g) < 0.005) return;
  const u = { id: nextId('usage'), spool_id: spool.id, grams: Math.round(g * 100) / 100, kind, ref: ref || null, note: note || null, printer: printer || null, created_at: now() };
  if (meta) { if (meta.pid != null) u.pid = meta.pid; if (meta.raw != null) u.raw = Math.round(meta.raw * 100) / 100; }
  // Spoolman am Drucker zählt diese Spule schon (smLive) → Druck nur festhalten, Bestand kommt aus Spoolman
  if (setLeft && isPrintUse(u) && smLive(spool)) { setLeft = false; u.sm = 1; }
  db.usage.push(u);
  if (setLeft) {
    const before = leftOf(spool);
    spool.weight_used = Math.round(clamp((+spool.weight_used || 0) + g, 0, spool.weight_total | 0) * 100) / 100;
    // Über den Bestand hinaus gedruckt: merken, die Oberfläche fragt dann nach dem echten Rest
    if (g > 0 && g > before) spool.over_g = (spool.over_g || 0) + (g - before);
  }
  if (g > 0) { spool.last_used_at = now(); spool.first_used_at = spool.first_used_at || now(); }
}
// ── Verbrauchsausgleich (10.11.2026, User: „die Spule war immer zuvor leer, nicht viel, aber genau ist es nicht“) ──
// Gebucht wird das Slicer-Gewicht. Was der Drucker darüber hinaus braucht (Spülen durch die Firmware, Rest im Schlauch zur
// Mehrfarbeinheit, zu hoch angenommenes Startgewicht), zeigt sich erst, wenn eine Spule leer gemeldet wird und laut Buchung
// noch etwas drauf war — oder über den Bestand hinaus gedruckt wurde. Daraus lernt die App je Drucker einen Faktor
// (wirklich verbraucht ÷ Slicer-Gewicht) und rechnet ihn auf die nächsten Drucke dieses Druckers. Neuere Spulen zählen mehr.
const ADJ_MIN_RAW = 200, ADJ_CAP_RAW = 3000, ADJ_MIN = 0.9, ADJ_MAX = 1.12;
const adjTab = () => (db.settings.adj = db.settings.adj || {});
/** Faktor für Drucke dieses Druckers (1 = Slicer-Gewicht). */
function adjOf(pid) {
  if (db.settings.amp_adj_off || pid == null) return 1;
  const a = adjTab()[pid];
  return a && a.raw > 0 ? clamp(a.real / a.raw, ADJ_MIN, ADJ_MAX) : 1;
}
const pidByName = n => { const p = n ? db.printers.find(x => x.name === n) : null; return p ? p.id : null; };
const isPrintUse = u => u.kind === 'print' || (u.kind === 'correction' && /^cancel\|/.test(u.note || ''));
/**
 * Spule wird leer gemeldet — VOR dem Ausbuchen des Rests aufrufen. Seit der letzten Bestandsangabe von Hand (Wiegen, Rest
 * eingeben, Bearbeiten, Import, frühere Leermeldung): wirklich verdruckt = gebuchte Drucke + Rest laut Buchung (negativ, wenn
 * über den Bestand gedruckt). Nur bei genug Drucken (ADJ_MIN_RAW) und kleinem Rest — eine halbvolle Spule, die nur
 * aussortiert wird, sagt nichts über den Verbrauch. Rückgabe: [{ pid, f }] der nachgeführten Drucker oder null.
 */
function adjLearn(s) {
  const us = db.usage.filter(u => u.spool_id === s.id);
  let i0 = 0;
  for (let i = us.length - 1; i >= 0; i--) { const u = us[i]; if (u.kind === 'weigh' || (u.kind === 'correction' && !/^cancel\|/.test(u.note || ''))) { i0 = i + 1; break; } }
  // Bestand kam von Spoolman (smLive), nicht aus unseren Buchungen → sagt nichts über unseren Ausgleich
  if (us.slice(i0).some(u => u.sm)) return null;
  let booked = 0; const raw = {};
  for (const u of us.slice(i0)) {
    if (!isPrintUse(u)) continue;
    booked += u.grams;
    const pid = u.pid ?? pidByName(u.printer);
    if (pid != null) raw[pid] = (raw[pid] || 0) + (u.raw ?? u.grams);
  }
  const rawSum = Object.values(raw).reduce((a, b) => a + b, 0);
  const rest = leftOf(s) - (s.over_g || 0);
  if (rawSum < ADJ_MIN_RAW || Math.abs(rest) > Math.max(25, rawSum * 0.1)) return null;
  const f = (booked + rest) / rawSum;
  if (!(f >= ADJ_MIN && f <= ADJ_MAX)) return null;
  const out = [];
  for (const [pid, r] of Object.entries(raw)) {
    const a = adjTab()[pid] = adjTab()[pid] || { raw: 0, real: 0, n: 0 };
    a.raw += r; a.real += r * f; a.n++; a.at = now();
    if (a.raw > ADJ_CAP_RAW) { const k = ADJ_CAP_RAW / a.raw; a.raw *= k; a.real *= k; }
    out.push({ pid, name: printerName(pid), f: adjOf(pid) });
  }
  try { document.dispatchEvent(new CustomEvent('amp-adj', { detail: out })); } catch (e) {}
  return out;
}

// ── Spoolman (10.11.2026, Donnie: U1 Extended, RFID-Tags je Kopf mit Spoolman verknüpft, 187 Spulen übernommen) ──────────
// 1. Spoolman-Spulen tragen in der App Spoolmans Nummer (wo sie frei ist) — „Spool 177 should be my Prusament Mango Yellow“.
// 2. Meldet ein Fach seine Spoolman-Spule (AFC-Spur, Happy-Hare-Fach, aktive Spule in Moonraker), setzt die App sie selbst ein —
//    fehlt sie, wird sie aus Spoolman angelegt. Dann gilt Spoolmans Restmenge (wie auf 3DSEARCH, User 06.10.2026: „die
//    Spoolman-Zahl gilt, ist genauer“): Moonraker zieht dort schon ab, die App hält Drucke nur fest (book → u.sm).
const smNum = s => +((/^spoolman:(\d+)$/.exec((s && s.ext_ref) || '') || [])[1] || 0);
/** Spule steckt in einem Fach, das genau diese Spoolman-Spule meldet (Drucker mit Spoolman-Anbindung). */
function smLive(s) {
  const n = smNum(s);
  return n > 0 && db.slots.some(sl => sl.spool_id === s.id && sl.sm === n);
}
/** Neue Spulennummer: Wunschnummer (Spoolman), wenn frei, sonst die nächste freie. */
function spoolId(want) {
  const used = id => db.spools.some(s => s.id === id);
  if (want > 0 && !used(want)) { db.seq.spool = Math.max(db.seq.spool || 0, want); return want; }
  let id; do id = nextId('spool'); while (used(id));
  return id;
}
/**
 * Spoolman-Spulen auf Spoolmans Nummer umstellen, wo sie frei ist — mit allen Verweisen (Fächer, Buchungen, Druckpläne) in
 * einem Schritt. Eine Spule, deren Wunschnummer belegt ist (eigene Spule der App), behält ihre; dann darf auch keine andere
 * Spule auf deren Nummer wechseln. Rückgabe: Anzahl umgestellter Spulen.
 */
function smRenumber() {
  const want = new Map();
  for (const s of db.spools) { const n = smNum(s); if (n > 0 && n !== s.id) want.set(s.id, n); }
  if (!want.size) return 0;
  const fixed = new Set(db.spools.filter(s => !want.has(s.id)).map(s => s.id));
  let map;
  for (;;) {
    map = new Map(); const taken = new Set();
    for (const [id, n] of [...want].sort((a, b) => a[0] - b[0])) if (!fixed.has(n) && !taken.has(n)) { map.set(id, n); taken.add(n); }
    const stuck = [...want.keys()].filter(id => !map.has(id));
    if (!stuck.length) break;
    stuck.forEach(id => { fixed.add(id); want.delete(id); });   // behält ihre Nummer → die ist für andere tabu
  }
  if (!map.size) return 0;
  const m = id => map.has(id) ? map.get(id) : id;
  for (const s of db.spools) s.id = m(s.id);
  for (const sl of db.slots) if (sl.spool_id) sl.spool_id = m(sl.spool_id);
  for (const u of db.usage) u.spool_id = m(u.spool_id);
  for (const j of db.jobs) for (const pl of j.plan || []) if (pl.spool_id) pl.spool_id = m(pl.spool_id);
  db.seq.spool = Math.max(db.seq.spool || 0, ...db.spools.map(s => s.id));
  return map.size;
}
/** Spoolman-Spule über Moonrakers Spoolman-Anbindung (/server/spoolman/proxy), höchstens alle 2 Min je Spule (wie der Agent). */
async function smFetch(p, L, n, force) {
  const c = (L.sm = L.sm || {})[n];
  if (c && !force && Date.now() - c.at < 120000) return c.d;
  let d = null;
  try { const r = await mrPost(p, '/server/spoolman/proxy', { request_method: 'GET', path: '/v1/spool/' + n }, 5000); if (r && +r.id === n) d = r; } catch (e) {}
  L.sm[n] = { at: Date.now(), d };
  return d;
}
/** Spule zu Spoolman-Nr. n: Bestand aus Spoolman übernehmen bzw. aus Spoolmans Daten anlegen (wie pc_spoolman_sync).
 *  Ohne Daten (Spoolman nicht erreichbar) bleibt alles, wie es ist. Rückgabe: Spule oder null (fehlt / aussortiert). */
async function smSync(n, d, color) {
  let s = db.spools.find(x => x.ext_ref === 'spoolman:' + n);
  if (s && s.archived_at) return null;
  const ok = d && d.remaining_weight != null && Number.isFinite(+d.remaining_weight);
  if (s) {
    if (ok) {
      const f = d.filament || {}, rem = Math.max(0, +d.remaining_weight), init = +(d.initial_weight || f.weight || 0);
      const total = Math.round(clamp(init > 0 ? init : Math.max(s.weight_total | 0, rem), 1, 10000));
      const used = Math.round(clamp(total - rem, 0, total) * 100) / 100;
      if ((s.weight_total | 0) !== total || Math.abs((+s.weight_used || 0) - used) >= 0.01) { s.weight_total = total; s.weight_used = used; s.over_g = 0; }
      if (d.last_used) { const lu = impDate(d.last_used); if (lu) s.last_used_at = lu; }
    }
    return s;
  }
  if (!ok) return null;
  const sp = (impSpoolman([d]) || [])[0];
  if (!sp) return null;
  const cat = await catalog();
  const { row } = impRow(sp, cat, impCatKeys(cat));
  if (!/^#[0-9a-f]{6}$/i.test(String((d.filament || {}).color_hex || '').replace(/^#?/, '#')) && color) row.color_hex = color;   // mehrfarbig ohne Einzelfarbe → Farbe des Fachs
  s = { id: spoolId(n), ...row, ext_ref: 'spoolman:' + n, over_g: 0, created_at: now(), archived_at: null };
  db.spools.push(s);
  if (sp.nfc && sp.nfc.length) nfcAdd(s, sp.nfc, 'spoolman');
  if (row.location) addLocation(row.location);
  return s;
}
/** Fach meldet Spoolman-Spule n: abgleichen/anlegen und einsetzen — nur wenn im Fach keine oder eine andere Spoolman-Spule
 *  steckt; von Hand gesetzte eigene Spulen bleiben. Offene Gramm hat Spoolman schon gezählt (book hält sie nur fest). */
async function smSlot(p, L, sl, n, color) {
  const cur = sl.spool_id ? db.spools.find(x => x.id === sl.spool_id) : null;
  if (cur && !smNum(cur) && !cur.archived_at) return;
  const s = await smSync(n, await smFetch(p, L, n), color);
  if (!s || sl.spool_id === s.id) return;
  db.slots.forEach(x => { if (x.spool_id === s.id && x !== sl) x.spool_id = null; });   // eine Spule steckt nur in einem Fach
  sl.spool_id = s.id;
  if (sl.pending_g >= 0.5) book(s, sl.pending_g, 'print', 'pending', '', printerName(sl.printer_id), true, { pid: sl.printer_id, raw: sl.pending_g });
  sl.pending_g = 0;
  diag({ a: 'spoolman', p: kindOf(p), m: p.model || '', d: 'slot ' + (sl.index + 1) + ' ← ' + n });
  persist();
}
/** Spoolman-Nr. eines Fachs merken (sl.sm, für smLive) und die Spule einsetzen. Nur wenn Moonraker Spoolman angebunden hat —
 *  sonst zieht dort niemand ab und die App bucht selbst weiter. */
// ── NFC-Tags (10.11.2026, User: „bau mal“, erst nur lesen): Spule ↔ Tag-Kennung (UID). Mehrere Tags je Spule (der U1 liest seitlich,
// manche kleben zwei auf). Eine UID gehört immer nur einer Spule. Gespeichert in spool.nfc = [{ uid, type, src, at }].
const nfcUid = u => { const h = String(u || '').replace(/[^0-9a-f]/gi, '').toUpperCase(); return h.length >= 8 && h.length <= 32 ? h : ''; };
const spoolByNfc = uid => db.spools.find(s => (s.nfc || []).some(x => x.uid === uid)) || null;
/** UIDs an eine Spule hängen (von anderen Spulen weg). src: 'tap' (angetippt) | 'spoolman' (Übernahme). */
function nfcAdd(s, uids, src, type) {
  for (const raw of uids) {
    const uid = nfcUid(raw); if (!uid) continue;
    for (const o of db.spools) if (o !== s && o.nfc) o.nfc = o.nfc.filter(x => x.uid !== uid);
    s.nfc = s.nfc || [];
    if (!s.nfc.some(x => x.uid === uid)) s.nfc.push({ uid, type: type || null, src, at: now() });
  }
}
/** OpenSpool-Inhalt eines Tags → Material, Farbe, Hersteller, Temperaturen (zum Vorbelegen einer neuen Spule). */
function osParse(txt) {
  let o; try { o = JSON.parse(txt); } catch (e) { return null; }
  if (!o || String(o.protocol || '').toLowerCase() !== 'openspool') return null;
  const hx = /^#?([0-9a-f]{6})/i.exec(String(o.color_hex || ''));
  const n = v => Number.isFinite(+v) && +v > 0 ? +v : null;
  return { material: str([o.type, o.subtype && o.subtype !== 'Basic' ? o.subtype : ''].filter(Boolean).join(' '), 20), color: hx ? '#' + hx[1].toLowerCase() : null,
           brand: str(o.brand, 100), min_temp: n(o.min_temp), max_temp: n(o.max_temp), weight: n(o.weight), diameter: n(o.diameter) };
}

async function smMark(p, L, sl, n, color) {
  n = (L.comps || []).includes('spoolman') ? Math.max(0, parseInt(n, 10) || 0) : 0;
  if ((sl.sm || 0) !== n) { sl.sm = n; persist(); }
  if (n > 0) await smSlot(p, L, sl, n, color).catch(e => console.error('spoolman', e));
}

function addLocation(name) {
  if (name && !db.locations.some(l => l.name === name)) db.locations.push({ id: nextId('loc'), name, sort: 999 });
}
const locations = () => db.locations.slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

async function spoolSave(inp) {
  const id = +inp.id || 0, cur = id ? own(id) : null;
  const fil = inp.fm_filament_id ? await filamentById(+inp.fm_filament_id) : null;
  let total = int(inp.total, 1, 10000) ?? (fil && fil.weight_g) ?? 1000;
  let left = int(inp.left, 0, 10000);
  if (cur && left !== null && inp.left_orig !== undefined && +inp.left_orig === left) left = null;
  if (left === null) left = cur ? leftOf(cur) : total;
  total = Math.max(total, left);
  let ppk = num(inp.price_per_kg, 0.01, 9999);
  const sp = num(inp.price_spool, 0.01, 9999);
  if (ppk === null && sp !== null) ppk = Math.round(sp * 1000 / total * 100) / 100;
  const material = str(inp.material, 20) ?? (fil && fil.material) ?? 'PLA';
  const f = {
    fm_filament_id: fil ? fil.id : null,
    brand: fil ? fil.vendor : str(inp.brand, 100),
    material: String(fil ? fil.material : material).slice(0, 20),
    color_name: fil ? String(fil.name).slice(0, 50) : str(inp.color_name, 50),
    color_hex: fil && fil.color ? fil.color : hex(inp.color),
    // zweite Farbe beim manuellen Anlegen (24.11.2026, Community #56): wie die Mehrfarb-Angabe aus dem Katalog
    color_hexes: fil && fil.colors ? fil.colors.map(c => c.slice(1)).join(',') : (!fil && inp.color2_on && hex(inp.color2) && hex(inp.color) ? [hex(inp.color), hex(inp.color2)].map(c => c.slice(1)).join(',') : null),
    weight_total: total, weight_used: total - left, price_per_kg: ppk,
    location: str(inp.location, 60), lot_nr: str(inp.lot_nr, 60), notes: str(inp.notes, 255),
    empty_spool_g: int(inp.empty_spool_g, 0, 2000) ?? (fil ? (fil.spool_weight_g || fil.vendor_spool || null) : null),
    diameter: num(inp.diameter, 1, 3.5) ?? (fil ? fil.diameter : 1.75),
  };
  const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  if ('opened_at' in inp) f.opened_at = day(inp.opened_at);
  if ('dried_at' in inp) { const d = day(inp.dried_at); f.dried_at = d === null ? null : (cur && cur.dried_at && cur.dried_at.slice(0, 10) === d ? cur.dried_at : d + ' 12:00:00'); }
  const matIn = f.color_name && f.color_name.toLowerCase().includes(f.material.toLowerCase());
  f.name = ([f.brand, matIn ? null : f.material, f.color_name].filter(Boolean).join(' ').trim() || f.material).slice(0, 100);
  if (cur && !fil && !inp.unlink && cur.fm_filament_id) { f.fm_filament_id = cur.fm_filament_id; f.color_hexes = cur.color_hexes || null; }
  if (cur) {
    const oldLeft = leftOf(cur);
    if (left === 0 && oldLeft > 0) adjLearn(cur);   // im Formular auf 0 gesetzt = leer gemeldet
    Object.assign(cur, f);
    if (oldLeft !== left) book(cur, oldLeft - left, 'correction', 'edit', '', null, false);
    addLocation(f.location);
    return reply(cur.id);
  }
  const qty = int(inp.qty ?? 1, 1, 50) || 1, ids = [];
  for (let i = 0; i < qty; i++) { const nid = spoolId(0); db.spools.push({ id: nid, ...f, over_g: 0, created_at: now(), archived_at: null }); ids.push(nid); }
  addLocation(f.location);
  persist();
  return { ok: true, ids };
}

// ── Spulen übernehmen (wie /filament „Import“): 3DSEARCH-Export, Spoolman (Datei oder Server im WLAN), SpoolDB,
// OctoPrint SpoolManager, eigene Tabellen. Ergänzt/aktualisiert über ext_ref, ersetzt nie den Bestand.
function impCsv(raw) {
  raw = String(raw || '').replace(/^﻿/, '');
  const first = raw.split(/\r\n|\n|\r/, 1)[0] || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) { if (c === '"') { if (raw[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && raw[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  if (head.length < 3) return null;
  return rows.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] === '' ? null : r[i]])));
}
function impDecode(raw) {
  const s = String(raw || '').replace(/^﻿/, '').trim();
  if (/^[[{]/.test(s)) { try { return JSON.parse(s); } catch (e) { return null; } }
  return impCsv(s);
}
/** Zahl aus „1.000,5“ / „1,000.5“ / „1000.5“ */
function impNum(v) {
  if (v === null || v === undefined || typeof v === 'object') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = +s; return s !== '' && Number.isFinite(n) ? n : null;
}
function impDate(v) {
  const s = String(v || '').trim(); if (!s) return null;
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')} ${(m[4] || '0').padStart(2, '0')}:${m[5] || '00'}:00`;
  const t = Date.parse(s); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 19).replace('T', ' ') : null;
}
const impS = v => { const s = v === null || v === undefined ? '' : String(v).trim(); return s || null; };
const impList = d => Array.isArray(d) && d.length && d[0] && typeof d[0] === 'object' && !Array.isArray(d[0]) ? d : null;
const impHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
/** Gleiche Spulen ohne eigene Nummer → laufende Nummer, sonst würden sie beim Import eins */
function impNth() { const seen = {}; return key => { const n = seen[key] = (seen[key] || 0) + 1; return n > 1 ? '#' + n : ''; }; }

/** Eigener CSV-Export von 3dsearch.net/filament (export.php) */
function impOwn(d) {
  d = impList(d); if (!d || !('remaining_g' in d[0]) || !('weight_total_g' in d[0])) return null;
  const tx = v => { const s = impS(v); return s && /^'[=+\-@]/.test(s) ? s.slice(1) : s; };
  const yes = v => ['1', 'true', 'yes', 'ja'].includes(String(v || '').trim().toLowerCase());
  return d.filter(r => tx(r.material) || tx(r.name)).map(r => {
    const id = parseInt(r.id, 10) || 0, total = impNum(r.weight_total_g) || 1000, rest = impNum(r.remaining_g);
    const extra = Object.keys(r).filter(k => k.startsWith('field:') && impS(r[k])).map(k => k.slice(6).trim() + ': ' + tx(r[k]));
    const ppk = impNum(r.price_per_kg);
    return { ref: id ? '3dsearch:' + id : '3dsearch:new-' + impHash(JSON.stringify(r)), fmid: parseInt(r.catalog_id, 10) || null,
      brand: tx(r.brand) || tx(r.catalog_vendor), material: tx(r.material), color_name: tx(r.color_name), name: tx(r.name), hex: r.color_hex,
      diameter: impNum(r.diameter_mm), total, used: rest !== null ? total - rest : (impNum(r.weight_used_g) || 0),
      ppk, empty: impNum(r.empty_spool_g), location: tx(r.location), lot: tx(r.lot_nr), notes: [tx(r.notes), ...extra].filter(Boolean).join(' · ') || null,
      archived: yes(r.archived), first: impS(r.first_used_at), last: impS(r.last_used_at), full: true, extra: [] };
  });
}
/** SpoolDB (spooldb.com, CSV oder JSON) */
function impSpoolDb(d) {
  d = impList(d); if (!d || !('short_code' in d[0])) return null;
  return d.filter(r => r.short_code).map(r => {
    const p = r.spool_properties && typeof r.spool_properties === 'object' ? { ...r.spool_properties } : {};
    for (const k of Object.keys(r)) if (k.startsWith('spool_') && k !== 'spool_url' && k !== 'spool_properties' && p[k.slice(6)] === undefined) p[k.slice(6)] = r[k];
    const type = String(r.material_type || '').trim(), color = String(r.color || '').replace(/\s+/g, ' ').trim();
    const plain = color.replace(/\s*\(\s*\d+\s*\)\s*$/, '').trim(), basic = !type || /^basic$/i.test(type);
    const typed = basic || plain.toLowerCase().includes(type.toLowerCase()) ? plain : `${type} ${plain}`;
    const mat = String(r.material || '').trim().replace(/^(\w+\+)\/Pro$/i, '$1');
    const loc = String(r.location || '').trim(), empty = /^empty$/i.test(loc);
    const extra = ['purchase_date', 'last_dried_date', 'td_value', 'k_value', 'flow_ratio', 'preferred_nozzle_temp', 'preferred_bed_temp'].filter(k => impS(p[k])).map(k => k + ': ' + p[k]);
    return { ref: 'spooldb:' + String(r.short_code).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40), cands: [[mat, typed], [mat, `${mat} ${plain}`], [mat, plain]],
      brand: impS(r.brand), material: mat, color_name: basic || color.toLowerCase().includes(type.toLowerCase()) ? color : `${type} ${color}`, hex: r.rgb,
      rest: impNum(r.remaining_grams), ppk: null, price: impNum(p.purchase_price), empty: impNum(p.empty_spool_weight),
      location: empty ? null : loc || null, archived: empty, notes: impS(r.notes), dried: impS(p.last_dried_date), extra };
  });
}
/** OctoPrint SpoolManager (OllisGit), CSV-Export */
function impOctoSm(d) {
  d = impList(d); if (!d || !('Spool Name' in d[0]) || !('Used weight [g]' in d[0])) return null;
  const nth = impNth();
  return d.filter(r => impS(r['Spool Name']) || impS(r.Material)).map(r => {
    const key = ['Spool Name', 'Vendor', 'Material', 'Color Name', 'Color Code [hex]', 'Serialnumber', 'Purchased on [dd.mm.yyyy]'].map(k => String(r[k] || '').trim().toLowerCase()).join('|');
    return { ref: 'octosm:' + impHash(key) + nth(key), brand: impS(r.Vendor), material: impS(r.Material),
      color_name: impS(r['Color Name']) || impS(r['Spool Name']), hex: r['Color Code [hex]'], density: impNum(r['Density [g/cm3]']), diameter: impNum(r['Diameter [mm]']),
      total: impNum(r['Total weight [g]']) || 1000, used: Math.max(0, impNum(r['Used weight [g]']) || 0), empty: impNum(r['Spool weight [g]']),
      price: impNum(r.Cost), lot: impS(r.Serialnumber), notes: impS(r.Note),
      first: impDate(r['First use [dd.mm.yyyy hh:mm]']), last: impDate(r['Last use [dd.mm.yyyy hh:mm]']), extra: [] };
  });
}
/** Spoolman: /api/v1/spool (verschachtelt) oder flacher Export mit „filament.vendor.name“-Spalten */
function impSpoolman(d) {
  if (d && !Array.isArray(d) && Array.isArray(d.spools)) d = d.spools;
  d = impList(d); if (!d) return null;
  const out = [];
  for (let r of d) {
    r = { ...r };
    for (const k of Object.keys(r)) if (k.includes('.')) { const v = r[k]; delete r[k]; let o = r; const ps = k.split('.'); ps.slice(0, -1).forEach(p => { o = o[p] = o[p] && typeof o[p] === 'object' ? o[p] : {}; }); o[ps[ps.length - 1]] = v; }
    if (r.id === undefined || !r.filament || typeof r.filament !== 'object') continue;
    const f = r.filament, v = f.vendor || {};
    const arch = r.archived === true || ['1', 'true', 'yes'].includes(String(r.archived || '').toLowerCase());
    const extra = r.extra && typeof r.extra === 'object' ? Object.keys(r.extra).filter(k => k !== 'card_uids').map(k => { let x = r.extra[k]; try { x = JSON.parse(x); } catch (e) {} return k + ': ' + x; }) : [];
    // NFC-Tags aus Spoolman: extra.card_uids (U1-Extended SpoolLink, Spool Studio) = JSON-String mit kommagetrennten Hex-UIDs
    let cu = r.extra && r.extra.card_uids; try { cu = JSON.parse(cu); } catch (e) {}
    const nfc = String(cu || '').split(/[,;\s]+/).map(nfcUid).filter(Boolean);
    const total = impNum(r.initial_weight) || impNum(f.weight);
    out.push({ ref: 'spoolman:' + (parseInt(r.id, 10) || 0), brand: impS(v.name), material: impS(f.material), color_name: impS(f.name), hex: f.color_hex,
      hexes: impS(f.multi_color_hexes), density: impNum(f.density), diameter: impNum(f.diameter),
      total, used: impNum(r.used_weight), rest: impNum(r.remaining_weight), empty: impNum(r.spool_weight) ?? impNum(f.spool_weight),
      price: impNum(r.price) ?? (impNum(f.price) && impNum(f.weight) ? impNum(f.price) * (total || impNum(f.weight)) / impNum(f.weight) : null),
      location: impS(r.location), lot: impS(r.lot_nr), notes: impS(r.comment), archived: arch, first: impDate(r.first_used), last: impDate(r.last_used), extra, nfc });
  }
  return out.length ? out : null;
}
/** Allgemeine Tabelle: Spalten über Namen erkennen (deutsch/englisch, ohne Einheiten) */
function impGeneric(d) {
  d = impList(d); if (!d) return null;
  const want = {
    brand: /^(brand|vendor|manufacturer|marke|hersteller|filament vendor|filament brand)$/, material: /^(material|type|typ|filament type|material type)$/,
    name: /^(name|spool name|display name|filament|filament name|bezeichnung|product)$/, color_name: /^(colou?r|colou?r name|farbe|farbname)$/,
    hex: /^(hex|colou?r hex|colou?r code|rgb|hex colou?r|farbcode)$/, total: /^(total weight|initial weight|net weight|weight|spool size|gewicht|nettogewicht|füllgewicht)$/,
    used: /^(used|used weight|verbraucht)$/, left: /^(remaining|remaining weight|remaining grams|left|rest|restgewicht|übrig)$/,
    empty: /^(spool weight|empty spool|empty spool weight|tare|leerspule|spulengewicht)$/, price: /^(price|cost|preis|kosten|purchase price)$/,
    location: /^(location|storage|lagerort|ort)$/, notes: /^(notes?|comment|bemerkung|notiz)$/, diameter: /^(diameter|durchmesser)$/, lot: /^(lot|lot nr|lot number|batch|charge)$/,
  };
  const map = {};
  for (const col of Object.keys(d[0])) {
    const c = col.toLowerCase().replace(/\s*[[(].*?[\])]\s*/g, ' ').trim().replace(/[_-]+/g, ' ');
    for (const [f, re] of Object.entries(want)) if (!map[f] && re.test(c)) { map[f] = col; break; }
  }
  if (!(map.material || map.brand) || !(map.total || map.left || map.used)) return null;
  const v = (r, f) => map[f] && r[map[f]] !== null && r[map[f]] !== undefined ? String(r[map[f]]).trim() : '';
  const nth = impNth();
  return d.filter(r => v(r, 'material') || v(r, 'brand')).map(r => {
    const key = ['brand', 'material', 'name', 'color_name', 'hex', 'lot'].map(f => v(r, f)).join('|').toLowerCase();
    let total = impNum(v(r, 'total')) || null; if (total !== null && total < 10) total *= 1000;
    let mat = v(r, 'material'), col = v(r, 'color_name') || v(r, 'name'); const cands = [];
    const mm = /^(PLA\+?|PETG|PCTG|ABS|ASA|TPU|PA\d*|PC|PVA|HIPS|PET|PP)[\s-]+(.+)$/i.exec(mat);
    if (mm) {
      mat = mm[1].toUpperCase(); const variant = mm[2].trim(), basic = /^basic$/i.test(variant);
      if (col) cands.push([mat, basic ? col : `${variant} ${col}`], [mat, col]);
      if (!basic) col = `${variant} ${col}`.trim();
    }
    const left = impNum(v(r, 'left'));
    return { ref: 'table:' + impHash(key) + nth(key), cands: cands.length ? cands : null, brand: v(r, 'brand') || null, material: mat || null, color_name: col || null,
      hex: v(r, 'hex'), diameter: impNum(v(r, 'diameter')), total, rest: left, used: left === null ? impNum(v(r, 'used')) : null,
      empty: impNum(v(r, 'empty')), price: impNum(v(r, 'price')), location: v(r, 'location') || null, lot: v(r, 'lot') || null, notes: v(r, 'notes') || null, extra: [] };
  });
}
const IMP_FORMATS = [['3dsearch', impOwn], ['spooldb', impSpoolDb], ['octosm', impOctoSm], ['spoolman', impSpoolman], ['table', impGeneric]];

async function spoolImport(inp) {
  let raw = inp.data;
  if (inp.url) {
    // Spoolman im Heimnetz: „192.168.1.20“ → http://192.168.1.20:7912
    let u = String(inp.url).trim().replace(/\/+$/, '').replace(/\/api\/v1\/spool.*$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    if (!/^https?:\/\/[^/]+:\d+/i.test(u) && /^http:\/\//i.test(u)) u = u.replace(/^(http:\/\/[^/]+)/i, '$1:7912');
    let r = null; try { r = await native('http', { url: u + '/api/v1/spool?allow_archived=true', timeout: 15000 }); } catch (e) {}
    if (!r || r.status !== 200) { diag({ a: 'spool_import', err: r ? 'http_' + r.status : 'unreachable', d: 'spoolman' }); fail('import_url'); }
    raw = r.text;
  }
  if (!raw || String(raw).length > 20 * 1024 * 1024) fail('import_bad');
  const dec = impDecode(raw);
  if (dec && dec.app === 'AllMyPrinters') fail('import_backup');
  let rows = null, format = null;
  for (const [n, fn] of IMP_FORMATS) { try { rows = fn(dec); } catch (e) { rows = null; } if (rows && rows.length) { format = n; break; } }
  if (!rows || !rows.length) fail('import_bad');
  const cat = await catalog();
  const byKey = impCatKeys(cat);
  const commit = inp.mode === 'commit';
  const res = { format, spools: 0, new: 0, update: 0, archived: 0, catalog_match: 0, locations: 0, extra: 0, renumbered: 0 };
  const locs = new Set();
  for (const sp of rows) {
    res.spools++; if (sp.archived) res.archived++;
    const { row, fil, loc } = impRow(sp, cat, byKey);
    if (fil) res.catalog_match++;
    if (loc) locs.add(loc);
    if (sp.extra && sp.extra.length) res.extra++;
    const cur = db.spools.find(s => s.ext_ref === sp.ref);
    cur ? res.update++ : res.new++;
    if (!commit) continue;
    if (cur) {
      // Fremde Quellen lassen das Archiv in Ruhe, der 3DSEARCH-Export ist der volle Stand
      if (sp.full) row.archived_at = sp.archived ? (cur.archived_at || now()) : null;
      const before = leftOf(cur);
      Object.assign(cur, row);
      if (sp.nfc && sp.nfc.length) nfcAdd(cur, sp.nfc, 'spoolman');
      const after = leftOf(cur);
      if (before !== after) book(cur, before - after, 'correction', 'import', '', null, false);
    } else {
      const ns = { id: spoolId(smNum({ ext_ref: sp.ref })), ...row, ext_ref: sp.ref, over_g: 0, created_at: now(), archived_at: sp.archived ? now() : null };
      db.spools.push(ns);
      if (sp.nfc && sp.nfc.length) nfcAdd(ns, sp.nfc, 'spoolman');
    }
    if (loc) addLocation(loc);
  }
  res.locations = locs.size;
  if (commit) res.renumbered = smRenumber();   // früher übernommene Spoolman-Spulen bekommen jetzt auch Spoolmans Nummer
  diag({ a: 'spool_import', err: '', d: `${format} ${res.spools} ${commit ? 'commit' : 'preview'}` });
  if (commit) await persist(true);
  return { committed: commit, result: res };
}
/** Katalog nach Hersteller|Material|Name (1,75 mm bevorzugt) — für den Abgleich übernommener Spulen. */
function impCatKeys(cat) {
  const byKey = new Map();
  for (const it of cat.items) { const k = impCk(it.vendor, it.material, it.name); if (!byKey.has(k) || it.diameter === 1.75) byKey.set(k, it); }
  return byKey;
}
const impCk = (v, m, n) => [v, m, n].map(x => String(x || '').trim().toLowerCase()).join('|');
/** Eine erkannte Spule (Ausgabe der imp*-Leser) → Felder der Spule in der App, mit Katalogtreffer. */
function impRow(sp, cat, byKey) {
  let fil = sp.fmid ? cat.byId.get(sp.fmid) || null : null;
  if (!fil && sp.brand) for (const [m, n] of sp.cands || [[sp.material, sp.color_name]]) { if (m && n && (fil = byKey.get(impCk(sp.brand, m, n)))) break; }
  let total = Math.round(sp.total || (fil && fil.weight_g) || 1000);
  if (sp.rest !== null && sp.rest !== undefined) total = Math.max(total, Math.round(sp.rest));
  total = clamp(total, 1, 10000);
  // Spoolman rechnet mit Nachkommastellen (971,26 g) — die bleiben, wie in der App seit 0.6.2
  const used = clamp(Math.round((sp.used ?? (sp.rest !== null && sp.rest !== undefined ? total - sp.rest : 0)) * 100) / 100, 0, total);
  const ppk = sp.ppk ? sp.ppk : sp.price > 0 ? Math.round(sp.price * 100000 / total) / 100 : null;
  const material = String(sp.material || (fil && fil.material) || 'PLA').replace(/\s+/g, ' ').trim().slice(0, 20);
  const colorName = str(sp.color_name, 50) || (fil ? String(fil.name).slice(0, 50) : null);
  const h = /^#?([0-9a-f]{6})/i.exec(String(sp.hex || '').trim());
  const loc = str(sp.location, 60);
  const row = {
    fm_filament_id: fil ? fil.id : null, brand: str(sp.brand, 100) || (fil ? fil.vendor : null), material, color_name: colorName,
    color_hex: h ? '#' + h[1].toLowerCase() : fil && fil.color ? fil.color : '#888888',
    color_hexes: fil && fil.colors ? fil.colors.map(c => c.slice(1)).join(',') : sp.hexes ? String(sp.hexes).replace(/#/g, '') : null,
    weight_total: total, weight_used: used, price_per_kg: ppk && ppk < 10000 ? ppk : null,
    location: loc, lot_nr: str(sp.lot, 60), notes: str([sp.notes, ...(sp.extra || [])].filter(Boolean).join(' · '), 255),
    empty_spool_g: sp.empty !== null && sp.empty !== undefined ? clamp(Math.round(sp.empty), 0, 2000) : fil ? (fil.spool_weight_g || fil.vendor_spool || null) : null,
    diameter: sp.diameter ? clamp(sp.diameter, 1, 3.5) : fil ? fil.diameter : 1.75,
    first_used_at: sp.first || null, last_used_at: sp.last || null,
  };
  if (sp.dried) { const dd = impDate(sp.dried); if (dd) row.dried_at = dd; }
  const matIn = row.color_name && row.color_name.toLowerCase().includes(row.material.toLowerCase());
  row.name = (sp.full && sp.name ? sp.name : [row.brand, matIn ? null : row.material, row.color_name].filter(Boolean).join(' ').trim() || row.material).slice(0, 100);
  return { row, fil, loc };
}

// ── Eigene Slicer-Profile (Experten-Einstellungen) + Import eines OrcaSlicer-Prozessprofils (09.11.2026, Wunsch Adam) ──
// Nur die Werte, die der Server beim Slicen annimmt (PS_X_PROC in print_slice_lib.php, gleiche Grenzen). Alles andere aus
// der Datei wird gezählt und gemeldet, nie übernommen (z. B. post_process = Skripte, eigener G-Code).
const PF_E = {
  sparse_infill_pattern: ['grid', 'gyroid', 'honeycomb', 'cubic', 'adaptivecubic', 'triangles', 'tri-hexagon', 'rectilinear', 'line', 'lightning', 'crosshatch', '3dhoneycomb'],
  seam_position: ['aligned', 'nearest', 'back', 'random'], ironing_type: ['no ironing', 'top', 'topmost', 'solid'], fuzzy_skin: ['none', 'external', 'all'],
  print_sequence: ['by layer', 'by object'], support_type: ['tree(auto)', 'organic', 'normal(auto)'],
  brim_type: ['auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'brim_ears', 'no_brim'],
};
const PF_N = { layer_height: [0.04, 0.6], wall_loops: [1, 20, 1], top_shell_layers: [0, 50, 1], bottom_shell_layers: [0, 50, 1], sparse_infill_density: [0, 100, 1],
  support_threshold_angle: [0, 90, 1], support_top_z_distance: [0, 1], support_bottom_z_distance: [0, 1], support_object_xy_distance: [0, 5],
  support_interface_top_layers: [0, 10, 1], brim_width: [0, 30], skirt_loops: [0, 10, 1] };
const PF_KEYS = [...Object.keys(PF_N), ...Object.keys(PF_E), 'support_on_build_plate_only', 'enable_prime_tower'];   // Reinigungsturm seit 25.11.2026
const PF_META = /^(name|inherits|from|version|type|setting_id|is_custom_defined|instantiation|print_settings_id|base_id|user_id|updated_time|description|compatible_printers.*|compatible_prints.*|print_compatible_printers|filament_settings_id|printer_settings_id|printer_model|default_print_profile)$/;
/** Ein Wert → Formularwert (wie im Expertenfeld) oder null, wenn außerhalb der Grenzen / unbekannt */
function pfVal(k, v) {
  if (Array.isArray(v)) v = v[0];
  v = String(v ?? '').trim();
  if (v === '' || v === 'nil') return null;
  if (k === 'support_on_build_plate_only' || k === 'enable_prime_tower') return v === '1' || v === 'true' ? '1' : v === '0' || v === 'false' ? '0' : null;
  if (PF_E[k]) return PF_E[k].includes(v) ? v : null;
  const r = PF_N[k]; if (!r) return null;
  const n = parseFloat(v.replace('%', '').replace(',', '.'));
  if (!Number.isFinite(n) || n < r[0] || n > r[1]) return null;
  return String(r[2] ? Math.round(n) : Math.round(n * 1000) / 1000);
}
function pfClean(vals) {
  const out = {};
  for (const [k0, v] of Object.entries(vals || {})) { const k = k0.replace(/^x_/, ''); if (!PF_KEYS.includes(k)) continue; const c = pfVal(k, v); if (c !== null) out[k] = c; }
  return out;
}
/** OrcaSlicer-Prozessprofil (.json aus dem user/…/process-Ordner) oder Konfiguration als key = value (.ini) lesen */
function pfParse(text, file) {
  const raw = String(text || '');
  if (raw.startsWith('PK')) fail('pf_zip');
  let o = null;
  const s = raw.replace(/^﻿/, '').trim();
  if (s.startsWith('{')) { try { o = JSON.parse(s); } catch (e) { fail('pf_bad'); } }
  else { o = {}; for (const l of s.split(/\r?\n/)) { const m = /^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(l); if (m) o[m[1]] = m[2]; } }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Object.keys(o).length) fail('pf_bad');
  const type = String(o.type || '').toLowerCase();
  if (type === 'filament' || type === 'machine' || type === 'printer') fail('pf_type');
  const vals = {}, bad = [], other = { speed: 0, accel: 0, width: 0, rest: 0 };
  // Stützen: Orca trennt Art (tree/normal, auto/manual) und Stil (organic …) — die App kennt tree(auto), organic, normal(auto)
  const st = String(o.support_type || ''), sty = String(o.support_style || '');
  if (st) { const v = /^tree/.test(st) ? (sty === 'organic' ? 'organic' : 'tree(auto)') : /^normal/.test(st) ? 'normal(auto)' : null; if (v) vals.support_type = v; else bad.push('support_type'); }
  for (const [k, v] of Object.entries(o)) {
    if (PF_META.test(k) || k === 'support_type' || k === 'support_style' || k === 'enable_support') continue;
    if (PF_KEYS.includes(k)) { const c = pfVal(k, v); if (c !== null) vals[k] = c; else bad.push(k); continue; }
    if (/_speed$|^speed_/.test(k)) other.speed++; else if (/_acceleration$|_jerk$/.test(k)) other.accel++; else if (/_line_width$/.test(k)) other.width++; else other.rest++;
  }
  if (!Object.keys(vals).length) fail(bad.length ? 'pf_range' : 'pf_none');
  const name = String(o.name || String(file || '').replace(/\.(json|ini)$/i, '') || 'Orca').trim().slice(0, 40);
  return { name, vals, bad, other, sup: o.enable_support === undefined ? null : String(o.enable_support) === '1' };
}
function pfUpsert(name, vals) {
  db.profiles = db.profiles || [];
  const nm = String(name || '').trim().slice(0, 40) || 'Profil';
  let p = db.profiles.find(x => x.name.toLowerCase() === nm.toLowerCase());
  if (p) { p.vals = vals; p.updated_at = now(); }
  else { p = { id: nextId('profile'), name: nm, vals, created_at: now() }; db.profiles.push(p); }
  persist();
  return p;
}

// ── Verlauf + Statistik ────────────────────────────────────────────────────
function history(inp) {
  const lim = 100;
  let rows = db.usage.slice().sort((a, b) => b.id - a.id);
  if (inp.spool) rows = rows.filter(u => u.spool_id === +inp.spool);
  if (inp.before) rows = rows.filter(u => u.id < +inp.before);
  const more = rows.length > lim;
  const items = rows.slice(0, lim).map(u => {
    const s = db.spools.find(x => x.id === u.spool_id) || {};
    const j = u.ref ? db.jobs.find(x => x.ref === u.ref) : null;
    return { id: u.id, spool_id: u.spool_id, grams: u.grams, kind: u.kind, ref: u.ref, note: u.note, created_at: u.created_at,
             name: s.name, brand: s.brand, material: s.material, color_hex: s.color_hex, provider: j ? 'moonraker' : null,
             printer: u.printer || (j ? printerName(j.printer_id) : null),
             cost: s.price_per_kg != null && u.grams > 0 && ['print', 'queue', 'manual'].includes(u.kind) ? Math.round(u.grams * s.price_per_kg / 10) / 100 : null,
             title: j ? j.title : null };
  });
  const out = { items, more };
  if (!inp.before && !inp.spool) {
    const t30 = Date.now() - 30 * 864e5, t7 = Date.now() - 7 * 864e5;
    const real = db.usage.filter(u => ['print', 'queue', 'manual'].includes(u.kind) && ts(u.created_at) >= t30);
    out.sum = { g7: real.filter(u => u.grams > 0 && ts(u.created_at) >= t7).reduce((a, u) => a + u.grams, 0),
                g30: real.filter(u => u.grams > 0).reduce((a, u) => a + u.grams, 0), n30: real.length };
  }
  return out;
}
const printerName = pid => (db.printers.find(p => p.id === pid) || {}).name || null;
function colorFamily(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return 'grey';
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const flat = () => l > 0.85 ? 'white' : l < 0.18 ? 'black' : 'grey';
  if (d < 0.08) return flat();
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  if (s < 0.15) return flat();
  let hh = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * (((b - r) / d) + 2) : 60 * (((r - g) / d) + 4);
  if (hh < 0) hh += 360;
  if (l < 0.3 && hh >= 15 && hh < 45) return 'brown';
  if (hh < 15 || hh >= 340) return 'red';
  if (hh < 45) return 'orange'; if (hh < 70) return 'yellow'; if (hh < 165) return 'green'; if (hh < 250) return 'blue'; if (hh < 290) return 'purple';
  return 'pink';
}
// Gezählt wird, was wirklich verbraucht wurde (gebucht oder geparkt) — wie die Statistik auf 3DSEARCH
const countedJobs = () => db.jobs.filter(j => j.status !== 1 && j.state !== 'before_connect' && j.state !== 'duplicate');
function jobPaint(j) {
  const p = (j.paint || []).filter(x => x.g > 0);
  return p.length ? p : j.grams ? [{ g: j.grams, material: '?' }] : [];
}
function stats() {
  const ym = d => d.slice(0, 7);
  const months = {}, mmeta = {}, mat = {};
  const start = new Date(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 11);
  const from = start.toISOString().slice(0, 7);
  let prints = 0;
  for (const j of countedJobs()) {
    const w = j.end || j.start; if (!w || ym(w) < from) continue;
    prints++;
    const k = ym(w);
    mmeta[k] = mmeta[k] || { n: 0, cost: 0, run: null }; mmeta[k].n++; mmeta[k].cost += j.cost || 0;
    const rc = runCost(j); if (rc && rc.total !== null) mmeta[k].run = (mmeta[k].run || 0) + rc.total;   // Strom + Verschleiß (Monatsgrafik)
    for (const p of jobPaint(j)) {
      const m = String(p.material || '').toUpperCase().trim() || '?';
      (months[k] = months[k] || {})[m] = (months[k][m] || 0) + p.g; mat[m] = (mat[m] || 0) + p.g;
    }
  }
  // Alle 12 Monate, auch leere (die Grafik zeigt Lücken)
  const all = {};
  for (let i = 0; i < 12; i++) { const d = new Date(start); d.setUTCMonth(start.getUTCMonth() + i); const k = d.toISOString().slice(0, 7); all[k] = months[k] || {}; mmeta[k] = mmeta[k] || { n: 0, cost: 0, run: null }; }
  const act = db.spools.filter(s => !s.archived_at);
  const lefts = act.map(leftOf);
  const stock = { spools: act.length, grams: lefts.reduce((a, b) => a + b, 0), value: Math.round(act.reduce((a, s, i) => a + (s.price_per_kg != null ? lefts[i] * s.price_per_kg / 1000 : 0), 0) * 100) / 100,
                  low: act.filter((s, i) => warnLvl(s, lefts[i]) > 0).length, priced: act.filter(s => s.price_per_kg != null).length };
  const tot = act.reduce((a, s) => a + (s.weight_total | 0), 0);
  stock.fill_pct = tot > 0 ? Math.round(stock.grams / tot * 100) : null;
  const d90 = {}, t90 = Date.now() - 90 * 864e5;
  for (const j of countedJobs()) if (ts(j.end || j.start) >= t90) for (const p of jobPaint(j)) { const m = String(p.material || '').toUpperCase() || '?'; d90[m] = (d90[m] || 0) + p.g / 90; }
  const bm = {};
  act.forEach((s, i) => { const b = bm[s.material] || (bm[s.material] = { material: s.material, n: 0, g: 0 }); b.n++; b.g += lefts[i]; });
  const by_material = Object.values(bm).sort((a, b) => b.g - a.g).map(b => { const pd = d90[String(b.material).toUpperCase()] || 0; return { ...b, per_day: Math.round(pd * 10) / 10, days: pd > 0.5 ? Math.floor(b.g / pd) : null }; });
  const win = (a, b) => { const js = db.jobs.filter(j => j.state !== 'before_connect' && ts(j.end || j.start) >= a && ts(j.end || j.start) < b); return { ok: js.filter(j => j.status === 2).length, fail: js.filter(j => j.status === 3).length, g: js.filter(j => j.status !== 1).reduce((x, j) => x + (j.grams_real ?? j.grams ?? 0), 0) }; };
  const n30 = win(Date.now() - 30 * 864e5, Date.now() + 1), p30 = win(Date.now() - 60 * 864e5, Date.now() - 30 * 864e5);
  const t30 = Date.now() - 30 * 864e5;
  const last30 = { grams: Math.round(n30.g), cost: 0, logged: Math.round(db.usage.filter(u => ts(u.created_at) >= t30).reduce((a, u) => a + u.grams, 0)), prev_grams: Math.round(p30.g), ok: n30.ok, fail: n30.fail };
  const pr = {};
  for (const j of db.jobs.filter(j => j.state !== 'before_connect')) {
    const p = pr[j.printer_id] || (pr[j.printer_id] = { provider: 'moonraker', name: printerName(j.printer_id) || '?', n: 0, ok: 0, g: 0, secs: 0 });
    if (j.status === 1) continue;
    p.n++; if (j.status === 2) p.ok++; p.g += j.grams_real ?? j.grams ?? 0; p.secs += j.print_s || 0;
  }
  const printers = Object.values(pr).filter(p => p.n).map(p => ({ provider: p.provider, name: p.name, n: p.n, ok: p.ok, g: Math.round(p.g), hours: Math.round(p.secs / 360) / 10 }));
  const fam = {};
  for (const j of countedJobs()) for (const p of jobPaint(j)) { if (!p.color) continue; const k = colorFamily(p.color); const f = fam[k] || (fam[k] = { g: 0, hex: {} }); f.g += p.g; f.hex[p.color.slice(1)] = (f.hex[p.color.slice(1)] || 0) + p.g; }
  const colors = Object.entries(fam).sort((a, b) => b[1].g - a[1].g).slice(0, 8).map(([k, f]) => ({ family: k, g: Math.round(f.g), hex: '#' + Object.entries(f.hex).sort((a, b) => b[1] - a[1])[0][0] }));
  const top = {};
  for (const u of db.usage) if ((u.kind === 'print' || u.kind === 'manual') && u.grams > 0 && ts(u.created_at) >= t30) top[u.spool_id] = (top[u.spool_id] || 0) + u.grams;
  const top_spools = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, g]) => ({ id: +id, g: Math.round(g) }));
  const rec = { heavy: null, long: null, avg_g: null, hours: 0 };
  const fin = db.jobs.filter(j => j.status === 2 && j.state !== 'before_connect');
  for (const j of fin) {
    const gg = j.grams_real ?? j.grams ?? 0, ss = j.print_s || 0;
    if (gg > 0 && (!rec.heavy || gg > rec.heavy.g)) rec.heavy = { name: j.title, g: Math.round(gg) };
    if (ss > 0 && (!rec.long || ss > rec.long.s)) rec.long = { name: j.title, s: ss };
  }
  const wg = fin.filter(j => (j.grams_real ?? j.grams) > 0);
  rec.avg_g = wg.length ? Math.round(wg.reduce((a, j) => a + (j.grams_real ?? j.grams), 0) / wg.length) : null;
  rec.hours = Math.round(db.jobs.filter(j => j.state !== 'before_connect').reduce((a, j) => a + (j.print_s || 0), 0) / 3600);
  const mm = {};
  for (const k of Object.keys(all)) mm[k] = { n: mmeta[k].n, cost: Math.round(mmeta[k].cost * 100) / 100, run: mmeta[k].run != null ? Math.round(mmeta[k].run * 100) / 100 : null };
  return { stock, last30, prints, months, months_all: all, months_meta: mm, materials: mat, by_material, printers, colors, top_spools, records: rec };
}

// ── Drucker: Moonraker (Klipper, Rinkhals auf Anycubic Kobra, KIAUH …) ─────
const live = {};   // id → { entry, at, objects, meta: {datei → …}, thumbs: {datei → dataURL}, histAt, model }
const mrUrl = (p, path) => `http://${p.host}:${p.port || 7125}${path}`;
async function mrGet(p, path, timeout = 4000) {
  const r = await native('http', { url: mrUrl(p, path), timeout, headers: p.key ? { 'X-Api-Key': p.key } : {} });
  if (r.status === 401 || r.status === 403) fail('unauthorized');
  if (r.status >= 400) fail('http_' + r.status);
  const d = JSON.parse(r.text || '{}');
  return d.result !== undefined ? d.result : d;
}
async function mrPost(p, path, body, timeout = 8000) {
  const r = await native('http', { url: mrUrl(p, path), method: 'POST', timeout, body: JSON.stringify(body || {}),
                                   headers: Object.assign({ 'Content-Type': 'application/json' }, p.key ? { 'X-Api-Key': p.key } : {}) });
  if (r.status >= 400) { let m = ''; try { m = JSON.parse(r.text).error.message; } catch (e) {} const e = new Error('http_' + r.status); e.msg = m; throw e; }
  try { const d = JSON.parse(r.text || '{}'); return d.result !== undefined ? d.result : d; } catch (e) { return {}; }
}
const qs = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + (v === null ? '' : '=' + encodeURIComponent(v))).join('&');
// Mehrfarbeinheiten unter Klipper: mmu/mmu_machine = Happy Hare und Anycubic ACE (Rinkhals), box = Creality-CFS (K1/K2),
// box_extras + save_variables (+ multi_color_controller) = QIDI Box, AFC_lane … = Box Turtle / U1 Extended, print_task_config = U1 Original-Firmware
const MR_OBJ = ['webhooks', 'print_stats', 'virtual_sdcard', 'display_status', 'extruder', 'heater_bed', 'mmu', 'mmu_machine', 'box', 'box_extras', 'save_variables', 'multi_color_controller', 'toolhead', 'print_task_config', 'AFC', 'gcode_move'];
const MR_ATTRS = { gcode_move: 'speed_factor', toolhead: 'extruder', print_task_config: 'filament_type,filament_color_rgba,filament_exist,extruder_map_table,extruders_used,reprint_info',
                   AFC_lane: 'name,lane,extruder,map,material,color,spool_id,load,prep,tool_loaded', AFC_stepper: 'name,lane,extruder,map,material,color,spool_id,load,prep,tool_loaded',
                   AFC: 'lanes', box_extras: 'box_drying_state', save_variables: 'variables', multi_color_controller: 'box',
                   heater_generic: 'temperature,target', aht20_f: 'temperature,humidity' };
const cfsIndex = n => { const m = /^T([1-4])([A-D])$/.exec(String(n || '')); return m ? (+m[1] - 1) * 4 + m[2].charCodeAt(0) - 65 : null; };
/** Creality-CFS (Objekt box) → Fächer 1A–4D wie pc_cfs_box auf 3DSEARCH. */
function cfsBox(box) {
  if (!box || typeof box !== 'object') return null;
  const names = {};
  for (const sm of box.same_material || []) if (Array.isArray(sm) && String(sm[3] || '').trim()) for (const sl of sm[2] || []) names[String(sl)] = String(sm[3]).trim();
  const slots = [], boxes = []; let last = -1;
  const pos = v => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };
  for (let u = 1; u <= 4; u++) {
    const t = box['T' + u];
    if (!t || t.state !== 'connect') continue;
    for (let i = 0; i < 4; i++) {
      const code = String((t.material_type || [])[i] ?? '-1').trim(), col = String((t.color_value || [])[i] ?? '-1').trim();
      // „unknown“: Spule ohne RFID — Fach belegt, Material unbekannt (HelixScreen K2-Mitschnitt; vorher stand „unknown“ als Material da)
      const unk = code.toLowerCase() === 'unknown';
      const filled = !['', '-1', 'none'].includes(code.toLowerCase()) && col !== '-1';
      const cm = /^0?([0-9a-f]{6})$/i.exec(col);
      slots.push({ index: (u - 1) * 4 + i, label: u + String.fromCharCode(65 + i), sku: filled && !unk ? code.slice(0, 20) : null,
                   material: filled ? (names['T' + u + String.fromCharCode(65 + i)] ? String(names['T' + u + String.fromCharCode(65 + i)]).slice(0, 30) : unk ? null : code.slice(0, 30)) : null,
                   color: filled && cm ? '#' + cm[1].toLowerCase() : null });
    }
    last = (u - 1) * 4 + 3;
    const hum = pos(t.dry_and_humidity), tc = pos(t.temperature);
    boxes.push({ id: u - 1, label: (String(box.type || '').trim().slice(0, 20) || 'CFS') + ' ' + u, dry: null, control: false, temp: tc !== null ? Math.round(tc) : null, humidity: hum !== null && hum <= 100 ? Math.round(hum) : null });
  }
  if (!slots.length) return null;
  const ttg = Array.from({ length: last + 1 }, (_, i) => i);
  for (const [tool, slot] of Object.entries(box.map || {})) { const ti = cfsIndex(tool), si = cfsIndex(slot); if (ti !== null && si !== null && ti <= last) ttg[ti] = si; }
  return { slots, boxes, ttg, cur: +box.filament === 1 ? cfsIndex(box.extruder_last_tnn) : null };
}
/**
 * QIDI Box (Prüfung 11.11.2026, vorher falsches Format → Box nie erkannt): Stand liegt in save_variables.variables —
 * box_count, slotN (0 leer, 1/3 bereit, 2 geladen, <0 gesperrt), filament_slotN/color_slotN/vendor_slotN als Nummern in
 * officiall_filas_list.cfg ([filaN] filament/type, [colordict], [vendor_list]; color_slotN auch als Liste ['228332']),
 * value_tN = "slotM" (Werkzeug → Fach), last_load_slot "slotM"/"slot-1", is_tool_change. Neuere Firmware zusätzlich
 * multi_color_controller.box mit box<B>_filament_info_<I>_filament_type. Temperatur/Feuchte: heater_generic/aht20_f heater_box<n>,
 * Trocknen: box_extras.box_drying_state.box<n>. Quellen: QIDI_Q2/QIDI_PLUS4-Konfigurationen, HelixScreen qidi_status_parse.cpp.
 */
function qidiPalette(text) {
  const pal = { fila: {}, color: {}, vendor: {} }; let sec = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = /^\s*\[([^\]]+)\]/.exec(line); if (h) { sec = h[1].trim(); continue; }
    const kv = /^\s*([^=#;]+?)\s*=\s*(.*?)\s*$/.exec(line); if (!kv) continue;
    const m = /^fila(\d+)$/.exec(sec);
    if (m) (pal.fila[+m[1]] = pal.fila[+m[1]] || {})[kv[1]] = kv[2];
    else if (sec === 'colordict' && /^\d+$/.test(kv[1])) pal.color[+kv[1]] = kv[2];
    else if (sec === 'vendor_list' && /^\d+$/.test(kv[1])) pal.vendor[+kv[1]] = kv[2];
  }
  return pal;
}
function qidiBox(st, pal) {
  const v = (st.save_variables || {}).variables;
  if (!v || typeof v !== 'object') return null;
  const mcc = (st.multi_color_controller || {}).box || {};
  let nb = Number.isInteger(+v.box_count) && v.box_count !== undefined ? Math.max(0, Math.min(4, +v.box_count)) : 0;
  if (!nb) { let hi = -1; for (const k of Object.keys(v)) { const m = /^slot(\d+)$/.exec(k); if (m) hi = Math.max(hi, +m[1]); } nb = hi >= 0 ? Math.min(4, Math.floor(hi / 4) + 1) : 0; }
  if (!nb || !('box_extras' in st || 'multi_color_controller' in st || v.box_count !== undefined)) return null;
  const n = nb * 4, P = pal || { fila: {}, color: {}, vendor: {} };
  const id = x => { const t = typeof x === 'string' ? x.trim() : x; return Number.isInteger(+t) && t !== '' && +t >= 0 ? +t : null; };
  const slotNo = x => { const m = /^slot(-?\d+)$/.exec(String(x || '')); return m ? +m[1] : null; };
  const slots = [];
  for (let i = 0; i < n; i++) {
    const stt = Number.isInteger(+v['slot' + i]) && v['slot' + i] !== undefined ? +v['slot' + i] : null;
    const b = Math.floor(i / 4), k = i % 4, fx = key => mcc['box' + b + '_filament_info_' + k + '_' + key];
    let mat = String(fx('filament_type') || '').trim() || null;
    const fv = v['filament_slot' + i];
    if (!mat && typeof fv === 'string' && /^[A-Z]{2,4}\d{2,3}$/.test(fv.trim())) mat = fv.trim().replace(/\d+$/, '');
    else if (!mat) { const fi = id(fv); if (fi) mat = (P.fila[fi] || {}).filament || (P.fila[fi] || {}).type || null; }
    let col = null; const cv = v['color_slot' + i];
    if (Array.isArray(cv)) { const m = /^#?([0-9a-f]{6})/i.exec(String(cv[0] || '')); col = m ? '#' + m[1].toLowerCase() : null; }
    else { const ci = id(cv); const m = ci ? /^#?([0-9a-f]{6})/i.exec(String(P.color[ci] || '')) : null; col = m ? '#' + m[1].toLowerCase() : null; }
    const filled = stt === null ? !!mat : stt >= 1 && stt <= 3;
    slots.push({ index: i, label: nb > 1 ? (b + 1) + '-' + (k + 1) : String(k + 1), sku: null, material: filled && mat ? String(mat).slice(0, 30) : null,
                 color: filled ? col : null, remain_pct: null, state: stt });
  }
  const ttg = Array.from({ length: n }, (_, t) => { const m = slotNo(v['value_t' + t]); return m !== null && m >= 0 && m < n ? m : t; });
  const ll = slotNo(v.last_load_slot), loaded = slots.find(x => x.state === 2);
  const cur = +v.is_tool_change ? null : ll !== null && ll >= 0 && ll < n ? ll : ll === -1 ? null : loaded ? loaded.index : null;
  const drying = (st.box_extras || {}).box_drying_state || {};
  const boxes = Array.from({ length: nb }, (_, b) => {
    const h = st['heater_generic heater_box' + (b + 1)] || {}, a = st['aht20_f heater_box' + (b + 1)] || {}, ds = drying['box' + (b + 1)] || {};
    const tc = Number.isFinite(+a.temperature) && +a.temperature > 0 ? +a.temperature : Number.isFinite(+h.temperature) && +h.temperature > 0 ? +h.temperature : null;
    const hum = Number.isFinite(+a.humidity) && +a.humidity > 0 && +a.humidity <= 100 ? Math.round(+a.humidity) : null;
    const end = +ds.end_time || 0, tt = +h.target || 0;
    return { id: b, label: 'QIDI Box' + (nb > 1 ? ' ' + (b + 1) : ''), control: false, temp: tc !== null ? Math.round(tc) : null, humidity: hum,
             dry: +ds.dry_state && tt > 0 ? { target: Math.round(tt), remain_min: end * 1000 > Date.now() ? Math.round((end * 1000 - Date.now()) / 60000) : 0, duration_min: 0 } : null };
  });
  for (const x of slots) delete x.state;
  return { slots, boxes, ttg, cur };
}
async function qidiPal(p, L) {
  if (L.qpal && (L.qpal.ok || Date.now() - L.qpal.at < 600000)) return L.qpal.pal;
  let pal = null;
  try { const r = await native('http', { url: mrUrl(p, '/server/files/config/officiall_filas_list.cfg'), timeout: 4000, headers: p.key ? { 'X-Api-Key': p.key } : {} }); if (r.status === 200) pal = qidiPalette(r.text); } catch (e) {}
  L.qpal = { ok: !!pal, at: Date.now(), pal };
  return pal;
}
/** AFC-Spuren (Box Turtle, U1 Extended) bzw. U1-Köpfe aus print_task_config → [{material, color, load, extruder, map, spool_id}]. */
function afcLanes(st) {
  // Box Turtle meldet seine Spuren als „AFC_stepper laneN“, HTLF/U1 Extended als „AFC_lane …“ (AFC-Klipper-Add-On, Prüfung 11.11.2026).
  // Welche davon Spuren sind, steht in AFC.lanes (HTLF hat zusätzlich AFC_stepper HTLF_Drive/HTLF_Selector).
  const names = Array.isArray((st.AFC || {}).lanes) ? st.AFC.lanes.map(String) : null;
  const keys = names ? names.map(n => st['AFC_lane ' + n] ? 'AFC_lane ' + n : st['AFC_stepper ' + n] ? 'AFC_stepper ' + n : null).filter(Boolean)
                     : Object.keys(st).filter(k => k.startsWith('AFC_lane '));
  const l = keys.sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1], 'en', { numeric: true })).map(k => st[k]).filter(x => x && typeof x === 'object');
  if (l.length) return l;
  const ptc = st.print_task_config || {}, types = ptc.filament_type || [];
  if (types.length < 2) return [];
  return types.map((tp, i) => ({ material: String(tp), color: String((ptc.filament_color_rgba || [])[i] || ''), load: !!(ptc.filament_exist || [])[i],
                                 extruder: i ? 'extruder' + i : 'extruder', map: ['T' + i] }));
}

/**
 * Druckermodell ohne Raten: 1. Orca-Profilname, den Rinkhals während eines Drucks in virtual_sdcard.printer_settings_id meldet
 * („Anycubic Kobra S1 0.4 nozzle“), 2. Rinkhals-Hostname mit Anycubic-Modellcode („kobra-ks1-9025“ = KS1 = Kobra S1).
 * Rinkhals hat kein configfile-Objekt — deshalb taugt die Kinematik dort nicht. null = unbekannt (Profil wählt der Nutzer).
 */
const KOBRA_CODES = { ks1m: 'Anycubic Kobra S1 Max', ks1: 'Anycubic Kobra S1', k3m: 'Anycubic Kobra 3 Max', k3v2: 'Anycubic Kobra 3 V2', k3: 'Anycubic Kobra 3', k2p: 'Anycubic Kobra 2 Pro', kx: 'Anycubic Kobra X' };
function modelFrom(hostname, settingsId) {
  const sid = String(settingsId || '').trim();
  if (sid) return sid.replace(/\s*\(?0\.\d+ ?(mm )?nozzle\)?$/i, '').trim() || null;
  const m = /^kobra[-_]?(ks1m|ks1|k3m|k3v2|k3|k2p|kx)(?:[-_]|$)/i.exec(String(hostname || ''));
  return m ? KOBRA_CODES[m[1].toLowerCase()] : null;
}

/** Elegoo-Antworten auf „M99999“: {Id, Data:{Name, MachineName, MainboardIP, MainboardID, FirmwareVersion, ProtocolVersion}}. */
function sdcpFound(packets) {
  const out = new Map();
  for (const pk of packets) {
    let j; try { j = JSON.parse(pk.data); } catch (e) { continue; }
    const d = j.Data || j; if (!d.MainboardID && !d.MainboardIP) continue;
    const ip = d.MainboardIP || pk.from;
    if (!out.has(ip)) out.set(ip, { host: ip, port: 3030, kind: 'sdcp', mainboard: d.MainboardID || '', name: d.Name || d.MachineName || 'Elegoo',
                                    model: d.MachineName ? 'Elegoo ' + String(d.MachineName).replace(/^Elegoo\s*/i, '') : null, fw: d.FirmwareVersion || null });
  }
  return [...out.values()];
}

/** CC2-Antworten auf {"id":0,"method":7000} (UDP 52700): {id:0, result:{host_name, machine_model, sn, token_status, lan_status}}. */
function cc2Found(packets) {
  const out = new Map();
  for (const pk of packets) {
    let j; try { j = JSON.parse(pk.data); } catch (e) { continue; }
    const r = j && j.result; if (!r || !r.sn || !r.machine_model) continue;
    const ip = r.ip || pk.from;
    if (!out.has(ip)) out.set(ip, { host: ip, port: 1883, kind: 'cc2', serial: String(r.sn), name: r.host_name || r.machine_model,
      model: 'Elegoo ' + String(r.machine_model).replace(/^Elegoo\s*/i, ''), need_code: r.token_status === 1 || r.token_status === true,
      lan_only: !(r.lan_status === 0 || r.lan_status === false) });
  }
  return [...out.values()];
}

/** Bambu-SSDP (NOTIFY auf UDP 2021): Location = IP, USN = Seriennummer, DevModel/DevName. */
function bambuFound(packets) {
  const out = new Map();
  for (const pk of packets) {
    const t = String(pk.data || ''); if (!/bambulab|bambu\.com/i.test(t)) continue;
    const h = k => { const m = new RegExp('^' + k + ':\\s*(.+)$', 'im').exec(t); return m ? m[1].trim() : ''; };
    const ip = h('Location') || pk.from, sn = h('USN'), code = h('DevModel\\.bambu\\.com');
    if (!ip || out.has(ip)) continue;
    const model = BBL_MODELS[code] || null;
    out.set(ip, { host: ip, port: 8883, kind: 'bambu', serial: sn, name: h('DevName\\.bambu\\.com') || model || 'Bambu Lab', model, need_code: true,
                  lan: /lan/i.test(h('DevConnect\\.bambu\\.com')) });
  }
  return [...out.values()];
}

/** OctoPrint (Application-Keys-Plugin antwortet ohne Schlüssel mit 204) bzw. PrusaLink (Digest „Printer API“)? */
/** Creality OS: GET http://IP/info → {"model", "mac", …}, dazu WebSocket-Port 9999 offen. */
async function crInfo(host, port) {
  try {
    const r = await native('http', { url: `http://${host}:${port || 80}/info`, timeout: 2500, max: 8000 });
    if (r.status !== 200) return null;
    const j = JSON.parse(r.text || '{}');
    if (!j.model || !j.mac) return null;
    const ws = await native('tcpcheck', { host, port: 9999 }).catch(() => ({}));
    if (!ws.open) return null;
    const m = crModel(j.model);
    return { host, port: 9999, kind: 'creality', name: (j.hostname || m || 'Creality').toString().slice(0, 60), model: m, mac: String(j.mac).toLowerCase() };
  } catch (e) { return null; }
}
async function probeOther(host, port) {
  const base = `http://${host}:${port}`;
  { const c = await crInfo(host, port); if (c) return c; }   // Creality OS: /info auf Port 80 (von Hand auch andere Ports)
  try {
    const r = await native('http', { url: base + '/plugin/appkeys/probe', timeout: 2500, max: 2000 });
    if (r.status === 204) return { host, port, kind: 'octoprint', name: 'OctoPrint', model: null, need_key: true };
  } catch (e) {}
  try {
    const r = await native('http', { url: base + '/api/version', timeout: 2500, max: 4000 });
    const wa = String((r.hdr || {})['www-authenticate'] || ''), srv = String((r.hdr || {}).server || '');
    if (r.status === 401 && /digest/i.test(wa) && /printer api|prusa/i.test(wa + srv)) return { host, port, kind: 'prusalink', name: 'Prusa', model: null, need_pass: true };
    if (r.status === 200 && /prusalink|prusa/i.test(r.text || '')) return { host, port, kind: 'prusalink', name: 'Prusa', model: null, need_pass: true };
  } catch (e) {}
  return null;
}

/** Ist unter host:port ein Moonraker? → Kurzbeschreibung für die Suche bzw. das Hinzufügen. */
async function probe(host, port) {
  const mr = await probeMoonraker(host, port);
  return mr || (port === 7125 || (port >= 7126 && port <= 7135) ? null : probeOther(host, port));   // 7126 ff. = weitere Drucker einer KX-Bridge
}
async function probeMoonraker(host, port) {
  const p = { host, port };
  try {
    const info = await mrGet(p, '/server/info', 2500);
    if (!info || !('klippy_state' in info || 'moonraker_version' in info || 'components' in info)) return null;
    let pinfo = {};
    try { pinfo = await mrGet(p, '/printer/info', 2500); } catch (e) { /* Klipper noch nicht bereit */ }
    let model = null, ace = false;
    try {
      const lst = (await mrGet(p, '/printer/objects/list', 2500)).objects || [];
      ace = lst.includes('mmu');
      const q = lst.includes('virtual_sdcard') ? await mrGet(p, '/printer/objects/query?virtual_sdcard=printer_settings_id', 2500) : null;
      model = modelFrom(pinfo.hostname, q && q.status && q.status.virtual_sdcard && q.status.virtual_sdcard.printer_settings_id);
      // Snapmaker U1: Rechnername ist immer „lava“, ein Profilname steht nicht immer drin → wie mrSync an print_task_config erkennen
      // (25.11.2026, Chris' U1 wurde bei der Suche als „lava“ angezeigt)
      if (!model && lst.includes('print_task_config') && (lst.includes('extruder1') || lst.includes('toolhead'))) model = 'Snapmaker U1';
    } catch (e) { model = modelFrom(pinfo.hostname, null); }
    const hn = pinfo.hostname && pinfo.hostname !== 'localhost' && !/^kobra[-_]/i.test(pinfo.hostname) ? pinfo.hostname : '';
    return { host, port, kind: 'moonraker', hostname: hn, mrhost: pinfo.hostname || '', model, ace, klippy: pinfo.state || info.klippy_state || null, rinkhals: /^kobra[-_]/i.test(pinfo.hostname || ''),
             name: model || (hn && hn !== 'kobrax-bridge' ? hn : '') || 'Klipper', version: info.moonraker_version || null };
  } catch (e) {
    // Moonraker lässt dieses Handy nicht zu (nicht in trusted_clients): /access/info geht immer ohne Anmeldung → nach API-Schlüssel fragen
    if (e.message !== 'unauthorized') return null;
    try {
      const ai = await mrGet({ host, port }, '/access/info', 2500);
      if (ai && ('login_required' in ai || 'default_source' in ai || 'available_sources' in ai)) return { host, port, kind: 'moonraker', name: 'Klipper', model: null, need_key: true };
    } catch (e2) {}
    return null;
  }
}

function slotRow(pid, index) {
  let sl = db.slots.find(s => s.printer_id === pid && s.index === index);
  if (!sl) { sl = { id: nextId('slot'), printer_id: pid, index, spool_id: null, pending_g: 0 }; db.slots.push(sl); }
  return sl;
}

async function mrSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = { id: p.id, name: p.name, model: p.model || null, online: false, busy: false, locked: false, img: p.img || null, img_own: !!p.img, cal: calOf(p), lvl: lvlOf(p),
                  temps: null, stats: null, slots: [], boxes: [], orphans: [], job: null, last: null, cam: false,
                  agent: { backend: 'moonraker', klippy: null, klippy_msg: '', silent: false }, host: p.host + ':' + (p.port || 7125), files: true,
                  cam: true, cam_ok: true };   // Live-Bild bleibt im Heimnetz → keine Freigabe wie auf 3DSEARCH nötig
  let pinfo;
  try { pinfo = await mrGet(p, '/printer/info', 3500); }
  catch (e) { entry.amp_err = e.message === 'unauthorized' ? 'key' : 'unreach'; entry.agent = null; finish(p, entry, L); return entry; }
  entry.online = true;
  if (pinfo.hostname && p.mrhost !== pinfo.hostname) { p.mrhost = pinfo.hostname; persist(); }   // Kennung fürs Wiederfinden nach IP-Wechsel
  entry.agent.klippy = pinfo.state || 'unknown';
  // KX-Bridge meldet sich immer als „kobrax-bridge“, der Druckername steht in cpu_info
  L.kx = pinfo.hostname === 'kobrax-bridge'; L.kxName = pinfo.cpu_info || '';
  if (L.kx && !p.model) { p.model = 'Anycubic Kobra X'; entry.model = p.model; persist(); }
  if (!p.model || p.model === 'Anycubic Kobra') {
    const m = modelFrom(pinfo.hostname, null);
    if (m) { p.model = m; entry.model = m; if (p.prof && !p.prof.chosen) p.prof = null; persist(); }
  }
  if (pinfo.state !== 'ready') {
    entry.agent.klippy_msg = String(pinfo.state_message || '').slice(0, 200);
    // printerCard zeigt den Klipper-Hinweis nur offline — Klipper im Fehler ist für den Nutzer „nicht bereit“
    entry.online = false;
    finish(p, entry, L); return entry;
  }
  if (!L.objects || force) {
    const lst = (await mrGet(p, '/printer/objects/list')).objects || [];
    const qidi = lst.includes('box_extras') || lst.includes('multi_color_controller');
    L.objects = MR_OBJ.filter(o => lst.includes(o) && (qidi || !['save_variables', 'multi_color_controller'].includes(o)))
      .concat(lst.filter(o => o.startsWith('AFC_lane ') || (o.startsWith('AFC_stepper ') && lst.includes('AFC')) || (qidi && /^(heater_generic|aht20_f) heater_box\d$/.test(o))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
      // Weitere Köpfe (Snapmaker U1: extruder1–3, IDEX) — für die Düsentemperatur des aktiven Kopfs
      .concat(lst.filter(o => /^extruder\d+$/.test(o)));
    L.qidi = qidi;
    // Lüfter und Licht (12.11.2026): Bauteillüfter, frei schaltbare Lüfter, Licht-Ausgänge und LEDs (Abfrage getrennt, mrCtl)
    L.ctlObj = lst.filter(o => o === 'fan' || /^fan_generic [\w-]+$/.test(o) || /^(led|neopixel|dotstar|pca9533|pca9632) [\w-]+$/.test(o)
                            || (/^output_pin [\w-]+$/.test(o) && LIGHT_RE.test(o.slice(11))));
    // U1 (Original-Firmware): Material/Farbe je Kopf in print_task_config → Modell „Snapmaker U1“
    if (!p.model && lst.includes('print_task_config') && (lst.includes('extruder1') || lst.includes('toolhead'))) { p.model = 'Snapmaker U1'; entry.model = p.model; persist(); }
    // Bis 25.11.2026 übernahm die Suche beim U1 den Rechnernamen „lava“ (hat jeder U1) als Druckernamen → einmal auf den Modellnamen.
    // Nur wenn der Name noch genau der Rechnername ist (selbst vergebene Namen bleiben).
    if (p.model === 'Snapmaker U1' && p.name === 'lava' && pinfo.hostname === 'lava') { p.name = p.model; entry.name = p.name; persist(); }
  }
  const st = (await mrGet(p, '/printer/objects/query?' + qs(Object.fromEntries(L.objects.map(o => [o, MR_ATTRS[o.split(' ')[0]] || (/^extruder\d+$/.test(o) ? 'temperature,target' : null)]))))).status || {};
  const ps = st.print_stats || {}, vs = st.virtual_sdcard || {}, ds = st.display_status || {};
  const pstate = ps.state || '';
  if (L.lastState !== undefined && L.lastState !== pstate) L.sm = {};   // Druck fertig/gestartet → Spoolman-Bestand gleich neu holen
  entry.busy = pstate === 'printing' || pstate === 'paused';
  // Düse = aktiver Kopf (toolhead.extruder). Beim U1 ist „extruder“ nur Kopf 1 — druckt Kopf 2–4, steht er geparkt und kalt
  // (echter U1 auf 3DSEARCH: toolhead.extruder „extruder1“, extruder PARKED 44 °C; Meldung 11.11.2026 „Düsentemperatur fehlt nach Druckstart“)
  const axName = String((st.toolhead || {}).extruder || ''), nozzle = (/^extruder\d+$/.test(axName) && st[axName]) || st.extruder;
  if (nozzle || st.heater_bed) entry.temps = { nozzle: Math.round((nozzle || {}).temperature || 0), bed: Math.round((st.heater_bed || {}).temperature || 0) };
  if (pstate === 'error' && ps.message) entry.print_error = String(ps.message).slice(0, 200);
  // Rinkhals meldet beim Drucken das Orca-Profil der Datei → genaues Modell, wenn wir es noch nicht kennen
  if ((!p.model || p.model === 'Anycubic Kobra') && vs.printer_settings_id) {
    const m = modelFrom(null, vs.printer_settings_id);
    if (m) { p.model = m; entry.model = m; if (p.prof && !p.prof.chosen) p.prof = null; persist(); }
  }
  if (!L.comps || force || Date.now() - (L.compsAt || 0) > 600000) { try { L.comps = (await mrGet(p, '/server/info')).components || []; L.compsAt = Date.now(); } catch (e) { L.comps = L.comps || []; } }
  // Gesamtwerte höchstens jede Minute
  if (!L.totals || Date.now() - (L.totalsAt || 0) > 60000) { try { L.totals = (await mrGet(p, '/server/history/totals')).job_totals; L.totalsAt = Date.now(); } catch (e) {} }
  if (L.totals) entry.stats = { prints: L.totals.total_jobs || 0, hours: Math.round((L.totals.total_print_time || 0) / 3600), fw: pinfo.software_version ? String(pinfo.software_version).replace(/-.*$/, '') : null };
  L.kobra = /^kobra[-_]/i.test(pinfo.hostname || '');   // Rinkhals (GoKlipper) → Lüfter über M106 P2/P3
  entry.ctl = await mrCtl(p, L, entry.busy, st.gcode_move);

  // Fächer: Happy-Hare-Format (Rinkhals meldet die ACE genauso)
  const mmu = st.mmu, mach = st.mmu_machine || {};
  if (mmu && Array.isArray(mmu.gate_status) && mmu.gate_status.length) {
    const units = [];
    for (let u = 0; u < (mach.num_units || 1); u++) if (mach['unit_' + u]) units.push(mach['unit_' + u]);
    const unitOf = gI => { for (let u = 0; u < units.length; u++) { const un = units[u]; if (gI >= un.first_gate && gI < un.first_gate + un.num_gates) return [u, gI - un.first_gate]; } return [0, gI]; };
    for (let gI = 0; gI < mmu.gate_status.length; gI++) {
      const gs = mmu.gate_status[gI];
      const matr = String((mmu.gate_material || [])[gI] || '').trim();
      const filled = gs > 0 || (gs < 0 && matr !== '');
      const [u, i] = unitOf(gI);
      const sl = slotRow(p.id, gI);
      const gcol = filled ? hhColor(mmu, gI) : null;
      const ace = /anycubic/i.test(String((units[u] || {}).vendor || ''));
      await smMark(p, L, sl, filled ? (mmu.gate_spool_id || [])[gI] : 0, gcol);   // Happy Hare + Spoolman
      entry.slots.push({ slot_id: sl.id, index: gI, label: units.length > 1 ? (u + 1) + '-' + (i + 1) : String(gI + 1),
        material: filled ? (matr.slice(0, 30) || null) : null, color: gcol, sku: null, remain_pct: null, filled,
        spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false,
        // Rinkhals meldet das Fach, aus dem gerade gedruckt wird, mit −1 (Material bleibt gesetzt). Bei echtem Happy Hare heißt −1
        // „unbekannt“ (GATE_UNKNOWN) — dort zählt nur mmu.gate (Prüfung 11.11.2026)
        inuse: entry.busy && ((ace && gs < 0 && matr !== '') || mmu.gate === gI) });
    }
    units.forEach((un, u) => {
      const dry = (un.dryer_status || 'stop') !== 'stop' && (un.dryer_target_temp || 0) > 0 ? { target: un.dryer_target_temp | 0, remain_min: un.dryer_remaining | 0, duration_min: 0 } : null;
      // Rinkhals meldet keine Restzeit → aus unserem eigenen Startbefehl rechnen (wie printer_cloud_lib auf 3DSEARCH)
      const mine = (p.dry || {})[u];
      if (dry && !dry.remain_min && mine && Date.now() - mine.at < mine.minutes * 60000 + 3600000) {
        dry.duration_min = mine.minutes; dry.remain_min = Math.max(0, mine.minutes - Math.floor((Date.now() - mine.at) / 60000));
      }
      entry.boxes.push({ id: u, label: (un.vendor === 'Anycubic' ? 'ACE ' : 'MMU ') + (u + 1), dry,
                         control: un.vendor === 'Anycubic' && (L.comps || []).includes('mmu_ace'),
                         temp: un.dryer_temp ? un.dryer_temp | 0 : null, humidity: un.dryer_humidity && un.dryer_humidity <= 100 ? un.dryer_humidity | 0 : null });
    });
    entry.ttg_map = (mmu.ttg_map || []).map(Number);
  } else if (L.unit = cfsBox(st.box) || (L.qidi ? qidiBox(st, await qidiPal(p, L)) : null)) {
    // Creality-CFS bzw. QIDI Box: Fach im Kopf (cur) zählt erst, wenn gedruckt wird (vorher steht noch das alte Fach drin)
    const u = L.unit, printing = entry.busy && +(ps.print_duration || 0) > 0;
    for (const x of u.slots) {
      const sl = slotRow(p.id, x.index);
      entry.slots.push({ slot_id: sl.id, index: x.index, label: x.label, material: x.material, color: x.color, sku: x.sku || null, remain_pct: x.remain_pct ?? null,
                         spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: printing && u.cur === x.index });
    }
    entry.boxes = u.boxes; entry.ttg_map = u.ttg;
  } else if ((L.lanes = afcLanes(st)).length) {
    // Je Spur ein Fach; Snapmaker U1: Spur i = Kopf i (extruder, extruder1 …), aktiver Kopf = toolhead.extruder
    const lanes = L.lanes, ext = {}, tool = [];
    for (let i = 0; i < lanes.length; i++) {
      const lv = lanes[i];
      const mat = String(lv.material || '').trim();
      // Belegt heißt load/prep (AFC_lane.py); material bleibt ohne Spoolman/default_material_type leer → Fach trotzdem belegt (Prüfung 11.11.2026)
      const known = mat !== '' && mat.toUpperCase() !== 'NONE';
      const filled = 'load' in lv || 'prep' in lv || 'tool_loaded' in lv ? !!(lv.load || lv.prep || lv.tool_loaded) : known;
      const sl = slotRow(p.id, i);
      if (lv.extruder) ext[lv.extruder] = i;
      for (const t of [].concat(lv.map || [])) { const m = /^T(\d+)$/.exec(String(t)); if (m) tool[+m[1]] = i; }   // map ist ein String „T0“ (AFC_lane.py)
      // Spur nennt ihre Spoolman-Spule (U1 Extended: RFID-Tag → Spoolman) → selbst einsetzen
      await smMark(p, L, sl, filled ? lv.spool_id : 0, filled ? mrColor(lv.color) : null);
      entry.slots.push({ slot_id: sl.id, index: i, label: String(i + 1), material: filled && known ? mat.slice(0, 30) : null, color: filled ? mrColor(lv.color) : null, sku: null, remain_pct: null,
                         spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: false, filled });
    }
    const heads = new Set(Object.values(ext)).size > 1;
    const act = heads ? [ext[(st.toolhead || {}).extruder]] : lanes.map((lv, i) => lv.tool_loaded ? i : null);
    if (entry.busy) for (const x of act) if (x != null && entry.slots[x]) entry.slots[x].inuse = true;
    entry.ttg_map = Array.from({ length: Math.max(tool.length, lanes.length) }, (_, i) => tool[i] ?? i);
  } else {
    // Ein Kopf, keine Mehrfarbeinheit: „aktive Spule“ — mit Spoolman in Moonraker die dort gesetzte (SET_ACTIVE_SPOOL)
    const sl = slotRow(p.id, 0);
    let act = 0;
    if ((L.comps || []).includes('spoolman')) {
      if (L.smActAt === undefined || Date.now() - L.smActAt > 30000) { try { L.smAct = +((await mrGet(p, '/server/spoolman/spool_id', 3000)) || {}).spool_id || 0; } catch (e) { L.smAct = L.smAct || 0; } L.smActAt = Date.now(); }
      act = L.smAct;
    }
    await smMark(p, L, sl, act, null);
    entry.slots.push({ slot_id: sl.id, index: 0, label: '1', single: true, material: null, color: null, sku: null, remain_pct: null,
                       spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: entry.busy });
    entry.ttg_map = [0];
  }

  if (entry.busy) {
    const prog = +(ds.progress ?? vs.progress ?? 0), dur = +(ps.print_duration || 0);
    const fn = ps.filename || '';
    const md = await meta(p, L, fn);
    let est = +(md.estimated_time || 0); if (est <= 0) est = +(vs.total_time || 0);
    const rt = +(vs.remain_time || 0);
    const remain = rt > 0 ? rt : (est > dur ? est - dur : (prog > 0.01 ? dur / prog * (1 - prog) : 0));
    entry.job = { name: fn.split('/').pop(), title: jobTitle(fn), progress: Math.floor(prog * 100), remain_min: Math.round(remain / 60),
                  layer: ps.info && ps.info.current_layer != null ? ps.info.current_layer | 0 : null, layers: ps.info && ps.info.total_layer != null ? ps.info.total_layer | 0 : null,
                  img: L.thumbs[fn] || null, speed: null, paused: pstate === 'paused' };
    // Für die spätere Abbuchung merken, welche Fächer dieser Druck benutzt (Rinkhals: −1 = aktiv; Datei: Gramm je Werkzeug)
    L.liveGates = L.liveGates || {};
    const key = fn + '|' + Math.floor((Date.now() / 1000 - dur) / 600);
    const lg = L.liveGates[fn] || (L.liveGates[fn] = { key, gates: [], tools: null });
    entry.slots.filter(s => s.inuse && !s.single).forEach(s => { if (!lg.gates.includes(s.index)) lg.gates.push(s.index); });
    if (!lg.tools && vs.filament_used_g) { const tw = String(vs.filament_used_g).split(',').map(x => parseFloat(x) || 0); if (tw.some(x => x > 0)) lg.tools = tw; }
    const ptc = st.print_task_config;
    if (ptc && Array.isArray(ptc.extruder_map_table)) lg.fmap = ptc.extruder_map_table.slice(0, 32).map(Number);
    entry.job.slots = entry.slots.filter(s => s.inuse).map(s => s.index);
  }

  // Modell unbekannt (alle außer Anycubic/U1/KX): Orca schreibt „; printer_settings_id = Creality K1 Max (0.4 nozzle)“ ans Dateiende
  if (!p.model && !L.modelTried && (L.lastFile || ps.filename)) { L.modelTried = true; modelFromFile(p, L.lastFile || ps.filename).then(m => { if (m && !p.model) { p.model = m; if (p.prof && !p.prof.chosen) p.prof = null; persist(); } }).catch(() => {}); }
  // Druckverlauf: bei Zustandswechsel sofort, sonst höchstens alle 20 s
  const changed = L.lastState !== pstate;
  L.lastState = pstate;
  if (changed || force || Date.now() - L.histAt > 20000) { await mrHistory(p, L, entry); L.histAt = Date.now(); }
  finish(p, entry, L);
  return entry;
}

async function modelFromFile(p, fn) {
  const r = await native('http', { url: mrUrl(p, '/server/files/gcodes/' + String(fn).split('/').map(encodeURIComponent).join('/')), headers: Object.assign({ Range: 'bytes=-131072' }, p.key ? { 'X-Api-Key': p.key } : {}), timeout: 8000, max: 140000 });
  if (r.status !== 206 && r.status !== 200) return null;
  const m = /^;\s*printer_settings_id\s*=\s*(.+)$/m.exec(r.text || '') || /^;\s*printer_model\s*=\s*(.+)$/m.exec(r.text || '');
  return m ? modelFrom(null, m[1].replace(/^"|"$/g, '')) : null;
}

function finish(p, entry, L) {
  const done = db.jobs.filter(j => j.printer_id === p.id && j.status !== 1 && j.state !== 'before_connect').sort((a, b) => ts(b.end || b.start) - ts(a.end || a.start))[0];
  if (done) entry.last = { id: done.id, status: done.status, title: done.title, end: done.end, mk: true };
  if (!entry.slots.length) {   // offline: Fächer aus der Datenbank zeigen, damit die Zuordnung sichtbar bleibt
    const rows = db.slots.filter(s => s.printer_id === p.id).sort((a, b) => a.index - b.index);
    const single = rows.length === 1 && rows[0].index === 0 && !(L.lastSlots || []).length;
    entry.slots = (L.lastSlots && L.lastSlots.length ? L.lastSlots : rows.map(s => ({ slot_id: s.id, index: s.index, label: String(s.index + 1), single, material: null, color: null })))
      .map(s => { const r = db.slots.find(x => x.id === s.slot_id) || {}; return { ...s, spool_id: r.spool_id || null, pending_g: Math.round(r.pending_g || 0), inuse: false }; });
  } else L.lastSlots = entry.slots.map(s => ({ slot_id: s.slot_id, index: s.index, label: s.label, single: s.single, material: s.material, color: s.color }));
  L.entry = entry; L.at = now();
}

async function meta(p, L, fn) {
  if (!fn) return {};
  if (L.meta[fn]) return L.meta[fn];
  let md = {};
  try { md = await mrGet(p, '/server/files/metadata?' + qs({ filename: fn })); } catch (e) { md = {}; }
  L.meta[fn] = md;
  // Vorschaubild: das größte, über die Brücke als data:-Adresse (die Oberfläche darf den Drucker nicht selbst fragen)
  const th = (md.thumbnails || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  if (th && th.relative_path && !L.thumbs[fn]) {
    const dir = fn.includes('/') ? fn.slice(0, fn.lastIndexOf('/') + 1) : '';
    native('http', { url: mrUrl(p, '/server/files/gcodes/' + (dir + th.relative_path).split('/').map(encodeURIComponent).join('/')), binary: true, timeout: 6000, max: 600000,
                     headers: p.key ? { 'X-Api-Key': p.key } : {} })
      .then(r => { if (r.status === 200 && r.b64) L.thumbs[fn] = 'data:image/png;base64,' + r.b64; }).catch(() => {});
  }
  return md;
}

const MR_STATUS = { completed: 2, cancelled: 3, error: 3, klippy_shutdown: 3, klippy_disconnect: 3, server_exit: 3, interrupted: 3, in_progress: 1, printing: 1 };
/** Verlauf abgleichen und buchen. Drucke vor dem Hinzufügen des Druckers nie. App-Drucke sind beim Start schon gebucht → am Ende nur korrigieren. */
/**
 * KX-Bridge (Kobra X über MQTT, ein Moonraker-Nachbau je Drucker auf eigenem Port): /server/history/list ist EINE Liste für
 * alle Drucker der Bridge → nur die eigenen aus /kx/history (wie der 3DSEARCH-Agent, kx_history). Unklar, welcher wir sind →
 * kein Verlauf (lieber nichts als fremde Drucke abbuchen). Gramm liefert die Bridge nie — App-Drucke sind beim Start gebucht.
 */
async function kxHistory(p, L) {
  if (L.kxMine === undefined) {
    let lst = null; try { lst = await mrGet(p, '/kx/printers'); } catch (e) {}
    if (!Array.isArray(lst) || !lst.length) { L.kxMine = null; return null; }
    const port = +(p.port || 7125);
    let mine = lst.filter(x => { try { return +new URL(x.bridge_url).port === port; } catch (e) { return false; } });
    if (!mine.length && L.kxName) mine = lst.filter(x => x.name === L.kxName);
    if (!mine.length && lst.length === 1) mine = lst;
    L.kxMine = mine.length === 1 ? [mine[0].id, mine[0].device_id].filter(x => x !== undefined && x !== null && x !== '').map(String) : [];
  }
  if (!L.kxMine || !L.kxMine.length) return null;
  let rows; try { rows = await mrGet(p, '/kx/history?limit=' + (L.histFull ? 50 : 200), 15000); } catch (e) { return null; }
  if (!Array.isArray(rows)) return null;
  const sec = v => v ? Date.parse(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z')) / 1000 || null : null;
  return { jobs: rows.filter(r => L.kxMine.includes(String(r.printer_id))).map(r => ({ job_id: 'kx' + r.id, filename: r.filename, status: r.status === 'printing' ? 'in_progress' : r.status,
    start_time: sec(r.started_at), end_time: sec(r.ended_at), print_duration: r.duration_sec || 0, filament_used: 0, metadata: {} })) };
}

async function mrHistory(p, L, entry) {
  let h;
  try { h = await mrGet(p, '/server/history/list?' + qs({ order: 'desc', limit: L.histFull ? 20 : 200 }), 6000); } catch (e) { return; }
  if (L.kx) { h = await kxHistory(p, L); if (!h) return; }
  L.histFull = true;
  applyHistory(p, L, h.jobs || []);
}
/** Druckverlauf (Moonraker-Form: job_id, filename, status, start_time, end_time, print_duration, filament_used mm, metadata) abgleichen und buchen. */
function applyHistory(p, L, jobs) {
  const h = { jobs };
  const added = ts(p.added_at);
  if ((h.jobs || [])[0] && h.jobs[0].filename) L.lastFile = h.jobs[0].filename;
  for (const mj of (h.jobs || []).slice().reverse()) {
    const ref = 'mr:' + p.id + ':' + mj.job_id;
    let j = db.jobs.find(x => x.ref === ref);
    const status = MR_STATUS[mj.status] ?? 3;
    const md = mj.metadata || {};
    if (!j) {
      // Von der App gestartet? (Datei + Startzeit passen zu einem Auftrag ohne Moonraker-Nummer)
      // Dateiname ohne Ordner vergleichen: Creality meldet den vollen Pfad (/mnt/UDISK/printer_data/gcodes/x.gcode)
      const bn = f => String(f || '').split('/').pop();
      j = db.jobs.find(x => x.printer_id === p.id && x.ours && !x.ext_id && bn(x.file) === bn(mj.filename) && Math.abs(ts(x.start) / 1000 - (mj.start_time || 0)) < 900);
      if (j) { j.ref = ref; j.ext_id = mj.job_id; }
    }
    if (!j) {
      const start = fromUnix(mj.start_time);
      j = { id: nextId('job'), ref, ext_id: mj.job_id, printer_id: p.id, file: mj.filename, title: jobTitle(mj.filename), status, start, end: null,
            grams: null, paint: [], state: (mj.start_time || 0) * 1000 < added ? 'before_connect' : 'open', ours: false, print_s: 0 };
      db.jobs.push(j);
    }
    j.status = status;
    if (status !== 1) j.how = String(mj.status || '');   // Ende roh (completed/cancelled/error/klippy_shutdown …) → Benachrichtigung Fehler oder Abbruch
    j.print_s = Math.round(mj.print_duration || 0);
    if (status !== 1 && !j.end) j.end = fromUnix(mj.end_time) || now();
    if (j.state === 'before_connect' || j.state === 'booked' || j.state === 'no_data' || j.state === 'parked') continue;
    if (status === 1) continue;
    // ── Ende erreicht: Gramm bestimmen ──
    const plannedMm = +(md.filament_total || 0), usedMm = +(mj.filament_used || 0);
    const ratio = status === 2 ? 1 : plannedMm > 0 ? clamp(usedMm / plannedMm, 0, 1) : null;
    if (j.ours && j.plan) {
      // App-Druck: beim Start voll gebucht; abgebrochen → nicht verbrauchten Teil zurück
      const r = ratio === null ? (usedMm > 0 ? null : 0) : ratio;
      for (const pl of j.plan) {
        const real = r === null ? Math.min(pl.g, mmToG(usedMm / j.plan.length)) : pl.g * r;
        const back = pl.g - real;
        if (back >= 0.5) refund(p, pl, back, j);
        pl.real = real;
      }
      j.grams_real = j.plan.reduce((a, pl) => a + (pl.real ?? pl.g), 0);
      j.paint = j.plan.map(pl => ({ index: pl.slot, g: pl.real ?? pl.g, color: pl.color, material: pl.material }));
      j.state = 'booked';
      continue;
    }
    const fa = adjOf(p.id);   // Verbrauchsausgleich dieses Druckers
    const parts = [];
    if (Array.isArray(mj.parts) && mj.parts.length) {
      // Hersteller-Cloud im Agenten (19.11.2026): Gramm je Fach kommen fertig zugeordnet; abgebrochen nur mit bekanntem Fortschritt
      // actual (Anycubic LAN, 23.11.2026): am Drucker gemessen, also schon der echte Verbrauch → nicht anteilig kürzen
      const r = status === 2 || mj.actual ? 1 : mj.prog != null ? clamp(+mj.prog, 0, 1) : 0;
      // gemessen (actual) enthält Spülen/Vorlauf schon → ohne Verbrauchsausgleich (der gleicht nur Slicer-Gewichte an)
      for (const x of mj.parts) if (+x.g > 0 && r > 0) parts.push({ slot: x.slot, raw: x.g * r, g: x.g * r * (mj.actual ? 1 : fa) });
      if (!parts.length) { j.state = 'no_data'; j.grams = null; continue; }
    } else {
    // Fremder Druck (am Display, aus dem Slicer, über die Anycubic-Cloud)
    // U1-Originalfirmware liefert die Liste als filament_weight (Snapmaker u1-moonraker), Extended/Orca-Patch als filament_weights
    const fwl = Array.isArray(md.filament_weights) ? md.filament_weights : Array.isArray(md.filament_weight) ? md.filament_weight : null;
    let weights = fwl && fwl.some(x => +x > 0) ? fwl.map(Number) : null;
    const lg = (L.liveGates || {})[mj.filename];
    if (!weights && lg && lg.tools) weights = lg.tools;
    if (!weights && +md.filament_weight_total > 0) weights = [+md.filament_weight_total];
    if (!weights && usedMm > 0) weights = [mmToG(usedMm)];
    if (!weights) { j.state = 'no_data'; j.grams = null; continue; }
    const sc = ratio === null ? 1 : ratio;
    const ttg = (L.entry && L.entry.ttg_map) || [];
    const hasMmu = db.slots.some(s => s.printer_id === p.id && s.index > 0) || (L.entry && L.entry.slots.some(s => !s.single));
    weights.forEach((w, tI) => { if (w > 0) parts.push({ tool: tI, raw: w * sc, g: w * sc * fa }); });
    // Datei nur auf T0 (Anycubic-Slicer/Cloud): Fach kennt nur die Live-Meldung während des Drucks
    if (hasMmu && parts.length === 1 && lg && lg.gates.length === 1) parts[0].slot = lg.gates[0];
    for (const pt of parts) if (pt.slot === undefined) pt.slot = hasMmu ? (lg && lg.fmap ? lg.fmap[pt.tool] ?? pt.tool : ttg[pt.tool] ?? pt.tool) : 0;
    }
    j.grams = parts.reduce((a, x) => a + x.g, 0);
    j.grams_real = j.grams;
    j.paint = [];
    let any = false;
    for (const pt of parts) {
      const sl = db.slots.find(s => s.printer_id === p.id && s.index === pt.slot);
      const es = L.entry ? L.entry.slots.find(s => s.index === pt.slot) : null;
      const spool = sl && sl.spool_id ? db.spools.find(s => s.id === sl.spool_id) : null;
      j.paint.push({ index: pt.slot, g: pt.g, color: spool ? spool.color_hex : es && es.color, material: spool ? spool.material : es && es.material });
      if (spool) { book(spool, pt.g, 'print', j.title, j.ref, p.name, true, { pid: p.id, raw: pt.raw }); any = true; }
      else if (sl) { sl.pending_g = (sl.pending_g || 0) + pt.raw; any = true; }
    }
    j.state = any ? 'booked' : 'no_data';
    j.cost = costOf(j);
  }
  persist();
}
function refund(p, pl, back, j) {
  const spool = pl.spool_id ? db.spools.find(s => s.id === pl.spool_id) : null, f = pl.f || 1;
  if (spool) book(spool, -back, 'correction', 'cancel|' + j.title, j.ref, p.name, true, { pid: p.id, raw: -back / f });
  else { const sl = db.slots.find(s => s.printer_id === p.id && s.index === pl.slot); if (sl) sl.pending_g = Math.max(0, (sl.pending_g || 0) - back / f); }
}
function costOf(j) {
  let c = 0, any = false;
  for (const pi of j.paint || []) {
    const sl = db.slots.find(s => s.printer_id === j.printer_id && s.index === pi.index);
    const sp = sl && sl.spool_id ? db.spools.find(s => s.id === sl.spool_id) : null;
    if (sp && sp.price_per_kg != null) { c += pi.g * sp.price_per_kg / 1000; any = true; }
  }
  return any ? Math.round(c * 100) / 100 : null;
}

// ── Kamera: echter Livestream aus dem Heimnetz ─────────────────────────────
// Reihenfolge: Anycubic gkcam (H.264 als FLV auf :18088, das Bild der Anycubic-App) → MJPEG-Stream aus Moonrakers Webcam-Liste
// (crowsnest/mjpg-streamer, Rinkhals) → übliche mjpg-streamer-Adressen → nur Einzelbilder. Geprüft wird jede Quelle kurz.
const b64head = b => { try { return atob(b || ''); } catch (e) { return ''; } };
/** Kennung der ersten Bytes eines Kamera-Stroms (nur Format, kein Inhalt). */
function camMagic(h) {
  const c = i => h.charCodeAt(i);
  if (!h) return 'empty';
  if (h.startsWith('FLV')) return 'flv';
  if (h.slice(4, 8) === 'ftyp' || h.slice(4, 8) === 'moof' || h.slice(4, 8) === 'styp') return 'mp4';
  if (c(0) === 0x47 && (h.length < 189 || c(188) === 0x47)) return 'ts';
  if (c(0) === 0 && c(1) === 0 && (c(2) === 1 || (c(2) === 0 && c(3) === 1))) return 'h264';
  if (c(0) === 0xFF && c(1) === 0xD8) return 'jpeg';
  if (h.startsWith('--') || h.startsWith('\r\n--')) return 'multipart';
  if (h.startsWith('RTSP') || h.startsWith('HTTP')) return h.slice(0, 4).toLowerCase();
  return 'x' + [0, 1, 2, 3].map(i => (c(i) || 0).toString(16).padStart(2, '0')).join('');
}
/** Adresse fürs Protokoll: nur Port + Pfad, Sitzungs-Token (/live/<token>) ausgeblendet. */
const camShort = u => { try { const x = new URL(u); return (x.port || '80') + x.pathname.replace(/\/live\/[^/]+/, '/live/*'); } catch (e) { return '?'; } };
/**
 * Quellen kurz prüfen (64 Byte): FLV-Kopf, MJPEG = multipart, Einzelbild = JPEG. retry = einmal nach 1,2 s nachfassen (gkcam braucht nach
 * startCapture einen Moment). Einzelbilder dürfen länger brauchen (KX-Bridge holt das Bild erst beim Drucker). res = Ergebnis je Adresse.
 */
async function camProbe(cand) {
  const seen = new Set(), ok = [], res = [];
  await Promise.all(cand.filter(c => !seen.has(c.url) && seen.add(c.url)).map(async (c, i) => {
    let why = '';
    for (let k = 0; k < (c.retry ? 2 : 1); k++) {
      if (k) await new Promise(z => setTimeout(z, 1200));
      try {
        const r = await native('http', { url: c.url, timeout: c.kind === 'snap' ? 6000 : 2500, max: 64, binary: true });
        const head = b64head(r.b64), type = String(r.type || '').toLowerCase();
        // 206 zählt wie 200: Kobra X liefert /live/<token> als „Partial Content“ (#85, 10.11.2026 — vorher deshalb verworfen)
        const okStatus = r.status === 200 || r.status === 206;
        if (okStatus && (c.kind === 'flv' ? head.startsWith('FLV') : c.kind === 'mjpeg' ? type.startsWith('multipart/') : head.charCodeAt(0) === 0xFF && head.charCodeAt(1) === 0xD8)) {
          ok.push({ ...c, i }); why = 'ok'; break;
        }
        // Antwort da, aber nicht das erwartete Format → was es ist (Inhaltstyp + Kennung der ersten Bytes) fürs Protokoll
        why = !okStatus ? 'http' + r.status : 'http' + r.status + ' ' + (type.split(';')[0] || 'type?') + ' ' + camMagic(head);
      } catch (e) { why = String(e.message || 'err').slice(0, 24); }
    }
    res[i] = camShort(c.url) + '=' + why;
  }));
  ok.sort((a, b) => a.i - b.i);
  return { ok: ok.map(({ i, retry, ...c }) => c), res: res.filter(Boolean) };
}
/**
 * Kamera-Kandidaten eines Klipper-Hosts: Moonrakers Webcam-Liste, dann übliche mjpg-streamer-Adressen. Relative Adressen auf Port 80
 * (Rinkhals, nginx) UND auf den Moonraker-Port: KX-Bridge liefert /api/camera/… auf ihrem eigenen Port (09.11.2026, Dennys Kobra X —
 * der 3DSEARCH-Agent bekam dort http://<bridge>:7125/api/camera/snapshot). Kein Filter auf den Dienst: Was kein MJPEG ist, fällt beim Prüfen raus.
 */
async function mrCamCands(p, mrPort) {
  const base = `http://${p.host}`, mbase = `http://${p.host}:${mrPort}`, cand = [];
  const fix = v => {
    v = String(v || '').trim(); if (!v) return [];
    if (v.startsWith('/')) return [base + v, mbase + v];
    // Moonraker reicht stream_url/snapshot_url unverändert durch — „webcam/?action=stream“ ohne / ist relativ zum Host (Prüfung 11.11.2026)
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return [base + '/' + v, mbase + '/' + v];
    if (!/^https?:\/\//i.test(v)) return [];
    try { const u = new URL(v); if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) u.hostname = p.host; return [u.toString()]; } catch (e) { return []; }
  };
  try {
    const w = await mrGet({ host: p.host, port: mrPort, key: kindOf(p) === 'moonraker' ? p.key : undefined }, '/server/webcams/list', 3000);
    for (const c of w.webcams || []) {
      if (c.enabled === false) continue;
      // Snapmaker U1 Extended (paxx12 v4l2-mpp stream-http): meldet WebRTC (/webcam/webrtc) + Einzelbild /webcam/snapshot.jpg, liefert daneben
      // aber echtes MJPEG unter /webcam/stream.mjpg — flüssiger als Einzelbilder (25.11.2026, an Chris' U1 im Browser geprüft). Zuerst probieren.
      if (/\/snapshot\.jpg$/i.test(String(c.snapshot_url || '').split('?')[0])) for (const u of fix(String(c.snapshot_url).split('?')[0].replace(/snapshot\.jpg$/i, 'stream.mjpg'))) cand.push({ kind: 'mjpeg', url: u, name: c.name || '' });
      for (const u of fix(c.stream_url)) cand.push({ kind: 'mjpeg', url: u, name: c.name || '' });
      for (const u of fix(c.snapshot_url)) cand.push({ kind: 'snap', url: u, name: c.name || '' });
    }
  } catch (e) { /* kein Moonraker dort oder ohne Webcam-Liste */ }
  for (const f of [base + '/webcam/?action=stream', base + ':8080/?action=stream']) cand.push({ kind: 'mjpeg', url: f });
  for (const f of [base + '/webcam/?action=snapshot', base + ':8080/?action=snapshot']) cand.push({ kind: 'snap', url: f });
  return cand;
}
async function camSources(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  if (kindOf(p) === 'sdcp') {
    // Kamera bei jedem Öffnen einschalten (Cmd 386), MJPEG unter :3031/video; amp_cam_off schaltet sie danach wieder ab,
    // sonst bleibt der Zuschauerplatz am Drucker belegt (Elegoo lässt nur wenige gleichzeitig zu)
    // Antwort auswerten (SDCP V3): Ack 0 ok + VideoUrl, 1 zu viele Zuschauer, 2 keine Kamera — vorher schwarzes Bild ohne Grund (zweite Prüfung 11.11.2026)
    const rid = uuid(), def = `http://${p.host}:${sdPort(p, 'video', 3031)}/video`;
    try { await sdSend(p, 386, { Enable: 1 }, rid); } catch (e) {}
    let r = null;
    for (let i = 0; i < 8 && !r; i++) {
      await new Promise(z => setTimeout(z, 250));
      const s_ = await native('live_state', { key: 'sd_' + p.id }).catch(() => ({}));
      const x = (s_.state || {}).Response_386;
      if (x && x.RequestID === rid) r = x.Data || {};
    }
    if (r && (+r.Ack === 1 || +r.Ack === 2)) { L.camWhy = +r.Ack === 1 ? 'busy' : 'none'; return []; }
    L.camWhy = null;
    const vu = r && /^https?:\/\/[^\s]+$/i.test(String(r.VideoUrl || '')) ? String(r.VideoUrl) : r && /^[\w.-]+:\d+\//.test(String(r.VideoUrl || '')) ? 'http://' + r.VideoUrl : null;
    return vu && vu !== def ? [{ kind: 'mjpeg', url: vu }, { kind: 'mjpeg', url: def }] : [{ kind: 'mjpeg', url: def }];
  }
  // Anycubic LAN: video startCapture → S1/Kobra 3 FLV unter :18088/flv, Kobra 4/X melden eine Adresse je Sitzung (/live/<token>)
  if (kindOf(p) === 'acl') {
    await acSend(p, 'video', 'stopCapture').catch(() => {});
    await new Promise(z => setTimeout(z, 600));
    const t0 = Date.now(); await acSend(p, 'video', 'startCapture').catch(() => {});
    acSend(p, 'info', 'query').catch(() => {});   // frischer info-Bericht = aktuelles Kamera-Token (Kobra X, urls.rtspUrl)
    let u = '';
    for (let i = 0; i < 10 && !u; i++) {
      await new Promise(z => setTimeout(z, 300));
      const S = ((await native('live_state', { key: acKey(p) }).catch(() => ({}))).state) || {};
      // Kobra 4/X: Adresse der startCapture-Antwort steht unter data.urls.rtspUrl (anycubic_ha_local camera.py; zweite Prüfung 11.11.2026)
      if ((S.video_at || 0) >= t0 - 500) u = String(((S.video || {}).urls || {}).rtspUrl || (S.video || {}).url || (S.video || {}).flv_url || '');
      if (S.video_at >= t0 - 500 && !u) break;
    }
    const fix = v => v.replace(/^https?:\/\/[^/:]+(:\d+)?/, (m0, pt) => `http://${p.host}${p.ports && p.ports.cam ? ':' + p.ports.cam : pt || ':18088'}`);
    const flv = { kind: 'flv', url: u && /^https?:\/\//.test(u) ? fix(u) : `http://${p.host}:${acPort(p, 'cam', 18088)}/flv`, retry: true };
    // Kobra X (und Kobra 4): Kameraadresse mit Sitzungs-Token steht im info-Bericht unter urls.rtspUrl — trotz des Namens HTTP,
    // http://<IP>:18088/live/<token>; :18088/flv antwortet dort 429/404 (10.11.2026, Dennys Kobra X, Protokoll cam_acl). S1: rtspUrl leer
    const S0 = ((await native('live_state', { key: acKey(p) }).catch(() => ({}))).state) || {};
    const ru = String(((S0.info || {}).urls || {}).rtspUrl || '');
    const rtsp = /^https?:\/\//.test(ru) && fix(ru) !== flv.url ? [{ kind: 'flv', url: fix(ru), retry: true }] : [];
    // Rinkhals kann die Kamera übernehmen (mjpg-streamer statt gkcam) — dann liefert der Anycubic-Weg kein FLV mehr (09.11.2026, Denny:
    // S1/S1 Max im LAN-Modus ohne Bild, über Rinkhals geht es). Rückfall: Rinkhals' Moonraker auf demselben Drucker (7125)
    const { ok, res } = await camProbe([...rtsp, flv, ...await mrCamCands(p, acPort(p, 'mr', 7125))]);
    if (ok.length) return ok;
    // Nichts gefunden: fürs „Problem melden“ festhalten, was der Drucker auf startCapture gesagt hat (Kobra X im LAN-Modus ungeklärt)
    const S = ((await native('live_state', { key: acKey(p) }).catch(() => ({}))).state) || {}, V = S.video || {};
    // Adresse kam erst nach der ersten (leeren) Bestätigung? Während der Prüfung ist Zeit vergangen — jetzt noch einmal nachsehen
    const u2 = String((V.urls || {}).rtspUrl || V.url || V.flv_url || '');
    // dasselbe für rtspUrl: der info-Bericht mit (neuem) Token kann erst nach dem Lesen oben angekommen sein
    const ru2 = String(((S.info || {}).urls || {}).rtspUrl || '');
    const lateC = [];
    if (u2 && u2 !== u && /^https?:\/\//.test(u2)) lateC.push({ kind: 'flv', url: fix(u2), retry: true });
    if (ru2 && ru2 !== ru && /^https?:\/\//.test(ru2)) lateC.push({ kind: 'flv', url: fix(ru2), retry: true });
    if (lateC.length) {
      const late = await camProbe(lateC);
      if (late.ok.length) return late.ok;
    }
    const vi = (S.video_at || 0) >= t0 - 500 ? `${S.video_action || '?'}{${Object.keys(V).slice(0, 8).join(',')}}${u || u2 ? ' ' + camShort(fix(u || u2)) : ''}` : 'no_report';
    diag({ a: 'cam', p: 'acl', m: p.model || '', err: 'none', d: 'video:' + vi + ' ' + res.join(' ') });
    // Zweiter Eintrag (09.11.2026, Kobra X: startCapture{} ohne Adresse, :18088/flv mal 429, mal 404, mal keine Verbindung):
    // welche Berichte seit startCapture kamen (Art + Feldnamen) und wo im Stand Adressen stehen — nur Namen, keine Werte/Tokens
    const after = Object.keys(S).filter(k => k.endsWith('_at') && +S[k] >= t0 - 500).map(k => k.slice(0, -3))
      .map(k => k + (S[k] && typeof S[k] === 'object' ? '{' + Object.keys(S[k]).slice(0, 5).join(',') + '}' : ''));
    const urlKeys = [];
    const walk = (o, path, d) => {
      if (!o || typeof o !== 'object' || d > 3 || urlKeys.length >= 8) return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /^(https?|rtsps?|rtmp|wss?|webrtc):\/\/|\.(flv|m3u8)\b|\/live\//i.test(v)) urlKeys.push(path + k);
        else walk(v, path + k + '.', d + 1);
      }
    };
    walk(S, '', 0);
    // Adress-Felder zuerst: diag kürzt auf 160 Zeichen (10.11.2026 fiel genau das dritte Feld, info.urls.rtspUrl, hinten weg)
    diag({ a: 'cam_acl', p: 'acl', m: p.model || '', err: 'none', d: 'urls:' + (urlKeys.join(',') || '-') + ' after:' + (after.join(' ') || '-') });
    // wie bisher trotzdem versuchen — die Oberfläche verbindet neu, gkcam kann spät anlaufen; gemeldete Adresse zuerst
    const lastRu = /^https?:\/\//.test(ru2) ? fix(ru2) : rtsp.length ? rtsp[0].url : '';
    return [...(lastRu && lastRu !== flv.url ? [{ kind: 'flv', url: lastRu }] : []), { kind: 'flv', url: flv.url }];
  }
  // Creality: K1C/K1 Max ab 1.3.5.22, K2, Hi → WebRTC (Aushandeln über :8000/call/webrtc_local), ältere K1 → MJPEG :8080; K1 SE ohne Kamera
  if (kindOf(p) === 'creality') {
    const S = ((await native('live_state', { key: crKey(p) }).catch(() => ({}))).state) || {};
    const rtc = { kind: 'webrtc', url: `http://${p.host}:${crPort(p, 'video', 8000)}/call/webrtc_local` }, mj = { kind: 'mjpeg', url: `http://${p.host}:${crPort(p, 'cam', 8080)}/?action=stream` };
    if (+S.video === 0 && !+S.webrtcSupport) return [];
    return +S.webrtcSupport === 1 ? [rtc, mj] : [mj, rtc];
  }
  // Flashforge: MJPEG :8080 (5M Pro eingebaut, 5M mit Zubehörkamera), URL meldet der Drucker in cameraStreamUrl
  if (kindOf(p) === 'flashforge') { const u = (live[p.id] || {}).ffCam; return [{ kind: 'mjpeg', url: u && /^http:\/\//.test(u) && !(p.ports && p.ports.cam) ? u : `http://${p.host}:${(p.ports && p.ports.cam) || 8080}/?action=stream` }]; }
  // CC2: MJPEG auf Port 8080 (jeder Pfad), ohne Anmeldung; meist nur 1 Zuschauer gleichzeitig
  if (kindOf(p) === 'cc2') return [{ kind: 'mjpeg', url: `http://${p.host}:${ccPort(p, 'cam', 8080)}/?action=stream` }];
  if (L.cams && !force && Date.now() - L.camsAt < 300000) { if (L.cams.some(c => c.wake)) await u1CamWake(p, true); return L.cams; }   // U1: auch beim Wiederöffnen wecken
  const base = `http://${p.host}`;
  const fix = v => {
    v = String(v || '').trim(); if (!v) return null;
    if (v.startsWith('/')) return base + v;
    if (!/^https?:\/\//i.test(v)) return null;
    try { const u = new URL(v); if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) u.hostname = p.host; return u.toString(); } catch (e) { return null; }
  };
  if (kindOf(p) === 'prusalink') { L.cams = []; L.camsAt = Date.now(); return []; }
  if (kindOf(p) === 'bambu') {
    // P1/A1: eigener JPEG-Strom (Port 6000, Access Code) über Cam.kt. X1/H2/P2S: RTSPS auf 322 (H.264, am Drucker „LAN Only Liveview“),
    // Rtsp.kt packt es in FLV um. Modell unbekannt: erst RTSPS, dann Port 6000.
    const j6000 = { kind: 'mjpeg', url: `bambu6000://${p.host}:${bbPort(p, 'cam', 6000)}/?code=${encodeURIComponent(p.code || '')}` };
    const rtsp = { kind: 'flv', url: `rtsps://bblp:${encodeURIComponent(p.code || '')}@${p.host}:${bbPort(p, 'rtsp', 322)}/streaming/live/1` };
    L.cams = BBL_CAM6000.test(p.model || '') || (p.ports && p.ports.cam) ? [j6000] : p.model || (p.ports && p.ports.rtsp) ? [rtsp] : [rtsp, j6000];
    L.camsAt = Date.now(); return L.cams;
  }
  // Anycubic gkcam (:18088) nicht beim Snapmaker U1 fragen (gibt es dort nicht; im Test antwortete dort der Anycubic-Nachbau, 25.11.2026)
  const cand = kindOf(p) === 'octoprint' || isU1(p) ? [] : [{ kind: 'flv', url: `${base}:18088/flv` }];
  if (kindOf(p) === 'octoprint') {
    try {
      const w = (await dj(p, 'GET', '/api/settings')).webcam || {};
      const abs = v => !v ? null : /^https?:\/\//i.test(v) ? fix(v) : v.startsWith('/') ? baseUrl(p, v) : null;
      if (w.webcamEnabled !== false) { const st = abs(w.streamUrl), sn = abs(w.snapshotUrl); if (st) cand.push({ kind: 'mjpeg', url: st }); if (sn) cand.push({ kind: 'snap', url: sn }); }
    } catch (e) {}
  } else cand.push(...await mrCamCands(p, p.port || 7125));
  for (const f of kindOf(p) === 'octoprint' ? [base + '/webcam/?action=stream', base + ':8080/?action=stream'] : []) cand.push({ kind: 'mjpeg', url: f });
  for (const f of kindOf(p) === 'octoprint' ? [base + '/webcam/?action=snapshot', base + ':8080/?action=snapshot'] : []) cand.push({ kind: 'snap', url: f });
  let { ok, res } = await camProbe(cand);
  // Snapmaker U1 mit Originalfirmware: Moonraker meldet keine Kamera → aufwecken und Einzelbild nehmen (Extended-Firmware meldet ihre Kamera,
  // dann bleibt es beim normalen Weg oben)
  if (!ok.length && isU1(p)) {
    await u1CamWake(p, true);
    const r2 = await camProbe([{ kind: 'snap', url: `http://${p.host}:${p.port || 7125}/server/files/camera/monitor.jpg`, wake: true, retry: true }]);
    ok = r2.ok; res = res.concat(r2.res);
  }
  if (!ok.length) diag({ a: 'cam', p: kindOf(p), m: p.model || '', err: 'none', d: res.join(' ') });
  L.cams = ok; L.camsAt = Date.now();
  return L.cams;
}

// ── Snapmaker U1 mit Originalfirmware: Kamera aufwecken (25.11.2026, Chris' U1) ──────────────────────────────────────────────────
// Moonraker kennt dort keine Kamera (Fluidd zeigt auch keine), die Snapmaker-App weckt sie mit camera.start_monitor {domain: lan}. Danach legt
// der U1 etwa 1 Bild/s unter /server/files/camera/monitor.jpg ab — im Heimnetz abrufbar (an Chris' U1 geprüft). Den Befehl nimmt Moonraker
// NUR über den Websocket an (HTTP /server/jsonrpc → „Method not found for transport HTTP“, ebenfalls geprüft).
// Ohne Wiederholung schläft die Kamera ein → die Ansicht ruft amp_cam_wake alle 10 s, solange sie das Bild zeigt (wie SimplyPrint).
// Kein camera.stop_monitor beim Schließen: könnte das Bild in der Snapmaker-App abbrechen; die Kamera schläft von selbst wieder ein.
// Websocket über die Live-Art 'sdcp' (ws://IP:Port/websocket, gibt es auf Android, iPhone und im Agenten) und gleich wieder zu — offen
// bliebe der SDCP-Text „ping“ alle 10 s, den Moonraker als Parse-Fehler protokollieren würde.
const isU1 = p => kindOf(p) === 'moonraker' && p.model === 'Snapmaker U1';
/**
 * Snapmaker U1: Druckoptionen vor dem Start (25.11.2026, User: „Druckbett nivellieren usw. fehlt mir“). Die Firmware nimmt sie nur per
 * SET_PRINT_PREFERENCES und nur VOR dem Start (Snapmaker u1-klipper print_task_config.py, sonst Fehler 16), Vorgabe ab Werk überall aus;
 * die Zeilen SET_PRINT_AUTO_BED_LEVELING/SET_TIME_LAPSE_CAMERA im Orca-Profil kennt sie nicht (Prüfung 09.10.2026, memory
 * bett-nivellieren-druckstart). Immer alle vier Werte, damit nichts von einem früheren Druck (Snapmaker-App) stehen bleibt.
 * Scheitert der Befehl (andere Firmware), startet der Druck trotzdem — Eintrag im Protokoll.
 */
async function u1Prefs(p, o) {
  const script = 'SET_PRINT_PREFERENCES BED_LEVEL=' + (o.level === false ? 0 : 1) + ' FLOW_CALIBRATE=' + (o.flow ? 1 : 0)
    + ' SHAPER_CALIBRATE=' + (o.vib ? 1 : 0) + ' TIME_LAPSE_CAMERA=' + (o.tl ? 1 : 0);
  try { await mrPost(p, '/printer/gcode/script', { script }, 10000); }
  catch (e) { diag({ a: 'u1_prefs', p: 'moonraker', m: p.model || '', err: String(e.message || 'err').slice(0, 30), d: String(e.msg || '').slice(0, 120) }); }
}
async function u1CamWake(p, first) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  if (!first && Date.now() - (L.u1WakeAt || 0) < 5000) return true;   // mehrere Ansichten gleichzeitig (Agent: Handy + PC)
  L.u1WakeAt = Date.now();
  const key = 'mrc_' + p.id;
  try {
    await native('live_open', { kind: 'sdcp', key, host: p.host, port: +(p.port || 7125) });
    for (let i = 0; i < 15; i++) { const st = await native('live_state', { key }).catch(() => ({})); if (st.connected) break; await new Promise(z => setTimeout(z, 200)); }
    await native('live_send', { key, payload: JSON.stringify({ jsonrpc: '2.0', id: 30003, method: 'camera.start_monitor', params: { domain: 'lan', interval: 0 } }) });
    await new Promise(z => setTimeout(z, first ? 1500 : 300));   // erstes Mal: dem U1 Zeit fürs erste Bild geben
    return true;
  } catch (e) { diag({ a: 'cam_wake', p: 'moonraker', m: p.model || '', err: String(e.message || 'err').slice(0, 40) }); return false; }
  finally { native('live_close', { key }).catch(() => {}); }
}

// ── OctoPrint und PrusaLink (wie die Treiber des 3DSEARCH-Agenten) ──────────
const kindOf = p => p.kind || 'moonraker';
const baseUrl = (p, path) => `http://${p.host}:${p.port || (kindOf(p) === 'moonraker' ? 7125 : 80)}${path}`;
/** JSON-Anfrage an OctoPrint (X-Api-Key) bzw. PrusaLink (Digest „maker“). */
async function dj(p, method, path, body, timeout = 6000) {
  const k = kindOf(p), a = { url: baseUrl(p, path), method, timeout, headers: {} };
  if (k === 'octoprint' && p.key) a.headers['X-Api-Key'] = p.key;
  if (k === 'prusalink') a.digest = { user: p.user || 'maker', pass: p.pass || '' };
  if (body !== undefined && body !== null) { a.body = JSON.stringify(body); a.headers['Content-Type'] = 'application/json'; }
  const r = await native('http', a);
  if (r.status === 401 || r.status === 403) fail('unauthorized');
  // 409: bei OctoPrint /api/printer = Drucker nicht verbunden; bei Auftragsbefehlen (OctoPrint /api/job, PrusaLink /api/v1/job) = Zustand
  // passt nicht, z. B. PrusaLink ATTENTION wartet auf Bestätigung am Display (docs api/job.rst, Buddy prusa_link_api_v1.cpp; zweite Prüfung 11.11.2026)
  if (r.status === 409) fail(/^\/api\/printer\b/.test(path) ? 'not_connected' : 'conflict');
  if (r.status >= 400) { const e = new Error('http_' + r.status); e.msg = String(r.text || '').slice(0, 160); throw e; }
  if (r.status === 204 || !String(r.text || '').trim()) return {};
  try { return JSON.parse(r.text); } catch (e) { return {}; }
}
// Kalibrieren vor dem Druck (21.11.2026, User: „Vibrationstest vor dem Druck … mit Flusskalibrierung“): nur, was der Startbefehl belegt kann —
// Anycubic LAN task_settings.vibration_compensation/flow_calibration (kobra-connect mqtt-commands.md), Bambu project_file vibration_cali/
// flow_cali (+ extrude_cali_flag), Flashforge AD5X/Creator 5 flowCalibration (ff-5mp-api AD5X-/Creator5-Parameter; 5M/5M Pro nicht belegt).
// Snapmaker U1 (25.11.2026): SET_PRINT_PREFERENCES vor dem Start (u1Prefs) — Vibrationsausgleich, Flusskalibrierung, dazu Zeitraffer (tl)
const calOf = p => { const k = kindOf(p); return k === 'acl' || k === 'bambu' ? { vib: true, flow: true } : k === 'flashforge' && /AD5X|Creator 5/i.test(p.model || '') ? { vib: false, flow: true } : isU1(p) ? { vib: true, flow: true, tl: true } : null; };
// Häkchen „Bett vor dem Druck nivellieren“ (Startbefehl trägt die Wahl): Anycubic LAN auto_leveling (17.11.2026), Elegoo CC2 printer_check (21.11.2026)
// Hinweis „Flashforge noch in der Testphase“ (22.11.2026, User). Creator 5 / 5 Pro seit 0.19.5 ohne: am echten C5 Pro bestätigt
// (#30/#31, 22.11.2026: Kopf 1, anderer Kopf, zweifarbig, ohne Nivellieren). AD5X, 5M und die übrigen behalten ihn (kein bestätigter Druck).
const ffBeta = p => kindOf(p) === 'flashforge' && !/creator\s*5/i.test(p.model || '');
const lvlOf = p => ['acl', 'cc2', 'flashforge'].includes(kindOf(p)) || isU1(p);   // U1 seit 25.11.2026 (BED_LEVEL in u1Prefs)   // Flashforge seit 0.19.4 (22.11.2026): levelingBeforePrint stand fest auf an, der Creator 5 Pro nivellierte vor jedem Druck
function baseEntry(p, backend) {
  return { id: p.id, name: p.name, model: p.model || null, online: false, busy: false, locked: false, img: p.img || null, img_own: !!p.img, cal: calOf(p), lvl: lvlOf(p),
           temps: null, stats: null, slots: [], boxes: [], orphans: [], job: null, last: null, cam: true, cam_ok: true,
           agent: { backend, klippy: null, klippy_msg: '', silent: false }, host: p.host + (p.port ? ':' + p.port : '') };
}
function singleSlot(p, entry) {
  const sl = slotRow(p.id, 0);
  entry.slots.push({ slot_id: sl.id, index: 0, label: '1', single: true, material: null, color: null, sku: null, remain_pct: null,
                     spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: entry.busy });
  entry.ttg_map = [0];
}
/** Kopf + Ende einer Datei holen und die Slicer-Zusammenfassung lesen (Gramm je Werkzeug, mm) — einmal je Datei. */
async function fileSummary(p, L, url) {
  L.fsum = L.fsum || {};
  if (L.fsum[url]) return L.fsum[url];
  const hd = Object.assign({}, kindOf(p) === 'octoprint' && p.key ? { 'X-Api-Key': p.key } : {});
  const get = range => native('http', { url, headers: { ...hd, Range: range }, timeout: 8000, max: 300000, digest: kindOf(p) === 'prusalink' ? { user: p.user || 'maker', pass: p.pass || '' } : undefined }).catch(() => null);
  const [h, t] = await Promise.all([get('bytes=0-65535'), get('bytes=-196608')]);
  const md = gcodeMeta(h && h.status < 300 ? h.text : '', t && t.status === 206 ? t.text : '');
  return (L.fsum[url] = { weights: md.weights, mm: md.mm ? md.mm.reduce((a, b) => a + b, 0) : null, time_s: md.time_s, model: null });
}
/**
 * Eigene Beobachtung als Verlauf (OctoPrint/PrusaLink merken sich keine Drucke wie Moonraker): Start, Fortschritt, Ende.
 * c = {state: 'printing'|'paused'|'', file, jid, prog 0..1, print_s, finished, error, weights, mm}. Danach wie Moonraker buchen.
 */
function obsHistory(p, L, c) {
  p.hist = p.hist || [];
  const cur = p.hist[0] && p.hist[0].status === 'in_progress' ? p.hist[0] : null;
  const md = { filament_total: c.mm || 0, filament_weights: c.weights || [], filament_weight_total: (c.weights || []).reduce((a, b) => a + b, 0) };
  const close = (h, status) => { h.status = status; h.end_time = Date.now() / 1000; h.filament_used = (h.metadata.filament_total || 0) * (status === 'completed' ? 1 : h.prog || 0); };
  // gemessener Verbrauch je Fach (Anycubic LAN: supplies_usage, acUsage) → applyHistory bucht ihn wie gemessen, auch bei Abbruch
  const useOn = h => { if (h && c.use && c.use.parts && c.use.parts.length && c.use.file === String(h.filename || '').split('/').pop()) { h.parts = c.use.parts; h.actual = true; } };
  if (c.state) {
    if (!cur || cur.filename !== c.file || (c.jid != null && cur.jid !== c.jid)) {
      if (cur) close(cur, 'cancelled');
      p.hist.unshift({ job_id: 'o' + Date.now(), jid: c.jid ?? null, filename: c.file, status: 'in_progress', start_time: Date.now() / 1000 - (c.print_s || 0),
                       end_time: null, print_duration: c.print_s || 0, filament_used: 0, metadata: md, prog: c.prog || 0 });
      p.hist = p.hist.slice(0, 60);
    } else { cur.print_duration = c.print_s || cur.print_duration; cur.prog = Math.max(cur.prog || 0, c.prog || 0); if (md.filament_total || md.filament_weight_total) cur.metadata = md; }
    useOn(p.hist[0]);
    persist();
  } else if (cur) {
    if (c.prog) cur.prog = Math.max(cur.prog || 0, c.prog);
    useOn(cur);
    close(cur, c.error ? 'error' : c.finished || (cur.prog || 0) >= 0.995 ? 'completed' : 'cancelled');
    persist();
  }
  applyHistory(p, L, p.hist);
}
function jobEntry(L, c, remainS, layer) {
  return { name: String(c.file || '').split('/').pop(), title: jobTitle(c.file), progress: Math.floor((c.prog || 0) * 100), remain_min: Math.round((remainS || 0) / 60),
           layer: layer ? layer[0] : null, layers: layer ? layer[1] : null, img: null, speed: null, paused: c.state === 'paused' };
}

// ── Modellbild zum laufenden Druck (14.11.2026, User: „beim Drucken sehe ich nicht, was gedruckt wird“) ──────────────────────
// Beim Senden gemerkt: vom Slicer (thumb, ab Slicer 1.0.5) oder das größte PNG/JPG aus dem Kopf des G-Codes. Eigene Datei
// 'jobthumbs' (nicht in den Daten und Sicherungen), höchstens 30 Bilder. Schlüssel: Drucker + Dateiname ohne Endung und Sonderzeichen —
// Drucker melden den Namen mal mit, mal ohne Endung, Bambu/Elegoo mit _ statt Leerzeichen, manche gekürzt.
let JT = null;
const jtName = n => String(n || '').split('/').pop().replace(/\.(gcode\.3mf|gcode|bgcode|3mf|gco|g)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
async function jtLoad() {
  if (JT) return JT;
  try { JT = JSON.parse((await native('load', { key: 'jobthumbs' })).text || '{}') || {}; } catch (e) { JT = {}; }
  return JT;
}
async function jtPut(pid, name, img) {
  const k = jtName(name);
  if (!k || !/^data:image\/(png|jpeg|webp);base64,/.test(String(img || '')) || img.length > 400000) return;
  const t = await jtLoad();
  t[pid + '|' + k] = { img, at: Date.now() };
  Object.keys(t).sort((a, b) => t[b].at - t[a].at).slice(30).forEach(x => delete t[x]);
  await native('save', { key: 'jobthumbs', text: JSON.stringify(t) }).catch(() => {});
}
function jtGet(pid, name) {
  const k = jtName(name);
  if (!JT || !k) return null;
  if (JT[pid + '|' + k]) return JT[pid + '|' + k].img;
  // gekürzt gemeldet (Bambu: 60 Zeichen) oder gekürzt gesendet: einer ist Anfang des anderen, mindestens 12 Zeichen
  if (k.length < 12) return null;
  const hit = Object.keys(JT).filter(x => x.startsWith(pid + '|')).map(x => [x, x.slice(String(pid).length + 1)])
    .filter(([, n]) => n.length >= 12 && (n.startsWith(k) || k.startsWith(n))).sort((a, b) => JT[b[0]].at - JT[a[0]].at)[0];
  return hit ? JT[hit[0]].img : null;
}

async function opSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'octoprint');
  let conn;
  try { conn = await dj(p, 'GET', '/api/connection', null, 3500); }
  catch (e) { entry.amp_err = e.message === 'unauthorized' ? 'key' : 'unreach'; finish(p, entry, L); return entry; }
  entry.online = true;
  const pr = await dj(p, 'GET', '/api/printer?exclude=sd').catch(() => null);   // 409: OctoPrint nicht mit dem Drucker verbunden
  const jb = await dj(p, 'GET', '/api/job').catch(() => ({}));
  const fl = ((pr || {}).state || {}).flags || {};
  const jf = (jb.job || {}).file || {}, pg = jb.progress || {};
  const c = { state: fl.paused || fl.pausing ? 'paused' : fl.printing || fl.cancelling || fl.finishing ? 'printing' : '', file: String(jf.path || jf.name || ''),
              prog: (+pg.completion || 0) / 100, print_s: +pg.printTime || 0, error: !!(fl.error || fl.closedOrError) };
  if (!pr) { entry.online = false; entry.agent.klippy = 'disconnected'; entry.agent.klippy_msg = 'OctoPrint: ' + ((conn.current || {}).state || '?'); }
  else {
    entry.agent.klippy = 'ready';
    const tp = pr.temperature || {};
    entry.temps = { nozzle: Math.round((tp.tool0 || {}).actual || 0), bed: Math.round((tp.bed || {}).actual || 0) };
  }
  if (!L.version) { try { const v = await dj(p, 'GET', '/api/version'); L.version = v.server || v.text || ''; } catch (e) { L.version = ''; } }
  entry.stats = { prints: null, hours: null, fw: L.version ? 'OctoPrint ' + L.version : null };
  entry.busy = !!c.state;
  singleSlot(p, entry);
  if (c.file) Object.assign(c, await fileSummary(p, L, baseUrl(p, '/downloads/files/local/' + c.file.split('/').map(encodeURIComponent).join('/'))));
  if (entry.busy) entry.job = jobEntry(L, c, +pg.printTimeLeft || 0);
  if (pr) obsHistory(p, L, c);
  finish(p, entry, L);
  return entry;
}
const PL_BUSY = ['PRINTING', 'PAUSED', 'BUSY', 'ATTENTION'];
async function plSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'prusalink');
  let st;
  try { st = await dj(p, 'GET', '/api/v1/status', null, 3500); }
  catch (e) { entry.amp_err = e.message === 'unauthorized' ? 'key' : 'unreach'; finish(p, entry, L); return entry; }
  entry.online = true; entry.agent.klippy = 'ready';
  const pr = st.printer || {}, sj = st.job || {}, ps = String(pr.state || '').toUpperCase();
  entry.temps = { nozzle: Math.round(+pr.temp_nozzle || 0), bed: Math.round(+pr.temp_bed || 0) };
  if (!L.info) { L.info = await dj(p, 'GET', '/api/v1/info').catch(() => ({})); const v = await dj(p, 'GET', '/api/version').catch(() => ({})); L.version = v.server || v.firmware || ''; }
  entry.stats = { prints: null, hours: null, fw: L.version ? 'PrusaLink ' + L.version : null };
  const job = sj.id != null ? await dj(p, 'GET', '/api/v1/job').catch(() => ({})) : {};
  const jf = job.file || {}, m = jf.meta || {};
  const n = v => { const x = parseFloat(String(v ?? '').trim()); return Number.isFinite(x) ? x : null; };
  const per = typeof m['filament used [g] per tool'] === 'string' ? m['filament used [g] per tool'].split(',') : m['filament used [g] per tool'];
  const c = { state: sj.id != null && ['PRINTING', 'BUSY'].includes(ps) ? 'printing' : sj.id != null && ['PAUSED', 'ATTENTION'].includes(ps) ? 'paused' : '',
              file: String(jf.display_name || jf.name || ''), jid: sj.id ?? null, prog: (n(sj.progress ?? job.progress) || 0) / 100,
              print_s: n(sj.time_printing ?? job.time_printing) || 0, finished: ps === 'FINISHED', error: ps === 'ERROR',
              weights: Array.isArray(per) ? per.map(x => n(x) || 0) : n(m['filament used [g]']) ? [n(m['filament used [g]'])] : [], mm: n(m['filament used [mm]']) };
  entry.busy = !!c.state;
  singleSlot(p, entry);
  if (entry.busy) entry.job = jobEntry(L, c, n(sj.time_remaining ?? job.time_remaining) || 0);
  obsHistory(p, L, c);
  finish(p, entry, L);
  return entry;
}
/** Prusa-Modell aus dem Hostnamen („prusa-core-one“, „mk4s“ …), wie prusa_model im Agenten. */
function prusaModel(...names) {
  for (const h of names) {
    const m = /(core[\s_-]?one|mk\d(?:\.\d)?s?|mini\+?|xl)/i.exec(String(h || ''));
    if (m) { const t = m[1].replace(/[\s_-]+/g, '').toUpperCase(); return 'Prusa ' + (t === 'COREONE' ? 'CORE One' : t === 'MINI+' ? 'MINI' : t); }
  }
  return null;
}
// ── Bambu Lab im LAN (Entwicklermodus): MQTT-Stand über den Android-Teil (Live.kt), Upload per FTPS, Start per project_file ──
// Modellkennung aus der SSDP-Meldung (DevModel.bambu.com) → Orca-Maschinenname (Vendor-Ordner „BBL“)
const BBL_MODELS = { 'C11': 'Bambu Lab P1P', 'C12': 'Bambu Lab P1S', 'N1': 'Bambu Lab A1 mini', 'N2S': 'Bambu Lab A1', 'BL-P001': 'Bambu Lab X1 Carbon', '3DPrinter-X1-Carbon': 'Bambu Lab X1 Carbon',
                     'BL-P002': 'Bambu Lab X1', '3DPrinter-X1': 'Bambu Lab X1', 'C13': 'Bambu Lab X1E', 'O1D': 'Bambu Lab H2D', 'O1S': 'Bambu Lab H2S', 'N7': 'Bambu Lab P2S',
                     // Prüfung 11.11.2026 (Bambuddy printer_models.py): fehlten → Rückfall auf P1S/C12 im 3MF
                     'O1E': 'Bambu Lab H2D Pro', 'O2D': 'Bambu Lab H2D Pro', 'O1C': 'Bambu Lab H2C', 'O1C2': 'Bambu Lab H2C', 'N6': 'Bambu Lab X2D', 'N9': 'Bambu Lab A2L', 'N10': 'Bambu Lab H3C' };
const BBL_CAM6000 = /\b(P1P|P1S|A1|A2L)\b/;   // P1/A1/A2L: JPEG-Strom auf Port 6000 (A2L: ha-bambulab); X1/H2/P2S: RTSPS auf 322 (Rtsp.kt)
const bbPort = (p, k, d) => (p.ports && p.ports[k]) || d;
/**
 * AMS-Fach → unser Fachindex: AMS 0–3 je vier (A1…D4), AMS HT (ams_id 128 ff.) ab 16, externe Spule 100 (Hauptdüse/rechts, 255)
 * und 101 (zweite Düse/links, 254). A2L meldet sein AMS Lite als id 16 und erwartet flach 0–3 (Bambuddy) → Fachindex 0–3.
 * Prüfung 11.11.2026: belegt nach tray_exist_bits (Bit ams*4+fach, HT 16+(id−128), A2L 24+fach; Bambuddy/OrcaSlicer) — Teilberichte
 * mit nur {id} für ein geleertes Fach ließen sonst Material und Farbe der alten Spule stehen.
 */
function bbSlots(pr) {
  const out = [], boxes = [], A = pr.ams || {};
  const hex = v => { if (v === undefined || v === null || v === '') return null; const n = parseInt(String(v), 16); return Number.isFinite(n) ? n : null; };
  const bits = hex(A.tray_exist_bits), useBits = bits !== null && !(bits === 0 && A.power_on_flag === false);
  for (const a of (A.ams || [])) {
    const id = +a.id, ht = id >= 128, a2l = id === 16;
    const trays = a.tray || [];
    trays.forEach((t, k) => {
      const tid = +(t.id ?? k), idx = ht ? 16 + (id - 128) : a2l ? tid : id * 4 + tid;
      const bit = ht ? 16 + (id - 128) : a2l ? 24 + tid : id <= 3 ? id * 4 + tid : -1;
      const there = useBits && bit >= 0 && bit < 32 ? !!((bits >>> bit) & 1) : true;
      const col = /^[0-9a-f]{6}/i.test(t.tray_color || '') ? '#' + t.tray_color.slice(0, 6).toLowerCase() : null;
      const mat = there ? String(t.tray_type || '').trim() || null : null;
      out.push({ index: idx, tray: ht ? id : a2l ? tid : id * 4 + tid, ams: id, label: ht ? 'HT' + (id - 127) : a2l ? 'A' + (tid + 1) : 'ABCD'[id] + (tid + 1), material: mat, color: mat ? col : null,
                 sku: mat ? t.tray_info_idx || null : null, remain_pct: mat && +t.remain >= 0 && t.remain !== undefined ? Math.max(0, Math.min(100, +t.remain)) : null,
                 // Bambu-Spule mit RFID-Chip (tray_uuid ≠ 0): der Drucker kennt das Filament selbst — nie per ams_filament_setting überschreiben
                 rfid: !!(mat && /[1-9a-f]/i.test(String(t.tray_uuid || ''))) });
    });
    const hum = a.humidity_raw !== undefined ? +a.humidity_raw : null, tc = a.temp !== undefined ? Math.round(+a.temp) : null;
    boxes.push({ id: boxes.length, label: ht ? 'AMS HT' + (id - 127) : a2l ? 'AMS Lite' : 'AMS ' + (id + 1), dry: null, control: false, temp: tc && tc > 0 ? tc : null, humidity: hum >= 0 && hum <= 100 ? hum : null });
  }
  // Externe Spule: zwei Düsen (H2D, H2D Pro, H2C, X2D) melden vir_slot [254 links, 255 rechts]; ein Kopf nur vt_tray bzw. vir_slot[0].
  // Senden: ein Kopf immer ams_id 255, zwei Düsen die echte id (BambuStudio DevDefs.h: 255 MAIN, 254 DEPUTY; Bambuddy) — Prüfung 11.11.2026
  const vs = Array.isArray(pr.vir_slot) ? pr.vir_slot.filter(x => x && typeof x === 'object') : [];
  const dual = vs.length >= 2;
  const exts = dual ? vs.map(x => ({ e: x, vid: +x.id === 254 ? 254 : 255 })) : (pr.vt_tray || vs[0]) ? [{ e: pr.vt_tray || vs[0], vid: 255 }] : [];
  for (const { e, vid } of exts) {
    const mat = String(e.tray_type || '').trim() || null;
    out.push({ index: vid === 255 ? 100 : 101, tray: 1000 + vid, ext: true, vid, ams: vid, label: dual ? (vid === 255 ? 'Ext R' : 'Ext L') : 'Ext', material: mat,
               color: mat && /^[0-9a-f]{6}/i.test(e.tray_color || '') ? '#' + e.tray_color.slice(0, 6).toLowerCase() : null, sku: null, remain_pct: null });
  }
  return { slots: out, boxes, dual };
}
/**
 * Beigaben für ein selbst gepacktes .gcode.3mf: slice_info.config (Modellkennung, Filamente, Zeit, Gewicht), Projektdaten und ein
 * Vorschaubild — laut bambox prüft die Firmware diese Dateien. Ungetestet am echten Gerät (Recherche 08.11.2026).
 */
// X1/X1 Carbon heißen in slice_info BL-P002/BL-P001 (Bambuddy; Prüfung 11.11.2026) — vorher bekamen sie eine leere Kennung
const BBL_IDS = Object.fromEntries(Object.entries(BBL_MODELS).filter(([k]) => !/^3DPrinter/.test(k)).map(([k, v]) => [v, k]));
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
function bbExtra(p, used, slots, timeS, png) {
  const esc_ = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const model = p.model || 'Bambu Lab P1S', mid = BBL_IDS[model] || '';
  const fils = used.map((u, i) => { const s_ = slots.find(z => z.index === u.slot) || {}; return { id: (u.tool ?? i) + 1, type: s_.material || u.material || 'PLA', color: (s_.color || u.color || '#ffffff').toUpperCase(), g: +u.g || 0, idx: s_.sku || '' }; });
  const g = fils.reduce((a, f) => a + f.g, 0);
  const info = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="01.10.00.00"/>\n  </header>\n  <plate>\n`
    + `    <metadata key="index" value="1"/>\n    <metadata key="printer_model_id" value="${esc_(mid)}"/>\n    <metadata key="nozzle_diameters" value="0.4"/>\n    <metadata key="timelapse_type" value="0"/>\n`
    + `    <metadata key="prediction" value="${Math.round(timeS || 0)}"/>\n    <metadata key="weight" value="${g.toFixed(2)}"/>\n    <metadata key="outside" value="false"/>\n    <metadata key="support_used" value="false"/>\n    <metadata key="label_object_enabled" value="false"/>\n`
    + fils.map(f => `    <filament id="${f.id}" tray_info_idx="${esc_(f.idx)}" type="${esc_(f.type)}" color="${esc_(f.color)}" used_m="0" used_g="${f.g.toFixed(2)}"/>\n`).join('') + `  </plate>\n</config>\n`;
  // Listen nach Filament-ID (T+1): Lücken (Filament 2 unbenutzt) bekommen Platzhalter, sonst rutschten Typ/Farbe auf die falsche Stelle
  const nF = Math.max(0, ...fils.map(f => f.id)), at = id => fils.find(f => f.id === id);
  const proj = JSON.stringify({ printer_model: model, printer_settings_id: model + ' 0.4 nozzle', printer_model_id: mid, nozzle_diameter: ['0.4'],
                                filament_type: Array.from({ length: nF }, (_, i) => (at(i + 1) || {}).type || 'PLA'),
                                filament_colour: Array.from({ length: nF }, (_, i) => (at(i + 1) || {}).color || '#FFFFFF'), version: '01.10.00.00' }, null, 2);
  return { 'Metadata/slice_info.config': info, 'Metadata/project_settings.config': proj, 'Metadata/plate_1.png': 'b64:' + (png || PNG1) };
}

/**
 * Begleitdateien für eine Orca-.gcode.3mf an Nicht-Bambu-Drucker (Flashforge AD5X/Creator 5, 16.11.2026): slice_info.config mit der
 * Filamentliste nach Filament-ID (T + 1) und das Plattenbild. Der SimplyPrint Client schickt einen vollständigen Orca-Export; die Firmware
 * liest daraus Metadata/plate_1.gcode und die Filamente — Bambu-Kennungen (printer_model_id, tray_info_idx) gehören hier nicht hinein.
 */
function orcaExtra(used, slots, timeS, png) {
  const esc_ = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fils = used.map((u, i) => { const s_ = slots.find(z => z.index === u.slot) || {};
    return { id: (u.tool ?? i) + 1, type: s_.material || u.material || 'PLA', color: (s_.color || u.color || '#ffffff').toUpperCase(), g: +u.g || 0 }; });
  const g = fils.reduce((a, f) => a + f.g, 0);
  const info = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="01.10.00.00"/>\n  </header>\n  <plate>\n`
    + `    <metadata key="index" value="1"/>\n`
    + `    <metadata key="nozzle_diameters" value="0.4"/>\n    <metadata key="prediction" value="${Math.round(timeS || 0)}"/>\n    <metadata key="weight" value="${g.toFixed(2)}"/>\n`
    + fils.map(f => `    <filament id="${f.id}" type="${esc_(f.type)}" color="${esc_(f.color)}" used_m="0" used_g="${f.g.toFixed(2)}"/>\n`).join('') + `  </plate>\n</config>\n`;
  return { 'Metadata/slice_info.config': info, 'Metadata/plate_1.png': 'b64:' + (png || PNG1) };
}
/**
 * slice_info.config für Creator 5 / 5 Pro (22.11.2026) mit den Feldern, die Flash Studio 1.7.6 für den C5 Pro schreibt (ff-5mp-api-py
 * tests/fixtures/threemf/flashstudio-1.7.6_c5pro-2color.3mf; Orca 2.5 --export-3mf hat dieselben): Angaben je Kopf (4 Einträge), Filament →
 * Werkzeug, Objekt, Schichtliste, tray_info_idx, uuid. Vorher (orcaExtra) nur nozzle_diameters „0.4“ — der Drucker nahm /printGcode an und
 * war danach 1–3 Min. nicht erreichbar, über die App UND den Agenten (Meldung #26, Druckstarts 50–72). Die C5-Firmware prüft an anderer
 * Stelle hart auf genau 4 Einträge (ff-5mp-api CHANGELOG: temperatureCtl_cmd nozzles size() == 4).
 * gm = c5Meta(): Düsen und Filamentlängen aus dem G-Code, heads = Kopfzahl aus /detail, name = Objektname.
 */
function c5Extra(used, slots, timeS, png, modelId, gm) {
  const esc_ = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const heads = Math.max(1, Math.min(8, +gm.heads || 4));
  const noz = Array.from({ length: heads }, (_, i) => +gm.nozzles[i] || +gm.nozzles[0] || 0.4);
  const fils = used.map((u, i) => {
    const s_ = slots.find(z => z.index === u.slot) || {}, t = u.tool ?? i, g = +u.g || 0, mm = +(gm.mm || [])[t] || 0;
    const type = s_.material || u.material || 'PLA';
    return { t, id: t + 1, type, idx: (filStd({ material: type }) || {}).idx || 'GFL99', color: (s_.color || u.color || '#ffffff').toUpperCase(), g, m: mm ? mm / 1000 : g / 2.98 };
  }).sort((a, b) => a.t - b.t);
  const nF = Math.max(1, ...fils.map(f => f.id)), g = fils.reduce((a, f) => a + f.g, 0);
  const meta = [['index', 1], ['extruder_type', Array(heads).fill(0).join(' ')], ['nozzle_volume_type', Array(heads).fill(0).join(' ')], ['printer_model_id', modelId || ''],
    ['nozzle_diameters', noz.join(',')], ['timelapse_type', 0], ['prediction', Math.round(timeS || 0)], ['weight', g.toFixed(2)], ['first_layer_time', 0],
    ['outside', 'false'], ['support_used', 'false'], ['label_object_enabled', 'false'],
    ['filament_maps', Array.from({ length: nF }, (_, i) => i + 1).join(' ')], ['limit_filament_maps', Array(nF).fill(heads).join(' ')]];
  const info = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value=""/>\n    <uuid value="${uuid()}"/>\n  </header>\n  <plate>\n`
    + meta.map(([k, v]) => `    <metadata key="${k}" value="${esc_(v)}"/>\n`).join('')
    + `    <object identify_id="1" name="${esc_(gm.name || 'AllMyPrinters')}" skipped="false" />\n`
    + fils.map(f => `    <filament id="${f.id}" tray_info_idx="${f.idx}" type="${esc_(f.type)}" color="${esc_(f.color)}" used_m="${f.m.toFixed(2)}" used_g="${f.g.toFixed(2)}" />\n`).join('')
    + (gm.layers > 0 ? `    <layer_filament_lists>\n      <layer_filament_list filament_list="${fils.map(f => f.t).join(' ')}" layer_ranges="0 ${gm.layers - 1}" />\n    </layer_filament_lists>\n` : '')
    + `  </plate>\n</config>\n`;
  return { 'Metadata/slice_info.config': info, 'Metadata/plate_1.png': 'b64:' + (png || PNG1) };
}
/** Für c5Extra aus Kopf und Ende des G-Codes: Düsen je Kopf (Orca „; nozzle_diameter = 0.4,0.4,0.4,0.4“), Schichtzahl, Filament in mm je Werkzeug. */
async function c5Meta(file) {
  const rd = a => native('fileRead', a).then(r => (r && r.text) || '').catch(() => '');
  const txt = (await rd({ token: file.token, offset: 0, length: 16384 })) + '\n' + (await rd({ token: file.token, tail: true, length: 262144 }));
  const nums = s => (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  let m; const o = { nozzles: [], layers: 0, mm: [] };
  if ((m = /^;\s*nozzle_diameter\s*=\s*(.+)$/im.exec(txt))) o.nozzles = nums(m[1]);
  if ((m = /^;\s*total layer number:\s*(\d+)/im.exec(txt))) o.layers = +m[1];
  if ((m = /^;\s*filament used \[mm\]\s*[=:]\s*(.+)$/im.exec(txt))) o.mm = nums(m[1]);
  return o;
}

/** Entwicklermodus? print.fun Bit 29 gesetzt = Drucker verlangt signierte Befehle (kein Entwicklermodus). */
const bbDevMode = pr => { try { return pr.fun === undefined ? null : !(BigInt('0x' + String(pr.fun)) & 0x20000000n); } catch (e) { return null; } };
async function bbSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'bambu');
  const key = 'bb_' + p.id;
  let st;
  try {
    await native('live_open', { kind: 'bambu', key, host: p.host, serial: p.serial || '', code: p.code || '', port: bbPort(p, 'mqtt', 8883) });
    st = await native('live_state', { key });
  } catch (e) { st = { connected: false, err: e.message }; }
  if (st.serial && st.serial !== p.serial) { p.serial = st.serial; persist(); }
  const pr = ((st.state || {}).print) || null;
  if (!st.connected || !pr) {
    entry.amp_err = st.err === 'access_code' ? 'key' : 'unreach';
    if (L.lastSlots) finish(p, entry, L); else { finish(p, entry, L); }
    return entry;
  }
  entry.online = true; entry.agent.klippy = 'ready';
  const gs = String(pr.gcode_state || '').toUpperCase();
  entry.busy = ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(gs);
  entry.temps = { nozzle: Math.round(+pr.nozzle_temper || 0), bed: Math.round(+pr.bed_temper || 0) };
  entry.ctl = bbCtl(p, L, pr, entry.busy);
  const dev = bbDevMode(pr);
  // Hinweis „Entwicklermodus ist aus“: nach einer echten Ablehnung immer; nach dem Merkmal (fun-Bit) nur, solange ein Druck trotz „aus“
  // nicht schon geklappt hat (H2C 25.11.2026: 2× abgewiesen, ob das Bit dort stimmt, ist unbelegt — bb_bitbad lernt es)
  p.devmode = dev; entry.amp_devmode = dev === true ? true : p.bb_rej ? false : dev === false && p.bb_bitbad ? null : dev;
  const ver = ((st.state || {}).info || {}).module;
  if (Array.isArray(ver)) { const ota = ver.find(m => m.name === 'ota'); if (ota) L.fw = ota.sw_ver; }
  entry.stats = { prints: null, hours: null, fw: L.fw || null };
  const u = bbSlots(pr), now_ = +(pr.ams || {}).tray_now;
  for (const x of u.slots) {
    const sl = slotRow(p.id, x.index);
    entry.slots.push({ slot_id: sl.id, index: x.index, label: x.label, material: x.material, color: x.color, sku: x.sku, remain_pct: x.remain_pct,
                       spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: entry.busy && (x.ext ? (u.dual ? now_ === x.vid : now_ === 254 || now_ === 255) : x.tray === now_) });
  }
  if (!entry.slots.length) singleSlot(p, entry);
  entry.boxes = u.boxes; entry.ttg_map = entry.slots.map(x => x.index);
  L.bbSlots = u.slots;
  const c = { state: gs === 'PAUSE' ? 'paused' : entry.busy ? 'printing' : '', file: String(pr.subtask_name || pr.gcode_file || ''), prog: (+pr.mc_percent || 0) / 100,
              print_s: 0, finished: gs === 'FINISH', error: gs === 'FAILED' };
  if (entry.busy) entry.job = jobEntry(L, c, (+pr.mc_remaining_time || 0) * 60, pr.total_layer_num ? [+pr.layer_num || 0, +pr.total_layer_num] : null);
  obsHistory(p, L, c);
  finish(p, entry, L);
  return entry;
}

// ── Elegoo Centauri Carbon (SDCP V3): WebSocket ws://IP:3030/websocket über Live.kt, Upload /uploadFile/upload in 1-MiB-Stücken ──
const uuid = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };
const sdPort = (p, k, d) => (p.ports && p.ports[k]) || d;
function sdReq(p, cmd, data, rid) {
  const mb = p.mainboard || '';
  return JSON.stringify({ Id: uuid(), Data: { Cmd: cmd, Data: data || {}, RequestID: rid || uuid(), MainboardID: mb, TimeStamp: Math.floor(Date.now() / 1000), From: 0 }, Topic: 'sdcp/request/' + mb });
}
const sdSend = (p, cmd, data, rid) => native('live_send', { key: 'sd_' + p.id, payload: sdReq(p, cmd, data, rid) });
// PrintInfo.Status (FDM, Elegoo-SDK): 0 frei, 5/6 pausiert, 7/8 stoppt/gestoppt, 9 fertig, 13 druckt, 14 Fehler, sonst Vorbereitung
const SD_PAUSED = [5, 6], SD_DONE = [0, 8, 9, 14];
async function sdSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'elegoo');
  const key = 'sd_' + p.id;
  let st;
  try {
    await native('live_open', { kind: 'sdcp', key, host: p.host, port: sdPort(p, 'ws', 3030) });
    st = await native('live_state', { key });
    if (st.connected) {
      if (st.mainboard && st.mainboard !== p.mainboard) { p.mainboard = st.mainboard; persist(); }
      sdSend(p, 0).catch(() => {});
      // CANVAS (Cmd 324): ältere CC1-Firmware ohne CANVAS kennt den Befehl nicht und kann bei gehäuften Anfragen den Druckdienst
      // abstürzen lassen (pycentauri PROTOCOL.md; Prüfung 11.11.2026). Darum: antwortet der Drucker nie, nur noch alle 10 Min.
      // fragen und nie während eines Drucks; mit CANVAS (Antwort kam) wie bisher alle 30 s.
      const S0 = (st.state || {}).Status || {}, r324 = (st.state || {}).Response_324;
      if (r324) L.canvasOk = true;
      const printing0 = [].concat(S0.CurrentStatus || []).includes(1);
      const gap = L.canvasOk ? 30000 : (L.canvasAsks || 0) >= 2 ? 600000 : 30000;
      // Meldet der Drucker AmsConnectStatus, nur fragen, wenn eine CANVAS angeschlossen ist (Elegoo-SDK; zweite Prüfung 11.11.2026)
      const amsKnown = S0.AmsConnectStatus !== undefined, amsOn = amsKnown && !!+S0.AmsConnectStatus;
      if ((amsKnown ? amsOn : true) && (L.canvasOk || amsOn || !printing0 || (L.canvasAsks || 0) < 2) && (!L.canvasAt || Date.now() - L.canvasAt > gap)) { L.canvasAt = Date.now(); L.canvasAsks = (L.canvasAsks || 0) + 1; sdSend(p, 324).catch(() => {}); }
    }
  } catch (e) { st = { connected: false, err: e.message }; }
  const S_ = (st.state || {}).Status;
  if (!st.connected || !S_) { entry.amp_err = 'unreach'; finish(p, entry, L); return entry; }
  entry.online = true; entry.agent.klippy = 'ready';
  const pi = S_.PrintInfo || {}, cs = [].concat(S_.CurrentStatus || []), ps = +pi.Status || 0;
  entry.busy = cs.includes(1) || (ps > 0 && !SD_DONE.includes(ps));
  entry.temps = { nozzle: Math.round(+S_.TempOfNozzle || 0), bed: Math.round(+S_.TempOfHotbed || 0) };
  entry.ctl = sdCtl(p, L, S_, entry.busy);
  const at = (st.state || {}).Attributes || {};
  entry.stats = { prints: null, hours: null, fw: at.FirmwareVersion || null };
  if (!p.model && at.MachineName) { p.model = 'Elegoo ' + String(at.MachineName).replace(/^Elegoo\s*/i, ''); persist(); }
  // CANVAS (Mehrfarbeinheit): Antwort auf Cmd 324 — Fächer ab 0, leere melden „— — —“/„?“
  const cv = (st.state || {}).Response_324 && ((st.state || {}).Response_324.Data || (st.state || {}).Response_324);
  if (!canvasInto(p, entry, cv)) singleSlot(p, entry);
  const c = { state: entry.busy ? (SD_PAUSED.includes(ps) ? 'paused' : 'printing') : '', file: String(pi.Filename || ''), jid: pi.TaskId || null,
              prog: (+pi.Progress || 0) / 100, print_s: +pi.CurrentTicks || 0, finished: ps === 9, error: ps === 14 };
  if (entry.busy) entry.job = jobEntry(L, c, Math.max(0, (+pi.TotalTicks || 0) - (+pi.CurrentTicks || 0)), pi.TotalLayer ? [+pi.CurrentLayer || 0, +pi.TotalLayer] : null);
  obsHistory(p, L, c);
  finish(p, entry, L);
  return entry;
}

/** CANVAS (Mehrfarbeinheit; CC1: Antwort auf Cmd 324, CC2: Methode 2005): Fächer ab 0, leere melden status 0 bzw. „— — —“/„?“. */
function canvasInto(p, entry, cv) {
  const lst = cv && cv.canvas_list ? cv.canvas_list.filter(x => +x.connected) : [];
  if (!lst.length) return false;
  const many = lst.length > 1;
  for (const c of lst) for (const t of c.tray_list || []) {
    const idx = (+c.canvas_id) * 4 + (+t.tray_id), mat = String(t.filament_type || '').trim();
    const ok = mat && !/^[—\-\s?]+$/.test(mat) && +t.status !== 0;
    const sl = slotRow(p.id, idx);
    entry.slots.push({ slot_id: sl.id, index: idx, label: many ? (+c.canvas_id + 1) + '-' + (+t.tray_id + 1) : String(+t.tray_id + 1), material: ok ? mat.slice(0, 30) : null,
      color: ok && /^#?[0-9a-f]{6}$/i.test(t.filament_color || '') ? '#' + t.filament_color.replace('#', '').toLowerCase() : null, sku: null, remain_pct: null,
      spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false,
      inuse: entry.busy && +cv.active_canvas_id === +c.canvas_id && +cv.active_tray_id === +t.tray_id });
  }
  entry.boxes = lst.map((c, i) => ({ id: i, label: 'CANVAS' + (many ? ' ' + (+c.canvas_id + 1) : ''), dry: null, control: false, temp: null, humidity: null }));
  entry.ttg_map = entry.slots.map(x => x.index);
  return true;
}

// ── Elegoo Centauri Carbon 2: MQTT tcp://IP:1883 über Live.kt (Benutzer „elegoo“, Passwort = Zugangscode bzw. 123456), Anmeldung
//    über api_register, Befehle {id, method, params}, Vollstatus 1002 + Deltas 6000, Upload PUT :80/upload in 1-MiB-Stücken (elegoo-link-SDK) ──
const ccPort = (p, k, d) => (p.ports && p.ports[k]) || d;
const ccKey = p => 'cc_' + p.id;
const ccOpen = p => native('live_open', { kind: 'cc2', key: ccKey(p), host: p.host, serial: p.serial || '', code: p.code || '', port: ccPort(p, 'mqtt', 1883) });
/** Befehl schicken; Live.kt vergibt die id und hält 2 s Abstand (der CC2 verwirft Antworten, wenn Anfragen dicht folgen). */
const ccSend = (p, method, params) => native('live_send', { key: ccKey(p), payload: JSON.stringify({ method, params: params || {} }) });
const CC_ERR = { 109: 'no_filament', 1000: 'login', 1009: 'printer_busy', 1010: 'not_printing', 1021: 'file_missing', 1026: 'no_mesh', 9004: 'md5' };
/** Befehl mit Antwort: wartet auf r_<Methode> mit derselben id (Start/Pause antworten erst nach dem mechanischen Ablauf). */
async function ccCall(p, method, params, ms, early) {
  const { id } = await ccSend(p, method, params);
  const until = Date.now() + (ms || 15000);
  while (Date.now() < until) {
    await new Promise(z => setTimeout(z, 700));
    const st = await native('live_state', { key: ccKey(p) }).catch(() => ({}));
    const r = (st.state || {})['r_' + method];
    if (r && r.id === id) { const ec = +((r.result || {}).error_code || 0); if (ec) fail(CC_ERR[ec] || 'cc_' + ec); return r.result || {}; }
    if (early && early(st.state || {})) return {};
  }
  fail('timeout');
}
/** Druckzustand: print_status.state (neuere Firmware), sonst machine_status 2 + sub_status (2077 fertig, 2504 gestoppt, 2501/2502/2505 Pause). */
function ccPhase(S) {
  const ms = S.machine_status || {}, ps = S.print_status || {}, st = String(ps.state || ''), sub = +ms.sub_status || 0;
  if (st) return { busy: st === 'printing' || st === 'paused', paused: st === 'paused', done: st === 'complete', err: st === 'error' };
  const busy = +ms.status === 2 && ![2077, 2504].includes(sub);
  return { busy, paused: busy && [2501, 2502, 2505].includes(sub), done: sub === 2077, err: false };
}
async function ccSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'elegoo');
  let st;
  try {
    await ccOpen(p);
    st = await native('live_state', { key: ccKey(p) });
    if (st.serial && st.serial !== p.serial) { p.serial = st.serial; persist(); }
    if (st.registered && (!L.canvasAt || Date.now() - L.canvasAt > 30000)) { L.canvasAt = Date.now(); ccSend(p, 2005).catch(() => {}); }
  } catch (e) { st = { connected: false, err: e.message }; }
  const S_ = (st.state || {}).status;
  if (!st.connected || !S_) { entry.amp_err = st.err === 'access_code' ? 'key' : 'unreach'; finish(p, entry, L); return entry; }
  entry.online = true; entry.agent.klippy = 'ready';
  const ph = ccPhase(S_), ms = S_.machine_status || {}, ps = S_.print_status || {};
  entry.busy = ph.busy;
  entry.temps = { nozzle: Math.round(+(S_.extruder || {}).temperature || 0), bed: Math.round(+(S_.heater_bed || {}).temperature || 0) };
  entry.ctl = ccCtl(p, L, S_, entry.busy);
  const at = (st.state || {}).attributes || {};
  entry.stats = { prints: null, hours: null, fw: (at.software_version || {}).ota_version || null };
  if (!p.model && at.machine_model) { p.model = 'Elegoo ' + String(at.machine_model).replace(/^Elegoo\s*/i, ''); persist(); }
  // external_device.type "0"/leer = kein CANVAS angeschlossen (z. B. "0303" = angeschlossen)
  const ext = S_.external_device, noCanvas = ext && ['', '0'].includes(String(ext.type ?? ''));
  if (noCanvas || !canvasInto(p, entry, (st.state || {}).canvas || S_.canvas_info)) singleSlot(p, entry);
  const c = { state: ph.busy ? (ph.paused ? 'paused' : 'printing') : '', file: String(ps.filename || ''), jid: ps.uuid || null,
              prog: (+ms.progress || 0) / 100, print_s: +ps.print_duration || 0, finished: ph.done, error: ph.err };
  if (entry.busy) entry.job = jobEntry(L, c, +ps.remaining_time_sec || 0, +ps.total_layer ? [+ps.current_layer || 0, +ps.total_layer] : null);
  obsHistory(p, L, c);
  finish(p, entry, L);
  return entry;
}

// ── Creality OS ohne Root (K1/K1C/K1 Max/K1 SE, K2-Familie, Hi, Ender-3 V3, K3): WebSocket ws://IP:9999 über Live.kt,
//    Upload POST http://IP/upload/<name> (multipart „file“), Start opGcodeFile printprt:<pfad>, CFS boxsInfo, Kamera MJPEG/WebRTC ──
const crPort = (p, k, d) => (p.ports && p.ports[k]) || d;
const crKey = p => 'cr_' + p.id;
const CR_MODELS = { F001: 'Ender-3 V3', F002: 'Ender-3 V3 Plus', F005: 'Ender-3 V3 KE', F008: 'K2 Plus', F012: 'K2 Pro', F016: 'K2 SE', F021: 'K2', F018: 'Hi', F039: 'K3',
                    'CR-K1 Max': 'K1 Max', 'K1 Max': 'K1 Max', K1: 'K1', 'CR-K1': 'K1', K1C: 'K1C', 'K1C_CFS-C': 'K1C', 'K1 SE': 'K1 SE' };
const crModel = m => { m = String(m || '').trim(); return m ? 'Creality ' + (CR_MODELS[m] || m.replace(/^Creality\s*/i, '')) : null; };
// state: 0 bereit, 1 druckt (auch Heizen/Kalibrieren), 2 fertig, 3 Fehler, 4 abgebrochen, 5 Pause, 7 bricht ab, 9 Auftrag angenommen;
// laut CrealityPrint-Quellen: 5 PAUSED, 6 PAUSING, 7 STOPPING, 8 RESTORING (zweite Prüfung 11.11.2026)
const CR_BUSY = [1, 5, 6, 7, 8, 9];
const crSet = (p, params) => native('live_send', { key: crKey(p), payload: JSON.stringify({ method: 'set', params }) });
const crGet = (p, params) => native('live_send', { key: crKey(p), payload: JSON.stringify({ method: 'get', params }) });
const crColor = c => { const h = String(c || '').replace('#', ''); return /^[0-9a-f]{6,8}$/i.test(h) ? '#' + h.slice(-6).toLowerCase() : null; };   // „#0RRGGBB“ bzw. „#FFRRGGBB“
const crOpen = p => native('live_open', { kind: 'crws', key: crKey(p), host: p.host, port: crPort(p, 'ws', 9999) });
async function crSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'creality');
  let st;
  try { await crOpen(p); st = await native('live_state', { key: crKey(p) }); } catch (e) { st = { connected: false, err: e.message }; }
  const S = (st && st.state) || {};
  if (!st.connected || !('state' in S || 'nozzleTemp' in S)) { entry.amp_err = 'unreach'; finish(p, entry, L); return entry; }
  entry.online = true; entry.agent.klippy = 'ready';
  const code = +S.state || 0, busy = CR_BUSY.includes(code) || +S.deviceState === 1;
  entry.busy = busy;
  entry.temps = { nozzle: Math.round(+S.nozzleTemp || 0), bed: Math.round(+(S.bedTemp0 ?? S.bedTemp) || 0) };
  entry.ctl = crCtl(p, L, S, entry.busy);
  const fw = (/DWIN sw ver:([^;]+)/.exec(String(S.modelVersion || '')) || [])[1] || (/printer sw ver:([^;]+)/.exec(String(S.modelVersion || '')) || [])[1] || S.printerVersion || null;
  entry.stats = { prints: S.totalJob != null ? +S.totalJob : null, hours: S.totalUsageTime != null ? Math.round(+S.totalUsageTime / 3600) : null, fw };
  // Modellcode, den wir früher nicht kannten (F016 = K2 SE, #90), auch bei schon gespeicherten Druckern nachziehen
  if (S.model && (!p.model || (p.model === 'Creality ' + String(S.model).trim() && CR_MODELS[String(S.model).trim()]))) { p.model = crModel(S.model); persist(); }
  // CFS kommt nicht im Statusstrom → alle 20 s abfragen, wenn angeschlossen (Creality Print macht es genauso)
  if ((+S.cfsConnect === 1 || S.boxsInfo) && (!L.cfsAt || Date.now() - L.cfsAt > 20000)) { L.cfsAt = Date.now(); crGet(p, { boxsInfo: 1 }).catch(() => {}); }
  const mb = ((S.boxsInfo || {}).materialBoxs || []).filter(b => b && Array.isArray(b.materials));
  const cfs = mb.filter(b => +b.type !== 1 && +b.id >= 1).sort((a, b) => a.id - b.id), ext = mb.find(b => +b.type === 1);
  if (cfs.length) {
    for (const b of cfs) for (const m of b.materials) {
      const idx = (+b.id - 1) * 4 + (+m.id), filled = +m.state !== 0 && String(m.type || '').trim();
      const sl = slotRow(p.id, idx);
      entry.slots.push({ slot_id: sl.id, index: idx, label: b.id + 'ABCD'[+m.id], material: filled ? String(m.type).slice(0, 30) : null, color: filled ? crColor(m.color) : null,
        sku: null, remain_pct: filled && +m.state === 2 && m.percent >= 0 && m.percent <= 100 ? Math.round(+m.percent) : null,
        spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: busy && +m.selected === 1 });
    }
    if (ext && ext.materials[0]) {   // Spulenhalter (boxId 0) als „Ext“
      const m = ext.materials[0], filled = +m.state !== 0 && String(m.type || '').trim(), sl = slotRow(p.id, 100);
      entry.slots.push({ slot_id: sl.id, index: 100, label: 'Ext', material: filled ? String(m.type).slice(0, 30) : null, color: filled ? crColor(m.color) : null, sku: null, remain_pct: null,
        spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: busy && +m.selected === 1 });
    }
    entry.boxes = cfs.map(b => ({ id: +b.id, label: 'CFS ' + b.id, dry: null, control: false, temp: b.temp != null ? Math.round(+b.temp) : null,
                                  humidity: b.humidity > 0 && b.humidity <= 100 ? Math.round(+b.humidity) : null }));
    entry.ttg_map = entry.slots.map(x => x.index);
  } else singleSlot(p, entry);
  const file = String(S.printFileName || '').split('/').pop();   // voller Pfad → nur der Name (wie die App ihn hochlädt)
  // Am Druckanfang/-ende CFS sofort neu holen (aktives Fach), sonst alle 20 s
  if (L.crBusy !== busy && (+S.cfsConnect === 1 || S.boxsInfo)) { L.cfsAt = Date.now(); crGet(p, { boxsInfo: 1 }).catch(() => {}); }
  L.crBusy = busy;
  const c = { state: busy ? (code === 5 || code === 6 ? 'paused' : 'printing') : '', file, jid: S.printId || null, prog: (+S.printProgress || 0) / 100, print_s: +S.printJobTime || 0,
              finished: code === 2, error: code === 3 };
  // usedMaterialLength = bisher verbrauchte mm → hochgerechnet auf den ganzen Druck (obsHistory bucht bei Abbruch Gesamt × Fortschritt)
  if (+S.usedMaterialLength > 0 && c.prog > 0.02) c.mm = Math.round(+S.usedMaterialLength / c.prog);
  if (busy) entry.job = jobEntry(L, c, +S.printLeftTime || 0, +S.TotalLayer ? [+S.layer || 0, +S.TotalLayer] : null);
  obsHistory(p, L, c);
  finish(p, entry, L);
  return entry;
}
/** Ordner der G-Codes: was der Drucker selbst meldet (printFileName), sonst K2/K3/Hi /mnt/UDISK…, K1/Ender /usr/data… */
// G-Code-Ordner: K1-Familie, Ender-3 V3 (F001–F005) und K2 SE (F016) unter /usr/data, alle anderen unter /mnt/UDISK
// (OrcaSlicer CrealityPrint.cpp; Prüfung 11.11.2026 — vorher landeten unbekannte Modelle wie SPARKX i7/Ender-3 V4 falsch in /usr/data)
// K1C_CFS-C (Orca stores_gcode_in_usr_data) und CR-K1 (ha_creality_ws) fielen durch → zweite Prüfung 11.11.2026
const CR_USR = /^(F00[1-5]|F016|(CR-)?K1(C|C[ _-].*|[ _-].*)?)$/i;
function crDir(p, S) {
  const f = String(S.printFileName || '');
  // Ordner des letzten Drucks nur, wenn es der G-Code-Ordner ist (ein Druck vom USB-Stick läge woanders)
  if (/^\/.+\/printer_data\/gcodes\/[^/]+$/.test(f)) return f.replace(/\/[^/]+$/, '');
  if (p.crDir) return p.crDir;   // hier hat ein Start aus der App schon geklappt (#98)
  const code = String(S.model || '').trim();
  if (code) return CR_USR.test(code) ? '/usr/data/printer_data/gcodes' : '/mnt/UDISK/printer_data/gcodes';
  return /\bK1\b|K1C|K1 Max|K1 SE|Ender-3 V3|K2 SE/.test(p.model || '') ? '/usr/data/printer_data/gcodes' : '/mnt/UDISK/printer_data/gcodes';
}

// ── Flashforge Adventurer 5M / 5M Pro / AD5X / Creator 5 (Werksfirmware, „Nur LAN“): HTTP http://IP:8898, POST mit serialNumber + checkCode ──
const ffPort = p => (p.ports && p.ports.http) || p.port || 8898;
const FF_PID = { 0x23: 'Adventurer 5M', 0x24: 'Adventurer 5M Pro', 0x26: 'AD5X', 0x28: 'Creator 5', 0x29: 'Creator 5 Pro' };
const ffModel = pid => { const n = typeof pid === 'string' ? parseInt(pid, /^0/.test(pid) ? 16 : 10) : +pid; return FF_PID[n] ? 'Flashforge ' + FF_PID[n] : null; };
const FF_BUSY = ['printing', 'pausing', 'pause', 'paused', 'heating', 'calibrate_doing', 'busy', 'canceling', 'downloading', 'sending', 'unzipping', 'cloud_slicing'];
const FF_ERR = { 2: 'printer_busy', 3: 'file_missing', '-2': 'lan_mode' };
async function ffPost(p, path, extra, timeout) {
  const r = await native('http', { url: `http://${p.host}:${ffPort(p)}${path}`, method: 'POST', timeout: timeout || 5000, headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify({ serialNumber: p.serial || '', checkCode: p.code || '', ...(extra || {}) }) });
  if (r.status >= 400) fail('http_' + r.status);
  let d; try { d = JSON.parse(r.text || '{}'); } catch (e) { fail('bad_json'); }
  if (+d.code !== 0) { const m = String(d.message || ''); fail(/access code|SN is different/i.test(m) || +d.code === 1 ? 'login' : FF_ERR[d.code] || 'ff_' + d.code); }
  return d;
}
async function ffSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'flashforge');
  let d;
  try { d = (await ffPost(p, '/detail', null, 3500)).detail || {}; }
  catch (e) { entry.amp_err = e.message === 'login' ? 'key' : e.message === 'lan_mode' ? 'lan' : 'unreach'; finish(p, entry, L); return entry; }
  entry.online = true; entry.agent.klippy = 'ready';
  const stt = String(d.status || '').toLowerCase(), busy = FF_BUSY.includes(stt) || !['ready', 'completed', 'cancel', 'error', ''].includes(stt);
  entry.busy = busy;
  entry.temps = { nozzle: Math.round(+(d.rightTemp ?? (d.nozzleTemps || [])[0]) || 0), bed: Math.round(+d.platTemp || 0) };
  entry.ctl = ffCtl(p, L, d, busy);
  entry.stats = { prints: null, hours: null, fw: d.firmwareVersion || null };
  if (!p.model) { const m = ffModel(d.pid); if (m) { p.model = m; persist(); } }
  // IFS (AD5X, Creator 5): 4 Fächer, slotId ab 1
  const ms = d.matlStationInfo || {}, infos = Array.isArray(ms.slotInfos) ? ms.slotInfos : [];
  if ((d.hasMatlStation === true || +d.hasMatlStation === 1 || infos.length) && infos.length) {
    for (const s of infos) {
      const idx = (+s.slotId || 1) - 1, filled = (s.hasFilament === true || +s.hasFilament === 1) && String(s.materialName || '').trim();
      const sl = slotRow(p.id, idx);
      entry.slots.push({ slot_id: sl.id, index: idx, label: String(idx + 1), material: filled ? String(s.materialName).slice(0, 30) : null,
        color: filled && /^#?[0-9a-f]{6}$/i.test(s.materialColor || '') ? '#' + String(s.materialColor).replace('#', '').toLowerCase() : null,
        sku: null, remain_pct: null, spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: busy && +ms.currentSlot === idx + 1 });
    }
    entry.boxes = [{ id: 0, label: 'IFS', dry: null, control: false, temp: null, humidity: null }];
    entry.ttg_map = entry.slots.map(x => x.index);
  } else singleSlot(p, entry);
  const w = +d.estimatedRightWeight || 0, mm = +d.estimatedRightLen || 0;
  const c = { state: busy ? (/^paus/.test(stt) ? 'paused' : 'printing') : '', file: String(d.printFileName || ''), jid: null, prog: Math.min(1, +d.printProgress || 0),
              print_s: +d.printDuration || 0, finished: stt === 'completed', error: stt === 'error', weights: w ? [w] : [], mm: mm || null };
  if (busy) entry.job = jobEntry(L, c, +d.estimatedTime || 0, +d.targetPrintLayer ? [+d.printLayer || 0, +d.targetPrintLayer] : null);
  obsHistory(p, L, c);
  L.ffCam = d.cameraStreamUrl || '';
  finish(p, entry, L);
  return entry;
}
/** Flashforge-Antwort auf die Suche (UDP, Big Endian, ≥ 196 Bytes): Name @0, PID @0x88, HTTP-Port @0x8E, Seriennummer @0x92. */
function ffFound(packets) {
  const out = new Map();
  for (const pk of packets) {
    let b; try { b = Uint8Array.from(atob(pk.b64 || ''), ch => ch.charCodeAt(0)); } catch (e) { continue; }
    if (b.length < 196 || ((b[0x86] << 8) | b[0x87]) !== 0x2B71) continue;   // VID Flashforge
    const cstr = (o, n) => { let s = ''; for (let i = o; i < Math.min(b.length, o + n) && b[i]; i++) s += String.fromCharCode(b[i]); return s.trim(); };
    const pid = (b[0x88] << 8) | b[0x89], port = (b[0x8E] << 8) | b[0x8F], serial = cstr(0x92, 128);
    if (!out.has(pk.from)) out.set(pk.from, { host: pk.from, port: port || 8898, kind: 'flashforge', serial, name: cstr(0, 128) || ffModel(pid) || 'Flashforge', model: ffModel(pid), need_code: true });
  }
  return [...out.values()];
}
// Suchanfrage wie FlashPrint/Orca: „www.usr"e6“ + 0xC0 + 9 Nullbytes
const FF_DISCO = btoa(String.fromCharCode(0x77, 0x77, 0x77, 0x2E, 0x75, 0x73, 0x72, 0x22, 0x65, 0x36, 0xC0, 0, 0, 0, 0, 0, 0, 0, 0, 0));

// ── Anycubic LAN-Modus (Werksfirmware ohne Rinkhals; Kobra 3/3 V2/3 Max/4, S1, S1 Max, Kobra X): Handshake + MQTT/TLS in Live.kt,
//    Upload POST <info.urls.fileUploadurl> (multipart „gcode“ + Feld filename, X-File-Length), Start print/start mit ams_box_mapping ──
const AC_MODELS = { 20021: 'Kobra 2 Pro', 20022: 'Kobra 2 Plus', 20023: 'Kobra 2 Max', 20024: 'Kobra 3', 20025: 'Kobra S1', 20026: 'Kobra 3 Max',
                    20027: 'Kobra 3 V2', 20028: 'Kobra 4', 20029: 'Kobra S1 Max', 20030: 'Kobra X' };
const acModel = (id, name) => AC_MODELS[+id] ? 'Anycubic ' + AC_MODELS[+id] : name ? 'Anycubic ' + String(name).replace(/^Anycubic\s*/i, '') : null;
const acPort = (p, k, d) => (p.ports && p.ports[k]) || d;
const acKey = p => 'ac_' + p.id;
const acOpen = p => native('live_open', { kind: 'acl', key: acKey(p), host: p.host, port: acPort(p, 'http', p.port || 18910), mqttPort: acPort(p, 'mqtt', 0), did: deviceId() });
const acSend = (p, type, action, data) => native('live_send', { key: acKey(p), payload: JSON.stringify({ type, action, data: data === undefined ? null : data }) });
// project.state: preheating, auto_leveling, vibrating, flow_calibrating, printing, pausing, paused, resuming, stopping, stoped (sic), finished
// Firmware 2.0.x (Kobra X u. a.) meldet die Vorbereitung in Einzelschritten (KX-Bridge bridge_constants; Prüfung 11.11.2026, #84)
const AC_PREP = ['preheating', 'auto_leveling', 'vibrating', 'flow_calibrating', 'nozzle_heating', 'nozzle_cooling', 'nozzle_wiping', 'nozzle_purging',
                 'hotbed_heating', 'z_offset_calibrating', 'frequency_sweeping', 'extfilbox_filament_feeding', 'hotbed_cooling_off', 'init'];
const AC_RUN = [...AC_PREP, 'printing', 'pausing', 'paused', 'pause', 'resuming', 'resumed', 'stopping', 'busy', 'downloading', 'checking'];
const acRgb = c => Array.isArray(c) && c.length >= 3 ? '#' + c.slice(0, 3).map(v => (+v & 255).toString(16).padStart(2, '0')).join('') : null;
// Auftragsnummer des laufenden Drucks: info.project.taskid, je nach Firmware task_id (anycubic-cloud-api LAN), sonst aus dem print-Bericht.
// Pause/Stopp brauchen sie (23.11.2026 #52, Kobra X FW 2.0.2.8: mit taskid "-1" passiert nichts, nur „Weiter“ nimmt sie an —
// Anycubic Slicer Next und hass-anycubic schicken immer die echte Nummer)
const acTaskOf = S => { const pj = (S.info || {}).project || {}, pr = S.print || {}; const v = pj.taskid ?? pj.task_id ?? pr.taskid ?? pr.task_id;
  return v != null && String(v) !== '' && String(v) !== '-1' ? String(v) : null; };
const acArr = h => { const m = /^#?([0-9a-f]{6})/i.exec(h || ''); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : [0, 0, 0]; };
/**
 * Auftrag: Lebenslauf (state, pause) NUR aus info.project; Fortschritt kommt schneller als print-Bericht — der ist ungeschachtelt
 * (progress, curr_layer, total_layers, remain_time Min., print_time Sek.) und nur gültig, wenn er „progress“ enthält und neuer ist.
 * Leerlauf: kein project, dafür last_project (state finished/stoped). (anycubic_ha_local PROTOCOL-VALIDATED)
 */
function acPhase(S) {
  const info = S.info || {}, cur = info.project || null, last = info.last_project || null, pr = S.print || {};
  const st = String((cur || {}).state || '').toLowerCase(), pz = +(cur || {}).pause || 0;
  const busy = !!cur && (AC_RUN.includes(st) || (String(info.state || '') === 'busy' && !['finished', 'stoped', 'stopped'].includes(st)));
  const pj = Object.assign({}, busy ? cur : (last || {}));
  if (busy && 'progress' in pr && (S.print_at || 0) > (S.info_at || 0) && (!pr.filename || !pj.filename || String(pr.filename).split('/').pop() === String(pj.filename).split('/').pop()))
    for (const k of ['progress', 'curr_layer', 'total_layers', 'remain_time', 'print_time', 'supplies_usage']) if (pr[k] !== undefined) pj[k] = pr[k];
  // Vor dem eigentlichen Druck (Aufheizen, Nivellieren, Kalibrieren) gibt es noch keinen Druckfortschritt
  if (busy && AC_PREP.includes(st)) pj.progress = 0;
  const lst = String((last || {}).state || '').toLowerCase();
  return { busy, paused: busy && (st === 'paused' || st === 'pausing' || st === 'pause' || pz === 1 || pz === 2), done: !busy && lst === 'finished', stopped: !busy && (lst === 'stoped' || lst === 'stopped'), pj, phase: st };
}
async function acSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'anycubic');
  let st;
  try { await acOpen(p); st = await native('live_state', { key: acKey(p) }); } catch (e) { st = { connected: false, err: e.message }; }
  const S = (st && st.state) || {};
  if (!st.connected || !(S.info || S.print || S.tempature || S.multiColorBox)) {
    entry.amp_err = st.err === 'lan_off' ? 'lan' : st.err === 'login' ? 'key' : 'unreach';
    if (entry.amp_err === 'unreach') entry.amp_detail = st.connected ? 'MQTT verbunden, noch kein Bericht' : st.err || '';
    finish(p, entry, L); return entry;
  }
  entry.online = true; entry.agent.klippy = 'ready';
  const ph = acPhase(S), info = S.info || {}, tp = Object.assign({}, info.temp || {}, S.tempature || {});
  entry.busy = ph.busy;
  if (L.acBusy !== ph.busy) acSend(p, 'multiColorBox', 'getInfo').catch(() => {});   // Druckanfang/-ende: aktives Fach sofort neu
  L.acBusy = ph.busy;
  entry.temps = { nozzle: Math.round(+(tp.curr_nozzle_temp ?? tp.nozzle_temp ?? 0) || 0), bed: Math.round(+(tp.curr_hotbed_temp ?? tp.hotbed_temp ?? 0) || 0) };
  // Licht und Lüfter kommen nicht von selbst → nachfragen (wie anycubic_ha_local QUERY_TYPES)
  // Nach dem (Neu-)Verbinden fehlen beide Berichte → gleich fragen (höchstens alle 3 s), sonst alle 30 s
  if (!L.acCtlAt || Date.now() - L.acCtlAt > (S.light && S.fan ? 30000 : 3000)) { L.acCtlAt = Date.now(); acSend(p, 'light', 'query').catch(() => {}); acSend(p, 'fan', 'query').catch(() => {}); }
  entry.ctl = acCtl(p, L, S, ph.busy);
  entry.stats = { prints: null, hours: null, fw: info.version || info.firmware_version || null };
  const li = S.lanInfo || {};
  if (!p.model || p.model === 'Anycubic') { const m = acModel(li.modelId || info.model_id, li.modelName); if (m) { p.model = m; persist(); } }
  // ACE: je Box 4 Fächer; eine Box „1–4“, mehrere „1-1 … 2-4“ (wie 3DSEARCH); Fach-status 5 = Spule drin, 4 = LEER, type "" = leer.
  // Status 4 behält Material/Farbe/SKU der letzten Spule (Dennys Rohdaten 29.09.2026, printer_cloud_lib.php) — vorher zählte die App
  // nur „type gesetzt“ → Phantomspule im geleerten Fach, Abbuchung darauf. SimplyPrint zählt ebenfalls nur 5 (beobachtet 17.11.2026).
  // ACE-Bericht kommt nach App-Start erst ~5 s nach info → bis dahin den zuletzt gesehenen Stand (in data.json) zeigen statt
  // „1 Spule“, und noch einmal nachfragen (09.11.2026, Echttest Kobra S1)
  let boxes = (((S.multiColorBox || {}).multi_color_box) || []).filter(b => b && Array.isArray(b.slots) && b.slots.length);
  if (boxes.length) {
    const keep = boxes.map(b => ({ id: b.id, loaded_slot: b.loaded_slot, slots: b.slots.map(x => ({ index: x.index, type: x.type, color: x.color, sku: x.sku, consumables_percent: x.consumables_percent, status: x.status })) }));
    if (JSON.stringify(keep) !== JSON.stringify(p.acBox || null)) { p.acBox = keep; persist(); }
  } else if (Array.isArray(p.acBox) && p.acBox.length) {
    boxes = p.acBox;
    if (Date.now() - (L.acAsk || 0) > 2000) { L.acAsk = Date.now(); acSend(p, 'multiColorBox', 'getInfo').catch(() => {}); }
  }
  L.acBoxes = boxes.map(b => +b.id);
  if (boxes.length) {
    const many = boxes.length > 1;
    boxes.forEach((b, pos) => {
      for (const s of b.slots) {
        const i = +s.index || 0, idx = pos * 4 + i, filled = String(s.type || '').trim() && +s.status !== 4 ? String(s.type).trim() : '';
        const sl = slotRow(p.id, idx);
        entry.slots.push({ slot_id: sl.id, index: idx, label: many ? (pos + 1) + '-' + (i + 1) : String(i + 1), material: filled ? String(s.type).slice(0, 30) : null,
          color: filled ? acRgb(s.color) : null, sku: filled ? s.sku || null : null, remain_pct: filled && +s.consumables_percent > 0 && +s.consumables_percent <= 100 ? Math.round(+s.consumables_percent) : null,
          spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: ph.busy && +b.loaded_slot === i });
      }
      const ds = b.drying_status || {};
      // Box −1 = eingebauter Fachwechsler der Kobra X: nur Zuführung, kein Trockner (anycubic_ha_local const.py, Issue #8; zweite Prüfung 11.11.2026)
      const head = +b.id < 0;
      entry.boxes.push({ id: pos, label: head ? 'Kobra X' : 'ACE' + (many ? ' ' + (pos + 1) : ''), control: !head,
        dry: +ds.status === 1 ? { target: Math.round(+ds.target_temp || 0), remain_min: Math.round(+ds.remain_time || 0), duration_min: Math.round(+ds.duration || 0) } : null,
        temp: b.temp > 0 ? Math.round(+b.temp) : null, humidity: b.humidity > 0 && b.humidity <= 100 ? Math.round(+b.humidity) : null });
    });
    entry.ttg_map = entry.slots.map(x => x.index);
  } else singleSlot(p, entry);
  const pj = ph.pj;
  // ACE im Druck alle 10 s fragen: welches Fach gerade fördert, für die Verbrauchsaufteilung (acUsage)
  if (ph.busy && boxes.length && Date.now() - (L.acBoxAt || 0) > 10000) { L.acBoxAt = Date.now(); acSend(p, 'multiColorBox', 'getInfo').catch(() => {}); }
  const c = { state: ph.busy ? (ph.paused ? 'paused' : 'printing') : '', file: String(pj.filename || '').split('/').pop(), jid: pj.taskid && pj.taskid !== '-1' ? String(pj.taskid) : null,
              prog: Math.min(1, (+pj.progress || 0) / 100), print_s: +pj.print_time || 0, finished: ph.done, error: false, use: acUsage(p, L, S, ph, boxes) };
  if (ph.busy) entry.job = jobEntry(L, c, (+pj.remain_time || 0) * 60, +pj.total_layers ? [+pj.curr_layer || 0, +pj.total_layers] : null);
  obsHistory(p, L, c);
  finish(p, entry, L);
  return entry;
}
/**
 * Verbrauch fremder Drucke (23.11.2026, Meldung Kobra X FW 2.0.2.8: Drucke aus Anycubic Slicer Next standen als „ohne Filamentdaten“):
 * Der Drucker meldet supplies_usage = tatsächlich geförderte mm (info.project und print-Bericht, nach dem Ende in info.last_project;
 * so liest es auch hass-anycubic / anycubic-cloud-api). Gramm je Fach: jeden Zuwachs dem Fach zuschreiben, das die ACE gerade als
 * geladen meldet (im Druck alle 10 s erfragt); Fach noch unbekannt → zurückhalten, bis eins gemeldet wird. Ohne ACE: Fach 0.
 * Stand in p.acUse { key, file, last (mm), mm: { Fach: mm }, slot, pend, done } — in den Daten, übersteht einen Neustart.
 * → { file, parts: [{ slot, g }] } für obsHistory (gebucht wird wie gemessen, auch bei Abbruch), sonst null.
 */
function acUsage(p, L, S, ph, boxes) {
  const bn = f => String(f || '').split('/').pop();
  let u = p.acUse || null, dirty = false, now = Date.now();
  const add = (mm, slot) => {
    if (slot === null || slot === undefined) { u.pend = (u.pend || 0) + mm; return; }
    u.mm[slot] = (u.mm[slot] || 0) + mm + (u.pend || 0); u.pend = 0;
  };
  if (ph.busy) {
    const pj = ph.pj, file = bn(pj.filename), key = file + '|' + String(pj.taskid ?? pj.task_id ?? '');
    const mm = +pj.supplies_usage;
    if (!file || !Number.isFinite(mm)) return u && u.key === key ? acUseOut(p, u) : null;   // Firmware ohne supplies_usage → wie bisher
    if (!u || u.key !== key || mm + 5 < u.last) { u = p.acUse = { key, file, last: 0, mm: {}, slot: null, pend: 0, done: false }; dirty = true; L.acUseSave = 0; }
    let sl = boxes.length ? null : 0;
    for (let pos = 0; pos < boxes.length && sl === null; pos++) { const ls = +boxes[pos].loaded_slot; if (ls >= 0 && ls < 4) sl = pos * 4 + ls; }
    if (sl !== null && sl !== u.slot) { u.slot = sl; if (u.pend) add(0, sl); dirty = true; L.acUseSave = 0; }
    if (mm > u.last) { add(mm - u.last, sl ?? u.slot); u.last = mm; dirty = true; }
  } else if (u && !u.done) {
    // Ende: letzter Stand aus last_project (die letzten Sekunden seit der Abfrage), sonst was bis dahin gemessen wurde
    const lp = (S.info || {}).last_project || {}, fin = +lp.supplies_usage;
    if (bn(lp.filename) === u.file && Number.isFinite(fin) && fin > u.last) { add(fin - u.last, u.slot); u.last = fin; }
    u.done = true; dirty = true; L.acUseSave = 0;
  }
  if (dirty && now - (L.acUseSave || 0) > 60000) { L.acUseSave = now; persist(); }
  return u ? acUseOut(p, u) : null;
}
function acUseOut(p, u) {
  const parts = Object.entries(u.mm).filter(([, mm]) => mm > 0).map(([s, mm]) => {
    const sl = db.slots.find(x => x.printer_id === p.id && x.index === +s), sp = sl && sl.spool_id ? db.spools.find(x => x.id === sl.spool_id) : null;
    const box = (p.acBox || []).flatMap((b, pos) => (b.slots || []).map(x => [pos * 4 + (+x.index || 0), x.type])).find(x => x[0] === +s);
    const mat = String((sp && sp.material) || (box && box[1]) || 'PLA').toUpperCase();
    return { slot: +s, g: Math.round(mmToG(mm, (sp && +sp.diameter) || 1.75, (sp && +sp.density) || DENSITY[mat] || 1.24) * 10) / 10 };
  });
  return { file: u.file, parts };
}
/** Anycubic-LAN-Antwort auf GET :18910/info → Fund (ctrlType lan/cloud, modelId, cn). */
async function acInfo(host, port) {
  try {
    const r = await native('http', { url: `http://${host}:${port || 18910}/info`, timeout: 2500, max: 8000 });
    if (r.status !== 200) return null;
    const j = JSON.parse(r.text || '{}');
    if (!j.modelId && !j.cn && !j.ctrlInfoUrl) return null;
    const m = acModel(j.modelId, j.modelName);
    return { host, port: port || 18910, kind: 'acl', serial: j.cn || '', name: j.deviceName || m || 'Anycubic', model: m, lan: j.ctrlType !== 'cloud', old: !j.token };
  } catch (e) { return null; }
}

// ── Lüfter und Licht (12.11.2026, User: „so schön drehend und eben ein Lichtschalter“, Vorbild OctoApp am Kobra S1) ──────────
// entry.ctl = { fans: [{ id, k, name, pct, set }], lights: [{ id, k, name, on }] } oder null.
//   k = Art für den Text (part, aux, box, chamber, filter, exhaust; light: chamber, head, camera), sonst name = Name am Drucker;
//   pct 0–100 bzw. on true/false, null = unbekannt; set = false → nur anzeigen (Anycubic/Flashforge nur während eines Drucks).
// Quellen (nur Fakten): Rinkhals kobra.py, Klipper-Doku, elegoo-homeassistant (SDCP 403, CC2 1029/1030), ha_creality_ws,
// Parallel-7 flashforge-api-docs, anycubic_ha_local, ha-bambulab. OctoPrint/PrusaLink: kein lesbarer Stand → nicht angeboten.
const LIGHT_RE = /light|led|lamp|licht|caselight|lumi/i;
const fanK = n => /^(box|case|enclosure|cavity)_?fans?$/i.test(n) ? 'box' : /filter|nevermore|bento|scrubber/i.test(n) ? 'filter' : /exhaust/i.test(n) ? 'exhaust'
  : /chamber/i.test(n) ? 'chamber' : /aux|side/i.test(n) ? 'aux' : /^part|^model/i.test(n) ? 'part' : '';
const lightK = n => /head|nozzle|toolhead/i.test(n) ? 'head' : /cam/i.test(n) ? 'camera' : /chamber|case|cabinet|enclosure|^(led|light|lights)$/i.test(n) ? 'chamber' : '';
// Rinkhals (GoKlipper, Kobra S1/S1 Max): box_fan/air_filter_fan stehen als fan_generic in der Liste, geschaltet wie im Anycubic-Druckprofil
// (belegt 12.11.2026: der Druck setzt „M106 P3 S153“ am Start und ab Schicht 2 „M106 P2 S153“, OctoApp zeigt Air Filter 60 % / Box Fan 60 %)
const KOBRA_FAN_P = { box_fan: 2, air_filter_fan: 3 };
const pctOf = (v, max) => v === undefined || v === null || v === '' || !Number.isFinite(+v) ? null : Math.round(Math.max(0, Math.min(max, +v)) / max * 100);
const ctlEmpty = () => ({ fans: [], lights: [] });
// ── Druckgeschwindigkeit (21.11.2026, User: „beim Kobra S1 gibt es die Funktion speed … in 3 Stufen“) ──────────
// ctl.speed = { lv: Stufen, cur: Stufe | null, pct: Prozent | null } — NUR während eines Drucks (vorher/nachher nichts einzustellen).
// Stufen je Weg (nur Fakten aus den Referenzen): Anycubic LAN print/update settings.print_speed_mode 1–3 (kobra-connect mqtt-commands.md,
// KX-Bridge handle_api_speed), Bambu print_speed 1–4 / spd_lvl (ha-bambulab), Elegoo CC1 PrintSpeedPct 50/100/130/160 über 403
// (elegoo-homeassistant PRINT_SPEED_PRESETS_SDCP), CC2 Methode 1031 {mode 0–3} / gcode_move_inf.speed_mode (CC2_PROTOCOL.md),
// Creality setFeedratePct / curFeedratePct (ha_creality_ws), Flashforge printerCtl_cmd speed / printSpeedAdjust (ff-5mp-api Control.ts),
// Klipper M220 S<%> / gcode_move.speed_factor. Prozent-Drucker bekommen dieselben vier Stufen wie Elegoo CC1.
const SPD = ['silent', 'std', 'sport', 'ludi'];
const SPD_PCT = { silent: 50, std: 100, sport: 130, ludi: 160 };
const spdOfPct = pct => pct == null || !Number.isFinite(+pct) ? null : SPD.find(k => Math.abs(SPD_PCT[k] - pct) <= 2) || null;
const spdMk = (lv, cur, pct) => ({ lv, cur: lv.includes(cur) ? cur : null, pct: pct == null || !Number.isFinite(+pct) ? null : Math.round(+pct) });
/** Gerade selbst geschaltet: bis die Meldung des Druckers nachzieht (Dauerverbindungen melden teils Sekunden später), den gewünschten Stand zeigen. */
function ctlOverlay(L, ctl) {
  const want = L.ctlWant || {}, t0 = Date.now();
  for (const f of ctl.fans) { const w = want['f:' + f.id]; if (w && t0 - w.at < 8000) f.pct = w.v; }
  for (const l of ctl.lights) { const w = want['l:' + l.id]; if (w && t0 - w.at < 8000) l.on = w.v; }
  const ws = want.s; if (ctl.speed && ws && t0 - ws.at < 8000) { ctl.speed.cur = ws.v; if (ctl.speed.pct != null) ctl.speed.pct = SPD_PCT[ws.v]; }
  return ctl.fans.length || ctl.lights.length || ctl.speed ? ctl : null;
}

/** Klipper: eigene Abfrage, damit ein Fehler hier nie den ganzen Druckerstand kostet. Licht auch als Moonraker-Schaltgerät (Rinkhals: chamber_light). */
async function mrCtl(p, L, busy, gm) {
  const ctl = ctlEmpty(), objs = L.ctlObj || [];
  // Geschwindigkeit: gcode_move.speed_factor (1 = 100 %) aus der Hauptabfrage, gesetzt mit M220
  if (busy && gm && Number.isFinite(+gm.speed_factor)) { const pc = +gm.speed_factor * 100; ctl.speed = spdMk(SPD, spdOfPct(pc), pc); }
  if (objs.length) {
    try {
      const q = Object.fromEntries(objs.map(o => [o, /^(fan|fan_generic)\b/.test(o) ? 'speed' : /^output_pin /.test(o) ? 'value' : 'color_data']));
      const s = (await mrGet(p, '/printer/objects/query?' + qs(q), 3000)).status || {};
      for (const o of objs) {
        const v = s[o]; if (!v || typeof v !== 'object') continue;
        const sp = o.indexOf(' '), type = sp < 0 ? o : o.slice(0, sp), name = sp < 0 ? '' : o.slice(sp + 1);
        if (type === 'fan') ctl.fans.unshift({ id: 'fan', k: 'part', name: '', pct: pctOf(v.speed, 1), set: true });
        else if (type === 'fan_generic') ctl.fans.push({ id: o, k: fanK(name), name, pct: pctOf(v.speed, 1), set: true });
        else if (type === 'output_pin') ctl.lights.push({ id: o, k: lightK(name), name, on: v.value == null ? null : +v.value > 0 });
        else ctl.lights.push({ id: o, k: lightK(name), name, on: Array.isArray(v.color_data) ? v.color_data.some(c => Array.isArray(c) && c.some(x => +x > 0)) : null });
      }
    } catch (e) { /* Lüfter/Licht diesmal ohne Stand */ }
  }
  if ((L.comps || []).includes('power')) {
    try {
      if (!L.pwrAt || Date.now() - L.pwrAt > 5000) { L.pwr = (await mrGet(p, '/machine/device_power/devices', 3000)).devices || []; L.pwrAt = Date.now(); }
      // Nur Lichter — ein Schaltgerät, das den ganzen Drucker abschaltet, gehört nicht auf diese Kachel
      for (const d of L.pwr || []) if (d && /^[\w.-]+$/.test(d.device || '') && LIGHT_RE.test(d.device))
        ctl.lights.push({ id: 'power:' + d.device, k: lightK(d.device), name: d.device, on: d.status === 'on' ? true : d.status === 'off' ? false : null });
    } catch (e) { L.pwr = L.pwr || []; }
  }
  return ctlOverlay(L, ctl);
}
async function mrCtlSet(p, L, inp, id) {
  const gc = script => mrPost(p, '/printer/gcode/script', { script }, 10000);
  if (inp.cmd === 'fan') {
    const v = int(inp.pct, 0, 100) ?? 0, s255 = Math.round(v * 255 / 100);
    if (id === 'fan' && (L.ctlObj || []).includes('fan')) return gc(`M106 S${s255}`);
    if ((L.ctlObj || []).includes(id) && /^fan_generic [\w-]+$/.test(id)) {
      const n = id.slice(12);
      return gc(L.kobra && KOBRA_FAN_P[n] ? `M106 P${KOBRA_FAN_P[n]} S${s255}` : `SET_FAN_SPEED FAN=${n} SPEED=${(v / 100).toFixed(2)}`);
    }
    fail('cmd');
  }
  const on = !!inp.on;
  if (id.startsWith('power:')) {
    const dev = id.slice(6);
    if (!/^[\w.-]+$/.test(dev) || !LIGHT_RE.test(dev)) fail('cmd');
    await mrPost(p, '/machine/device_power/device?' + qs({ device: dev, action: on ? 'on' : 'off' }), {}, 10000);
    L.pwrAt = 0; return;
  }
  if (!(L.ctlObj || []).includes(id)) fail('cmd');
  const n = id.slice(id.indexOf(' ') + 1), b = on ? 1 : 0;
  if (/^output_pin /.test(id)) return gc(`SET_PIN PIN=${n} VALUE=${b}`);
  return gc(`SET_LED LED=${n} RED=${b} GREEN=${b} BLUE=${b} WHITE=${b}`);
}

/** Bambu: Lüfter 0–15 (cooling_fan_speed, big_fan1_speed = Zusatz, big_fan2_speed = Kammer), Licht aus lights_report. */
function bbCtl(p, L, pr, busy) {
  const m = String(p.model || ''), open = /\bA1\b|A1 mini/i.test(m), p1p = /P1P/i.test(m);
  const ctl = ctlEmpty();
  if (busy) ctl.speed = spdMk(SPD, SPD[(+pr.spd_lvl || 0) - 1] || null, null);   // spd_lvl 1 leise … 4 Ludicrous
  ctl.fans.push({ id: 'p1', k: 'part', name: '', pct: pctOf(pr.cooling_fan_speed, 15), set: true });
  if (!open && !p1p) {
    ctl.fans.push({ id: 'p2', k: 'aux', name: '', pct: pctOf(pr.big_fan1_speed, 15), set: true });
    ctl.fans.push({ id: 'p3', k: 'chamber', name: '', pct: pctOf(pr.big_fan2_speed, 15), set: true });
  }
  const lr = Array.isArray(pr.lights_report) ? pr.lights_report : [], cl = lr.find(x => x && x.node === 'chamber_light');
  L.bbLights = lr.filter(x => x && /^chamber_light\d*$/.test(x.node || '')).map(x => x.node);
  if (cl && !open) ctl.lights.push({ id: 'chamber_light', k: 'chamber', name: '', on: cl.mode === 'on' ? true : cl.mode === 'off' ? false : null });
  return ctlOverlay(L, ctl);
}
/** Elegoo CC1 (SDCP): CurrentFanSpeed in Prozent, LightStatus.SecondLight 0/1. */
function sdCtl(p, L, S_, busy) {
  const f = S_.CurrentFanSpeed || {}, ls = S_.LightStatus, ctl = ctlEmpty();
  const sp = (S_.PrintInfo || {}).PrintSpeedPct;
  if (busy) ctl.speed = spdMk(SPD, spdOfPct(sp ?? 100), sp ?? 100);
  for (const [id, k] of [['ModelFan', 'part'], ['AuxiliaryFan', 'aux'], ['BoxFan', 'box']]) if (id in f) ctl.fans.push({ id, k, name: '', pct: pctOf(f[id], 100), set: true });
  if (ls && typeof ls === 'object' && 'SecondLight' in ls) ctl.lights.push({ id: 'SecondLight', k: 'chamber', name: '', on: !!+ls.SecondLight });
  L.sdRgb = ls && Array.isArray(ls.RgbLight) ? ls.RgbLight : [0, 0, 0];
  return ctlOverlay(L, ctl);
}
/** Elegoo CC2: fans.{fan, aux_fan, box_fan}.speed 0–255, led.status 0/1. */
function ccCtl(p, L, S_, busy) {
  const fs = S_.fans || {}, ctl = ctlEmpty(), sm = (S_.gcode_move_inf || {}).speed_mode;
  if (busy) ctl.speed = spdMk(SPD, sm == null ? null : SPD[+sm] || null, null);   // speed_mode 0 leise … 3 Ludicrous
  for (const [id, k] of [['fan', 'part'], ['aux_fan', 'aux'], ['box_fan', 'box']]) if (fs[id] && typeof fs[id] === 'object') ctl.fans.push({ id, k, name: '', pct: pctOf(fs[id].speed, 255), set: true });
  if (S_.led && typeof S_.led === 'object' && 'status' in S_.led) ctl.lights.push({ id: 'led', k: 'chamber', name: '', on: !!+S_.led.status });
  return ctlOverlay(L, ctl);
}
/** Creality OS: modelFanPct/caseFanPct/auxiliaryFanPct, Licht lightSw 0/1; geschaltet über M106 P0/P1/P2 bzw. lightSw. */
function crCtl(p, L, S, busy) {
  const ctl = ctlEmpty();
  if (busy && 'curFeedratePct' in S) ctl.speed = spdMk(SPD, spdOfPct(+S.curFeedratePct), +S.curFeedratePct);
  for (const [id, f, k] of [['p0', 'modelFanPct', 'part'], ['p1', 'caseFanPct', 'box'], ['p2', 'auxiliaryFanPct', 'aux']]) if (f in S) ctl.fans.push({ id, k, name: '', pct: pctOf(S[f], 100), set: true });
  if ('lightSw' in S) ctl.lights.push({ id: 'lightSw', k: 'chamber', name: '', on: !!+S.lightSw });
  return ctlOverlay(L, ctl);
}
/** Flashforge: Licht immer, Bauteil-/Kammerlüfter nur während eines Drucks, Filter (5M Pro) innen/außen an/aus. */
function ffCtl(p, L, d, busy) {
  const ctl = ctlEmpty(), pro = /5M Pro/i.test(p.model || '');
  L.ffD = d;   // Geschwindigkeit: printerCtl_cmd schickt alle Werte zusammen (ff-5mp-api Control.ts) → aktuelle mitgeben
  if (busy && 'printSpeedAdjust' in d) ctl.speed = spdMk(SPD, spdOfPct(+d.printSpeedAdjust), +d.printSpeedAdjust);
  if ('coolingFanSpeed' in d) ctl.fans.push({ id: 'coolingFan', k: 'part', name: '', pct: pctOf(d.coolingFanSpeed, 100), set: busy });
  if (pro && 'chamberFanSpeed' in d) ctl.fans.push({ id: 'chamberFan', k: 'chamber', name: '', pct: pctOf(d.chamberFanSpeed, 100), set: busy });
  if (pro) for (const [id, f, k] of [['internal', 'internalFanStatus', 'filter'], ['external', 'externalFanStatus', 'exhaust']])
    if (f in d) ctl.fans.push({ id, k, name: '', pct: String(d[f]) === 'open' ? 100 : 0, set: true, onoff: true });
  if ('lightStatus' in d) ctl.lights.push({ id: 'light', k: 'chamber', name: '', on: String(d.lightStatus) === 'open' });
  return ctlOverlay(L, ctl);
}
/** Anycubic LAN: Lichter aus der Antwort auf light/query (Typ 1 Kopf, 2 Kammer, 3 Kamera), Lüfter aus info/fan — einstellbar nur im Druck. */
const AC_LIGHT_K = { 1: 'head', 2: 'chamber', 3: 'camera' };
function acCtl(p, L, S, busy) {
  const ctl = ctlEmpty(), info = S.info || {}, fan = Object.assign({}, info, S.fan || {});
  // Geschwindigkeit 1 leise, 2 Standard, 3 Sport: im info-Bericht oben, nach print/update auch in print.settings (der neuere zählt)
  const prs = ((S.print || {}).settings || {}).print_speed_mode, ifs = info.print_speed_mode ?? ((info.project || {}).settings || {}).print_speed_mode;
  const sm = prs != null && (ifs == null || (S.print_at || 0) > (S.info_at || 0)) ? prs : ifs;
  L.acTask = busy ? acTaskOf(S) : null;
  if (busy) ctl.speed = spdMk(SPD.slice(0, 3), sm == null ? null : SPD[+sm - 1] || null, null);
  const enclosed = /Kobra S1/i.test(p.model || '');
  if ('fan_speed_pct' in fan) ctl.fans.push({ id: 'fan_speed_pct', k: 'part', name: '', pct: pctOf(fan.fan_speed_pct, 100), set: busy });
  if (enclosed && 'aux_fan_speed_pct' in fan) ctl.fans.push({ id: 'aux_fan_speed_pct', k: 'aux', name: '', pct: pctOf(fan.aux_fan_speed_pct, 100), set: busy });
  if (enclosed && 'box_fan_level' in fan) ctl.fans.push({ id: 'box_fan_level', k: 'box', name: '', pct: pctOf(fan.box_fan_level, 100), set: busy });
  const lt = S.light || {}, list = Array.isArray(lt.lights) ? lt.lights.filter(x => x && AC_LIGHT_K[+x.type]) : [];
  // Antwort auf einen Schaltbefehl kommt als nacktes Licht {type, status} (anycubic_ha_local models.py) und ist dann der neueste Stand
  const bare = S.light_action === 'control' && AC_LIGHT_K[+lt.type] && lt.status != null ? lt : null;
  for (const x of list) {
    const now_ = bare && +bare.type === +x.type ? bare : x;
    ctl.lights.push({ id: 'l' + (+x.type), k: AC_LIGHT_K[+x.type], name: '', on: now_.status == null ? null : +now_.status === 1 });
  }
  return ctlOverlay(L, ctl);
}

/** Druckgeschwindigkeit wählen (printer_cmd speed, lv = silent|std|sport|ludi) — nur während eines Drucks und nur angebotene Stufen. */
async function spdSet(p, L, inp) {
  const sp = (L.entry || {}).ctl ? L.entry.ctl.speed : null, lv = String(inp.lv || ''), kind = kindOf(p);
  if (!sp) fail('print_only');
  if (!sp.lv.includes(lv)) fail('cmd');
  const i = SPD.indexOf(lv), pct = SPD_PCT[lv], seq = () => String(Date.now() % 100000);
  if (kind === 'moonraker') await mrPost(p, '/printer/gcode/script', { script: `M220 S${pct}` }, 10000);
  else if (kind === 'bambu') await native('live_send', { key: 'bb_' + p.id, payload: JSON.stringify({ print: { sequence_id: seq(), command: 'print_speed', param: String(i + 1) } }) });
  else if (kind === 'sdcp') await sdSend(p, 403, { PrintSpeedPct: pct });
  else if (kind === 'cc2') await ccSend(p, 1031, { mode: i });
  else if (kind === 'creality') await crSet(p, { setFeedratePct: pct });
  else if (kind === 'flashforge') {
    const d = L.ffD || {}, n = (v, z) => Number.isFinite(+v) ? +v : z;
    await ffPost(p, '/control', { payload: { cmd: 'printerCtl_cmd', args: { zAxisCompensation: n(d.zAxisCompensation, 0), speed: pct, chamberFan: n(d.chamberFanSpeed, 0), coolingFan: n(d.coolingFanSpeed, 0), coolingLeftFan: 0 } } });
  } else if (kind === 'acl') {
    await acSend(p, 'print', 'update', { taskid: L.acTask || '-1', settings: { print_speed_mode: i + 1 } });
    setTimeout(() => acSend(p, 'info', 'query').catch(() => {}), 1500);
  } else fail('cmd');
  (L.ctlWant || (L.ctlWant = {})).s = { v: lv, at: Date.now() };
  if (L.entry && L.entry.ctl) ctlOverlay(L, L.entry.ctl);
  return { ok: true };
}

/** Lüfter bzw. Licht schalten (printer_cmd fan/light). */
async function ctlSet(p, inp) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  if (inp.cmd === 'speed') return spdSet(p, L, inp);
  const id = String(inp.id || '').slice(0, 80), kind = kindOf(p), fan = inp.cmd === 'fan';
  const v = int(inp.pct, 0, 100) ?? 0, on = !!inp.on, seq = () => String(Date.now() % 100000);
  const known = (((L.entry || {}).ctl || {})[fan ? 'fans' : 'lights'] || []).find(x => x.id === id);
  if (kind !== 'moonraker' && !known) fail('cmd');
  if (known && known.set === false) fail('print_only');
  if (kind === 'moonraker') await mrCtlSet(p, L, inp, id);
  else if (kind === 'bambu') {
    const payload = fan ? { print: { sequence_id: seq(), command: 'gcode_line', param: `M106 P${id.slice(1)} S${Math.round(v * 255 / 100)}\n` } } : null;
    if (fan) await native('live_send', { key: 'bb_' + p.id, payload: JSON.stringify(payload) });
    else for (const node of (L.bbLights && L.bbLights.length ? L.bbLights : ['chamber_light']))
      await native('live_send', { key: 'bb_' + p.id, payload: JSON.stringify({ system: { sequence_id: seq(), command: 'ledctrl', led_node: node, led_mode: on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } }) });
  } else if (kind === 'sdcp') {
    if (fan) await sdSend(p, 403, { TargetFanSpeed: { [id]: v } });
    // Nur bei Änderung schicken (elegoo-homeassistant: schon an → nichts senden, sonst schaltet manche Firmware um)
    else if (known.on !== on) await sdSend(p, 403, { LightStatus: { SecondLight: on ? 1 : 0, RgbLight: L.sdRgb || [0, 0, 0] } });
  } else if (kind === 'cc2') {
    if (fan) await ccSend(p, 1030, { [id]: Math.round(v * 255 / 100) });
    else await ccSend(p, 1029, { power: on ? 1 : 0, brightness: on ? 255 : 0 });
  } else if (kind === 'creality') {
    if (fan) await crSet(p, { gcodeCmd: `M106 P${id.slice(1)} S${Math.round(v * 255 / 100)}` });
    else await crSet(p, { lightSw: on ? 1 : 0 });
  } else if (kind === 'flashforge') {
    const args = !fan ? { cmd: 'lightControl_cmd', args: { status: on ? 'open' : 'close' } }
      : known.onoff ? { cmd: 'circulateCtl_cmd', args: { [id]: v > 0 ? 'open' : 'close' } }
      : { cmd: 'printerCtl_cmd', args: { [id]: v } };
    await ffPost(p, '/control', { payload: args });
  } else if (kind === 'acl') {
    if (fan) { await acSend(p, 'print', 'update', { taskid: L.acTask || '-1', settings: { [id]: v } }); setTimeout(() => acSend(p, 'fan', 'query').catch(() => {}), 1500); }
    else { const tp = +id.slice(1); await acSend(p, 'light', 'control', { type: tp, status: on ? 1 : 0, brightness: on ? 100 : 0 }); setTimeout(() => acSend(p, 'light', 'query').catch(() => {}), 1500); }
  } else fail('cmd');
  (L.ctlWant || (L.ctlWant = {}))[(fan ? 'f:' : 'l:') + id] = { v: fan ? (known && known.onoff ? (v > 0 ? 100 : 0) : v) : on, at: Date.now() };
  if (L.entry && L.entry.ctl) ctlOverlay(L, L.entry.ctl);
  return { ok: true };
}

// ── Hersteller-Konten im Agenten (19.11.2026, User: „bau es ein für alle Drucker, nur lesend, nicht druckend“) ────────────────
// Dieselben Clouds wie 3DSEARCH /filament (Bambu, Anycubic, Creality, Elegoo, Prusa Connect), aber vom Agenten beim Nutzer aus:
// jedes Konto nur für sich, vom eigenen Anschluss, keine Sammel-IP (Bambu sperrte am 10.11. die eine Server-IP für 94 Konten).
// NUR LESEN: Status, Fächer, Abbuchung am Druckende, Benachrichtigungen — nie Befehle, nie Druckaufträge (printSend/printer_cmd
// lehnen kind 'cloud' ab). Anbieter in eigenen Dateien web/js/cloud-<prov>.js (nur der Agent lädt sie, runtime.js) über
// AMP_CLOUD_REG; ohne geladene Anbieter (Android-App) gibt es den Weg nicht. Drucker: kind 'cloud', p.prov, p.cloud = Konto, p.dev.
// Konten in db.clouds [{id, prov, user, uid, acc (Zugang, nur hier), added_at, err ('auth' = neu anmelden), jobs_at}].
const CLOUD = {};
window.AMP_CLOUD_REG = (prov, def) => { CLOUD[prov] = Object.assign({ prov, every: 30000, jobsEvery: 300000, devEvery: 3600e3 }, def); };
const cloudAcc = id => (db.clouds || []).find(a => a.id === id) || null;
const cloudErr = (code, msg) => { const e = new Error(code); if (msg) e.msg = String(msg).slice(0, 200); return e; };
/** Hilfen für die Anbieter (eine Schnittstelle, damit cloud-*.js nichts aus backend.js kennen muss). */
const CH = {
  async http(o) {
    const hdr = Object.assign({ Accept: 'application/json', 'User-Agent': 'AllMyPrinters-Agent' },
      o.body !== undefined && typeof o.body !== 'string' ? { 'Content-Type': 'application/json' } : {}, o.headers || {});
    const r = await native('http', { url: o.url, method: o.method || 'GET', headers: hdr, timeout: o.timeout || 15000,
      body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body) });
    let json = null; try { json = JSON.parse(r.text || ''); } catch (e) {}
    return { status: r.status || 0, json, text: r.text || '', hdr: r.hdr || {} };
  },
  live_open: a => native('live_open', a),
  live_state: key => native('live_state', { key }),
  live_close: key => native('live_close', { key }).catch(() => {}),
  bbSlots: pr => bbSlots(pr),
  err: cloudErr,
  // Testumgebung: Adressen der Anbieter umbiegen (localStorage amp_cloud_<prov>), die App selbst nie
  base: (prov, def) => { try { return localStorage.getItem('amp_cloud_' + prov) || def; } catch (e) { return def; } },
  hex: v => { const m = /^#?([0-9a-f]{6})/i.exec(String(v || '')); return m ? '#' + m[1].toLowerCase() : null; },
  diag: (prov, d) => diag({ a: 'cloud', p: prov, err: d.err || '', d: d.d || '' }),
};
const clJobsBusy = {}, clDevBusy = {};

async function cloudSync(p, force) {
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const entry = baseEntry(p, 'cloud');
  entry.agent.cloud = 'cl_' + p.prov; entry.ro = true; entry.cam = false; entry.cam_ok = false; entry.host = '';
  const acc = cloudAcc(p.cloud), P = CLOUD[p.prov];
  if (!acc || !P) { entry.amp_err = 'cloud_gone'; finish(p, entry, L); return entry; }
  if (acc.err === 'auth' || !acc.acc) { entry.amp_err = 'cloud_login'; finish(p, entry, L); return entry; }
  cloudDevTick(acc);
  let st = L.cl && Date.now() - (L.clAt || 0) < (force ? Math.min(P.every, 5000) : P.every) ? L.cl : null;
  if (!st) {
    const before = JSON.stringify(acc.acc);
    try { st = await P.status(CH, acc.acc, p.dev, L); L.cl = st; L.clAt = Date.now(); if (JSON.stringify(acc.acc) !== before) persist(true); }
    catch (e) {
      if (e.message === 'auth') { acc.err = 'auth'; persist(); entry.amp_err = 'cloud_login'; }
      else { entry.amp_err = 'unreach'; entry.amp_detail = (e.msg || e.message || '').slice(0, 160); }
      finish(p, entry, L); return entry;
    }
  }
  cloudJobsTick(acc);
  if (!st || !st.online) { entry.amp_err = 'cloud_off'; finish(p, entry, L); return entry; }
  entry.online = true; entry.agent.klippy = 'ready';
  entry.busy = st.state === 'printing' || st.state === 'paused';
  entry.temps = st.temps || null;
  entry.stats = { prints: null, hours: null, fw: st.fw || null };
  for (const x of st.slots || []) {
    const sl = slotRow(p.id, x.index);
    entry.slots.push({ slot_id: sl.id, index: x.index, label: x.label, material: x.material || null, color: x.color || null, sku: x.sku || null,
                       remain_pct: x.remain_pct ?? null, spool_id: sl.spool_id, pending_g: Math.round(sl.pending_g || 0), locked: false, inuse: !!(entry.busy && x.inuse) });
  }
  if (!entry.slots.length) singleSlot(p, entry);
  entry.boxes = (st.boxes || []).map(b => ({ ...b, control: false }));
  entry.ttg_map = entry.slots.map(x => x.index);
  if (entry.busy) {
    entry.job = jobEntry(L, { state: st.state, file: st.file || '', prog: st.prog || 0 }, st.remain_s || 0, st.layer || null);
    if (st.img) entry.job.img = st.img;
    // Fortschritt merken: bricht der Druck ab, bucht cloudApplyJobs anteilig (die Clouds melden für Abbrüche nur das geplante Gewicht)
    L.clObs = { file: st.file || '', prog: Math.max(st.prog || 0, L.clObs && L.clObs.file === st.file ? L.clObs.prog : 0), at: Date.now() };
  }
  finish(p, entry, L);
  return entry;
}
/** Geräteliste des Kontos höchstens stündlich (Namen, neu hinzugekommene Drucker für „Drucker wählen“). */
function cloudDevTick(acc, force) {
  const P = CLOUD[acc.prov]; if (!P || !P.devices || clDevBusy[acc.id]) return;
  if (!force && Date.now() - (acc.devs_at || 0) < P.devEvery) return;
  clDevBusy[acc.id] = true; acc.devs_at = Date.now();
  P.devices(CH, acc.acc).then(list => {
    acc.devs = (list || []).slice(0, 40).map(d => ({ dev: String(d.dev), name: String(d.name || '').slice(0, 60), model: d.model || null }));
    for (const p of db.printers) if (p.kind === 'cloud' && p.cloud === acc.id) { const d = acc.devs.find(x => x.dev === String(p.dev)); if (d && d.model && !p.model) p.model = d.model; }
    persist();
  }).catch(e => { if (e.message === 'auth') { acc.err = 'auth'; persist(); } }).finally(() => { clDevBusy[acc.id] = false; });
}
/** Aufträge des Kontos (alle Drucker in einer Liste) höchstens alle P.jobsEvery holen und buchen. */
function cloudJobsTick(acc, force) {
  const P = CLOUD[acc.prov]; if (!P || !P.jobs || acc.err === 'auth' || clJobsBusy[acc.id]) return null;
  if (!force && Date.now() - (acc.jobs_at || 0) < P.jobsEvery) return null;
  clJobsBusy[acc.id] = true; acc.jobs_at = Date.now();
  const before = JSON.stringify(acc.acc);   // erneuerter Zugang (Elegoo/Prusa tauschen das Erneuerungs-Token) → sofort sichern
  return P.jobs(CH, acc.acc).then(list => { if (JSON.stringify(acc.acc) !== before) persist(true); cloudApplyJobs(acc, list || []); })
    .catch(e => { if (e.message === 'auth') { acc.err = 'auth'; persist(); } else diag({ a: 'cloud_jobs', p: acc.prov, err: e.message, d: e.msg || '' }); })
    .finally(() => { clJobsBusy[acc.id] = false; });
}
/**
 * Aufträge der Cloud → Moonraker-Form für applyHistory, Gramm je Fach fertig zugeordnet (parts). Abgebrochen: anteilig nach dem
 * zuletzt gesehenen Fortschritt, wenn der Druck um diese Zeit lief — sonst nichts (lieber nicht buchen als zu viel).
 */
function cloudApplyJobs(acc, list) {
  for (const p of db.printers.filter(x => x.kind === 'cloud' && x.cloud === acc.id)) {
    const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
    const mine = list.filter(j => String(j.dev) === String(p.dev)).sort((a, b) => (b.start || 0) - (a.start || 0)).slice(0, 60);
    if (!mine.length) continue;
    const obs = L.clObs, have = new Set(db.slots.filter(s => s.printer_id === p.id).map(s => s.index));
    // zweite externe Spule (101) gibt es nur bei zwei Düsen; sonst ist es die eine externe Spule (100)
    for (const j of mine) for (const x of j.parts || []) if (+x.slot === 101 && !have.has(101) && have.has(100)) x.slot = 100;
    applyHistory(p, L, mine.map(j => {
      let prog = j.prog ?? null;
      if (prog === null && j.status === 3 && obs && j.end && Math.abs(obs.at / 1000 - j.end) < 900) prog = obs.prog;
      return { job_id: 'cl' + j.id, filename: j.title || '', status: j.status === 2 ? 'completed' : j.status === 1 ? 'in_progress' : 'cancelled',
               start_time: j.start || 0, end_time: j.end || null, print_duration: j.secs || 0, filament_used: 0, metadata: {},
               parts: (j.parts || []).map(x => ({ slot: +x.slot, g: +x.g || 0, color: x.color || null, material: x.material || null })), prog };
    }));
  }
}

/** Drucker im Konto, mit „schon hinzugefügt“. */
async function cloudDevices(acc) {
  const P = CLOUD[acc.prov] || fail('prov');
  let list;
  try { list = await P.devices(CH, acc.acc); }
  catch (e) { if (e.message === 'auth') { acc.err = 'auth'; persist(); } const er = new Error(e.message || 'cloud'); er.msg = e.msg || ''; throw er; }
  acc.devs = (list || []).slice(0, 40).map(d => ({ dev: String(d.dev), name: String(d.name || '').slice(0, 60), model: d.model || null })); acc.devs_at = Date.now();
  return (list || []).slice(0, 40).map(d => ({ dev: String(d.dev), name: String(d.name || d.dev).slice(0, 60), model: d.model || null, online: d.online ?? null,
    added: db.printers.some(p => p.kind === 'cloud' && p.prov === acc.prov && String(p.dev) === String(d.dev)) }));
}
const DRV = {
  cloud: { sync: (p, f) => cloudSync(p, f) },
  acl: { sync: (p, f) => acSync(p, f) },
  creality: { sync: (p, f) => crSync(p, f) },
  flashforge: { sync: (p, f) => ffSync(p, f) },
  cc2: { sync: (p, f) => ccSync(p, f) },
  sdcp: { sync: (p, f) => sdSync(p, f) },
  moonraker: { sync: (p, f) => mrSync(p, f) },
  octoprint: { sync: (p, f) => opSync(p, f) },
  prusalink: { sync: (p, f) => plSync(p, f) },
  bambu: { sync: (p, f) => bbSync(p, f) },
};

// Drucker mit Dauerverbindung (MQTT/WebSocket in Live.kt): nach App-Start oder nach 90 s ohne Abfrage baut sich die Verbindung
// erst auf — dann kurz warten statt sofort „nicht erreichbar“ zu zeigen; kurze Aussetzer überbrückt der letzte gute Stand.
// Protokoll für „Problem melden“: nur Fehlerart, Treiber, Modell, Schritt — nie Zugangscodes, Passwörter, Schlüssel, Dateien
const DIAG = (() => { try { return JSON.parse(localStorage.getItem('amp_diag') || '[]').slice(-80); } catch (e) { return []; } })();
function diag(ev) {
  const last = DIAG[DIAG.length - 1], e = { t: new Date().toISOString().slice(0, 19) + 'Z', ...ev };
  if (e.d) e.d = String(e.d).replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>').slice(0, 160);   // Java-/Node-Meldungen nennen Heimnetz-Adressen
  if (last && last.a === e.a && last.p === e.p && last.err === e.err && Date.now() - Date.parse(last.t) < 120000) { last.n = (last.n || 1) + 1; }
  else { DIAG.push(e); if (DIAG.length > 80) DIAG.shift(); }
  try { localStorage.setItem('amp_diag', JSON.stringify(DIAG)); } catch (er) {}
}
const LIVE_KINDS = ['bambu', 'sdcp', 'cc2', 'creality', 'acl'];
const GRACE_MS = 45000;

// ── Neue IP-Adresse (10.11.2026, User: „was passiert, wenn sich die IP des Druckers ändert?“) ─────────────────
// Bisher: „nicht erreichbar“ für immer, nur Löschen + neu anlegen (Fachzuordnung, Profil, Foto, Codes weg). Jetzt:
// 1. Wiederfinden: ist ein Drucker ≥ 90 s weg, sucht die App im WLAN (höchstens alle 3 Min) nach DEMSELBEN Gerät — Seriennummer
//    (Anycubic LAN, Bambu, Elegoo CC2, Flashforge), Mainboard-ID (Elegoo CC1), MAC (Creality), Rechnername + Port (Klipper).
//    Nur bei genau einem Treffer, der keinem anderen eingetragenen Drucker gehört (Klipper heißen oft gleich, z. B. „mainsailos“).
// 2. Von Hand: „Adresse ändern“ (amp_set_host), für alle Arten — OctoPrint/PrusaLink haben keine eindeutige Kennung.
function ampIdentOf(kind, o) {
  if (['acl', 'bambu', 'cc2', 'flashforge'].includes(kind)) return o.serial ? kind + ':' + String(o.serial).toLowerCase() : null;
  if (kind === 'sdcp') return o.mainboard ? 'sdcp:' + o.mainboard : null;
  if (kind === 'creality') return o.mac ? 'creality:' + String(o.mac).toLowerCase() : null;
  if (kind === 'moonraker') return o.mrhost && o.mrhost !== 'localhost' ? 'moonraker:' + o.mrhost + ':' + (o.port || 7125) : null;
  return null;
}
const ampIdent = p => ampIdentOf(kindOf(p), p);
/** Drucker auf eine neue Adresse umziehen: Dauerverbindung zu, Adresse rein, alles andere (Fächer, Profil, Foto, Codes) bleibt. */
async function ampMove(p, host, port, how) {
  const L = LIVE_SEND[kindOf(p)] ? LIVE_SEND[kindOf(p)](p) : null;
  if (L) await native('live_close', { key: L.key }).catch(() => {});
  const old = p.main ? p.main.host : p.host;
  // Mit zweiter Adresse zieht immer die erste um (Wiederfinden sucht nur im Heimnetz, „Adresse ändern“ meint die erste)
  if (p.alt) { const mp = port || (p.main && p.main.port) || p.port; p.main = { host, port: mp }; p.on_alt = false; port = mp; }
  p.host = host;
  if (port) p.port = port;
  // letzter guter Stand gehört zur alten Adresse → nicht als Überbrückung (GRACE_MS) weiterzeigen
  const lv = live[p.id]; if (lv) { lv.downSince = 0; lv.cams = null; lv.diagErr = ''; lv.good = null; lv.goodAt = 0; }
  persist();
  diag({ a: 'relocate', p: kindOf(p), m: p.model || '', err: '', d: how });
  if (window.AMP_ev) window.AMP_ev('relocated', { id: p.id, name: p.name, host, old, how });
}

// ── Zweite Adresse (10.11.2026, Donnie: denselben U1 zweimal eingetragen — zu Hause per IP, unterwegs per Tailscale) ──
// p.host/p.port = Adresse, die gerade benutzt wird. Mit zweiter Adresse zusätzlich p.main + p.alt ({host, port}) und p.on_alt.
// Antwortet die benutzte nicht, probiert die App die andere (höchstens alle 30 s). Läuft sie über die zweite, schaut sie alle
// 2 Min, ob die erste wieder antwortet (zurück im Heim-WLAN → direkt statt über das VPN). Ein Eintrag = jeder Druck nur
// einmal gebucht (zwei Einträge für denselben Drucker buchten jeden Druck doppelt, sobald beide erreichbar waren).
const addrOf = p => ({ host: p.host, port: p.port });
const hostsOf = p => [p.main || addrOf(p), p.alt].filter(Boolean);
const ALT_RETRY_MS = 30000, ALT_BACK_MS = 120000;
// Testumgebung verkürzt die Wartezeiten (localStorage amp_alt_ms), die App selbst nie
const altWait = ms => { try { return +localStorage.getItem('amp_alt_ms') || ms; } catch (e) { return ms; } };
/** Antwortet unter Adresse a derselbe Drucker? Klipper: Rechnername wie bekannt; sonst reicht der offene Hauptport. */
const drvPort = (p, a) => kindOf(p) === 'moonraker' ? (a.port || p.port || 7125)
  : ({ bambu: bbPort(p, 'mqtt', 8883), sdcp: sdPort(p, 'ws', 3030), cc2: ccPort(p, 'mqtt', 1883), flashforge: (p.ports && p.ports.http) || 8898 }[kindOf(p)] || a.port || p.port || 80);
const NET_BLOCKED = ['EACCES', 'EPERM'];
/** Windows-Sicherheitscenter → wer sperrt wahrscheinlich: aktives VPN vor fremder Firewall vor fremdem Virenschutz, sonst die
 *  Windows-Firewall selbst; dazu Netze, die Windows als „Öffentlich“ führt */
function secGuess(s) {
  if (!s) return null;
  const own = n => /windows defender|microsoft defender/i.test(n);
  const fw = (s.fw || []).filter(n => !own(n)), av = (s.av || []).filter(n => !own(n));
  const who = (s.vpn || [])[0] ? { kind: 'vpn', name: s.vpn[0] } : fw[0] ? { kind: 'fw', name: fw[0] } : av[0] ? { kind: 'av', name: av[0] } : { kind: 'win', name: '' };
  return { ...who, pub: (s.pub || []).slice(0, 2), all: [...new Set([...(s.vpn || []), ...fw, ...av])].slice(0, 4) };
}
async function addrAnswers(p, a) {
  const k = kindOf(p);
  if (k === 'moonraker') {
    try { const pi = await mrGet({ host: a.host, port: a.port || 7125, key: p.key }, '/printer/info', 2500); return !p.mrhost || !pi.hostname || pi.hostname === p.mrhost; }
    catch (e) { return false; }
  }
  const port = drvPort(p, a);
  const o = await native('tcpcheck', { host: a.host, port, timeout: 2000 }).catch(() => ({}));
  return !!o.open;
}
/** Auf die andere Adresse wechseln: Dauerverbindung zu, Kamera und letzter Stand gehören zur alten Adresse. */
async function ampSwitch(p, a, onAlt) {
  const L = LIVE_SEND[kindOf(p)] ? LIVE_SEND[kindOf(p)](p) : null;
  if (L) await native('live_close', { key: L.key }).catch(() => {});
  p.host = a.host; if (a.port) p.port = a.port; p.on_alt = !!onAlt;
  const lv = live[p.id]; if (lv) { lv.downSince = 0; lv.cams = null; lv.diagErr = ''; lv.good = null; lv.goodAt = 0; }
  persist();
  diag({ a: 'addr', p: kindOf(p), m: p.model || '', d: onAlt ? 'alt' : 'main' });
}
let relocAt = 0, relocBusy = false;
// Testumgebung verkürzt die Wartezeiten (localStorage amp_reloc_ms), die App selbst nie
const relocMs = () => { try { return +localStorage.getItem('amp_reloc_ms') || 0; } catch (e) { return 0; } };
async function relocateLost() {
  if (relocBusy || Date.now() - relocAt < (relocMs() || 180000)) return;
  const lost0 = db.printers.filter(p => { const L = live[p.id]; return L && L.downSince && Date.now() - L.downSince > (relocMs() || 90000) && ampIdent(p); });
  if (!lost0.length) return;
  relocBusy = true; relocAt = Date.now();
  try {
    // Nur im eigenen Netz suchen: Handy und alte Druckeradresse im selben /24 (anderes WLAN, z. B. Arbeit → nicht durchsuchen;
    // Drucker per Name statt IP eingetragen → ändert sich nicht)
    const n = await native('net').catch(() => ({}));
    const pre = ip => (String(ip || '').match(/^(\d+\.\d+\.\d+)\.\d+$/) || [])[1];
    const lost = lost0.filter(p => pre(p.host) && pre(p.host) === pre(n.ip));
    if (!lost.length) return;
    const { hosts } = await A.amp_scan();
    for (const p of lost) {
      const id = ampIdent(p), k = kindOf(p);
      const hit = (hosts || []).filter(d => (['octoprint', 'prusalink', 'bambu', 'sdcp', 'cc2', 'creality', 'flashforge', 'acl'].includes(d.kind) ? d.kind : 'moonraker') === k
        && ampIdentOf(k, d) === id && !hostsOf(p).some(h => h.host === d.host)
        && !db.printers.some(o => o.id !== p.id && hostsOf(o).some(h => h.host === d.host && (h.port || 7125) === (d.port || 7125))));
      if (hit.length === 1) await ampMove(p, hit[0].host, k === 'moonraker' ? hit[0].port : null, 'auto');
    }
  } finally { relocBusy = false; }
}

async function syncOne(p, force) {
  const drv = DRV[kindOf(p)] || DRV.moonraker;
  const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
  const run = () => drv.sync(p, force).catch(e => { console.error(e); return L.entry ? { ...L.entry, online: false, amp_err: 'unreach' } : { id: p.id, name: p.name, online: false, amp_err: 'unreach', slots: [], boxes: [], orphans: [] }; });
  const settle = async () => {
    let e = await run();
    if (!e.online && e.amp_err === 'unreach') {
      if (!L.downSince) L.downSince = Date.now();
      // gerade erst (wieder) verbunden: bis 5 s auf die ersten Daten warten
      if (LIVE_KINDS.includes(kindOf(p)) && Date.now() - L.downSince < 8000) {
        for (let i = 0; i < 10 && !e.online; i++) { await new Promise(z => setTimeout(z, 500)); e = await run(); }
      }
    }
    return e;
  };
  let e = await settle();
  // Zweite Adresse: die benutzte antwortet nicht → die andere probieren; über die zweite verbunden → ab und zu die erste
  // Nur eine Prüfung je Drucker gleichzeitig (Druckerseite und „Jetzt abfragen“ laufen parallel); Richtung vorher festhalten —
  // sonst schaltete die zweite Abfrage mit !p.on_alt die Kennung zurück, während sie schon auf der zweiten Adresse war
  if (p.alt && p.main && !L.altBusy && !e.online && e.amp_err === 'unreach' && Date.now() - (L.altAt || 0) > altWait(ALT_RETRY_MS)) {
    L.altAt = Date.now(); L.altBusy = true;
    try {
      const toAlt = !p.on_alt, other = toAlt ? p.alt : p.main;
      if (await addrAnswers(p, other) && !!p.on_alt !== toAlt) { await ampSwitch(p, other, toAlt); e = await settle(); }
    } finally { L.altBusy = false; }
  } else if (p.alt && p.main && !L.altBusy && p.on_alt && e.online && Date.now() - (L.mainAt || 0) > altWait(ALT_BACK_MS)) {
    L.mainAt = Date.now(); L.altBusy = true;
    try {
      if (await addrAnswers(p, p.main) && p.on_alt) { await ampSwitch(p, p.main, false); e = await settle(); }
    } finally { L.altBusy = false; }
  }
  if (e.online && kindOf(p) === 'creality' && !p.mac && !L.macTried) {
    L.macTried = true;
    crInfo(p.host, 80).then(c => { if (c && c.mac) { p.mac = c.mac; persist(); } }).catch(() => {});
  }
  // Nicht erreichbar: lässt das Betriebssystem die Verbindung überhaupt raus? EACCES/EPERM = Firewall, Virenschutz oder VPN
  // auf dem Rechner mit dem Agenten (19.11.2026: Windows-Laptop, Kobra S1 „Handshake: connect EACCES“). Höchstens einmal je Minute.
  if (!e.online && e.amp_err === 'unreach' && p.host) {
    if (!L.blkAt || Date.now() - L.blkAt > 60000) {
      L.blkAt = Date.now();
      const o = await native('tcpcheck', { host: p.host, port: drvPort(p, p), timeout: 2000 }).catch(() => ({}));
      L.blk = NET_BLOCKED.includes(o.code) ? { code: o.code, win: o.os === 'win32' } : null;
      if (L.blk && L.blk.win) L.blk.sec = secGuess(await native('secinfo').catch(() => null));
    }
    if (L.blk) e = { ...e, amp_block: L.blk.code, amp_block_win: L.blk.win, amp_block_sec: L.blk.sec || null };
  } else if (e.online) { L.blk = null; L.blkAt = 0; }
  if (!e.online && e.amp_err === 'unreach' && !e.amp_block) relocateLost().catch(() => {});   // neue IP? → im Hintergrund suchen (gesperrt: sinnlos)
  if (e.online) { if (L.diagErr) { diag({ a: 'sync_ok', p: kindOf(p), m: p.model || '' }); L.diagErr = ''; } L.downSince = 0; L.good = e; L.goodAt = Date.now(); return e; }
  if (L.diagErr !== e.amp_err) { L.diagErr = e.amp_err || 'off'; diag({ a: 'sync', p: kindOf(p), m: p.model || '', err: e.amp_err || 'off', d: (e.amp_block ? 'OS blockiert (' + e.amp_block + (e.amp_block_sec ? ', ' + e.amp_block_sec.kind + ': ' + (e.amp_block_sec.all.join(', ') || 'Windows-Firewall') + (e.amp_block_sec.pub.length ? ', öffentlich' : '') : '') + ') · ' : '') + (e.amp_detail || '') }); }
  // kurzer Aussetzer (Neuverbindung, eine verlorene Antwort): letzten guten Stand zeigen
  if (e.amp_err === 'unreach' && L.good && Date.now() - L.goodAt < GRACE_MS) return { ...L.good, stale: true };
  return e;
}
async function printers(inp) {
  const res = await Promise.all(db.printers.map(p => syncOne(p, !!inp.force)));
  persist();
  await jtLoad();
  for (const e of res) if (e && e.job && !e.job.img) { const img = jtGet(e.id, e.job.name || e.job.title); if (img) { e.job.img = img; e.job.img_render = true; } }
  const sp = await spools();
  // Einrichtung Schritt 4 „Erster Druck abgebucht“: nur eine echte Buchung auf eine Spule (wie /filament fmp_onboard). Vorher zählte
  // jeder Auftrag 'booked' — auch Verbrauch, der in einem Fach ohne Spule nur wartet (Tester António 21.11.2026: abgehakt ohne Spule)
  const booked = db.usage.some(isPrintUse);
  return {
    connections: db.printers.length ? [{ provider: 'moonraker', last_sync_at: now(), error: null, printers: res }] : [],
    spools: sp, onboard: { hidden: !!db.settings.onboard_hidden, booked }, unbooked: null, maint: mtTasks().filter(x => x.state !== 'ok'), consent_missing: [], consent_cc: {},
  };
}

// ── Wartung je Drucker (20.11.2026, wie 3DSEARCH printer_maint_lib.php) ──────────────────────────────────────────────
// Eine Aufgabe („Düse prüfen“) wird fällig nach X Druckstunden, X kg, X Drucken oder X Tagen seit dem letzten Erledigen —
// was zuerst eintritt. Gezählt wird aus dem Druckverlauf (db.jobs, fertig + abgebrochen, die Maschine lief), nichts extra.
// db.maint = [{id, printer_id, title, every_hours, every_grams, every_prints, every_days, last_done_at, created_at}],
// db.maint_log = [{id, task_id, at, hours, grams, prints, note}]. Die Oberfläche (#maint) ist die von /filament (viewMaint).
// „maint“ in printers() (nur bald/fällig) zeigt den Hinweis auf der Druckerkarte und löst im Agenten die Benachrichtigung aus.
const MT_SOON = 0.85;
const mtList = () => (db.maint = db.maint || []);
const mtLog = () => (db.maint_log = db.maint_log || []);
/** Laufzeit eines Drucks in Sekunden wie runCost: Start bis Ende, sonst reine Druckzeit; über 3 Tage unplausibel → 0. */
const jobSecs = j => { let s = j.start && j.end ? (ts(j.end) - ts(j.start)) / 1000 : 0; if (!(s > 0) || s > 3 * 86400) s = +j.print_s || 0; return s > 0 && s <= 3 * 86400 ? s : 0; };
function mtUsage(pid, since) {
  const t0 = ts(since);
  let secs = 0, g = 0, n = 0;
  for (const j of db.jobs) {
    if (j.printer_id !== pid || (j.status !== 2 && j.status !== 3) || ts(j.end || j.start) <= t0) continue;
    n++; secs += jobSecs(j);
    const gg = j.grams_real ?? j.grams; if (gg > 0) g += +gg;
  }
  return { hours: Math.round(secs / 360) / 10, grams: Math.round(g), prints: n, days: Math.max(0, Math.floor((Date.now() - t0) / 864e5)) };
}
function mtOut(x) {
  const used = mtUsage(x.printer_id, x.last_done_at);
  const every = { hours: x.every_hours ?? null, grams: x.every_grams ?? null, prints: x.every_prints ?? null, days: x.every_days ?? null };
  let ratio = 0, by = null;
  for (const k of ['hours', 'grams', 'prints', 'days']) { if (!every[k]) continue; const r = used[k] / every[k]; if (by === null || r > ratio) { ratio = r; by = k; } }
  return { id: x.id, provider: 'moonraker', pid: String(x.printer_id), title: x.title, every, last_done_at: x.last_done_at, used, ratio: Math.round(ratio * 1000) / 1000, by,
           state: ratio >= 1 ? 'due' : ratio >= MT_SOON ? 'soon' : 'ok' };
}
const mtTasks = () => mtList().map(mtOut);
/** Gesamte Druckstunden laut Verlauf (für den Kopf der Wartungskarte, falls der Drucker selbst keine meldet). */
const mtHours = pid => Math.round(db.jobs.filter(j => j.printer_id === pid && (j.status === 2 || j.status === 3)).reduce((a, j) => a + jobSecs(j), 0) / 3600);
const mtDay = v => {   // „zuletzt erledigt am“ (JJJJ-MM-TT, Mittag Ortszeit) — Zukunft und älter als 5 Jahre nicht
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return null;
  const d = new Date(v + 'T12:00:00'); if (isNaN(d)) return null;
  const t = d.getTime(); if (t > Date.now() + 864e5 || t < Date.now() - 5 * 365 * 864e5) return null;
  return new Date(Math.min(t, Date.now())).toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * Betriebskosten eines Drucks (15.11.2026, wie 3DSEARCH printer_maint_lib.php pm_run_cost): Strompreis + Verschleiß je Stunde aus
 * db.settings.costs {kwh, wear_h}, Leistung je Drucker p.power_w (Einstellungen → Druckkosten). Laufzeit = Start bis Ende (mit
 * Aufheizen), ohne beides die reine Druckzeit; über 3 Tage unplausibel → null. Rückgabe null oder {kwh, energy, wear, total}.
 */
function runCost(j) {
  const c = db.settings.costs || {}, p = db.printers.find(x => x.id === j.printer_id);
  const price = c.kwh != null ? +c.kwh : 0, wearH = c.wear_h != null ? +c.wear_h : 0, w = p && p.power_w ? +p.power_w : 0;
  if (!price && !wearH && !w) return null;
  let secs = j.start && j.end ? (ts(j.end) - ts(j.start)) / 1000 : 0;
  if (!(secs > 0) || secs > 3 * 86400) secs = +j.print_s || 0;
  if (!(secs > 0) || secs > 3 * 86400) return null;
  const h = secs / 3600, kwh = w ? w / 1000 * h : null, r2 = v => Math.round(v * 100) / 100;
  const energy = kwh !== null && price ? kwh * price : null, wear = wearH ? h * wearH : null;
  if (energy === null && wear === null) return kwh !== null ? { kwh: Math.round(kwh * 1000) / 1000, energy: null, wear: null, total: null } : null;
  return { kwh: kwh !== null ? Math.round(kwh * 1000) / 1000 : null, energy: energy !== null ? r2(energy) : null, wear: wear !== null ? r2(wear) : null,
           total: r2((energy || 0) + (wear || 0)) };
}

/** Ein Auftrag für die Liste (Druckaufträge, Druckbuch der Bibliothek) */
const jobItem = j => ({
  id: j.id, title: j.title, status: j.status, printer: printerName(j.printer_id), provider: 'moonraker', start: j.start, end: j.end,
  grams: j.grams_real ?? j.grams, paint: (j.paint || []).map(x => ({ color: x.color, g: x.g })), state: j.state === 'open' ? 'not_finished' : j.state,
  cost: j.cost ?? null, cost_est: null, run: j.status === 1 ? null : runCost(j), mk: undefined,
});
function jobsOut(inp) {
  const off = +inp.offset || 0, lim = 50;
  const all = db.jobs.slice().sort((a, b) => ts(b.end || b.start) - ts(a.end || a.start));
  const items = all.slice(off, off + lim).map(jobItem);
  const m0 = Date.now() - 30 * 864e5, mj = db.jobs.filter(j => j.state !== 'before_connect' && ts(j.end || j.start) >= m0);
  const costs = mj.map(j => j.cost).filter(c => c != null);
  // Strom + Verschleiß: fertige und abgebrochene Drucke (die Maschine lief auch bei Abbruch)
  let run = null, kwh = null;
  for (const j of mj) {
    if (j.status !== 2 && j.status !== 3) continue;
    const rc = runCost(j); if (!rc) continue;
    if (rc.total !== null) run = (run || 0) + rc.total;
    if (rc.kwh !== null) kwh = (kwh || 0) + rc.kwh;
  }
  return { jobs: items, more: all.length > off + lim,
           month: { ok: mj.filter(j => j.status === 2).length, fail: mj.filter(j => j.status === 3).length, g: mj.reduce((a, j) => a + (j.grams_real ?? j.grams ?? 0), 0),
                    cost: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
                    run: run !== null ? Math.round(run * 100) / 100 : null, kwh: kwh !== null ? Math.round(kwh * 10) / 10 : null } };
}

async function slotAssign(inp) {
  const sl = db.slots.find(s => s.id === +inp.slot_id) || fail('not_found');
  const spool = own(inp.spool_id);
  const old = sl.spool_id && sl.spool_id !== spool.id ? db.spools.find(s => s.id === sl.spool_id) : null;
  if (inp.empty_old && old) { adjLearn(old); old.archived_at = now(); if (leftOf(old) > 0) { book(old, leftOf(old), 'correction', 'empty', '', null); } }
  // Eine Spule steckt immer nur in einem Fach
  db.slots.forEach(s => { if (s.spool_id === spool.id && s !== sl) s.spool_id = null; });
  sl.spool_id = spool.id;
  spool.archived_at = null;
  // Seit dem Einlegen gedruckt, aber noch keiner Spule zugeordnet → jetzt nachbuchen
  if (sl.pending_g >= 0.5) { book(spool, sl.pending_g * adjOf(sl.printer_id), 'print', 'pending', '', printerName(sl.printer_id), true, { pid: sl.printer_id, raw: sl.pending_g }); }
  sl.pending_g = 0;
  persist();
  // Spule auch am Drucker eintragen (Display, Hersteller-Slicer) — ein Fehler dabei macht die Zuordnung in der App nicht rückgängig
  const printer_set = await slotPush(sl, spool).catch(e => 'error:' + (e && e.message || e));
  return { ok: true, printer_set };
}

/**
 * Material der Spule → Standardfilament am Drucker (16.11.2026). Bambu-Kennung (tray_info_idx) und Düsenbereich aus den Bambu-Profilen
 * von OrcaSlicer (Generic …: GFL99 PLA, GFL96 PLA Silk, GFL98 PLA-CF, GFG99 PETG, GFB99 ABS, GFB98 ASA, GFU99 TPU, GFN99 PA, GFN98 PA-CF,
 * GFC99 PC, GFS99 PVA). Unbekanntes Material (PCTG, HIPS, PETG-CF …) → null, dann wird am Drucker nichts eingetragen.
 */
const FIL_STD = [
  [/^PLA[\s-]*CF\b/i, 'PLA-CF', 'PLA-CF', 'GFL98', 190, 240],
  [/^PLA\b.*\bSILK\b|^SILK\b/i, 'PLA', 'PLA Silk', 'GFL96', 190, 240],
  [/^PLA(?![\s-]*CF)/i, 'PLA', 'PLA', 'GFL99', 190, 240],
  [/^PETG(?![\s-]*CF)/i, 'PETG', 'PETG', 'GFG99', 220, 270],
  [/^ABS(?![\s-]*CF)/i, 'ABS', 'ABS', 'GFB99', 240, 280],
  [/^ASA(?![\s-]*CF)/i, 'ASA', 'ASA', 'GFB98', 240, 280],
  [/^TPU\b/i, 'TPU', 'TPU', 'GFU99', 200, 250],
  [/^(PA\d*|NYLON)[\s-]*CF\b/i, 'PA-CF', 'PA-CF', 'GFN98', 260, 300],
  [/^(PA\d*|NYLON)(?![A-Z])(?![\s-]*CF)/i, 'PA', 'PA', 'GFN99', 240, 280],
  [/^PC(?![A-Z])(?![\s-]*[A-Z])/i, 'PC', 'PC', 'GFC99', 260, 290],   // nicht PCTG, PC-ABS, PC-CF
  [/^PVA\b/i, 'PVA', 'PVA', 'GFS99', 190, 240],
];
function filStd(sp) {
  const txt = (String(sp.material || '').trim() + ' ' + (/\bsilk\b/i.test(sp.color_name || '') ? 'Silk' : '')).trim();
  const r = FIL_STD.find(([re]) => re.test(txt));
  return r ? { type: r[1], name: r[2], idx: r[3], min: r[4], max: r[5] } : null;
}
/**
 * Spule im Fach → auch am Drucker eintragen (16.11.2026, wie der SimplyPrint Client im Betrieb: Bambu MQTT „ams_filament_setting“, Elegoo CC2
 * Methode 2003). Nur Bambu-AMS (nicht die externe Spule) und CC2-CANVAS; nie über eine Bambu-Spule mit RFID-Chip (der Drucker weiß es besser);
 * nichts senden, wenn Material und Farbe am Drucker schon stimmen. Abschaltbar (Einstellungen, amp_slot_push_off).
 * Rückgabe: 'sent' oder der Grund, warum nicht ('off', 'kind', 'slot', 'rfid', 'material', 'same', 'offline').
 */
async function slotPush(sl, sp) {
  if (db.settings.amp_slot_push_off) return 'off';
  const p = db.printers.find(x => x.id === sl.printer_id);
  if (!p) return 'kind';
  const k = kindOf(p);
  if (k !== 'bambu' && k !== 'cc2') return 'kind';
  // Bambu: die Rohdaten aus bbSlots (AMS-Nummer, Fach, extern, RFID) — die Einträge der Druckerkarte tragen sie nicht
  const es = k === 'bambu' ? ((live[p.id] && live[p.id].bbSlots) || []).find(s => s.index === sl.index)
                           : ((live[p.id] && live[p.id].entry && live[p.id].entry.slots) || []).find(s => s.index === sl.index);
  if (!es || es.single || es.ext) return 'slot';
  if (es.rfid) return 'rfid';
  const f = filStd(sp);
  if (!f) return 'material';
  const col = hex(sp.color_hex).slice(1).toUpperCase();
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (es.material && es.color && norm(es.material) === norm(f.type) && es.color.replace('#', '').toUpperCase() === col) return 'same';
  if (k === 'bambu') {
    const st = await native('live_state', { key: 'bb_' + p.id }).catch(() => ({}));
    if (!st.connected) return 'offline';
    // ams_id/slot_id wie ams_mapping2: AMS {ams, fach}, AMS HT {ams_id ≥ 128, 0}, A2L {16, fach}; tray_id = Fach wie beim SimplyPrint Client
    const slotId = es.ams >= 128 ? 0 : es.ams === 16 ? es.tray : es.tray % 4;
    const cmd = { print: { sequence_id: String(Math.floor(Math.random() * 2e9)), command: 'ams_filament_setting', ams_id: es.ams, slot_id: slotId, tray_id: slotId,
      tray_info_idx: f.idx, tray_color: col + 'FF', nozzle_temp_min: f.min, nozzle_temp_max: f.max, tray_type: f.type, setting_id: '' } };
    await native('live_send', { key: 'bb_' + p.id, payload: JSON.stringify(cmd) });
  } else {
    const st = await native('live_state', { key: ccKey(p) }).catch(() => ({}));
    if (!st.connected || !st.registered) return 'offline';
    await ccCall(p, 2003, { canvas_id: Math.floor(sl.index / 4), tray_id: sl.index % 4, brand: String(sp.brand || 'Generic').slice(0, 30), filament_type: f.type,
      filament_name: f.name, filament_code: '0x0000', filament_color: '#' + col, filament_min_temp: f.min, filament_max_temp: f.max }, 8000);
  }
  diag({ a: 'slot_push', p: k, m: p.model || '', d: f.type });
  // Oberfläche bestätigt kurz (amp-views; im Agenten über agent-shim wie „amp-adj“)
  try { document.dispatchEvent(new CustomEvent('amp-slot-push', { detail: { slot: es.label, printer: p.name } })); } catch (e) {}
  return 'sent';
}

// ── Drucken aus der App ────────────────────────────────────────────────────
/** Slicer-Zusammenfassung aus Kopf und Ende einer G-Code-Datei: Gramm/Material/Farbe je Werkzeug, Zeit, Vorschaubild. */
function gcodeMeta(head, tail) {
  const txt = head + '\n' + tail, md = { weights: null, mm: null, types: [], colors: [], time_s: null, thumb: null, slicer: null };
  const nums = s => (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  let m;
  if ((m = /^;\s*filament used \[g\]\s*[=:]\s*(.+)$/im.exec(txt))) md.weights = nums(m[1]);
  if (!md.weights && (m = /^;\s*total filament used \[g\]\s*[=:]\s*([\d.]+)/im.exec(txt))) md.weights = [+m[1]];
  if ((m = /^;\s*filament used \[mm\]\s*[=:]\s*(.+)$/im.exec(txt))) md.mm = nums(m[1]);
  if (!md.mm && (m = /^;\s*Filament used:\s*(.+)$/m.exec(txt))) md.mm = (m[1].match(/(\d+(?:\.\d+)?)m/g) || []).map(x => parseFloat(x) * 1000);
  if ((m = /^;\s*filament_type\s*=\s*(.+)$/im.exec(txt))) md.types = m[1].split(';').map(s => s.trim());
  if ((m = /^;\s*filament_colou?r\s*=\s*(.+)$/im.exec(txt))) md.colors = m[1].split(';').map(s => s.trim());
  if ((m = /^;\s*estimated printing time(?: \(normal mode\))?\s*=\s*(.+)$/im.exec(txt)) || (m = /^;\s*model printing time:.*;\s*total estimated time:\s*(.+)$/im.exec(txt))) {   // 2. = Bambu-Format
    const t = m[1]; let s = 0; const d = /(\d+)d/.exec(t), h = /(\d+)h/.exec(t), mi = /(\d+)m(?!m)/.exec(t), se = /(\d+)s/.exec(t);
    s = (d ? +d[1] * 86400 : 0) + (h ? +h[1] * 3600 : 0) + (mi ? +mi[1] * 60 : 0) + (se ? +se[1] : 0); md.time_s = s || null;
  } else if ((m = /^;TIME:(\d+)/m.exec(txt))) md.time_s = +m[1];
  if ((m = /^;\s*generated by\s+(.+)$/im.exec(txt)) || (m = /^;\s*(OrcaSlicer|PrusaSlicer|BambuStudio|Anycubic Slicer[^\n]*|Cura_SteamEngine[^\n]*)/im.exec(head))) md.slicer = m[1].trim().slice(0, 60);
  if ((m = /^;\s*nozzle_diameter\s*=\s*([\d.]+)/im.exec(txt))) md.nozzle = +m[1];
  if ((m = /^;\s*printer_model\s*=\s*(.+)$/im.exec(txt))) md.printer_model = m[1].trim().slice(0, 60);
  if (!md.weights && md.mm) md.weights = md.mm.map((x, i) => mmToG(x, 1.75, DENSITY[String(md.types[i] || 'PLA').toUpperCase()] || 1.24));
  // Größtes PNG/JPG-Vorschaubild im Kopf
  const re = /^;\s*(thumbnail(?:_PNG|_JPG)?) begin (\d+)x(\d+) \d+\s*$([\s\S]*?)^;\s*\1 end/gim;
  let best = null;
  while ((m = re.exec(head))) {
    const w = +m[2], b64 = m[4].split('\n').map(l => l.replace(/^;\s?/, '').trim()).join('');
    if (!best || w > best.w) best = { w, b64, jpg: /JPG/i.test(m[1]) };
  }
  if (best && best.b64.length > 100) md.thumb = 'data:image/' + (best.jpg ? 'jpeg' : 'png') + ';base64,' + best.b64;
  return md;
}
async function fileMeta(file) {
  // Fertig geslicte 3MF (.gcode.3mf aus Bambu Studio/OrcaSlicer, 24.11.2026 — Druckstarts 23.11.: ~20 vergebliche Slice-Versuche mit so
  // einer Datei): Zeit, Gramm, Filamente aus dem G-Code darin (Metadata/plate_1.gcode); gesendet wird die Datei unverändert (printSend).
  if (/\.3mf$/i.test(file.name || '') && window.AMPMesh && AMPMesh.gcodeOf) {
    try {
      const blob = await (await _fetch((window.AMP_BASE || '') + '/file?t=' + encodeURIComponent(file.token))).blob();
      const g = await AMPMesh.gcodeOf(blob);
      if (g !== null) return Object.assign(gcodeMeta(g.slice(0, 393216), g.slice(-262144)), { g3mf: true });
    } catch (e) { /* unlesbar → wie bisher */ }
  }
  const head = (await native('fileRead', { token: file.token, offset: 0, length: 393216 })).text;
  const tail = (await native('fileRead', { token: file.token, tail: true, length: 262144 })).text;
  return gcodeMeta(head, tail);
}
// ── G-Code-Prüfung vor dem Senden (26.11.2026) ─────────────────────────────────────────────────────────────────────────
// Anlass: U1 mehrfarbig (25.11.) — der Slicer heizte beim Kopfwechsel den falschen Kopf, der Drucker meldete „Düsentemperatur zu
// niedrig“. Gefunden nur, weil Chris selbst einen U1 hat. User: „was können wir machen, damit wir mehr sehen, wenn ein User druckt“ +
// „auch den eigenen Slicer beachten“ → die App prüft JEDE Datei kurz vor dem Senden (unser Slicer, eigener Slicer, fertige Datei),
// liest sie dafür einmal durch und schickt nur die Namen der auffälligen Regeln + Anzahl mit der Rückmeldung zum Druckstart.
// Nichts aus der Datei verlässt das Gerät. Regeln (bewusst wenige, ohne Fehlalarme an 31 Testdateien von 22 Druckern):
//   tc_heat    Kopfwechsel: „M109 … T<a>“ wartet auf Kopf a, gewechselt wird auf Kopf b (U1-Fehler bis Slicer 1.0.13)
//   cold_ext   Extrudieren, während der aktive Kopf ausdrücklich unter 170 °C gestellt ist (Klipper-Grenze min_extrude_temp)
//   rel_xy     Druckbewegung im G91 (relativ) — ein Wechsel-Makro hat G90 vergessen (02.10.2026)
//   tool_range Werkzeug T<n>, das der Drucker laut Datei nicht hat (nur Werkzeugwechsler mit eigenem Heizer je Kopf)
//   off_bed    Druckbewegung außerhalb der Druckfläche aus der Datei (+3 mm)
//   bed_cold   Bett wird nie geheizt, die Einstellungen in der Datei verlangen aber eine Betttemperatur (U1-Plattentyp 17.11.)
//   no_ext     Keine einzige Druckbewegung
// Nicht prüfbar → skip_read / skip_time / skip_fmt (Binär-G-Code). Ergebnis: { rules: {regel: anzahl} } oder { skip }.
const GCHK_V = 1, GCHK_MIN_T = 170, GCHK_MS = 60000;
/** Einstellungsblock am Dateiende (Orca, Bambu Studio, PrusaSlicer: „; key = value“) → nur die Werte, die die Regeln brauchen. */
function gchkConf(tail) {
  const c = {};
  for (const m of String(tail || '').matchAll(/^; ?([a-z_0-9]+) = (.*)$/gm)) c[m[1]] = m[2].trim();
  const nz = (c.nozzle_diameter || '').split(',').filter(x => x.trim() !== '').length;
  const area = [];
  for (const m of String(c.printable_area || c.extruder_printable_area || c.bed_shape || '').matchAll(/(-?[\d.]+)x(-?[\d.]+)/g)) area.push([+m[1], +m[2]]);
  // Betttemperatur aus der Datei: PrusaSlicer bed_temperature/first_layer_bed_temperature, Orca/Bambu je Plattentyp (curr_bed_type)
  const plate = { 'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'High Temp Plate': 'hot_plate_temp', 'Textured PEI Plate': 'textured_plate_temp',
                  'Textured Cool Plate': 'textured_cool_plate_temp', 'Supertack Plate': 'supertack_plate_temp' }[(c.curr_bed_type || '').replace(/^"|"$/g, '')];
  const num = k => Math.max(0, ...String(c[k] || '').split(',').map(Number).filter(Number.isFinite));
  const bed = plate ? Math.max(num(plate), num(plate + '_initial_layer')) : Math.max(num('bed_temperature'), num('first_layer_bed_temperature'));
  return {
    // Heizer je Werkzeug: mehrere Düsen und KEIN „ein Extruder, mehrere Filamente“ (Bambu H2D: 2 Düsen, T = Filament → nicht je Werkzeug)
    heaters: nz > 1 && c.single_extruder_multi_material === '0' && !/bambu/i.test(c.printer_model || '') ? nz : 1,
    box: area.length >= 3 ? [Math.min(...area.map(p => p[0])), Math.min(...area.map(p => p[1])), Math.max(...area.map(p => p[0])), Math.max(...area.map(p => p[1]))] : null,
    bed, known: Object.keys(c).length > 20,
  };
}
function gchkNew(conf) {
  return { conf, hit: {}, layer: false, abs: true, absE: false, e: 0, tool: 0, tgt: {}, heatT: null, bedHeat: false, ext: 0, extAny: 0, x: null, y: null };
}
const gchkHit = (st, r) => { st.hit[r] = (st.hit[r] || 0) + 1; };
const gchkNum = (s, k) => { const m = s.match(new RegExp('(?:^|\\s)' + k + '(-?[\\d.]+)', 'i')); return m ? +m[1] : null; };
/** Eine Zeile (ohne Kommentar am Zeilenende) prüfen. */
function gchkLine(st, raw) {
  const c0 = raw.charCodeAt(0);
  if (c0 === 59) {   // ';' — Schichtwechsel: ab hier wird gedruckt (Orca/Prusa „;LAYER_CHANGE“, Bambu „; CHANGE_LAYER“, Cura „;LAYER:0“)
    // Simplify3D „; layer 1, Z = …“, KISSlicer „; BEGIN_LAYER“. Ohne Marke greifen nur no_ext/bed_cold/tool_range (nichts raten)
    if (!st.layer && /^;\s*(LAYER_CHANGE\b|CHANGE_LAYER\b|LAYER:\s*\d|layer \d|BEGIN_LAYER)/.test(raw)) st.layer = true;
    return;
  }
  const sc = raw.indexOf(';');
  const l = (sc >= 0 ? raw.slice(0, sc) : raw).trim();
  if (!l) return;
  const u = l.charCodeAt(0);
  const heat = st.conf.heaters > 1;
  if (u === 71 || u === 103) {   // G
    const g = l.match(/^G(\d+)/i); if (!g) return;
    const n = +g[1];
    if (n === 90) { st.abs = true; return; }
    if (n === 91) { st.abs = false; return; }
    if (n === 92) { const e = gchkNum(l, 'E'); if (e !== null) st.e = e; return; }
    if (n > 3) return;
    const x = gchkNum(l, 'X'), y = gchkNum(l, 'Y'), e = gchkNum(l, 'E');
    if (st.abs) { if (x !== null) st.x = x; if (y !== null) st.y = y; }
    if (e === null) return;
    const d = st.absE ? e - st.e : e;
    if (st.absE) st.e = e;
    if (!(d > 0.0001)) return;
    st.heatT = null;   // gedruckt → ein früheres „M109 … T<a>“ gehört nicht mehr zum nächsten Wechsel (Creator 5: erst T, dann M109)
    if (x === null && y === null) return;
    st.extAny++;
    if (!st.layer) return;
    st.ext++;
    if (!st.abs) { gchkHit(st, 'rel_xy'); return; }
    const t = st.tgt[heat ? st.tool : 0];
    if (t !== undefined && t < GCHK_MIN_T && !st.tAmb) gchkHit(st, 'cold_ext');
    const b = st.conf.box;
    if (b && st.x !== null && st.y !== null && (st.x < b[0] - 3 || st.y < b[1] - 3 || st.x > b[2] + 3 || st.y > b[3] + 3)) gchkHit(st, 'off_bed');
    return;
  }
  if (u === 77 || u === 109) {   // M
    const m = l.match(/^M(\d+)/i); if (!m) return;
    const n = +m[1];
    if (n === 82) { st.absE = true; return; }
    if (n === 83) { st.absE = false; return; }
    if (n === 104 || n === 109) {
      const s = gchkNum(l, 'S'), r = gchkNum(l, 'R'), tt = gchkNum(l, 'T');
      const v = s !== null ? s : r;
      // Ein Heizer laut Datei, aber Befehle für Kopf 1, 2 …: Bambu H2D/H2C (2 Düsen, T = Filament) — welche Düse druckt, steht nicht da
      if (!heat && tt) st.tAmb = true;
      const tool = heat ? (tt !== null ? tt : st.tool) : 0;
      if (v !== null) st.tgt[tool] = v;
      if (n === 109 && tt !== null) st.heatT = tt;
      return;
    }
    if ((n === 140 || n === 190) && (gchkNum(l, 'S') || gchkNum(l, 'R') || 0) > 0) st.bedHeat = true;
    return;
  }
  if (u === 84 || u === 116) {   // T<n> = Werkzeugwahl
    const m = l.match(/^T(\d+)\s*$/i); if (!m) return;
    const t = +m[1];
    // nur im Druck: Startskripte holen die Köpfe nacheinander ab, ohne zu drucken (Prusa XL: M109 T0 S170, dann T1, T2 …)
    if (st.heatT !== null && st.heatT !== t && heat && st.layer) gchkHit(st, 'tc_heat');
    st.heatT = null;
    if (heat && t >= st.conf.heaters) gchkHit(st, 'tool_range');
    st.tool = t;
    return;
  }
  // Makros (Klipper): Bett per Parameter (PRINT_START BED=60, BED_TEMP=…), Heizer per SET_HEATER_TEMPERATURE
  if (!st.bedHeat && /\bBED[A-Z_]*=\s*[1-9]/i.test(l)) st.bedHeat = true;
  // Düse per Parameter (START_PRINT EXTRUDER_TEMP=220, PRINT_START EXTRUDER=220 HOTEND=…) — Orca schreibt davor oft „M104 S0“.
  // Startmakro ohne Temperatur: es heizt vielleicht selbst → Ziel unbekannt
  const xt = l.match(/\b(?:EXTRUDER|HOTEND|NOZZLE)[A-Z_]*=\s*(\d{2,3})\b/i);
  if (xt && +xt[1] >= 100) { if (heat) st.tgt[st.tool] = +xt[1]; else st.tgt[0] = +xt[1]; }
  else if (/^[A-Z_]*(START|PREPARE|BEGIN)[A-Z_]*\b/i.test(l)) st.tgt = {};
  const sh = l.match(/^SET_HEATER_TEMPERATURE\s+HEATER=(\w+)\s+TARGET=([\d.]+)/i);
  if (sh) {
    if (/^heater_bed$/i.test(sh[1])) { if (+sh[2] > 0) st.bedHeat = true; }
    else { const k = sh[1].match(/^extruder(\d*)$/i); if (k) st.tgt[heat ? +(k[1] || 0) : 0] = +sh[2]; }
  }
}
function gchkEnd(st) {
  if (!st.extAny) gchkHit(st, 'no_ext');
  if (!st.bedHeat && st.conf.known && st.conf.bed > 0) gchkHit(st, 'bed_cold');
  return { v: GCHK_V, rules: st.hit };
}
/** Ganze Datei als Text (z. B. G-Code aus einer .gcode.3mf). */
function gchkText(g) {
  const st = gchkNew(gchkConf(g.slice(0, 393216) + '\n' + g.slice(-262144)));
  let i = 0;
  while (i < g.length) { let j = g.indexOf('\n', i); if (j < 0) j = g.length; gchkLine(st, g.slice(i, g.charCodeAt(j - 1) === 13 ? j - 1 : j)); i = j + 1; }
  return gchkEnd(st);
}
/** Datei zur Kennung lesen (Android/iOS/Agent liefern sie unter /file?t=) und prüfen. Wirft nie. */
async function gcodeCheck(file, name) {
  try {
    if (/\.bgcode$/i.test(name || '')) return { skip: 'fmt' };
    const url = (window.AMP_BASE || '') + '/file?t=' + encodeURIComponent(file.token);
    const until = Date.now() + GCHK_MS;
    if (/\.3mf$/i.test(name || '')) {
      if (!(window.AMPMesh && AMPMesh.gcodeOf)) return { skip: 'fmt' };
      const g = await AMPMesh.gcodeOf(await (await _fetch(url)).blob());
      return g === null ? { skip: 'fmt' } : gchkText(g);
    }
    // Einstellungen stehen am Ende (Orca, PrusaSlicer) bzw. am Anfang (Bambu Studio, Orca mit Bambu-Druckern)
    const head = (await native('fileRead', { token: file.token, offset: 0, length: 393216 })).text;
    const tail = (await native('fileRead', { token: file.token, tail: true, length: 262144 })).text;
    const st = gchkNew(gchkConf(head + '\n' + tail));
    const res = await _fetch(url);
    if (!res.ok) return { skip: 'read' };
    if (!res.body || !res.body.getReader) { const g = await res.text(); return gchkText(g); }   // ohne Stream (alte WebView): ganz lesen
    const rd = res.body.getReader(), dec = new TextDecoder();
    let rest = '';
    for (;;) {
      const { done, value } = await rd.read();
      const s = rest + (done ? dec.decode() : dec.decode(value, { stream: true }));
      let i = 0, j;
      while ((j = s.indexOf('\n', i)) >= 0) { gchkLine(st, s.slice(i, s.charCodeAt(j - 1) === 13 ? j - 1 : j)); i = j + 1; }
      rest = s.slice(i);
      if (done) { if (rest) gchkLine(st, rest); break; }
      if (Date.now() > until) { rd.cancel().catch(() => {}); return { skip: 'time' }; }
    }
    return gchkEnd(st);
  } catch (e) { return { skip: 'read' }; }
}
/** Für die Rückmeldung: „tc_heat:48,cold_ext:3“, leer = unauffällig, „skip_time:1“ = nicht geprüft. */
const gchkStr = r => !r ? null : r.skip ? 'skip_' + r.skip + ':1' : Object.entries(r.rules || {}).map(([k, n]) => k + ':' + Math.min(n, 99999)).join(',');
// ── Ende G-Code-Prüfung ──

/** Hochladen + Starten je Treiber → Dateiname auf dem Drucker. */
const SEND = {
  async moonraker(p, file, name, start, plan, opts) {
    if (start) {
      const st = await mrGet(p, '/printer/objects/query?print_stats');
      const s = ((st.status || {}).print_stats || {}).state;
      if (s === 'printing' || s === 'paused') fail('printer_busy');
    }
    const up = await native('upload', { url: mrUrl(p, '/server/files/upload'), token: file.token, filename: name, fields: { root: 'gcodes' }, timeout: 600000,
                                        headers: p.key ? { 'X-Api-Key': p.key } : {} });
    if (up.status >= 400) fail('upload_' + up.status);
    let fname = name;
    try { const r = JSON.parse(up.text); fname = (r.result || r).item ? (r.result || r).item.path : name; } catch (e) {}
    if (!start) return fname;
    if (isU1(p)) await u1Prefs(p, opts || {});
    try { await mrPost(p, '/printer/print/start?' + qs({ filename: fname }), {}, 20000); }
    catch (e) {
      // Moonraker antwortet nach großen Dateien manchmal spät (prüft sie erst) — der Druck läuft dann trotzdem (Kobra S1, 30 MB).
      // Bis 0.8.3 nur EINE Prüfung nach 4 s: Kobra S1 mit Klipper meldete zweimal „timeout“ (Druckstart-Tabelle 17.11.2026,
      // Zeilen 25/26). Jetzt etwa 30 s lang alle 3 s nachsehen; läuft er dann nicht, „start_timeout“ statt „timeout“,
      // damit die Tabelle Upload- und Startprobleme unterscheidet.
      if (!/^http_/.test(e.message)) {
        const until = Date.now() + 30000;
        while (Date.now() < until) {
          await new Promise(r => setTimeout(r, 3000));
          const st = await mrGet(p, '/printer/objects/query?print_stats').catch(() => null);
          const ps = st && st.status && st.status.print_stats;
          // „error“ nicht als Abbruchgrund: kann noch vom vorigen Druck stehen
          if (ps && (ps.state === 'printing' || ps.state === 'paused') && String(ps.filename || '').endsWith(fname)) { diag({ a: 'mr_start_late', p: p.id, d: e.message + ' ' + Math.round((Date.now() - until + 30000) / 1000) + ' s' }); return fname; }
        }
        diag({ a: 'mr_start_timeout', p: p.id, err: e.message });
        fail('start_timeout');
      } else throw e;
    }
    return fname;
  },
  async octoprint(p, file, name, start) {
    if (start) {
      const pr = await dj(p, 'GET', '/api/printer?exclude=sd,temperature').catch(e => { if (e.message === 'not_connected') fail('not_connected'); throw e; });
      const fl = (pr.state || {}).flags || {};
      if (fl.printing || fl.paused || fl.pausing || fl.cancelling) fail('printer_busy');
    }
    const up = await native('upload', { url: baseUrl(p, '/api/files/local'), token: file.token, filename: name, fields: { select: 'true', print: start ? 'true' : 'false' },
                                        timeout: 600000, headers: p.key ? { 'X-Api-Key': p.key } : {} });
    if (up.status === 401 || up.status === 403) fail('unauthorized');
    if (up.status >= 400) fail('upload_' + up.status);
    let r = {}; try { r = JSON.parse(up.text); } catch (e) {}
    // OctoPrint lehnt den Start nicht mit 409 ab, sondern meldet effectivePrint:false (keine Druckrechte, Drucker nicht bereit;
    // docs api/files) — vorher galt das als gestartet und wurde abgebucht (Prüfung 11.11.2026)
    if (start && r.effectivePrint === false) fail('start_failed');
    return ((r.files || {}).local || {}).path || name;
  },
  async bambu(p, file, name, start, plan, opts = {}) {
    const st = await native('live_state', { key: 'bb_' + p.id }).catch(() => ({}));
    const pr = (st.state || {}).print || {};
    if (!st.connected) fail('unreach');
    // Stand vor dem Start: FAILED/print_error bleiben nach einem abgebrochenen Druck stehen (Ruhezustand) — nur Änderungen zählen
    const g0 = String(pr.gcode_state || '').toUpperCase(), e0 = +pr.print_error || 0;
    // Entwicklermodus (26.11.2026): nicht mehr vorab sperren — das Merkmal ist nicht bei jedem Modell belegt (H2C, Druckstarts 25.11.).
    // Der Drucker sagt es selbst: Startantwort „verify failed“ → devmode (unten). Kostet bei wirklich ausgeschaltetem Modus nur das Hochladen.
    const devBit = bbDevMode(pr);
    if (devBit === false) diag({ a: 'send', p: 'bambu', m: p.model || '', d: 'devmode bit off, trying' });
    if (start && ['RUNNING', 'PAUSE', 'PREPARE'].includes(String(pr.gcode_state || '').toUpperCase())) fail('printer_busy');
    // .gcode.3mf packen (Metadata/plate_1.gcode), per FTPS hochladen, per MQTT mit Fachzuordnung starten
    // Keine Leerzeichen im Namen (sonst startet der Drucker nicht)
    const base = name.replace(/\.gcode\.3mf$/i, '').replace(/\.(gcode|gco|g|3mf)$/i, '').replace(/\s+/g, '_').replace(/[^\w.\-()+]/g, '_').slice(0, 60) || 'print';
    const remote = base + '.gcode.3mf';
    const slots = live[p.id] && live[p.id].bbSlots || [];
    const used = (plan || []).filter(x => x.g > 0);
    // Fertiges Bambu-/Orca-Projekt (.gcode.3mf) unverändert; sonst verpacken samt slice_info/Projektdaten/Vorschaubild
    const pk = /\.3mf$/i.test(name) ? file : await native('make3mf', { token: file.token, name: remote, extra: bbExtra(p, used, slots, plan && plan.time_s, file.plate_png) });
    // Port 990 schreibt nur auf USB-Stick/SD-Karte; ohne Medium antwortet der Drucker 553 (Bambuddy print_storage.py, Prüfung 11.11.2026)
    await native('ftps', { token: pk.token, host: p.host, code: p.code || '', remote: '/' + remote, port: bbPort(p, 'ftps', 990) })
      .catch(e => { if (/\b553\b/.test(`${e && e.message} ${e && e.msg} ${e && e.data && e.data.msg}`)) fail('no_medium'); throw e; });
    // MD5 der ganzen hochgeladenen Datei in Großbuchstaben, wie der SimplyPrint Client (beobachtet 16.11.2026) und BambuStudio
    const md5 = start ? String((await native('md5', { token: pk.token }).catch(() => ({}))).md5 || '').toUpperCase() : '';
    if (pk !== file) native('fileDrop', { token: pk.token }).catch(() => {});
    if (!start) return remote;
    // ams_mapping: eine Stelle je Filament der Datei (Filament-ID − 1), Wert = AMS-Fach (ams_id*4+slot, AMS HT = ams_id, A2L lokal 0–3), −1 = unbenutzt
    // oder externe Spule (rohe 254/255 im Feld → Fehler 0700_8012 am H2D). ams_mapping2 wie BambuStudio SelectMachine.cpp: externe Spule
    // {255|254, 0}, AMS {ams, fach}, A2L {16, fach}, unbenutzt {255, 255} (Prüfung 11.11.2026: Mischdruck extern + AMS schickte {255, 255})
    const fil = used.map((x, i) => ({ f: x.tool ?? x.fil ?? i, s: slots.find(z => z.index === x.slot) })).filter(x => x.s && x.s.tray !== null && x.s.tray !== undefined);
    const ext = fil.length > 0 && fil.every(x => x.s.ext);
    const n = Math.max(1, ...fil.map(x => x.f + 1));
    const map = Array.from({ length: n }, () => -1), map2 = Array.from({ length: n }, () => ({ ams_id: 255, slot_id: 255 }));
    fil.forEach(({ f, s: z }) => {
      if (z.ext) { map2[f] = { ams_id: z.vid, slot_id: 0 }; return; }
      map[f] = z.tray;
      map2[f] = z.ams >= 128 ? { ams_id: z.ams, slot_id: 0 } : z.ams === 16 ? { ams_id: 16, slot_id: z.tray } : { ams_id: Math.floor(z.tray / 4), slot_id: z.tray % 4 };
    });
    const useAms = !ext && fil.length > 0;
    const sid = String(Math.floor(Math.random() * 2e9));
    const cmd = { print: { sequence_id: sid, command: 'project_file', param: 'Metadata/plate_1.gcode', subtask_name: base,
      // url „ftp://<name>“ (zwei Schrägstriche) wie der SimplyPrint Client im Betrieb — vorher „ftp:///“ (Widerspruch aus der Prüfung 11.11.2026)
      url: 'ftp://' + remote, file: remote, md5, project_id: '0', profile_id: '0', task_id: '0', subtask_id: '0', job_id: 0,
      // flow_cali/vibration_cali: Häkchen vor dem Druck (21.11.2026), ohne Angabe wie bisher aus
      bed_type: 'auto', bed_leveling: true, flow_cali: !!opts.flow, vibration_cali: !!opts.vib, layer_inspect: false, timelapse: false,
      // Neuere Drucker (P2S …) entscheiden nach diesen Zahlen und kalibrieren sonst trotzdem (ha-bambulab; Prüfung 11.11.2026)
      auto_bed_leveling: 1, extrude_cali_flag: opts.flow ? 1 : 0,
      use_ams: useAms, ams_mapping: useAms ? map : [-1] } };
    cmd.print.ams_mapping2 = map2;
    const sentAt = Date.now();
    await native('live_send', { key: 'bb_' + p.id, payload: JSON.stringify(cmd) });
    // Start abwarten: Drucker meldet PREPARE/RUNNING. Antwort auf project_file (Live.kt bb_ack) zuerst: „failed“ mit Grund,
    // „mqtt message verify failed“ = kein Entwicklermodus (P1/A1 melden das sonst nirgends; Bambuddy) — Prüfung 11.11.2026
    let other = false;
    // 27.11.2026 (Druckstart 133: P1S direkt aus der App → start_timeout, über den Agenten lief es): nach 25 s ohne Zustandswechsel
    // einmal den vollen Stand anfordern (pushall — die P1-Reihe schickt sonst nur Änderungen) und 20 s weiter warten; der Grund
    // (gesehene Zustände, Antwort, Verbindung, Alter der letzten Meldung) geht mit der Druckstart-Meldung mit (det)
    const seen = [], dt = { ack: 'none', conn: '?', age: -1, push: 0 };
    for (let i = 0; i < 45; i++) {
      await new Promise(z => setTimeout(z, 1000));
      if (i === 25) {
        dt.push = 1;
        await native('live_send', { key: 'bb_' + p.id, payload: JSON.stringify({ pushing: { sequence_id: String(Math.floor(Math.random() * 2e9)), command: 'pushall', version: 1, push_target: 1 } }) }).catch(() => { dt.push = 2; });
      }
      const s2 = await native('live_state', { key: 'bb_' + p.id }).catch(() => ({}));
      const S2 = s2.state || {}, pr2 = S2.print || {}, g2 = String(pr2.gcode_state || '').toUpperCase();
      dt.conn = s2.connected ? 1 : 0; dt.age = typeof s2.age === 'number' ? Math.round(s2.age / 1000) : -1;
      if (g2 && seen[seen.length - 1] !== g2 && seen.length < 6) seen.push(g2);
      if (S2.bb_ack && +S2.bb_ack.at >= sentAt) dt.ack = String(S2.bb_ack.result || 'x').slice(0, 12);
      if (['PREPARE', 'RUNNING', 'SLICING'].includes(g2)) {
        if (p.bb_rej || (devBit === false && !p.bb_bitbad)) { p.bb_rej = 0; if (devBit === false) p.bb_bitbad = true; persist(); }   // Merkmal „aus“ war falsch
        return remote;
      }
      const ack = S2.bb_ack && +S2.bb_ack.at >= sentAt && (!S2.bb_ack.seq || String(S2.bb_ack.seq) === sid) ? S2.bb_ack : null;
      if (ack && /fail/i.test(ack.result || '')) {
        if (/verif/i.test(ack.reason || '') || [84033543, 84033544, 84033545, 84033546, 84033547, 84033548].includes(+ack.err)) { p.bb_rej = Date.now(); p.bb_bitbad = false; persist(); fail('devmode'); }
        const e = new Error('start_failed'); e.code = 'start_failed'; e.detail = `${ack.reason || ''} ${ack.err || ''}`.trim(); e.msg = ack.reason || ''; throw e;
      }
      if (g2 && g2 !== 'FAILED') other = true;
      const err = +pr2.print_error || 0;
      if ((g2 === 'FAILED' && (g0 !== 'FAILED' || other)) || (err && err !== e0 && i > 3)) { const e = new Error('start_failed'); e.code = 'start_failed'; e.detail = `state=${g2} err=${err}`; throw e; }
      dt.err = err;
    }
    const e = new Error('start_timeout'); e.code = 'start_timeout';
    e.detail = `seen=${seen.join('>') || '-'} ack=${dt.ack} conn=${dt.conn} age=${dt.age}s push=${dt.push} err=${dt.err || 0} was=${g0 || '-'}`;
    diag({ a: 'bb_start_timeout', p: 'bambu', m: p.model || '', err: 'start_timeout', d: e.detail });
    throw e;
  },
  async sdcp(p, file, name, start, plan) {
    const st = await native('live_state', { key: 'sd_' + p.id }).catch(() => ({}));
    const S_ = (st.state || {}).Status || {};
    if (!st.connected) fail('unreach');
    if (start && ([].concat(S_.CurrentStatus || []).includes(1) || ((+(S_.PrintInfo || {}).Status || 0) > 0 && !SD_DONE.includes(+(S_.PrintInfo || {}).Status)))) fail('printer_busy');
    const fname = name.replace(/\s+/g, '_').replace(/\.(gco|g)$/i, '.gcode');
    const md5 = (await native('md5', { token: file.token })).md5;
    const fields = { 'S-File-MD5': md5, Check: '1', Offset: '{offset}', Uuid: uuid(), TotalSize: String(file.size || 0) };
    let up = null;
    // Port 80 zuerst: Elegoo-SDK, OrcaSlicer und pycentauri laden dort hoch; 3030 steht nur in der Spezifikation (Prüfung 11.11.2026)
    for (const port of [...new Set([sdPort(p, 'http', 80), 80, 3030])]) {
      up = await native('chunkUpload', { url: `http://${p.host}:${port}/uploadFile/upload`, token: file.token, filename: fname, field: 'File', fields, chunk: 1048576 }).catch(e => ({ status: 0, text: e.message }));
      if (up.status === 200) break;
    }
    let ok = false; try { const r = JSON.parse(up.text || '{}'); ok = r.success === true || r.code === '000000'; } catch (e) {}
    if (!up || up.status !== 200 || !ok) fail('upload_' + (up ? up.status : 0));
    if (!start) return fname;
    // Nach dem Upload prüft der Drucker die Datei (CurrentStatus 8, Übertragung 2) — erst danach nimmt er den Start an
    // (OrcaSlicer ElegooLink checkResult, ElegooSlicer isBusy; Prüfung 11.11.2026)
    for (let i = 0; i < 60; i++) {
      const s1 = await native('live_state', { key: 'sd_' + p.id }).catch(() => ({}));
      const cs1 = [].concat((((s1.state || {}).Status) || {}).CurrentStatus || []);
      if (!cs1.includes(8) && !cs1.includes(2)) break;
      if (i % 3 === 0) sdSend(p, 0).catch(() => {});
      await new Promise(z => setTimeout(z, 1000));
    }
    const slots = live[p.id] && live[p.id].entry ? live[p.id].entry.slots : [];
    const slot_map = (plan || []).filter(x => x.g > 0 && !(slots.find(z => z.index === x.slot) || {}).single).map((x, i) => ({ t: x.tool ?? i, canvas_id: Math.floor(x.slot / 4), tray_id: x.slot % 4 }));
    const data = { Filename: fname, StartLayer: 0, Calibration_switch: 1, PrintPlatformType: 0, Tlp_Switch: 0 };
    if (slot_map.length) data.slot_map = slot_map;
    // Antwort über die RequestID zuordnen (Elegoo-SDK findRequestRecord) — vorher galt auch das Ack eines früheren Starts;
    // bis 30 s warten (OrcaSlicer), „/local/…“ nur, wenn der reine Name nicht gefunden wurde (Ack 2)
    for (const fnm of [fname, '/local/' + fname]) {   // Elegoo-SDK: reiner Name; OrcaSlicer: /local/…
      const rid = uuid();
      await sdSend(p, 128, { ...data, Filename: fnm }, rid);
      let ack;
      for (let i = 0; i < 40 && ack === undefined; i++) {
        await new Promise(z => setTimeout(z, 750));
        const s2 = await native('live_state', { key: 'sd_' + p.id }).catch(() => ({}));
        const r = (s2.state || {}).Response_128;
        if (r && r.RequestID === rid) ack = r.Data ? r.Data.Ack : r.Ack;
        else {   // keine Antwort, aber der Drucker druckt unsere Datei → angenommen
          const S2 = (s2.state || {}).Status || {}, pi2 = S2.PrintInfo || {};
          if ([].concat(S2.CurrentStatus || []).includes(1) && String(pi2.Filename || '').split('/').pop() === fname) return fname;
        }
      }
      if (ack === 0) return fname;
      if (ack === 1) fail('printer_busy');
      if (ack === 2) continue;   // nicht gefunden → anderer Pfad
      if (ack !== undefined && ack !== null) fail('start_' + ack);
      break;
    }
    fail('start_timeout');
  },
  async acl(p, file, name, start, plan, opts = {}) {
    let st = await native('live_state', { key: acKey(p) }).catch(() => ({}));
    if (!st.connected) fail('unreach');
    // „busy“ ohne Auftrag (ACE trocknet, Filament wird geladen) zählt auch: ein Start dann wird mit 10101 abgelehnt und kann den
    // Auftragsstand des Druckers durcheinanderbringen (anycubic_ha_local, Test am S1 Max; Prüfung 11.11.2026)
    if (start && (acPhase(st.state || {}).busy || String(((st.state || {}).info || {}).state || '') === 'busy')) fail('printer_busy');
    // Upload-Adresse mit kurzlebigem Sitzungs-Token kommt im info-Bericht → frisch anfordern und auf einen neuen Bericht warten
    const upUrl = async () => {
      const t0 = (st.state || {}).info_at || 0;
      await acSend(p, 'info', 'query');
      for (let i = 0; i < 16 && !(((st.state || {}).info_at || 0) > t0); i++) { await new Promise(z => setTimeout(z, 300)); st = await native('live_state', { key: acKey(p) }).catch(() => ({})); }
      const upu = (((st.state || {}).info || {}).urls || {}).fileUploadurl;
      if (!upu) fail('no_upload_url');
      // Adresse aus Druckersicht → auf den Host umbiegen, unter dem das Handy ihn erreicht (Pfad, Port und Token bleiben)
      return String(upu).replace(/^https?:\/\/[^/:]+(:\d+)?/, (m0, pt) => `http://${p.host}${p.ports && p.ports.http ? ':' + p.ports.http : pt || ''}`);
    };
    const fname = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.(gco|g)$/i, '.gcode');
    const md5 = (await native('md5', { token: file.token })).md5;
    const upload = async url => native('upload', { url, token: file.token, filename: fname, field: 'gcode', fields: { filename: fname }, headers: { 'X-File-Length': String(file.size || 0) }, timeout: 900000 });
    let up = await upload(await upUrl());
    // 403 = Sitzung schon ersetzt: kam zwischen Abfrage und Upload ein weiterer info-Bericht (Live-Abgleich fragt parallel), gilt nur dessen
    // Token (Nachbau: jede info-Antwort vergibt ein neues; e2e 17.11.2026 zufällig rot) → einmal frische Adresse holen und neu hochladen
    if (up.status === 403) { diag({ a: 'send_retry', p: 'acl', m: p.model || '', d: 'upload 403 → new session' }); up = await upload(await upUrl()); }
    if (up.status !== 200) fail('upload_' + up.status);
    // Antwort {"code":200,"message":"success"}; Fehler kommen als anderer code mit HTTP 200 (Name, Platz, 3MF-Prüfung)
    { let uc = null; try { uc = JSON.parse(up.text || '').code; } catch (e) {} if (uc != null && ![0, 200].includes(+uc)) fail('upload_c' + uc); }
    if (!start) return fname;
    const slots = live[p.id] && live[p.id].entry ? live[p.id].entry.slots : [];
    // Kobra X (FW 2.0.x): Start wie KX-Bridge für Dateien, die schon auf dem Drucker liegen — filepath „/“, eigene Auftragsnummer,
    // Farben mit Alpha, vollständige Zusatzangaben (kobrax_moonraker_bridge.py printer-local start + _build_print_payload). Mit
    // filepath null und leerer url antwortete Dennys Kobra X mit 10301 „设备忙,情况未知“ (#90/#91, 11.11.2026). S1/S1 Max unverändert.
    const kx = /Kobra X/i.test(p.model || '');
    const rgba = c => kx ? [...acArr(c), 255] : acArr(c);
    const map = (plan || []).filter(x => x.g > 0 && slots.some(z => z.index === x.slot && !z.single)).map((x, i) => {
      const sl = slots.find(z => z.index === x.slot) || {};
      return { paint_index: x.tool ?? i, ams_index: x.slot, paint_color: rgba(x.color || sl.color), ams_color: rgba(sl.color), material_type: sl.material || 'PLA' };
    });
    // Bett nivellieren: Häkchen in Druck- bzw. G-Code-Ansicht (17.11.2026); ohne Angabe wie bisher und wie Anycubic Slicer Next: an
    const lev = opts.level === false ? 0 : 1;
    // Vibrationsausgleich / Flusskalibrierung vor dem Druck: Häkchen (21.11.2026), ohne Angabe wie bisher aus
    const vib = opts.vib ? 1 : 0, flw = opts.flow ? 1 : 0;
    const sentAt = Date.now();
    await acSend(p, 'print', 'start', kx
      ? { taskid: String(Math.floor(Math.random() * 1e6)), filename: fname, filepath: '/', task_mode: 1, filetype: 1, md5, filesize: file.size || 0,
          ams_settings: { use_ams: map.length > 0, ams_box_mapping: map },
          task_settings: { auto_leveling: lev, vibration_compensation: vib, flow_calibration: flw, dry_mode: 0, ai_settings: { status: 0, count: 0, type: 1 },
                           timelapse: { status: 0, count: 0, type: 64 }, drying_settings: { status: 0, target_temp: 0, duration: 0, remain_time: 0 }, model_objects_skip_parts: [] } }
      : { taskid: '-1', filename: fname, filetype: 1, url: '', md5, filepath: null, project_type: 1, filesize: file.size || 0,
          ams_settings: { use_ams: map.length > 0, ams_box_mapping: map },
          task_settings: { auto_leveling: lev, vibration_compensation: vib, flow_calibration: flw, dry_mode: 0, ai_settings: {}, timelapse: { status: 0 }, drying_settings: {}, model_objects_skip_parts: [] } });
    // Auf den Start warten. #84 (Denny, Kobra X, FW 2.0.2.2): nach 30 s „start_timeout“, danach meldete der Drucker „busy“ —
    // er hatte den Druck also wohl angenommen, nur nicht in der erwarteten Form. Darum bis 60 s warten, und ist er beschäftigt
    // (vor dem Start war er frei, siehe printer_busy oben), gilt das als unser Druck, auch wenn er die Datei anders nennt; dann mit SEINEM Namen weiter,
    // damit der Abgleich mit seinem Verlauf den Auftrag findet. Was er gemeldet hat, steht im Protokoll („Problem melden“).
    // Antwort des Druckers auf print/start (Live.kt print_res_start): code 200 = angenommen, sonst abgelehnt mit Grund (Prüfung 11.11.2026).
    // Vorher zählte nur der Auftrag im info-Bericht — eine Ablehnung endete erst nach 60 s als „start_timeout“.
    let seen = '', okAt = 0, softAt = 0, soft = null;
    for (let i = 0; i < 80; i++) {
      await new Promise(z => setTimeout(z, 750));
      const s2 = (await native('live_state', { key: acKey(p) }).catch(() => ({}))).state || {};
      const ph = acPhase(s2), pf = String(ph.pj.filename || '').split('/').pop();
      const res = s2.print_res_start && +s2.print_res_start.at >= sentAt ? s2.print_res_start : null;
      seen = `phase=${ph.phase || '-'} state=${(s2.info || {}).state || '-'} project=${(s2.info || {}).project ? 'yes' : 'no'} name=${!pf ? 'none' : pf === fname ? 'same' : 'other'}`
        + (res ? ` res=${res.state || '-'}/${res.code ?? '-'}` : '');
      // Auftrag mit unserer Datei zuerst: Toms Kobra X legte ihn an und antwortete trotzdem 10301 (#90, phase=init name=same)
      if (ph.busy && pf === fname) { if (softAt) diag({ a: 'send', p: 'acl', m: p.model || '', err: '', d: 'started after 10301, ' + seen }); return fname; }
      if (res && !okAt) {
        const code = res.code == null ? null : +res.code, rs = String(res.state || '').toLowerCase();
        if (code === 10101) fail('printer_busy');
        // Kobra X: 10301 „Gerät beschäftigt, Zustand unbekannt“ — bis 25 s abwarten, ob der Drucker den Auftrag doch anlegt
        if (kx && code === 10301) {
          if (!softAt) { softAt = Date.now(); soft = res; }
          if (Date.now() - softAt >= 25000) { const e = new Error('start_10301'); e.code = e.message; e.detail = seen + (soft.msg ? ' msg=' + soft.msg : ''); e.msg = soft.msg || ''; throw e; }
          if (i % 2 === 1) acSend(p, 'info', 'query').catch(() => {});
        } else if (rs === 'failed' || rs === 'stoped' || (code !== null && code !== 200 && code !== 0)) {
          const e = new Error('start_' + (code || rs)); e.code = e.message; e.detail = seen + (res.msg ? ' msg=' + res.msg : ''); e.msg = res.msg || ''; throw e;
        }
        if (code === 200 || code === 0) okAt = Date.now();
      }
      if (ph.busy && pf === fname) return fname;
      // angenommen, aber der Auftrag taucht im Bericht (noch) nicht auf: nach 20 s als gestartet werten
      if (okAt && Date.now() - okAt > 20000) { diag({ a: 'send', p: 'acl', m: p.model || '', err: '', d: 'accepted, ' + seen }); return fname; }
      if (ph.busy) { diag({ a: 'send', p: 'acl', m: p.model || '', err: '', d: (softAt ? 'started after 10301, ' : 'started, ') + seen }); return pf || fname; }   // vorher frei → das ist unser Druck
      if (i % 4 === 3) acSend(p, 'info', 'query').catch(() => {});
    }
    const e = new Error('start_timeout'); e.code = 'start_timeout'; e.detail = seen; throw e;
  },
  async creality(p, file, name, start, plan) {
    const st = await native('live_state', { key: crKey(p) }).catch(() => ({}));
    if (!st.connected) fail('unreach');
    const S = st.state || {};
    // deviceState 7 = Referenzfahrt (ha_creality_ws), 10/11 = Filament laden/entladen (F022) — CrealityPrint startet dann nicht
    if (start && (CR_BUSY.includes(+S.state) || [1, 7, 10, 11].includes(+S.deviceState))) fail('printer_busy');
    const e0 = JSON.stringify(S.err || null);   // ein alter Fehler bleibt im Stand stehen (ha_creality_ws #125) — nur neue zählen
    // Creality Print entfernt \ / : * ? " ' < > | aus dem Namen, „#“ macht Ärger
    const fname = name.replace(/[\\/:*?"'<>|#\s]+/g, '_').replace(/\.(gco|g)$/i, '.gcode');
    let up = await native('upload', { url: `http://${p.host}:${crPort(p, 'http', 80)}/upload/${encodeURIComponent(fname)}`, token: file.token, filename: fname, field: 'file', timeout: 900000 });
    // Der SimplyPrint Client lädt nach POST /upload (Name nur im Formular, beobachtet 16.11.2026) — kennt ein Drucker /upload/<name> nicht, so
    if (up.status === 404) up = await native('upload', { url: `http://${p.host}:${crPort(p, 'http', 80)}/upload`, token: file.token, filename: fname, field: 'file', timeout: 900000 });
    if (up.status !== 200 || !/ok/i.test(up.text || '')) fail('upload_' + up.status);
    if (!start) return fname;
    // Wo liegt die Datei? Den Drucker fragen (reqGcodeFile → retGcodeFileInfo2, je Datei der volle Pfad; ha_creality_ws) statt nur
    // nach Modell zu raten: Nebula Pad am Ender-3 Max Neo (#98 Denny, start_timeout) legt unter /usr/data ab, steht aber in keiner Liste.
    // Kommt keine Liste: geratener Ordner, dann der andere (/usr/data ↔ /mnt/UDISK); was geklappt hat, merkt sich der Drucker (p.crDir).
    let found = null;
    await crGet(p, { reqGcodeFile: 1 }).catch(() => {});
    for (let i = 0; i < 8 && !found; i++) {
      await new Promise(z => setTimeout(z, 400));
      const lst = ((await native('live_state', { key: crKey(p) }).catch(() => ({}))).state || {}).retGcodeFileInfo2;
      for (const e of Array.isArray(lst) ? lst : []) {
        const pth = String(typeof e === 'string' ? e : (e && (e.path || e.name)) || '');
        if (pth.split('/').pop() === fname && pth.startsWith('/')) { found = pth; break; }
      }
    }
    const guess = crDir(p, S) + '/' + fname, other = guess.startsWith('/usr/data/') ? guess.replace('/usr/data/', '/mnt/UDISK/') : guess.replace('/mnt/UDISK/', '/usr/data/');
    const paths = found ? [found] : other !== guess ? [guess, other] : [guess];
    const slots = live[p.id] && live[p.id].entry ? live[p.id].entry.slots : [];
    const multi = (plan || []).filter(x => x.g > 0 && x.slot !== 100 && slots.some(z => z.index === x.slot && !z.single));
    let errNow = e0;
    for (let k = 0; k < paths.length; k++) {
      const path = paths[k], last = k === paths.length - 1;
      if (k) diag({ a: 'send_retry', p: 'creality', m: p.model || '', d: path.replace(/\/[^/]*$/, '') });
      if (multi.length) {
        // CFS: erst Farben zuordnen (id T1A = Filament 1 … T2A = Filament 5), dann Mehrfarbdruck starten (wie Creality Print)
        const list = multi.map((x, i) => { const t = x.tool ?? i, sl = slots.find(z => z.index === x.slot) || {};
          return { id: 'T' + (Math.floor(t / 4) + 1) + 'ABCD'[t % 4], type: sl.material || 'PLA', color: sl.color || '#000000', boxId: Math.floor(x.slot / 4) + 1, materialId: x.slot % 4 }; });
        await crSet(p, { colorMatch: { path, list } });
        await new Promise(z => setTimeout(z, 800));
        await crSet(p, { multiColorPrint: { gcode: path, enableSelfTest: 0 } });
      } else await crSet(p, { opGcodeFile: 'printprt:' + path, enableSelfTest: 0 });
      // Falscher Ordner: der Drucker meldet einen Fehler oder tut nichts → nach ~10 s den anderen Ordner, beim letzten bis 30 s warten
      let errSeen = null;
      for (let i = 0; i < (last ? 40 : 13); i++) {
        await new Promise(z => setTimeout(z, 750));
        const s2 = (await native('live_state', { key: crKey(p) }).catch(() => ({}))).state || {};
        if ((CR_BUSY.includes(+s2.state) || +s2.deviceState === 1) && String(s2.printFileName || '').split('/').pop() === fname) {
          const dir = path.replace(/\/[^/]*$/, '');
          if (p.crDir !== dir) { p.crDir = dir; persist(); }
          return fname;
        }
        if (s2.err && +s2.err.errcode && i > 2 && JSON.stringify(s2.err) !== errNow) {
          errSeen = new Error('start_' + (s2.err.key || s2.err.errcode)); errSeen.code = errSeen.message; errSeen.detail = JSON.stringify(s2.err).slice(0, 120);
          errNow = JSON.stringify(s2.err); break;
        }
      }
      if (last) { if (errSeen) throw errSeen; fail('start_timeout'); }
    }
  },
  async flashforge(p, file, name, start, plan, opts = {}) {
    // Schritt + Meldung des Android-/Node-Teils ins Protokoll (#25: nur „SocketException“, ohne Schritt und ohne Text)
    const step = (s, pr) => pr.catch(e => { if (!e.detail) e.detail = s + (e.data && e.data.msg ? ': ' + e.data.msg : ''); throw e; });
    const d = (await step('detail', ffPost(p, '/detail'))).detail || {};
    const stt = String(d.status || '').toLowerCase();
    // Creator 5 / 5 Pro (PID 40/41): Werkzeugwechsler, die 4 Köpfe erscheinen als die 4 Fächer der „Materialstation“. Eigener Startweg
    // wie die FlashForge-App (ff-5mp-api-ts JobControl startCreator5Job, „confirmed against a live Creator 5“): hochladen OHNE Start,
    // dann POST /printGcode mit materialMappings; kein firstLayerInspection-Kopf (gibt es am C5 nicht). Meldung #25 (20.11.2026,
    // Creator 5 Pro FW 2.0.0): Upload mit printNow=true wurde angenommen (Druckstart-Meldung „ok“, 2×), gedruckt hat er nicht.
    const c5 = [0x28, 0x29].includes(+d.pid) || /creator 5/i.test(p.model || '');
    if (start && FF_BUSY.includes(stt)) fail('printer_busy');
    // „Platte frei“ vor jedem Start, wie der SimplyPrint Client (beobachtet 16.11.2026 am AD5X-Nachbau: immer direkt vor /uploadGcode).
    // Nach „fertig“/„abgebrochen“ wartet der Drucker sonst auf diese Bestätigung und nimmt keinen neuen Druck an. Creator 5: nur dann
    // (die FlashForge-App schickt vor /printGcode nichts dergleichen).
    if (start && !c5 && !['completed', 'cancel'].includes(stt)) await ffPost(p, '/control', { payload: { cmd: 'stateCtrl_cmd', args: { action: 'setClearPlatform' } } }).catch(() => {});
    if (['completed', 'cancel'].includes(stt)) {
      await ffPost(p, '/control', { payload: { cmd: 'stateCtrl_cmd', args: { action: 'setClearPlatform' } } }).catch(() => {});
      // /control bestätigt nur den Empfang — bis „ready“ warten, sonst lehnt der Upload mit „busy“ ab (Prüfung 11.11.2026)
      for (let i = 0; i < 8; i++) { await new Promise(z => setTimeout(z, 400)); const s_ = String(((await ffPost(p, '/detail').catch(() => ({}))).detail || {}).status || '').toLowerCase(); if (s_ && !['completed', 'cancel'].includes(s_)) break; }
    }
    let fname = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.(gco|g)$/i, '.gcode');
    const slots = live[p.id] && live[p.id].entry ? live[p.id].entry.slots : [];
    // Nur beim Starten: der Drucker behält hochgeladene Zuordnungen bis zum nächsten Druckende und wendet sie sonst auf einen späteren an
    let used = (start ? plan || [] : []).filter(x => x.g > 0 && slots.some(z => z.index === x.slot && !z.single)).slice(0, 4);
    let maps = used.map((x, i) => {
      const sl = slots.find(z => z.index === x.slot) || {};
      return { toolId: x.tool ?? i, slotId: x.slot + 1, materialName: sl.material || 'PLA', toolMaterialColor: (sl.color || '#ffffff').toUpperCase(), slotMaterialColor: (sl.color || '#ffffff').toUpperCase() };
    });
    // Firmware erwartet toolId 0–3, slotId 1–4 (ff-5mp-api validate…MaterialMappings) — Werte außerhalb nie an den Drucker schicken
    const badMap = maps.filter(m => !(m.toolId >= 0 && m.toolId <= 3 && m.slotId >= 1 && m.slotId <= 4));
    if (badMap.length) {
      diag({ a: 'ff_map', p: 'flashforge', m: p.model || '', err: 'range', d: JSON.stringify(badMap.map(m => [m.toolId, m.slotId])) });
      used = used.filter((x, i) => !badMap.includes(maps[i])); maps = maps.filter(m => !badMap.includes(m));
    }
    // AD5X/Creator 5 wenden materialMappings nur bei .3mf an, bei .gcode druckt Werkzeug n aus Fach n (ff-5mp-api-ts JobControl.ts +
    // CHANGELOG 2.1.0, Flashforge-Hilfe AD5X; zweite Prüfung 11.11.2026). Der SimplyPrint Client schickt deshalb eine .gcode.3mf mit
    // UNVERÄNDERTEN T-Nummern (Orca: T = Filament − 1) und ordnet über materialMappings zu (beobachtet 16.11.2026) — so jetzt auch wir.
    // Vorher schrieben wir die T-Nummern im G-Code aufs Fach um (remap_tools), ungetestet an einem echten Gerät.
    let sendFile = file;
    // Creator 5 (22.11.2026): Druckt jedes Werkzeug aus „seinem“ Kopf (T0 → Kopf 1, T1 → Kopf 2 …), reicht die reine .gcode OHNE Hülle und
    // ohne Zuordnung — ohne Zuordnung druckt die Firmware Werkzeug n aus Kopf n+1 (ff-5mp-api CHANGELOG) und muss nichts auspacken.
    // Anlass: Druckstarts 50–72 (App UND Agent) — /printGcode angenommen, danach Drucker 1–3 Min. nicht erreichbar; gemeinsam war nur
    // unsere selbst gepackte .gcode.3mf. Sonst (anderer Kopf, mehrfarbig quer) .gcode.3mf mit slice_info wie Flash Studio (c5Extra).
    // Creator 5 mit vollständiger Projektdatei vom Slicer (22.11.2026, file.full3mf aus sliceSend): so sendet der Flashforge-Slicer
    // selbst (Orca-Flashforge 1.7.15 SendToPrinter.cpp, C5/C5P): IMMER „<Name>.3mf“ (Orca-Export mit G-Code, ohne Modell), Material-
    // station fest an, Zuordnung für jedes Werkzeug — auch 1:1. Reine .gcode und unsere selbst gepackte Hülle benutzt er nie; an der
    // Hülle stürzte der Drucker ab (#26). Start bleibt in zwei Schritten (/printGcode wie die FlashForge-App).
    // 0.19.4: Druckt jedes Werkzeug aus „seinem“ Kopf (1:1), bleibt es bei der reinen .gcode — dieser Weg ist am echten Creator 5 Pro
    // bewiesen (Druckstart 77, App 0.19.2, 22.11.2026: „direkt drucken hat geklappt“). Die vollständige Datei nur, wo sonst unsere Hülle käme.
    const c5one = c5 && maps.length > 0 && maps.every(m => m.slotId === m.toolId + 1);
    // file.full3mf = Abruf-Funktion aus sliceSend (0.19.5): die Datei wird erst hier und nur bei Bedarf geladen (bei 1:1 nie)
    const c5full = c5 && start && maps.length > 0 && !c5one && typeof file.full3mf === 'function' ? await file.full3mf() : null;
    const toolCnt = maps.length;
    const c5plain = !c5full && c5one && !/\.3mf$/i.test(fname);
    if (c5plain) maps = [];
    if (c5full) { fname = fname.replace(/\.gcode$/i, '').replace(/\.3mf$/i, '') + '.3mf'; sendFile = c5full; }
    else if (maps.length && !/\.3mf$/i.test(fname)) {
      const base = fname.replace(/\.gcode$/i, '');
      fname = base + '.gcode.3mf';
      // Creator 5: Modellkennung wie im Orca-Export (printer_model_id = model_id des Orca-Profils, z. B. „Flashforge-Creator-5-Pro“)
      const mid = c5 ? (/creator 5 pro/i.test(p.model || '') || +d.pid === 0x29 ? 'Flashforge-Creator-5-Pro' : 'Flashforge-Creator-5') : null;
      const extra = c5 ? c5Extra(used, slots, plan && plan.time_s, file.plate_png, mid, { ...(await c5Meta(file)), heads: +d.nozzleCnt || 4, name: base })
                       : orcaExtra(used, slots, plan && plan.time_s, file.plate_png);
      sendFile = await step('make3mf', native('make3mf', { token: file.token, name: fname, extra }));
    }
    const c5way = c5full ? 'full3mf' : c5plain ? 'gcode' : /\.3mf$/i.test(fname) ? '3mf' : 'gcode';
    // Flusskalibrierung vor dem Druck: Häkchen (21.11.2026), nur AD5X/Creator 5 (calOf) — sonst wie bisher aus
    const flw = !!opts.flow && !!(calOf(p) || {}).flow;
    // Bett nivellieren: Häkchen (0.19.4), Vorgabe an wie im Flashforge-Slicer — vorher fest an
    const lev = opts.level !== false;
    const headers = c5
      ? { serialNumber: p.serial || '', checkCode: p.code || '', fileSize: String(sendFile.size || 0), printNow: 'false', levelingBeforePrint: String(lev),
          flowCalibration: String(flw), timeLapseVideo: 'false', useMatlStation: String(maps.length > 0), gcodeToolCnt: String(toolCnt) }
      : { serialNumber: p.serial || '', checkCode: p.code || '', fileSize: String(sendFile.size || 0), printNow: String(!!start), levelingBeforePrint: String(lev),
          flowCalibration: String(flw), firstLayerInspection: 'false', timeLapseVideo: 'false', useMatlStation: String(maps.length > 0),
          gcodeToolCnt: String(maps.length), materialMappings: btoa(JSON.stringify(maps)) };
    const up = await step('upload', native('upload', { url: `http://${p.host}:${ffPort(p)}/uploadGcode`, token: sendFile.token, filename: fname, field: 'gcodeFile', headers, timeout: 900000 }))
      .finally(() => { if (sendFile !== file && sendFile !== c5full) native('fileDrop', { token: sendFile.token }).catch(() => {}); });
    let r = {}; try { r = JSON.parse(up.text || '{}'); } catch (e) {}
    if (up.status !== 200 || +r.code !== 0) fail(+r.code === 1 ? 'login' : FF_ERR[r.code] || 'upload_' + (up.status !== 200 ? up.status : 'c' + r.code));
    if (!c5 || !start) return fname;
    // Creator 5: Start mit Zuordnung (Felder wie die FlashForge-App; Wahrheitswerte als JSON, nicht als Text)
    await step('printGcode', ffPost(p, '/printGcode', { fileName: fname, levelingBeforePrint: lev, flowCalibration: flw, timeLapseVideo: false,
                                                        ...(maps.length ? { materialMappings: maps } : {}) }, 15000));
    // Angenommen heißt nicht gedruckt (#25) — erst als gestartet zählen (und abbuchen), wenn der Drucker etwas anderes als „bereit“ meldet
    let wait = 25000; try { wait = +localStorage.getItem('amp_ff_wait_ms') || wait; } catch (e) {}   // Test-Schalter
    const seen = [], until = Date.now() + wait;
    while (Date.now() < until) {
      await new Promise(z => setTimeout(z, 1500));
      const s_ = String(((await ffPost(p, '/detail', null, 3500).catch(() => ({}))).detail || {}).status || '').toLowerCase();
      if (s_ && seen[seen.length - 1] !== s_) seen.push(s_);
      if (s_ && !['ready', 'completed', 'cancel', 'error'].includes(s_)) { diag({ a: 'ff_c5', p: 'flashforge', m: p.model || '', err: '', d: c5way + ' ' + s_ }); return fname; }
      if (s_ === 'error') break;
    }
    // Weg (gcode = reine Datei, 3mf = Hülle) im Protokoll — so zeigt die nächste Meldung, welcher Weg am echten Gerät scheitert
    const e = new Error('start_timeout'); e.code = 'start_timeout'; e.detail = 'c5 ' + c5way + ' printGcode ok, ' + (seen.join('>') || 'no detail'); throw e;
  },
  async cc2(p, file, name, start, plan, opts = {}) {
    // „Beschäftigt“ hat drei Quellen — für die Druckstart-Meldung getrennt (20.11.2026: CC2 2× printer_busy, Ursache nicht erkennbar).
    // Die Oberfläche sieht weiter „printer_busy“ (e.message), nur e.code unterscheidet: vorher gemeldet / Upload 429 / Startbefehl 1009
    const busy = w => { const e = new Error('printer_busy'); e.code = 'busy_' + w; throw e; };
    const st = await native('live_state', { key: ccKey(p) }).catch(() => ({}));
    if (!st.connected || !st.registered) fail('unreach');
    if (start && ccPhase((st.state || {}).status || {}).busy) busy('check');
    const fname = name.replace(/\s+/g, '_').replace(/\.(gco|g)$/i, '.gcode');
    const md5 = (await native('md5', { token: file.token })).md5;
    // Alle Stücke über EINE Keep-Alive-Verbindung (neue TCP-Verbindung je Stück → ab dem 4. Stück 429); nach 429 nie wiederholen (zerstört die Datei)
    const up = await native('putChunks', { url: `http://${p.host}:${ccPort(p, 'http', 80)}/upload`, token: file.token, chunk: 1048576,
                                           headers: { 'X-File-Name': fname, 'X-File-MD5': md5, 'X-Token': p.code || '123456' } }).catch(e => ({ status: 0, text: e.message }));
    if (up.status === 429) busy('upload');
    if (up.status !== 200 || up.ec) fail(up.status === 401 || up.ec === 1000 ? 'login' : up.ec ? 'upload_ec' + up.ec : 'upload_' + up.status);
    if (!start) return fname;
    const slots = live[p.id] && live[p.id].entry ? live[p.id].entry.slots : [];
    const slot_map = (plan || []).filter(x => x.g > 0 && !(slots.find(z => z.index === x.slot) || {}).single).map((x, i) => ({ t: x.tool ?? i, canvas_id: Math.floor(x.slot / 4), tray_id: x.slot % 4 }));
    // printer_check immer ausdrücklich: Die Firmware merkt sich den letzten Wert, weglassen = „wie beim letzten Auftrag“ (gemessen von der
    // Home-Assistant-Integration auf FW 02.01.00.00, Elegoo-SDK schickt es immer; zweite Prüfung 11.11.2026). Antwort erst nach dem
    // mechanischen Ablauf (> 15 s möglich) → Druckbeginn zählt auch
    const started = s => { const S_ = s.status || {}; return ccPhase(S_).busy && String((S_.print_status || {}).filename || '').split('/').pop() === fname; };
    // Wie der SimplyPrint Client (beobachtet 16.11.2026): erst Methode 1046 (Datei auf dem Drucker abfragen), dann 1020 mit printer_check: true.
    // Die Antwort auf 1046 wertet der Client nicht aus (startet auch bei Fehler) — hier ebenso: kurz warten, Fehler ignorieren.
    await ccCall(p, 1046, { storage_media: 'local', filename: fname }, 4000).catch(() => {});
    await new Promise(z => setTimeout(z, 2100));   // ≥ 2 s zwischen Befehlen
    const busyStart = e => { if (e.message === 'printer_busy') e.code = 'busy_start'; throw e; };   // 1009 auf den Startbefehl
    // printer_check = Schalter „Auto bed leveling“ in ElegooSlicer (elegoo-link: printer_check = autoBedLeveling; FW 02.01.00.00 gemessen:
    // true nivelliert IMMER ~200 s, false nie). Bis 0.19.0 fest true → jeder Druck aus der App nivellierte (António, 21.11.2026).
    // Häkchen in Druck-/G-Code-Ansicht; ohne Angabe wie bisher an.
    const chk = opts.level !== false;
    try { await ccCall(p, 1020, { storage_media: 'local', filename: fname, config: { delay_video: false, printer_check: chk, print_layout: 'A', bedlevel_force: false, slot_map } }, 90000, started); }
    catch (e) {
      // 1026 = kein Bett-Mesh gespeichert (neuer/zurückgesetzter Drucker): Elegoos Oberfläche wiederholt dann mit Nivellieren (Prüfung 11.11.2026)
      if (e.message !== 'no_mesh') busyStart(e);
      await new Promise(z => setTimeout(z, 2100));   // ≥ 2 s zwischen Befehlen
      // ohne gespeichertes Netz geht es nur mit Nivellieren — auch wenn das Häkchen aus ist (wie ElegooSlicer)
      await ccCall(p, 1020, { storage_media: 'local', filename: fname, config: { delay_video: false, print_layout: 'A', bedlevel_force: true, printer_check: true, slot_map } }, 120000, started).catch(busyStart);
    }
    return fname;
  },
  async prusalink(p, file, name, start) {
    const st = await dj(p, 'GET', '/api/v1/status');
    if (start && PL_BUSY.includes(String((st.printer || {}).state || '').toUpperCase())) fail('printer_busy');
    const sto = ((await dj(p, 'GET', '/api/v1/storage').catch(() => ({}))).storage_list || []).find(x => x.available !== false && !x.read_only);
    if (!sto) fail('no_storage');
    const where = String(sto.path || sto.name || 'usb').replace(/^\/+|\/+$/g, '');
    // Pfad auf dem Drucker höchstens ~100 Zeichen (Buddy max_sfn_path_length 103 inkl. /usb/) → Namen kürzen, Endung behalten
    const ext_ = (/\.(bgcode|gcode|gco|g)$/i.exec(name) || ['.gcode'])[0];
    name = name.length > 90 ? name.slice(0, 90 - ext_.length).replace(/[\s._-]+$/, '') + ext_ : name;
    // Print-After-Upload nur beim Starten: ältere PrusaLink-Firmware startete auf jeden Wert hin (PrusaSlicer OctoPrint.cpp)
    const up = await native('putFile', { url: baseUrl(p, '/api/v1/files/' + encodeURIComponent(where) + '/' + encodeURIComponent(name)), token: file.token, timeout: 600000,
                                         headers: { 'Content-Type': 'application/octet-stream', ...(start ? { 'Print-After-Upload': '?1' } : {}), Overwrite: '?1' },
                                         digest: { user: p.user || 'maker', pass: p.pass || '', probe: baseUrl(p, '/api/v1/status') } });
    if (up.status === 401) fail('unauthorized');
    if (up.status >= 400) fail('upload_' + up.status);
    return name;
  },
};

/**
 * Dauerverbindung fürs Senden bereitmachen (09.11.2026, Kobra S1 im LAN-Modus: „unreach“ direkt nach dem Slicen).
 * Live.kt schließt eine Verbindung nach 90 s ohne Abfrage (Akku). In der Druckansicht fragt niemand ab, während geslict,
 * die Vorschau angesehen und der G-Code geladen wird — beim Senden war sie dann zu. Darum vor dem Senden neu öffnen und
 * bis ~12 s auf Verbindung + ersten Bericht warten (wie der Abgleich), während Upload und Start alle 20 s abfragen.
 */
const LIVE_SEND = {
  bambu: p => ({ key: 'bb_' + p.id, open: () => native('live_open', { kind: 'bambu', key: 'bb_' + p.id, host: p.host, serial: p.serial || '', code: p.code || '', port: bbPort(p, 'mqtt', 8883) }),
                 ready: st => st.connected && !!(st.state || {}).print }),
  sdcp: p => ({ key: 'sd_' + p.id, open: () => native('live_open', { kind: 'sdcp', key: 'sd_' + p.id, host: p.host, port: sdPort(p, 'ws', 3030) }),
                ready: st => st.connected && !!(st.state || {}).Status, poke: () => sdSend(p, 0) }),
  cc2: p => ({ key: ccKey(p), open: () => ccOpen(p), ready: st => st.connected && st.registered && !!(st.state || {}).status }),
  creality: p => ({ key: crKey(p), open: () => crOpen(p), ready: st => { const S = st.state || {}; return st.connected && ('state' in S || 'nozzleTemp' in S); } }),
  acl: p => ({ key: acKey(p), open: () => acOpen(p), ready: st => { const S = st.state || {}; return st.connected && !!(S.info || S.print || S.tempature || S.multiColorBox); } }),
};
async function liveReady(p) {
  const L = LIVE_SEND[kindOf(p)] ? LIVE_SEND[kindOf(p)](p) : null;
  if (!L) return null;
  let st = {}, poked = false;
  for (let i = 0; i < 24; i++) {
    try { await L.open(); st = await native('live_state', { key: L.key }); } catch (e) { st = { connected: false, err: e.message }; }
    if (L.ready(st)) break;
    if (!st.connected && ['access_code', 'login', 'lan_off', 'no_token'].includes(st.err)) break;   // falscher Code u. ä.: Warten hilft nicht
    if (st.connected && L.poke && !poked) { poked = true; L.poke().catch(() => {}); }
    await new Promise(z => setTimeout(z, 500));
  }
  if (!L.ready(st)) diag({ a: 'send_live', p: kindOf(p), m: p.model || '', err: st.connected ? 'no_report' : 'unreach', d: st.err || '' });
  return L;
}

/** Datei an den Drucker: hochladen (Fortschritt), starten, sofort abbuchen (die App sieht das Druckende vielleicht nie). */
async function printSend(inp, onProgress) {
  const p = db.printers.find(x => x.id === inp.printer) || fail('not_found');
  if (p.kind === 'cloud') fail('cloud_ro');   // Hersteller-Konto: nur lesend (19.11.2026)
  const file = inp.file || fail('no_file');
  const L = live[p.id];
  const name = String(file.name || 'print.gcode').replace(/[^\w.\- ()+]+/g, '_').replace(/^\.+/, '') || 'print.gcode';
  // G-Code-Prüfung (26.11.2026): läuft neben dem Hochladen, das Ergebnis geht nur mit der Rückmeldung zum Druckstart (startReport)
  if (inp.start && !startOff() && !inp._chk) inp._chk = gcodeCheck(file, file.name || name);
  // Modellbild für die Druckkarte (und Bambu: plate_1.png): vom Slicer mitgegeben, sonst aus dem G-Code-Kopf
  let img = inp.thumb || (inp.meta && inp.meta.thumb) || null;
  if (!img && /\.(gcode|gco|g)$/i.test(name) && file.token) img = (await fileMeta(file).catch(() => ({}))).thumb || null;
  if (!file.plate_png && /^data:image\/png;base64,/.test(img || '')) file.plate_png = img.slice(22);
  // „Platte leer?“ (Agent mit Überwachung, 17.11.2026): vor dem Start Kamerabild gegen das Referenzbild der leeren Platte (agent/src/watch.js).
  // Weicht es ab → erst nachfragen (Oberfläche schickt dann plate_ok). Ohne Agent, ohne Referenz oder ohne Bild: nichts hält auf.
  if (inp.start && !inp.plate_ok && window.AMP_WATCH && typeof AMP_WATCH.plate === 'function') {
    const pc = await AMP_WATCH.plate(p.id).catch(() => null);
    if (pc && pc.state === 'check') { diag({ a: 'plate', p: kindOf(p), m: p.model || '', err: 'check', d: 'score ' + pc.score }); const e = new Error('plate_check'); e.code = 'plate_check'; e.img = pc.img || null; throw e; }
  }
  const lv = await liveReady(p);
  const keep = lv ? setInterval(() => { native('live_state', { key: lv.key }).catch(() => {}); }, 20000) : null;
  const t0 = Date.now();
  let fname;
  try { fname = await (SEND[kindOf(p)] || SEND.moonraker)(p, file, name, !!inp.start, inp.plan || (inp.meta && inp.meta.weights ? inp.meta.weights.map((g, t) => ({ slot: t, tool: t, g })) : []),
                                                        { level: typeof inp.level === 'boolean' ? inp.level : null, vib: inp.vib === true, flow: inp.flow === true, tl: inp.tl === true }); }
  catch (e) { diag({ a: 'send', p: kindOf(p), m: p.model || '', err: e.code || e.message || 'error', d: String(e.detail || e.msg || (e.data && e.data.msg) || '').slice(0, 160) }); throw e; }   // #84: Sendefehler standen nicht im Protokoll; #25: Text des Android-Teils mit
  finally { if (keep) clearInterval(keep); }
  if (img) await jtPut(p.id, fname || name, img).catch(() => {});
  if (!inp.start) return { ok: true, started: false, file: fname };
  // Abbuchen nach Plan: Werkzeug → Fach (ttg_map, sonst gleiche Nummer), ein Kopf → aktive Spule
  const md = inp.meta || { weights: [], colors: [], types: [] };
  const entry = L && L.entry;
  const single = !entry || entry.slots.every(s => s.single);
  const ttg = (entry && entry.ttg_map) || [];
  const plan = [], fa = adjOf(p.id);   // Verbrauchsausgleich dieses Druckers
  // Vom Slicer-Server: Gramm je Fach schon bekannt (G-Code ist auf diese Fächer umgeschrieben)
  for (const pl of inp.plan || []) {
    if (!(pl.g > 0)) continue;
    const slot = single || pl.slot < 0 ? 0 : +pl.slot;
    const sl = slotRow(p.id, slot);
    const sp = sl.spool_id ? db.spools.find(s => s.id === sl.spool_id) : null;
    plan.push({ tool: slot, slot, raw: +pl.g, g: +pl.g * fa, f: fa, spool_id: sp ? sp.id : null, color: sp ? sp.color_hex : pl.color || null, material: sp ? sp.material : pl.material || null });
  }
  if (!inp.plan) (md.weights || []).forEach((w, tI) => {
    if (!(w > 0)) return;
    const slot = single ? 0 : (inp.map && inp.map[tI] != null ? +inp.map[tI] : (ttg[tI] ?? tI));
    const sl = slotRow(p.id, slot);
    const sp = sl.spool_id ? db.spools.find(s => s.id === sl.spool_id) : null;
    plan.push({ tool: tI, slot, raw: w, g: w * fa, f: fa, spool_id: sp ? sp.id : null, color: sp ? sp.color_hex : (md.colors[tI] || null), material: sp ? sp.material : (md.types[tI] || null) });
  });
  if (single && plan.length > 1) {   // mehrere Werkzeuge auf einem Kopf (selten): zusammenfassen
    const g = plan.reduce((a, x) => a + x.g, 0), raw = plan.reduce((a, x) => a + x.raw, 0); plan.splice(0, plan.length, { ...plan[0], g, raw });
  }
  // Wettlauf (12.11.2026, im Gesamttest gefunden): Lief während des Startens ein Abgleich (Druckerseite, Agent im Hintergrund),
  // steht der Druck schon als FREMDER Auftrag da — dann den übernehmen statt einen zweiten anzulegen. Sonst blieb unserer ewig
  // „läuft“ (kein Verlaufseintrag mehr frei) und der fremde ungebucht.
  const bn = f => String(f || '').split('/').pop();
  const early = db.jobs.find(x => x.printer_id === p.id && !x.ours && bn(x.file) === bn(fname) && !['booked', 'before_connect'].includes(x.state) && ts(x.start) >= t0 - 300000);
  if (early) diag({ a: 'send_join', p: kindOf(p), m: p.model || '', d: 'job ' + early.id });
  const fresh = { grams: plan.reduce((a, x) => a + x.g, 0), plan, paint: plan.map(x => ({ index: x.slot, g: x.g, color: x.color, material: x.material })),
                  state: plan.length ? 'open' : 'no_data', ours: true };
  const j = early ? Object.assign(early, fresh)
    : { id: nextId('job'), ref: null, ext_id: null, printer_id: p.id, file: fname, title: jobTitle(fname), status: 1, start: now(), end: null, print_s: 0, ...fresh };
  for (const pl of plan) {
    const sp = pl.spool_id ? db.spools.find(s => s.id === pl.spool_id) : null;
    if (sp) book(sp, pl.g, 'print', j.title, 'app:' + j.id, p.name, true, { pid: p.id, raw: pl.raw });
    else { const sl = slotRow(p.id, pl.slot); sl.pending_g = (sl.pending_g || 0) + pl.raw; }   // offen ohne Faktor, der kommt beim Nachbuchen
  }
  // ref erst durch den Moonraker-Verlauf (mr:<drucker>:<nummer>); die Buchungen tragen bis dahin app:<auftrag>
  j.cost = costOf(j);
  if (!early) db.jobs.push(j);
  if (L) { L.histAt = 0; }
  persist(true);
  return { ok: true, started: true, job: j.id, file: fname };
}

// ── Slicen über OrcaSlicer: Container „AllMyPrinters Slicer“ (10.11.2026) ──────────────
// Standard: unser Container auf allmyprinters.com. Oder ein eigener (Docker im Heimnetz, Einstellungen → Slicer) — dann
// laufen alle Aufrufe über den Android-Teil (die App-Seite ist https, die WebView blockt http ins Heimnetz).
// Ohne Konto: das Gerät hat eine zufällige Kennung. Senden und Abbuchen macht das Handy selbst im Heimnetz.
// Testumgebung kann den Server umlenken (localStorage amp_slice_url), die App selbst nie.
const SLICE_DEFAULT = 'https://allmyprinters.com/slicer/';
const SLICE_API_MIN = 1;   // Schnittstellen-Stufe, die diese App-Version braucht (?a=version → api)
function slicer() {
  let test = null; try { test = localStorage.getItem('amp_slice_url'); } catch (e) {}
  if (test) return { url: test, own: false };
  const s = (db && db.settings && db.settings.slicer) || {};
  return s.mode === 'own' && /^https?:\/\/[^\s\/?#]+/i.test(s.url || '') ? { url: s.url, own: true } : { url: SLICE_DEFAULT, own: false };
}
const slcUrl = (q, base) => { const u = base || slicer().url; return q ? u + (u.includes('?') ? '&' : '?') + new URLSearchParams(q) : u; };
/** Adresse aus dem Eingabefeld: ohne Schema → http://, ohne Abfrageteil, Leerzeichen weg. */
function slcNorm(u) {
  u = String(u || '').trim().replace(/[?#].*$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
  return /^https?:\/\/[^\s\/?#]+(\/[^\s]*)?$/i.test(u) ? u : '';
}
/** Modell-Datei aus der Oberfläche an den Android-Teil (stückweise, 1 MB) → Kennung für den Upload. */
async function slcStash(f) {
  let token = '';
  for (let o = 0; o < f.size || !token; o += 1 << 20) {
    const b = new Uint8Array(await f.slice(o, o + (1 << 20)).arrayBuffer());
    let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    token = (await native('stash', { token, b64: btoa(bin), name: f.name })).token;
  }
  return token;
}
function deviceId() {
  if (!/^[0-9a-f]{32}$/.test(db.settings.device || '')) {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    db.settings.device = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); persist();
  }
  return db.settings.device;
}
const sliceHdr = () => ({ 'X-AMP-Device': deviceId() });
const _fetch = window.fetch.bind(window);
async function server(a, q = {}, body = null) {
  const { url, own } = slicer();
  if (own) {
    let r;
    try {
      r = body ? await native('http', { url, method: 'POST', headers: { ...sliceHdr(), 'Content-Type': 'application/json' }, body: JSON.stringify({ a, ...body }), timeout: 30000 })
               : await native('http', { url: slcUrl({ a, ...q }, url), headers: sliceHdr(), timeout: 30000 });
    } catch (e) { fail('slicer_own'); }
    try { return JSON.parse(r.text); } catch (e) { return { error: 'http_' + r.status }; }
  }
  let r;
  try {
    r = body ? await _fetch(url, { method: 'POST', headers: { ...sliceHdr(), 'Content-Type': 'application/json' }, body: JSON.stringify({ a, ...body }) })
             : await _fetch(slcUrl({ a, ...q }, url), { headers: sliceHdr() });
  } catch (e) { fail('nonet'); }
  const d = await r.json().catch(() => ({ error: 'http_' + r.status }));
  return d;
}
/** Vorschau (binär). Eigener Slicer über den Android-Teil — der entpackt gzip schon, wie der Browser auch. */
async function slcPreview(job) {
  const { url, own } = slicer();
  if (!own) return _fetch(slcUrl({ a: 'preview', job }, url), { headers: sliceHdr() });
  const r = await native('http', { url: slcUrl({ a: 'preview', job }, url), headers: sliceHdr(), binary: true, max: 96 << 20, timeout: 60000 });
  const bin = Uint8Array.from(atob(r.b64 || ''), c => c.charCodeAt(0));
  return new Response(bin, { status: r.status, headers: { 'Content-Type': r.type || 'application/octet-stream' } });
}
const PROF_REV = 2;
const profBedStale = pf => !!pf && pf.bed === null && Date.now() - (pf.at || 0) > 3600e3;
/** Orca-Profil zum Drucker (einmal vom Server, dann gemerkt); eigene Wahl über print_profile. */
async function profileOf(p) {
  // nozzles (Slicer ≥ 1.0.7): fehlt das Feld in einem älteren gemerkten Profil, einmal neu fragen
  // bed (Slicer ≥ 1.0.10, „passt auf“ in der Bibliothek): fehlt der Schlüssel ganz, einmal neu fragen (ältere Server liefern null → kein Dauerfragen)
  // bed null (alter Slicer): nach einer Stunde neu fragen — sonst blieb „Platte unbekannt“ nach dem Container-Update bis zu 7 Tage (User 19.11.2026, Slicer 1.0.10)
  // rev 2 (24.11.2026, Meldung #33): Slicer erkennt den Kopfwechsel des Snapmaker U1 (switches) — gemerkte Profile einmal neu fragen,
  // sonst blieben die Köpfe 2–4 beim Slicen bis zu 7 Tage gesperrt
  if (p.prof && p.prof.rev === PROF_REV && p.prof.at > Date.now() - 7 * 864e5 && (p.prof.chosen || p.prof.model === (p.model || '')) && Array.isArray(p.prof.nozzles) && 'bed' in p.prof && !profBedStale(p.prof)) return p.prof;
  const d = await server('printer_info', p.prof && p.prof.chosen ? { vendor: p.prof.vendor, machine: p.prof.machine }
    : kindOf(p) === 'bambu' && p.model ? { vendor: 'BBL', machine: p.model + ' 0.4 nozzle' } : { model: p.model || '' });
  if (d.error) return p.prof || null;
  p.prof = { vendor: d.vendor, machine: d.machine, exact: !!d.exact, switches: d.switches_by_t, caps: d.caps, materials: d.materials,
             // Düsengrößen mit Orca-Profil (Druckansicht → Düse und Temperatur); alter Slicer ohne Angabe → null = beim nächsten Mal neu fragen
             // (mit [] blieb die Liste nach dem Container-Update bis zu 7 Tage leer, 15.11.2026)
             nozzles: Array.isArray(d.nozzles) ? d.nozzles : null,
             bed: Array.isArray(d.bed) && d.bed.length >= 2 && d.bed.slice(0, 2).every(v => +v > 0) ? d.bed.slice(0, 3).map(v => v == null ? null : +v) : null,
             chosen: !!(p.prof && p.prof.chosen), model: p.model || '', at: Date.now(), rev: PROF_REV };
  persist();
  return p.prof;
}
/**
 * Fach belegt, aber ohne Material vom Drucker (Meldung #33, 24.11.2026: Snapmaker U1 meldet bei Spulen ohne RFID-Chip „NONE“,
 * solange am Display kein Typ eingestellt ist; ebenso AFC/Happy Hare ohne Angabe). Bisher war der Kopf im Slicen-Dialog gesperrt.
 * Jetzt: Material + Farbe der Spule, die dem Fach in der App zugeordnet ist — sonst das im Dialog gewählte (pick = {index, material}).
 */
function slotMat(s, pick) {
  if (s.material || !s.filled) return { material: s.material || null, color: s.color || null, need: false };
  const sp = s.spool_id ? db.spools.find(x => x.id === s.spool_id && !x.archived_at) : null;
  if (sp && sp.material) return { material: String(sp.material).slice(0, 30), color: sp.color_hex || s.color || null, need: false };
  if (pick && pick.index === s.index && pick.material) return { material: pick.material, color: s.color || null, need: false };
  return { material: null, color: s.color || null, need: true };
}
/** Beschreibung für den Server: Profil + Fächer wie ps_printers() sie braucht. */
function printerJson(p, e, pick) {
  return { id: p.id, kind: kindOf(p), name: p.name, model: p.model || '', vendor: p.prof && p.prof.vendor, machine: p.prof && p.prof.machine,
           // filled: belegt ohne Materialangabe (Happy Hare/AFC) — zählt beim Slicer als Mehrfarbeinheit (zweite Prüfung 11.11.2026)
           slots: ((e && e.slots) || []).map(s => { const m = slotMat(s, pick); return { index: s.index, label: s.label, material: m.material, color: m.color, single: !!s.single, filled: !!s.filled }; }),
           ttg: (e && e.ttg_map) || [] };
}
/** Wie print_printers in filament/print_api.php — aus den eigenen Druckern. */
async function slicePrinters() {
  const d = await printers({});
  const es = d.connections.length ? d.connections[0].printers : [];
  const out = [];
  let mats = ['PLA', 'PLA+', 'PLA Silk', 'PETG', 'ABS', 'ASA', 'TPU'];
  for (const p of db.printers) {
    if (p.kind === 'cloud') continue;   // Hersteller-Konto: nur ansehen, kein Druckziel
    const e = es.find(x => x.id === p.id) || { slots: [] };
    const prof = await profileOf(p).catch(() => p.prof || null);
    if (prof && prof.materials) mats = prof.materials;
    const slotsIn = (e.slots || []).filter(s => !s.single && (s.material || s.filled));   // Happy Hare/AFC: belegt ohne Materialangabe (Prüfung 11.11.2026)
    const hasBox = slotsIn.length > 0, any = hasBox;
    let tool0 = null, ttg = null;
    if (hasBox && !['bambu', 'sdcp', 'cc2', 'creality', 'flashforge', 'acl'].includes(kindOf(p))) {   // Bambu/Elegoo: Fach kommt über den Startbefehl, nicht über T im G-Code
      ttg = (e.ttg_map && e.ttg_map.length ? e.ttg_map : e.slots.map(s => s.index)).map(Number);
      if (prof && prof.switches === false) tool0 = ttg[0] ?? 0;
    }
    // need_mat: belegt, Material unbekannt, keine Spule zugeordnet → im Dialog wählbar, Material daneben (amp-views ampSlotMat, Meldung #33)
    const slots = (e.slots || []).filter(s => !s.single).map(s => { const m = slotMat(s); return { index: s.index, label: s.label, material: m.material, color: m.color, need_mat: m.need, remain: null,
      locked: (tool0 !== null && s.index !== tool0) || (ttg !== null && tool0 === null && !ttg.includes(s.index)) }; });
    // „über …“ in der Druckansicht: der echte Weg (Anycubic LAN, Bambu, Elegoo …), nicht pauschal Klipper
    const via = { sdcp: 'elegoo', cc2: 'elegoo', acl: 'acl' }[kindOf(p)] || kindOf(p);
    out.push({ key: 'moonraker:' + p.id, provider: 'moonraker', id: p.id, via, name: p.name, model: p.model || '', online: !!e.online, busy: !!e.busy,
               // beta: Hinweis „noch in der Testphase“ in der Druckansicht — Flashforge (22.11.2026, User), ffBeta: ohne Creator 5 / 5 Pro
               img: p.img || '', can_print: true, testers_only: false, beta: ffBeta(p), devmode_off: kindOf(p) === 'bambu' && e.amp_devmode === false, box: hasBox, slots, slot_mode: any ? 'slots' : 'material', tool0, ttg: tool0 === null ? ttg : null,
               machine: prof ? prof.machine : null, vendor: prof ? prof.vendor : null, exact: prof ? prof.exact : false, chosen: !!(prof && prof.chosen),
               // Häkchen „Bett vor dem Druck nivellieren“ (17.11.2026, Wunsch YvonneOliver Community #39): Anycubic LAN schickt die Wahl als
               // task_settings.auto_leveling im Startbefehl (vorher fest 1). Modus wie die Anycubic-Cloud auf 3DSEARCH (ps_level_info 'cloud'), Vorgabe an
               // Elegoo CC2 (21.11.2026, Tester António: „druckt aus der App, nivelliert jedes Mal“): Wahl geht als printer_check in Methode 1020
               level: lvlOf(p) ? { mode: 'cloud', def: true } : { mode: 'none' }, cal: calOf(p), cfs: false, caps: prof ? prof.caps : null, nozzles: prof && Array.isArray(prof.nozzles) ? prof.nozzles : [],
               // Mehrfarbig auch bei Druckern, deren Startbefehl die Fächer zuordnet (10.11.2026, User: „kommt keine Farbzuordnung, er würde
               // einfarbig drucken“) — der Slicer-Server liefert dann je Werkzeug Gramm + T-Nummer (amp_printer tools seq/keep)
               multi: hasBox && (['bambu', 'sdcp', 'cc2', 'creality', 'flashforge', 'acl'].includes(kindOf(p)) || (tool0 === null && ttg !== null)) });
  }
  return { printers: out, materials: mats, upload_only: ['moonraker'], files: [], files_limit: 0, files_free: 0, files_sup: 0, pq_projects: [] };
}
const pkOf = key => db.printers.find(p => 'moonraker:' + p.id === key) || null;
/** Slice-Formular (FormData von /filament) an den Server, mit Druckerbeschreibung. */
async function sliceForm(fd) {
  const p = pkOf(fd.get('printer'));
  if (!p) return { error: 'no_printer' };
  if (fd.get('a') !== 'print_slice') return { error: 'unsupported' };
  // Weiche der App ohne Agent (24.11.2026): Hinweis mit Link zur Agent-Anleitung (amp-views ampPlanHint) + Text in der Druckansicht (psd_err_plan_*)
  const need = aplSliceNeed(fd, slicer().own);
  if (need) { window.AMP_ev('plan_hint', { f: need }); return { error: 'plan_' + need }; }
  await profileOf(p).catch(() => {});
  fd.set('a', 'slice');
  // Material für ein Fach, das der Drucker ohne Material meldet und dem keine Spule zugeordnet ist (Meldung #33, ampSlotMat)
  const sm = String(fd.get('slot_mat') || '').trim(); fd.delete('slot_mat');
  const pick = /^[\w+ .\/-]{1,30}$/.test(sm) ? { index: +fd.get('slot'), material: sm } : null;
  fd.set('printer_json', JSON.stringify(printerJson(p, live[p.id] && live[p.id].entry, pick)));
  const { url, own } = slicer();
  if (own) {
    // Felder in Reihenfolge (Namen dürfen sich wiederholen), Dateien erst an den Android-Teil, dann ein Upload
    const fieldList = [], files = [], toks = [];
    try {
      for (const [k, v] of fd.entries()) {
        if (v instanceof Blob) { const token = await slcStash(v); toks.push(token); files.push({ token, field: k, filename: v.name || 'model' }); }
        else fieldList.push([k, String(v)]);
      }
      const r = await native('upload', { url, headers: sliceHdr(), fieldList, files, timeout: 600000 });
      try { return JSON.parse(r.text); } catch (e) { return { error: r.status === 413 ? 'too_big' : 'http_' + r.status }; }
    } catch (e) { return { error: 'slicer_own' }; }
    finally { toks.forEach(token => native('fileDrop', { token }).catch(() => {})); }
  }
  try {
    const r = await _fetch(url, { method: 'POST', headers: sliceHdr(), body: fd });
    return await r.json().catch(() => ({ error: r.status === 413 ? 'too_big' : 'http_' + r.status }));
  } catch (e) { return { error: 'nonet' }; }
}
/** Verbindungstest für Einstellungen → Slicer: antwortet dort ein AllMyPrinters Slicer, passt die Schnittstelle? */
// Funktionen der App, die einen neueren Container brauchen (10.11.2026): Container meldet sie unter ?a=version → features.
// Fehlt eine, sagt die App es Selbsthostern (Druckansicht, Einstellungen) — sie blockiert nichts, der Druck liefe nur ohne die Funktion.
const SLICE_FEATURES = { multi_start: '1.0.3', nozzle_temp: '1.0.7', bed: '1.0.10' };   // bed: Plattengröße für „Passt auf“ und den Editor (19.11.2026)   // nozzle_temp: Düsengröße + Temperatur in der Druckansicht   // Mehrfarbig, wo der Startbefehl die Fächer zuordnet (Bambu, Anycubic LAN, Elegoo, Creality, Flashforge)
// Fehler älterer Container, die ein Update behebt (17.11.2026) — Versionsvergleich statt Kennung, betroffen ab „from“ bis vor „to“.
// bambu_start: 1.0.4–1.0.7 (Orca 2.5) lösten „include“ der Bambu-Profile nicht auf → allgemeiner Start-G-Code, kein Laden aus dem AMS (Meldung #22)
const SLICE_FIXES = { bambu_start: { from: '1.0.4', to: '1.0.8' } };
const slcVcmp = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const slcFixes = d => Object.keys(SLICE_FIXES).filter(f => /^\d+\.\d+\.\d+/.test(String((d && d.version) || ''))
  && slcVcmp(d.version, SLICE_FIXES[f].from) >= 0 && slcVcmp(d.version, SLICE_FIXES[f].to) < 0);
const slcMissing = d => [...Object.keys(SLICE_FEATURES).filter(f => !(Array.isArray(d && d.features) && d.features.includes(f))), ...slcFixes(d)];
const slcNeed = miss => miss.map(f => SLICE_FEATURES[f] || (SLICE_FIXES[f] || {}).to).sort(slcVcmp).pop() || null;
async function slicerTest(u) {
  const url = slcNorm(u);
  if (!url) return { error: 'url' };
  let r;
  try { r = await native('http', { url: slcUrl({ a: 'version' }, url), timeout: 6000 }); } catch (e) { return { error: 'unreach', url }; }
  let d = null; try { d = JSON.parse(r.text); } catch (e) {}
  if (r.status !== 200 || !d || d.name !== 'allmyprinters-slicer') return { error: 'not_slicer', url };
  if ((+d.api || 0) < SLICE_API_MIN) return { error: 'old', url, version: d.version };
  const miss = slcMissing(d);
  // „Verbinden“ frischt auch den Stand für die Druckansicht auf (nach einem Update verschwindet der Hinweis sofort)
  slcCapsC = { url, at: Date.now(), res: { own: true, version: d.version || '?', missing: miss, need: slcNeed(miss), bambu: miss.includes('bambu_start') } };
  return { ok: true, url, version: d.version || '?', orca: d.orca || '?', missing: miss, need: slcNeed(miss), bambu: miss.includes('bambu_start') };
}
/** Eigener Container: kann er alles, was diese App-Version nutzt? Höchstens einmal pro Stunde nachfragen (force: jetzt). */
let slcCapsC = null;
async function slicerCaps(force) {
  const s = slicer();
  if (!s.own) return { own: false, missing: [] };
  if (!force && slcCapsC && slcCapsC.url === s.url && Date.now() - slcCapsC.at < 3600000) return slcCapsC.res;
  let res = { own: true, missing: [], version: null };
  try {
    const r = await native('http', { url: slcUrl({ a: 'version' }, s.url), timeout: 6000 });
    const d = JSON.parse(r.text || '{}');
    if (r.status === 200 && d.name === 'allmyprinters-slicer') { const miss = slcMissing(d); res = { own: true, version: d.version || '?', missing: miss, need: slcNeed(miss), bambu: miss.includes('bambu_start') }; }
  } catch (e) { /* nicht erreichbar: das meldet das Slicen selbst */ }
  slcCapsC = { url: s.url, at: Date.now(), res };
  return res;
}
// ── Rückmeldung zum Druckstart (17.11.2026, User: „1 bauen“) ──────────────
// Nach jedem Startversuch: hat der Drucker den Start angenommen oder welcher Fehlercode kam? Bisher erfuhren wir Erfolg nie, Fehler nur,
// wenn jemand „Problem melden“ drückte. Admin: allmyprinters.com/admin/?t=prints.
// Geschickt: Zufallskennung je Auftrag (selbst erzeugt, NICHT die Slicer-Auftragsnummer → nicht mit dem Slicer-Protokoll verknüpfbar),
// Versuch Nr., App-/Agent-Version, Weg (amp = unser Slicer, own = eigener Slicer, file = fertige G-Code-Datei), Treiber, Modell,
// Orca-Profil, Firmware, Zahl der Fächer, Ergebnis. Keine Datei, kein Name, keine Adresse, keine Seriennummer, keine Gerätekennung.
// Abschaltbar: Einstellungen → Slicer, im Agenten auch AMP_PING=off. Ab 0.9.10 / Agent 0.7.4 auch eigener Slicer und fertige Dateien
// (User 17.11.: „ich habe einen eigenen Slicer, daher habe ich gefragt, ob auch alles mitgeschnitten wird“) — 0.9.9 meldete nur „amp“.
const START_URL = (() => { try { return localStorage.getItem('amp_start_url') || 'https://allmyprinters.com/api/print-start.php'; } catch (e) { return 'https://allmyprinters.com/api/print-start.php'; } })();
const startOff = () => !!(db.settings.amp_start_report_off || (window.FM && FM.no_report));
let startInfo = null;
/** sj: Eintrag des Slicer-Auftrags (merkt Kennung + Versuche) oder null bei einer fertigen Datei (je Start eine neue Kennung). */
/** Technischer Grund für die Druckstart-Meldung (27.11.2026, User: „bau Sachen ein, damit wir mehr sehen, warum was nicht funktioniert“):
 *  eigene Angaben (e.detail: Zustände, Codes) bzw. die Fehlermeldung — Adressen, Rechner-, Datei- und Seriennamen werden ersetzt. */
function startDet(e) {
  if (!e) return '';
  // eigene Angaben (state=… ack=… seen=…): bereinigt übernehmen
  if (e.detail) return String(e.detail).replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, 'ip').replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, 'ip')
    .replace(/\S+\.(gcode|gco|g|3mf|stl|bgcode|ufp)\b/gi, 'file')
    .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(local|lan|home|box|internal|intranet|com|net|de|org|io|at|ch)\b/gi, 'host')
    .replace(/\b(?=[0-9A-Z]*\d)[0-9A-Z]{10,}\b/g, 'id').replace(/[^\w .:=,+\/>()-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  // Fehlermeldung von Node/Android/iOS: nur erkennbare technische Begriffe — Freitext kann Datei- oder Rechnernamen enthalten
  if (!e.message || e.message === e.code) return '';
  const m = String(e.message).replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, ' ').replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, ' ');
  const toks = m.match(/\b(E[A-Z]{3,}|[1-5]\d\d|http_\d{3}|timeout|timed out|refused|reset|closed|hang up|handshake|certificate|tls|ssl|mqtt|ftps?|socket|unreachable|denied|not found|verify failed|no route)\b/gi) || [];
  return [...new Set(toks.map(x => x.toLowerCase()))].join(' ').slice(0, 120);
}
async function startReport(sj, p, res, plan, via, chkP, det) {
  try {
    if (startOff() || !p) return;
    sj = sj || {};
    if (!/^[0-9a-f]{32}$/.test(sj.rk || '')) { const b = new Uint8Array(16); crypto.getRandomValues(b); sj.rk = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }
    sj.tries = Math.min(50, (sj.tries || 0) + 1); persist();
    if (!startInfo) startInfo = await native('info', {}).catch(() => ({}));
    const e = (live[p.id] || {}).good || (live[p.id] || {}).entry || {};
    const used = new Set((plan || []).filter(x => x.g > 0).map(x => +x.slot));
    const body = { k: sj.rk, n: sj.tries, v: startInfo.version || '', src: startInfo.agent ? 'agent' : 'app', via: via || 'amp', kind: kindOf(p), model: p.model || '',
                   machine: (p.prof || {}).machine || '', fw: String((e.stats || {}).fw || ''), colors: used.size || 1,
                   // Nur echte Codes (unreach, printer_busy, upload_404 …). Freitext von Node/Android kann eine Adresse enthalten
                   // („connect ECONNREFUSED 192.168.…“) → dann nur „other“
                   r: /^[A-Za-z0-9_]{1,40}$/.test(String(res || '')) ? String(res).toLowerCase() : 'other' };
    if (det && body.r !== 'ok') body.det = String(det).slice(0, 120);   // 27.11.2026: technischer Grund (startDet, schon bereinigt)
    // G-Code-Prüfung (ab 0.24.0): nur Regelname + Anzahl („tc_heat:48“), leer = unauffällig — nie etwas aus der Datei
    if (chkP) { const c = gchkStr(await Promise.race([chkP, new Promise(z => setTimeout(() => z({ skip: 'time' }), GCHK_MS + 5000))]).catch(() => null)); if (c !== null) body.chk = c; }
    // Nebenbei, ohne Warten und ohne Fehlermeldung: Drucken darf daran nie hängen
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    if (ac) setTimeout(() => ac.abort(), 15000);
    _fetch(START_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(ac ? { signal: ac.signal } : {}) }).catch(() => {});
  } catch (e) { /* nie stören */ }
}

/** Fertigen G-Code holen und lokal senden, dann nach dem Plan des Servers (Gramm je Fach) abbuchen. */
async function sliceSend(inp) {
  const sj = (db.slicejobs = db.slicejobs || {});
  if (sj[inp.job] && sj[inp.job].sent && inp.start) return { error: 'already_sent' };
  const p = db.printers.find(x => x.id === (sj[inp.job] || {}).printer) || null;
  // png: Bambu braucht das Bild als PNG im .gcode.3mf (Metadata/plate_1.png), alle anderen nehmen das kleine WebP
  const j = await server('job', p && kindOf(p) === 'bambu' ? { job: inp.job, png: 1 } : { job: inp.job });
  if (j.error || j.status !== 'done') return { error: j.error || 'not_ready' };
  if (!p) return { error: 'no_printer' };
  const dl = await native('download', { url: slcUrl({ a: 'gcode', job: inp.job }), headers: sliceHdr(), name: (j.name || 'print') + '.gcode' });
  const via = slicer().own ? 'own' : 'amp';
  if (dl.status !== 200 || !dl.token) { if (inp.start) startReport(sj[inp.job], p, 'download_' + (dl.status || 0), j.plan, via); return { error: 'send', detail: 'download ' + dl.status }; }
  // Flashforge Creator 5 (22.11.2026): der Slicer (ab 1.0.11) legt die vollständige Projektdatei mit G-Code dazu — genau das schickt
  // der Flashforge-Slicer an den Drucker. Nur zum Starten; fehlt sie (älterer eigener Slicer, Abruf scheitert), bleibt der bisherige Weg.
  // 0.19.5: nur noch auf Abruf — SEND.flashforge holt sie erst, wenn die Zuordnung nicht 1:1 ist (bei 1:1 geht die reine .gcode raus)
  let full = null;
  const fullGet = inp.start && j.full3mf && kindOf(p) === 'flashforge' ? async () => {
    if (full) return full;
    const d3 = await native('download', { url: slcUrl({ a: 'full3mf', job: inp.job }), headers: sliceHdr(), name: (j.name || 'print') + '.3mf' }).catch(() => null);
    if (d3 && d3.status === 200 && d3.token) full = { token: d3.token, name: d3.name, size: d3.size };
    else diag({ a: 'ff_full', p: 'flashforge', m: p.model || '', err: 'download_' + ((d3 && d3.status) || 0) });
    return full;
  } : null;
  const pin = { printer: p.id, file: { token: dl.token, name: dl.name, size: dl.size, plate_png: j.thumb_png || null, full3mf: fullGet }, start: !!inp.start, plan: j.plan || [],
                thumb: j.thumb || null, level: (sj[inp.job] || {}).level, vib: (sj[inp.job] || {}).vib === true, flow: (sj[inp.job] || {}).flow === true, tl: (sj[inp.job] || {}).tl === true, plate_ok: !!inp.plate_ok };
  try {
    const r = await printSend(pin);
    sj[inp.job] = { ...(sj[inp.job] || {}), [inp.start ? 'sent' : 'uploaded']: now() };
    if (inp.start && (sj[inp.job].lib || sj[inp.job].plate)) libLink([].concat(sj[inp.job].lib || [], sj[inp.job].plate || []), r.started ? r.job : null, p.name);
    persist();
    if (inp.start) startReport(sj[inp.job], p, r.started ? 'ok' : 'not_started', j.plan, via, pin._chk);
    return { ok: true, pending: false, kept: null, started: r.started };
  } catch (e) {
    if (e.message === 'plate_check') return { error: 'plate_check', img: e.img || null };   // Platte nicht leer? → Oberfläche fragt nach
    if (inp.start && e.message !== 'plate_check') startReport(sj[inp.job], p, e.code || e.message, j.plan, via, pin._chk, startDet(e));
    // „unreach“ roh im Satz verstand niemand (09.11.2026) → vorhandener Text „Nicht erreichbar unter <Adresse> …“
    // (app.js ist eine eigene Funktion — dessen t() gibt es hier nicht; die Texte liegen in window.FM.S)
    const ur = window.FM && FM.S && FM.S.amp_unreach;
    const tx = window.FM && FM.S && FM.S['amp_send_' + e.message];
    const detail = e.message === 'unreach' && ur ? ur.split('{h}').join(p.host) : tx || e.msg || e.message;
    return { error: e.message === 'printer_busy' ? 'busy' : 'send', detail };
  } finally { native('fileDrop', { token: dl.token }).catch(() => {}); if (full) native('fileDrop', { token: full.token }).catch(() => {}); }
}
// Die Druckansicht von /filament ruft api.php teils direkt per fetch (print_map, print_send, Vorschau) → hier umleiten
window.fetch = async (url, opt = {}) => {
  if (typeof url === 'string' && /^api\.php/.test(url)) {
    await boot();
    if (url.startsWith('api.php?')) {
      const q = new URLSearchParams(url.slice(8));
      if (q.get('a') === 'print_preview') return slcPreview(q.get('job') || '');
      if (q.get('a') === 'lib_get') return libFetch(+q.get('id'));
      if (q.get('a') === 'lib_mesh') return _fetch(url);   // 3D-Netz: liefert MainActivity aus filesDir/library-mesh
      const d = await api(q.get('a'), null, Object.fromEntries(q)).catch(e => ({ error: e.message }));
      return new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } });
    }
    let body = {}; try { body = JSON.parse(opt.body || '{}'); } catch (e) {}
    const d = await api(body.a, body).catch(e => ({ error: e.message }));
    return new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } });
  }
  return _fetch(url, opt);
};

// ── Bibliothek (10.11.2026, User: „ja bau 1“): eigene Modelldateien wie /filament #library, aber auf dem Handy ──────────
// Dateien im App-Speicher oder in einem vom Nutzer gewählten Ordner (db.settings.lib_loc = {uri, name}); jede Datei merkt sich,
// wo sie liegt (loc + key bzw. doc), beim Wechsel des Ordners bleiben vorhandene, wo sie sind. Vorschau: Plattenbilder aus der
// 3MF, für STL zeichnet die Oberfläche ein Bild (amp-views.js ampStlThumb), G-Code nimmt sein eingebettetes Vorschaubild.
// Schnittstelle wie library_api.php (lib_list/upload/update/delete), damit app.js' Ansicht (drawLib/libOpen) unverändert läuft.
const LIB_EXTS = ['stl', '3mf', 'gcode', 'gco', 'g'], LIB_MAX = 500 * 1048576;
const libLoc = () => { const l = db.settings.lib_loc; return l && l.dav ? 'dav' : l && l.uri ? l.uri : 'app'; };
// ── WebDAV (10.11.2026): Bibliothek + tägliche Sicherung auf dem NAS. db.settings.lib_loc = { dav: true, url, user, pass, scheme, name }.
// Nur PUT/GET/DELETE (Android-HTTP kann kein PROPFIND/MKCOL): den Ordner legt man am NAS an.
const davCfg = () => { const l = db.settings.lib_loc; return l && l.dav ? l : null; };
const davUrl = (base, name) => String(base).replace(/\/+$/, '') + '/' + encodeURIComponent(name);
const davCall = (method, url, extra = {}, cfg) => { const c = cfg || davCfg() || {}; return native('dav', { method, url, user: c.user || '', pass: c.pass || '', scheme: c.scheme || '', ...extra }); };
/** Fehler von WebDAV → Code für die Oberfläche (amp_dav_err_*) */
const davErr = (r, e) => { const s = r ? +r.status : 0; if (!r) return /ssl|certif|handshake/i.test(String(e && e.message)) ? 'ssl' : 'net';
  return s === 401 ? 'login' : s === 404 || s === 409 ? 'folder' : s === 403 || s === 405 || s === 501 ? 'write' : s === 507 ? 'full' : 'other'; };
/** Daten für Sicherungen: ohne NAS-Passwort */
// full: mit NAS-Passwort — nur für den Umzug zwischen eigenen Geräten (App ↔ Agent, Ende-zu-Ende verschlüsselt), nie für Dateien/NAS-Sicherung
function dbExport(full) { const d = JSON.parse(JSON.stringify(db)); if (!full && d.settings && d.settings.lib_loc && d.settings.lib_loc.pass) d.settings.lib_loc.pass = '';
  if (!full && Array.isArray(d.clouds)) d.clouds.forEach(a => { a.acc = null; a.err = 'auth'; });   // Zugänge der Hersteller-Konten bleiben im Agenten
  return d; }
/** Einmal am Tag (bzw. jetzt) die Daten der App aufs NAS: sieben Dateien, eine je Wochentag (keine Liste nötig, alte werden überschrieben). */
async function davBackup(force) {
  const c = davCfg();
  if (!c || c.backup === false || !c.pass) return { ok: false, off: true };
  if (!force && Date.now() - ts(db.settings.dav_backup_at || '') < 20 * 3600e3) return { ok: true, skipped: true };
  const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
  let r = null, err = null;
  try { r = await davCall('PUT', davUrl(c.url, `allmyprinters-backup-${day}.json`), { text: JSON.stringify({ app: 'AllMyPrinters', exported_at: now(), data: dbExport() }, null, 1), timeout: 60000 }); } catch (e) { err = e; }
  const ok = !!r && r.status >= 200 && r.status < 300;
  if (ok) { db.settings.dav_backup_at = now(); delete db.settings.dav_backup_err; } else db.settings.dav_backup_err = davErr(r, err) + (r ? ' ' + r.status : '');
  diag({ a: 'dav_backup', err: ok ? '' : db.settings.dav_backup_err, d: day });
  persist();
  return { ok, err: ok ? null : davErr(r, err), status: r ? r.status : 0 };
}
on('resume', () => { davBackup(false).catch(() => {}); });
const libItems = () => (db.library = db.library || []);
const libUsed = () => libItems().reduce((a, f) => a + (f.size || 0), 0);
// plates = Plattennummern mit Bild (aus der Datei bzw. gezeichnet), mplates = Platten aus dem 3D-Netz (AMPMesh, libMeshBuild)
const libOut = f => {
  const th = f.plates || [], mp = f.mesh && f.mplates ? f.mplates : null;
  const busy = f.preview === 'busy' && Date.now() - ts(f.busy_at || '') < 10 * 60000;   // App zu während des Baus → nicht ewig „wird erstellt“
  if (f.loc === 'plate') return libPlateOut(f);
  if (f.want) return { id: f.id, name: f.name, folder: f.folder || '', tags: f.tags || [], notes: f.notes || '', photo: false, book: 0, want: true, remote: f.remote || null,
    ext: '', size: 0, orig: '', created: f.created, printed: null, preview: 'none', mesh: false, thumbs: false, plates: [], v: f.v || 1, print: false, gcode: null, err: null,
    loc: 'want', printer: null, prints: 0, can3d: false, gone: false };
  const last = libLast(f), pcols = mp ? mp.map(p => (p.cols || []).length).reduce((a, b) => Math.max(a, b), 0) : 0;
  const multi = pcols > 1 || (f.gcode && (f.gcode.types || []).length > 1) || (last && last.cols.length > 1);
  return { id: f.id, name: f.name, folder: f.folder || '', tags: f.tags || [], notes: f.notes || '', photo: !!f.photo, book: (f.jobs || []).length, remote: f.remote || null,
    ext: f.ext, size: f.size, orig: f.orig, created: f.created, printed: f.printed || null, last, multi: !!multi,
    preview: busy ? 'busy' : th.length || mp ? 'ok' : 'none', mesh: !!mp, thumbs: th.length > 0,
    plates: mp ? mp.map(p => ({ ...p, thumb: th.includes(p.n) })) : (th.length ? th : [1]).map(n => ({ n, empty: false, thumb: th.includes(n), name: '' })),
    v: f.v || 1, print: true, gcode: f.gcode || null, err: f.err || null, loc: f.loc === 'app' ? 'app' : f.loc === 'dav' ? 'dav' : 'dir',
    printer: f.printer || null, prints: f.prints || 0, can3d: ['stl', '3mf'].includes(f.ext), gone: !!f.gone };
};
// ── Platten (18.11.2026, User: „Stufe 1 und 2 finde ich super“; Wunsch #45 Tropisch: mehrere Dateien je Modell) ──────────────
// Eintrag ohne eigene Datei (loc 'plate'): welche STL-Einträge der Bibliothek wie oft (n) und aus welchem Fach (slot, '' = Fach der
// Druckansicht) zusammen auf eine Platte kommen. Teile mit Nummer + Dateiname + Größe: beim Koppeln mit dem Agenten bekommen Einträge
// neue Nummern, lib_adopt findet die Teile über Name + Größe wieder. Bild Nr. 1 = Collage der Teilbilder (Oberfläche), Druckbuch wie
// bei Dateien (jobs). Fehlt ein Teil (gelöscht, nicht mehr im Ordner), druckt die Platte ohne es und zeigt das an.
const LIB_PLATE_MAX = 20;   // wie PS_STL_MAX der Druckansicht
/** Letzter Druck eines Bibliothekseintrags (Bibliothek-Redesign 18.11.2026: Status, Farbpunkte, „Weiter drucken“, „wie zuletzt“) */
function libLast(f) {
  const js = (f.jobs || []).map(id => db.jobs.find(j => j.id === id)).filter(Boolean);
  if (!js.length) return null;
  const j = js.reduce((a, b) => ts(b.end || b.start) > ts(a.end || a.start) ? b : a);
  const cols = [...new Set((j.paint || []).filter(x => x && x.color && (x.g == null || x.g > 0)).map(x => String(x.color).toLowerCase()))].slice(0, 4);
  return { at: j.end || j.start, pid: j.printer_id, printer: printerName(j.printer_id), g: Math.round(j.grams_real ?? j.grams ?? 0), s: j.print_s || 0, st: j.status, cols };
}
function libPlateOut(f) {
  const all = libItems();
  const parts = (f.parts || []).map(p => {
    const x = all.find(y => y.id === p.id && y.loc !== 'plate' && !y.want);
    return { id: p.id, n: p.n || 1, slot: p.slot || '', name: x ? x.name : p.name || p.orig || '?', ok: !!(x && !x.gone && x.ext === 'stl'),
             thumb: !!(x && (x.plates || []).includes(1)), v: x ? x.v || 1 : 1, inst: p.inst || null, sup: p.sup || '' };
  });
  const th = (f.plates || []).includes(1);
  return { id: f.id, name: f.name, folder: f.folder || '', tags: f.tags || [], notes: f.notes || '', photo: !!f.photo, book: (f.jobs || []).length, remote: null,
    ext: '', size: 0, orig: '', created: f.created, printed: f.printed || null, preview: th ? 'ok' : 'none', mesh: false, thumbs: th,
    plates: [{ n: 1, empty: false, thumb: th, name: '' }], v: f.v || 1, print: parts.some(p => p.ok), gcode: null, err: null, loc: 'plate', plate: true, parts, last: libLast(f),
    multi: (() => { const l = libLast(f); return !!(l && l.cols.length > 1); })(),
    printer: f.printer || null, prints: f.prints || 0, can3d: false, gone: false, edp: f.edp || null };
}
const libPlateParts = list => {
  const all = libItems();
  return (Array.isArray(list) ? list : []).slice(0, LIB_PLATE_MAX).map(p => {
    const x = all.find(y => y.id === +(p && p.id) && y.loc !== 'plate' && !y.want && y.ext === 'stl');
    if (!x) return null;
    const inst = libPlateInst(p.inst), o = { id: x.id, n: inst ? inst.length : int(p.n, 1, 100) || 1, slot: /^\d{1,3}$/.test(String(p.slot ?? '')) ? String(p.slot) : '', name: x.name, orig: x.orig, size: x.size };
    if (inst) o.inst = inst;
    if (['auto', 'bed'].includes(p.sup)) o.sup = p.sup;   // Stützen je Teil (Editor)
    return o;
  }).filter(Boolean);
};
/** Anordnung aus dem Editor (19.11.2026): je Kopie { L: 3×3 zeilenweise, x, y (Mitte auf dem Bett, mm), s (Maßstab), skip } — sonst null */
function libPlateInst(v) {
  if (!Array.isArray(v) || !v.length || v.length > 100) return null;
  const fin = (x, lim) => Number.isFinite(+x) && Math.abs(+x) <= lim;
  const out = [];
  for (const q of v) {
    if (!q || !Array.isArray(q.L) || q.L.length !== 9 || !q.L.every(x => fin(x, 1000)) || !fin(q.x, 100000) || !fin(q.y, 100000)) return null;
    out.push({ L: q.L.map(Number), x: +q.x, y: +q.y, s: fin(q.s, 1000) && +q.s > 0 ? +q.s : 1, skip: !!q.skip });
  }
  return out;
}
// Ordnen + Druckbuch (13.11.2026, User: „mach 2 und 3“): Unterordner als Pfad „A/B“, Tags, Notizen, Foto vom fertigen Druck
// (Vorschaubild Nr. 0, ersetzt in der Liste das Plattenbild), Druckbuch = Nummern der Druckaufträge in f.jobs (überlebt das Koppeln
// mit dem Agenten: Aufträge behalten ihre Nummern, Einträge bekommen neue). Ältere Drucke zählt nur f.prints.
const libFolder = s => String(s ?? '').split('/').map(x => x.replace(/[\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean).join('/').slice(0, 160);
const libTags = v => {
  const out = [], seen = new Set();
  for (const x of Array.isArray(v) ? v : String(v ?? '').split(',')) {
    const tg = String(x).replace(/[\x00-\x1f,#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30), k = tg.toLowerCase();
    if (tg && !seen.has(k)) { seen.add(k); out.push(tg); }
  }
  return out.slice(0, 20);
};
const libNote = s => String(s ?? '').replace(/\r\n?/g, '\n').slice(0, 4000);
/** Aus der Bibliothek gestartet: zählen, Drucker merken, Auftrag ins Druckbuch */
function libLink(id, job, printer) {
  // Platte bzw. mehrere Dateien auf einer Platte (18.11.2026): jede Datei und die Platte bekommen den Druck ins Druckbuch
  if (Array.isArray(id)) { [...new Set(id.map(Number))].forEach(x => libLink(x, job, printer)); return; }
  const it = libItems().find(x => x.id === +id); if (!it) return;
  it.printed = now(); it.prints = (it.prints || 0) + 1; it.printer = printer || it.printer || null;
  if (job) it.jobs = [...(it.jobs || []).filter(x => x !== job), job].slice(-200);
}
/** Datei samt Bildern/Netzen entfernen (einzeln und Mehrfachauswahl) */
async function libRemove(f) {
  if (f.loc === 'dav') { await davCall('DELETE', f.doc).catch(() => {}); await native('lib_del', { id: f.id }).catch(() => {}); }
  else await native('lib_del', { id: f.id, key: f.key || '', doc: f.doc || '' }).catch(() => {});
}
// ── 3DSEARCH merken (13.11.2026, User: „baus mal so“ — ohne Erkennung über Name/Zeitpunkt, ohne Download-Ordner, Thingiverse bleibt) ──
// Suche und Details über die öffentliche Schnittstelle von 3DSEARCH (api/v1, liefert seit 13.11. img = anzeigefertiges Bild und license).
// Merken = Bibliothekseintrag ohne Datei (want, loc 'want', remote = Quelle). Die Datei lädt der Nutzer selbst auf der Plattform;
// sie kommt über „Teilen / Öffnen mit“ oder „Datei auswählen“ dazu (amp_lib_attach). Wir laden nie Modelldateien.
const S3D = 'https://3dsearch.net/api/v1/';
async function s3dGet(path, q) {
  const qs = q ? '?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString() : '';
  let r; try { r = await native('http', { url: S3D + path + qs, timeout: 15000 }); } catch (e) { return { error: 'net' }; }
  if (!r || r.status !== 200) return { error: r && r.status === 404 ? 'not_found' : 'net' };
  try { return JSON.parse(r.text || ''); } catch (e) { return { error: 'net' }; }
}
const s3dHit = h => ({ id: String(h.id || ''), name: str(h.name, 160) || '?', img: h.img || null, url: /^https?:\/\//.test(h.url || '') ? h.url : null, source: str(h.source, 30) || '',
  designer: h.designer ? str(h.designer, 80) : null, license: h.license ? str(h.license, 64) : null, is_free: h.is_free !== false, tags: (Array.isArray(h.tags) ? h.tags : []).slice(0, 10).map(x => str(x, 40)).filter(Boolean),
  likes: Math.max(0, +h.likes || 0), makes: Math.max(0, +h.makes || 0) });   // Likes/Makes für die Kartenzeile (14.11.2026)
/** Treffer mit Merk-Zustand aus der Bibliothek */
const s3dHitLib = h => { const x = s3dHit(h), w = libWantOf(x.id); return { ...x, saved: w ? w.id : null, folder: w ? w.folder || '' : '' }; };
let s3dTrend = null;   // „Gerade beliebt“ 10 Min. im Speicher (Startseite der Modellsuche)
/** Wettbewerb für Liste/Karte (18.11.2026): Bild über den 3DSEARCH-Proxy (img), Ende als ISO-Zeit (UTC wie die Datenbank) */
const s3dContest = c => ({ id: Math.max(0, +c.id || 0), name: str(c.name, 200) || '?', platform: str(c.platform, 30) || '', img: /^https?:\/\//.test(c.img || '') ? c.img : null,
  ends: /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(c.open_to || '') ? c.open_to.replace(' ', 'T') + 'Z' : null, open: !!c.is_open, entries: Math.max(0, +c.entries_count || 0),
  prize: str(c.prize, 160) || '', noai: !!c.ai_disabled, snippet: str(c.description, 300) || '' });
const libWantOf = rid => libItems().find(x => x.remote && x.remote.id === String(rid));
/** 3D-Netz im Hintergrund bauen (Datei aus dem Speicher holen → AMPMesh → je Platte ins App-Verzeichnis). */
async function libMeshBuild(f) {
  if (!['stl', '3mf'].includes(f.ext) || !window.AMPMesh) return;
  f.preview = 'busy'; f.busy_at = now(); delete f.err; persist();
  try {
    const blob = await (await libFetch(f.id)).blob();
    const res = await window.AMPMesh.build(blob, f.ext);
    for (const p of res.plates) {
      // Farbwechsel nach Höhe (27.11.2026): eigenes farbiges Vorschaubild ersetzt das einfarbige plate_N.png aus Bambu Studio
      if (p.thumb) {
        try { await native('lib_thumb_put', { id: f.id, n: String(p.n), b64: p.thumb }); f.plates = [...new Set([...(f.plates || []).map(Number), p.n])].sort((a, b) => a - b); }
        catch (e) { diag({ a: 'lib_lc_thumb', err: String(e && e.message || 'thumb').slice(0, 40) }); }
      }
      if (!p.gz) continue;
      let bin = ''; for (let i = 0; i < p.gz.length; i += 0x8000) bin += String.fromCharCode.apply(null, p.gz.subarray(i, i + 0x8000));
      await native('lib_mesh_put', { id: f.id, n: p.n, b64: btoa(bin) });
    }
    f.mplates = res.plates.map(({ gz, thumb, ...p }) => p);
    f.mesh = true; f.lcv = 1; f.v = (f.v || 1) + 1;
  } catch (e) {
    f.mesh = false; f.err = String(e && e.message || 'mesh').slice(0, 40);
    diag({ a: 'lib_mesh', err: f.err, d: f.ext + ' ' + Math.round((f.size || 0) / 1048576) + ' MB' });
  }
  f.preview = 'done'; delete f.busy_at;
  persist();
}
// Farbwechsel nach Höhe (27.11.2026): mehrfarbige 3MF, deren 3D-Ansicht vor dem farbigen Vorschaubild gebaut wurde (ohne lcv), einmal
// neu bauen — nacheinander im Hintergrund, angestoßen beim Öffnen der Bibliothek. Bemalte Dateien behalten ihr Bild (thumb nur bei lc).
let libLcRun = null;
function libLcMig() {
  if (libLcRun) return;
  const todo = libItems().filter(f => f.ext === '3mf' && f.mesh && !f.lcv && !f.want && f.preview !== 'busy' && (f.mplates || []).some(p => (p.cols || []).length > 1));
  if (!todo.length) return;
  libLcRun = (async () => {
    for (const f of todo) {
      if (!libItems().includes(f) || f.lcv || f.preview === 'busy') continue;
      f.preview = 'busy'; f.busy_at = now();
      await libMeshBuild(f).catch(() => {});
      f.lcv = 1; persist();
    }
  })().finally(() => { libLcRun = null; });
}
// Bibliotheksdatei zum Drucken holen → { token, size }. #23 (17.11.2026, Denny, WebDAV am Agenten): „Drucken“ blieb bei
// „Datei wird geladen …“ stehen. Der Abruf wartete bis zu 5 Min. auf ein stummes NAS und stand nirgends im Protokoll.
// Jetzt: 60 s ohne Daten = Fehler „slow“ (die Grenze gilt je Lesevorgang in Bridge.kt und native.js, große Dateien dürfen
// länger laden, solange Daten kommen), und jeder Abruf steht mit Ort, Größe, Dauer und Ergebnis im Protokoll (diag lib_get).
// Fehler vom NAS kommen als Error('lib_dav_<code>') mit .status, Fehler im eigenen Speicher unverändert.
const LIB_DAV_IDLE = 60000;
async function libGrab(f) {
  const t0 = Date.now(), dav = f.loc === 'dav';
  let r = null, code = '', err = null;
  try {
    r = dav ? await davCall('GET', f.doc, { name: f.orig, timeout: LIB_DAV_IDLE }) : await native('lib_get', { key: f.key || '', doc: f.doc || '', name: f.orig });
    if (dav && (!r || !r.token)) code = r && (+r.status === 404 || +r.status === 410) ? 'gone' : davErr(r);
  } catch (e) { err = e; code = e.message === 'timeout' ? 'slow' : dav ? davErr(null, e) : e.message || 'other'; }
  const mb = (((r && r.size) || f.size || 0) / 1048576).toFixed(1), s = ((Date.now() - t0) / 1000).toFixed(1);
  diag({ a: 'lib_get', err: code || undefined, d: `${dav ? 'dav' : 'local'} ${f.ext || ''} ${mb} MB ${s} s${r && r.status ? ' http ' + r.status : ''}` });
  if (!dav && err) throw err;
  if (code) throw Object.assign(new Error('lib_dav_' + code), { status: (r && +r.status) || 0 });
  return r;
}
async function libFetch(id) {
  const f = libItems().find(x => x.id === id);
  if (!f || f.want) return new Response('', { status: 404 });
  let r;
  try { r = await libGrab(f); }
  catch (e) {
    if (!/^lib_dav_/.test(e.message)) throw e;
    return new Response(JSON.stringify({ error: e.message, status: e.status || 0 }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
  setTimeout(() => native('fileDrop', { token: r.token }).catch(() => {}), 180000);   // Kopie im Zwischenspeicher wieder weg
  return _fetch('/file?t=' + encodeURIComponent(r.token));
}

// ── Ordner einlesen (12.11.2026, Denny: Dateien vom PC bzw. vom Tablet erscheinen nicht in der Bibliothek) ──────────────
// Der Ordner (WebDAV bzw. Handy-Ordner) ist die gemeinsame Ablage aller Geräte. Beim Öffnen der Bibliothek (höchstens alle 30 s)
// und mit „Neu einlesen“ listet die App ihn auf (eine Abfrage, darum höchstens alle 10 s statt 30): neue STL/3MF/G-Code-Dateien werden Einträge (Vorschau im Hintergrund wie beim
// Hochladen), Einträge, deren Datei dort fehlt, bekommen „nicht mehr im Ordner“ (gone) — nie still gelöscht. Unterordner nicht.
// Namen, Ordner-Schilder und „x× gedruckt“ bleiben je Gerät.
const libKeyOf = (loc, doc) => {
  const s = String(doc || '');
  if (loc === 'dav') { try { return decodeURIComponent(new URL(s).pathname).replace(/\/+$/, ''); } catch (e) { return s; } }
  const m = /\/document\/([^/?#]+)/.exec(s);   // SAF: Dokument-Kennung (createDocument und Ordnerliste bauen die Adresse gleich)
  try { return decodeURIComponent(m ? m[1] : s); } catch (e) { return m ? m[1] : s; }
};
/** WebDAV-Antwort (207 multistatus) → [{ url, name, size, mtime }] ohne Ordner. Ohne DOMParser, läuft auch im Agenten. */
function davParse(xml, base) {
  const out = [], b = String(base).replace(/\/*$/, '/');
  const tag = (s, t) => { const m = new RegExp('<(?:[\\w-]+:)?' + t + '\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?' + t + '>', 'i').exec(s); return m ? m[1].trim() : null; };
  for (const m of String(xml || '').matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const r = m[1], href = tag(r, 'href');
    if (!href || /<(?:[\w-]+:)?collection\b/i.test(r)) continue;   // der Ordner selbst und Unterordner
    let url; try { url = new URL(href.replace(/&amp;/g, '&'), b).href; } catch (e) { continue; }
    let name = url.replace(/\/+$/, '').split('/').pop() || ''; try { name = decodeURIComponent(name); } catch (e) {}
    if (name) out.push({ url, name, size: +tag(r, 'getcontentlength') || 0, mtime: Date.parse(tag(r, 'getlastmodified') || '') || 0 });
  }
  return out;
}
let libScanAt = 0, libScanRun = null, libPvRun = null;
const libPvQueue = [];
async function libScan(force) {
  const loc = libLoc();
  if (loc === 'app') return { ok: true, skipped: 'app' };
  if (libScanRun) return libScanRun;
  if (!force && Date.now() - libScanAt < 10000) return { ok: true, skipped: 'recent' };
  libScanAt = Date.now();
  libScanRun = (async () => {
    let list;
    if (loc === 'dav') {
      const c = davCfg(); let r = null, err = null;
      try { r = await native('dav_list', { url: c.url, user: c.user || '', pass: c.pass || '', scheme: c.scheme || '' }); } catch (e) { err = e; }
      if (!r || r.status !== 207) { diag({ a: 'lib_scan', err: 'dav ' + davErr(r, err), d: r ? String(r.status) : '' }); return { error: 'lib_dav_' + (!r ? davErr(r, err) : r.status === 401 ? 'login' : r.status === 404 || r.status === 409 ? 'folder' : 'other') }; }
      if (r.scheme && c.scheme !== r.scheme) c.scheme = r.scheme;
      list = davParse(r.text, c.url).map(x => ({ doc: x.url, name: x.name, size: x.size }));
    } else {
      let r; try { r = await native('lib_dir_list', { loc }); } catch (e) { diag({ a: 'lib_scan', err: 'dir ' + String(e && e.message || '').slice(0, 30) }); return { error: 'lib_dir' }; }
      list = (r.files || []).map(x => ({ doc: String(x.doc || ''), name: String(x.name || ''), size: +x.size || 0 }));
    }
    const base = loc === 'dav' ? libKeyOf('dav', davCfg().url) + '/' : null;
    const mine = libItems().filter(f => loc === 'dav' ? f.loc === 'dav' && libKeyOf('dav', f.doc).startsWith(base) : f.loc === loc);
    const seen = new Set(list.map(x => libKeyOf(loc, x.doc))), known = new Set(mine.map(f => libKeyOf(loc, f.doc)));
    let gone = 0, back = 0;
    for (const f of mine) {
      const g = !seen.has(libKeyOf(loc, f.doc));
      if (g && !f.gone) { f.gone = true; gone++; } else if (!g && f.gone) { delete f.gone; back++; }
    }
    const added = [];
    for (const x of list) {
      const ext = (/\.([a-z0-9]+)$/i.exec(x.name) || [])[1];
      if (!ext || !LIB_EXTS.includes(ext.toLowerCase()) || x.size > LIB_MAX || known.has(libKeyOf(loc, x.doc))) continue;
      // Von einem anderen Gerät hochgeladen: „<Nummer>-<Name>“ → Name ohne Nummer; dieselbe Datei schon in der Bibliothek → nicht doppelt
      const orig = /^\d{1,9}-./.test(x.name) ? x.name.replace(/^\d{1,9}-/, '') : x.name;
      if (libItems().some(f => !f.gone && f.size === x.size && (f.orig === orig || f.orig === x.name))) continue;
      const it = { id: nextId('lib'), name: orig.replace(/\.[^.]+$/, '').slice(0, 120) || orig, folder: '', ext: ext.toLowerCase(), size: x.size, orig, created: now(),
                   printed: null, prints: 0, loc, key: null, doc: x.doc, plates: [], v: 1, scanned: true, preview: 'busy', busy_at: now() };
      libItems().push(it); added.push(it); known.add(libKeyOf(loc, x.doc));
    }
    if (added.length || gone || back) persist();
    if (added.length) { libPvQueue.push(...added); libPvNext(); }
    diag({ a: 'lib_scan', err: '', d: `${loc === 'dav' ? 'dav' : 'dir'} ${list.length} +${added.length} -${gone}` });
    return { ok: true, added: added.length, gone, back, total: list.length };
  })().finally(() => { libScanRun = null; });
  return libScanRun;
}
/** Vorschau für eingelesene Dateien, eine nach der anderen: 3MF-Plattenbilder, G-Code-Bild, STL gezeichnet (nur in der App), dann 3D-Netz. */
function libPvNext() {
  if (libPvRun) return;
  libPvRun = (async () => {
    while (libPvQueue.length) {
      const it = libPvQueue.shift();
      if (!libItems().includes(it)) continue;
      let tok = null;
      try {
        it.busy_at = now();
        const r = it.loc === 'dav' ? await davCall('GET', it.doc, { name: it.orig, timeout: 300000 }) : await native('lib_get', { key: '', doc: it.doc, name: it.orig });
        if (!r || !r.token) throw new Error('get ' + (r && r.status || ''));
        tok = r.token;
        if (r.size && !it.size) it.size = +r.size;
        if (it.ext === '3mf') it.plates = ((await native('lib_3mf_thumbs', { token: tok, id: it.id })).plates || []).map(Number).sort((a, b) => a - b);
        else if (it.ext !== 'stl') {
          const md = await fileMeta({ token: tok });
          if (md.thumb) { await native('lib_thumb_put', { id: it.id, n: 1, b64: md.thumb }); it.plates = [1]; }
          it.gcode = { printer: null, types: md.types || [] };
        } else if (typeof window !== 'undefined' && window.ampStlThumb) {
          const blob = await (await _fetch('/file?t=' + encodeURIComponent(tok))).blob();
          const th = await window.ampStlThumb(blob).catch(() => null);
          if (th) { await native('lib_thumb_put', { id: it.id, n: 1, b64: th }); it.plates = [1]; }
        }
        it.v = (it.v || 1) + 1;
      } catch (e) { it.err = String(e && e.message || 'preview').slice(0, 40); diag({ a: 'lib_scan_pv', err: it.err, d: it.ext }); }
      finally { if (tok) native('fileDrop', { token: tok }).catch(() => {}); }
      if (['stl', '3mf'].includes(it.ext) && !it.err) await libMeshBuild(it).catch(() => {});
      else { it.preview = 'done'; delete it.busy_at; }
      persist();
    }
  })().finally(() => { libPvRun = null; if (libPvQueue.length) libPvNext(); });
}

// ── Aktionen ───────────────────────────────────────────────────────────────
const A = {
  async spools() { return { spools: await spools(), locations: locations().map(l => l.name) }; },
  async facets() {
    const c = await catalog(), n = {}, mats = {};
    for (const i of c.items) { n[i.vendor_id] = (n[i.vendor_id] || 0) + 1; mats[i.material] = (mats[i.material] || 0) + 1; }
    for (const f of db.filaments) mats[f.material] = (mats[f.material] || 0) + 1;
    return { vendors: c.vendors.map(v => ({ id: v.id, name: v.name, empty_spool_g: v.empty_spool_g, n: n[v.id] || 0 })),
             materials: Object.entries(mats).sort((a, b) => b[1] - a[1]).map(([material, n]) => ({ material, n })) };
  },
  async catalog(inp) {
    const c = await catalog();
    let items = c.items.concat(db.filaments);
    if (inp.vendor) items = items.filter(i => String(i.vendor_id) === String(inp.vendor));
    if (inp.material) items = items.filter(i => i.material === inp.material);
    if (inp.diameter) items = items.filter(i => +i.diameter === +inp.diameter);
    const q = String(inp.q || '').trim().toLowerCase();
    if (q) { const ws = q.slice(0, 80).split(/\s+/); items = items.filter(i => { const h = (i.vendor + ' ' + i.material + ' ' + i.name).toLowerCase(); return ws.every(w => h.includes(w)); }); }
    const use = {};
    for (const s of db.spools) if (!s.archived_at && s.fm_filament_id) use[s.fm_filament_id] = (use[s.fm_filament_id] || 0) + 1;
    items = items.map(i => ({ ...i, in_use: use[i.id] || 0 }))
      .sort((a, b) => b.in_use - a.in_use || a.vendor.localeCompare(b.vendor) || a.material.localeCompare(b.material) || a.name.localeCompare(b.name) || (a.diameter !== 1.75) - (b.diameter !== 1.75) || (a.weight_g !== 1000) - (b.weight_g !== 1000));
    const page = Math.max(0, +inp.page || 0);
    return { items: items.slice(page * 60, page * 60 + 60), total: items.length, page };
  },
  async filament_save(inp) {
    const vendor = str(inp.vendor, 100) || fail('vendor'), material = str(inp.material, 30) || fail('material'), name = str(inp.name, 120) || fail('name');
    const f = { id: OWN_BASE + nextId('fil'), vendor_id: 'own', vendor, vendor_spool: null, name, material, color: hex(inp.color), colors: null,
                diameter: num(inp.diameter, 1, 3.5) || 1.75, density: num(inp.density, 0.5, 3), weight_g: int(inp.weight_g, 1, 10000) || 1000,
                spool_weight_g: int(inp.spool_weight_g, 0, 2000), extruder_temp: int(inp.extruder_temp, 100, 500), bed_temp: int(inp.bed_temp, 0, 150),
                finish: null, source: 'user', mine: true };
    db.filaments.push(f); persist();
    return { ok: true, id: f.id };
  },
  history,
  stats,
  async spool_save(inp) { return spoolSave(inp); },
  async spool_use(inp) {
    const s = own(inp.id), g = num(inp.grams, -10000, 10000);
    if (g === null || Math.abs(g) < 0.5) fail('grams');
    book(s, g, 'manual', str(inp.note, 255) || '');
    return reply(s.id);
  },
  async spool_weigh(inp) {
    const s = own(inp.id), gross = int(inp.gross, 1, 12000), empty = int(inp.empty_spool_g, 0, 2000) ?? s.empty_spool_g;
    if (gross === null || empty == null) fail('weigh');
    const left = Math.max(0, gross - empty), oldLeft = leftOf(s), total = Math.max(s.weight_total | 0, left);
    s.weight_total = total; s.weight_used = total - left; s.empty_spool_g = empty;
    book(s, oldLeft - left, 'weigh', gross + '|' + empty, '', null, false);
    return reply(s.id);
  },
  async spool_left(inp) {
    const s = own(inp.id), left = int(inp.left, 0, 10000);
    if (left === null) fail('grams');
    if (left === 0) adjLearn(s);
    const oldLeft = leftOf(s), total = Math.max(s.weight_total | 0, left);
    s.weight_total = total; s.weight_used = total - left; s.over_g = 0;
    if (oldLeft !== left) book(s, oldLeft - left, 'correction', left === 0 ? 'empty' : 'left', '', null, false);
    return reply(s.id);
  },
  async spool_dried(inp) {
    const s = own(inp.id); s.dried_at = now();
    db.usage.push({ id: nextId('usage'), spool_id: s.id, grams: 0, kind: 'dry', ref: null, note: str(inp.note, 255), printer: null, created_at: now() });
    return reply(s.id);
  },
  async spool_archive(inp) { const s = own(inp.id); s.archived_at = inp.archived ? now() : null; return reply(s.id); },
  async spool_delete(inp) {
    const s = own(inp.id);
    if (db.slots.some(sl => sl.spool_id === s.id && db.printers.some(p => p.id === sl.printer_id))) fail('in_use');
    db.slots.forEach(sl => { if (sl.spool_id === s.id) sl.spool_id = null; });
    db.spools = db.spools.filter(x => x.id !== s.id);
    db.usage = db.usage.filter(u => u.spool_id !== s.id);
    persist(); return { ok: true };
  },
  async spool_move(inp) { const s = own(inp.id); s.location = str(inp.location, 60); addLocation(s.location); return reply(s.id); },
  async locations() { return { locations: locations().map(l => ({ id: l.id, name: l.name, n: db.spools.filter(s => !s.archived_at && s.location === l.name).length })) }; },
  async location_save(inp) {
    const name = str(inp.name, 60) || fail('name');
    if (inp.id) {
      const l = db.locations.find(x => x.id === +inp.id) || fail('not_found');
      db.spools.forEach(s => { if (s.location === l.name) s.location = name; }); l.name = name;
    } else addLocation(name);
    persist(); return { ok: true, locations: (await A.locations()).locations };
  },
  async location_delete(inp) {
    const l = db.locations.find(x => x.id === +inp.id) || fail('not_found');
    db.spools.forEach(s => { if (s.location === l.name) s.location = null; });
    db.locations = db.locations.filter(x => x !== l);
    persist(); return { ok: true, locations: (await A.locations()).locations };
  },
  async location_order(inp) { (inp.ids || []).forEach((id, i) => { const l = db.locations.find(x => x.id === +id); if (l) l.sort = i; }); persist(); return { ok: true }; },
  async fields() { return { fields: [] }; },
  // start_locked: Agent mit AMP_PING=off schickt auch keine Rückmeldung zum Druckstart (Schalter dann aus und gesperrt)
  async settings_get() { return { settings: db.settings, start_locked: !!(window.FM && FM.no_report) }; },
  /** Verbrauchsausgleich je Drucker für Einstellungen → Verbrauch. */
  async amp_adj() {
    const t = adjTab();
    return { off: !!db.settings.amp_adj_off, printers: db.printers.map(p => ({ id: p.id, name: p.name, n: (t[p.id] || {}).n || 0,
      f: t[p.id] && t[p.id].raw > 0 ? clamp(t[p.id].real / t[p.id].raw, ADJ_MIN, ADJ_MAX) : null })) };
  },
  async amp_adj_reset(inp) { delete adjTab()[inp.printer]; persist(); return { ok: true }; },
  async amp_slicer_test(inp) { return slicerTest(inp.url); },
  async amp_slicer_caps(inp) { return slicerCaps(!!inp.force); },
  // Warnschwellen: allgemein und je Spule
  async amp_low() { return { cfg: lowCfg(), def: LOW_DEF }; },
  async amp_low_save(inp) {
    const mode = inp.mode === 'pct' ? 'pct' : 'g', max = mode === 'pct' ? 100 : 10000;
    const n = v => v === '' || v === null || v === undefined ? null : clamp(Math.round(+v * 10) / 10, 0, max);
    db.settings.lowcfg = { mode, low: n(inp.low), crit: n(inp.crit) };
    persist(); return { ok: true, cfg: lowCfg() };
  },
  async amp_spool_warn(inp) {
    const s = own(inp.id), w = inp.warn;
    if (!w || w === 'default') delete s.warn;
    else if (w === 'off' || w.off) s.warn = { off: true };
    else { const mode = w.mode === 'pct' ? 'pct' : 'g', max = mode === 'pct' ? 100 : 10000, n = v => v === '' || v == null ? null : clamp(Math.round(+v * 10) / 10, 0, max); s.warn = { mode, low: n(w.low), crit: n(w.crit) }; }
    return reply(s.id);
  },
  // Bibliothek (Schnittstelle wie library_api.php)
  async lib_list() {
    libLcMig();
    const sp = await native('lib_space').catch(() => ({ free: 0 }));
    const used = libUsed();
    return { files: libItems().slice().sort((a, b) => b.id - a.id).map(libOut), used, quota: used + Math.max(+sp.free || 0, LIB_MAX), max: LIB_MAX, exts: LIB_EXTS, sup_quota: 0,
             loc: db.settings.lib_loc && db.settings.lib_loc.uri ? { name: db.settings.lib_loc.name } : null,
             scan: libLoc() === 'app' ? null : { name: (db.settings.lib_loc || {}).name || '', at: libScanAt ? new Date(libScanAt).toISOString().slice(0, 19).replace('T', ' ') : null } };
  },
  /** Ordner einlesen (12.11.2026): force = „Neu einlesen“, sonst höchstens alle 10 s */
  async lib_scan(inp) { return libScan(!!(inp && inp.force)); },
  /** { token (stash), name, size, folder, thumb (STL-Bild als data:-Adresse) } → Datei in die Bibliothek */
  async lib_upload(inp) {
    const orig = str(inp.name, 200) || 'model', ext = (orig.split('.').pop() || '').toLowerCase();
    if (!LIB_EXTS.includes(ext)) return { error: 'lib_type' };
    if (+inp.size > LIB_MAX) return { error: 'lib_too_big' };
    const dup = libItems().find(x => x.orig === orig && x.size === +inp.size);
    if (dup) return { error: 'lib_dupe', name: dup.name };
    const id = nextId('lib'), loc = libLoc();
    let r;
    if (loc === 'dav') {
      const c = davCfg(), url = davUrl(c.url, id + '-' + orig.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 160));
      let d = null, err = null;
      try { d = await davCall('PUT', url, { token: inp.token, timeout: 600000 }); } catch (e) { err = e; }
      if (!d || d.status < 200 || d.status >= 300) { diag({ a: 'lib', err: 'dav ' + davErr(d, err), d: d ? String(d.status) : '' }); return { error: 'lib_dav_' + davErr(d, err) }; }
      r = { size: +inp.size, doc: url };
    } else {
      try { r = await native('lib_put', { token: inp.token, key: id + '-' + orig.replace(/[^\w.\- ()]+/g, '_').slice(0, 160), name: orig, loc }); }
      catch (e) { diag({ a: 'lib', err: e.message || 'put', d: loc === 'app' ? 'app' : 'dir' }); return { error: loc === 'app' ? 'lib_upload' : 'lib_dir' }; }
    }
    const it = { id, name: orig.replace(/\.[^.]+$/, '').slice(0, 120) || orig, folder: libFolder(inp.folder), tags: [], notes: '', ext, size: +r.size || +inp.size || 0, orig, created: now(),
                 printed: null, prints: 0, loc, key: r.key || null, doc: r.doc || null, plates: [], v: 1 };
    try {
      if (ext === '3mf') it.plates = ((await native('lib_3mf_thumbs', { token: inp.token, id })).plates || []).map(Number).sort((a, b) => a - b);
      else if (ext === 'stl' && inp.thumb) { await native('lib_thumb_put', { id, n: 1, b64: inp.thumb }); it.plates = [1]; }
      else if (ext !== 'stl') {
        const md = await fileMeta({ token: inp.token });
        if (md.thumb) { await native('lib_thumb_put', { id, n: 1, b64: md.thumb }); it.plates = [1]; }
        it.gcode = { printer: null, types: md.types || [] };
      }
    } catch (e) { /* ohne Bild — Datei ist trotzdem da */ }
    libItems().push(it);
    if (['stl', '3mf'].includes(ext)) { it.preview = 'busy'; it.busy_at = now(); libMeshBuild(it).catch(() => {}); }   // 3D-Ansicht im Hintergrund
    persist();
    return { ok: true, file: libOut(it), used: libUsed() };
  },
  async lib_update(inp) {
    const f = libItems().find(x => x.id === +inp.id) || fail('not_found');
    if (inp.name !== undefined && str(inp.name, 120)) f.name = str(inp.name, 120);
    if (inp.folder !== undefined) f.folder = libFolder(inp.folder);
    if (inp.tags !== undefined) f.tags = libTags(inp.tags);
    if (inp.notes !== undefined) f.notes = libNote(inp.notes);
    persist();
    return { ok: true, file: libOut(f) };
  },
  async lib_delete(inp) {
    const f = libItems().find(x => x.id === +inp.id) || fail('not_found');
    await libRemove(f);
    db.library = libItems().filter(x => x !== f);
    persist();
    return { ok: true, used: libUsed() };
  },
  /** Mehrfachauswahl: { ids, folder | tag_add | tag_del | del } */
  async amp_lib_bulk(inp) {
    const ids = new Set((inp.ids || []).map(Number)), its = libItems().filter(x => ids.has(x.id));
    if (inp.del) {
      for (const f of its) await libRemove(f);
      db.library = libItems().filter(x => !ids.has(x.id)); persist();
      return { ok: true, n: its.length, used: libUsed() };
    }
    const del = String(inp.tag_del || '').trim().toLowerCase();
    for (const f of its) {
      if (inp.folder !== undefined) f.folder = libFolder(inp.folder);
      if (inp.tag_add) f.tags = libTags([...(f.tags || []), inp.tag_add]);
      if (del) f.tags = (f.tags || []).filter(x => x.toLowerCase() !== del);
    }
    persist();
    return { ok: true, n: its.length, files: its.map(libOut) };
  },
  /** Foto vom fertigen Druck: { id, b64 (data:image/…) } oder { id, remove } — liegt als Vorschaubild Nr. 0 */
  async amp_lib_photo(inp) {
    const f = libItems().find(x => x.id === +inp.id) || fail('not_found');
    if (inp.remove) f.photo = false;
    else {
      const b = String(inp.b64 || '');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(b) || b.length > 6e6) fail('bad_file');
      await native('lib_thumb_put', { id: f.id, n: '0', b64: b });   // als Text: Agent/Handy lesen 0 als Zahl sonst als „1“
      f.photo = true;
    }
    f.v = (f.v || 1) + 1; persist();
    return { ok: true, file: libOut(f) };
  },
  /** Druckbuch einer Datei: Aufträge wie in „Druckaufträge“, neueste zuerst; before = ältere Drucke ohne Eintrag */
  async amp_lib_book(inp) {
    const f = libItems().find(x => x.id === +inp.id) || fail('not_found');
    const js = (f.jobs || []).map(id => db.jobs.find(j => j.id === id)).filter(Boolean).sort((a, b) => ts(b.start) - ts(a.start));
    return { jobs: js.map(jobItem), before: Math.max(0, (f.prints || 0) - (f.jobs || []).length) };
  },
  /** Bettmaße je Drucker für „passt auf“ (Bibliothek, 18.11.2026): [{ id, key, name, bed: [w, d, h] | null }]. Profile ohne Bettmaße einmal holen. */
  async amp_lib_beds() {
    await Promise.all(db.printers.map(p => (!p.prof || !('bed' in p.prof) || profBedStale(p.prof)) ? profileOf(p).catch(() => null) : null));
    return { printers: db.printers.map(p => ({ id: p.id, key: 'moonraker:' + p.id, name: p.name, bed: (p.prof && p.prof.bed) || null })) };
  },
  /** Platte speichern (18.11.2026): { id? (bestehende Platte ändern), name, folder, parts: [{ id, n, slot }], thumb: data:image/png } */
  async amp_lib_plate_save(inp) {
    const parts = libPlateParts(inp.parts);
    if (!parts.length) return { error: 'plate_empty' };
    let f = inp.id ? libItems().find(x => x.id === +inp.id && x.loc === 'plate') : null;
    const fresh = !f;
    if (fresh) f = { id: nextId('lib'), name: '', folder: '', tags: [], notes: '', ext: '', size: 0, orig: '', created: now(), printed: null, prints: 0,
                     loc: 'plate', key: null, doc: null, plates: [], v: 1, parts: [] };
    // Bild zuerst, Eintrag danach: sonst steht eine neue Platte kurz ohne Bild in der Liste (eine Abfrage dazwischen sieht sie halb)
    if (/^data:image\/png;base64,/.test(String(inp.thumb || ''))) {
      try { await native('lib_thumb_put', { id: f.id, n: '1', b64: String(inp.thumb) }); f.plates = [1]; f.v = (f.v || 1) + 1; } catch (e) { diag({ a: 'plate_thumb', err: String(e && e.message).slice(0, 40) }); }
    }
    f.name = str(inp.name, 120) || f.name || parts[0].name;
    if (inp.folder !== undefined) f.folder = libFolder(inp.folder);
    f.parts = parts;
    if (inp.edp !== undefined) f.edp = /^moonraker:[A-Za-z0-9_-]{1,40}$/.test(String(inp.edp || '')) ? String(inp.edp) : null;   // Drucker, für den der Editor angeordnet hat
    if (fresh) libItems().push(f);
    persist();
    return { ok: true, file: libOut(f) };
  },
  /** Datei aus der Bibliothek als Token (G-Code direkt drucken: viewGcode bekommt sie wie eine gewählte Datei) */
  async amp_lib_token(inp) {
    const f = libItems().find(x => x.id === +inp.id && !x.want) || fail('not_found');
    let r;
    try { r = await libGrab(f); } catch (e) { if (/^lib_dav_/.test(e.message)) return { error: e.message, status: e.status || 0 }; throw e; }
    return { token: r.token, name: f.orig, size: +r.size || f.size };
  },
  /** Modelle auf 3DSEARCH suchen → Treffer (saved = schon gemerkt bzw. in der Bibliothek, folder = dessen Sammlung).
   *  Filter (13.11.2026): sources [] (mehrere Plattformen), price ''|'free'|'paid', group = Hauptgruppe wie /categories,
   *  sort relevance|first_seen|likes|makes (Downloads bewusst nicht, User 13.11.). Alt: source (Text), free (bool). */
  async amp_s3d_search(inp) {
    const srcs = (Array.isArray(inp.sources) ? inp.sources : String(inp.source || '').split(',')).map(x => String(x).trim().toLowerCase()).filter(x => /^[a-z0-9]{2,20}$/.test(x)).slice(0, 12);
    const price = inp.price === 'paid' ? 'false' : inp.price === 'free' || inp.free ? 'true' : '';
    const group = /^[a-z]{2,12}$/.test(String(inp.group || '')) ? String(inp.group) : '';
    const sort = ['first_seen', 'likes', 'makes'].includes(inp.sort) ? inp.sort : '';
    const designer = str(inp.designer, 80) || '';   // „Mehr von diesem Designer“ (14.11.2026), exakter Name
    // safe=1 (25.11.2026, App Store): auch die Suche mit Suchbegriff ohne Erwachseneninhalte (Tags + Namen) und ohne Sketchfab,
    // wie Startseite/Vorschläge/Ähnliche — sonst Altersfreigabe 18+ bzw. Ablehnung bei Apple (Richtlinie 1.1.4)
    const d = await s3dGet('search', { q: str(inp.q, 120) || '', page: Math.max(1, +inp.page || 1), per_page: 24, source: srcs.join(','), is_free: price, group, sort, designer, safe: 1 });
    if (d.error || !Array.isArray(d.hits)) return { error: d.error || 'net' };
    return { hits: d.hits.map(s3dHitLib), page: +d.page || 1, pages: +d.pages || 1, found: +d.found || 0 };
  },
  // Startseite, Vorschläge, Ähnliche (14.11.2026, User: „Modellseite optimieren wie 3DSEARCH“). safe=1: ohne Erwachseneninhalte und Sketchfab.
  /** Gerade beliebt (api/v1/models/trending) */
  async amp_s3d_trending(inp) {
    const n = Math.max(4, Math.min(24, +inp.n || 12));
    if (!s3dTrend || s3dTrend.n !== n || Date.now() - s3dTrend.at > 600000) {
      const d = await s3dGet('models/trending', { per_page: n, safe: 1 });
      if (d.error || !Array.isArray(d.hits)) return { error: d.error || 'net' };
      s3dTrend = { n, at: Date.now(), hits: d.hits };
    }
    return { hits: s3dTrend.hits.map(s3dHitLib) };
  },
  /** Neu hinzugekommen (Startseite der Modellsuche, 17.11.2026): neueste zuerst wie die 3DSEARCH-Startseite, safe=1 wie „Gerade beliebt“ */
  async amp_s3d_new(inp) {
    const d = await s3dGet('search', { q: '', page: Math.max(1, +inp.page || 1), per_page: 24, sort: 'first_seen', safe: 1 });
    if (d.error || !Array.isArray(d.hits)) return { error: d.error || 'net' };
    return { hits: d.hits.map(s3dHitLib), page: +d.page || 1, pages: +d.pages || 1, found: +d.found || 0 };   // found: Zahl der Modelle für die Kopfzeile (18.11.2026)
  },
  // ── Wettbewerbe (18.11.2026, User: Modellsuche „fast genau so wie 3DSEARCH … auch die Wettbewerbe“): api/v1/contests ──
  /** Liste: status open|past, platform, Seite; laufende nach Enddatum (endet bald zuerst), beendete zuletzt beendet zuerst */
  async amp_s3d_contests(inp) {
    const status = inp.status === 'past' ? 'past' : 'open', platform = /^[a-z0-9]{2,20}$/.test(String(inp.platform || '')) ? String(inp.platform) : '';
    const d = await s3dGet('contests', { status, platform, page: Math.max(1, +inp.page || 1), per_page: Math.max(1, Math.min(40, +inp.n || 24)), sort: status === 'open' ? 'ends' : '' });
    if (d.error || !Array.isArray(d.contests)) return { error: d.error || 'net' };
    const cnt = L => (Array.isArray(L) ? L : []).map(x => ({ platform: str(x.platform, 30) || '', n: Math.max(0, +x.count || 0) })).filter(x => x.platform);
    return { contests: d.contests.map(s3dContest), page: +d.page || 1, pages: +d.pages || 0, found: +d.total || 0,
             active: +(d.stats && d.stats.active) || 0, past: +(d.stats && d.stats.past) || 0, platforms: cnt(d.platforms_open) };
  },
  /** Ein Wettbewerb mit Beschreibung, Preisen (Zeilen) und Link zum Mitmachen */
  async amp_s3d_contest(inp) {
    const id = Math.max(0, parseInt(inp.id, 10) || 0);
    if (!id) return { error: 'not_found' };
    const d = await s3dGet('contests/' + id);
    if (d.error || !d.contest) return { error: d.error || 'not_found' };
    const c = d.contest;
    return { contest: { ...s3dContest(c), description: str(c.description, 4000) || '', prizes: (Array.isArray(c.prizes) ? c.prizes : []).slice(0, 10).map(x => str(x, 160)).filter(Boolean),
      url: /^https?:\/\//.test(c.url || '') ? c.url : null, winners: Math.max(0, +d.winners || 0) } };
  },
  /** Eingereichte Modelle eines Wettbewerbs (seitenweise, Gewinner zuerst bzw. neueste) */
  async amp_s3d_contest_models(inp) {
    const id = Math.max(0, parseInt(inp.id, 10) || 0);
    if (!id) return { error: 'not_found', hits: [] };
    const d = await s3dGet('contests/' + id + '/models', { sort: inp.sort === 'new' ? 'new' : 'likes', page: Math.max(1, +inp.page || 1), per_page: 24, safe: 1 });
    if (d.error || !Array.isArray(d.hits)) return { error: d.error || 'net', hits: [] };
    return { hits: d.hits.map(h => ({ ...s3dHitLib(h), winner: !!h.is_winner })), page: +d.page || 1, pages: +d.pages || 0, found: +d.found || 0 };
  },
  /** Ähnliche Modelle im Modell-Dialog */
  async amp_s3d_related(inp) {
    const d = await s3dGet('models/' + encodeURIComponent(String(inp.id || '')) + '/related', { per_page: 10, safe: 1 });
    if (d.error || !Array.isArray(d.hits)) return { error: d.error || 'net', hits: [] };
    return { hits: d.hits.map(s3dHitLib) };
  },
  /** Vorschläge beim Tippen: Begriffe (Tags), Modelle (Name + Bild), Designer */
  async amp_s3d_suggest(inp) {
    const q = str(inp.q, 80) || '';
    if (q.length < 2) return { terms: [], models: [], designers: [] };
    const [m, t, d] = await Promise.all([s3dGet('autocomplete', { q, safe: 1 }), s3dGet('autocomplete/tags', { q, safe: 1 }), s3dGet('autocomplete/designers', { q, safe: 1 })]);
    const lst = (x, k) => (x && !x.error && Array.isArray(x[k]) ? x[k] : []);
    return { terms: lst(t, 'results').map(x => str(x, 60)).filter(Boolean).slice(0, 6),
             models: lst(m, 'suggestions').slice(0, 4).map(x => ({ id: String(x.id || ''), name: str(x.name, 160) || '?', img: x.img || null, source: str(x.source, 30) || '' })).filter(x => x.id),
             designers: lst(d, 'results').map(x => str(x, 80)).filter(Boolean).slice(0, 3) };
  },
  /** Einzelnes Modell (Beschreibung, alle Bilder, Lizenz) */
  async amp_s3d_model(inp) {
    const d = await s3dGet('models/' + encodeURIComponent(String(inp.id || '')));
    if (d.error || !d.model) return { error: d.error || 'not_found' };
    const m = d.model, x = s3dHit({ ...m, img: (m.imgs || [])[0] || null }), w = libWantOf(x.id);
    return { model: { ...x, imgs: (m.imgs || []).slice(0, 8), summary: str(m.summary, 1500) || '', saved: w ? w.id : null, folder: w ? w.folder || '' : '' } };
  },
  /** Merken: Eintrag ohne Datei (oder den vorhandenen zurück). folder (13.11.2026, „Zur Sammlung“): Sammlung = Ordner der
   *  Bibliothek; ist das Modell schon da, wird es dorthin verschoben ('' = ohne Sammlung). Ohne folder bleibt der Ordner, wie er ist. */
  async amp_lib_want(inp) {
    const h = s3dHit(inp.hit || {});
    if (!h.id || !h.url) fail('bad_request');
    const folder = inp.folder === undefined || inp.folder === null ? null : libFolder(inp.folder);
    const old = libWantOf(h.id);
    if (old) {
      if (folder === null || (old.folder || '') === folder) return { ok: true, file: libOut(old), existed: true };
      old.folder = folder; old.v = (old.v || 1) + 1; persist();
      return { ok: true, file: libOut(old), existed: true, moved: true };
    }
    const it = { id: nextId('lib'), name: h.name.slice(0, 120), folder: folder || '', tags: libTags(h.tags.slice(0, 6)), notes: '', ext: '', size: 0, orig: '', created: now(), printed: null, prints: 0,
                 loc: 'want', key: null, doc: null, plates: [], v: 1, want: true,
                 remote: { id: h.id, url: h.url, source: h.source, designer: h.designer, license: h.license, img: h.img, is_free: h.is_free } };
    libItems().push(it); persist();
    return { ok: true, file: libOut(it) };
  },
  /** Sammlungen = Ordner der Bibliothek mit allen Zwischenstufen (A, A/B), n = Einträge darin samt Unterordnern */
  async amp_lib_folders() {
    const n = {};
    libItems().forEach(f => { const ps = String(f.folder || '').split('/').filter(Boolean); ps.forEach((_, i) => { const k = ps.slice(0, i + 1).join('/'); n[k] = (n[k] || 0) + 1; }); });
    return { folders: Object.keys(n).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).map(path => ({ path, n: n[path] })),
             want: libItems().filter(f => f.want).length, total: libItems().length };
  },
  /** Datei an ein gemerktes Modell hängen: wie Hochladen, Name/Ordner/Tags/Notizen/Quelle kommen vom gemerkten Eintrag, der dann weg ist */
  async amp_lib_attach(inp) {
    const w = libItems().find(x => x.id === +inp.id && x.want) || fail('not_found');
    const r = await A.lib_upload({ token: inp.token, name: inp.name, size: inp.size, folder: w.folder, thumb: inp.thumb || null });
    if (r.error) return r;
    const it = libItems().find(x => x.id === r.file.id);
    Object.assign(it, { name: w.name, tags: (w.tags || []).slice(), notes: w.notes || '', remote: w.remote });
    await libRemove(w);
    db.library = libItems().filter(x => x !== w);
    persist();
    return { ok: true, file: libOut(it), used: libUsed(), was: w.id };
  },
  /** STL ohne Bild (aus „Teilen“ angehängt): Bild nachreichen, das die Oberfläche gezeichnet hat */
  async amp_lib_setthumb(inp) {
    const f = libItems().find(x => x.id === +inp.id) || fail('not_found');
    if (f.want || (f.plates || []).length || !/^data:image\/png;base64,/.test(String(inp.b64 || ''))) return { ok: false };
    await native('lib_thumb_put', { id: f.id, n: '1', b64: inp.b64 }); f.plates = [1]; f.v = (f.v || 1) + 1; persist();
    return { ok: true, file: libOut(f) };
  },
  async lib_rebuild(inp) { const f = libItems().find(x => x.id === +inp.id && !x.want) || fail('not_found'); f.preview = 'busy'; f.busy_at = now(); libMeshBuild(f).catch(() => {}); return { ok: true }; },
  /** „Speichern unter“ (statt Herunterladen): Kopie an einen Ort nach Wahl */
  async amp_lib_save_as(inp) {
    const f = libItems().find(x => x.id === +inp.id && !x.want) || fail('not_found');
    const r = f.loc === 'dav' ? await davCall('GET', f.doc, { name: f.orig, timeout: 300000 }) : await native('lib_get', { key: f.key || '', doc: f.doc || '', name: f.orig });
    if (!r || !r.token) return { error: 'lib_dav_' + davErr(r) };
    try { return (await native('lib_save_as', { token: r.token, name: f.orig })) || { ok: false }; } finally { native('fileDrop', { token: r.token }).catch(() => {}); }
  },
  async amp_lib_loc() {
    const l = db.settings.lib_loc;
    if (l && l.dav) return { loc: 'dav', name: l.name, url: l.url, user: l.user, has_pass: !!l.pass, backup: l.backup !== false,
                             backup_at: db.settings.dav_backup_at || null, backup_err: db.settings.dav_backup_err || null };
    if (!l || !l.uri) return { loc: 'app' };
    const ok = await native('lib_dir_ok', { uri: l.uri }).then(r => !!r.ok).catch(() => false);
    return { loc: 'dir', name: l.name, ok };
  },
  async amp_lib_dir() {
    const r = await native('lib_dir_pick');
    if (!r || !r.uri) return { ok: false };
    db.settings.lib_loc = { uri: r.uri, name: r.name || '' }; persist();
    return { ok: true, name: r.name };
  },
  async amp_lib_app() { delete db.settings.lib_loc; persist(); return { ok: true }; },
  /** NAS (WebDAV) prüfen und übernehmen: Testdatei schreiben und wieder löschen. Leeres Passwort = bisheriges behalten. */
  async amp_lib_dav(inp) {
    let url = String(inp.url || '').trim().replace(/\/+$/, '');
    if (!url) return { error: 'url' };
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    try { new URL(url); } catch (e) { return { error: 'url' }; }
    const old = davCfg(), user = String(inp.user || '').trim();
    const pass = inp.pass ? String(inp.pass) : old && old.url === url && old.user === user ? old.pass : '';
    const cfg = { dav: true, url, user, pass, scheme: '' };
    let r = null, err = null;
    try { r = await davCall('PUT', davUrl(url, '.allmyprinters-test'), { text: 'AllMyPrinters ' + now(), timeout: 15000 }, cfg); } catch (e) { err = e; }
    if (!r || r.status < 200 || r.status >= 300) return { error: davErr(r, err), status: r ? r.status : 0 };
    if (r.scheme === 'digest') cfg.scheme = 'digest';
    await davCall('DELETE', davUrl(url, '.allmyprinters-test'), {}, cfg).catch(() => {});
    const u = new URL(url);
    cfg.name = u.host + (u.pathname !== '/' ? u.pathname : '');
    cfg.backup = inp.backup !== false;
    db.settings.lib_loc = cfg; persist();
    davBackup(false).catch(() => {});
    return { ok: true, name: cfg.name };
  },
  async amp_dav_backup(inp) {
    const c = davCfg(); if (!c) return { error: 'off' };
    if (inp.on !== undefined) { c.backup = !!inp.on; persist(); if (!inp.now) return { ok: true }; }
    return davBackup(true);
  },
  /** Tag angetippt: zu welcher Spule gehört er? (+ OpenSpool-Inhalt zum Vorbelegen) */
  async amp_nfc_tag(inp) {
    const uid = nfcUid(inp.uid) || fail('uid');
    const s = spoolByNfc(uid);
    return { uid, type: inp.type || null, spool: s ? s.id : null, archived: s ? !!s.archived_at : false, name: s ? s.name : null,
             os: inp.openspool ? osParse(inp.openspool) : null };
  },
  /** Tag mit Spule verknüpfen. Gehört er schon einer anderen: ohne move → { error: 'taken', other, name }. */
  async amp_nfc_link(inp) {
    const s = own(inp.spool), uid = nfcUid(inp.uid) || fail('uid');
    const o = spoolByNfc(uid);
    if (o && o.id !== s.id && !inp.move) return { error: 'taken', other: o.id, name: o.name };
    nfcAdd(s, [uid], 'tap', inp.type || null);
    return reply(s.id);
  },
  async amp_nfc_unlink(inp) { const s = own(inp.spool), uid = nfcUid(inp.uid); s.nfc = (s.nfc || []).filter(x => x.uid !== uid); return reply(s.id); },
  async settings_save(inp) {
    if (inp.k === 'onboard') db.settings.onboard_hidden = !!(inp.v && inp.v.hidden);
    else if (inp.k === 'currency') db.settings.currency = /^[A-Z]{3}$/.test((inp.v || {}).c || '') ? inp.v.c : 'EUR';
    else if (inp.k === 'slicer') {   // Einstellungen → Slicer: eigener nur mit gültiger Adresse (der Test lief vorher)
      const v = inp.v || {}, url = slcNorm(v.url);
      db.settings.slicer = v.mode === 'own' && url ? { mode: 'own', url } : { mode: 'default', url: url || (db.settings.slicer || {}).url || '' };
    }
    else if (typeof inp.k === 'string' && /^amp_[a-z_]+$/.test(inp.k)) db.settings[inp.k] = inp.v;
    persist(); return { ok: true };
  },
  // Druckkosten (15.11.2026): Strompreis, Verschleiß je Druckstunde, Leistung je Drucker — Felder wie /filament bindCosts
  async costs() {
    const c = db.settings.costs || {};
    return { cfg: { kwh: c.kwh ?? null, wear_h: c.wear_h ?? null },
             printers: db.printers.map(p => ({ provider: 'moonraker', pid: p.id, name: p.name, model: p.model || '', power_w: p.power_w ?? null })) };
  },
  async costs_save(inp) {
    const num = (v, a, b) => v === '' || v == null || !Number.isFinite(+v) ? null : clamp(+v, a, b);
    db.settings.costs = { kwh: num(inp.kwh, 0, 5), wear_h: num(inp.wear_h, 0, 100) };
    for (const [k, v] of Object.entries(inp.power || {})) {
      const p = db.printers.find(x => 'moonraker:' + x.id === k); if (!p) continue;
      const w = num(v, 1, 3000);
      if (w === null) delete p.power_w; else p.power_w = Math.round(w);
    }
    persist(); return { ok: true };
  },
  // Wartung (20.11.2026): Antworten wie 3DSEARCH filament/maint_api.php, damit viewMaint/drawMaint von /filament unverändert laufen
  async maint() {
    const log = {};
    for (const l of mtLog().slice().reverse()) { const a = log[l.task_id] || (log[l.task_id] = []); if (a.length < 5) a.push({ at: l.at, hours: l.hours, grams: l.grams, prints: l.prints, note: l.note || null }); }
    const printers = db.printers.map(p => { const e = (live[p.id] || {}).good || (live[p.id] || {}).entry || {};
      return { provider: 'moonraker', pid: String(p.id), name: p.name, model: p.model || '', img: p.img || '', img_own: !!p.img, power_w: p.power_w ?? null,
               hours: e.stats && e.stats.hours ? +e.stats.hours : mtHours(p.id) || null, parts: null }; });
    return { printers, tasks: mtTasks(), log, now: now() };
  },
  async maint_save(inp) {
    const id = +inp.id || 0;
    const title = String(inp.title || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 80) fail('fields');
    const int = (v, a, b) => v === '' || v == null || !Number.isFinite(+v) ? null : Math.round(clamp(+v, a, b));
    const kgv = inp.every_kg === '' || inp.every_kg == null || !Number.isFinite(+inp.every_kg) ? null : clamp(+inp.every_kg, 0.01, 1000);
    const every = { every_hours: int(inp.every_hours, 1, 20000), every_grams: kgv !== null ? Math.round(kgv * 1000) : null,
                    every_prints: int(inp.every_prints, 1, 20000), every_days: int(inp.every_days, 1, 3650) };
    if (!Object.values(every).some(v => v)) fail('maint_no_interval');
    const last = mtDay(inp.last_done);
    let x;
    if (id) {
      x = mtList().find(m => m.id === id) || fail('not_found');
      Object.assign(x, { title }, every);
      if (last) x.last_done_at = last;
    } else {
      const p = db.printers.find(q => String(q.id) === String(inp.pid)) || fail('not_found');
      if (mtList().length >= 100) fail('maint_max');
      x = { id: nextId('maint'), printer_id: p.id, title, ...every, last_done_at: last || now(), created_at: now() };
      mtList().push(x);
    }
    persist(true);
    return { ok: true, task: mtOut(x) };
  },
  async maint_done(inp) {
    const x = mtList().find(m => m.id === +inp.id) || fail('not_found'), o = mtOut(x);
    const note = String(inp.note || '').trim().slice(0, 255);
    mtLog().push({ id: nextId('mlog'), task_id: x.id, at: now(), hours: o.used.hours, grams: o.used.grams, prints: o.used.prints, note: note || null });
    if (mtLog().length > 2000) db.maint_log = mtLog().slice(-2000);
    x.last_done_at = now();
    persist(true);
    return { ok: true };
  },
  async maint_delete(inp) {
    const id = +inp.id;
    db.maint = mtList().filter(m => m.id !== id);
    db.maint_log = mtLog().filter(l => l.task_id !== id);
    persist(true);
    return { ok: true };
  },
  async since() { return { since: null }; },
  async mk_ask() { return { job: null }; },
  async printers(inp) { return printers(inp); },
  async jobs(inp) { return jobsOut(inp); },
  async slot_assign(inp) { return slotAssign(inp); },
  async slot_unassign(inp) { const sl = db.slots.find(s => s.id === +inp.slot_id) || fail('not_found'); sl.spool_id = null; persist(); return { ok: true }; },
  async slots_adopt(inp) {
    const ids = [];
    for (const it of inp.items || []) {
      const sl = db.slots.find(s => s.id === +it.slot_id); if (!sl || sl.spool_id) continue;
      const es = Object.values(live).map(L => L.entry).filter(Boolean).flatMap(e => e.slots).find(s => s.slot_id === sl.id) || {};
      const total = int(it.total, 1, 10000) || 1000, left = clamp(int(it.left, 0, 10000) ?? total, 0, total);
      // Ohne Produktnamen (ACE/Klipper melden nur Material + Farbe): Farbname aus der Farbfamilie, sonst hieße die Spule nur „PLA“
      const fam = es.color ? (window.FM && FM.S['fam_' + colorFamily(es.color)]) : '';
      const r = await spoolSave({ material: es.material || 'PLA', color: es.color, color_name: it.product || fam || '', total, left });
      const sp = own(r.ids[0]); sl.spool_id = sp.id;
      if (sl.pending_g >= 0.5) book(sp, sl.pending_g * adjOf(sl.printer_id), 'print', 'pending', '', printerName(sl.printer_id), true, { pid: sl.printer_id, raw: sl.pending_g });
      sl.pending_g = 0; ids.push(sp.id);
    }
    persist(); return { ok: true, ids };
  },
  async orphan_assign() { return { ok: true }; },
  async orphan_dismiss() { return { ok: true }; },
  /** „Adresse ändern“: prüfen, was unter der neuen Adresse antwortet; anderer Drucker → Fehler, keine Antwort → nur mit force. */
  async amp_set_host(inp) {
    const p = db.printers.find(x => x.id === inp.printer) || fail('not_found');
    const k = kindOf(p);
    const parse = s => {
      let [host, port] = String(s || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').split(':');
      if (!host || !/^[a-z0-9.-]+$/i.test(host)) fail('host');
      port = port ? +port : null;
      if (port !== null && !(port > 0 && port < 65536)) fail('host');
      if (port && k !== 'moonraker' && k !== 'octoprint' && k !== 'prusalink') port = null;   // feste Ports der Hersteller bleiben
      return { host, port };
    };
    const cur = p.main || addrOf(p);
    const owner = (host, port) => db.printers.find(o => o.id !== p.id && hostsOf(o).some(h => h.host === host && (h.port || 7125) === (port || 7125)));
    const { host, port } = parse(inp.host);
    const mport = port || cur.port || 7125;
    // Zweite Adresse (Feld im Dialog, leer = keine): prüfen, bevor irgendetwas gespeichert wird
    let alt;
    if (inp.alt !== undefined) {
      alt = null;
      if (String(inp.alt || '').trim()) {
        alt = parse(inp.alt); alt.port = alt.port || mport;
        if (alt.host === host && alt.port === mport) return { error: 'alt_same', field: 'alt' };
        const o = owner(alt.host, alt.port);
        if (o) return { error: 'alt_taken', field: 'alt', name: o.name };   // derselbe Drucker als eigener Eintrag → würde doppelt buchen
        // Antwortet dort ein anderer Klipper? (Prüfbar nur, wenn dort jemand antwortet — unterwegs ist die Heimadresse stumm)
        if (k === 'moonraker' && !inp.force) {
          const d = await probe(alt.host, alt.port).catch(() => null);
          if (d && d.kind === 'moonraker' && d.mrhost && p.mrhost && d.mrhost !== p.mrhost) return { error: 'other', field: 'alt', name: d.name || '' };
        }
      }
    }
    const same = host === cur.host && mport === (cur.port || 7125);
    if (same && alt === undefined) return { ok: true, same: true };
    if (!same && owner(host, mport)) fail('exists');
    if (!same && !inp.force) {
      let d = null;
      if (k === 'acl') d = await acInfo(host, p.port || 18910);
      else if (k === 'creality') d = await crInfo(host, 80);
      else if (['moonraker', 'octoprint', 'prusalink'].includes(k)) d = await probe(host, mport).catch(() => null);
      if (d) {
        const dk = ['octoprint', 'prusalink', 'creality', 'acl'].includes(d.kind) ? d.kind : 'moonraker';
        if (dk !== k) return { error: 'kind' };
        const a = ampIdentOf(k, { ...p, port: cur.port }), b = ampIdentOf(k, { ...d, port: mport });
        if (a && b && a !== b) return { error: 'other', name: d.name || '' };
      } else {
        // Bambu, Elegoo, Flashforge: ohne Zugangscode lässt sich die Kennung nicht abfragen — reicht, dass der Port antwortet
        const pt = { bambu: bbPort(p, 'mqtt', 8883), sdcp: sdPort(p, 'ws', 3030), cc2: ccPort(p, 'mqtt', 1883), flashforge: (p.ports && p.ports.http) || 8898 }[k];
        const o = pt ? await native('tcpcheck', { host, port: pt }).catch(() => ({})) : {};
        if (!o.open) return { error: 'notfound' };
      }
    }
    if (!same) await ampMove(p, host, port, 'manual');
    if (alt !== undefined) {
      if (p.on_alt) await ampSwitch(p, p.main, false);   // neue/andere zweite Adresse: erst die erste, der Abgleich wechselt bei Bedarf
      if (alt) { p.main = p.main || addrOf(p); p.alt = alt; p.on_alt = false; }
      else { delete p.alt; delete p.main; delete p.on_alt; }
      const lv = live[p.id]; if (lv) { lv.altAt = 0; lv.mainAt = 0; }
      persist();
    }
    return { ok: true };
  },
  async printer_rename(inp) { const p = db.printers.find(x => x.id === inp.printer) || fail('not_found'); p.name = str(inp.name, 60) || p.name; persist(); return { ok: true }; },
  async printer_remove(inp) {
    db.printers = db.printers.filter(x => x.id !== inp.printer);
    db.slots = db.slots.filter(s => s.printer_id !== inp.printer);
    { const gone = new Set(mtList().filter(m => m.printer_id === inp.printer).map(m => m.id));   // Wartung des Druckers mit weg
      if (gone.size) { db.maint = mtList().filter(m => !gone.has(m.id)); db.maint_log = mtLog().filter(l => !gone.has(l.task_id)); } }
    delete live[inp.printer];
    persist(true); return { ok: true };
  },
  async printer_photo_del(inp) { const p = db.printers.find(x => x.id === inp.printer) || fail('not_found'); p.img = null; persist(); return { ok: true }; },
  async printer_cmd(inp) {
    const p = db.printers.find(x => x.id === inp.printer) || fail('not_found');
    if (p.kind === 'cloud') fail('cloud_ro');   // Hersteller-Konto: nur lesend — nie Befehle über die Cloud
    if ((inp.cmd === 'dry_start' || inp.cmd === 'dry_stop') && kindOf(p) === 'acl') {
      // ACE-Trocknung im LAN-Modus: multiColorBox setDry (Dauer in Minuten), Box-id aus dem letzten Bericht
      const pos = Math.max(0, int(inp.box, 0, 7) || 0), id = ((live[p.id] || {}).acBoxes || [])[pos] ?? pos;
      if (+id < 0) fail('no_dryer');   // Fachwechsler der Kobra X hat keinen Trockner
      const temp = int(inp.temp, 35, 55) ?? 45, minutes = Math.max(30, Math.min(1440, Math.round((num(inp.hours, 0.5, 24) ?? 4) * 60)));
      await acSend(p, 'multiColorBox', 'setDry', { multi_color_box: [{ id, drying_status: inp.cmd === 'dry_start' ? { status: 1, target_temp: temp, duration: minutes } : { status: 0, target_temp: 0, duration: 0 } }] });
      setTimeout(() => acSend(p, 'multiColorBox', 'getInfo').catch(() => {}), 1500);
      return { ok: true };
    }
    if (inp.cmd === 'dry_start' || inp.cmd === 'dry_stop') {
      // ACE-Trocknung über Rinkhals (Moonraker-Komponente mmu_ace, Endpunkt filament_hub) — Grenzen wie auf 3DSEARCH
      const box = Math.max(0, int(inp.box, 0, 7) || 0);
      if (inp.cmd === 'dry_start') {
        const temp = int(inp.temp, 35, 55) ?? 45, minutes = Math.max(30, Math.min(1440, Math.round((num(inp.hours, 0.5, 24) ?? 4) * 60)));
        await mrPost(p, '/server/filament_hub/start_drying', { id: box, temp, duration: minutes }, 15000);
        p.dry = { ...(p.dry || {}), [box]: { minutes, temp, at: Date.now() } };
      } else {
        await mrPost(p, '/server/filament_hub/stop_drying', { id: box }, 15000);
        if (p.dry) delete p.dry[box];
      }
      persist();
      return { ok: true };
    }
    if (inp.cmd === 'fan' || inp.cmd === 'light' || inp.cmd === 'speed') return ctlSet(p, inp);   // Lüfter und Licht (12.11.2026), Geschwindigkeit (21.11.2026)
    if (!['pause', 'resume', 'stop'].includes(inp.cmd)) fail('cmd');
    if (kindOf(p) === 'sdcp') await sdSend(p, { pause: 129, stop: 130, resume: 131 }[inp.cmd]);
    else if (kindOf(p) === 'cc2') await ccSend(p, { pause: 1021, stop: 1022, resume: 1023 }[inp.cmd]);   // Antwort kommt erst nach dem Ablauf
    else if (kindOf(p) === 'creality') await crSet(p, { pause: { pause: 1 }, resume: { pause: 0 }, stop: { stop: 1 } }[inp.cmd]);
    else if (kindOf(p) === 'acl') {
      // echte Auftragsnummer (acTaskOf); fehlt sie im letzten Abgleich, frisch aus dem Verbindungsstand
      let tid = (live[p.id] || {}).acTask || null;
      if (!tid) { try { await acOpen(p); tid = acTaskOf(((await native('live_state', { key: acKey(p) })) || {}).state || {}); } catch (e) {} }
      await acSend(p, 'print', inp.cmd, { taskid: tid || '-1' }); setTimeout(() => acSend(p, 'info', 'query').catch(() => {}), 1200);
      diag({ a: 'cmd', p: 'acl', m: p.model || '', err: '', d: inp.cmd + (tid ? ' taskid' : ' taskid=-1') });
    }
    else if (kindOf(p) === 'flashforge') await ffPost(p, '/control', { payload: { cmd: 'jobCtl_cmd', args: { jobID: '', action: { pause: 'pause', resume: 'continue', stop: 'cancel' }[inp.cmd] } } });
    else if (kindOf(p) === 'bambu') await native('live_send', { key: 'bb_' + p.id, payload: JSON.stringify({ print: { sequence_id: String(Date.now() % 100000), command: inp.cmd, param: '' } }) });
    else if (kindOf(p) === 'octoprint') await dj(p, 'POST', '/api/job', inp.cmd === 'stop' ? { command: 'cancel' } : { command: 'pause', action: inp.cmd }, 15000);
    else if (kindOf(p) === 'prusalink') {
      const jid = ((await dj(p, 'GET', '/api/v1/status')).job || {}).id;
      if (jid == null) fail('no_job');
      await dj(p, inp.cmd === 'stop' ? 'DELETE' : 'PUT', '/api/v1/job/' + jid + (inp.cmd === 'stop' ? '' : '/' + inp.cmd), null, 15000);
    } else await mrPost(p, { pause: '/printer/print/pause', resume: '/printer/print/resume', stop: '/printer/print/cancel' }[inp.cmd], {}, 15000);
    if (live[p.id]) live[p.id].histAt = 0;
    return { ok: true };
  },
  // Drucken mit Slicen (Druckansicht von /filament)
  async print_printers() { return slicePrinters(); },
  async print_files() { return { files: [], files_limit: 0, files_free: 0, files_sup: 0 }; },
  async machines() { return (MACH = MACH || await server('machines')); },
  async print_profile(inp) {
    const p = pkOf(inp.printer) || fail('no_printer');
    const [v, m] = String(inp.profile || '').split('|');
    p.prof = v && m ? { vendor: v, machine: m, chosen: true, at: 0 } : null;
    await profileOf(p).catch(() => {});
    persist(); return { ok: true };
  },
  async print_xdef(inp) {
    const p = pkOf(inp.printer); const prof = p && await profileOf(p).catch(() => null);
    if (!prof || !prof.machine) return { vals: {} };
    return server('xdef', { vendor: prof.vendor, machine: prof.machine, nozzle: inp.nozzle || '', material: inp.material || '', bed: inp.bed || 'textured' });
  },
  async print_job(inp) {
    const r = await server('job', { job: inp.job });
    const sj = (db.slicejobs || {})[inp.job];
    if (sj && sj.sent) r.sent = true;
    if (r.status === 'done' && r.plan) r.cost = planCost(sj && sj.printer, r.plan);
    if (r.status === 'done' && r.plan && sj && sj.printer) r.short = shortList(sj.printer, slicePlanItems(sj.printer, r.plan));
    return r;
  },
  async print_map(inp) {
    const sj = (db.slicejobs || {})[inp.job]; const p = sj && db.printers.find(x => x.id === sj.printer);
    if (!p) return { error: 'no_printer' };
    return server('map', {}, { job: inp.job, map: inp.map, printer: printerJson(p, live[p.id] && live[p.id].entry) });
  },
  async print_send(inp) { return sliceSend(inp); },
  /** Reicht die Spule? für eine fertige G-Code-Datei (Druckansicht #gcode): Gramm je Werkzeug → Fach wie beim Abbuchen in printSend */
  // ── Dateien am Drucker (24.11.2026, Community #57 Sebastian S.: „auf die schon hochgeladenen Dateien zugreifen, um sie direkt zu
  // starten“). Nur Klipper/Moonraker: /server/files/list (gcodes), neueste zuerst; Zeit, Gramm und Vorschaubild aus den Metadaten
  // (meta(), Bild über die Brücke) für die ersten 30. Start wie SEND.moonraker ohne Upload, vorher „Reicht die Spule?“.
  async print_pfiles(inp) {
    const p = pfPrinter(inp.printer), L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
    let list, st;
    try { [list, st] = await Promise.all([mrGet(p, '/server/files/list?' + qs({ root: 'gcodes' }), 8000), mrGet(p, '/printer/objects/query?print_stats', 4000).catch(() => null)]); }
    catch (e) { fail(e.message === 'unauthorized' ? 'unauthorized' : 'offline'); }
    const all = (Array.isArray(list) ? list : []).filter(f => f && typeof f.path === 'string' && /\.(gcode|gco|g)$/i.test(f.path) && !/(^|\/)\./.test(f.path))
      .sort((a, b) => (+b.modified || 0) - (+a.modified || 0));
    const files = all.slice(0, 100), top = files.slice(0, 30);
    for (let i = 0; i < top.length; i += 4) await Promise.all(top.slice(i, i + 4).map(f => meta(p, L, f.path).catch(() => ({}))));
    // Vorschaubilder kommen über die Brücke nach — kurz warten
    const want = top.filter(f => ((L.meta[f.path] || {}).thumbnails || []).length);
    for (let i = 0; i < 12 && want.some(f => !L.thumbs[f.path]); i++) await new Promise(z => setTimeout(z, 250));
    const s = (((st || {}).status || {}).print_stats || {}).state || '';
    return { busy: s === 'printing' || s === 'paused', total: all.length,
             files: files.map(f => { const md = L.meta[f.path] || null, w = md ? pfWeights(md) : null;
               return { path: f.path, name: f.path.split('/').pop(), size: +f.size || 0, modified: Math.round(+f.modified || 0),
                        time: md && +md.estimated_time > 0 ? Math.round(+md.estimated_time) : null, g: w ? Math.round(w.reduce((a, b) => a + b, 0) * 10) / 10 : null,
                        colors: w ? w.filter(x => x > 0).length : null, img: L.thumbs[f.path] || null }; }) };
  },
  async print_pfile_start(inp) {
    const p = pfPrinter(inp.printer), path = String(inp.path || '');
    if (!path || path.length > 500 || /(^|\/)\.\.(\/|$)/.test(path)) fail('not_found');
    const st = await mrGet(p, '/printer/objects/query?print_stats', 5000).catch(() => fail('offline'));
    const s = ((st.status || {}).print_stats || {}).state;
    if (s === 'printing' || s === 'paused') fail('printer_busy');
    if (!inp.force) {
      const L = live[p.id] || (live[p.id] = { meta: {}, thumbs: {}, histAt: 0 });
      const w = pfWeights(await meta(p, L, path));
      const short = w ? shortList(p.id, gcodeItems(p.id, w, null)) : [];
      if (short.length) return { short };
    }
    try { await mrPost(p, '/printer/print/start?' + qs({ filename: path }), {}, 20000); }
    catch (e) {
      if (/^http_404/.test(e.message)) fail('file_missing');
      if (/^http_/.test(e.message)) throw e;
      // spät antwortender Moonraker (große Datei) — wie SEND.moonraker kurz nachsehen
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) { await new Promise(z => setTimeout(z, 3000)); try { const q = await mrGet(p, '/printer/objects/query?print_stats', 4000); ok = (((q.status || {}).print_stats || {}).state) === 'printing'; } catch (e2) {} }
      if (!ok) fail('start_timeout');
    }
    diag({ a: 'pfile_start', p: 'moonraker', m: p.model || '', err: '', d: path.split('/').pop().slice(0, 60) });
    return { ok: true };
  },
  // ── Zeitraffer am Drucker (27.11.2026, Community #62 Donnie K., Snapmaker U1: „access the time-lapse videos“). Videos, die der Klipper-
  // Drucker aufgenommen hat, auflisten, abspielen und speichern. Moonraker: Wurzel „timelapse“ (moonraker-timelapse, U1 Extended-Firmware),
  // die U1-Originalfirmware legt sie in „camera“ ab (dort liegt auch monitor.jpg). Abspielen in amp-views ampTlDlg: App direkt vom Drucker,
  // Agent über /cam/file (Range durchgereicht, auch von unterwegs). Speichern wie „Speichern unter“ der Bibliothek (download → lib_save_as).
  async amp_cam_tl(inp) {
    const p = pfPrinter(inp.printer);
    let roots = null;
    try { const r = await mrGet(p, '/server/files/roots', 5000); roots = (Array.isArray(r) ? r : []).map(x => x && x.name).filter(Boolean); }
    catch (e) { if (e.message === 'unauthorized') fail('unauthorized'); if (!/^http_/.test(e.message)) fail('offline'); }
    const cand = TL_ROOTS.filter(r => !roots || roots.includes(r));
    let root = '', list = null;
    for (const r of cand) {
      try { list = await mrGet(p, '/server/files/list?' + qs({ root: r }), 8000); root = r; break; }
      catch (e) { if (e.message === 'unauthorized') fail('unauthorized'); if (!/^http_/.test(e.message)) fail('offline'); }
    }
    if (!root) return { root: '', files: [], total: 0, u1: isU1(p) };
    const items = (Array.isArray(list) ? list : []).filter(f => f && typeof f.path === 'string' && !/(^|\/)\./.test(f.path));
    const imgs = new Map(items.filter(f => /\.(jpe?g|png)$/i.test(f.path)).map(f => [f.path.replace(/\.[^./]+$/, ''), f.path]));
    const all = items.filter(f => TL_VIDEO.test(f.path)).sort((a, b) => (+b.modified || 0) - (+a.modified || 0));
    const url = fp => tlUrl(p, root, fp);
    return { root, total: all.length, u1: isU1(p),
             files: all.slice(0, 100).map(f => { const im = imgs.get(f.path.replace(/\.[^./]+$/, ''));
               return { path: f.path, name: f.path.split('/').pop(), size: +f.size || 0, modified: Math.round(+f.modified || 0), src: url(f.path), img: im ? url(im) : null }; }) };
  },
  async amp_cam_tl_save(inp) {
    const p = pfPrinter(inp.printer), root = String(inp.root || ''), path = String(inp.path || '');
    if (!TL_ROOTS.includes(root) || !TL_VIDEO.test(path) || path.length > 500 || /(^|\/)\.\.(\/|$)/.test(path)) fail('not_found');
    const name = path.split('/').pop();
    const r = await native('download', { url: tlUrl(p, root, path), headers: p.key ? { 'X-Api-Key': p.key } : {}, name });
    if (!r || r.status !== 200 || !r.token) fail(r && r.status === 404 ? 'file_missing' : r && (r.status === 401 || r.status === 403) ? 'unauthorized' : 'offline');
    try { return (await native('lib_save_as', { token: r.token, name })) || { ok: false }; } finally { native('fileDrop', { token: r.token }).catch(() => {}); }
  },
  async print_short(inp) {
    const p = db.printers.find(x => x.id === inp.printer);
    return { short: p ? shortList(p.id, gcodeItems(p.id, inp.weights, inp.map)) : [] };
  },
  async print_queue_add() { return { error: 'unsupported' }; },
  async print_file_del() { return { error: 'unsupported' }; },
  async print_reprint() { return { error: 'unsupported' }; },
  async print_retarget() { return { error: 'unsupported' }; },
  /** Oberfläche hat alle gefundenen Kamera-Quellen ohne Bild aufgegeben → ins Protokoll (Art, Port+Pfad, Grund aus Cam.kt ohne Adresse) */
  async amp_cam_fail(inp) {
    const p = db.printers.find(x => x.id === inp.printer);
    if (!p) return { ok: false };
    const list = (Array.isArray(inp.list) ? inp.list : []).slice(0, 8);
    // WebRTC-Gründe (amp-views rtcWhy, 26.11.2026) sind länger: „ice:failed no_track H264 c2l1 ip“
    const why = w => String(w || '').split('; ').map(t => t.replace(/^.*?: /, '')).join('; ').slice(0, 64);
    diag({ a: 'cam_play', p: kindOf(p), m: p.model || '', err: 'no_picture', d: list.map(x => String(x.kind || '?').slice(0, 6) + ' ' + camShort(String(x.url || '')) + (x.why ? '=' + why(x.why) : '')).join(' ') });
    return { ok: true };
  },
  async amp_cam(inp) {
    const p = db.printers.find(x => x.id === inp.printer) || fail('not_found');
    if (p.kind === 'cloud') return { sources: [] };
    return { sources: await camSources(p, !!inp.force) };
  },
  /** WebRTC-Angebot an den Creality-Drucker (POST …/call/webrtc_local, Inhalt base64 von {"type":"offer","sdp",[token]}), Antwort ebenso. */
  async amp_webrtc(inp) {
    const p = db.printers.find(x => x.id === inp.printer) || fail('not_found');
    const url = String(inp.url || '');
    if (kindOf(p) !== 'creality' || !url.startsWith(`http://${p.host}:`)) fail('url');
    let S = ((await native('live_state', { key: crKey(p) }).catch(() => ({}))).state) || {};
    // Verschlüsseltes Video (features videoInfo.videoEncryption): Creality Print schickt ein Token mit → vorher holen
    if (!S.videoToken && JSON.stringify(S.features || '').includes('videoEncryption')) {
      await crGet(p, { getToken: 1 }).catch(() => {});
      for (let i = 0; i < 6 && !S.videoToken; i++) { await new Promise(z => setTimeout(z, 250)); S = ((await native('live_state', { key: crKey(p) }).catch(() => ({}))).state) || {}; }
    }
    // Eigene Adresse statt „.local“ (26.11.2026, K2 Pro am iPhone ohne Bild, Meldung #35): WebKit und Chromium verstecken die eigene Adresse
    // im Angebot hinter einem zufälligen mDNS-Namen (iOS-Simulator geprüft: nur „….local“). Creality Print schickt echte Adressen; löst der
    // Drucker .local nicht auf, bliebe nur der Umweg über unsere Prüfanfragen. Nur in der App — im Agenten läuft WebRTC im Browser eines
    // anderen Geräts, dessen Adresse wir nicht kennen.
    let sdp = String(inp.sdp || ''), ours = 'local';
    try {
      if (!(await native('info', {})).agent) {
        const ip = String((await native('net', {})).ip || '');
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { const s2 = sdp.replace(/^(a=candidate:\S+ \d+ \S+ \d+ )[0-9a-z-]+\.local( \d+ typ host)/gim, '$1' + ip + '$2'); if (s2 !== sdp) { sdp = s2; ours = 'ip'; } }
      }
    } catch (e) { /* ohne Adresse wie bisher */ }
    const offer = { type: 'offer', sdp }; if (S.videoToken) offer.token = String(S.videoToken);
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(offer))));
    const r = await native('http', { url, method: 'POST', headers: { 'Content-Type': 'plain/text' }, body: b64, timeout: 15000, max: 200000 });
    if (r.status !== 200) fail('cam_' + r.status);
    let a; try { a = JSON.parse(decodeURIComponent(escape(atob(String(r.text || '').trim())))); } catch (e) { fail('cam_answer'); }
    if (!a || !a.sdp) fail('cam_answer');
    // .local-Kandidaten des Druckers durch seine Adresse ersetzen (Creality Print macht das ebenso; Android löst .local nicht auf)
    // info fürs Protokoll, falls trotzdem kein Bild kommt (amp-views rtcWhy): Video-Codec der Antwort, Kandidaten des Druckers, unsere Adresse
    const as = String(a.sdp), pt = (/^m=video \d+ \S+ (\d+)/m.exec(as) || [])[1];
    const codec = pt ? ((new RegExp('^a=rtpmap:' + pt + ' ([A-Za-z0-9]+)', 'm').exec(as) || [])[1] || '?') : 'no_video';
    const cands = (as.match(/^a=candidate:.*$/gm) || []);
    return { sdp: as.replace(/[0-9a-z-]+\.local\b/gi, p.host), info: { codec, ours, cands: cands.length, local: cands.filter(l => /\.local /.test(l)).length } };
  },
  /** QR-Code einer Spule: unsere Etiketten (allmyprinters.com/s/<id>, auch …/filament/#s<id>), Spoolman (web+spoolman:s-<n>), nackt „#31“. */
  async resolve_qr(inp) {
    const code = String(inp.code || '').trim();
    // QR-Code des AllMyPrinters-Agenten (Einstellungen → Geräte koppeln) → App mit dem Agenten verbinden
    if (/^https:\/\/allmyprinters\.com\/web\/?#pair=[A-Za-z0-9_-]{100,}$/.test(code)) return { agent: code };
    let m, sp = null;
    if ((m = /allmyprinters\.com\/s\/(\d+)/i.exec(code) || /#s(\d+)$/.exec(code) || /^#?(\d{1,9})$/.exec(code))) sp = db.spools.find(s => s.id === +m[1]);
    else if ((m = /^web\+spoolman:s-(\d+)/i.exec(code))) sp = db.spools.find(s => s.ext_ref === 'spoolman:' + m[1]);
    return sp ? { spool: sp.id } : { error: 'qr_unknown' };
  },
  async amp_cam_off(inp) {
    const p = db.printers.find(x => x.id === inp.printer);
    if (p && kindOf(p) === 'sdcp') await sdSend(p, 386, { Enable: 0 }).catch(() => {});
    return { ok: true };
  },
  /** Snapmaker U1 (Originalfirmware): Kamera wach halten, solange die Ansicht das Bild zeigt (alle 10 s, siehe u1CamWake). */
  async amp_cam_wake(inp) {
    const p = db.printers.find(x => x.id === inp.printer) || fail('not_found');
    return { ok: isU1(p) ? await u1CamWake(p, false) : false };
  },
  async printer_cam_ok() { return { ok: true }; },
  // ── Neu in der App: Drucker suchen/hinzufügen, Drucken, Sicherung ──
  async amp_net() { return native('net'); },
  async amp_scan() {
    const n = await native('net');
    if (!n.ip) return { hosts: [], net: n };
    const ssdp = native('udp', { listen: 2021, ms: 7000 }).catch(() => ({ packets: [] }));
    // Elegoo SDCP: Rundruf „M99999“ an Port 3000 (Netz-Broadcast aus IP/Präfix)
    const bc = (() => { const a = n.ip.split('.').map(Number), pre = n.prefix || 24, ip = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0, mask = pre ? (~0 << (32 - pre)) >>> 0 : 0, b = (ip | ~mask) >>> 0; return [b >>> 24, (b >> 16) & 255, (b >> 8) & 255, b & 255].join('.'); })();
    const sdcp = native('udp', { send: { host: bc, port: 3000, data: 'M99999' }, ms: 2500 }).catch(() => ({ packets: [] }));
    const cc2 = native('udp', { send: { host: bc, port: 52700, data: '{"id":0,"method":7000}' }, ms: 2500 }).catch(() => ({ packets: [] }));   // Elegoo CC2
    const ffs = native('udp', { sends: [{ host: '225.0.0.9', port: 19000, b64: FF_DISCO }, { host: bc, port: 48899, b64: FF_DISCO }], ms: 2500 }).catch(() => ({ packets: [] }));   // Flashforge
    const r = await native('scan', { ip: n.ip, ports: [7125, 80, 5000, 7126, 7127, 18910], timeout: 450 });
    // Zweiter Durchgang nur für Klipper (7125) mit 1,5 s statt 450 ms (25.11.2026, Chris' Snapmaker U1 während eines Drucks: erst die
    // zweite Suche fand ihn, von Hand per IP sofort). Beim ersten Anklopfen muss sich das Gerät erst im WLAN melden — ein beschäftigter
    // oder stromsparender Drucker braucht dafür länger als 450 ms. Danach kennt das Handy ihn. Kostet ~6 s (254 Adressen, 64 gleichzeitig).
    if (!r.blocked) {
      const r2 = await native('scan', { ip: n.ip, ports: [7125], timeout: 1500 }).catch(() => ({ hosts: [] }));
      const seen = new Set((r.hosts || []).map(h => h.host + ':' + h.port));
      for (const h of r2.hosts || []) if (!seen.has(h.host + ':' + h.port)) { seen.add(h.host + ':' + h.port); (r.hosts = r.hosts || []).push(h); }
    }
    const found =bambuFound((await ssdp).packets || []).concat(sdcpFound((await sdcp).packets || []), cc2Found((await cc2).packets || []), ffFound((await ffs).packets || []));
    await Promise.all((r.hosts || []).map(async h => { const d = h.port === 18910 ? await acInfo(h.host, 18910) : await probe(h.host, h.port); if (d) found.push(d); }));
    // KX-Bridge/KIAUH: je weiterer Drucker ein eigener Port → nach dem höchsten gefundenen Moonraker-Port weiterfragen,
    // bis zur ersten Lücke, höchstens 8 (wie der 3DSEARCH-Agent 0.5.4)
    await Promise.all([...new Set(found.filter(d => d.kind === 'moonraker' && d.port !== 80 && d.port !== 5000).map(d => d.host))].map(async h => {
      let pt = Math.max(...found.filter(d => d.host === h && d.kind === 'moonraker').map(d => d.port));
      for (let i = 0; i < 8; i++) { const d = await probeMoonraker(h, ++pt); if (!d) break; found.push(d); }
    }));
    // Creality-OS-Drucker (K2) haben zusätzlich Moonraker auf 7125 → nur den Creality-Weg zeigen (CFS-Zuordnung, Kamera wie Creality Print)
    const crHosts = new Set(found.filter(d => d.kind === 'creality').map(d => d.host));
    // Kobra mit Rinkhals UND LAN-Modus: beide Wege zeigen (beschriftet „Rinkhals“ bzw. „Anycubic LAN“), der Nutzer wählt
    for (let i = found.length - 1; i >= 0; i--) if (found[i].kind === 'moonraker' && crHosts.has(found[i].host)) found.splice(i, 1);
    // Gleicher Drucker auf 80 und 7125 → einmal (7125 bevorzugt)
    const by = new Map();
    for (const d of found.sort((a, b) => (a.port === 7125 ? 0 : 1) - (b.port === 7125 ? 0 : 1))) if (!by.has(d.host + (d.port >= 7126 ? ':' + d.port : ''))) by.set(d.host + (d.port >= 7126 ? ':' + d.port : ''), d);
    const list = [...by.values()].map(d => ({ ...d, added: db.printers.some(p => hostsOf(p).some(h => h.host === d.host && ((h.port || 7125) === d.port || (p.kind === d.kind && d.kind !== 'moonraker')))) }));
    return { hosts: list, net: n, blocked: r.blocked || '', win: r.os === 'win32' };
  },
  async amp_probe(inp) {
    let [host, port] = String(inp.host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':');
    if (!host) fail('host');
    // Anycubic LAN-Modus: :18910/info (von Hand „IP:18910“ auch bei Rinkhals-Druckern)
    if (!port || +port === 18910) { const a = await acInfo(host, 18910); if (a) return { found: a }; }
    else if (+port > 10000) { const a = await acInfo(host, +port); if (a) return { found: a }; }   // Testumgebung
    // Creality OS zuerst (K2 hat auch Moonraker auf 7125, der Creality-Weg kann mehr)
    if (!port || +port === 80 || +port === 9999) { const c = await crInfo(host, 80); if (c) return { found: c }; }
    const ports = port ? [+port] : [7125, 80, 5000];
    for (const pt of ports) { const d = await probe(host, pt); if (d) return { found: d }; }
    // Elegoo SDCP: Port 3030 offen → per „M99999“ direkt an die Adresse nach Kennung fragen
    if (!port || +port === 3030) {
      const o = await native('tcpcheck', { host, port: 3030 }).catch(() => ({}));
      if (o.open) { const r = await native('udp', { send: { host, port: 3000, data: 'M99999' }, ms: 1500 }).catch(() => ({ packets: [] })); const f = sdcpFound(r.packets || [])[0]; return { found: f || { host, port: 3030, kind: 'sdcp', mainboard: '', name: 'Elegoo', model: null } }; }
    }
    // Elegoo CC2: MQTT 1883 offen UND Antwort auf {"id":0,"method":7000} an UDP 52700 (sonst ist 1883 irgendein MQTT-Server im Haus)
    if (!port || +port === 1883) {
      const o = await native('tcpcheck', { host, port: 1883 }).catch(() => ({}));
      if (o.open) { const r = await native('udp', { send: { host, port: 52700, data: '{"id":0,"method":7000}' }, ms: 1500 }).catch(() => ({ packets: [] })); const f = cc2Found(r.packets || [])[0]; if (f) return { found: f }; }
    }
    // Flashforge: HTTP 8898 offen → Suche per UDP direkt an die Adresse (liefert Seriennummer + Modell), sonst Seriennummer von Hand
    if (!port || +port === 8898) {
      const o = await native('tcpcheck', { host, port: 8898 }).catch(() => ({}));
      if (o.open) {
        const r = await native('udp', { sends: [{ host, port: 48899, b64: FF_DISCO }, { host, port: 19000, b64: FF_DISCO }], ms: 1500 }).catch(() => ({ packets: [] }));
        return { found: ffFound(r.packets || [])[0] || { host, port: 8898, kind: 'flashforge', serial: '', name: 'Flashforge', model: null, need_code: true } };
      }
    }
    // Bambu im LAN: MQTT-Port 8883 offen → Access Code (und Seriennummer) fragt der Dialog
    if (!port || +port === 8883) { const o = await native('tcpcheck', { host, port: 8883 }).catch(() => ({})); if (NET_BLOCKED.includes(o.code)) return { found: null, blocked: o.code, win: o.os === 'win32' }; if (o.open) return { found: { host, port: 8883, kind: 'bambu', name: 'Bambu Lab', model: null, need_code: true } }; }
    // nichts gefunden: verweigert das Betriebssystem die Verbindung? (dann liegt es nicht an der Adresse)
    const o = await native('tcpcheck', { host, port: +port || 80, timeout: 2000 }).catch(() => ({}));
    return NET_BLOCKED.includes(o.code) ? { found: null, blocked: o.code, win: o.os === 'win32' } : { found: null };
  },
  // ── Hersteller-Konten (nur im Agenten, nur lesend; 19.11.2026) ──
  async cloud_list() {
    const provs = Object.values(CLOUD).map(P => ({ prov: P.prov, label: P.label, steps: P.steps || {}, first: P.first || 'start', note: P.note || null }));
    const accounts = (db.clouds || []).map(a => ({ id: a.id, prov: a.prov, label: (CLOUD[a.prov] || {}).label || a.prov, user: a.user || '', added_at: a.added_at,
      err: a.err || null, printers: db.printers.filter(p => p.kind === 'cloud' && p.cloud === a.id).map(p => ({ id: p.id, name: p.name })) }));
    return { available: provs.length > 0, provs, accounts };
  },
  /** Ein Anmeldeschritt: {prov, step, inp, st} → {step, st, hint} (nächster Schritt) oder {done, id, devices}. */
  async cloud_login(inp) {
    const P = CLOUD[inp.prov] || fail('prov');
    let r;
    try { r = await P.login(CH, String(inp.step || P.first || 'start'), inp.inp || {}, inp.st || {}); }
    catch (e) { const er = new Error(e.message || 'login'); er.msg = e.msg || ''; throw er; }
    if (!r || !r.done) return { step: r.step, st: r.st || {}, hint: r.hint || null };
    db.clouds = db.clouds || [];
    let acc = db.clouds.find(a => a.prov === P.prov && r.uid && a.uid === String(r.uid));
    if (!acc) { acc = { id: 'c' + nextId('cloud'), prov: P.prov, added_at: now() }; db.clouds.push(acc); }
    Object.assign(acc, { acc: r.acc, uid: r.uid ? String(r.uid) : acc.uid || null, user: String(r.user || '').slice(0, 80), err: null, devs_at: 0, jobs_at: 0 });
    persist(true);
    diag({ a: 'cloud_login', p: P.prov, err: '', d: 'ok' });
    return { done: true, id: acc.id, devices: await cloudDevices(acc) };
  },
  /** Aufträge jetzt abgleichen (sonst alle P.jobsEvery von selbst). */
  async cloud_sync(inp) {
    const acc = cloudAcc(inp.id) || fail('not_found');
    await (cloudJobsTick(acc, true) || Promise.resolve());
    return { ok: true, err: acc.err || null };
  },
  async cloud_devices(inp) { const acc = cloudAcc(inp.id) || fail('not_found'); return { devices: await cloudDevices(acc) }; },
  async cloud_add(inp) {
    const acc = cloudAcc(inp.id) || fail('not_found'), P = CLOUD[acc.prov] || fail('prov');
    const devs = await cloudDevices(acc), want = new Set((inp.devs || []).map(String));
    let n = 0;
    for (const d of devs) {
      if (!want.has(d.dev) || d.added) continue;
      db.printers.push({ id: 'p' + nextId('printer'), kind: 'cloud', prov: acc.prov, cloud: acc.id, dev: d.dev, name: str(d.name, 60) || d.model || P.label,
                         model: d.model || null, added_at: now(), img: null });
      n++;
    }
    persist(true);
    return { ok: true, added: n };
  },
  /** Konto abmelden: Zugang löschen, seine Drucker mit ihren Fächern entfernen (Spulen und Verlauf bleiben). */
  async cloud_remove(inp) {
    const acc = cloudAcc(inp.id) || fail('not_found');
    for (const p of db.printers.filter(x => x.kind === 'cloud' && x.cloud === acc.id)) {
      if (CLOUD[acc.prov] && CLOUD[acc.prov].close) { try { CLOUD[acc.prov].close(CH, p.dev); } catch (e) {} }
      db.slots = db.slots.filter(s => s.printer_id !== p.id); delete live[p.id];
    }
    db.printers = db.printers.filter(x => !(x.kind === 'cloud' && x.cloud === acc.id));
    db.clouds = (db.clouds || []).filter(a => a.id !== acc.id);
    persist(true);
    return { ok: true };
  },
  async amp_add(inp) {
    const d = inp.found || fail('found');
    const kind = ['octoprint', 'prusalink', 'bambu', 'sdcp', 'cc2', 'creality', 'flashforge', 'acl'].includes(d.kind) ? d.kind : 'moonraker';
    if (db.printers.some(p => hostsOf(p).some(h => h.host === d.host && (h.port || 7125) === (d.port || 7125)))) fail('exists');
    const np = { id: 'p' + nextId('printer'), kind, name: str(inp.name, 60) || d.name || 'Klipper', model: d.model || null, host: d.host, port: d.port || 7125,
                 key: str(inp.key, 100), added_at: now(), img: null };
    if (d.mrhost) np.mrhost = String(d.mrhost).slice(0, 80);   // Kennungen fürs Wiederfinden nach IP-Wechsel (Seriennummern setzen die Zweige unten)
    if (d.mac) np.mac = String(d.mac).toLowerCase().slice(0, 40);
    if (kind === 'moonraker' && (np.key || d.need_key)) {
      // Schlüssel gleich prüfen (sonst stünde der Drucker nur mit „verlangt einen API-Schlüssel“ in der Liste)
      try { await mrGet(np, '/server/info', 4000); } catch (e) { fail(e.message === 'unauthorized' ? 'login' : 'unreach'); }
    }
    if (kind === 'prusalink') {
      np.user = str(inp.user, 40) || 'maker'; np.pass = String(inp.pass || '').slice(0, 100);
      // Passwort gleich prüfen, Modell aus dem Hostnamen
      try { await dj(np, 'GET', '/api/v1/status'); } catch (e) { fail(e.message === 'unauthorized' ? 'login' : 'unreach'); }
      const info = await dj(np, 'GET', '/api/v1/info').catch(() => ({}));
      np.model = np.model || prusaModel(info.hostname, info.name);
      if (!str(inp.name, 60) && np.model) np.name = np.model;
    }
    if (kind === 'sdcp') {
      np.port = 3030; np.mainboard = d.mainboard || ''; if (d.ports) np.ports = d.ports;
      const key = 'sd_' + np.id;
      await native('live_open', { kind: 'sdcp', key, host: np.host, port: sdPort(np, 'ws', 3030) });
      let st = {};
      for (let i = 0; i < 16; i++) { await new Promise(z => setTimeout(z, 500)); st = await native('live_state', { key }); if (st.connected) { if (st.mainboard) np.mainboard = st.mainboard; sdSend(np, 0).catch(() => {}); sdSend(np, 1).catch(() => {}); } if ((st.state || {}).Status) break; }
      if (!st.connected) { native('live_close', { key }).catch(() => {}); fail('unreach'); }
      np.model = np.model || d.model || null;
      if (!str(inp.name, 60)) np.name = d.name && d.name !== 'Elegoo' ? d.name : np.model || 'Elegoo';
    }
    if (kind === 'acl') {
      np.port = +d.port || 18910; if (d.ports) np.ports = d.ports; np.serial = d.serial || '';
      // Stand der WLAN-Suche kann alt sein (10.11.2026, Tester: „immer wieder LAN-Modus nicht aktiviert“, obwohl inzwischen am Display
      // eingeschaltet) → den Drucker jetzt nochmal fragen
      const fresh = await acInfo(d.host, np.port);
      if (fresh) { d.lan = fresh.lan; d.old = fresh.old; if (!np.serial && fresh.serial) np.serial = fresh.serial; }
      if (d.lan === false) fail('lan');
      if (d.old) fail('acl_old');   // Kobra 2: älterer Handshake ohne Signatur, noch nicht unterstützt
      await acOpen(np);
      let st = {};
      for (let i = 0; i < 30; i++) { await new Promise(z => setTimeout(z, 500)); st = await native('live_state', { key: acKey(np) }); if ((st.state || {}).info || ['lan_off', 'login', 'no_token'].includes(st.err) || (st.connected && i >= 12)) break; }
      if (!(st.state || {}).info && !st.connected) {
        native('live_close', { key: acKey(np) }).catch(() => {});
        const e = new Error(st.err === 'lan_off' ? 'lan' : st.err === 'no_token' ? 'acl_old' : st.err === 'login' ? 'login' : 'unreach'); e.msg = st.err || ''; throw e;
      }
      const li = (st.state || {}).lanInfo || {};
      np.model = np.model || d.model || acModel(li.modelId, li.modelName) || 'Anycubic';
      if (!str(inp.name, 60)) np.name = d.name && !/^Anycubic$/i.test(d.name) ? d.name : np.model;
    }
    if (kind === 'creality') {
      np.port = +d.port || 9999; if (d.ports) np.ports = d.ports;   // ports nur Testumgebung
      await crOpen(np);
      let st = {};
      for (let i = 0; i < 16; i++) { await new Promise(z => setTimeout(z, 500)); st = await native('live_state', { key: crKey(np) }); if (st.state && ('state' in st.state || 'nozzleTemp' in st.state)) break; }
      if (!st.state || !('state' in st.state || 'nozzleTemp' in st.state)) { native('live_close', { key: crKey(np) }).catch(() => {}); fail('unreach'); }
      np.model = np.model || d.model || crModel(st.state.model) || 'Creality';
      if (!str(inp.name, 60)) np.name = d.name && !/^Creality$/i.test(d.name) ? d.name : np.model;
    }
    if (kind === 'flashforge') {
      np.port = +d.port || 8898; if (d.ports) np.ports = d.ports;
      np.serial = str(inp.serial, 60) || d.serial || ''; np.code = String(inp.code || '').trim().slice(0, 20);
      if (!np.serial) fail('serial');
      if (!np.code) fail('code');
      let det;
      try { det = (await ffPost(np, '/detail', null, 5000)).detail || {}; } catch (e) { fail(['login', 'lan_mode'].includes(e.message) ? (e.message === 'lan_mode' ? 'lan' : 'login') : 'unreach'); }
      np.model = np.model || d.model || ffModel(det.pid) || 'Flashforge';
      if (!str(inp.name, 60)) np.name = det.name || (d.name && !/^Flashforge$/i.test(d.name) ? d.name : np.model);
    }
    if (kind === 'cc2') {
      np.code = String(inp.code || '').trim().slice(0, 20); np.serial = str(inp.serial, 40) || d.serial || ''; np.port = 1883;
      if (d.ports) np.ports = d.ports;   // nur Testumgebung
      if (!np.serial) fail('serial');
      const key = ccKey(np);
      await ccOpen(np);
      let st = {};
      for (let i = 0; i < 24; i++) { await new Promise(z => setTimeout(z, 500)); st = await native('live_state', { key }); if ((st.state || {}).status || ['access_code', 'too_many_clients'].includes(st.err)) break; }
      if (!(st.state || {}).status) { native('live_close', { key }).catch(() => {}); fail(st.err === 'access_code' ? 'login' : st.err === 'too_many_clients' ? 'clients' : 'unreach'); }
      const at = st.state.attributes || {};
      np.model = np.model || d.model || (at.machine_model ? 'Elegoo ' + String(at.machine_model).replace(/^Elegoo\s*/i, '') : 'Elegoo Centauri Carbon 2');
      if (!str(inp.name, 60)) np.name = d.name && !/^Elegoo$/i.test(d.name) ? d.name : np.model;
    }
    if (kind === 'bambu') {
      np.code = String(inp.code || '').trim().slice(0, 20); np.serial = str(inp.serial, 40) || d.serial || ''; np.port = 8883;
      if (d.ports) np.ports = d.ports;   // nur Testumgebung
      if (!np.code) fail('code');
      const key = 'bb_' + np.id;
      await native('live_open', { kind: 'bambu', key, host: np.host, serial: np.serial, code: np.code, port: bbPort(np, 'mqtt', 8883) });
      let st = {};
      for (let i = 0; i < 20; i++) { await new Promise(z => setTimeout(z, 500)); st = await native('live_state', { key }); if ((st.state || {}).print || st.err === 'access_code') break; }
      if (st.err === 'access_code') { native('live_close', { key }).catch(() => {}); fail('login'); }
      if (!(st.state || {}).print) { native('live_close', { key }).catch(() => {}); fail(np.serial ? 'unreach' : 'serial'); }
      np.serial = st.serial || np.serial;
      if (!np.model) { const pn = (((st.state || {}).info || {}).module || []).find(m => m.name === 'ota' || m.product_name); if (pn && pn.product_name) np.model = String(pn.product_name).replace(/^Bambu Lab\s*/i, 'Bambu Lab '); }
      if (!str(inp.name, 60) && (d.name || np.model)) np.name = d.name && d.name !== 'Bambu Lab' ? d.name : np.model || 'Bambu Lab';
    }
    if (kind === 'octoprint') {
      try { await dj(np, 'GET', '/api/connection'); } catch (e) { fail(e.message === 'unauthorized' ? 'login' : 'unreach'); }
      // Modell aus OctoPrints Standard-Druckerprofil (wie octo_model im Agenten)
      try {
        for (const pf of Object.values((await dj(np, 'GET', '/api/printerprofiles')).profiles || {})) if (pf.default) {
          const m = String(pf.model || '').trim(), n = String(pf.name || '').trim();
          np.model = m && m.toLowerCase() !== 'generic reprap printer' ? m.slice(0, 80) : n && !/^_?default$/i.test(n) ? n.slice(0, 80) : null;
        }
      } catch (e) {}
      if (!str(inp.name, 60) && np.model) np.name = np.model;
    }
    db.printers.push(np);
    persist(true);
    return { ok: true, id: np.id };
  },
  /** OctoPrint: Zugriff anfragen — OctoPrint zeigt dem angemeldeten Nutzer „AllMyPrinters erlauben?“. */
  async amp_octo_request(inp) {
    const d = inp.found || fail('found');
    const r = await native('http', { url: `http://${d.host}:${d.port}/plugin/appkeys/request`, method: 'POST', body: JSON.stringify({ app: 'AllMyPrinters' }), headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
    let tok = null; try { tok = JSON.parse(r.text).app_token; } catch (e) {}
    if (!tok) fail('octo_request');
    return { token: tok, url: `http://${d.host}${d.port && d.port !== 80 ? ':' + d.port : ''}/plugin/appkeys/auth/${tok}` };
  },
  async amp_octo_poll(inp) {
    const d = inp.found || fail('found');
    const r = await native('http', { url: `http://${d.host}:${d.port}/plugin/appkeys/request/${encodeURIComponent(inp.token)}`, timeout: 8000 });
    if (r.status === 200) { try { return { key: JSON.parse(r.text).api_key }; } catch (e) {} }
    if (r.status === 404) return { denied: true };
    return { wait: true };
  },
  async amp_file_meta(inp) { return fileMeta(inp.file); },
  async amp_print(inp) {
    // Fertige G-Code-Datei (Bibliothek, „Öffnen mit“, #gcode): Rückmeldung zum Druckstart mit Weg „file“ (ab 0.9.10)
    const p = db.printers.find(x => x.id === inp.printer) || null;
    const plan = inp.plan || (inp.meta && inp.meta.weights ? inp.meta.weights.map((g, t) => ({ slot: inp.map && inp.map[t] != null ? +inp.map[t] : t, tool: t, g })) : []);
    let r;
    try { r = await printSend(inp, inp._progress); }
    catch (e) { if (inp.start && e.message !== 'plate_check') startReport(null, p, e.code || e.message, plan, 'file', inp._chk, startDet(e)); throw e; }
    if (inp.start) startReport(null, p, r && r.started ? 'ok' : 'not_started', plan, 'file', inp._chk);
    if (inp.lib && r && r.started) { libLink(inp.lib, r.job, (db.printers.find(x => x.id === inp.printer) || {}).name); persist(); }
    return r;
  },
  async amp_export(inp) {
    return { text: JSON.stringify({ app: 'AllMyPrinters', exported_at: now(), data: dbExport(!!(inp && inp.full)) }, null, 1) };
  },
  /**
   * Bibliothekseintrag von einem anderen Gerät übernehmen (App ↔ Agent koppeln, 11.11.2026): die Sicherung enthält nur die Einträge,
   * nicht Dateien, Bilder und 3D-Netze. Datei (token) wird wie beim Hochladen gespeichert, NAS-Einträge (dav) zeigen weiter auf dieselbe
   * Datei. Vorschaubilder kommen mit (STL zeichnet sonst die Oberfläche beim Hochladen), das 3D-Netz entsteht hier neu.
   */
  async lib_adopt(inp) {
    const m = inp.meta || {}, thumbs = Array.isArray(inp.thumbs) ? inp.thumbs.slice(0, 30) : [];
    let it;
    if (m.loc === 'plate') {
      // Platte (18.11.2026): Teile haben hier neue Nummern → über Dateiname + Größe wiederfinden (loader.js schickt Platten zuletzt)
      const all = libItems();
      const parts = (Array.isArray(m.parts) ? m.parts : []).slice(0, LIB_PLATE_MAX).map(p => {
        const x = all.find(y => y.loc !== 'plate' && !y.want && y.ext === 'stl' && y.orig === p.orig && +y.size === +p.size);
        if (!x) return null;
        const inst = libPlateInst(p.inst), o = { id: x.id, n: inst ? inst.length : int(p.n, 1, 100) || 1, slot: p.slot || '', name: x.name, orig: x.orig, size: x.size };
        if (inst) o.inst = inst;   // Anordnung aus dem Editor bleibt beim Koppeln erhalten
        if (['auto', 'bed'].includes(p.sup)) o.sup = p.sup;
        return o;
      }).filter(Boolean);
      it = { id: nextId('lib'), name: str(m.name, 120) || 'plate', folder: libFolder(m.folder), ext: '', size: 0, orig: '', created: m.created || now(),
             printed: m.printed || null, prints: +m.prints || 0, printer: m.printer || null, loc: 'plate', key: null, doc: null, plates: [], v: 1, parts };
      libItems().push(it);
      const t1 = thumbs.find(x => +x.n === 1);
      if (t1) { try { await native('lib_thumb_put', { id: it.id, n: '1', b64: t1.b64 }); it.plates = [1]; } catch (e) {} }
    } else if (m.want && m.remote && m.remote.id) {
      const old = libWantOf(m.remote.id);
      if (old) return { ok: true, skipped: 'dupe' };
      it = { id: nextId('lib'), name: str(m.name, 120) || 'model', folder: libFolder(m.folder), tags: libTags(m.tags), notes: libNote(m.notes), ext: '', size: 0, orig: '', created: m.created || now(),
             printed: null, prints: 0, loc: 'want', key: null, doc: null, plates: [], v: 1, want: true, remote: { ...m.remote } };
      libItems().push(it); persist();
      return { ok: true, id: it.id };
    }
    if (it) { /* Platte: oben angelegt, weiter mit Tags/Notizen/Druckbuch/Foto */ }
    else if (!inp.token && m.loc === 'dav' && m.doc) {
      if (libItems().some(x => x.doc === m.doc)) return { ok: true, skipped: 'dupe' };
      it = { id: nextId('lib'), name: str(m.name, 120) || str(m.orig, 120) || 'model', folder: libFolder(m.folder), ext: String(m.ext || '').toLowerCase(), size: +m.size || 0,
             orig: str(m.orig, 200) || 'model', created: m.created || now(), printed: m.printed || null, prints: +m.prints || 0, printer: m.printer || null,
             loc: 'dav', key: null, doc: String(m.doc), plates: [], v: 1 };
      if (m.gcode) it.gcode = m.gcode;
      libItems().push(it);
    } else if (inp.token) {
      const t1 = thumbs.find(x => +x.n !== 0);
      const r = await A.lib_upload({ name: m.orig, size: +inp.size || +m.size || 0, token: inp.token, folder: m.folder, thumb: m.ext === 'stl' && t1 ? t1.b64 : null });
      if (r.error === 'lib_dupe') return { ok: true, skipped: 'dupe' };
      if (r.error) return r;
      it = libItems().find(x => x.id === r.file.id);
      Object.assign(it, { name: str(m.name, 120) || it.name, created: m.created || it.created, printed: m.printed || null, prints: +m.prints || 0, printer: m.printer || null });
    } else fail('no_file');
    Object.assign(it, { tags: libTags(m.tags), notes: libNote(m.notes), jobs: Array.isArray(m.jobs) ? m.jobs.map(Number).filter(Number.isFinite).slice(-200) : [] });
    if (m.remote && m.remote.id) it.remote = { ...m.remote };
    const ph = m.photo && thumbs.find(x => +x.n === 0);
    if (ph) { try { await native('lib_thumb_put', { id: it.id, n: '0', b64: ph.b64 }); it.photo = true; } catch (e) {} }
    if (it.loc === 'dav' || (it.ext === 'stl' && !(it.plates || []).length)) {
      for (const t of thumbs.filter(x => +x.n !== 0)) { const n = +t.n || 1; try { await native('lib_thumb_put', { id: it.id, n, b64: t.b64 }); if (!it.plates.includes(n)) it.plates.push(n); } catch (e) {} }
      it.plates.sort((a, b) => a - b);
    }
    if (['stl', '3mf'].includes(it.ext) && it.preview !== 'busy') { it.preview = 'busy'; it.busy_at = now(); libMeshBuild(it).catch(() => {}); }
    persist();
    return { ok: true, id: it.id };
  },
  async amp_import(inp) {
    let d; try { d = JSON.parse(inp.text); } catch (e) { fail('bad_file'); }
    const data = d && d.app === 'AllMyPrinters' ? d.data : null;
    if (!data || !Array.isArray(data.spools)) fail('bad_file');
    db = Object.assign(FRESH(), data);
    for (const k of Object.keys(live)) delete live[k];
    await persist(true);
    return { ok: true, spools: db.spools.length, printers: db.printers.length };
  },
  async amp_spool_import(inp) { return spoolImport(inp); },
  async amp_profiles() { return { profiles: (db.profiles || []).slice().sort((a, b) => a.name.localeCompare(b.name)) }; },
  async amp_profile_save(inp) {
    const vals = pfClean(inp.vals);
    if (!Object.keys(vals).length) fail('pf_empty');
    return { profile: pfUpsert(inp.name, vals) };
  },
  async amp_profile_delete(inp) { db.profiles = (db.profiles || []).filter(p => p.id !== +inp.id); persist(); return { ok: true }; },
  async amp_profile_import(inp) {
    const r = pfParse(inp.text, inp.file);
    diag({ a: 'profile_import', err: '', d: Object.keys(r.vals).length + ' ok ' + r.bad.length + ' bad' });
    return { profile: pfUpsert(r.name, r.vals), bad: r.bad, other: r.other, sup: r.sup };
  },
  async amp_counts() { return { spools: db.spools.filter(s => !s.archived_at).length, printers: db.printers.length }; },
  /** Was „Problem melden“ mitschicken würde (Vorschau = genau das). */
  async amp_diag() { return diagReport({ app: true, printer: true, log: true }, ''); },
  async amp_report(inp) {
    const text = String(inp.text || '').trim().slice(0, 4000);
    if (text.length < 5) fail('text');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(inp.email || '').trim())) fail('email');   // Pflicht seit 25.11.2026 (sonst keine Antwort möglich)
    let src = 'app'; try { if ((await native('info', {})).agent) src = 'agent'; } catch (e) {}
    const body = { text, email: String(inp.email || '').trim().slice(0, 200), lang: db.settings.lang || '', src, ...(await diagReport(inp.inc || {}, inp.printer || '')) };
    const r = await fetch(REPORT, { method: 'POST', headers: { 'Content-Type': 'application/json', ...sliceHdr() }, body: JSON.stringify(body) }).catch(() => null);
    if (!r) fail('offline');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) fail(d.error || 'http_' + r.status);
    diag({ a: 'report', err: '', d: 'sent #' + (d.id || '') });
    return { ok: true, id: d.id || null };
  },
};
// Seit 15.11.2026 an allmyprinters.com (Admin „Meldungen“); 3dsearch.net/api/amp_report.php reicht ältere App-Versionen nur noch weiter
const REPORT = (() => { try { return localStorage.getItem('amp_report_url') || 'https://allmyprinters.com/api/report.php'; } catch (e) { return 'https://allmyprinters.com/api/report.php'; } })();
/** Angaben für „Problem melden“: je Häkchen ein Teil. Drucker ohne Adresse/Zugang, nur Treiber, Modell, Firmware, Stand. */
async function diagReport(inc, pid) {
  const out = {};
  if (inc.app) { let i = {}; try { i = await native('info', {}); } catch (e) {} out.app = { version: i.version || '', agent: !!i.agent, android_sdk: i.sdk || null, phone: i.model || '', printers: db.printers.length, spools: db.spools.filter(s => !s.archived_at).length }; }
  if (inc.printer) {
    out.printers = db.printers.filter(p => !pid || p.id === pid).map(p => {
      const e = (live[p.id] || {}).good || (live[p.id] || {}).entry || {};
      return { kind: kindOf(p), model: p.model || '', port: p.port || null, fw: (e.stats || {}).fw || '', online: !!e.online, err: e.amp_err || '', ...(e.amp_block ? { blocked: e.amp_block, blocked_by: e.amp_block_sec ? [e.amp_block_sec.kind, ...e.amp_block_sec.all, ...(e.amp_block_sec.pub.length ? ['public'] : [])].join(' · ') : '' } : {}), slots: (e.slots || []).length, boxes: (e.boxes || []).length };
    });
  }
  if (inc.log) out.log = DIAG.slice(-40);
  return out;
}

/** Formular-Aufrufe (Druckerfoto). Das Foto bleibt als data:-Adresse in der Datei. */
async function form(fd) {
  await boot();
  if (fd.get('a') === 'print_slice' || fd.get('a') === 'print_retarget') {
    // aus der Bibliothek gedruckt (app.js-Patch) → später „gedruckt am“ + Druckbuch. Mehrere STL auf einer Platte: Nummern mit Komma,
    // amp_plate = gespeicherte Platte, von der aus gedruckt wurde (18.11.2026)
    const libs = String(fd.get('amp_lib') || '').split(',').map(Number).filter(n => n > 0).slice(0, 40); fd.delete('amp_lib');
    const lib = libs.length > 1 ? libs : libs[0] || null;
    const plate = +fd.get('amp_plate') || null; fd.delete('amp_plate');
    // vib/flow: Häkchen „Vibrationsausgleich“ / „Flusskalibrierung“ vor dem Druck (21.11.2026, amp-views ampRenderCal) — nur fürs Senden, nicht an den Slicer
    const vib = fd.get('vib') === '1', flow = fd.get('flow') === '1', tl = fd.get('tl') === '1'; fd.delete('vib'); fd.delete('flow'); fd.delete('tl');   // tl: Zeitraffer (U1, 25.11.2026)
    const r = await sliceForm(fd);
    // level: Häkchen „Bett vor dem Druck nivellieren“ ('1'/'0', leer = Drucker hat keins) — geht beim Senden in den Startbefehl
    const lvl = fd.get('level') === '0' ? false : fd.get('level') === '1' ? true : null;
    if (r.ok && r.job) { (db.slicejobs = db.slicejobs || {})[r.job] = { printer: (pkOf(fd.get('printer')) || {}).id, at: now(), ...(lib ? { lib } : {}), ...(plate ? { plate } : {}), ...(lvl !== null ? { level: lvl } : {}), ...(vib ? { vib } : {}), ...(flow ? { flow } : {}), ...(tl ? { tl } : {}) }; persist(); }
    return r;
  }
  if (fd.get('a') === 'printer_photo') {
    const p = db.printers.find(x => x.id === fd.get('printer')); if (!p) return { error: 'not_found' };
    const f = fd.get('photo'); if (!f || f.size > 3e6) return { error: 'photo_size' };
    p.img = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    persist(); return { ok: true };
  }
  return { error: 'unknown' };
}

async function api(a, body, params) {
  await boot();
  const f = A[a];
  if (!f) { console.warn('AMP: Aktion fehlt', a); fail('unsupported'); }
  const inp = Object.assign({}, params || {}, body || {});
  if (APL_ON && apl) {   // Weichen der App ohne Agent (24.11.2026, unten): nur was der Plan ausdrücklich ausschaltet
    const need = aplNeed(a, inp);
    if (need) { if (need !== 'models') window.AMP_ev('plan_hint', { f: need }); planFail(need); }   // Modellsuche prüfen die Ansichten vorher (auch Vorschläge beim Tippen)
  }
  if (!['amp_scan', 'amp_probe', 'amp_add', 'amp_print', 'printer_cmd', 'amp_octo_request', 'amp_octo_poll'].includes(a)) return f(inp);
  try {
    const r = await f(inp);
    if (a === 'amp_probe') diag({ a, err: r.found ? '' : 'not_found', p: r.found ? r.found.kind : '', m: r.found ? r.found.model || '' : '', d: String(inp.host || '').replace(/^.*:/, 'port ') });
    if (a === 'amp_scan') diag({ a, err: '', d: (r.hosts || []).length + ' found' + (r.net && r.net.ip ? '' : ', no wifi') });
    if (a === 'amp_add') diag({ a, err: '', p: (inp.found || {}).kind || '' });
    return r;
  } catch (e) {
    diag({ a, err: e.message || 'error', p: (inp.found || {}).kind || '', m: (inp.found || {}).model || '', d: e.msg || '' });
    throw e;
  }
}

// ── Weichen der App ohne Agent (24.11.2026, User: „so bauen, dass man es aktuell nicht sieht und alles frei kostenlos ist, erst später
// im Admin umschaltbar“, Plan: memory app-abo-grenzen-plan) ──────────────────────────────────────────────────────────────────
// Wie der Agent (agent/src/plan.js) holt die App von allmyprinters.com/api/app-plan.php einen signierten Plan
//   {v:1, k:'app', h, plan: beta|free, f: {funktion: bool}, printers: n|null, min: 'x.y.z'|'', upd: Adresse, iat, exp}
// (Ed25519, derselbe Schlüssel wie beim Agenten; k:'app' und h = sha256('amp-app|' + Kennung) → ein Agenten-Plan passt hier nicht).
// Eingestellt wird im Admin → Abo → „App ohne Agent“. Beta (Hauptschalter, Standard an) = alles frei, die App zeigt dann nichts davon.
// Regeln: Es gilt die neueste geprüfte Antwort. Grenzen bleiben auch nach Ablauf (exp) bestehen, die Mindestversion gilt nur bis exp
// (eine alte Antwort sperrt die App ohne Internet nie). Nie eine bekommen = alles frei; was der Plan nicht nennt, bleibt frei.
// Mit Agent läuft diese Datei in der App gar nicht (die App zeigt die Oberfläche des Agenten, dort gilt sein Plan); im Agenten
// selbst (runtime.js, FM.agent) ist die Weiche aus. Gesendet: eigene Zufallskennung (nur hierfür, NICHT die Gerätekennung des
// Slicers), Version, Plattform. Der Server speichert nichts. Ohne Ed25519 in der WebView (alte Android-WebView) wird nicht geprüft.
// Funktionen: models (Modellsuche), slice (Slicen auf unserem Server), own_slicer (eigener Slicer), plates, editor, stats; printers = Zahl.
const APL_ON = !(window.FM && FM.agent);
const APL_PUB = 'Nh9LLz8BGO+RIvDfGIVRyOLlcW7daBe+iTnU4M0LrLc=';   // allmyprinters.com private/agent-plan-key.json (wie agent/src/plan.js)
const APL_EVERY = 6 * 3600e3;
const aplUrl = () => { try { return localStorage.getItem('amp_plan_url') || 'https://allmyprinters.com/api/app-plan.php'; } catch (e) { return 'https://allmyprinters.com/api/app-plan.php'; } };
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const aplBytes = s => {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4);
  const r = atob(s), o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o;
};
let apl = null, aplAt = 0, aplErr = '', aplKey = null, aplNoEd = false, aplHash = null, aplVer = '', aplPlat = 'android', aplSig = '', aplBusy = null, aplReady = null;
function aplId() {
  let id = lsGet('amp_pid');
  if (!/^[A-Za-z0-9_-]{22}$/.test(id || '')) {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    id = btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); lsSet('amp_pid', id);
  }
  return id;
}
async function aplH() {
  if (aplHash) return aplHash;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('amp-app|' + aplId())));
  return (aplHash = [...d].map(x => x.toString(16).padStart(2, '0')).join(''));
}
/** Token „payload.signatur“ prüfen → Plan oder null (falsche Signatur, andere App, Agenten-Plan, kaputt). */
async function aplCheck(tok) {
  const [b, s] = String(tok || '').split('.');
  if (!b || !s) return null;
  let p; try { p = JSON.parse(new TextDecoder().decode(aplBytes(b))); } catch (e) { return null; }
  if (!p || p.v !== 1 || p.k !== 'app' || p.h !== (await aplH()).slice(0, 32) || !p.f || typeof p.f !== 'object' || !(+p.iat > 0)) return null;
  if (!aplKey && !aplNoEd) {
    try { aplKey = await crypto.subtle.importKey('raw', aplBytes(APL_PUB), { name: 'Ed25519' }, false, ['verify']); }
    catch (e) { aplNoEd = true; diag({ a: 'plan', err: 'no_ed25519', d: String((e && e.name) || '') }); }
  }
  if (aplKey && !(await crypto.subtle.verify({ name: 'Ed25519' }, aplKey, aplBytes(s), new TextEncoder().encode(b)).catch(() => false))) return null;
  return p;
}
const aplNum = v => String(v || '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
const aplVerLt = (a, b) => { const x = aplNum(a), y = aplNum(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
const planAllows = k => !(APL_ON && apl && apl.f[k] === false);
const planLimit = () => APL_ON && apl && apl.printers !== null && apl.printers !== undefined && apl.printers !== '' ? Math.max(0, parseInt(apl.printers, 10) || 0) : null;
function planStatus() {
  const fresh = !!(apl && +apl.exp * 1000 > Date.now());
  const min = APL_ON && fresh && apl.min && aplVer && aplVerLt(aplVer, apl.min) ? String(apl.min) : '';
  return { on: APL_ON, plan: apl ? apl.plan : null, f: apl ? Object.assign({}, apl.f) : {}, printers: planLimit(), min, upd: min ? String(apl.upd || '') : '',
           version: aplVer, platform: aplPlat, checked: aplAt, error: aplErr };
}
const aplSigOf = () => JSON.stringify([apl ? apl.f : null, planLimit(), planStatus().min]);
function aplChanged() { const s = aplSigOf(); if (s !== aplSig) { aplSig = s; window.AMP_ev('plan', planStatus()); } }
const planFail = f => { const e = new Error('plan'); e.code = 'plan:' + f; e.feature = f; throw e; };
/** Welche Weiche eine Aktion braucht (null = frei). Platten/Editor wie der Agent (server.js FEATURE_OF). */
function aplNeed(a, inp) {
  if (/^amp_s3d_/.test(a)) return planAllows('models') ? null : 'models';
  if (a === 'amp_slicer_test') return planAllows('own_slicer') ? null : 'own_slicer';
  if (a === 'amp_lib_plate_save') {
    if (!planAllows('plates')) return 'plates';
    return !planAllows('editor') && Array.isArray(inp.parts) && inp.parts.some(x => x && Array.isArray(x.inst) && x.inst.length) ? 'editor' : null;
  }
  if (a === 'amp_add') { const lim = planLimit(); return lim !== null && db.printers.length >= lim ? 'printers' : null; }   // vorhandene Drucker laufen weiter
  return null;
}
/** Slicen (sliceForm): unser Server = slice, eigener = own_slicer. Fertiger G-Code wird nur geprüft, nicht gesliced → immer frei. */
function aplSliceNeed(fd, own) {
  if (!APL_ON || !apl) return null;
  const k = own ? 'own_slicer' : 'slice';
  if (planAllows(k)) return null;
  const blobs = [...fd.values()].filter(v => v instanceof Blob);
  return blobs.length && blobs.every(b => /\.(gcode|bgcode|gco|g)$/i.test(b.name || '')) ? null : k;
}
async function aplLoad() {
  if (!APL_ON || !window.AMPNative) return;
  try { const i = await native('info', {}); aplVer = String(i.version || ''); aplPlat = i.platform === 'ios' ? 'ios' : 'android'; } catch (e) {}
  const p = await aplCheck(lsGet('amp_plan')).catch(() => null);
  if (p) apl = p;
  aplAt = +lsGet('amp_plan_at') || 0;
  aplSig = aplSigOf();
}
const planReady = () => aplReady || (aplReady = aplLoad().catch(() => {}));
async function planRefresh() {
  await planReady();
  if (!APL_ON || !window.AMPNative) return planStatus();
  if (aplBusy) return aplBusy;
  aplBusy = (async () => {
    try {
      const v = /^\d{1,3}\.\d{1,3}\.\d{1,4}(-[a-z0-9.]{1,12})?$/.test(aplVer) ? aplVer : '0.0.0';
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      if (ac) setTimeout(() => ac.abort(), 15000);
      // text/plain: einfache Anfrage ohne Vorab-Anfrage (CORS erlaubt der Server für die App-Herkünfte)
      const r = await _fetch(aplUrl(), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ id: aplId(), v, p: aplPlat }), cache: 'no-store', ...(ac ? { signal: ac.signal } : {}) });
      const j = await r.json().catch(() => ({}));
      const p = r.ok && j.ok ? await aplCheck(j.token) : null;
      if (!p) throw new Error(r.ok ? 'bad_token' : 'http_' + r.status);
      if (!apl || +p.iat >= +apl.iat) { apl = p; lsSet('amp_plan', j.token); }
      aplAt = Date.now(); lsSet('amp_plan_at', String(aplAt)); aplErr = '';
    } catch (e) { aplErr = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || 'net').slice(0, 40); }
    aplBusy = null;
    aplChanged();
    return planStatus();
  })();
  return aplBusy;
}
if (APL_ON && window.AMPNative) {
  planReady();
  setTimeout(() => { planRefresh().catch(() => {}); }, 4000);
  setInterval(() => { planRefresh().catch(() => {}); }, APL_EVERY);
  on('resume', () => { if (Date.now() - aplAt > 3600e3) planRefresh().catch(() => {}); });
}
const plan = { allows: planAllows, limit: planLimit, status: planStatus, refresh: planRefresh, ready: planReady };

// Leisten des Handys in der Farbe der Kopfzeile (hell/dunkel), bei jedem Umschalten
function bars() {
  const top = document.querySelector('.fmx-top'); if (!top || !window.AMPNative) return;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(top).backgroundColor); if (!m) return;
  const rgb = m.slice(1, 4).map(Number), color = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  native('bars', { color, dark: (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5 }).catch(() => {});
}
new MutationObserver(() => setTimeout(bars, 50)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.addEventListener('DOMContentLoaded', () => setTimeout(bars, 50));

window.AMP = { api, form, native, on, boot, gcodeMeta, plan: APL_ON ? plan : null, get db() { return db; } };
})();
