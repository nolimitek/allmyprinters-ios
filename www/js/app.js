/* AllMyPrinters — gebaut aus 3DSEARCH filament/app.js + amp-views.js (tools/build_web.py). Nicht von Hand ändern. */
/* 3DSEARCH Filament — Oberfläche. Ansichten über das Hash (#spools, #catalog, #history, #stats, #community, #s<ID>). */
(() => {
'use strict';
const S = FM.S, LANG = FM.lang;
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view'), sheet = $('#sheet'), scrim = $('#scrim'), dlg = $('#dlg');

const t = (k, p) => { let s = S[k] ?? k; if (p) for (const x in p) s = s.split('{' + x + '}').join(p[x]); return s; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat(LANG, { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat(LANG, { maximumFractionDigits: 1 });
// Anzeigewährung des Nutzers (fm_currency, 16.10.2026): nur Anzeige, umgerechnet wird nichts. Eingebettet kennt die Seite den
// Nutzer erst über den Schlüssel → setCur() vor dem ersten render(). Community-Durchschnittspreise bleiben in Euro.
let cur, CSYM;
const setCur = c => {
  const code = /^[A-Z]{3}$/.test(c || '') ? c : 'EUR';
  try { cur = new Intl.NumberFormat(LANG, { style: 'currency', currency: code }); } catch (e) { cur = new Intl.NumberFormat(LANG, { style: 'currency', currency: 'EUR' }); }
  CSYM = (cur.formatToParts(0).find(p => p.type === 'currency') || {}).value || code;
  FM.cur = cur.resolvedOptions().currency;
};
setCur(FM.cur);
const eur = new Intl.NumberFormat(LANG, { style: 'currency', currency: 'EUR' });   // Community-Preise (Mittel über Euro-Nutzer)
const g = v => nf.format(Math.round(v)) + ' g';
const kg = v => v >= 1000 ? nf1.format(v / 1000) + ' kg' : g(v);
const date = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString(LANG, { day: '2-digit', month: 'short', year: 'numeric' }) : '–';
// Uhrzeit 24/12 h (23.11.2026, AllMyPrinters-Community #53: App auf Englisch in Schweden zeigte AM/PM). Nur in der App (FM.app):
// localStorage amp_time = 24 | 12, sonst automatisch: 24 h, sobald App-Sprache ODER Gerät (navigator.languages[0]) 24 h nutzt.
// Website /filament: {} → wie bisher nach Sprache.
const HC = (() => {
  if (!FM.app) return {};
  let v = ''; try { v = localStorage.getItem('amp_time') || ''; } catch (e) {}
  if (v === '24' || v === '12') return { hour12: v === '12' };
  const hc = l => { try { return new Intl.DateTimeFormat(l, { hour: 'numeric' }).resolvedOptions().hourCycle || ''; } catch (e) { return ''; } };
  const dev = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  return { hour12: ![LANG, dev].some(l => l && /^h2[34]$/.test(hc(l))) };
})();
const dtime = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString(LANG, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', ...HC }) : '–';
const matName = m => m === '?' ? t('mat_unknown') : m;
const dia = d => new Intl.NumberFormat(LANG, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(d) + ' mm';
const catName = it => it.name.toLowerCase().includes(String(it.material).toLowerCase()) ? `${it.vendor} · ${it.name}` : `${it.vendor} ${it.material} · ${it.name}`;

// Eingebettet (Home Assistant, embed.php): angemeldet über den Kurzzeit-Schlüssel im Authorization-Kopf statt über das Cookie
const AUTH = FM.tok ? { Authorization: 'Bearer ' + FM.tok } : {};
function embedExpired(r) {
  if (!FM.embed || r.status !== 401) return;
  view.innerHTML = `<div class="empty">${esc(t('embed_expired'))}</div>`;
  try { window.parent.postMessage({ type: '3dsearch-embed-expired', view: location.hash.slice(1) }, '*'); } catch (e) { /* ohne Rahmen */ }
}
async function api(a, body) {
  // AllMyPrinters: lokales Backend auf dem Handy (backend.js) statt api.php
  return AMP.api(a, body, arguments[2] || {});
}
// Navigationszähler (render() zählt hoch): Eine Lese-Antwort, die erst nach einem Ansichtswechsel eintrifft, wird verworfen.
// Sonst zeichnete z. B. die Druckerübersicht nach ihrer Cloud-Abfrage über „Verbindungen“ und pollte dort alle 10 s weiter
// (halb eingegebenes Token weg). Schreibende Aufrufe (api mit body) sind ausgenommen — Nutzeraktionen gehen nie verloren.
let navGen = 0;
const STALE = 'stale';
const get = async (a, params) => { const g = navGen; const d = await api(a, null, params); if (g !== navGen) throw new Error(STALE); return d; };

let toastT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2400); }
function fail(e) { if (e && e.message === STALE) return; toast(t('err_' + e.message) !== 'err_' + e.message ? t('err_' + e.message) : t('err_generic')); console.error(e); }

// ── Zustand ────────────────────────────────────────────────────────────────
let lastView = null;
const st = { spools: [], locations: [], q: '', mat: '', loc: '', arch: false, facets: null };
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('fm_' + k); localStorage.setItem('fm_' + k, v); } catch (e) { return null; } };
st.arch = pref('arch') === '1';
// Spulenliste (19.10.2026, nach Spoolman v0.26): Gruppieren, Sortieren, Kacheln/Liste und die Filter bleiben je Browser gemerkt.
// Darstellung ohne gemerkte Wahl: ab 25 aktiven Spulen die Liste (große Lager scrollen sonst endlos durch Kacheln).
const GROUPS = ['loc', 'brand', 'mat', 'none'], SORTS = ['slot', 'last', 'left', 'added', 'name'];
st.group = GROUPS.includes(pref('group')) ? pref('group') : pref('group') === 'fil' ? 'none' : 'loc';
st.sort = SORTS.includes(pref('sort')) ? pref('sort') : 'slot';
st.mat = pref('mat') || ''; st.loc = pref('loc') || '';
st.open = new Set();   // aufgeklappte Gruppen gleicher unbenutzter Spulen
st.fpanel = false;     // Filter am Handy aufgeklappt

async function loadSpools() { const d = await get('spools'); st.spools = d.spools; st.locations = d.locations; }
async function facets() { if (!st.facets) st.facets = await get('facets'); return st.facets; }

/** Ringfarbe: echte Farbe, aber nahe Schwarz (dunkles Design) bzw. nahe Weiß (helles) zum Hintergrund hin abgesetzt. */
function ringColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#888888';
  const n = parseInt(m[1], 16), rgb = [n >> 16, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const mix = (to, f) => '#' + rgb.map(v => Math.round(v + (to - v) * f).toString(16).padStart(2, '0')).join('');
  return dark && lum < 0.22 ? mix(255, 0.42 - lum) : !dark && lum > 0.85 ? mix(0, 0.28) : '#' + m[1];
}
function ring(s, lg) {
  const c = ringColor(s.colors && s.colors.length > 1 ? s.colors[0] : s.color);
  const inner = lg ? `<b class="rv">${nf.format(s.left)}<small> g</small></b><small class="rp">${s.pct} %</small>` : `${s.pct}%`;
  // Mehrfarbig (Dual/Tri-Color, Regenbogen): der gefüllte Teil zeigt alle Farben nacheinander statt nur der ersten
  const multi = s.colors && s.colors.length > 1
    ? `;background:conic-gradient(${s.colors.map((x, i, a) => `${esc(ringColor(x))} ${(s.pct * i / a.length).toFixed(1)}% ${(s.pct * (i + 1) / a.length).toFixed(1)}%`).join(', ')}, var(--track) 0)` : '';
  return `<span class="ring${lg ? ' lg' : ''}" style="--c:${esc(c)};--p:${s.pct}${multi}"><i>${inner}</i></span>`;
}
/** Farbfeld einer Spule; mehrfarbig als Verlauf. */
const swatchBg = s => s.colors && s.colors.length > 1 ? `linear-gradient(135deg, ${s.colors.map(esc).join(', ')})` : esc(s.color || '#888');
/** Kleine Spule (Seitenansicht) statt Farbfeld in der Liste (20.10.2026): zwei Ränder, dazwischen die Wicklung in der
 *  Spulenfarbe, oben Licht, unten Schatten; mehrfarbig als Streifen. Ränder/Kontur über --spi-fl/--spi-ol (hell/dunkel). */
let spoolN = 0;
function spoolIco(s) {
  const cs = s.colors && s.colors.length > 1 ? s.colors : [s.color || '#888'], id = 'spi' + (++spoolN), w = 14.8 / cs.length;
  const fill = cs.map((c, i) => `<rect x="${(4.6 + i * w).toFixed(2)}" y="3.6" width="${(w + .05).toFixed(2)}" height="16.8" fill="${esc(c)}"/>`).join('');
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><clipPath id="${id}"><rect x="4.6" y="3.6" width="14.8" height="16.8" rx="3.4"/></clipPath>`
    + `<g clip-path="url(#${id})">${fill}<rect x="4.6" y="3.6" width="14.8" height="4.4" fill="#fff" opacity=".3"/><rect x="4.6" y="15.6" width="14.8" height="4.8" fill="#000" opacity=".2"/></g>`
    + `<rect class="spi-ol" x="4.6" y="3.6" width="14.8" height="16.8" rx="3.4"/><rect class="spi-fl" x="1.8" y="1.2" width="3.2" height="21.6" rx="1.6"/><rect class="spi-fl" x="19" y="1.2" width="3.2" height="21.6" rx="1.6"/></svg>`;
}
const title = s => s.brand ? `${s.brand}` : s.name;
// Spoolman-Nummer (ext_ref „spoolman:115“ aus Import/AFC-Spur): die kennen Spoolman-Nutzer von ihren Etiketten, unsere #ID nicht
// (Donnie 22.10.2026: „I could not find a spool ID … like #115 … I only see #706“) — überall daneben zeigen und suchbar machen
const smNo = s => (/^spoolman:(\d+)$/.exec(s.ext_ref || '') || [])[1] || null;
const spoolNo = s => smNo(s) ? `Spoolman #${smNo(s)}` : `#${s.id}`;
const sub = s => s.color_name && s.color_name.toLowerCase().includes(String(s.material).toLowerCase()) ? s.color_name : [s.material, s.color_name].filter(Boolean).join(' · ');
const slotTxt = sl => t('in_printer', { p: sl.printer, s: sl.slot === 'ext' ? t('slot_ext') : sl.slot });
// Spulen im Drucker zuerst und in Fach-Reihenfolge (Fach 1, 2, 3 …); der Rest behält die Server-Reihenfolge (Material, ID)
const bySlot = (a, b) => {
  const x = a.slots[0], y = b.slots[0];
  if (!x || !y) return !x - !y;
  return String(x.printer).localeCompare(String(y.printer)) || x.pid.localeCompare(y.pid) || x.index - y.index;
};

// ── Ansicht: Spulen ────────────────────────────────────────────────────────
// Shop für den Knopftext — dieselbe Wahl wie go.php: Markenshop, sonst Länder-Shop, wenn er das Material führt (Anycubic für
// US-Nutzer: FM.aff.cc, Materialwörter wie aff_shop_mat), sonst der Allrounder
function affShop(aff, s) {
  const b = aff.brands[String(s.brand || '').toLowerCase()];
  if (b) return b;
  const w = String(s.material || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return aff.cc && w.length && aff.cc.mats.some(k => k.every(x => w.includes(x))) ? aff.cc.name : aff.def;
}

// Leer-Prognose (31.10.2026, fm_forecast in api.php): nur Spulen mit genug Druckdaten haben s.fc
const fcVal = s => { const d = s.fc.days; return d < 2 ? t('fc_v_soon') : d < 14 ? t('fc_v_days', { n: d }) : d < 70 ? t('fc_v_weeks', { n: Math.round(d / 7) }) : t('fc_v_months', { n: Math.round(d / 30) }); };
// Warnstufe einer Spule (10.11.2026): liefert das Backend lvl (AllMyPrinters: eigene Schwellen, je Spule, „nie warnen“),
// sonst wie bisher fest unter FM.low (100 g). 1 = bald leer, 2 = kritisch.
const isLow = s => s.lvl !== undefined ? s.lvl > 0 : s.left < FM.low;
const isCrit = s => s.lvl === 2;
// „Bald leer“ (16.10.2026): Spulen unter FM.low mit Nachkaufen-Link (Partnerlink über /go.php, src fm_low), knappste zuerst
function lowList(active) {
  const low = active.filter(s => isLow(s) && s.total).sort((a, b) => (b.lvl || 0) - (a.lvl || 0) || a.left - b.left).slice(0, 6);
  if (!low.length) return '';
  // Ausgeblendet (05.11.2026): gilt für genau diese Spulen; kommt eine neue fast leere dazu, erscheint der Kasten wieder
  const ids = low.map(s => s.id).sort((a, b) => a - b), hid = (pref('low_hide') || '').split(',');
  if (ids.every(id => hid.includes(String(id)))) return '';
  const aff = FM.aff || { brands: {}, def: '3DJake' };
  return `<section class="lowbox"><div class="lowbox-h"><b>${esc(t('low_h'))}</b><span>${esc(t('low_lead', { g: FM.low }))}</span>
    <button type="button" class="lowhide" id="lowhide" data-ids="${ids.join(',')}" title="${esc(t('low_hide_t'))}">${esc(t('low_hide'))} ×</button></div>
    ${low.map(s => {
      const q = new URLSearchParams({ b: s.brand || '', m: s.material || '', c: s.color_name || '', src: FM.embed ? 'ha' : 'fm_low' });
      const shop = affShop(aff, s);
      return `<div class="lowrow"><span class="sw lg" style="background:${esc((s.colors && s.colors[0]) || s.color || '#888')}"></span>
        <a class="lowname" href="#s${s.id}"><b>${esc(title(s))}</b><small>${esc(sub(s))}${s.fc ? ' · ' + esc(t('fc_tag', { x: fcVal(s) })) : ''}</small></a><span class="lowg">${g(s.left)}</span>
        <a class="btn sm lowbuy" href="/go.php?${q}" target="_blank" rel="sponsored nofollow noopener">${esc(t('buy_btn', { shop }))} ↗</a></div>`;
    }).join('')}
    <p class="hint">${esc(S.buy_note)}</p></section>`;
}
// Sortierungen der Spulenliste (archivierte stehen immer hinten)
const tsv = s => s ? Date.parse(s.replace(' ', 'T') + 'Z') || 0 : 0;
const SORT_FN = {
  slot: bySlot,
  last: (a, b) => tsv(b.last_used_at) - tsv(a.last_used_at) || bySlot(a, b),
  left: (a, b) => a.left - b.left || a.id - b.id,
  added: (a, b) => tsv(b.created_at) - tsv(a.created_at) || b.id - a.id,
  name: (a, b) => (title(a) + ' ' + sub(a)).localeCompare(title(b) + ' ' + sub(b), LANG) || a.id - b.id,
};
// Gruppen: [Schlüssel, Überschrift]; der leere Schlüssel („ohne …“) steht immer hinten
const GROUP_OF = {
  loc: s => [s.location || '', s.location || t('no_location')],
  fil: s => [[title(s), s.material, s.color_name].join('|').toLowerCase(), [title(s), sub(s)].filter(Boolean).join(' · ')],
  brand: s => [(s.brand || '').trim().toLowerCase(), s.brand || t('no_brand')],
  mat: s => [s.material || '', s.material ? matName(s.material) : t('mat_unknown')],
  none: () => ['', ''],
};
// Gleiche unbenutzte Spulen (gleiches Filament, Gewicht und Ort, in keinem Drucker) → ein Eintrag „3× unbenutzt · je 1 kg“
const twinKey = s => !s.archived && (s.brand || s.material || s.color_name) ? [s.brand, s.material, s.color_name, s.color].map(x => String(x || '').trim().toLowerCase()).join('|') : null;
function twinItems(ss) {
  const by = new Map();
  ss.forEach(s => { const k = twinKey(s); if (k) { if (!by.has(k)) by.set(k, []); by.get(k).push(s); } });
  const out = [], seen = new Set();
  for (const s of ss) {
    const k = twinKey(s), tw = k && by.get(k);
    if (!tw || tw.length < 2) { out.push({ s }); continue; }
    if (!seen.has(k)) { seen.add(k); out.push({ twin: tw, key: k }); }
  }
  return out;
}
const I_GRID = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></svg>';
const I_LIST = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/></svg>';
const I_FILTER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>';
const I_CHEV = '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const spoolTags = s => `${s.slots.map(sl => `<span class="tag on">${esc(slotTxt(sl))}</span>`).join('')}${!s.archived && isLow(s) ? `<span class="tag ${isCrit(s) ? 'crit' : 'warn'}">${t(isCrit(s) ? 'low_crit' : 'low')}</span>` : !s.archived && s.fc && s.fc.days <= 21 ? `<span class="tag warn">${esc(t('fc_tag', { x: fcVal(s) }))}</span>` : ''}`
  + `${s.dry && s.dry.due ? `<span class="tag warn" title="${esc(t('dry_tag_t', { d: s.dry.days }))}">${t('dry_tag')}</span>` : ''}${s.archived ? `<span class="tag">${t('archived')}</span>` : ''}`;
const spoolCard = s => `<button class="spool${s.archived ? ' arch' : ''}" data-id="${s.id}">${ampSpool(s)}
  <span class="t"><b>${esc(title(s))}</b><span class="s">${esc(sub(s))} · ${esc(spoolNo(s))}</span>
  <span class="x"><span class="tag num left">${g(s.left)}</span>${spoolTags(s)}</span></span></button>`;
/** Listenzeile: Farbe, Name, #Nr · zuletzt benutzt · Ort/Fach, Füllbalken, Rest. $nest = Teil einer aufgeklappten Doppel-Gruppe. */
function spoolRow(s, nest) {
  const when = s.last_used_at ? esc(ago(s.last_used_at)) : s.used ? '' : esc(t('unused_s'));
  // Nach Filament gruppiert steht der Name schon in der Überschrift → Zeile zeigt Nummer und Ort (wie Spoolman)
  const fil = st.group === 'fil';
  const where = !fil && st.group !== 'loc' && s.location && !s.slots.length ? `<span class="lr-loc">${esc(s.location)}</span>` : '';
  const head = fil ? `<b>${esc(spoolNo(s))}</b><small>${esc(s.slots.length ? '' : s.location || t('no_location'))}</small>` : `<b>${esc(title(s))}</b><small>${esc(sub(s))}</small>`;
  return `<button class="lrow${s.archived ? ' arch' : ''}${!s.archived && isLow(s) ? ' low' + (isCrit(s) ? ' crit' : '') : ''}${nest ? ' nest' : ''}" data-id="${s.id}">
    <span class="lr-sw">${spoolIco(s)}</span>
    <span class="lr-t">${head}</span>
    <span class="lr-m">${fil ? '' : `<span class="lr-id"${smNo(s) ? ` title="3DSEARCH #${s.id}"` : ''}>${esc(spoolNo(s))}</span>`}${when ? `<span>${when}</span>` : ''}${where}${spoolTags(s)}</span>
    <span class="lr-bar" title="${s.pct} %"><i style="width:${s.pct}%;background:${esc(ringColor(s.colors && s.colors.length > 1 ? s.colors[0] : s.color))}"></i></span>
    <span class="lr-g">${g(s.left)}</span></button>`;
}
/** Doppel-Gruppe als Karte bzw. Zeile; aufgeklappt folgen die einzelnen Spulen. */
function twinItem_3ds(it, cards) {
  const s = it.twin[0], n = it.twin.length, open = st.open.has(it.key), txt = t('twins', { n, w: kg(s.total) });
  const head = cards
    ? `<button class="spool twin${open ? ' open' : ''}" data-twin="${esc(it.key)}" aria-expanded="${open}">${ampSpool(s)}<span class="t"><b>${esc(title(s))}</b><span class="s">${esc(sub(s))}</span>
        <span class="x"><span class="tag num left">${kg(s.total * n)}</span><span class="tag">${esc(txt)}</span>${I_CHEV}</span></span></button>`
    : `<button class="lrow twin${open ? ' open' : ''}" data-twin="${esc(it.key)}" aria-expanded="${open}"><span class="lr-sw">${spoolIco(s)}</span>
        <span class="lr-t">${st.group === 'fil' ? `<b>${esc(txt)}</b><small>${esc(s.location || t('no_location'))}</small>` : `<b>${esc(title(s))}</b><small>${esc(sub(s))}</small>`}</span>
        <span class="lr-m">${st.group === 'fil' ? '' : `<span class="tag">${esc(txt)}</span>`}${I_CHEV}</span>
        <span class="lr-bar"><i style="width:100%;background:${esc(ringColor(s.colors && s.colors.length > 1 ? s.colors[0] : s.color))}"></i></span><span class="lr-g">${kg(s.total * n)}</span></button>`;
  return head + (open ? it.twin.map(x => cards ? spoolCard(x) : spoolRow(x, true)).join('') : '');
}

function viewSpools() {
  const mats = [...new Set(st.spools.map(s => s.material))].sort();
  // Gemerkter Filter passt nicht mehr (Material aufgebraucht, Ort umbenannt) → nicht still eine leere Liste zeigen
  if (st.mat && !mats.includes(st.mat)) st.mat = '';
  if (st.loc && st.loc !== '-' && !st.locations.includes(st.loc)) st.loc = '';
  const list = st.spools.filter(s => (st.arch || !s.archived)
    && (!st.mat || s.material === st.mat) && (!st.loc || (s.location || '') === (st.loc === '-' ? '' : st.loc))
    && (!st.q || [s.brand, s.name, s.material, s.color_name, s.location, s.lot_nr, s.notes, '#' + s.id, smNo(s) ? 'spoolman #' + smNo(s) : ''].join(' ').toLowerCase().includes(st.q.toLowerCase())));
  const active = st.spools.filter(s => !s.archived);
  const sumG = active.reduce((a, s) => a + s.left, 0);
  const sumV = active.reduce((a, s) => a + (s.value || 0), 0);
  const low = active.filter(isLow).length;
  const totG = active.reduce((a, s) => a + (s.total || 0), 0), fillP = totG ? Math.round(sumG / totG * 100) : 0;
  const layout = ['cards', 'list'].includes(pref('layout')) ? pref('layout') : 'list';
  const nFilt = (st.mat ? 1 : 0) + (st.loc ? 1 : 0) + (st.arch ? 1 : 0);
  const opt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const chip = (k, label) => `<button type="button" class="chip on" data-clr="${k}">${esc(label)} ×</button>`;

  let html = `<h1>${t('spools_h')}</h1>${spoolTabs('spools')}<p class="lead">${t('spools_lead')}</p>${ampCardHtml()}
  ${active.length ? `<div class="skpis"><div class="sk-fill">${pctRing(fillP, 'var(--accent)', fillP + '%')}<span><small>${t('sk_fill')}</small><b>${kg(sumG)}</b></span></div>
    <div><small>${t('sum_spools')}</small><b>${nf.format(active.length)}</b></div>
    ${sumV ? `<div><small>${t('sum_value')}</small><b>${cur.format(sumV)}</b></div>` : ''}
    <div class="${low ? 'warn' : ''}"><small>${t('k_low')}</small><b>${nf.format(low)}</b></div></div>` : ''}
  ${lowList(active)}
  <div class="bar">
    <input class="in grow" id="q" type="search" placeholder="${esc(t('search_spools'))}" value="${esc(st.q)}">
    <button class="btn fbtn${st.fpanel ? ' on' : ''}" id="fbtn" aria-expanded="${st.fpanel}" aria-controls="fpanel">${I_FILTER}<span>${t('filters_btn')}</span>${nFilt ? `<span class="fcount">${nFilt}</span>` : ''}</button>
    <button class="btn bar-scan" id="scan2">${t('scan_btn')}</button>
    <button class="btn" id="labels" title="${esc(t('labels_hint'))}">${t('labels')}</button>
    <button class="btn pri" id="add">+ ${t('add_spool')}</button>
  </div>
  <div class="bar fpanel${st.fpanel ? ' open' : ''}" id="fpanel">
    <select class="in" id="fmat" aria-label="${esc(t('f_material'))}"><option value="">${t('all_materials')}</option>${mats.map(m => `<option${m === st.mat ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <select class="in" id="floc" aria-label="${esc(t('f_location'))}"><option value="">${t('all_locations')}</option>${st.locations.map(l => `<option${l === st.loc ? ' selected' : ''}>${esc(l)}</option>`).join('')}<option value="-"${st.loc === '-' ? ' selected' : ''}>${t('no_location')}</option></select>
    <label class="chk"><input type="checkbox" id="farch"${st.arch ? ' checked' : ''}> ${t('show_archived')}</label>
    <span class="fsp"></span>
    <select class="in" id="fgrp" aria-label="${esc(t('grp_label'))}">${GROUPS.map(k => opt(k, st.group, t('grp_label') + ': ' + t('grp_' + k))).join('')}</select>
    <select class="in" id="fsort" aria-label="${esc(t('sort_label'))}">${SORTS.map(k => opt(k, st.sort, t('sort_label') + ': ' + t('sort_' + k))).join('')}</select>
    <span class="seg lay" role="group"><button type="button" data-lay="cards" class="${layout === 'cards' ? 'on' : ''}" title="${esc(t('lay_cards'))}" aria-label="${esc(t('lay_cards'))}" aria-pressed="${layout === 'cards'}">${I_GRID}</button><button type="button" data-lay="list" class="${layout === 'list' ? 'on' : ''}" title="${esc(t('lay_list'))}" aria-label="${esc(t('lay_list'))}" aria-pressed="${layout === 'list'}">${I_LIST}</button></span>
  </div>
  ${nFilt && !st.fpanel ? `<div class="fchips">${st.mat ? chip('mat', st.mat) : ''}${st.loc ? chip('loc', st.loc === '-' ? t('no_location') : st.loc) : ''}${st.arch ? chip('arch', t('show_archived')) : ''}</div>` : ''}`;
  if (!st.spools.length) {
    html += `<div class="empty"><b>${t('empty_h')}</b>${t('empty_txt')}<br><br><button class="btn pri" id="add2">+ ${t('add_spool')}</button> <a class="btn" href="#import">${esc(t('amp_imp_link'))}</a></div>`;
  } else if (!list.length) {
    html += `<div class="empty">${t('no_match')}</div>`;
  } else {
    const sorted = list.slice().sort((a, b) => a.archived - b.archived || SORT_FN[st.sort](a, b));
    const groups = new Map();
    sorted.forEach(s => { const [k, lab] = GROUP_OF[st.group](s); if (!groups.has(k)) groups.set(k, { lab, ss: [] }); groups.get(k).ss.push(s); });
    const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || groups.get(a).lab.localeCompare(groups.get(b).lab, LANG));
    for (const k of keys) {
      const { lab, ss } = groups.get(k);
      const gl = ss.reduce((a, s) => a + s.left, 0), gt = ss.reduce((a, s) => a + (s.total || 0), 0);
      // Nach Filament: kleinere Überschrift mit Farbfeld, ohne Gruppenbalken (die Zeilen haben ihre eigenen)
      if (st.group === 'fil') html += `<div class="group-h gfil"><span class="lr-sw lg">${spoolIco(ss[0])}</span><b>${esc(lab)}</b><span>${t(ss.length === 1 ? 'n_spool' : 'n_spools', { n: ss.length })} · ${kg(gl)}</span></div>`;
      else if (st.group !== 'none') html += `<div class="group-h"><b>${esc(lab)}</b><span>${t(ss.length === 1 ? 'n_spool' : 'n_spools', { n: ss.length })} · ${kg(gl)}</span>${gt ? `<span class="gbar" title="${Math.round(gl / gt * 100)} %"><i style="width:${(gl / gt * 100).toFixed(1)}%"></i></span>` : ''}</div>`;
      const items = twinItems(ss);
      html += layout === 'cards' ? `<div class="grid">${items.map(it => it.twin ? twinItem(it, true) : spoolCard(it.s)).join('')}</div>`
        : `<div class="lgrid">${items.map(it => it.twin ? twinItem(it, false) : spoolRow(it.s)).join('')}</div>`;
    }
  }
  view.innerHTML = html;
  if (window.ampSpoolsTidy) ampSpoolsTidy();
  const rerender = () => { const pos = $('#q') && $('#q').selectionStart; viewSpools(); const q = $('#q'); if (q && document.activeElement !== q && pos !== null) { q.focus(); q.setSelectionRange(pos, pos); } };
  const setPref = (k, v) => { st[k] = v; pref(k, v); viewSpools(); };
  const lh = $('#lowhide'); if (lh) lh.onclick = () => { pref('low_hide', lh.dataset.ids); viewSpools(); };
  $('#q') && $('#q').addEventListener('input', e => { st.q = e.target.value; rerender(); });
  $('#fmat').addEventListener('change', e => setPref('mat', e.target.value));
  $('#floc').addEventListener('change', e => setPref('loc', e.target.value));
  $('#farch').addEventListener('change', e => { st.arch = e.target.checked; pref('arch', st.arch ? '1' : '0'); viewSpools(); });
  $('#fgrp').addEventListener('change', e => setPref('group', e.target.value));
  $('#fsort').addEventListener('change', e => setPref('sort', e.target.value));
  view.querySelectorAll('[data-lay]').forEach(b => b.addEventListener('click', () => { pref('layout', b.dataset.lay); viewSpools(); }));
  $('#fbtn').addEventListener('click', () => { st.fpanel = !st.fpanel; viewSpools(); });
  view.querySelectorAll('[data-clr]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.clr === 'arch') { st.arch = false; pref('arch', '0'); viewSpools(); } else setPref(b.dataset.clr, '');
  }));
  $('#labels').addEventListener('click', () => ampLabels(list.filter(s => !s.archived).map(s => s.id)));
  [$('#add'), $('#add2')].forEach(b => b && b.addEventListener('click', () => editSpool(null)));
  $('#scan2').addEventListener('click', openScanner);
  view.querySelectorAll('.spool[data-id], .lrow[data-id]').forEach(b => b.addEventListener('click', () => { location.hash = 's' + b.dataset.id; }));
  view.querySelectorAll('[data-twin]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.twin; st.open.has(k) ? st.open.delete(k) : st.open.add(k); viewSpools();
  }));
}

// ── Seitenpaneel: eine Spule ───────────────────────────────────────────────
function openSheet(html) { sheet.innerHTML = html; sheet.classList.add('on'); scrim.classList.add('on'); sheet.setAttribute('aria-hidden', 'false'); }
function closeSheet() { sheet.classList.remove('on'); scrim.classList.remove('on'); sheet.setAttribute('aria-hidden', 'true'); }
scrim.addEventListener('click', () => { history.replaceState(null, '', '#' + (lastView || 'spools')); closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet.classList.contains('on') && !dlg.open) { history.replaceState(null, '', '#' + (lastView || 'spools')); closeSheet(); } });

const SD_ICO = {
  use: '<path d="M12 5v14M5 12h14"/>',
  weigh: '<path d="M12 3v3M5 21h14l-2-12H7L5 21z"/><path d="M8 6h8"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
  label: '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  arch: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  print: '<path d="M6 9V3h12v6M6 18H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-2"/><rect x="6" y="14" width="12" height="7"/>',
  manual: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  correction: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.6-.6-.6-2.6z"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 7H6"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  dry: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dup: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
};
const sdIco = (k, sz = 18) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SD_ICO[k] || SD_ICO.manual}</svg>`;

async function showSpool(id) {
  await loadFields().catch(() => {});
  if (!st.spools.length) await loadSpools();
  const s = st.spools.find(x => x.id === id);
  if (!s) { toast(t('err_not_found')); return; }
  const rows = list => list.filter(Boolean).map(([k, v]) => `<div class="sd-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const fil = rows([
    [t('f_material'), esc(s.material || '–')], [t('f_diameter'), dia(s.diameter)], s.density && [t('f_density'), new Intl.NumberFormat(LANG, { maximumFractionDigits: 2 }).format(s.density) + ' g/cm³'],
    s.extruder_temp && [t('f_temps'), `${s.extruder_temp} °C / ${s.bed_temp ?? '–'} °C`],
    s.left > 0 && s.density && [t('f_length'), nf1.format(s.left / (s.density * Math.PI * Math.pow(s.diameter / 20, 2)) / 100) + ' m'],
    // Leerspule: Herkunft dazu (Spoolman „Overrides filament“) — Katalogwert oder eigener Wert mit dem Katalogwert zum Vergleich
    s.empty_spool_g != null && [t('f_empty_spool'), g(s.empty_spool_g) + (s.cat_spool_g == null ? ''
      : ` <small class="sd-src">· ${esc(s.cat_spool_g === s.empty_spool_g ? t('from_catalog') : t('es_own', { g: g(s.cat_spool_g) }))}</small>`)],
    s.lot_nr && [t('f_lot'), esc(s.lot_nr)],
    ...fieldsOf('spool').filter(f => s.custom && s.custom[f.id]).map(f => [esc(f.label), fieldShow(f, s.custom[f.id])]),
  ]);
  const use = rows([
    [t('f_location'), s.location ? esc(s.location) : '–'], [t('f_added'), date(s.created_at)],
    s.first_used_at && [t('f_first_used'), date(s.first_used_at)], s.last_used_at && [t('f_last_used'), date(s.last_used_at)],
    s.opened_at && [t('f_opened'), date(s.opened_at + ' 12:00:00')], [t('f_dried'), s.dried_at ? date(s.dried_at) : '–'],
  ]);
  // Trocknen empfohlen (07.10.2026): Material offen bzw. seit dem letzten Trocknen länger als seine Grenze
  const dry = s.dry && s.dry.due ? `<div class="note warn-note sd-dry">${sdIco('dry', 16)} ${esc(t(s.dry.since === 'dried' ? 'dry_due_dried' : 'dry_due_opened', { m: s.material, d: nf.format(s.dry.days), n: s.dry.limit }))}</div>` : '';
  const swatch = swatchBg(s);
  const tile = (k, v, sub, cls = '') => `<div class="sd-tile${cls}"><small>${k}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  const sec = (h, body) => body ? `<section class="sd-sec"><h3>${h}</h3><dl>${body}</dl></section>` : '';
  const btn = (act, label, cls = '') => `<button class="sd-act${cls}" data-act="${act}">${sdIco(act)}<span>${label}</span></button>`;
  // Nachkaufen (16.10.2026): Partnerlink über /go.php, Shop je Marke (affiliate_lib.php); hervorgehoben, wenn fast leer/aufgebraucht
  const aff = FM.aff || { brands: {}, def: '3DJake' };
  const shop = affShop(aff, s);
  const buyQ = new URLSearchParams({ b: s.brand || '', m: s.material || '', c: s.color_name || '', src: FM.embed ? 'ha' : 'fm' });
  const sc = esc((s.colors && s.colors[0]) || s.color || '#f07a1a');   // gezeichnete Rolle in der Farbe dieser Spule (wie aff_icon)
  const spoolPic = `<svg class="sd-buy-img" width="40" height="40" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="#d9dde3" stroke="#9aa3ad" stroke-width="1.5"/><circle cx="32" cy="32" r="23" fill="${sc}"/><circle cx="32" cy="32" r="19.5" fill="none" stroke="#000" stroke-opacity=".13"/><circle cx="32" cy="32" r="15.5" fill="none" stroke="#000" stroke-opacity=".13"/><circle cx="32" cy="32" r="10.5" fill="#eef0f3" stroke="#9aa3ad" stroke-width="1.5"/><circle cx="32" cy="32" r="3.5" fill="#9aa3ad"/><path d="M54.6 36c2 6 3.5 13 4.4 21" stroke="${sc}" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`;
  const buy = `<a class="sd-buy${s.archived || isLow(s) ? ' hot' : ''}" href="/go.php?${buyQ}" target="_blank" rel="sponsored nofollow noopener">${spoolPic}
    <span><b>${esc(t('buy_btn', { shop }))}</b><small>${esc(t('buy_note'))}</small></span>${sdIco('ext', 14)}</a>`;
  openSheet(`<div class="sheet-h sd-h"><span class="sd-id">${esc(t('sd_spool'))} #${s.id}${smNo(s) ? ` · Spoolman #${esc(smNo(s))}` : ''}</span><button class="x-btn" id="xs" aria-label="${esc(t('close'))}">×</button></div>
  <div class="sheet-b sd">
    <div class="sd-hero" style="--sc:${esc(ringColor(s.colors && s.colors.length > 1 ? s.colors[0] : s.color))}">${ring(s, true)}
      <div class="sd-t"><b>${esc(title(s))}</b>
        <span class="sd-sub"><i class="sd-sw" style="background:${swatch}"></i>${esc(sub(s) || s.material || '')}</span>
        <div class="sd-tags">${s.slots.map(sl => `<span class="tag on">${sdIco('print', 12)} ${esc(slotTxt(sl))}</span>`).join('')}${s.archived ? `<span class="tag">${t('archived')}</span>` : ''}${s.fm_filament_id ? `<span class="tag">${t('from_catalog')}</span>` : ''}</div>
      </div></div>
    <div class="sd-tiles">
      ${tile(t('f_left'), g(s.left), t('sd_of', { g: g(s.total) }), isLow(s) ? (isCrit(s) ? ' warn crit' : ' warn') : '')}
      ${tile(t('f_used'), g(s.used), '')}
      ${s.value != null ? tile(t('f_value'), cur.format(s.value), cur.format(s.price_per_kg) + '/kg') : ''}
    </div>
    ${s.fc ? `<p class="hint sd-fc">${esc(t('fc_line', { x: fcVal(s), g: nf.format(s.fc.gpd) }))}</p>` : ''}
    ${!s.archived && s.left < 1 ? `<div class="note warn-note sd-out"><span class="grow">${esc(s.over > 0 ? t('sd_over', { g: g(s.over) }) : t('sd_used_up'))}</span>
      <span class="slot-btns"><button type="button" class="btn sm pri" data-act="left">${esc(t('left_btn'))}</button><button type="button" class="btn sm ghost" data-act="arch">${esc(t('act_archive'))}</button></span></div>` : ''}
    <button class="btn pri sd-main" data-act="use">${sdIco('use')} ${t('act_use')}</button>
    <div class="sd-acts">${btn('weigh', t('act_weigh'))}${btn('dry', t('act_dried'))}${btn('edit', t('act_edit'))}${btn('label', t('act_label'))}${btn('arch', s.archived ? t('act_unarchive') : t('act_archive'))}</div>
    ${buy}${dry}${typeof ampWarnBlock === 'function' ? ampWarnBlock(s) : ''}${typeof ampNfcBlock === 'function' ? ampNfcBlock(s) : ''}<div id="sform"></div>
    ${s.notes ? `<div class="sd-note"><small>${t('f_notes')}</small><p>${esc(s.notes)}</p></div>` : ''}
    ${sec(t('sd_sec_filament'), fil)}${sec(t('sd_sec_usage'), use)}
    <h3 class="sd-hh">${t('history_h')}</h3><ul class="sd-hist" id="shist"><li class="loading">${t('loading')}</li></ul>
    <div class="sd-more"><button class="sd-dup" data-act="dup">${sdIco('dup', 16)}<span>${t('act_dup')}</span></button>
      ${s.slots.length ? '' : `<button class="sd-del" data-act="del">${t('act_delete')}</button>`}</div>
  </div>`);
  $('#xs').onclick = () => { history.replaceState(null, '', '#' + (lastView || 'spools')); closeSheet(); };
  sheet.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => spoolAction(s, b.dataset.act)));
  get('history', { spool: s.id }).then(d => {
    $('#shist').innerHTML = d.items.length ? d.items.map(sdHistLi).join('') : `<li class="hint">${t('history_empty')}</li>`;
  }).catch(fail);
}
/** Verlaufszeile in der Spulenansicht: Symbol je Art, Text zweizeilig, Zeit + Drucker darunter. */
function sdHistLi(h) {
  const back = h.grams < 0, hn = histNote(h);
  const what = h.kind === 'print' && hn ? hn : t('kind_' + h.kind) + (hn ? ' · ' + hn : '');
  const meta = [dtime(h.created_at), h.printer || ''].filter(Boolean).join(' · ');   // Art zeigt das Symbol
  return `<li><span class="sd-hi k-${esc(h.kind)}">${sdIco(h.kind === 'weigh' ? 'weigh' : h.kind, 16)}</span>
    <span class="sd-hw"><b>${esc(what)}</b><small>${esc(meta)}</small></span>
    <span class="sd-hg${back ? ' pos' : ''}">${+h.grams === 0 ? '–' : (back ? '+' : '−') + gUse(h.grams)}</span></li>`;
}

/** Vermerk einer Buchung lesbar machen: interne Kennungen übersetzen, Druckname kürzen. */
function histNote(h) {
  if (h.kind === 'dry') return h.note === 'box' ? t('note_dry_box') : (h.note || '');
  const wn = h.kind === 'weigh' && /^\d+\|\d+$/.test(h.note || '') ? h.note.split('|') : null;
  if (wn) return t('weigh_note', { g: nf.format(wn[0]), s: nf.format(wn[1]) });
  let note = h.note === 'pending' ? t('note_pending') : h.note === 'orphan' ? t('note_orphan') : h.note === 'duplicate' ? t('note_duplicate') : h.note === 'edit' ? ''
    : h.note === 'empty' ? t('note_marked_empty') : h.note === 'left' ? t('note_left_set') : (h.note || '');
  const bk = note ? note.match(/\|(?:backup:(\d+)(\?)?|unbooked:(\d+)|(runout))$/) : null;
  let extra = '';
  if (bk) {
    const src = st.spools.find(x => x.id === +bk[1]);
    extra = bk[4] ? t('note_runout') : bk[1] ? t(bk[2] ? 'note_backup_guess' : 'note_backup', { s: src ? src.name : '#' + bk[1] }) : t('note_unbooked', { g: bk[3] });
    note = note.slice(0, bk.index);
  }
  // Druckname: Server liefert den gekürzten Titel des Auftrags; sonst Slicer-Dateinamen hier kürzen
  if (h.title && h.kind === 'print' && h.note !== 'pending' && h.note !== 'orphan') note = h.title;
  else if (h.kind === 'print') note = note.replace(/\.(gcode|bgcode|3mf)$/i, '').replace(/^3DSEARCH_/, '').replace(/^\d{4}-\d{4}-/, '').replace(/_/g, ' ').trim();
  return [note, extra].filter(Boolean).join(' · ');
}
/** Menge: unter 1 g mit einer Nachkommastelle (vorher stand „−0 g“). */
const gUse = v => Math.abs(v) < 1 ? new Intl.NumberFormat(LANG, { maximumFractionDigits: 1 }).format(Math.abs(v)) + ' g' : g(Math.abs(v));

function histLi(h, withSpool) {
  const sign = h.grams < 0;
  const wn = h.kind === 'weigh' && /^\d+\|\d+$/.test(h.note || '') ? h.note.split('|') : null;
  // Interne Vermerke übersetzen: 'pending' = beim Zuweisen nachgebuchter Verbrauch des Fachs, 'edit' = Korrektur per Bearbeiten
  let note = h.note === 'pending' ? t('note_pending') : h.note === 'orphan' ? t('note_orphan') : h.note === 'duplicate' ? t('note_duplicate') : h.note === 'edit' ? '' : h.note;
  // Ersatzspule (Rolle lief im Druck leer): „…|backup:<Rolle>[?]“ bzw. „…|unbooked:<g>“ aus pc_book_slot
  const bk = !wn && note ? note.match(/\|(?:backup:(\d+)(\?)?|unbooked:(\d+))$/) : null;
  if (bk) {
    const base = note.slice(0, bk.index), src = st.spools.find(x => x.id === +bk[1]);
    note = [base, bk[1] ? t(bk[2] ? 'note_backup_guess' : 'note_backup', { s: src ? src.name : '#' + bk[1] }) : t('note_unbooked', { g: bk[3] })].filter(Boolean).join(' · ');
  }
  const hn = histNote(h);
  const what = t('kind_' + h.kind) + (hn ? ' · ' + hn : '');
  return `<li><span class="d">${dtime(h.created_at)}</span><span class="w">${withSpool ? `<span class="sw" style="background:${esc(h.color_hex || '#888')}"></span> <a href="#s${h.spool_id}">${esc(h.name || '#' + h.spool_id)}</a> · ` : ''}${esc(what)}</span>
    <span class="g${sign ? ' neg' : ''}">${+h.grams === 0 ? '–' : (sign ? '+' : '−') + gUse(h.grams)}</span></li>`;
}

function replaceSpool(s) { const i = st.spools.findIndex(x => x.id === s.id); if (i >= 0) st.spools[i] = s; }

function spoolAction(s, act) {
  const box = $('#sform');
  if (act === 'use') {
    box.innerHTML = `<form class="inline-form" id="fu"><div class="row"><label class="fld"><span>${t('use_grams')}</span><input class="in num" name="grams" type="number" step="1" required autofocus></label></div>
      <label class="fld"><span>${t('use_note')}</span><input class="in" name="note" maxlength="255" placeholder="${esc(t('use_note_ph'))}"></label>
      <div class="hint">${t('use_hint')}</div><div class="row"><button class="btn pri">${t('save')}</button><button type="button" class="btn ghost" data-x>${t('cancel')}</button></div></form>`;
    box.querySelector('[data-x]').onclick = () => box.innerHTML = '';
    $('#fu').onsubmit = async e => {
      e.preventDefault(); const f = new FormData(e.target);
      try { const d = await api('spool_use', { id: s.id, grams: +f.get('grams'), note: f.get('note') }); replaceSpool(d.spool); toast(t('saved')); showSpool(s.id); } catch (er) { fail(er); }
    };
  } else if (act === 'weigh') {
    box.innerHTML = `<form class="inline-form" id="fw"><div class="row">
      <label class="fld"><span>${t('weigh_gross')}</span><input class="in num" name="gross" type="number" min="1" step="1" required autofocus></label>
      <label class="fld"><span>${t('f_empty_spool')}</span><input class="in num" name="empty" type="number" min="0" step="1" value="${s.empty_spool_g ?? ''}" required></label></div>
      <div class="hint" id="wres">${t('weigh_hint')}</div>
      <div class="row"><button class="btn pri">${t('save')}</button><button type="button" class="btn ghost" data-x>${t('cancel')}</button></div></form>`;
    box.querySelector('[data-x]').onclick = () => box.innerHTML = '';
    const upd = () => { const f = new FormData($('#fw')); const gr = +f.get('gross'), em = +f.get('empty'); if (gr && f.get('empty') !== '') $('#wres').textContent = t('weigh_result', { n: nf.format(Math.max(0, gr - em)) }); };
    $('#fw').addEventListener('input', upd);
    $('#fw').onsubmit = async e => {
      e.preventDefault(); const f = new FormData(e.target);
      try { const d = await api('spool_weigh', { id: s.id, gross: +f.get('gross'), empty_spool_g: +f.get('empty') }); replaceSpool(d.spool); toast(t('saved')); showSpool(s.id); } catch (er) { fail(er); }
    };
  } else if (act === 'left') {
    leftDialog({ spool: s.id, sname: title(s) }, () => showSpool(s.id));
  } else if (act === 'dry') {
    api('spool_dried', { id: s.id }).then(d => { replaceSpool(d.spool); toast(t('dried_saved')); showSpool(s.id); }).catch(fail);
  } else if (act === 'edit') {
    editSpool(s);
  } else if (act === 'label') {
    ampLabels([s.id]);
  } else if (act === 'arch') {
    api('spool_archive', { id: s.id, archived: !s.archived }).then(d => { replaceSpool(d.spool); toast(t('saved')); showSpool(s.id); }).catch(fail);
  } else if (act === 'dup') {
    // Duplizieren (19.10.2026): neue, volle Spule mit denselben Angaben — Katalogbindung, Gewichte, Preis, Ort; Daten und Verbrauch nicht
    const preset = s.fm_filament_id ? { id: s.fm_filament_id, vendor: s.brand, material: s.material, name: s.color_name, color: s.color, colors: s.colors,
      weight_g: s.total, spool_weight_g: s.empty_spool_g, diameter: s.diameter } : null;
    editSpool(null, preset, { copy: spoolCopy(s, true) });
  } else if (act === 'del') {
    const del = () => api('spool_delete', { id: s.id }).then(() => { st.spools = st.spools.filter(x => x.id !== s.id); closeSheet(); location.hash = 'spools'; toast(t('deleted')); render(); }).catch(fail);
    if (s.archived || s.left <= 0) { if (confirm(t('confirm_delete'))) del(); return; }
    // Noch Filament drauf: Archivieren anbieten (Verlauf und Statistik bleiben), Löschen nur ausdrücklich
    dlg.innerHTML = `<form method="dialog" class="dlg-sm"><div class="dlg-h"><b>${esc(t('del_left_h', { g: g(s.left) }))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
      <div class="dlg-b"><p>${esc(t('del_left_txt'))}</p></div>
      <div class="dlg-f"><button type="button" class="btn ghost danger" data-del>${t('del_anyway')}</button><button type="button" class="btn pri" data-arch>${t('act_archive')}</button></div></form>`;
    dlg.querySelector('[data-x]').onclick = () => dlg.close();
    dlg.querySelector('[data-del]').onclick = () => { dlg.close(); del(); };
    dlg.querySelector('[data-arch]').onclick = () => { dlg.close(); spoolAction(s, 'arch'); };
    dlg.showModal();
  }
}
/** Angaben einer Spule für „Duplizieren“ bzw. „Speichern & nächste Farbe“ ($color = Farbe mitnehmen). */
const spoolCopy = (s, color) => ({ brand: s.brand, material: s.material, total: s.total, empty_spool_g: s.empty_spool_g, diameter: s.diameter, location: s.location,
  price_spool: s.price_per_kg ? (s.price_per_kg * s.total / 1000).toFixed(2) : '', ...(color ? { color_name: s.color_name, color: s.color } : {}) });

// ── Dialog: Spule anlegen / bearbeiten ─────────────────────────────────────
async function editSpool(s, preset, opts = {}) {
  await loadFields().catch(() => {});
  const isNew = !s;
  let picked = preset || null;      // Katalogeintrag
  let linked = s && s.fm_filament_id ? { id: s.fm_filament_id, vendor: s.brand, material: s.material, name: s.color_name, color: s.color } : null;
  const mats = st.facets ? st.facets.materials.map(m => m.material) : ['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC'];
  // Neue Spule mit Vorgaben (Duplizieren, „Speichern & nächste Farbe“): opts.copy aus spoolCopy()
  const c = s ? null : (opts.copy || {});
  const val = (k, d = '') => s ? (s[k] ?? d) : (c[k] ?? d);
  const priceSpool = s ? (s.price_per_kg ? (s.price_per_kg * s.total / 1000).toFixed(2) : '') : (c.price_spool || '');
  // Füllstand beim Anlegen (19.10.2026, nach Spoolman): voll, Rest in Gramm oder gewogen (Waage mit Spule − Leerspule)
  const fillCtl = `<div class="fld wide"><span>${t('fill_label')}</span><div class="fill-ctl">
      <span class="seg" id="fillseg" role="group">${['full', 'left', 'gross'].map(k => `<button type="button" data-fill="${k}" class="${k === 'full' ? 'on' : ''}" aria-pressed="${k === 'full'}">${t('fill_' + k)}</button>`).join('')}</span>
      <input class="in num" name="left" type="number" min="0" max="10000" placeholder="g" aria-label="${esc(t('f_left'))}" hidden>
      <input class="in num" name="gross" type="number" min="1" max="12000" placeholder="${esc(t('gross_ph'))}" aria-label="${esc(t('gross_ph'))}" hidden>
      <span class="hint" id="grossres"></span></div></div>`;
  dlg.innerHTML = `<form method="dialog" id="fs"${isNew && !opts.onCreated ? ' class="has-next"' : ''}>
    <div class="dlg-h"><b>${isNew ? t('add_spool') : t('edit_spool') + ' #' + s.id}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">
      <div id="pick"></div>
      <div class="fgrid" id="manual">
        <label class="fld"><span>${t('f_brand')}</span><input class="in" name="brand" maxlength="100" value="${esc(val('brand'))}"></label>
        <label class="fld"><span>${t('f_material')}</span><input class="in" name="material" list="matlist" maxlength="20" value="${esc(s ? s.material : (c.material || opts.material || 'PLA'))}"></label>
        <label class="fld"><span>${t('f_color_name')}</span><input class="in" name="color_name" maxlength="50" value="${esc(val('color_name'))}"></label>
        <label class="fld"><span>${t('f_color')}</span><input class="in" name="color" type="color" value="${esc(s ? s.color : (c.color || opts.color || '#f26a12'))}" style="padding:4px"></label>${window.ampColor2 ? ampColor2(s) : ''}
      </div>
      <datalist id="matlist">${mats.slice(0, 60).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
      <datalist id="loclist">${st.locations.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
      <div class="fgrid">
        <label class="fld"><span>${t('f_total')} (g)</span><input class="in num" name="total" type="number" min="1" max="10000" value="${esc(val('total'))}" placeholder="1000">
          <span class="wchips">${[250, 500, 750, 1000, 2000, 3000].map(w => `<button type="button" class="wchip" data-w="${w}">${w >= 1000 ? nf.format(w / 1000) + ' kg' : w + ' g'}</button>`).join('')}</span></label>
        <label class="fld"><span>${t('f_empty_spool')} (g)</span><input class="in num" name="empty_spool_g" type="number" min="0" max="2000" value="${esc(val('empty_spool_g') ?? '')}">
          <small class="fhint">${esc(t('empty_spool_hint'))}</small></label>
        <label class="fld"><span>${t('f_diameter')} (mm)</span><select class="in" name="diameter"><option>1.75</option><option${val('diameter') == 2.85 ? ' selected' : ''}>2.85</option></select></label>
        ${isNew ? fillCtl : `<label class="fld"><span>${t('f_left')} (g)</span><input class="in num" name="left" type="number" min="0" max="10000" value="${s.left}" placeholder="${esc(t('left_ph'))}"><input type="hidden" name="left_orig" value="${s.left}"></label>`}
        <label class="fld"><span>${t('f_price_spool')} (${esc(CSYM)})</span><input class="in num" name="price_spool" type="number" min="0" step="0.01" value="${esc(priceSpool)}"></label>
        <label class="fld"><span>${t('f_location')}</span><input class="in" name="location" list="loclist" maxlength="60" value="${esc(s ? s.location : (c.location ?? (st.loc && st.loc !== '-' ? st.loc : '')))}" placeholder="${esc(t('location_ph'))}"></label>
        <label class="fld"><span>${t('f_lot')}</span><input class="in" name="lot_nr" maxlength="60" value="${esc(s ? s.lot_nr : '')}"></label>
        <label class="fld"><span>${t('f_opened')}</span><input class="in" name="opened_at" type="date" max="${new Date().toLocaleDateString('sv')}" value="${esc(s && s.opened_at ? s.opened_at : '')}"></label>
        <label class="fld"><span>${t('f_dried')}</span><input class="in" name="dried_at" type="date" max="${new Date().toLocaleDateString('sv')}" value="${esc(s && s.dried_at ? s.dried_at.slice(0, 10) : '')}"></label>
        ${isNew ? `<label class="fld"><span>${t('f_qty')}</span><input class="in num" name="qty" type="number" min="1" max="50" value="1"></label>` : ''}
        <label class="fld wide"><span>${t('f_notes')}</span><textarea class="in" name="notes" rows="2" maxlength="255">${esc(s ? s.notes : '')}</textarea></label>
        ${fieldsOf('spool').map(f => fieldInput(f, s && s.custom ? s.custom[f.id] : '')).join('')}
      </div>
    </div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button>${isNew && !opts.onCreated ? `<button class="btn" value="next">${t('save_next')}</button>` : ''}<button class="btn pri" value="ok">${t('save')}</button></div></form>`;
  const form = $('#fs');
  form.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { form.total.value = b.dataset.w; form.total.dispatchEvent(new Event('input', { bubbles: true })); });
  let fill = 'full';
  const grossUpd = () => {
    const r = $('#grossres'); if (!r) return;
    const gr = +form.gross.value, em = form.empty_spool_g.value;
    r.textContent = fill !== 'gross' ? '' : gr && em !== '' ? t('weigh_result', { n: nf.format(Math.max(0, gr - +em)) }) : t('gross_need_empty');
  };
  form.querySelectorAll('[data-fill]').forEach(b => b.onclick = () => {
    fill = b.dataset.fill;
    form.querySelectorAll('[data-fill]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    form.left.hidden = fill !== 'left'; form.left.required = fill === 'left';
    form.gross.hidden = fill !== 'gross'; form.gross.required = fill === 'gross';
    form.empty_spool_g.required = fill === 'gross';   // ohne Leerspulengewicht lässt sich aus dem Wiegen nichts rechnen
    grossUpd();
    if (fill !== 'full') (fill === 'left' ? form.left : form.gross).focus();
  });
  if (isNew) form.addEventListener('input', grossUpd);
  const drawPick = () => {
    const cur = picked || linked;
    $('#manual').style.display = cur ? 'none' : '';
    if (cur) {
      $('#pick').innerHTML = `<div class="picked">${cur.colors && cur.colors.length > 1 ? cur.colors.map(c => `<span class="sw" style="background:${esc(c)}"></span>`).join('') : `<span class="sw" style="background:${esc(cur.color || '#888')};width:22px;height:22px"></span>`}
        <span class="t"><b>${esc(catName(cur))}</b><span>${[cur.weight_g && g(cur.weight_g), cur.spool_weight_g && t('spool_w', { n: cur.spool_weight_g }), cur.extruder_temp && cur.extruder_temp + ' °C'].filter(Boolean).join(' · ')}</span></span>
        <button type="button" class="btn sm" id="unpick">${t('change')}</button></div>`;
      $('#unpick').onclick = () => { picked = null; linked = null; drawPick(); };
    } else {
      $('#pick').innerHTML = `<label class="fld"><span>${t('pick_catalog')}</span><input class="in" id="cq" type="search" placeholder="${esc(t('pick_ph'))}" autocomplete="off"></label><div class="results" id="cres" hidden></div><div class="hint">${t('pick_hint')}</div>`;
      let tm, seq = 0;
      $('#cq').addEventListener('input', e => {
        clearTimeout(tm); const q = e.target.value.trim();
        if (q.length < 2) { $('#cres').hidden = true; return; }
        tm = setTimeout(async () => {
          const my = ++seq; const d = await get('catalog', { q, diameter: /2[.,]85/.test(q) ? '2.85' : '1.75' }).catch(() => null); if (!d || my !== seq) return;
          const r = $('#cres'); r.hidden = false;
          r.innerHTML = d.items.length ? d.items.slice(0, 40).map((it, i) => `<button type="button" data-i="${i}"><span class="sw" style="background:${esc(it.color || '#888')}"></span>
            <span class="t"><b>${esc(catName(it))}</b><br><span>${[it.weight_g && g(it.weight_g), dia(it.diameter), it.spool_weight_g && t('spool_w', { n: it.spool_weight_g })].filter(Boolean).join(' · ')}</span></span></button>`).join('')
            : `<div class="hint" style="padding:10px">${t('no_match')}</div>`;
          r.querySelectorAll('button').forEach(b => b.onclick = () => { picked = d.items[+b.dataset.i]; applyPick(); drawPick(); });
        }, 220);
      });
    }
  };
  const applyPick = () => {
    if (!picked) return;
    if (picked.weight_g && !form.total.value) form.total.value = picked.weight_g;
    if (picked.spool_weight_g && !form.empty_spool_g.value) form.empty_spool_g.value = picked.spool_weight_g;
    form.diameter.value = picked.diameter >= 2.5 ? '2.85' : '1.75';
  };
  if (picked) applyPick();
  drawPick();
  // „Speichern & nächste Farbe“: Katalogsuche mit Hersteller + Material vorbelegt, nur noch die Farbe wählen
  if (opts.q && $('#cq')) { $('#cq').value = opts.q; $('#cq').dispatchEvent(new Event('input')); }
  form.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  form.onsubmit = async e => {
    e.preventDefault();
    const next = e.submitter && e.submitter.value === 'next';
    const f = Object.fromEntries(new FormData(form));
    const body = { ...f, id: s ? s.id : 0, custom: fieldValues(form, fieldsOf('spool')) };
    Object.keys(body).forEach(k => { if (k.startsWith('cf_')) delete body[k]; });
    delete body.gross;
    if (picked) body.fm_filament_id = picked.id;
    else if (linked) body.fm_filament_id = linked.id;
    else if (s && s.fm_filament_id) body.unlink = 1;
    if (isNew && fill === 'gross') body.left = Math.max(0, (+f.gross || 0) - (+f.empty_spool_g || 0));
    else if (isNew && (fill === 'full' || f.left === '')) body.left = null;
    const cat = picked || linked;
    try {
      const d = await api('spool_save', body);
      dlg.close();
      if (opts.onCreated && d.ids) { await opts.onCreated(d.ids); return; }
      await loadSpools();
      toast(isNew && d.ids && d.ids.length > 1 ? t('added_n', { n: d.ids.length }) : t('saved'));
      if (next) {
        if (lastView === 'spools') viewSpools();
        const copy = { brand: cat ? cat.vendor : f.brand, material: cat ? cat.material : f.material, total: f.total, empty_spool_g: f.empty_spool_g,
          diameter: f.diameter, location: f.location, price_spool: f.price_spool };
        editSpool(null, null, { copy, q: cat ? [cat.vendor, cat.material].filter(Boolean).join(' ') : '' });
        return;
      }
      if (s) showSpool(s.id); else if (d.ids) location.hash = 's' + d.ids[0];
      if (lastView === 'spools') viewSpools();   // nicht route(): '#s<Nr>' zählt dort als Spulenansicht, auch wenn man aus dem Katalog kam
    } catch (er) { fail(er); }
  };
  dlg.showModal();
  setTimeout(() => { const q = $('#cq'); if (q && isNew) q.focus(); }, 30);
}

// ── Ansicht: Katalog ───────────────────────────────────────────────────────
const cat = { q: '', vendor: '', material: '', diameter: '', page: 0, items: [], total: 0 };
async function viewCatalog() {
  const fc = await facets();
  view.innerHTML = `<h1>${t('spools_h')}</h1>${spoolTabs('catalog')}<p class="lead">${t('catalog_lead', { n: nf.format(fc.vendors.reduce((a, v) => a + +v.n, 0)), v: fc.vendors.length })}</p>
  <div class="bar">
    <input class="in grow" id="cq2" type="search" placeholder="${esc(t('pick_ph'))}" value="${esc(cat.q)}">
    <select class="in" id="cv"><option value="">${t('all_vendors')}</option>${fc.vendors.map(v => `<option value="${v.id}"${String(v.id) === cat.vendor ? ' selected' : ''}>${esc(v.name)} (${v.n})</option>`).join('')}</select>
    <select class="in" id="cm"><option value="">${t('all_materials')}</option>${fc.materials.map(m => `<option${m.material === cat.material ? ' selected' : ''}>${esc(m.material)}</option>`).join('')}</select>
    <select class="in" id="cd"><option value="">⌀ ${t('all')}</option><option${cat.diameter === '1.75' ? ' selected' : ''}>1.75</option><option${cat.diameter === '2.85' ? ' selected' : ''}>2.85</option></select>
    <button class="btn" id="own">+ ${t('own_filament')}</button>
  </div><div id="clist"><div class="loading">${t('loading')}</div></div>
  <p class="src">${t('catalog_src')}</p>`;
  let tm;
  const reload = () => { cat.page = 0; cat.items = []; loadCat(); };
  $('#cq2').addEventListener('input', e => { cat.q = e.target.value; clearTimeout(tm); tm = setTimeout(reload, 250); });
  $('#cv').addEventListener('change', e => { cat.vendor = e.target.value; reload(); });
  $('#cm').addEventListener('change', e => { cat.material = e.target.value; reload(); });
  $('#cd').addEventListener('change', e => { cat.diameter = e.target.value; reload(); });
  $('#own').addEventListener('click', ownFilament);
  loadCat();
}
async function loadCat() {
  const d = await get('catalog', { q: cat.q, vendor: cat.vendor, material: cat.material, diameter: cat.diameter, page: cat.page }).catch(fail);
  if (!d) return;
  cat.items = cat.page ? cat.items.concat(d.items) : d.items; cat.total = d.total;
  const el = $('#clist'); if (!el) return;
  el.innerHTML = cat.items.length ? `<table class="ctable"><thead><tr><th>${t('c_filament')}</th><th class="hide-m">${t('f_material')}</th><th class="r hide-m">${t('c_net')}</th><th class="r hide-m">${t('c_spool')}</th><th class="r hide-m">${t('c_temps')}</th><th></th></tr></thead><tbody>
    ${cat.items.map((it, i) => `<tr><td><div class="nm">${it.colors && it.colors.length > 1 ? `<span class="sw" style="background:linear-gradient(90deg,${it.colors.map(esc).join(',')})"></span>` : `<span class="sw" style="background:${esc(it.color || '#888')}"></span>`}
      <div><button type="button" class="lnk cname" data-f="${i}"><b>${esc(it.name)}</b></button><span>${esc(it.vendor)}${it.finish ? ' · ' + esc(it.finish) : ''}${it.in_use ? ' · ' + t('in_use_n', { n: it.in_use }) : ''}${it.mine ? ' · ' + t('own') : ''}</span></div></div></td>
      <td class="hide-m">${esc(it.material)}</td><td class="r hide-m">${it.weight_g ? g(it.weight_g) : '–'}</td><td class="r hide-m">${it.spool_weight_g ? g(it.spool_weight_g) : '–'}</td>
      <td class="r hide-m">${it.extruder_temp ? it.extruder_temp + ' / ' + (it.bed_temp ?? '–') + ' °C' : '–'}</td>
      <td class="r"><button class="btn sm" data-i="${i}">+ ${t('add_short')}</button></td></tr>`).join('')}</tbody></table>
    <div class="more"><span>${t('shown_of', { n: nf.format(cat.items.length), m: nf.format(cat.total) })}</span>${cat.items.length < cat.total ? `<button class="btn" id="cmore">${t('more')}</button>` : ''}</div>`
    : `<div class="empty">${t('no_match')}</div>`;
  el.querySelectorAll('[data-i]').forEach(b => b.onclick = () => editSpool(null, cat.items[+b.dataset.i]));
  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => filamentDialog(cat.items[+b.dataset.f]));
  const m = $('#cmore'); if (m) m.onclick = () => { cat.page++; loadCat(); };
}
function ownFilament() {
  dlg.innerHTML = `<form method="dialog" id="fo"><div class="dlg-h"><b>${t('own_filament')}</b><button type="button" class="x-btn" data-x>×</button></div>
  <div class="dlg-b"><p class="hint" style="margin:0">${t('own_hint')}</p><div class="fgrid">
    <label class="fld"><span>${t('f_brand')} *</span><input class="in" name="vendor" list="vlist" required maxlength="100"></label>
    <label class="fld"><span>${t('f_material')} *</span><input class="in" name="material" list="matlist2" required maxlength="30"></label>
    <label class="fld"><span>${t('f_color_name')} *</span><input class="in" name="name" required maxlength="120"></label>
    <label class="fld"><span>${t('f_color')}</span><input class="in" name="color" type="color" value="#f26a12" style="padding:4px"></label>
    <label class="fld"><span>${t('c_net')} (g)</span><input class="in num" name="weight_g" type="number" min="1" value="1000"></label>
    <label class="fld"><span>${t('c_spool')} (g)</span><input class="in num" name="spool_weight_g" type="number" min="0"></label>
    <label class="fld"><span>${t('f_diameter')}</span><select class="in" name="diameter"><option>1.75</option><option>2.85</option></select></label>
    <label class="fld"><span>${t('f_density')}</span><input class="in num" name="density" type="number" step="0.01" min="0.5" max="3" placeholder="1.24"></label>
    <label class="fld"><span>${t('c_nozzle')} (°C)</span><input class="in num" name="extruder_temp" type="number" min="100" max="500"></label>
    <label class="fld"><span>${t('c_bed')} (°C)</span><input class="in num" name="bed_temp" type="number" min="0" max="150"></label>
  </div></div>
  <datalist id="vlist">${st.facets.vendors.map(v => `<option value="${esc(v.name)}">`).join('')}</datalist>
  <datalist id="matlist2">${st.facets.materials.slice(0, 60).map(m => `<option value="${esc(m.material)}">`).join('')}</datalist>
  <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form>`;
  const f = $('#fo');
  f.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  f.onsubmit = async e => {
    e.preventDefault();
    try { await api('filament_save', Object.fromEntries(new FormData(f))); dlg.close(); st.facets = null; toast(t('saved')); cat.q = f.name.value; viewCatalog(); } catch (er) { fail(er); }
  };
  dlg.showModal();
}

// ── Ansicht: Verlauf ───────────────────────────────────────────────────────
// Verlauf (05.10.2026 neu): nach Tagen gruppiert, Filter nach Art + Suche, Spulenring je Zeile, „Mehr laden“
const hv = { items: [], more: false, kind: '', q: '' };
const I_PRINTER_S = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>';
function histRow(h) {
  const sp = st.spools.find(x => x.id === h.spool_id);
  const vis = sp ? ring(sp) : `<span class="sw lg" style="background:${esc(h.color_hex || '#888')}"></span>`;
  const note = histNote(h), neg = h.grams < 0;
  const time = new Date(h.created_at.replace(' ', 'T') + 'Z').toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit', ...HC });
  return `<div class="hrow">${vis}<span class="ht"><a href="#s${h.spool_id}"><b>${esc(sp ? title(sp) : h.name || '#' + h.spool_id)}</b></a>
      <span class="hs"><span class="tag k-${esc(h.kind)}">${esc(t('kind_' + h.kind))}</span>${note ? `<span class="hn">${esc(note)}</span>` : ''}${h.printer ? `<span class="hp">${I_PRINTER_S}${esc(h.printer)}</span>` : ''}</span></span>
    <span class="hg"><b class="${neg ? 'pos' : ''}">${+h.grams === 0 ? '–' : (neg ? '+' : '−') + gUse(h.grams)}</b><small>${time}${h.cost ? ' · ' + cur.format(h.cost) : ''}</small></span></div>`;
}
function drawHistory() {
  const q = hv.q.toLowerCase();
  const items = hv.items.filter(h => (!hv.kind || h.kind === hv.kind) && (!q || [h.name, h.note, h.title, h.printer, h.material].join(' ').toLowerCase().includes(q)));
  const day = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('sv');   // JJJJ-MM-TT in Ortszeit
  const today = new Date().toLocaleDateString('sv'), yest = new Date(Date.now() - 864e5).toLocaleDateString('sv');
  let html = '', cur_ = null, buf = [], tot = 0;
  const flush = () => {
    if (!cur_) return;
    const d = new Date(cur_ + 'T12:00:00');
    const lab = cur_ === today ? t('h_today') : cur_ === yest ? t('h_yesterday') : d.toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long' });
    html += `<section class="card hday"><div class="hday-h"><b>${esc(lab)}</b>${tot > 0 ? `<span>−${gUse(tot)}</span>` : ''}</div>${buf.join('')}</section>`;
  };
  for (const h of items) {
    const k = day(h.created_at);
    if (k !== cur_) { flush(); cur_ = k; buf = []; tot = 0; }
    buf.push(ampHistRow(h));
    if (h.grams > 0 && h.kind !== 'weigh' && h.kind !== 'correction') tot += h.grams;
  }
  flush();
  $('#hlist').innerHTML = html || `<div class="empty">${hv.items.length ? t('h_none_filter') : t('history_empty_all')}</div>`;
  $('#hmore').hidden = !hv.more;
}
async function viewHistory() {
  view.innerHTML = `<h1>${t('history_h')}</h1><p class="lead">${t('history_lead')}</p><div class="loading">${t('loading')}</div>`;
  const [d] = await Promise.all([get('history'), st.spools.length ? null : loadSpools()]).catch(e => { fail(e); return []; });
  if (!d) return;
  hv.items = d.items; hv.more = d.more; hv.kind = ''; hv.q = '';
  const kinds = ['print', 'queue', 'manual', 'weigh', 'correction', 'dry'].filter(k => d.items.some(h => h.kind === k));
  const s = d.sum || { g7: 0, g30: 0, n30: 0 };
  view.innerHTML = `<h1>${t('history_h')}</h1><p class="lead amp-hlead">${t('history_lead')}</p>
    <div class="hkpis"><div><span>${t('h_7d')}</span><b>${kg(s.g7)}</b></div><div><span>${t('h_30d')}</span><b>${kg(s.g30)}</b></div><div><span>${t('h_n30')}</span><b>${nf.format(s.n30)}</b></div></div>
    <div class="hbar-f"><div class="chips" id="hchips"><button type="button" class="chip on" data-k="">${t('h_all')}</button>${kinds.map(k => `<button type="button" class="chip" data-k="${k}">${esc(t('kind_' + k))}</button>`).join('')}</div>
      <input class="in" id="hq" type="search" placeholder="${esc(t('h_search_ph'))}" aria-label="${esc(t('h_search_ph'))}"></div>
    <div id="hlist"></div><div class="hmore"><button type="button" class="btn" id="hmore" hidden>${t('more')}</button></div>`;
  $('#hchips').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; hv.kind = b.dataset.k; $('#hchips').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); drawHistory(); };
  $('#hq').oninput = e => { hv.q = e.target.value.trim(); drawHistory(); };
  $('#hmore').onclick = async e => {
    e.target.disabled = true;
    try { const m = await get('history', { before: hv.items[hv.items.length - 1].id }); hv.items = hv.items.concat(m.items); hv.more = m.more; drawHistory(); }
    catch (er) { fail(er); } finally { e.target.disabled = false; }
  };
  drawHistory();
}

// ── Diagramme ──────────────────────────────────────────────────────────────

// ── Statistik mit Ringen (05.10.2026, User: „runde Statistiken wie bei den Spulen, Seite aufhübschen, mehr Infos“) ──
// Farben je Material aus der geprüften dataviz-Palette (CSS-Variablen --m-*, hell/dunkel); Farbe folgt dem Material, nie dem Rang.
// Seltene Materialien und „ohne Angabe“ teilen sich ein Grau („Andere“) — ein 9. Farbton wäre nicht unterscheidbar.
const MAT_V = { PLA: 'pla', PETG: 'petg', 'PLA+': 'plap', ABS: 'abs', TPU: 'tpu', ASA: 'asa', PA: 'pa', PC: 'pc' };
const matKey = m => MAT_V[String(m || '').toUpperCase()] ? String(m).toUpperCase() : 'other';
const matVar = k => `var(--m-${MAT_V[k] || 'other'})`;
const matLabel = k => k === 'other' ? t('mat_other') : k;
const pctRing = (p, c, inner) => `<span class="ring" style="--c:${c};--p:${Math.max(0, Math.min(100, p || 0))}"><i>${inner}</i></span>`;
const hm = s => dur(Math.round(s / 60));

/** Werte je Monat auf feste Materialschlüssel zusammenfassen (Reihenfolge = Gesamtmenge, „Andere“ zuletzt). */
function matGroups(months) {
  const out = {}, tot = {};
  for (const [ym, mats] of Object.entries(months)) {
    out[ym] = {};
    for (const [m, v] of Object.entries(mats)) { const k = matKey(m); out[ym][k] = (out[ym][k] || 0) + v; tot[k] = (tot[k] || 0) + v; }
  }
  const order = Object.keys(tot).filter(k => k !== 'other').sort((a, b) => tot[b] - tot[a]);
  if (tot.other) order.push('other');
  return { out, order, tot };
}

/** Säulen je Monat, gestapelt nach Material: schmale Säulen, 2 px Lücke zwischen Teilen, oben 4 px gerundet, Tooltip je Monat. */
function monthColumns(d, width) {
  const { out, order } = matGroups(d.months_all);
  const keys = Object.keys(out);
  const totals = keys.map(k => Object.values(out[k]).reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  // In echter Pixelbreite zeichnen (viewBox = Breite): Schrift bleibt überall gleich groß statt mit dem Diagramm zu wachsen/schrumpfen
  const W = Math.max(300, Math.round(width || 720)), narrow = W < 560, H = narrow ? 150 : 210, L = narrow ? 40 : 46, top = 22;
  const bandW = (W - L) / keys.length, bw = Math.min(24, bandW * .55);
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), stepV = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= raw);
  const yMax = Math.ceil(max / stepV) * stepV, Y = v => top + H - v / yMax * H;
  const fmtAx = v => v >= 1000 ? nf1.format(v / 1000) + ' kg' : nf.format(v) + ' g';
  let svg = `<svg viewBox="0 0 ${W} ${top + H + 30}" width="${W}" height="${top + H + 30}" role="img" aria-label="${esc(t('chart_months'))}" class="mcols">`;
  for (let v = 0; v <= yMax + 1e-9; v += stepV) svg += `<line x1="${L}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="ax">${fmtAx(v)}</text>`;
  const iMax = totals.indexOf(Math.max(...totals)), iLast = keys.length - 1;
  keys.forEach((k, i) => {
    const cx = L + bandW * i + bandW / 2, x = cx - bw / 2;
    const segs = order.filter(m => out[k][m] > 0);
    let y = Y(0);
    segs.forEach((m, si) => {
      const h = out[k][m] / yMax * H, isTop = si === segs.length - 1;
      const hh = Math.max(h - (si ? 2 : 0), 0.8);   // 2 px Oberflächenlücke zwischen den Teilen
      const y0 = y - h;
      if (isTop && hh > 4) {
        const r = 4, yt = y0 + (si ? 0 : 0);
        svg += `<path d="M${x},${yt + hh} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${yt + hh} Z" style="fill:${matVar(m)}"/>`;
      } else svg += `<rect x="${x}" y="${y0}" width="${bw}" height="${hh}" style="fill:${matVar(m)}"/>`;
      y = y0;
    });
    const [yy, mm] = k.split('-'), dt = new Date(+yy, +mm - 1, 1);
    const lab = narrow ? dt.toLocaleDateString(LANG, { month: 'narrow' }) : dt.toLocaleDateString(LANG, { month: 'short' }) + (+mm === 1 || i === 0 ? ' ' + String(yy).slice(2) : '');
    svg += `<text x="${cx}" y="${top + H + 18}" text-anchor="middle" class="ax">${esc(lab)}</text>`;
    if ((i === iMax || i === iLast) && totals[i] > 0) svg += `<text x="${cx}" y="${Y(totals[i]) - 6}" text-anchor="middle" class="val">${kg(totals[i])}</text>`;
    // Tooltip-Fläche über die ganze Spalte (größer als die Säule)
    const meta = d.months_meta[k] || { n: 0, cost: 0 };
    const mcost = (meta.cost || 0) + (meta.run || 0);   // inkl. Strom/Verschleiß (Druckkosten-Einstellung)
    const tip = `<b>${esc(dt.toLocaleDateString(LANG, { month: 'long', year: 'numeric' }))}</b><span>${kg(totals[i])}${meta.n ? ' · ' + esc(t('st_prints_n', { n: meta.n })) : ''}${mcost ? ' · ' + esc(cur.format(mcost)) : ''}</span>`
      + segs.slice().reverse().map(m => `<span class="tl"><i style="background:${matVar(m)}"></i>${esc(matLabel(m))}<em>${g(out[k][m])}</em></span>`).join('');
    svg += `<rect x="${L + bandW * i}" y="${top}" width="${bandW}" height="${H}" class="hit" data-tip="${esc(tip)}"/>`;
  });
  svg += `</svg>`;
  const legend = order.length > 1 ? `<div class="legend">${order.map(m => `<span><i style="background:${matVar(m)}"></i>${esc(matLabel(m))}</span>`).join('')}</div>` : '';
  return totals.some(v => v > 0) ? `<div class="chart">${svg}</div>${legend}` : `<p class="hint">${t('no_prints')}</p>`;
}

/** Ring-Diagramm (Teil vom Ganzen, höchstens 6 Teile + Rest): parts = [{label, color, v, extra?}], Mitte = Wert + Beschriftung. */
function donut(parts, center, centerLbl, fmtV) {
  const sum = parts.reduce((a, p) => a + p.v, 0);
  if (!sum) return `<p class="hint">${t('empty_txt')}</p>`;
  const R = 54, C = 2 * Math.PI * R, gap = parts.length > 1 ? 2.5 : 0;
  let off = 0, arcs = '';
  for (const p of parts) {
    const len = p.v / sum * C, pct = Math.round(p.v / sum * 100);
    arcs += `<circle r="${R}" cx="70" cy="70" fill="none" stroke-width="16" style="stroke:${p.color}" stroke-dasharray="${Math.max(len - gap, 0.5)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)" data-tip="${esc(`<b>${esc(p.label)}</b><span>${fmtV(p.v)} · ${pct} %${p.extra ? ' · ' + esc(p.extra) : ''}</span>`)}" class="hit-arc"/>`;
    off += len;
  }
  return `<div class="donut"><svg viewBox="0 0 140 140" role="img" aria-label="${esc(centerLbl)}">
      <circle r="${R}" cx="70" cy="70" fill="none" stroke-width="16" class="track"/>${arcs}
      <text x="70" y="68" text-anchor="middle" class="dv">${esc(center)}</text><text x="70" y="86" text-anchor="middle" class="dl">${esc(centerLbl)}</text></svg>
    <ul class="dlist">${parts.map(p => `<li><i style="background:${p.color}"></i><span>${esc(p.label)}${p.tag || ''}</span><b>${fmtV(p.v)}</b><em>${Math.round(p.v / sum * 100)} %</em></li>`).join('')}</ul></div>`;
}
/** Materialmengen auf feste Materialschlüssel zusammenfassen (≤ 6 + „Andere“). rows = [[material, menge], …] */
function matParts(rows) {
  const agg = {};
  for (const [m, v] of rows) { const k = matKey(m); agg[k] = (agg[k] || 0) + v; }
  let parts = Object.entries(agg).filter(([k]) => k !== 'other').sort((a, b) => b[1] - a[1]);
  let other = agg.other || 0;
  if (parts.length > 6) { other += parts.slice(6).reduce((a, p) => a + p[1], 0); parts = parts.slice(0, 6); }
  if (other > 0) parts.push(['other', other]);
  return parts.map(([k, v]) => ({ label: matLabel(k), color: matVar(k), v }));
}
function stockDonut(byMat, total) {
  return donut(matParts(byMat.map(b => [b.material, b.g])), kg(total), t('k_stock'), kg);
}

/** Tooltips: eine Blase für alle [data-tip] der Ansicht; Maus folgt, Antippen schaltet um. */
function tipLayer(root) {
  if (root.dataset.tips) return;   // #view bleibt über Ansichtswechsel bestehen — Handler nur einmal anhängen
  root.dataset.tips = '1';
  let tip = document.getElementById('vtip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'vtip'; tip.className = 'vtip'; tip.hidden = true; document.body.appendChild(tip); }
  const show = (el, x, y) => {
    tip.innerHTML = el.getAttribute('data-tip'); tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, x + 14)) + 'px';
    tip.style.top = Math.max(8, y - h - 12 < 8 ? y + 18 : y - h - 12) + 'px';
    root.querySelectorAll('.on-tip').forEach(e => e.classList.remove('on-tip')); el.classList.add('on-tip');
  };
  const hide = () => { tip.hidden = true; root.querySelectorAll('.on-tip').forEach(e => e.classList.remove('on-tip')); };
  root.addEventListener('mousemove', e => { const el = e.target.closest('[data-tip]'); if (el) show(el, e.clientX, e.clientY); else hide(); });
  root.addEventListener('mouseleave', hide);
  root.addEventListener('click', e => { const el = e.target.closest('[data-tip]'); if (el) { e.stopPropagation(); show(el, e.clientX, e.clientY); } else hide(); });
  window.addEventListener('scroll', hide, { passive: true });
}

// ── Ansicht: Statistik (seit 05.10.2026 für alle) ─────────────────────────
async function viewStats() {
  view.innerHTML = `<div class="loading">${t('loading')}</div>`;
  const [d] = await Promise.all([get('stats'), st.spools.length ? null : loadSpools()]).catch(e => { fail(e); return []; });
  if (!d) return;
  const s = d.stock, l = d.last30, done = l.ok + l.fail;
  const delta = l.prev_grams > 0 ? Math.round((l.grams - l.prev_grams) / l.prev_grams * 100) : null;
  const active = st.spools.filter(x => !x.archived);
  const perDay = Object.fromEntries((d.by_material || []).map(b => [String(b.material).toUpperCase(), b.per_day]));
  const reachTxt = sp => { const pd = perDay[String(sp.material).toUpperCase()]; return pd > 0.5 ? t('days', { n: nf.format(Math.floor(sp.left / pd)) }) : null; };
  const yearG = Object.values(d.months_all).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const yearN = Object.values(d.months_meta).reduce((a, m) => a + m.n, 0);
  const tile = (ring, label, value, sub) => `<div class="stile">${ring}<div class="st-t"><span>${label}</span><b>${value}</b><small>${sub}</small></div></div>`;

  // Kennzahlen: jede mit einem Ring, der einen echten Anteil zeigt
  let h = `<h1>${t('stats_h')}</h1><p class="lead">${t('stats_lead')}</p><div class="stiles">`
    + tile(pctRing(s.fill_pct, 'var(--accent)', s.fill_pct === null ? '–' : s.fill_pct + '%'), t('k_stock'), kg(s.grams), t('st_fill_s', { n: s.fill_pct ?? '–', s: s.spools }))
    + tile(pctRing(s.spools ? s.priced / s.spools * 100 : 0, 'var(--accent)', s.spools ? Math.round(s.priced / s.spools * 100) + '%' : '–'), t('k_value'), cur.format(s.value), t('st_priced', { a: s.priced, b: s.spools }))
    + tile(pctRing(done ? l.ok / done * 100 : 0, 'var(--ok)', done ? Math.round(l.ok / done * 100) + '%' : '–'), t('st_prints30'), nf.format(done), t('st_prints30_s', { ok: l.ok, fail: l.fail }))
    + tile(pctRing(s.spools ? s.low / s.spools * 100 : 0, s.low ? 'var(--warn)' : 'var(--ok)', s.low), t('k_low'), nf.format(s.low), t('k_low_s', { n: FM.low }))
    + `</div>`;
  // Verbrauch 30 Tage + Jahr als Kopfzeile der Monatsgrafik
  h += `<section class="card scard"><div class="sc-h"><h2>${t('chart_months')}</h2>
      <div class="sc-kpi"><span><b>${kg(l.grams)}</b> ${t('k_30d')}${delta !== null ? ` <em title="${esc(t('st_vs_prev'))}">${delta > 0 ? '+' : '−'}${Math.abs(delta)} %</em>` : ''}</span>
      <span>${t('st_year_sum', { kg: kg(yearG), n: nf.format(yearN), h: nf.format(d.records.hours) })}</span></div></div>
      <div id="mchart"></div><p class="hint" style="margin:8px 0 0">${t('chart_months_s', { n: d.prints })}</p></section>`;
  // Lager nach Material + gedruckte Farben
  const cmax = Math.max(...d.colors.map(c => c.g), 1);
  h += `<div class="sgrid"><section class="card scard"><h2>${t('st_stock_mat')}</h2>${stockDonut(d.by_material, s.grams)}</section>
    <section class="card scard"><h2>${t('st_colors')}</h2>${d.colors.length ? `<ul class="clist">${d.colors.map(c => `<li><i class="sw" style="background:${esc(c.hex)}"></i><span>${esc(t('fam_' + c.family))}</span><span class="cb"><b style="width:${(c.g / cmax * 100).toFixed(1)}%"></b></span><em>${kg(c.g)}</em></li>`).join('')}</ul>` : `<p class="hint">${t('no_prints')}</p>`}</section></div>`;
  // Spulen im Blick: meistgenutzt + bald leer (mit den Spulenringen)
  const spRow = (sp, right) => `<a class="srow" href="#s${sp.id}">${ring(sp)}<span class="t"><b>${esc(title(sp))}</b><span>${esc(sub(sp))}</span></span><span class="r">${right}</span></a>`;
  const top = d.top_spools.map(x => ({ x, sp: st.spools.find(y => y.id === x.id) })).filter(o => o.sp);
  const soon = active.filter(x => x.left > 0).sort((a, b) => a.left - b.left).slice(0, 5);
  h += `<div class="sgrid"><section class="card scard"><h2>${t('st_top')}</h2>${top.length ? top.map(o => spRow(o.sp, `<b>${g(o.x.g)}</b><small>${t('st_used_30')}</small>`)).join('') : `<p class="hint">${t('st_none_top')}</p>`}</section>
    <section class="card scard"><h2>${t('st_soon')}</h2>${soon.length ? soon.map(sp => { const r = reachTxt(sp); return spRow(sp, `<b>${g(sp.left)}</b><small>${r ? t('st_reach_about', { d: r }) : t('st_left')}</small>`); }).join('') : `<p class="hint">${t('empty_txt')}</p>`}</section></div>`;
  // Drucker
  if (d.printers.length) {
    const gmax = Math.max(...d.printers.map(p => p.g), 1);
    h += `<section class="card scard"><h2>${t('st_printers')}</h2><p class="hint" style="margin:-6px 0 6px">${t('st_success')}</p><div class="plist">${d.printers.map(p => `<div class="prow">
      ${pctRing(p.n ? p.ok / p.n * 100 : 0, 'var(--ok)', p.n ? Math.round(p.ok / p.n * 100) + '%' : '–')}
      <span class="t"><b>${esc(p.name)}</b><span class="hint">${esc(t('prov_' + p.provider))}</span></span>
      <span class="pm"><b>${nf.format(p.n)}</b><small>${t('st_prints')}</small></span><span class="pm"><b>${nf.format(p.hours)} h</b><small>${t('st_hours')}</small></span>
      <span class="pm wide"><b>${kg(p.g)}</b><span class="cb"><b style="width:${(p.g / gmax * 100).toFixed(1)}%"></b></span></span></div>`).join('')}</div></section>`;
  }
  // Rekorde
  const r = d.records;
  if (r.heavy || r.long) h += `<div class="stiles recs">
    ${r.heavy ? `<div class="rec"><span>${t('st_heavy')}</span><b>${kg(r.heavy.g)}</b><small>${esc(r.heavy.name)}</small></div>` : ''}
    ${r.long ? `<div class="rec"><span>${t('st_long')}</span><b>${hm(r.long.s)}</b><small>${esc(r.long.name)}</small></div>` : ''}
    ${r.avg_g ? `<div class="rec"><span>${t('st_avg')}</span><b>${g(r.avg_g)}</b><small>${t('st_avg_s')}</small></div>` : ''}
    <div class="rec"><span>${t('st_hours')}</span><b>${nf.format(r.hours)} h</b><small>${t('st_hours_s')}</small></div></div>`;
  // Reichweite je Material (Tabelle bleibt die genaue Ansicht, jetzt mit „leer etwa am“)
  const empty = days => new Date(Date.now() + days * 864e5).toLocaleDateString(LANG, { day: 'numeric', month: 'short', year: 'numeric' });
  h += `<h2>${t('reach_h')}</h2>${d.by_material.length ? `<table class="ctable"><thead><tr><th>${t('f_material')}</th><th class="r">${t('sum_spools')}</th><th class="r">${t('sum_stock')}</th><th class="r hide-m">${t('per_day')}</th><th class="r">${t('reach')}</th><th class="r hide-m">${t('st_empty_on')}</th></tr></thead><tbody>
    ${d.by_material.map(b => `<tr><td><span class="sw" style="background:${matVar(matKey(b.material))}"></span> ${esc(matName(b.material))}</td><td class="r">${b.n}</td><td class="r">${kg(b.g)}</td><td class="r hide-m">${b.per_day ? g(b.per_day) : '–'}</td>
      <td class="r">${b.days === null ? '–' : t('days', { n: nf.format(b.days) })}</td><td class="r hide-m">${b.days === null ? '–' : esc(empty(b.days))}</td></tr>`).join('')}</tbody></table><p class="hint">${t('reach_s')}</p>` : `<p class="hint">${t('empty_txt')}</p>`}`;
  view.innerHTML = h;
  const draw = () => { const el = document.getElementById('mchart'); if (el) el.innerHTML = monthColumns(d, el.clientWidth); };
  draw();
  statsRedraw = draw;
  tipLayer(view);
}
let statsRedraw = null, statsRT;
window.addEventListener('resize', () => { clearTimeout(statsRT); statsRT = setTimeout(() => { if (statsRedraw && document.getElementById('mchart')) statsRedraw(); }, 150); });

// ── Ansicht: Gemeinschaft (Vorschau auf öffentlichen Inhalt) ───────────────
/** Druckstarts je Stunde als Säulen (eine Reihe, Akzentfarbe), in Ortszeit, Tooltip je Stunde. */
function hourColumns(hoursUtc, width) {
  const off = Math.round(-new Date().getTimezoneOffset() / 60);
  const hrs = Array.from({ length: 24 }, (_, h) => hoursUtc[((h - off) % 24 + 24) % 24] || 0);
  const W = Math.max(300, Math.round(width || 720)), H = W < 560 ? 110 : 140, L = 8, top = 16, bandW = (W - L) / 24, bw = Math.min(18, bandW * .62);
  const max = Math.max(...hrs, 1), sum = hrs.reduce((a, b) => a + b, 0) || 1;
  let svg = `<svg viewBox="0 0 ${W} ${top + H + 24}" width="${W}" height="${top + H + 24}" class="mcols" role="img" aria-label="${esc(t('c_hours'))}">`;
  svg += `<line x1="${L}" x2="${W}" y1="${top + H}" y2="${top + H}" class="grid"/>`;
  hrs.forEach((v, h) => {
    const x = L + bandW * h + (bandW - bw) / 2, hh = v / max * H, y = top + H - hh;
    if (hh > 0) svg += hh > 4 ? `<path d="M${x},${top + H} V${y + 4} Q${x},${y} ${x + 4},${y} H${x + bw - 4} Q${x + bw},${y} ${x + bw},${y + 4} V${top + H} Z" style="fill:var(--accent)"/>` : `<rect x="${x}" y="${y}" width="${bw}" height="${hh}" style="fill:var(--accent)"/>`;
    if (h % (W < 560 ? 6 : 3) === 0) svg += `<text x="${x + bw / 2}" y="${top + H + 16}" text-anchor="middle" class="ax">${h}:00</text>`;
    svg += `<rect x="${L + bandW * h}" y="${top}" width="${bandW}" height="${H}" class="hit" data-tip="${esc(`<b>${h}:00–${(h + 1) % 24}:00</b><span>${t('st_prints_n', { n: nf.format(v) })} · ${Math.round(v / sum * 100)} %</span>`)}"/>`;
  });
  return svg + `</svg>`;
}

async function viewCommunity() {
  view.innerHTML = `<div class="loading">${t('loading')}</div>`;
  const d = await get('community').catch(fail); if (!d) return;
  // Nur der Admin bekommt Zeilen unter der Schwelle (markiert); für alle anderen filtert der Server sie heraus
  const pub = r => d.admin && !r.public ? ` <span class="tag" title="${esc(t('hidden_public', { n: d.min_users }))}">${t('lt_users', { n: d.min_users })}</span>` : '';
  const FAM = { black: '#1d1d1d', white: '#f2f2f2', grey: '#9a9a9a', red: '#d33a2c', orange: '#f07a1a', yellow: '#f2c230', green: '#3a9a4a', blue: '#2f6fd8', purple: '#8a4fc9', pink: '#e86aa6', brown: '#7a4e2a' };
  const T = d.totals, linkP = T.spools ? Math.round(T.linked / T.spools * 100) : 0;
  const mats = d.materials.slice(0, 12), cmax = Math.max(...d.colors.map(c => c.kg), 0.001);
  let h = `<h1>${t('comm_h')}</h1>
  <div class="stiles">
    <div class="rec"><span>${t('c_users')}</span><b>${nf.format(T.users)}</b><small>${t('c_users_s')}</small></div>
    <div class="rec"><span>${t('c_prints')}</span><b>${nf.format(T.jobs)}</b><small>${t('c_median', { n: nf.format(T.median_g) })}</small></div>
    <div class="rec"><span>${t('c_kg')}</span><b>${nf1.format(T.kg)} kg</b><small>${t('c_kg_s')}</small></div>
    <div class="stile">${pctRing(linkP, 'var(--accent)', linkP + '%')}<div class="st-t"><span>${t('c_spools')}</span><b>${nf.format(T.spools)}</b><small>${t('c_spools_s', { u: T.spool_users, l: T.linked })}</small></div></div>
  </div>`;
  // Ausbau 13.10.2026: Community-Zähler, „Du im Vergleich“ (nur die eigene Position), Erfolgsquote je Material
  const C = d.counters, M = d.me;
  if (C) h += `<div class="stiles">
    <div class="rec"><span>${t('c_hours_total')}</span><b>${nf.format(C.hours)} h</b><small>${C.hours >= 8766 ? t('c_hours_total_y', { n: nf1.format(C.hours / 8766) }) : t('c_hours_total_d', { n: nf.format(C.hours / 24) })}</small></div>
    <div class="rec"><span>${t('c_km')}</span><b>≈ ${nf.format(C.km)} km</b><small>${t('c_km_s', { n: nf.format(C.finished) })}</small></div>
    <div class="rec"><span>${t('c_multi')}</span><b>${C.multi_pct} %</b><small>${t('c_multi_s')}</small></div>
    <div class="rec"><span>${t('c_dur')}</span><b>${C.median_min != null ? dur(C.median_min) : '–'}</b><small>${M && M.median_min != null ? t('c_dur_me', { m: dur(M.median_min) }) : t('c_dur_s')}</small></div>
  </div>`;
  if (M) h += `<section class="card scard"><h2>${t('c_me_h')}</h2><div class="stiles" style="margin:0">
    <div class="stile">${pctRing(M.pct, 'var(--accent)', M.pct + '%')}<div class="st-t"><span>${t('c_me_kg')}</span><b>${nf1.format(M.kg)} kg</b><small>${M.pct >= 5 ? t('c_me_kg_s', { p: M.pct }) : t('c_me_kg_s0')}</small></div></div>
    <div class="stile">${pctRing(M.rate, 'var(--ok)', M.rate + '%')}<div class="st-t"><span>${t('c_me_rate')}</span><b>${M.rate} %</b><small>${t('c_me_rate_s', { c: C && C.rate != null ? C.rate : '–' })}</small></div></div>
    ${M.mat ? `<div class="stile">${pctRing(M.mat_share, matVar(matKey(M.mat)), M.mat_share + '%')}<div class="st-t"><span>${t('c_me_mat')}</span><b>${esc(matName(M.mat))}</b><small>${t('c_me_mat_s', { s: M.mat_share, c: M.comm_mat_share })}</small></div></div>` : ''}
  </div></section>`;
  else if (C) h += `<section class="card scard"><h2>${t('c_me_h')}</h2><p class="hint" style="margin:0">${t('c_me_none')} <a href="#connect">${t('c_me_connect')}</a></p></section>`;
  h += `<div class="sgrid">
    <section class="card scard"><h2>${t('c_by_material')}</h2>${mats.length ? (d.admin
      ? donut(mats.map(m => ({ label: matName(m.material), color: matVar(matKey(m.material)), v: m.kg * 1000, extra: t('n_users', { n: m.users }), tag: pub(m) })), nf1.format(mats.reduce((a, m) => a + m.kg, 0)) + ' kg', t('c_kg'), kg)
      : donut(matParts(mats.map(m => [m.material, m.kg * 1000])), nf1.format(mats.reduce((a, m) => a + m.kg, 0)) + ' kg', t('c_kg'), kg)) : `<p class="hint">${t('comm_empty')}</p>`}</section>
    <section class="card scard"><h2>${t('c_by_color')}</h2>${d.colors.length ? `<ul class="clist">${d.colors.map(c => `<li class="${c.public ? '' : 'dim'}"><i class="sw" style="background:${FAM[c.family]}"></i><span>${esc(t('fam_' + c.family))}${pub(c)}</span><span class="cb"><b style="width:${(c.kg / cmax * 100).toFixed(1)}%"></b></span><em>${nf1.format(c.kg)} kg</em></li>`).join('')}</ul>` : `<p class="hint">${t('comm_empty')}</p>`}</section>
  </div>`;
  // Erfolgsquote je Material neben „Wann gedruckt wird“ (allein, wenn die Stunden mangels Nutzern ausgeblendet sind)
  const SU = d.success || [];
  const succ = `<section class="card scard"><h2>${t('c_success_h')}</h2>${SU.length ? `<table class="ctable plain"><thead><tr><th>${t('f_material')}</th><th>${t('c_success_col')}</th><th class="r">${t('c_prints')}</th><th class="r hide-m">${t('c_users')}</th></tr></thead><tbody>${SU.map(s => `<tr class="${s.public ? '' : 'dim'}"><td><span class="sw" style="background:${matVar(matKey(s.material))}"></span> ${esc(s.material)}${pub(s)}</td><td><span class="rbar"><span class="cb"><b style="width:${s.rate}%;background:${matVar(matKey(s.material))}"></b></span><em>${s.rate} %</em></span></td><td class="r">${nf.format(s.jobs)}</td><td class="r hide-m">${s.users}</td></tr>`).join('')}</tbody></table>
    <p class="hint" style="margin:10px 0 0">${t('c_success_note', { r: C && C.rate != null ? C.rate : '–' })}${C && C.cancel_g ? ' ' + t('c_cancel_g', { g: nf.format(C.cancel_g) }) : ''}</p>` : `<p class="hint">${t('comm_empty')}</p>`}</section>`;
  const hrs = d.hours.length ? `<section class="card scard"><h2>${t('c_hours')}</h2><div id="hchart"></div><p class="hint" style="margin:6px 0 0">${t('c_hours_local')}</p></section>` : '';
  h += hrs ? `<div class="sgrid">${succ}${hrs}</div>` : succ;
  h += `<div class="sgrid">
    <section class="card scard"><h2>${t('c_prices')}</h2>${d.prices.length ? `<table class="ctable plain"><thead><tr><th>${t('f_material')}</th><th class="r">Ø €/kg</th>${d.admin ? `<th class="r hide-m">${t('c_range')}</th>` : ''}<th class="r">${t('c_users')}</th></tr></thead><tbody>${d.prices.map(p => `<tr class="${p.public ? '' : 'dim'}"><td><span class="sw" style="background:${matVar(matKey(p.material))}"></span> ${esc(p.material)}</td><td class="r">${eur.format(p.avg_ppk)}</td>${d.admin ? `<td class="r hide-m">${eur.format(p.min_ppk)}–${eur.format(p.max_ppk)}</td>` : ''}<td class="r">${p.users}</td></tr>`).join('')}</tbody></table>` : `<p class="hint">${t('comm_empty')}</p>`}</section>
    <section class="card scard"><h2>${t('c_printers')}</h2>${d.printers.length ? `<table class="ctable plain"><thead><tr><th>${t('c_connection')}</th><th class="r">${t('c_printers')}</th><th class="r">${t('c_users')}</th></tr></thead><tbody>${d.printers.map(p => `<tr class="${(p.users >= d.min_users) ? '' : 'dim'}"><td>${esc(t('prov_' + p.provider))}</td><td class="r">${p.n}</td><td class="r">${p.users}</td></tr>`).join('')}</tbody></table>` : `<p class="hint">${t('comm_empty')}</p>`}</section>
  </div>
  <section class="card scard"><h2>${t('c_catalog_used')}</h2>${d.catalog_used.length ? `<table class="ctable plain"><thead><tr><th>${t('c_filament')}</th><th class="r">${t('sum_spools')}</th><th class="r">${t('c_users')}</th></tr></thead><tbody>${d.catalog_used.map(c => `<tr class="${(c.users >= d.min_users) ? '' : 'dim'}"><td>${esc(c.vendor)} ${esc(c.material)} · ${esc(c.name)}</td><td class="r">${c.spools}</td><td class="r">${c.users}</td></tr>`).join('')}</tbody></table>` : `<p class="hint">${d.admin ? t('c_catalog_none') : t('comm_empty')}</p>`}</section>`;
  // Planungsnotizen für öffentliche Inhalte: nur der Admin
  if (d.admin) h += `<section class="card scard"><h2>${t('c_ideas_h')}</h2><ul style="margin:0;padding-left:18px">${['c_idea1', 'c_idea2', 'c_idea3', 'c_idea4'].map(k => `<li>${t(k)}</li>`).join('')}</ul></section>`;
  view.innerHTML = h;
  const draw = () => { const el = document.getElementById('hchart'); if (el) el.innerHTML = hourColumns(d.hours, el.clientWidth); };
  draw();
  commRedraw = draw;
  tipLayer(view);
}
let commRedraw = null, commRT;
window.addEventListener('resize', () => { clearTimeout(commRT); commRT = setTimeout(() => { if (commRedraw && document.getElementById('hchart')) commRedraw(); }, 150); });

// ── Ansicht: Drucker ───────────────────────────────────────────────────────
const ps_ok = () => !!FM.can_print;
const pv = { data: null, sub: 'overview', timer: null, busy: false };
function stopPoll() { clearInterval(pv.timer); pv.timer = null; }
const dur = m => (m >= 60 ? Math.floor(m / 60) + ' h ' : '') + String(m % 60).padStart(2, '0') + ' min';
const clockIn = m => new Date(Date.now() + m * 60000).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit', ...HC });
const ago = s => {
  if (!s) return '–';
  const sec = Math.max(0, (Date.now() - new Date(s.replace(' ', 'T') + 'Z').getTime()) / 1000);
  return sec < 60 ? t('ago_s') : sec < 3600 ? t('ago_m', { n: Math.round(sec / 60) }) : sec < 172800 ? t('ago_h', { n: Math.round(sec / 3600) }) : t('ago_d', { n: Math.round(sec / 86400) });
};
const I_PEN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const I_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const I_LOCK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const I_PRINTER = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M8 8v4h8V8M10 12v2h4v-2M6 21v-3h12v3"/></svg>';

// Druckerbild (23.10.2026), wenn weder ein eigenes Foto noch ein Bild aus der Hersteller-Cloud da ist (Bambu, Klipper, Prusa …):
// geschlossener Kasten (CoreXY: Bett fährt beim Drucken nach unten) oder offener Drucker (Portal fährt nach oben).
// Beim Drucken fährt der Kopf hin und her, das Teil wächst mit dem echten Fortschritt in der Farbe des laufenden Fachs;
// 0 % = heizt (Düse glüht), pausiert = steht, offline = grau. Zeichnung 120×120, Bewegung in app.css (.pa).
const PA_OPEN = /\b(A[12](?:\s?mini|L)?|Kobra\s?(?:2|3|4|Neo)\b|Ender|MK[34]S?|MINI\+?|Neptune|Sidewinder|Genius|Hornet|i3)\b/i;
let paSeq = 0;
function printerArt(model, o = {}) {
  const u = 'pa' + (++paSeq), open = PA_OPEN.test(model || '');
  const run = !!o.busy && !o.off, p = run ? Math.max(0, Math.min(100, +o.p || 0)) / 100 : 0;
  const col = /^#[0-9a-f]{3,8}$/i.test(o.color || '') ? o.color : 'var(--accent)';
  const heat = run && p === 0 && !o.paused;
  const h = run ? Math.max(p * (open ? 42 : 32), p > 0 ? 1.2 : 0) : 0;
  const cls = ['pa', run ? 'run' : '', o.paused ? 'paused' : '', heat ? 'heat' : '', o.off ? 'off' : ''].filter(Boolean).join(' ');
  // Phase aus der Uhr: die Karten werden alle paar Sekunden neu gezeichnet, der Kopf springt dabei nicht an den Anfang
  const dl = run ? ` style="animation-delay:-${((Date.now() / 1000) % 3.2).toFixed(2)}s"` : '';
  const ol = ' stroke="#8f97a2" stroke-width=".7"';
  const obj = (x, y) => h > 0 ? `<rect x="${x}" y="${y}" width="26" height="${h.toFixed(2)}" rx="1" fill="${col}"/><rect x="${x}" y="${y}" width="26" height="${h.toFixed(2)}" rx="1" fill="url(#${u}s)"/>` : '';
  const head = tip => `<g class="pa-head"${dl}><rect x="51" y="${tip - 15}" width="18" height="12" rx="2.6" fill="#eceff3"${ol}/>
    <rect x="54.5" y="${tip - 12}" width="11" height="2" rx="1" fill="#a3abb6"/><rect x="54.5" y="${tip - 8.5}" width="4" height="2" rx="1" fill="${col}"/>
    <path class="pa-noz" d="M57 ${tip - 3}h6l-1.6 3h-2.8z" fill="#c79c45"/>${run && p > 0 ? `<rect x="55" y="${tip - .2}" width="10" height="1.6" rx=".8" fill="${col}"/>` : ''}</g>`;
  const defs = `<defs><linearGradient id="${u}f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9ced6"/><stop offset="1" stop-color="#8b939e"/></linearGradient>
    <linearGradient id="${u}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b323c"/><stop offset="1" stop-color="#161b22"/></linearGradient>
    <linearGradient id="${u}a" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d7dbe1"/><stop offset=".5" stop-color="#f1f3f6"/><stop offset="1" stop-color="#a6adb7"/></linearGradient>
    <pattern id="${u}s" width="4" height="2.2" patternUnits="userSpaceOnUse"><rect y="1.5" width="4" height=".7" fill="#000" opacity=".16"/></pattern></defs>`;
  let body;
  if (!open) {
    const tip = 47, bed = run ? tip + h : tip + 30;   // Düse fest, Bett samt Teil fährt nach unten; ohne Druck steht das Bett unten
    body = `<rect x="22" y="110" width="12" height="4.5" rx="1.6" fill="#2a2f37"/><rect x="86" y="110" width="12" height="4.5" rx="1.6" fill="#2a2f37"/>
      <rect x="14" y="7" width="92" height="105" rx="9" fill="url(#${u}f)" stroke="#7b838e" stroke-width=".8"/>
      <rect x="22" y="18" width="76" height="86" rx="4" fill="url(#${u}g)"/><rect x="24" y="19.5" width="72" height="1.4" rx=".7" fill="#fff" opacity=".45"/>
      <path d="M31 21v81M89 21v81" stroke="#3b434e" stroke-width="2"/><rect x="25" y="${tip - 12}" width="70" height="3" rx="1.5" fill="#58616d"/>
      <rect x="32" y="${bed}" width="56" height="2.6" fill="#b8914f"/><rect x="32" y="${bed + 2.6}" width="56" height="3" fill="#434b57"/><rect x="28" y="${bed + 3.6}" width="64" height="2" rx="1" fill="#2f3640"/>
      ${obj(47, tip)}${head(tip)}
      <path d="M22 18h34L22 66z" fill="#fff" opacity=".07"/><path d="M64 18h10L22 92v-14z" fill="#fff" opacity=".04"/>
      <rect x="100.2" y="50" width="2.2" height="22" rx="1.1" fill="#6f7782"/><rect x="72" y="9.5" width="22" height="6" rx="1.5" fill="#161b22"/><rect x="74" y="11" width="7" height="3" rx=".6" fill="${col}" opacity=".9"/>`;
  } else {
    const tip = 86, lift = run ? h : 30;   // Bett fest, Portal mit Kopf fährt nach oben; ohne Druck parkt es oben
    body = `<rect x="16" y="108" width="12" height="4" rx="1.5" fill="#2a2f37"/><rect x="92" y="108" width="12" height="4" rx="1.5" fill="#2a2f37"/>
      <rect x="12" y="95" width="96" height="14" rx="3" fill="#2a2f37" stroke="#4b535e" stroke-width=".7"/><rect x="12" y="95" width="96" height="1.3" fill="#fff" opacity=".14"/>
      <rect x="87" y="98.5" width="16" height="7.5" rx="1.5" fill="#0f1318"/><rect x="89" y="100" width="6" height="4.5" rx=".6" fill="${col}" opacity=".9"/>
      <rect x="18" y="16" width="7" height="80" fill="url(#${u}a)"${ol}/><rect x="95" y="16" width="7" height="80" fill="url(#${u}a)"${ol}/><rect x="18" y="10" width="84" height="7" rx="2" fill="url(#${u}a)"${ol}/>
      <rect x="26" y="${tip}" width="68" height="2.6" fill="#b8914f"/><rect x="26" y="${tip + 2.6}" width="68" height="2.6" fill="#4a525e"/><rect x="30" y="${tip + 5.2}" width="60" height="4" fill="#3a414b"/>
      ${obj(47, tip - h)}
      <g transform="translate(0 ${(-lift).toFixed(2)})"><rect x="16" y="${tip - 13}" width="11" height="11" rx="1.5" fill="#5a626e"/><rect x="93" y="${tip - 13}" width="11" height="11" rx="1.5" fill="#5a626e"/>
        <rect x="25" y="${tip - 10}" width="70" height="4" rx="1.5" fill="#3f4651"/>${head(tip)}</g>`;
  }
  return `<svg class="${cls}" viewBox="0 0 120 120" aria-hidden="true">${defs}${body}</svg>`;
}
// Bild eines Druckers: eigenes Foto bzw. Cloud-Bild, sonst (auch wenn das Bild nicht lädt) die Zeichnung
const printerPic = (p, model) => (p.img ? `<img${p.img_own ? ' class="own"' : ''} src="${esc(p.img)}" alt="" loading="lazy" onerror="this.remove()">` : '')
  + `<span class="pc-ico pc-art">${printerArt(model ?? p.model ?? p.name, { off: p.online === false })}</span>`;
const BOX_NAME = { creality: 'CFS', bambu: 'AMS', elegoo: 'CANVAS', anycubic: 'ACE Pro', moonraker: 'ACE / MMU', prusaconnect: 'MMU' };

// Mehrfarbeinheit als Zeichnung (23.10.2026, User): AMS, ACE, CFS, CANVAS, QIDI Box … mit den Spulen in ihren Farben
// (Wicklung so dick wie der Rest), darunter ein Lämpchen je Fach. Das laufende Fach schiebt Filament nach oben;
// beim Trocknen steigt Wärme auf und das Fenster glüht; ab 40 % Feuchte ein Tropfen. Zeichnung 160×96, Bewegung in app.css (.bxa).
// Fächer → Box: je Box vier in Fachreihenfolge, die letzte Box bekommt den Rest (AMS HT = ein Fach am Ende).
function boxArt(slots, o = {}) {
  const n = Math.max(1, Math.min(8, slots.length || 4)), w = 132 / n, f = v => v.toFixed(1);
  let sp = '', leds = '', feed = '';
  for (let i = 0; i < n; i++) {
    const sl = slots[i], x = 14 + i * w, cx = x + w / 2, col = sl && sl.material && /^#[0-9a-f]{3,8}$/i.test(sl.color || '') ? sl.color : null;
    if (col) {
      const s2 = sl.spool_id ? st.spools.find(z => z.id === sl.spool_id) : null;
      const pct = Math.max(0, Math.min(1, s2 ? (+s2.pct || 0) / 100 : sl.remain_pct != null ? +sl.remain_pct / 100 : .7));
      const hw = 10 + 28 * pct, y = 50 - hw / 2;
      sp += `<rect x="${f(x + 5)}" y="46" width="${f(w - 10)}" height="8" fill="#4a525e"/>`
        + `<rect x="${f(x + 5.5)}" y="${f(y)}" width="${f(w - 11)}" height="${f(hw)}" rx="3" fill="${esc(col)}" stroke="#fff" stroke-opacity=".16" stroke-width=".7"/>`
        + `<rect x="${f(x + 5.5)}" y="${f(y)}" width="${f(w - 11)}" height="${f(hw * .28)}" rx="3" fill="#fff" opacity=".22"/>`
        + `<rect x="${f(x + 3)}" y="30" width="3" height="40" rx="1.5" fill="#9aa2ad"/><rect x="${f(x + w - 6)}" y="30" width="3" height="40" rx="1.5" fill="#9aa2ad"/>`;
      if (sl.inuse && o.run) feed = `<path class="bx-feed" d="M${f(cx)} ${f(y)}V2" stroke="${esc(col)}" stroke-width="1.8" fill="none"/>`;
    } else sp += `<rect x="${f(x + 4)}" y="31" width="${f(w - 8)}" height="38" rx="4" fill="none" stroke="#3a414b" stroke-dasharray="3 3"/>`;
    leds += `<circle cx="${f(cx)}" cy="83" r="2.2" fill="${col ? esc(col) : '#454c57'}"/>`;
  }
  const waves = o.dry ? [32, 64, 96, 128].map((x, i) => `<path class="bx-wave" style="animation-delay:${(i * .55).toFixed(2)}s" d="M${x} 14c-3.5-2.5 3.5-5 0-7.5s3.5-5 0-7.5" fill="none" stroke="#ff8a3d" stroke-width="2.4" stroke-linecap="round"/>`).join('') : '';
  const drop = o.humid && !o.dry ? `<path d="M146 17.5c-2.2 3-3.4 4.8-3.4 6.3a3.4 3.4 0 0 0 6.8 0c0-1.5-1.2-3.3-3.4-6.3z" fill="#3b82f6"/>` : '';
  return `<svg class="bxa${o.dry ? ' dry' : ''}" viewBox="0 0 160 96" aria-hidden="true"><rect x="6" y="16" width="148" height="76" rx="10" fill="#30363f" stroke="#4b535e" stroke-width=".8"/>`
    + `<rect x="6" y="16" width="148" height="10" rx="5" fill="#c9ced6"/><rect x="6" y="21" width="148" height="5" fill="#c9ced6"/><rect x="14" y="27" width="132" height="47" rx="5" fill="#161b22"/>${sp}`
    + (o.dry ? `<rect class="bx-glow" x="14" y="27" width="132" height="47" rx="5" fill="#ff7a1a"/>` : '')
    + `<path d="M14 27h40L20 74h-6z" fill="#fff" opacity=".05"/>${leds}${feed}${waves}${drop}</svg>`;
}

async function loadPrinters(force) {
  const d = await get('printers', force ? { force: 1 } : {});
  pv.data = d; st.spools = d.spools;
  return d;
}

async function viewPrinters(sub) {
  pv.sub = sub;
  if (sub === 'jobs') return viewJobs();
  const g = navGen;
  if (!pv.data) view.innerHTML = `<div class="loading">${t('loading')}</div>`;
  await loadPrinters(false);   // nach einem Ansichtswechsel: STALE → hier Schluss
  drawPrinters();
  if (pv.since === undefined) get('since').then(r => { pv.since = r.since; if (pv.since && g === navGen && !dlg.open) drawPrinters(); }).catch(() => {});
  if (pv.ask === undefined) get('mk_ask').then(r => { pv.ask = r.job; if (pv.ask && g === navGen && !dlg.open) drawPrinters(); }).catch(() => {});
  const timer = pv.timer = setInterval(async () => {
    if (g !== navGen) { clearInterval(timer); return; }   // Ansicht verlassen: Schleife beendet sich selbst
    if (document.hidden || pv.busy || dlg.open) return;
    try { await loadPrinters(false); if (!dlg.open) drawPrinters(); } catch (e) { /* nächster Versuch */ }
  }, 10000);
}

function prHead_3ds(active) {
  const tabs = [['overview', '#printers', t('pr_tab_overview')], ['jobs', '#jobs', t('pr_tab_jobs')], ['library', '#library', t('tab_library')], ['connect', '#connect', t('pr_tab_connect')]];
  return `<div class="ph-row"><div><h1>${t('pr_h')}</h1><p class="lead">${t('pr_lead')}</p></div>
    <div class="ph-acts">${ps_ok() ? `<a class="btn pri" href="#print">${t('tab_print')}</a>` : ''}</div></div>
    <div class="subtabs prtabs">${tabs.map(([k, h, l]) => `<a href="${h}" class="${active === k ? 'on' : ''}">${l}</a>`).join('')}</div>
    <details class="subdd"><summary>${(tabs.find(x => x[0] === active) || tabs[0])[2]}${I_CHEV}</summary>
      <nav class="subdd-list">${tabs.map(([k, h, l]) => `<a href="${h}" class="${active === k ? 'on' : ''}">${l}${active === k ? I_CHECK : ''}</a>`).join('')}</nav></details>`;
}

// Einstiegs-Checkliste (08.10.2026): rund 30 Konten mit Drucker, aber nur 8, bei denen je ein Druck wirklich von einer Spule
// abgezogen wurde — die übrigen blieben bei „verbunden“ stehen. Führt durch die vier Schritte bis zur automatischen Abbuchung
// und verschwindet, wenn alle erledigt sind oder der Nutzer sie ausblendet (fm_settings 'onboard'). Schritt 4 kommt vom Server.
const I_CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
// Geparkter Verbrauch: Drucke in Fächer ohne Spule zählen als 'booked', ihre Gramm warten in printer_slots.pending_used_g und
// werden beim Zuordnen nachgebucht. Der alte Hinweis zählte nur 'no_data' (keine Gramm je Fach) und sah diese Nutzer fast nie
// (13.10.2026: 9,6 kg bei 23 Nutzern ohne Spule).
const parkedG = d => (d.connections || []).flatMap(c => c.printers).filter(p => !p.locked).flatMap(p => p.slots || [])
  .filter(sl => !sl.spool_id && !sl.locked).reduce((a, sl) => a + (+sl.pending_g || 0), 0);
function onboardHtml(d) {
  const ob = d.onboard || {};
  if (ob.hidden) return '';
  const printers = d.connections.flatMap(c => c.printers);
  const slots = printers.filter(p => !p.locked).flatMap(p => p.slots || []);
  // Schritte 2 + 3 (Spulen) tragen „Optional“ (21.11.2026, Tester António: „dachte, ich muss das erledigen“ — drucken geht auch ohne Spulen)
  const done = [printers.length > 0, (st.spools || []).some(x => !x.archived), slots.some(sl => sl.spool_id), !!ob.booked];
  const n = done.filter(Boolean).length;
  if (n === done.length) return '';
  const cur = done.indexOf(false);
  // Schritte 2 und 3 in einem: Spulen aus den gemeldeten Fächern anlegen und gleich zuordnen
  const adN = adoptCount(null);
  const adBtn = adN ? `<button type="button" class="btn sm pri" data-ob="adopt">${esc(t('adopt_short', { n: adN }))}</button> ` : '';
  const act = [`<a class="btn sm pri" href="#connect">${esc(t('ob_s1_btn'))}</a>`,
    adBtn + `<button type="button" class="btn sm${adN ? '' : ' pri'}" data-ob="spool">${esc(t('ob_s2_btn'))}</button>`,
    slots.some(sl => !sl.spool_id && !sl.locked) ? adBtn + `<button type="button" class="btn sm${adN ? '' : ' pri'}" data-ob="slot">${esc(t('ob_s3_btn'))}</button>` : '',
    ''][cur];
  // Schritt 3 offen: die nicht abgebuchten Drucke (sonst eigener Hinweis über der Übersicht) gehören hierher
  const pg = parkedG(d);
  const wait = (cur === 1 || cur === 2) && pg >= 1 ? `<p class="ob-wait">${esc(t('ob_parked', { g: kg(pg) }))}</p>`
    : cur === 2 && d.unbooked && d.unbooked.n > 0 ? `<p class="ob-wait">${esc(t('ob_s3_wait', { n: nf.format(d.unbooked.n), g: gUse(d.unbooked.g) }))}</p>` : '';
  return `<section class="ob" aria-labelledby="ob-h"><div class="ob-top"><h2 id="ob-h">${esc(t('ob_h'))}</h2>
    <span class="ob-prog">${esc(t('ob_prog', { n }))}</span><span class="grow"></span><button type="button" class="lnk" data-ob="hide">${esc(t('ob_hide'))}</button></div>
    <ol class="ob-steps">${done.map((ok, i) => `<li class="${ok ? 'ok' : i === cur ? 'cur' : ''}"${i === cur ? ' aria-current="step"' : ''}><span class="ob-n">${ok ? I_CHECK : i + 1}</span>
      <div><b>${esc(t(ok ? `ob_s${i + 1}_done` : `ob_s${i + 1}`))}${!ok && (i === 1 || i === 2) ? ` <span class="ob-opt">${esc(t('ob_opt'))}</span>` : ''}</b>${ok ? '' : `<p>${esc(t(`ob_s${i + 1}_p`))}</p>`}${i === cur ? wait + act : ''}</div></li>`).join('')}</ol></section>`;
}
function bindOnboard() {
  view.querySelectorAll('[data-ob]').forEach(b => b.addEventListener('click', async () => {
    const k = b.dataset.ob;
    if (k === 'hide') {
      b.disabled = true;
      try { await api('settings_save', { k: 'onboard', v: { hidden: 1 } }); pv.data.onboard = { ...(pv.data.onboard || {}), hidden: true }; drawPrinters(); }
      catch (e) { b.disabled = false; fail(e); }
    } else if (k === 'adopt') {
      adoptDialog(null);
    } else if (k === 'spool') {
      editSpool(null, null, { onCreated: async () => { toast(t('saved')); await loadPrinters(false); drawPrinters(); } });
    } else if (k === 'slot') {
      let a = view.querySelector('.slot.needs [data-act="assign"]');
      if (!a) {   // Drucker als schmale Zeile zugeklappt (23.10.2026): den ersten mit offenem Fach aufklappen
        const hit = pv.data.connections.flatMap(c => c.printers.map(p => [c.provider, p])).find(([, p]) => !p.locked && p.slots.some(sl => sl.material && !sl.spool_id && !sl.locked));
        if (hit) { pexp.add(hit[0] + ':' + hit[1].id); drawPrinters(); a = view.querySelector('.slot.needs [data-act="assign"]'); }
      }
      if (!a) return;
      { const dd = a.closest('details'); if (dd) dd.open = true; }   // Fächerliste ist zugeklappt (20.11.2026)
      a.closest('.slot').classList.add('ob-hl');
      a.scrollIntoView({ block: 'center', behavior: 'smooth' });
      a.focus({ preventScroll: true });
    }
  }));
}

// Druckerseite frischer (23.10.2026, User „mach alles“): ein Kopf für alle Anschlüsse statt einer Leiste je Hersteller;
// was druckt, steht oben mit großer Bühne (Restzeit groß); bereite und Offline-Drucker als schmale Zeile, sobald es mindestens
// zwei Drucker sind (Klick klappt auf, gemerkt je Browser in fm_pexp); Temperaturen und Gesamtwerte als eine Zeile;
// eine Stunde nach Druckende „Fertig vor …“ mit „Foto teilen“; Fach-Aktionen im ⋯-Menü statt zweier Links je Fach.
const I_THERMO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/></svg>';
const I_DOTS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
const I_FOLD = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const PS_PROVS = ['anycubic', 'creality', 'moonraker'];   // wie PS_PROVIDERS in print_slice_lib.php
const pexp = new Set((() => { try { return JSON.parse(pref('pexp') || '[]'); } catch (e) { return []; } })());
const minsAgo = s => s ? (Date.now() - new Date(s.replace(' ', 'T') + 'Z').getTime()) / 60000 : Infinity;
// Reihenfolge: druckt → gerade fertig (bleibt eine Stunde offen) → bereit → offline → gesperrt
const pRank = p => p.locked ? 3 : p.online && (p.job || p.busy) ? 0 : doneNow(p) ? 0.5 : p.online ? 1 : 2;
// Braucht eine Entscheidung (offener Posten, abgebrochener Druck) → nie als schmale Zeile
const pUrgent = p => !p.locked && ((p.orphans || []).length > 0 || (!!p.print_error && !p.busy) || p.amp_devmode === false);
const pVia = (prov, p) => p.agent && p.agent.backend === 'cloud' ? p.agent.cloud : prov === 'moonraker' && p.agent && ['octoprint', 'prusalink', 'bambu', 'elegoo', 'creality', 'flashforge', 'anycubic'].includes(p.agent.backend) ? p.agent.backend : prov;
const pMaint = (prov, p) => ((pv.data && pv.data.maint) || []).filter(x => x.provider === prov && x.pid === String(p.id));
const doneNow = p => !p.job && p.last && p.last.status === 2 && minsAgo(p.last.end) <= 60;
// Von sich aus offene Karten (druckt, gerade fertig, Entscheidung offen) lassen sich seit 10.11.2026 auch zuklappen (Tester: „der erste
// Drucker hat keinen Pfeil“). Gemerkt in fm_pcol samt Anlass (Datei, Druck, Posten) — ändert sich der Anlass, ist die Karte wieder offen.
const pcol = new Set((() => { try { return JSON.parse(pref('pcol') || '[]'); } catch (e) { return []; } })());
const pOpenDef = p => pRank(p) < 1 || pUrgent(p);
const pSig = p => p.job ? 'j' + (p.job.name || p.job.title || '') : doneNow(p) ? 'd' + p.last.id : 'u' + (p.orphans || []).length + (p.print_error ? 'e' : '');
const pColKey = (prov, p) => prov + ':' + p.id + '#' + pSig(p);
// Offene Posten gebündelt (03.11.2026): je Fach + Material + Farbe eine Zeile statt einer je Druck (ein Nutzer hatte 84 gelbe Zeilen)
function orphGroups(p) {
  const m = new Map();
  for (const o of p.orphans || []) {
    const k = o.index + '|' + (o.material || '') + '|' + (o.color || '');
    if (!m.has(k)) {
      const sl = (p.slots || []).find(x => x.index === o.index), l = sl && sl.label != null ? sl.label : String(o.index + 1);
      m.set(k, { ids: [], n: 0, g: 0, material: o.material, color: o.color, label: l === 'Ext' ? t('slot_ext') : l });
    }
    const gr = m.get(k); gr.ids.push(o.id); gr.n++; gr.g += +o.g || 0;
  }
  return [...m.values()];
}
const slotAttrs = (p, sl) => { const label = sl.label ?? String(sl.index + 1);
  return `data-slot="${sl.slot_id}" data-pid="${esc(p.id)}" data-pname="${esc(p.name)}" data-label="${esc(label)}" data-index="${sl.index}" data-mat="${esc(sl.material || '')}" data-color="${esc(sl.color || '')}" data-pending="${sl.pending_g}" data-remain="${sl.remain_pct ?? ''}" data-busy="${p.online && (p.busy || p.job) ? 1 : ''}"`; };
const slotName = sl => sl.single ? t('active_spool') : t('slot_n', { s: (sl.label ?? String(sl.index + 1)) === 'Ext' ? t('slot_ext') : (sl.label ?? String(sl.index + 1)) });
// Druck pausiert, und die Spule im druckenden Fach ist (fast) leer, lief laut Buchung schon über 0 oder das Fach meldet kein
// Material mehr → nachfragen, ob eine neue Spule rein soll (03.11.2026). Ohne Treffer bleibt der Weg über ⋯ › „Leer – neue Spule“.
function runoutSlot(p) {
  if (!(p.online && p.job && p.job.paused)) return null;
  const has = (p.slots || []).filter(sl => sl.spool_id && !sl.locked);
  const run = has.filter(sl => sl.inuse || sl.single);
  for (const sl of run.length ? run : has) {
    const sp = st.spools.find(x => x.id === sl.spool_id);
    if (sp && (sp.left <= Math.max(30, sp.total * 0.05) || sp.over > 0 || (!sl.material && !sl.single))) return sl;
  }
  return null;
}
document.addEventListener('click', e => {   // ⋯-Menü der Fächer: Klick daneben schließt
  document.querySelectorAll('details.smenu[open]').forEach(m => { if (!m.contains(e.target)) m.open = false; });
});

// „Seit deinem letzten Besuch“ (31.10.2026, since_api.php): was gelaufen ist, darunter gesammelt, was offen ist. Nur hier in der App,
// nie als Mail (keine Verbrauchsdaten in Nachrichten). Die offenen Punkte kommen aus a=printers, der Zeitraum vom Server.
function sinceHtml(d) {
  const s = pv.since;
  if (!s) return '';
  const orph = d.connections.flatMap(c => c.printers).reduce((a, p) => a + (p.locked ? 0 : orphGroups(p).length), 0);
  const act = (d.spools || []).filter(x => !x.archived);
  const dry = act.filter(x => x.dry && x.dry.due).length, maint = (d.maint || []).filter(m => m.state === 'due').length;
  const low = act.filter(x => x.slots.length && (isLow(x) || (x.fc && x.fc.days <= 7))).length;
  const q = [orph && `<button type="button" class="since-q" data-sinceo>${esc(t('since_q_orphan', { n: orph }))}</button>`,
    dry && `<a class="since-q" href="#spools">${esc(t('since_q_dry', { n: dry }))}</a>`, maint && `<a class="since-q" href="#maint">${esc(t('since_q_maint', { n: maint }))}</a>`,
    low && `<a class="since-q" href="#spools">${esc(t('since_q_low', { n: low }))}</a>`].filter(Boolean);
  return `<section class="note since"><div class="since-h"><b>${esc(t('since_h'))}</b><small>${esc(dtime(s.from))}</small><button type="button" class="x-btn" data-sincex aria-label="${esc(t('close'))}">×</button></div>
    <div class="since-n"><span><b>${nf.format(s.done)}</b>${esc(t('since_done'))}</span>${s.failed ? `<span><b>${nf.format(s.failed)}</b>${esc(t('since_fail'))}</span>` : ''}${s.g >= 1 ? `<span><b>${kg(s.g)}</b>${esc(t('since_g'))}</span>` : ''}</div>
    ${q.length ? `<div class="since-l">${q.join('')}</div>` : ''}</section>`;
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-sincex]')) { pv.since = null; e.target.closest('.since').remove(); api('since_dismiss', {}).catch(() => {}); }
  else if (e.target.closest('[data-sinceo]')) { const n = view.querySelector('.note.orphan'); if (n) n.scrollIntoView({ block: 'center' }); }
});

function drawPrinters() {
  const d = pv.data;
  const y = window.scrollY;
  if (!d.connections.length) {
    // Noch nichts verbunden: die Checkliste ersetzt den leeren Kasten (gleicher Knopf), ausgeblendet bleibt der alte Hinweis
    const ob = onboardHtml(d);
    view.innerHTML = prHead('overview') + ampCardHtml() + (ob || `<div class="empty"><b>${t('pr_none_h')}</b>${t('pr_none_txt')}<br><br><a class="btn pri" href="#connect">${t('pr_connect')}</a></div>`);
    bindOnboard(); bindAmpCard();
    return;
  }
  let html = prHead('overview') + ampCardHtml();
  // Drucke ohne Spule im Fach liefen an der Abbuchung vorbei (08.10.2026: 1.322 von 1.503 Aufträgen) — Hinweis nur, solange ein Fach leer zugeordnet ist
  const open = d.connections.some(c => c.printers.some(p => !p.locked && p.slots.some(sl => sl.material && !sl.spool_id && !sl.locked)));
  const ob = onboardHtml(d);
  const adN = adoptCount(null);
  const pg = parkedG(d);
  if (open && !ob && (pg >= 1 || (d.unbooked && d.unbooked.n > 0))) html += `<div class="note warn-note">${esc(pg >= 1 ? t('parked_note', { g: kg(pg) })
    : t('unbooked_note', { n: nf.format(d.unbooked.n), g: gUse(d.unbooked.g) }))}${adN
    ? ` <button type="button" class="btn sm pri" data-ob="adopt" style="margin-top:8px">${esc(t('adopt_short', { n: adN }))}</button>` : ''}</div>`;
  for (const prov of d.consent_missing || []) html += consentAsk(prov, d.consent_cc);
  const all = d.connections.flatMap(c => c.printers.map(p => ({ prov: c.provider, p })));
  all.sort((a, b) => pRank(a.p) - pRank(b.p));   // stabil: innerhalb einer Stufe bleibt die Reihenfolge der Anschlüsse
  // Die Frage „Foto teilen?“ oben entfällt, wenn derselbe Druck schon als „Fertig vor …“ an seiner Karte steht
  const shown = all.filter(x => doneNow(x.p)).map(x => x.p.last.id);
  html += sinceHtml(d) + ob + (pv.ask && shown.includes(pv.ask.id) ? '' : askHtml());
  const ticked = [...view.querySelectorAll('form[data-consent] input:checked')].map(i => i.closest('form').dataset.consent);
  const menu = (view.querySelector('details.smenu[open]') || {}).dataset;
  // Ein Kopf für alle Anschlüsse: Stand = ältester Abgleich, ein Knopf fragt alle ab; der Hersteller steht an der Karte
  const syncs = d.connections.map(c => c.last_sync_at).filter(Boolean).sort();
  html += `<div class="conn-bar pr-bar"><span>${t('pr_last_sync', { t: ago(syncs[0]) })}</span><span class="grow"></span>
    <button class="btn sm" data-sync>${t('pr_refresh')}</button></div>`;
  for (const c of d.connections) {
    const pn = `<b>${esc(t('prov_' + c.provider))}:</b> `;
    // Bambu sperrt unseren Server (10.11.2026): kein „neu verbinden“, sondern sagen, was los ist, und den Weg übers Heimnetz zeigen
    if (c.error) html += c.blocked ? `<div class="note warn-note">${pn}${esc(S.pc_bb_blocked || '')}${bbAlt()}</div>`
      : `<div class="note warn-note">${pn}${t('pr_sync_err')} <a href="#connect">${t('pr_manage')}</a></div>`;
    // Cloud-Login klappte, aber kein Drucker: meist anderes Konto oder LAN-Modus — gleich dazusagen (07.10.2026, Bambu-Nutzer 2389)
    if (!c.printers.length && !c.error) html += ['bambu', 'anycubic', 'creality', 'elegoo'].includes(c.provider)
      ? `<div class="empty" style="padding:20px"><b>${pn}${t('pr_no_printers')}</b>${t('pr_np_' + c.provider)}<br><br><a class="btn sm" href="#connect">${t('pr_manage')}</a></div>`
      : `<div class="empty" style="padding:20px">${pn}${t('pr_no_printers')}</div>`;
  }
  const fold = all.length >= 2;
  let colDirty = false;
  for (const { prov, p } of all) {
    // Pfeil an jeder Karte außer gesperrten; bereit/offline ist von sich aus zu (fm_pexp = aufgeklappt), der Rest offen (fm_pcol = zugeklappt)
    const k = prov + ':' + p.id, foldable = fold && pRank(p) < 3, ck = pColKey(prov, p);
    for (const x of pcol) if (x.startsWith(k + '#') && x !== ck) { pcol.delete(x); colDirty = true; }   // anderer Anlass → wieder offen
    html += foldable && (pOpenDef(p) ? pcol.has(ck) : !pexp.has(k)) ? printerMini(prov, p) : printerCard(prov, p, foldable);
  }
  if (colDirty) pref('pcol', JSON.stringify([...pcol]));
  view.innerHTML = html;
  ampPrTidy();
  camReattach();
  window.scrollTo(0, y);
  ticked.forEach(p => { const i = view.querySelector(`form[data-consent="${p}"] input`); if (i) i.checked = true; });
  if (menu && menu.k) { const m = view.querySelector(`details.smenu[data-k="${menu.k}"]`); if (m) m.open = true; }
  bindConsent(view, async () => { await loadPrinters(true); drawPrinters(); });
  bindOnboard(); bindAmpCard();
  view.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = t('loading');
    try { await loadPrinters(true); drawPrinters(); } catch (e) { fail(e); b.disabled = false; }
  });
  view.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); printerAction(b.dataset); }));
  // Auf-/Zuklappen: schmale Zeile (ganze Zeile) bzw. Pfeil an der offenen Karte
  const toggle = el => {
    const k = el.dataset.fold, ck = el.dataset.fcol;
    if (ck) { pcol.has(ck) ? pcol.delete(ck) : pcol.add(ck); pref('pcol', JSON.stringify([...pcol])); }
    else { pexp.has(k) ? pexp.delete(k) : pexp.add(k); pref('pexp', JSON.stringify([...pexp])); }
    drawPrinters();
  };
  view.querySelectorAll('[data-fold]').forEach(el => {
    const mini = el.classList.contains('pmini');   // offene Karte: nur der Pfeil klappt zu
    el.addEventListener('click', e => { if (mini ? !e.target.closest('a, [data-act]') : e.target.closest('.pc-fold')) toggle(el); });
    if (mini) el.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); toggle(el); } });
  });
  // „Drucken“ an einem Drucker: diesen in der Druckansicht vorwählen
  view.querySelectorAll('[data-pkey]').forEach(a => a.addEventListener('click', e => { e.stopPropagation(); pv.printKey = a.dataset.pkey; }));
}

/** Schmale Zeile: Bild, Name, letzter Druck bzw. laufender Druck (Prozent, Restzeit), Fachfarben, Zustand. */
// ── Live-Bild (Agent ab 0.5.13, Test nur für PC_CAM_USERS, 04.11.2026) ─────────────────────────────────────
// Der Agent holt Kamerabilder nur, solange hier jemand zusieht: jeder Abruf von printer_cam hält das 25 s wach.
// Kein Stream — alle 2 s das letzte JPEG per fetch+Blob (eingebettet in Home Assistant schickt nur fetch den Schlüssel mit).
const cam = { open: new Set(), url: {}, msg: {}, timer: null, busy: false };
function camBlock_3ds(p) {
  const pid = esc(p.id);
  // Erst erlauben (je Drucker, Bilder aus der Wohnung): vorher fragt kein Agent seine Kamera ab
  if (!p.cam_ok) return `<div class="pcam-bar"><button type="button" class="btn sm" data-act="camsetup" data-pid="${pid}" data-name="${esc(p.name)}">${I_CAM} ${esc(t('cam_setup'))}</button></div>`;
  if (!cam.open.has(p.id)) return `<div class="pcam-bar"><button type="button" class="btn sm" data-act="cam" data-pid="${pid}">${I_CAM} ${esc(t('cam_show'))}</button>${p.cam_err ? `<span class="hint">${esc(t('cam_none'))}</span>` : ''}</div>`;
  const u = cam.url[p.id];
  return `<div class="pcam" data-cam="${pid}"><div class="pcam-img">${u ? `<img src="${u}" alt="${esc(t('cam_alt', { n: p.name }))}">` : `<span class="pcam-wait">${esc(cam.msg[p.id] || t('cam_wait'))}</span>`}${u ? '<span class="pcam-live">LIVE</span>' : ''}</div>
    <div class="pcam-f"><span class="hint pcam-st">${esc(u ? t('cam_note') : '')}</span><button type="button" class="btn sm ghost" data-act="camoff" data-pid="${pid}">${esc(t('cam_off'))}</button><button type="button" class="btn sm ghost" data-act="cam" data-pid="${pid}">${esc(t('cam_hide'))}</button></div></div>`;
}
function camSetupDialog(ds) {
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('cam_allow_h'))}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b"><p>${esc(t('cam_allow_p1', { n: ds.name }))}</p><p class="hint">${esc(t('cam_allow_p2'))}</p><div id="cammsg"></div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button type="button" class="btn pri" id="camok">${esc(t('cam_allow_btn'))}</button></div>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  $('#camok').onclick = async () => {
    try {
      await api('printer_cam_ok', { printer: ds.pid, on: true });
      dlg.close(); cam.open.add(ds.pid); await loadPrinters(false); drawPrinters(); camTick();
    } catch (e) { $('#cammsg').innerHTML = `<div class="note warn-note">${esc(t('err_generic'))}</div>`; }
  };
  dlg.showModal();
}
function camDrop_3ds(pid) {
  if (cam.url[pid]) URL.revokeObjectURL(cam.url[pid]);
  delete cam.url[pid]; delete cam.msg[pid];
}
async function camTick_3ds() {
  if (!cam.timer) cam.timer = setInterval(camTick, 2000);
  if (cam.busy) return;
  // Ansicht verlassen oder zugeklappt: nichts mehr abrufen (der Agent hört dann binnen ~25 s auf)
  for (const pid of [...cam.open]) if (!view.querySelector(`[data-cam="${CSS.escape(pid)}"]`) && !view.querySelector(`[data-act="cam"][data-pid="${CSS.escape(pid)}"]`)) { cam.open.delete(pid); camDrop(pid); }
  if (!cam.open.size) { clearInterval(cam.timer); cam.timer = null; return; }
  if (document.hidden) return;
  cam.busy = true;
  try {
    for (const pid of cam.open) {
      const box = () => view.querySelector(`[data-cam="${CSS.escape(pid)}"]`);
      try {
        const r = await fetch('api.php?' + new URLSearchParams({ a: 'printer_cam', printer: pid }), { credentials: 'same-origin', headers: AUTH, cache: 'no-store' });
        embedExpired(r);
        if ((r.headers.get('Content-Type') || '').startsWith('image/')) {
          const u = URL.createObjectURL(await r.blob()), had = !!cam.url[pid];
          if (cam.url[pid]) URL.revokeObjectURL(cam.url[pid]);
          cam.url[pid] = u; delete cam.msg[pid];
          const img = box() && box().querySelector('img');
          if (img && had) img.src = u; else if (box() && !dlg.open) drawPrinters();
        } else {
          const d = await r.json().catch(() => ({}));
          if (d.error) { cam.open.delete(pid); camDrop(pid); drawPrinters(); continue; }
          const m = d.err ? t('cam_err', { m: d.err }) : t('cam_wait');
          if (m !== cam.msg[pid] || cam.url[pid]) { camDrop(pid); cam.msg[pid] = m; if (box() && !dlg.open) drawPrinters(); }
          if (d.tried && d.tried.length) console.info('Kamera versucht:', d.tried);
        }
      } catch (e) { /* nächster Versuch */ }
    }
  } finally { cam.busy = false; }
}

function printerMini(prov, p) {
  const k = prov + ':' + p.id, off = !p.online, j = !off && p.job, busy = !off && (!!p.job || !!p.busy);
  const state = off ? ['off', t('st_offline')] : j && j.paused ? ['pause', t('paused')] : busy ? ['busy', t('st_printing')] : ['idle', t('st_ready')];
  const l = p.last;
  const sub = j ? [j.title || j.name, Math.max(0, Math.min(100, j.progress || 0)) + ' %', !j.paused && j.remain_min > 0 ? t('job_left', { d: dur(j.remain_min) }) : ''].filter(Boolean).join(' · ')
    : l ? t(l.status === 3 ? 'pr_last_fail' : 'pr_last_done', { n: l.title, t: ago(l.end) })
    : [p.model && p.model !== p.name ? p.model : '', t('prov_' + pVia(prov, p))].filter(Boolean).join(' · ');
  const dots = (p.slots || []).filter(sl => sl.material && sl.color && !sl.locked)
    .map(sl => `<span class="sw" style="background:${esc(sl.color)}" title="${esc(sl.material)}"></span>`).join('');
  const nOpen = (p.slots || []).filter(sl => sl.material && !sl.spool_id && !sl.locked).length;
  const due = pMaint(prov, p).filter(x => x.state === 'due');
  const flags = ((p.orphans || []).length ? `<span class="mini-flag warn">${esc(t('orphan_h'))}</span>` : '')
    + (nOpen ? `<span class="mini-flag">${esc(t('pr_slots_open', { n: nOpen }))}</span>` : '')
    + (due.length ? `<span class="mini-flag warn" title="${esc(t('mt_card_due', { t: due.map(x => x.title).join(', ') }))}">${sdIco('wrench', 15)}</span>` : '');
  const canPrint = ps_ok() && !off && !busy && PS_PROVS.includes(prov);
  return `<section class="pcard pmini${off ? ' is-off' : ''}" data-fold="${esc(k)}"${pOpenDef(p) ? ` data-fcol="${esc(pColKey(prov, p))}"` : ''} role="button" tabindex="0" aria-expanded="false" title="${esc(t('pr_expand'))}">
    <span class="mini-pic">${printerPic(p)}</span>
    <div class="mini-t"><b>${esc(p.name)}</b><span class="hint">${esc(sub)}</span></div>
    ${dots ? `<span class="mini-dots">${dots}</span>` : ''}${flags}
    ${canPrint ? `<a class="btn sm mini-go" href="#print" data-pkey="${esc(k)}">${esc(t('tab_print'))}</a>` : ''}
    <span class="pstate ${state[0]}"><span class="dot ${state[0]}"></span>${state[1]}</span><span class="mini-chev">${I_FOLD}</span></section>`;
}

function printerCard(prov, p, foldable) {
  // Kopf (05.10.2026 aufgeräumt): Zustand als Plakette rechts, Modell · Anbindung · Firmware darunter
  const paused = p.job && p.job.paused;
  const state = !p.online ? ['off', t('st_offline')] : paused ? ['pause', t('paused')] : p.busy ? ['busy', t('st_printing')] : ['idle', t('st_ready')];
  // OctoPrint/PrusaLink laufen über den Anschluss „moonraker“ (Agent bzw. Brücke) — den echten Weg nennen
  const sub = [p.model && p.model !== p.name ? p.model : '', t('prov_' + pVia(prov, p)), p.stats && p.stats.fw ? 'Firmware ' + p.stats.fw : ''].filter(Boolean);
  // Eine Zeile statt Kacheln: Düse und Bett (Thermometer orange, solange heiß), rechts klein die Gesamtwerte
  const temps = p.temps && p.online ? [[t('m_nozzle'), p.temps.nozzle, 50], [t('m_bed'), p.temps.bed, 35]] : [];
  const life = [p.stats && p.stats.prints ? ['', nf.format(p.stats.prints) + ' ' + t('m_prints')] : null, p.stats && p.stats.hours ? [t('m_hours'), nf.format(p.stats.hours) + ' h'] : null,
    p.material_used ? [t('m_used'), p.material_used] : null].filter(Boolean);
  const pid = esc(p.id), k = esc(prov + ':' + p.id);
  let h = `<section class="pcard${p.locked ? ' locked' : ''}${p.job ? ' is-busy' : ''}"${foldable ? ` data-fold="${k}"${pOpenDef(p) ? ` data-fcol="${esc(pColKey(prov, p))}"` : ''}` : ''}>
    <div class="pc-top"><button type="button" class="pc-pic" title="${esc(t('pr_photo'))}" aria-label="${esc(t('pr_photo'))}" data-act="photo" data-prov="${esc(prov)}" data-pid="${pid}"
        data-own="${p.img_own ? 1 : ''}" data-img="${esc(p.img || '')}" data-model="${esc(p.model || p.name)}">${printerPic(p)}<span class="cam">${I_CAM}</span></button>
      <div class="pc-name"><div class="pc-n1"><b>${esc(p.name)}</b>
        <button class="icon-btn" title="${esc(t('rename'))}" aria-label="${esc(t('rename'))}" data-act="rename" data-prov="${esc(prov)}" data-pid="${pid}" data-name="${esc(p.name)}">${I_PEN}</button>${window.ampAddrBtn ? ampAddrBtn(prov, p) : ''}
        <button class="icon-btn" title="${esc(t('pr_remove'))}" aria-label="${esc(t('pr_remove'))}" data-act="remove" data-prov="${esc(prov)}" data-pid="${pid}" data-name="${esc(p.name)}">${I_TRASH}</button></div>
        <div class="pc-state">${sub.map(esc).join(' · ')}</div></div>
      <span class="pstate ${state[0]}"><span class="dot ${state[0]}"></span>${state[1]}</span>
      ${foldable ? `<button type="button" class="icon-btn pc-fold" title="${esc(t('pr_collapse'))}" aria-label="${esc(t('pr_collapse'))}" aria-expanded="true">${I_FOLD}</button>` : ''}</div>
    ${temps.length || life.length ? `<div class="pc-live">${temps.map(([n, v, hot]) => `<span class="tchip${v >= hot ? ' hot' : ''}">${I_THERMO}<small>${esc(n)}</small><b>${v} °C</b></span>`).join('')}
      <span class="grow"></span>${life.length ? `<span class="pc-life">${life.map(([n, v]) => `<span${n ? ` title="${esc(n)}"` : ''}>${esc(v)}</span>`).join(' · ')}</span>` : ''}</div>` : ''}`;
  if (p.locked) {
    return h + `<div class="note">${I_LOCK} ${t('pr_locked')}</div></section>`;
  }
  // Klipper-Agent: statt nur „Offline“ sagen, warum — Agent still (Neustart, kein Autostart) oder Klipper im Fehler
  if (p.amp_err || p.amp_devmode === false) h += ampUnreach(p);
  const ag = prov === 'moonraker' && !p.online ? p.agent : null;
  if (ag && ag.silent) h += `<div class="note warn-note">${t('ag_silent', { t: ago(ag.last_push) })}</div>`;
  else if (ag && ag.klippy === 'octoprint_allow') h += `<div class="note warn-note">${t('ag_octo_allow')}</div>`;
  else if (ag && ag.klippy && ag.klippy !== 'ready') h += `<div class="note warn-note">${t({ octoprint: 'ag_octo', prusalink: 'ag_prusa' }[ag.backend] || 'ag_klippy', { s: esc(ag.klippy), m: ag.klippy_msg ? ': ' + esc(ag.klippy_msg) : '' })}</div>`;
  if (p.print_error && !p.busy) h += `<div class="note warn-note">${t('pr_print_error', { m: esc(p.print_error) })}</div>`;
  // Wartung fällig / bald fällig (Wartungsplan, 07.10.2026)
  const mdue = pMaint(prov, p);
  if (mdue.length) {
    const due = mdue.filter(x => x.state === 'due');
    h += `<a class="note ${due.length ? 'warn-note' : ''} mnote" href="#maint">${sdIco('wrench', 16)}<span>${esc(t(due.length ? 'mt_card_due' : 'mt_card_soon', { t: (due.length ? due : mdue).map(x => x.title).join(', ') }))}</span></a>`;
  }
  if (p.cam && p.online) h += camBlock(p);
  if (p.job) {
    // Bühne: fahrender Drucker groß, Restzeit groß, Ende und Prozent daneben; Bild des Drucks (Cloud bzw. von uns geslict, 23.10.2026) vor dem Namen
    const j = p.job, ctl = (prov === 'anycubic' || prov === 'moonraker' || prov === 'prusaconnect') && !p.ro;
    const jcol = ((p.slots || []).find(s => s.inuse) || {}).color, pct = Math.max(0, Math.min(100, j.progress || 0));
    const big = j.paused ? t('paused') : j.remain_min > 0 ? t('job_left', { d: dur(j.remain_min) }) : t('st_printing');
    const info = [j.layers ? t('job_layer', { a: j.layer, b: j.layers }) : '', j.speed ? esc(j.speed) : ''].filter(Boolean).join(' · ');
    h += `<div class="job stage"><span class="job-art">${printerArt(p.model || p.name, { busy: true, paused: !!j.paused, p: pct, color: jcol })}</span><div class="job-main">
      ${j.img ? `<div class="j-head"><span class="j-thumb${j.img_render ? ' rnd' : ''}"><img src="${esc(j.img)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></span><b class="j-title">${esc(j.title || j.name)}</b></div>`
        : `<b class="j-title">${esc(j.title || j.name)}</b>`}
      <div class="jbig"><b>${esc(big)}</b>${!j.paused && j.remain_min > 0 ? `<span>${esc(t('job_done', { t: clockIn(j.remain_min) }))}</span>` : ''}<span class="jpct">${pct} %</span></div>
      <div class="prog"><i style="width:${pct}%"></i></div>
      ${info ? `<span class="hint">${info}</span>` : ''}
      ${ctl ? `<div class="actions" style="margin:6px 0 0">${pauseBtn(p, j, pid)}
        <button class="btn sm danger" data-act="cmd" data-cmd="stop" data-pid="${pid}">${t('stop')}</button></div>` : ''}
    </div></div>`;
    const ro = runoutSlot(p);
    if (ro) h += `<div class="note warn-note runout"><span class="grow">${esc(t('runout_q', { s: slotName(ro) }))}</span><button class="btn sm pri" data-act="assign" data-empty="1" ${slotAttrs(p, ro)}>${esc(t('runout_btn'))}</button></div>`;
  } else if (doneNow(p)) {
    const l = p.last;
    h += `<div class="done-now"><span class="dn-ico">${I_CHECK}</span><div><b>${esc(t('pr_done_ago', { t: ago(l.end) }))}</b><span class="hint">${esc(l.title)}</span></div>
      ${l.mk ? '' : `<button type="button" class="btn sm pri" data-mkshare="${l.id}">${I_CAM} ${esc(t('mk_share_btn'))}</button>`}</div>`;
  }
  if (window.ampCtlBlock) h += ampCtlBlock(prov, p);
  if (p.online && p.boxes && p.boxes.length) {
    const bsl = (p.slots || []).filter(sl => sl.index < 100 && sl.label !== 'Ext').sort((a, b) => a.index - b.index), nb = p.boxes.length;
    const brun = p.online && p.busy && !(p.job && p.job.paused);
    h += `<div class="boxes">` + p.boxes.map((bx, bi) => {
      const dry = bx.dry, hum = bx.humidity ?? null, humid = hum !== null && hum >= 40;
      const art = boxArt(nb === 1 ? bsl : bsl.slice(bi * 4, bi === nb - 1 ? undefined : bi * 4 + 4), { dry: !!dry, humid, run: brun });
      const name = bx.builtin ? t('box_builtin') : (p.boxes.length > 1 || prov === 'moonraker') && bx.label ? bx.label : BOX_NAME[prov] || 'ACE';
      const clim = [bx.temp > 0 ? t('box_inside', { n: bx.temp }) : '', hum !== null ? t('box_hum', { n: hum }) : ''].filter(Boolean);
      let b = `<div class="box${dry ? ' drying' : ''}${humid && !dry ? ' humid' : ''}"><div class="box-top"><span class="box-art">${art}</span><div class="box-main"><b>${esc(name)}</b>
        <span class="hint">${dry ? t('dry_active', { n: dry.target }) : clim.length ? clim.join(' · ') : t('dry_idle')}${dry && clim.length ? ' · ' + clim.join(' · ') : ''}</span></div>`;
      if (bx.control) b += dry ? `<button class="btn sm danger" data-act="cmd" data-cmd="dry_stop" data-pid="${pid}" data-box="${bx.id}">${t('dry_stop')}</button>`
                               : `<button class="btn sm" data-act="dry" data-pid="${pid}" data-box="${bx.id}">${t('dry_btn')}</button>`;
      b += `</div>`;
      if (dry) {
        const tot = Math.max(dry.duration_min || 0, dry.remain_min || 0), done = tot > 0 ? Math.round((tot - dry.remain_min) / tot * 100) : 0;
        b += `<div class="prog"><i style="width:${Math.max(2, done)}%"></i></div>${dry.remain_min > 0 ? `<span class="hint">${t('dry_left', { d: dur(dry.remain_min), t: clockIn(dry.remain_min) })}</span>` : ''}`;
      } else if (humid) b += `<span class="hint warn-t">${t('humid_warn')}</span>`;
      return b + `</div>`;
    }).join('') + `</div>`;
  }
  const adN = adoptCount(p.id);
  if (adN) h += `<div class="ad-bar"><span>${esc(t('adopt_card_p'))}</span><button type="button" class="btn sm pri" data-act="adopt" data-pid="${pid}">${esc(t('adopt_short', { n: adN }))}</button></div>`;
  if (p.slots.length) {
    h += ampTubes(prov, p) + ampSlotsWrap(p, `<div class="slots">` + p.slots.map(sl => slotCard(prov, p, sl)).join('') + `</div>`);
  } else if (p.online && (prov === 'bambu' || prov === 'creality')) {
    h += `<p class="hint">${t('no_ams')}</p>`;
  }
  // Offene Posten: Verbrauch einer nie zugeordneten Spule, die inzwischen aus dem Fach ist — zuordnen oder verwerfen
  const og = orphGroups(p);
  const oLine = o => `<div class="note orphan"><span class="sw" style="background:${esc(o.color || '#888')}"></span><span class="grow">${t(o.n > 1 ? 'orphan_grp' : 'orphan_txt', { n: nf.format(o.n), g: g(o.g), m: esc(o.material || '?'), s: esc(o.label) })}</span>
      <span class="slot-btns"><button class="btn sm pri" data-act="orphan" data-oids="${o.ids.join(',')}" data-g="${o.g}" data-mat="${esc(o.material || '')}" data-color="${esc(o.color || '')}">${t('orphan_pick')}</button>
      <button class="btn sm ghost" data-act="orphan_dismiss" data-oids="${o.ids.join(',')}">${t('orphan_dismiss')}</button></span></div>`;
  if (og.length > 3) {
    const all = og.flatMap(o => o.ids), sumG = og.reduce((a, o) => a + o.g, 0);
    h += `<details class="note orphan orph-all"><summary><span class="grow">${esc(t('orphan_sum', { n: nf.format(all.length), g: g(sumG) }))}</span><span class="btn sm">${esc(t('orphan_show'))}</span></summary>
      ${og.map(oLine).join('')}<div class="orph-f"><button class="btn sm ghost" data-act="orphan_dismiss" data-all="1" data-oids="${all.join(',')}">${esc(t('orphan_dismiss_all', { n: nf.format(all.length) }))}</button></div></details>`;
  } else h += og.map(oLine).join('');
  return h + `</section>`;
}

/** Spule von vorn (23.10.2026) statt Ring im Fach: Wicklung in der Spulenfarbe, so dick wie der Rest (mehrfarbig als Abschnitte),
 *  Nabe mit drei Löchern — dreht sich, wenn das Fach gerade druckt (.slot.run, app.css). */
function spoolFace(s) {
  const cs = s.colors && s.colors.length > 1 ? s.colors : [s.color || '#888'];
  const pct = Math.max(0, Math.min(100, +s.pct || 0)) / 100, rh = 8.5, r0 = rh + 1.2, r1 = 20, rf = Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * pct);
  const rm = (rh + rf) / 2, w = rf - rh, C = 2 * Math.PI * rm, seg = C / cs.length;
  const wind = pct > 0 ? cs.map((c, i) => `<circle cx="24" cy="24" r="${rm.toFixed(2)}" fill="none" stroke="${esc(c)}" stroke-width="${w.toFixed(2)}"${cs.length > 1
    ? ` stroke-dasharray="${seg.toFixed(2)} ${(C - seg).toFixed(2)}" stroke-dashoffset="${(-i * seg).toFixed(2)}"` : ''}/>`).join('')
    + `<circle cx="24" cy="24" r="${rf.toFixed(2)}" class="spf-ol"/>` : '';
  return `<svg class="spf" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22.5" class="spf-fl"/>${wind}
    <circle cx="24" cy="24" r="${rh}" class="spf-hub"/><circle cx="24" cy="24" r="2.6" class="spf-hole"/>
    <circle cx="24" cy="18.2" r="1.5" class="spf-hole"/><circle cx="18.98" cy="26.9" r="1.5" class="spf-hole"/><circle cx="29.02" cy="26.9" r="1.5" class="spf-hole"/></svg>`;
}

/** Ausweg bei gesperrter Bambu-Cloud: AllMyPrinters im Heimnetz (Tester-Beitrag). */
// „Tester werden“ führt auf die Beta-Seite von AllMyPrinters (18.11.2026, statt des alten 3DSEARCH-Themas feedback.php?id=40)
// 19.11.2026: zusätzlich „Am PC installieren“ (Agent ohne Warteliste), Links mit utm_source=3dsearch
const bbAlt = () => false ? `<br><small>${esc(S.pc_bb_blocked_alt)} <a href="${ampUrl('pc', 'bambu')}" target="_blank" rel="noopener">${esc(t('amp_c_pc'))}</a> · <a href="${ampUrl('beta', 'bambu')}" target="_blank" rel="noopener">${esc(S.pc_bb_blocked_cta || '')}</a></small>` : '';
// ── AllMyPrinters vorstellen (19.11.2026, User: „mehr User von /filament zu AllMyPrinters bewegen … viele wissen nicht, was das kann“):
// Karte oben in Drucker-Übersicht und Spulen (ausblendbar, localStorage fm_amp_x), Hinweis an den Sackgassen (Druckerwunsch, Bambu).
// Einstieg zuerst der Agent am PC (ohne Warteliste, solange die App im geschlossenen Test ist), dann die Android-Beta.
// „Gleiche Modellsuche wie auf 3DSEARCH“ als eigener Punkt (User). Links mit utm_source=3dsearch zum Messen.
const ampL = () => ['de', 'en', 'fr', 'es', 'it', 'nl'].includes(LANG) ? LANG : 'en';
const ampUrl = (page, c) => `https://allmyprinters.com/${ampL()}/${page}/?utm_source=3dsearch&utm_medium=filament&utm_campaign=${c}`;
const ampLinks = c => `<a href="${ampUrl('pc', c)}" target="_blank" rel="noopener">${esc(t('amp_c_pc'))}</a> · <a href="${ampUrl('beta', c)}" target="_blank" rel="noopener">${esc(t('amp_c_beta'))}</a> · <a href="${ampUrl('iphone', c)}" target="_blank" rel="noopener">${esc(t('amp_c_ios'))}</a>`;   // iPhone seit 24.11.2026 (TestFlight-Beta)
const ampHint = () => '';
const ampHintWeb = () => `<br><small>${esc(t('amp_h_req'))} ${ampLinks('amp-hint')}</small>`;
function ampCardHtml() {
  return '';   // AllMyPrinters: die Karte wirbt nur auf 3DSEARCH für die App
  try { if (localStorage.getItem('fm_amp_x')) return ''; } catch (e) {}
  const li = k => `<li>${I_CHECK}<span>${esc(t(k))}</span></li>`;
  return `<section class="ampcard" id="ampcard" aria-labelledby="ampcard-h">
    <div class="ampc-top"><h2 id="ampcard-h">${esc(t('amp_c_h'))}</h2><button type="button" class="ampc-x" data-ampx aria-label="${esc(t('amp_c_x'))}" title="${esc(t('amp_c_x'))}">×</button></div>
    <p class="ampc-lead">${esc(t('amp_c_lead'))}</p>
    <ul class="ampc-list">${li('amp_c_b1')}${li('amp_c_b2')}${li('amp_c_b3')}</ul>
    <p class="ampc-sp">${esc(t('amp_c_spools'))}</p>
    <div class="ampc-acts"><a class="btn pri" href="${ampUrl('pc', 'amp-card')}" target="_blank" rel="noopener">${esc(t('amp_c_pc'))}</a>
      <a class="btn" href="${ampUrl('beta', 'amp-card')}" target="_blank" rel="noopener">${esc(t('amp_c_beta'))}</a>
      <a class="btn" href="${ampUrl('iphone', 'amp-card')}" target="_blank" rel="noopener">${esc(t('amp_c_ios'))}</a>
      <a class="ampc-more" href="${ampUrl('features', 'amp-card')}" target="_blank" rel="noopener">${esc(t('amp_c_more'))}</a></div>
    <p class="ampc-sub">${esc(t('amp_c_pc_sub'))}</p></section>`;
}
function bindAmpCard() {
  const x = document.querySelector('#ampcard [data-ampx]');
  if (x) x.onclick = () => { try { localStorage.setItem('fm_amp_x', String(Date.now())); } catch (e) {} const c = document.getElementById('ampcard'); if (c) c.remove(); };
}

function slotCard(prov, p, sl) {
  const label = sl.label ?? String(sl.index + 1);
  // unknown: Fach da, Material meldet der Drucker nicht (Prusa MK3S + MMU3) — zuordenbar, nicht „leer“ (08.10.2026)
  const unk = !!sl.unknown && !sl.material;
  const empty = (!sl.material || !sl.color) && !unk;
  const sp = sl.spool_id ? st.spools.find(x => x.id === sl.spool_id) : null;
  const head = `<div class="slot-top"><span class="sw lg${empty || unk ? ' empty' : ''}" style="${empty || unk ? '' : 'background:' + esc(sl.color)}"></span>
    <div><b>${empty ? t(sl.single ? 'slot_unreported' : 'slot_empty') : unk ? t('slot_unreported') : esc(sl.material)}</b><span class="hint">${sl.single ? t('active_spool') : t('slot_n', { s: esc(label === 'Ext' ? t('slot_ext') : label) })}${sl.inuse ? ` · <b class="inuse">${t('slot_printing')}</b>` : ''}</span></div></div>`;
  const attrs = slotAttrs(p, sl);
  if (sl.locked) return `<div class="slot locked">${head}<span class="hint">${I_LOCK} ${t('pr_locked_slot')}</span></div>`;
  if (empty && !sp && !sl.single) return `<div class="slot empty">${head}</div>`;
  const macro = sl.single && prov === 'moonraker' && !p.ro && !(p.agent && ['octoprint', 'prusalink'].includes(p.agent.backend)) ? `<details class="macro"><summary>${t('macro_h')}</summary><p class="hint">${t('macro_p')}</p>
    <div class="cmd"><code>${esc(MACRO_CFG)}</code></div><p class="hint">${t('macro_use')}</p></details>` : '';
  if (sp) {
    // Wechseln/Herausnehmen im ⋯-Menü (23.10.2026): acht orange Links bei vier Fächern machten die Karte unruhig
    const menu = `<details class="smenu" data-k="${sl.slot_id}"><summary class="icon-btn" title="${esc(t('pr_more'))}" aria-label="${esc(t('pr_more'))}">${I_DOTS}</summary>
      <div class="smenu-l"><button type="button" data-act="assign" ${attrs}>${t('slot_change')}</button><button type="button" data-act="assign" data-empty="1" ${attrs}>${t('slot_empty_new')}</button><button type="button" class="bad" data-act="unassign" ${attrs}>${t('slot_remove')}</button></div></details>`;
    // „druckt gerade“ als eigene Zeile unter Farbpunkt, Fach und ⋯ (23.10.2026): neben dem Namen brach es am Handy um und schob den Punkt nach unten
    const headHas = `<div class="slot-top${sl.inuse ? ' s-run' : ''}"><span class="sw lg" style="background:${esc(sl.color || sp.color || '#888')}"></span><div><b>${sl.single ? t('active_spool') : t('slot_n', { s: esc(label === 'Ext' ? t('slot_ext') : label) })}</b></div>${menu}${sl.inuse ? `<b class="inuse s-run-l">${t('slot_printing')}</b>` : ''}</div>`;
    // Spule im Fach, das gerade druckt, dreht sich (23.10.2026); Ein-Spulen-Drucker ohne Fachmeldung: die aktive Spule
    const spin = p.online && p.busy && !(p.job && p.job.paused) && (sl.inuse || (sl.single && (p.slots || []).length === 1));
    return `<div class="slot has${sl.inuse ? ' printing' : ''}${spin ? ' run' : ''}">${headHas}
      <a class="slot-spool" href="#s${sp.id}">${spoolFace(sp)}<span><b>${esc(title(sp))}</b><span class="hint">${esc(sub(sp))}</span><span class="num">${g(sp.left)} · ${Math.round(+sp.pct || 0)} %</span></span></a>${sp.left < 1 ? `<div class="slot-out"><span class="hint warn-t">${esc(sp.over > 0 ? t('slot_over', { g: g(sp.over) }) : t('slot_used_up'))}</span>
        <span class="slot-btns"><button type="button" class="btn sm pri" data-act="assign" data-empty="1" ${attrs}>${t('slot_new_spool')}</button><button type="button" class="btn sm ghost" data-act="left" data-spool="${sp.id}" data-sname="${esc(title(sp))}">${t('left_btn')}</button></span></div>` : ''}${macro}</div>`;
  }
  const reports = sl.remain_pct !== null && sl.remain_pct !== undefined ? `<div class="fill"><i style="width:${+sl.remain_pct}%;background:${esc(sl.color)}"></i></div><span class="hint">${t('slot_reports', { d: BOX_NAME[prov] || '', n: sl.remain_pct })}</span>` : '';
  return `<div class="slot needs${sl.inuse ? ' printing' : ''}">${head}<span class="hint">${t('slot_unknown')}${sl.pending_g > 0 ? ' · ' + t('slot_used_since', { n: sl.pending_g }) : ''}</span>${reports}
    <button class="btn sm pri" data-act="assign" ${attrs}>${t('slot_assign')}</button>${macro}</div>`;
}

const hexRgb = h => { const m = /^#?([0-9a-f]{6})/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const colorDist = (a, b) => { const x = hexRgb(a), y = hexRgb(b); return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 999; };

async function printerAction(ds) {
  const act = ds.act;
  if (act === 'amp_addr' && window.ampAddrDialog) return ampAddrDialog(ds);
  if (act === 'rename') {
    const n = prompt(t('rename_prompt'), ds.name);
    if (n === null || !n.trim() || n.trim() === ds.name) return;
    try { await api('printer_rename', { provider: ds.prov, printer: ds.pid, name: n.trim() }); await loadPrinters(false); drawPrinters(); toast(t('saved')); } catch (e) { fail(e); }
  } else if (act === 'photo') {
    photoDialog(ds);
  } else if (act === 'camsetup') {
    camSetupDialog(ds);
  } else if (act === 'camoff') {
    if (!confirm(t('cam_off_confirm'))) return;
    cam.open.delete(ds.pid); camDrop(ds.pid);
    try { await api('printer_cam_ok', { printer: ds.pid, on: false }); await loadPrinters(false); drawPrinters(); toast(t('cam_off_done')); } catch (e) { fail(e); }
  } else if (act === 'cam') {
    if (cam.open.has(ds.pid)) { cam.open.delete(ds.pid); camDrop(ds.pid); } else { cam.open.add(ds.pid); camTick(); }
    drawPrinters();
  } else if (act === 'remove') {
    // Klipper: Agent entfernen (beendet sich beim nächsten Melden); Cloud: nur ausblenden, das Konto liefert ihn weiter (11.10.2026)
    if (!confirm(t('pr_remove_confirm', { n: ds.name }))) return;
    try { await api('printer_remove', { provider: ds.prov, printer: ds.pid }); await loadPrinters(false); drawPrinters(); toast(t('pr_removed')); } catch (e) { fail(e); }
  } else if (act === 'adopt') {
    adoptDialog(ds.pid);
  } else if (act === 'cmd') {
    askCmd(ds.cmd, ds.pid, +(ds.box || 0));
  } else if (act === 'dry') {
    dryDialog(ds.pid, +(ds.box || 0));
  } else if (act === 'assign') {
    assignDialog(ds);
  } else if (act === 'orphan') {
    orphanDialog(ds);
  } else if (act === 'orphan_dismiss') {
    const ids = String(ds.oids || ds.oid || '').split(',').map(Number).filter(Boolean);
    if (!confirm(ds.all ? t('orphan_dismiss_all_confirm', { n: nf.format(ids.length) }) : t('orphan_dismiss_confirm'))) return;
    try { await api('orphan_dismiss', { ids }); await loadPrinters(false); drawPrinters(); toast(t('saved')); } catch (e) { fail(e); }
  } else if (act === 'left') {
    leftDialog(ds, async () => { await loadPrinters(false); drawPrinters(); });
  } else if (act === 'unassign') {
    if (!confirm(t('confirm_unassign'))) return;
    try { await api('slot_unassign', { slot_id: +ds.slot }); await loadPrinters(false); drawPrinters(); toast(t('saved')); } catch (e) { fail(e); }
  }
}

// Eigenes Druckerfoto (23.10.2026): wählen = sofort hochladen (Handyfotos vorher verkleinert, mkShrink), entfernen = zurück zu Cloud-Bild/Zeichnung
function photoDialog(ds) {
  const own = !!ds.own;
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('pr_photo_h'))}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b"><div class="pp-row">${ds.img ? `<img class="${own ? 'own' : ''}" src="${esc(ds.img)}" alt="">` : `<span class="pp-art">${printerArt(ds.model)}</span>`}<p class="hint">${esc(t('pr_photo_p'))}</p></div><div id="phmsg"></div></div>
    <div class="dlg-f">${own ? `<button type="button" class="btn danger" id="phdel">${esc(t('pr_photo_del'))}</button>` : ''}
      <label class="btn pri" id="phpick">${esc(t(own ? 'pr_photo_new' : 'pr_photo_pick'))}<input type="file" accept="image/jpeg,image/png,image/webp" hidden></label></div>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const done = async msg => { dlg.close(); await loadPrinters(false); drawPrinters(); toast(t(msg)); };
  const err = k => { $('#phmsg').innerHTML = `<div class="note warn-note">${esc(t(k) !== k ? t(k) : t('err_generic'))}</div>`; };
  dlg.querySelector('#phpick input').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const pick = $('#phpick'); pick.classList.add('busy'); pick.firstChild.textContent = t('pr_photo_sending');
    const ph = await mkShrink(file), fd = new FormData();
    fd.append('a', 'printer_photo'); fd.append('provider', ds.prov); fd.append('printer', ds.pid);
    fd.append('photo', ph, ph === file ? (file.name || 'photo.jpg') : 'photo.jpg');
    const r = await postForm(fd).catch(() => ({ error: 'generic' }));
    if (r.ok) return done('pr_photo_saved');
    pick.classList.remove('busy'); pick.firstChild.textContent = t(own ? 'pr_photo_new' : 'pr_photo_pick'); e.target.value = ''; err(r.error);
  };
  if (own) $('#phdel').onclick = async () => {
    try { await api('printer_photo_del', { provider: ds.prov, printer: ds.pid }); done('pr_photo_removed'); } catch (e) { err(e.message); }
  };
  dlg.showModal();
}

// Pausieren/Fortsetzen: nach dem eigenen Befehl gesperrt, bis der Status wechselt (höchstens 90 s, wie der Server), beim
// Kobra mit Aufheizen solange der Agent heizt. 28.10.2026: Fortsetzen dauerte länger, die Seite zeigte weiter „pausiert“,
// das zweite Fortsetzen fiel mitten in den Ablauf der Firmware.
const cmdWait = {};
function pauseBtn(p, j, pid) {
  const w = cmdWait[pid];
  if (j.paused && j.heating) return `<button class="btn sm" disabled>${esc(t('resume_heating', { a: p.temps ? p.temps.nozzle : '–', b: j.heating.nozzle }))}</button>`;
  if (w && Date.now() < w.until && (w.cmd === 'resume') === !!j.paused) return `<button class="btn sm" disabled>${esc(t(w.cmd === 'resume' ? 'cmd_resuming' : 'cmd_pausing'))}</button>`;
  return j.paused ? `<button class="btn sm" data-act="cmd" data-cmd="resume" data-pid="${pid}">${t('resume')}</button>`
    : `<button class="btn sm" data-act="cmd" data-cmd="pause" data-pid="${pid}">${t('pause')}</button>`;
}

async function sendCmd(body, btn) {
  pv.busy = true; btn.disabled = true; btn.textContent = t('cmd_sending');
  try {
    await api('printer_cmd', body);
    if (body.cmd === 'pause' || body.cmd === 'resume') cmdWait[body.printer] = { cmd: body.cmd, until: Date.now() + 90000 };
    dlg.close(); toast(t('cmd_sent')); await loadPrinters(false); drawPrinters();
  }
  catch (e) { btn.disabled = false; btn.textContent = t('retry'); fail(e); }
  finally { pv.busy = false; }
}

function askCmd(cmd, pid, box) {
  const check = cmd === 'stop';
  dlg.innerHTML = `<form method="dialog" id="fc"><div class="dlg-h"><b>${t('ask_' + cmd + '_h')}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b"><p style="margin:0">${t('ask_' + cmd + '_p')}</p>${check ? `<label class="chk"><input type="checkbox" id="fcc"> ${t('ask_stop_check')}</label>` : ''}</div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn ${cmd === 'stop' || cmd === 'dry_stop' ? 'danger-fill' : 'pri'}" id="fcgo"${check ? ' disabled' : ''}>${t('go_' + cmd)}</button></div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  if (check) $('#fcc').onchange = e => { $('#fcgo').disabled = !e.target.checked; };
  $('#fc').onsubmit = e => { e.preventDefault(); sendCmd({ printer: pid, cmd, box }, $('#fcgo')); };
  dlg.showModal();
}

function dryDialog(pid, box) {
  const pre = [['PLA', 45, 4], ['TPU', 50, 6], ['PETG', 55, 6], ['ABS/ASA', 55, 8]];
  dlg.innerHTML = `<form method="dialog" id="fd"><div class="dlg-h"><b>${t('dry_h')}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b"><p style="margin:0" class="hint">${t('dry_p')}</p>
      <div class="presets">${pre.map(([m, tc, hh], i) => `<button type="button" data-t="${tc}" data-h="${hh}"${i === 0 ? ' class="on"' : ''}><b>${m}</b><span>${tc} °C · ${hh} h</span></button>`).join('')}</div>
      <div class="fgrid"><label class="fld"><span>${t('dry_temp')}</span><input class="in num" name="temp" type="number" min="35" max="55" value="45" required></label>
      <label class="fld"><span>${t('dry_hours')}</span><input class="in num" name="hours" type="number" min="1" max="24" value="4" required></label></div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn pri" id="fdgo">${t('dry_go')}</button></div></form>`;
  const f = $('#fd');
  f.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  f.querySelectorAll('.presets button').forEach(b => b.onclick = () => {
    f.querySelectorAll('.presets button').forEach(x => x.classList.toggle('on', x === b));
    f.temp.value = b.dataset.t; f.hours.value = b.dataset.h;
  });
  f.onsubmit = e => { e.preventDefault(); sendCmd({ printer: pid, cmd: 'dry_start', box, temp: +f.temp.value, hours: +f.hours.value }, $('#fdgo')); };
  dlg.showModal();
}

// Spulenauswahl mit Suchfeld (03.11.2026): wer seine Spulen mit Edding nummeriert, tippt „31“ bzw. „#31“
// (auch die Spoolman-Nummer); Text sucht in Name, Farbe, Ort. Enter bei genau einem Treffer wählt ihn.
const pickSearchHtml = n => `${n > 3 ? `<input class="in" id="faq" type="search" autocomplete="off" enterkeyhint="go" placeholder="${esc(t('assign_search_ph'))}" aria-label="${esc(t('assign_search_ph'))}">` : ''}<div id="fahit" hidden></div>`;
function pickSearch(all, item, bind, choose) {
  const fq = $('#faq');
  if (!fq) return;
  const hits = () => {
    const q = fq.value.trim().toLowerCase().replace(/^#\s*/, '');
    if (!q) return null;
    if (/^\d+$/.test(q)) return all.filter(x => String(x.s.id) === q || smNo(x.s) === q);
    return all.filter(x => [title(x.s), sub(x.s), x.s.location, x.s.color_name].join(' ').toLowerCase().includes(q));
  };
  fq.addEventListener('input', () => {
    const r = hits(), box = $('#fahit');
    $('#falist').hidden = !!r; box.hidden = !r;
    if (!r) return;
    box.innerHTML = r.length ? `<div class="results spools-pick">${r.map(item).join('')}</div>` : `<p class="hint">${t('assign_search_none')}</p>`;
    bind(box);
  });
  fq.addEventListener('keydown', e => { if (e.key !== 'Enter') return; e.preventDefault(); const r = hits(); if (r && r.length === 1) choose(r[0].s.id); });
}
function assignDialog(ds) {
  const pending = +ds.pending || 0;
  const here = sl => sl.pid === ds.pid && String(sl.index) === ds.index;
  // Wie HelixScreen (10.11.2026, Donnies Bilder): Spulen, die schon in einem ANDEREN Fach stecken, ausgegraut ans Ende ihrer
  // Gruppe — wählbar nur mit Rückfrage („umsetzen?“), damit man nicht versehentlich einem anderen Kopf die Spule wegnimmt
  const inOther = s => s.slots.some(sl => !here(sl));
  const cands = st.spools.filter(s => !s.archived || s.slots.length === 0).map(s => ({ s,
    score: (s.material.toUpperCase() === ds.mat.toUpperCase() ? 0 : 1000) + colorDist(s.color, ds.color) }))
    .filter(x => !x.s.slots.some(here))
    .sort((a, b) => inOther(a.s) - inOther(b.s) || a.score - b.score);
  // Neue Spule für eine leere (03.11.2026): leere Spulen nicht anbieten
  const pick = ds.empty === '1' ? cands.filter(x => x.s.left >= 1) : cands;
  const match = pick.filter(x => x.score < 120), other = pick.filter(x => x.score >= 120 && !x.s.archived);
  const item = x => `<button type="button" data-id="${x.s.id}"${inOther(x.s) ? ` class="sp-busy" data-busy="${esc(slotTxt(x.s.slots[0]))}"` : ''}>${ring(x.s)}<span class="t"><b><span class="sp-no">${esc(spoolNo(x.s))}</span> ${esc(title(x.s))}</b><br><span>${esc(sub(x.s))} · ${g(x.s.left)}${x.s.location ? ' · ' + esc(x.s.location) : ''}${x.s.slots.length ? ' · ' + esc(t('assign_in', { p: slotTxt(x.s.slots[0]) })) : ''}</span></span></button>`;
  // Die Spule, die gerade im Fach steckt, oben mit Haken (nicht wählbar — sie ist ja schon drin)
  const curSp = ds.empty === '1' ? null : st.spools.find(s => s.slots.some(here));
  const curHtml = curSp ? `<div><div class="fld"><span>${esc(t('assign_cur'))}</span></div><div class="results spools-pick"><div class="sp-cur">${ring(curSp)}<span class="t"><b><span class="sp-no">${esc(spoolNo(curSp))}</span> ${esc(title(curSp))}</b><br><span>${esc(sub(curSp))} · ${g(curSp.left)}${curSp.location ? ' · ' + esc(curSp.location) : ''}</span></span>`
    + `<svg class="sp-check" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m7.5 12.5 3 3 6-6.5"/></svg></div></div></div>` : '';
  // „Leer – neue Spule“ (03.11.2026): die alte wird archiviert; mitten im Druck bekommt sie am Druckende noch ihren Rest (Server: pc_book_slot)
  const empty = ds.empty === '1', mid = empty && ds.busy === '1';
  const oldSp = empty ? st.spools.find(s => s.slots.some(sl => sl.pid === ds.pid && String(sl.index) === ds.index)) : null;
  dlg.innerHTML = `<form method="dialog" id="fa"><div class="dlg-h"><b>${empty ? esc(t('assign_empty_h', { p: ds.pname, s: ds.label === 'Ext' ? t('slot_ext') : ds.label })) : t('assign_h', { p: esc(ds.pname), s: esc(ds.label) })}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b">${oldSp ? `<p class="note warn-note" style="margin:0">${esc(t(mid ? 'assign_empty_mid' : 'assign_empty_p', { s: title(oldSp) }))}</p>` : ''}
      <div class="picked"><span class="sw" style="background:${esc(ds.color || '#888')};width:22px;height:22px"></span><span class="t"><b>${esc(ds.mat || t('slot_empty'))}</b><span>${t('assign_slot_says')}</span></span></div>
      ${pending > 0 ? `<p class="hint" style="margin:0">${t('assign_pending', { n: pending })}</p>` : ''}
      <button type="button" class="btn pri" id="fanew">+ ${t('assign_new')}</button>${window.ampAsgScanBtn ? ampAsgScanBtn() : ''}
      ${pickSearchHtml(match.length + other.length)}
      <div id="falist">${curHtml}${match.length ? `<div><div class="fld"><span>${t('assign_match')}</span></div><div class="results spools-pick">${match.map(item).join('')}</div></div>` : ''}
      ${other.length ? `<div><div class="fld"><span>${t('assign_other')}</span></div><div class="results spools-pick">${other.map(item).join('')}</div></div>` : ''}
</div>
      ${!pick.length ? `<p class="hint">${t('assign_none')}</p>` : ''}
    </div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button></div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const assign = async id => {
    try { await api('slot_assign', { slot_id: +ds.slot, spool_id: id, empty_old: empty, mid_print: mid }); dlg.close(); toast(t(oldSp ? 'assigned_empty' : 'assigned'));
      if (oldSp) oldSp.archived = true;
      await loadPrinters(false); if (lastView === 'gcode') viewGcode(); else drawPrinters(); } catch (e) { fail(e); }
  };
  // Spule aus einem anderen Fach: erst fragen (auch bei Enter in der Suche)
  const pickId = id => {
    const s = st.spools.find(z => z.id === id);
    if (s && inOther(s) && !confirm(t('assign_move', { p: slotTxt(s.slots.find(sl => !here(sl))) }))) return;
    assign(id);
  };
  const bind = root => root.querySelectorAll('.spools-pick button').forEach(b => b.onclick = () => pickId(+b.dataset.id));
  bind(dlg);
  pickSearch([...match, ...other], item, bind, pickId);
  $('#fanew').onclick = () => { dlg.close(); editSpool(null, null, { material: ds.mat, color: ds.color, onCreated: ids => assign(ids[0]) }); };
  if (window.ampAsgScanWire) ampAsgScanWire(pickId, [...match, ...other].map(x => x.s.id), curSp ? curSp.id : null);
  dlg.showModal();
}

/** Rest von Hand (03.11.2026): Spule zeigt 0 g, druckte aber weiter — echten Rest eintragen (0 = wirklich leer). */
function leftDialog(ds, done) {
  dlg.innerHTML = `<form method="dialog" id="flf"><div class="dlg-h"><b>${esc(t('left_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p class="hint" style="margin:0">${esc(t('left_p', { s: ds.sname || '' }))}</p>
      <label class="fld"><span>${esc(t('left_lbl'))}</span><input class="in num" name="left" type="number" min="0" max="10000" step="1" inputmode="numeric" required autofocus></label>
      <p class="hint" style="margin:0">${esc(t('left_weigh'))}</p></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button class="btn pri">${esc(t('save'))}</button></div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  $('#flf').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn.pri'); btn.disabled = true;
    try { const d = await api('spool_left', { id: +ds.spool, left: Math.max(0, Math.round(+new FormData(e.target).get('left'))) });
      if (d.spool) replaceSpool(d.spool); dlg.close(); toast(t('saved')); if (done) await done(); }
    catch (er) { btn.disabled = false; fail(er); }
  };
  dlg.showModal();
}

// ── „Alle Fächer übernehmen“ (13.10.2026) ─────────────────────────────────
// 23 Nutzer hatten Drucker, aber keine Spule; 97 von 121 ihrer Fächer meldeten Material und Farbe schon selbst. Statt je Fach
// „Zuordnen → Neue Spule → Formular“ legt ein Dialog alle auf einmal an und ordnet sie zu (Server: slots_adopt).
const adoptable = sl => sl.slot_id && !sl.spool_id && !sl.locked && !sl.unknown && sl.material && sl.color;
// Passende freie Spule schon im Lager (gleiches Material, ähnliche Farbe — Schwelle wie assignDialog): solche Fächer zählen
// nicht für den Knopf und sind im Dialog nicht angehakt, sonst entstünden Doppel („lieber zuordnen“)
const spoolTwin = sl => (st.spools || []).find(s => !s.archived && !s.slots.length && s.material.toUpperCase() === sl.material.toUpperCase() && colorDist(s.color, sl.color) < 120);
const adoptCount = pid => adoptables(pid).filter(r => !spoolTwin(r.sl)).length;
function adoptables(pid) {
  const out = [];
  for (const c of (pv.data && pv.data.connections) || []) for (const p of c.printers) {
    if (p.locked || (pid != null && String(p.id) !== String(pid))) continue;
    for (const sl of p.slots || []) if (adoptable(sl)) out.push({ p, sl });
  }
  return out;
}
function adoptDialog(pid) {
  const rows = adoptables(pid);
  if (!rows.length) return;
  const many = new Set(rows.map(r => r.p.id)).size > 1;
  const sizes = [250, 500, 750, 1000, 2000];
  let size = 1000;
  const lbl = sl => { const l = sl.label ?? String(sl.index + 1); return l === 'Ext' ? t('slot_ext') : l; };
  // Füllstand nur von Spulen mit Chip (sku = RFID-Kennung); Fremdspulen melden 0 oder pauschal 100. „100 %“ trotz Verbrauch seit
  // dem Einlegen ist veraltet (Creality-CFS meldete 100 % bei 614 g offenem Verbrauch) → dann Größe minus Verbrauch
  const pctOf = sl => sl.sku && sl.remain_pct > 0 && !(sl.remain_pct >= 100 && sl.pending_g > 0) ? sl.remain_pct : null;
  // Rest JETZT: Chip-Füllstand, sonst volle Spule minus das, was seit dem Einlegen schon gedruckt wurde
  const leftOf = sl => { const pc = pctOf(sl); return pc !== null ? Math.round(size * pc / 100) : Math.max(0, size - Math.round(sl.pending_g || 0)); };
  dlg.innerHTML = `<form method="dialog" id="fad"><div class="dlg-h"><b>${esc(t('adopt_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">
      <p class="hint" style="margin:0">${esc(t('adopt_p'))}</p>
      <div class="fld"><span>${esc(t('adopt_size'))}</span><div class="presets ad-sizes">${sizes.map(s => `<button type="button" data-s="${s}"${s === size ? ' class="on"' : ''}><b>${s >= 1000 ? s / 1000 + ' kg' : s + ' g'}</b></button>`).join('')}</div></div>
      <div class="ad-list">${rows.map((r, i) => {
        const sl = r.sl, pc = pctOf(sl), tw = spoolTwin(sl);
        const info = [many ? r.p.name : '', sl.single ? t('active_spool') : t('slot_n', { s: lbl(sl) }),
          pc !== null ? t('adopt_chip', { n: pc }) : sl.pending_g > 0 ? t('adopt_pend', { g: gUse(sl.pending_g) }) : ''].filter(Boolean).join(' · ');
        return `<div class="ad-row${tw ? ' off' : ''}"><label class="ad-pick"><input type="checkbox"${tw ? '' : ' checked'} data-i="${i}"><span class="sw" style="background:${esc(sl.color)}"></span>
          <span class="t"><b>${esc(sl.product || sl.material)}</b><span>${esc(info)}</span>${tw ? `<span class="ad-twin">${esc(t('adopt_has', { s: tw.name }))}</span>` : ''}</span></label>
          <label class="ad-left"><input class="in num" type="number" min="0" max="10000" step="1" value="${leftOf(sl)}" data-l="${i}"${tw ? ' disabled' : ''}><small>${esc(t('adopt_left'))}</small></label></div>`;
      }).join('')}</div>
    </div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button class="btn pri" id="fadgo"></button></div></form>`;
  const f = $('#fad'), go = $('#fadgo');
  const boxes = [...f.querySelectorAll('[data-i]')], lefts = [...f.querySelectorAll('[data-l]')];
  const count = () => { const n = boxes.filter(b => b.checked).length; go.textContent = t('adopt_go', { n }); go.disabled = !n; };
  boxes.forEach(b => b.addEventListener('change', () => { lefts[+b.dataset.i].disabled = !b.checked; b.closest('.ad-row').classList.toggle('off', !b.checked); count(); }));
  lefts.forEach(l => l.addEventListener('input', () => { l.dataset.touched = '1'; }));
  f.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => {
    size = +b.dataset.s;
    f.querySelectorAll('[data-s]').forEach(x => x.classList.toggle('on', x === b));
    lefts.forEach((l, i) => { if (!l.dataset.touched) l.value = leftOf(rows[i].sl); });   // selbst eingetippte Werte bleiben
  }));
  f.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  count();
  f.onsubmit = async e => {
    e.preventDefault();
    const items = boxes.filter(b => b.checked).map(b => {
      const i = +b.dataset.i, sl = rows[i].sl, left = Math.round(+lefts[i].value);
      return { slot_id: sl.slot_id, total: Math.max(size, Number.isFinite(left) ? left : 0), left: Number.isFinite(left) ? Math.max(0, left) : size,
               product: sl.product || '', label: String(sl.label ?? sl.index + 1) };
    });
    if (!items.length) return;
    go.disabled = true;
    try {
      const d = await api('slots_adopt', { items });
      dlg.close();
      toast(t('adopted', { n: d.ids.length }));
      await loadPrinters(false); drawPrinters();
    } catch (er) { go.disabled = false; fail(er); }
  };
  dlg.showModal();
}

function orphanDialog(ds) {
  const cands = st.spools.filter(s => !s.archived).map(s => ({ s,
    score: (s.material.toUpperCase() === (ds.mat || '').toUpperCase() ? 0 : 1000) + colorDist(s.color, ds.color) })).sort((a, b) => a.score - b.score);
  const item = x => `<button type="button" data-id="${x.s.id}">${ring(x.s)}<span class="t"><b><span class="sp-no">${esc(spoolNo(x.s))}</span> ${esc(title(x.s))}</b><br><span>${esc(sub(x.s))} · ${g(x.s.left)}${x.s.location ? ' · ' + esc(x.s.location) : ''}</span></span></button>`;
  dlg.innerHTML = `<form method="dialog"><div class="dlg-h"><b>${t('orphan_h')}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('cancel'))}">×</button></div>
    <div class="dlg-b"><p class="hint" style="margin:0">${t('orphan_p', { g: g(+ds.g) })}</p>
      ${pickSearchHtml(cands.length)}
      <div id="falist">${cands.length ? `<div class="results spools-pick">${cands.map(item).join('')}</div>` : `<p class="hint">${t('assign_none')}</p>`}</div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button></div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  let busy = false;   // kein Doppelbuchen per Doppeltipp (Server prüft zusätzlich)
  const choose = async id => {
    if (busy) return; busy = true;
    const btns = dlg.querySelectorAll('.spools-pick button'); btns.forEach(x => x.disabled = true);
    try { await api('orphan_assign', { ids: String(ds.oids || ds.oid || '').split(',').map(Number).filter(Boolean), spool_id: id }); dlg.close(); toast(t('saved')); await loadPrinters(false); drawPrinters(); }
    catch (e) { fail(e); btns.forEach(x => x.disabled = false); busy = false; }
  };
  const bind = root => root.querySelectorAll('.spools-pick button').forEach(b => b.onclick = () => choose(+b.dataset.id));
  bind(dlg);
  pickSearch(cands, item, bind, choose);
  dlg.showModal();
}

// Druckaufträge (05.10.2026 neu): Kacheln, Filter + Suche, nach Monaten gruppiert, 50 je Seite mit „Mehr laden“
const jv = { items: [], more: false, f: '', q: '' };
function jobRow(j) {
  const when = j.end || j.start;
  const ms = s => new Date(s.replace(' ', 'T') + 'Z').getTime();
  const mins = j.start && j.end ? Math.round((ms(j.end) - ms(j.start)) / 60000) : 0;
  const st = j.status === 1 ? ['run', t('js_running')] : j.status === 3 ? ['fail', t('js_cancelled')] : ['ok', t('j_done')];
  const book = j.state === 'booked' ? t('js_booked') : j.state === 'before_connect' ? t('js_before') : j.state === 'no_data' ? (j.grams !== null ? t('js_no_slot') : t('js_no_data')) : '';
  const dots = j.paint.length ? j.paint.map(pi => `<i style="background:${esc(pi.color || '#999')}"${pi.g != null ? ` title="${esc(g(pi.g))}"` : ''}></i>`).join('') : '<i class="nd"></i>';
  // Kosten = Filament (gebucht oder geschätzt) + Betrieb (Strom/Verschleiß, wenn eingestellt); Aufschlüsselung im Tooltip
  const fil = j.cost !== null ? j.cost : j.cost_est, run = j.run && j.run.total !== null ? j.run.total : null;
  const sum = fil !== null && fil !== undefined || run !== null ? (fil || 0) + (run || 0) : null;
  const money = sum === null ? '' : (j.cost === null && j.cost_est ? '~' : '') + cur.format(sum);
  const mtip = [fil ? t('c_fil', { c: cur.format(fil) }) : '', j.run && j.run.energy !== null ? t('c_energy', { c: cur.format(j.run.energy), k: nf1.format(j.run.kwh) }) : '',
    j.run && j.run.wear !== null ? t('c_wear', { c: cur.format(j.run.wear) }) : ''].filter(Boolean).join(' · ');
  // Druck teilen (16.10.2026): fertige und abgebrochene Drucke; geteilt → Stand statt Knopf
  const share = FM.app ? '' : j.status === 1 ? '' : j.mk === null || j.mk === undefined
    ? `<button type="button" class="lnk mk-jbtn" data-mkshare="${j.id}">${I_CAM}<span>${esc(t('mk_share_btn'))}</span></button>`
    : `<span class="mk-jst${j.mk ? ' on' : ''}">${esc(t(j.mk ? 'mk_st_online' : 'mk_st_wait'))}</span>`;
  return `<div class="jrow"><span class="jdots">${dots}</span>
    <span class="jt"><b>${esc(j.title)}</b><span class="hs"><span class="jst ${st[0]}">${esc(st[1])}</span><span>${esc(j.printer || t('prov_' + j.provider))}</span><span>${dtime(when)}${mins > 0 ? ' · ' + dur(mins) : ''}</span></span>${share}</span>
    <span class="hg"><b>${j.grams ? gUse(j.grams) : '–'}</b><small${mtip ? ` title="${esc(mtip)}"` : ''}>${esc(money)}${book ? `<span class="jbook">${money ? ' · ' : ''}${esc(book)}</span>` : ''}</small></span></div>`;
}
function drawJobs() {
  const q = jv.q.toLowerCase();
  const want = { ok: 2, fail: 3, run: 1 }[jv.f];
  const items = jv.items.filter(j => (!jv.f || j.status === want) && (!q || [j.title, j.printer, t('prov_' + j.provider)].join(' ').toLowerCase().includes(q)));
  let html = '', cur_ = null, buf = [], n = 0, gsum = 0;
  const flush = () => { if (!cur_) return; const [y, m] = cur_.split('-');
    html += `<section class="card hday"><div class="hday-h"><b>${esc(new Date(+y, +m - 1, 1).toLocaleDateString(LANG, { month: 'long', year: 'numeric' }))}</b><span>${t('st_prints_n', { n: nf.format(n) })}${gsum ? ' · ' + kg(gsum) : ''}</span></div>${buf.join('')}</section>`; };
  for (const j of items) {
    const w = (j.end || j.start || '').slice(0, 7) || '—';
    if (w !== cur_) { flush(); cur_ = w; buf = []; n = 0; gsum = 0; }
    buf.push(jobRow(j)); n++; if (j.grams && j.state !== 'not_finished') gsum += j.grams;
  }
  flush();
  $('#jlist').innerHTML = html || `<div class="empty">${jv.items.length ? t('h_none_filter') : t('jobs_empty')}</div>`;
  $('#jmore').hidden = !jv.more;
}
async function viewJobs() {
  view.innerHTML = prHead('jobs') + `<div class="loading">${t('loading')}</div>`;
  const d = await get('jobs').catch(fail); if (!d) return;
  jv.items = d.jobs; jv.more = d.more; jv.f = ''; jv.q = '';
  const M = d.month, done = M.ok + M.fail, rate = done ? Math.round(M.ok / done * 100) : 0;
  view.innerHTML = prHead('jobs') + `<div class="skpis">
      <div class="sk-fill">${pctRing(rate, 'var(--ok)', done ? rate + '%' : '–')}<span><small>${t('j_rate')}</small><b>${done ? `${M.ok} / ${done}` : '–'}</b></span></div>
      <div><small>${t('jobs_month')}</small><b>${nf.format(done)}</b></div>
      <div><small>${t('j_used')}</small><b>${kg(M.g)}</b></div>
      ${M.cost !== null ? `<div><small>${t('j_cost')}</small><b>${cur.format(M.cost)}</b></div>` : ''}
      ${M.run !== null ? `<div title="${esc(M.kwh !== null ? nf1.format(M.kwh) + ' kWh' : '')}"><small>${t('j_run')}</small><b>${cur.format(M.run)}</b></div>` : ''}</div>
    <div class="hbar-f"><div class="chips" id="jchips"><button type="button" class="chip on" data-f="">${t('h_all')}</button>${[['ok', t('j_done')], ['fail', t('js_cancelled')], ['run', t('js_running')]].map(([k, l]) => `<button type="button" class="chip" data-f="${k}">${esc(l)}</button>`).join('')}</div>
      <input class="in" id="jq" type="search" placeholder="${esc(t('j_search_ph'))}" aria-label="${esc(t('j_search_ph'))}"></div>
    <div id="jlist"></div><div class="hmore"><button type="button" class="btn" id="jmore" hidden>${t('more')}</button></div>`;
  $('#jchips').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; jv.f = b.dataset.f; $('#jchips').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); drawJobs(); };
  $('#jq').oninput = e => { jv.q = e.target.value.trim(); drawJobs(); };
  $('#jmore').onclick = async e => {
    e.target.disabled = true;
    try { const m = await get('jobs', { offset: jv.items.length }); jv.items = jv.items.concat(m.jobs); jv.more = m.more; drawJobs(); }
    catch (er) { fail(er); } finally { e.target.disabled = false; }
  };
  drawJobs();
}

// ── Druck teilen (16.10.2026): Foto eines Drucks als „Make“ auf die Modellseite. Das Modell wählt der Nutzer selbst
// (Suche mit Vorschlägen) — sicher vorgeschlagen wird nur die MakerWorld-Nummer, die Bambu mitliefert. Aufruf über jeden
// Knopf mit data-mkshare (leer = ohne Auftrag), die Frage oben in der Übersicht und #share-<Auftrag> (Link aus „Druck fertig“).
const I_CAM = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>';
const MK_SRC = { printables: 'Printables', thingiverse: 'Thingiverse', makerworld: 'MakerWorld', cults3d: 'Cults3D', myminifactory: 'MyMiniFactory', makeronline: 'MakerOnline',
  crealitycloud: 'Creality Cloud', thangs: 'Thangs', grabcad: 'GrabCAD', sketchfab: 'Sketchfab', nexprint: 'NexPrint' };
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mkshare]');
  if (b) { e.preventDefault(); shareDialog(b.dataset.mkshare ? +b.dataset.mkshare : null); return; }
  const no = e.target.closest('[data-mkno]');
  if (no) { e.preventDefault(); pv.ask = null; no.closest('.mk-ask')?.remove(); api('mk_dismiss', { job: +no.dataset.mkno }).catch(() => {}); }
});
/** Frage nach dem jüngsten fertigen Druck (oben in der Druckerübersicht). */
const askHtml = () => pv.ask ? `<section class="note mk-ask"><span class="mk-ask-ico">${I_CAM}</span><div class="mk-ask-t">
    <b>${esc(t('mk_ask_h', { t: pv.ask.title }))}</b><p>${esc(t('mk_ask_p'))}</p>
    <div class="row"><button type="button" class="btn sm pri" data-mkshare="${pv.ask.id}">${I_CAM} ${esc(t('mk_share_btn'))}</button>
    <button type="button" class="btn sm ghost" data-mkno="${pv.ask.id}">${esc(t('mk_ask_no'))}</button></div></div></section>` : '';
/** Großes Handyfoto vor dem Hochladen verkleinern (2000 px, JPEG) — spart Datenvolumen; geht das nicht, das Original. */
async function mkShrink(file) {
  if (file.size < 1.5e6 || !window.createImageBitmap) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const f = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * f); c.height = Math.round(bmp.height * f);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    return blob && blob.size < file.size ? blob : file;
  } catch (e) { return file; }
}
async function shareDialog(jobId) {
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('mk_h'))}</b><button type="button" class="x-btn" data-x>×</button></div><div class="dlg-b"><div class="loading">${t('loading')}</div></div>`;
  dlg.querySelector('[data-x]').onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
  let d;
  try { d = await api('mk_info', null, jobId ? { job: jobId } : {}); } catch (e) { dlg.close(); fail(e); return; }
  if (d.shared) { dlg.close(); toast(t(d.shared.approved ? 'mk_st_online' : 'mk_st_wait')); return; }
  const job = d.job;
  const mk = { pre: d.pre, sel: d.pre, res: d.results, timer: 0, seq: 0, photo: null };
  const card = (m, badge) => `<label class="mk-card"><input type="radio" name="model_id" value="${esc(m.id)}"${mk.sel && mk.sel.id === m.id ? ' checked' : ''}>
    <img src="${esc(m.thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span class="mk-c-t"><b>${esc(m.name)}</b>
    <small>${esc([m.designer, MK_SRC[m.source] || m.source].filter(Boolean).join(' · '))}</small>${badge ? `<em>${esc(badge)}</em>` : ''}</span></label>`;
  const drawRes = () => {
    const seen = new Set(), rows = [];
    const add = (m, badge) => { if (!m || seen.has(m.id)) return; seen.add(m.id); rows.push(card(m, badge)); };
    add(mk.pre, t(d.pre_src === 'bambu' ? 'mk_pre_bambu' : 'mk_pre_title'));
    add(mk.sel);
    mk.res.forEach(m => add(m));
    $('#mkres').innerHTML = rows.join('') || `<p class="hint mk-none">${esc(t($('#mkq').value.trim() ? 'mk_none' : 'mk_type'))}</p>`;
  };
  const okDefault = !job || job.status !== 3;
  dlg.innerHTML = `<form id="mkf"><div class="dlg-h"><b>${esc(t('mk_h'))}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b mk-b">
      ${job ? `<p class="mk-job">${I_PRINTER.replace('width="28" height="28"', 'width="18" height="18"')}<span><b>${esc(job.title)}</b>${job.data ? `<small>${esc(job.data)}</small>` : ''}</span></p>` : `<p class="hint" style="margin:0">${esc(t('mk_lead_any'))}</p>`}
      <label class="mk-photo" id="mkph"><input type="file" id="mkfile" accept="image/*">
        <span class="mk-ph-e">${I_CAM.replace('width="16" height="16"', 'width="30" height="30"')}<b>${esc(t('mk_photo'))}</b><small>${esc(t('mk_photo_hint'))}</small></span>
        <img id="mkimg" alt="" hidden></label>
      <div class="fld"><span>${esc(t('mk_ok_q'))}</span><div class="mk-seg">
        <label><input type="radio" name="success" value="1"${okDefault ? ' checked' : ''}><span>${esc(t('mk_ok_yes'))}</span></label>
        <label><input type="radio" name="success" value="0"${okDefault ? '' : ' checked'}><span>${esc(t('mk_ok_no'))}</span></label></div></div>
      <div class="fld"><span>${esc(t('mk_model'))}</span>
        <input class="in" type="search" id="mkq" value="${esc(d.q || '')}" placeholder="${esc(t('mk_q_ph'))}" aria-label="${esc(t('mk_model'))}" autocomplete="off">
        <div class="mk-res" id="mkres"></div><small class="hint">${esc(t('mk_q_hint'))}</small></div>
      <label class="fld"><span>${esc(t('mk_tip'))}</span><textarea class="in" name="tip" rows="2" maxlength="500" placeholder="${esc(t('mk_tip_ph'))}"></textarea></label>
      ${job && job.data ? `<label class="chk row"><input type="checkbox" name="show_data" value="1" checked> <span>${esc(t('mk_show_data'))} <b>${esc(job.data)}</b></span></label>` : ''}
      <p class="hint mk-note">${esc(t('mk_note'))}</p><div id="mkmsg"></div>
    </div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button class="btn pri" id="mkgo">${esc(t('mk_go'))}</button></div></form>`;
  const f = $('#mkf');
  f.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  drawRes();
  $('#mkres').onchange = e => { if (e.target.name === 'model_id') mk.sel = [mk.pre, ...mk.res].find(m => m && m.id === e.target.value) || mk.sel; };
  $('#mkq').oninput = () => {
    clearTimeout(mk.timer);
    mk.timer = setTimeout(async () => {
      const q = $('#mkq').value.trim(), n = ++mk.seq;
      if (!q) { mk.res = []; drawRes(); return; }
      try { const r = await api('mk_search', null, { q }); if (n === mk.seq) { mk.res = r.results; drawRes(); } } catch (e) { /* nächster Tastendruck */ }
    }, 350);
  };
  $('#mkq').onkeydown = e => { if (e.key === 'Enter') e.preventDefault(); };   // Enter sucht, schickt nicht ab
  $('#mkfile').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    mk.photo = file;
    const img = $('#mkimg'); if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(file); img.hidden = false; $('#mkph').classList.add('has');
  };
  const msg = (k, bad) => { $('#mkmsg').innerHTML = `<div class="note ${bad ? 'warn-note' : ''}">${esc(t(k) !== k ? t(k) : t('err_generic'))}</div>`; };
  f.onsubmit = async e => {
    e.preventDefault();
    const sel = f.querySelector('input[name="model_id"]:checked');
    if (!mk.photo) { msg('mk_err_photo', true); $('#mkph').scrollIntoView({ block: 'nearest' }); return; }
    if (!sel) { msg('mk_err_pick', true); $('#mkq').focus(); return; }
    const btn = $('#mkgo'); btn.disabled = true; btn.textContent = t('mk_sending');
    const fd = new FormData();
    fd.append('a', 'mk_share'); fd.append('model_id', sel.value);
    fd.append('success', f.querySelector('input[name="success"]:checked').value);
    fd.append('tip', f.tip.value);
    if (job) fd.append('job', job.id);
    if (f.show_data && f.show_data.checked) fd.append('show_data', '1');
    const ph = await mkShrink(mk.photo);
    fd.append('photo', ph, ph === mk.photo ? (mk.photo.name || 'photo.jpg') : 'photo.jpg');
    const r = await postForm(fd).catch(() => ({ error: 'generic' }));
    if (!r.ok) { btn.disabled = false; btn.textContent = t('mk_go'); msg(r.error, true); return; }
    if (job) { if (pv.ask && pv.ask.id === job.id) pv.ask = null; const it = jv.items.find(x => x.id === job.id); if (it) { it.mk = 0; if ($('#jlist')) drawJobs(); } }
    view.querySelectorAll('.mk-ask').forEach(x => x.remove());
    dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('mk_done_h'))}</b><button type="button" class="x-btn" data-x>×</button></div>
      <div class="dlg-b"><p style="margin:0">${esc(t('mk_done_p'))}</p>${r.model ? `<a class="mk-card mk-done" href="${esc(r.model.url)}" target="_blank" rel="noopener"><img src="${esc(r.model.thumb)}" alt=""><span class="mk-c-t"><b>${esc(r.model.name)}</b><small>${esc(t('mk_done_link'))}</small></span></a>` : ''}</div>
      <div class="dlg-f"><button type="button" class="btn pri" data-x>${esc(t('close'))}</button></div>`;
    dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  };
}

// ── Texte der Druckeranbindung (lang.php, sprintf-Platzhalter %s / %d / %1$s) ──
const tf = (k, ...a) => { let i = 0; return String(S[k] ?? k).replace(/%(\d\$)?(0?\d)?[sd]/g, (m, pos, pad) => {
  let v = String(pos ? a[parseInt(pos) - 1] : a[i++]); if (pad && pad[0] === '0') v = v.padStart(+pad[1], '0'); return v; }).replace(/%%/g, '%'); };
const PROV_NAME = { anycubic: 'Anycubic', bambu: 'Bambu Lab', creality: 'Creality', elegoo: 'Elegoo', moonraker: 'Klipper / Moonraker', octoprint: 'OctoPrint', prusa: 'Prusa', prusaconnect: 'Prusa Connect' };
// Clouds außerhalb der EU (08.10.2026): Häkchen = ausdrückliche Einwilligung (Art. 49 Abs. 1 lit. a DSGVO). Welche Anbieter, sagt
// der Server (PC_CONSENT_COUNTRIES); wo deren Daten liegen, steht je Anbieter in pc_where_* (Quellen: deren Datenschutzerklärungen).
// Der Server prüft das Häkchen ebenfalls; bestehende Verbindungen ohne Einwilligung fragt consentAsk nach.
const consentTxt = (prov, cc) => t('pc_consent', { b: esc(PROV_NAME[prov] || prov), c: esc(t('pc_where_' + prov)),
  l: `<a href="/privacy.php#printers" target="_blank" rel="noopener">${esc(t('pc_consent_link'))}</a>` });
const consentBox = (prov, cc) => cc && cc[prov] ? `<label class="consent" data-prov="${esc(prov)}"><input type="checkbox" name="consent" value="1" required><span>${consentTxt(prov, cc)}</span></label>` : '';
// Häkchen vergessen (25.10.2026, User: „sehr oft setzt der User das Häkchen nicht“; logs/connect_funnel.log „invalid …:consent“):
// statt der kleinen Browser-Sprechblase den Kasten rot markieren, darunter klar sagen, was fehlt, und hinscrollen
function consentMiss(inp, first) {
  const box = inp.closest('.consent');
  if (!box) return;
  box.classList.remove('miss'); void box.offsetWidth; box.classList.add('miss');   // Wackeln bei jedem Versuch neu
  let m = box.nextElementSibling;
  if (!m || !m.classList.contains('consent-miss')) { m = document.createElement('p'); m.className = 'consent-miss'; m.setAttribute('role', 'alert'); box.after(m); }
  m.textContent = t('pc_consent_miss', { b: PROV_NAME[box.dataset.prov] || box.dataset.prov || '' });
  if (first) { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); inp.focus({ preventScroll: true }); }
  if (!inp.dataset.miss) {
    inp.dataset.miss = '1';
    inp.addEventListener('change', () => {
      if (!inp.checked) return;
      box.classList.remove('miss');
      const n = box.nextElementSibling; if (n && n.classList.contains('consent-miss')) n.remove();
    });
  }
}
const consentAsk = (prov, cc) => `<form class="note consent-ask" data-consent="${esc(prov)}"><b>${esc(t('pc_consent_h', { b: PROV_NAME[prov] || prov }))}</b>
  <p>${esc(t('pc_consent_p'))}</p>${consentBox(prov, cc)}
  <div class="row"><button class="btn sm pri">${esc(t('pc_consent_btn'))}</button><button type="button" class="btn sm danger" data-consent-no>${esc(t('pc_consent_no'))}</button></div></form>`;
function bindConsent(root, after) {
  root.querySelectorAll('form[data-consent]').forEach(f => {
    const prov = f.dataset.consent;
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const b = f.querySelector('button'); b.disabled = true;
      try { await api('consent_give', { provider: prov, consent: 1 }); toast(t('pc_consent_ok')); after(); } catch (er) { b.disabled = false; toast(S[er.message] || t('err_generic')); }
    });
    f.querySelector('[data-consent-no]').addEventListener('click', async ev => {
      if (!confirm(tf('pc_disconnect_confirm_prov', PROV_NAME[prov]))) return;
      ev.target.disabled = true;
      try { await api('disconnect', { provider: prov }); after(); } catch (er) { ev.target.disabled = false; fail(er); }
    });
  });
}
const msgBox = (html, err) => `<div class="note${err ? ' err-note' : ''}">${html}</div>`;
async function postForm(fd) { return AMP.form(fd); }

// ── Ansicht: Verbindungen ──────────────────────────────────────────────────
const cn = { msg: null, poll: null, tokenFill: null, open: null, brand: null, brWatchUntil: 0, fail: null };
// Verbinden-Trichter (21.10.2026): Seit 19.10. verband niemand mehr, obwohl so viele wie vorher auf die Seite kamen — jeder Schritt
// je Seitenaufruf einmal an den Server (logs/connect_funnel.log), ohne Eingaben. Fehlschlag still, der Nutzer merkt nichts.
const cnSeen = new Set();
function cnEv(step, v = '') {
  const k = step + ':' + v;
  if (cnSeen.has(k)) return;
  cnSeen.add(k);
  api('cn_ev', { step, v: String(v).slice(0, 60) }).catch(() => {});
}
// Vom Browser abgelehnte Pflichtfelder (Häkchen der Einwilligung, leere E-Mail): dann geht gar keine Anfrage raus
document.addEventListener('invalid', e => {
  const f = e.target.form;
  if (lastView === 'connect' && f && f.dataset.a) cnEv('invalid', f.dataset.a + ':' + (e.target.name || e.target.type));
  if (e.target.name === 'consent' && e.target.type === 'checkbox') {
    e.preventDefault();   // keine Browser-Sprechblase, dafür consentMiss
    // Hinscrollen nur, wenn das Häkchen das erste fehlende Feld ist (sonst zeigt der Browser z. B. die leere E-Mail an)
    consentMiss(e.target, !f || [...f.elements].find(x => x.validity && !x.validity.valid) === e.target);
  }
}, true);
// Verbindungs-Assistent (08.10.2026, User: „durch den Prozess führen“): Marke → Weg → Anleitung (die Panels darunter).
// [Schlüssel, Name (null = t('wz_'+Schlüssel)), Beispiele, Wege [Anschluss, Voraussetzung?]] — erster Weg = empfohlen
const WZ_BRANDS = [
  ['bambu', 'Bambu Lab', 'X1, P1, A1, H2D', [['bambu', 'wz_n_bambu']]],
  ['anycubic', 'Anycubic', 'Kobra S1, Kobra 3, Kobra X', [['anycubic'], ['moonraker', 'wz_n_rinkhals']]],
  ['creality', 'Creality', 'K1, K2, Ender-3 V3, Hi', [['creality'], ['moonraker', 'wz_n_root'], ['octoprint', 'wz_n_octo']]],
  ['elegoo', 'Elegoo', 'Centauri Carbon 2, Neptune 4', [['elegoo', 'wz_n_elegoo'], ['moonraker', 'wz_n_neptune']]],
  ['prusa', 'Prusa', 'MK4S, MK3.9, Core One, XL, MINI+', [['prusaconnect', 'wz_n_pcn'], ['prusa'], ['octoprint', 'wz_n_mk3']]],
  ['flashforge', 'Flashforge', 'AD5X, Adventurer 5M, 5M Pro', [['lan', 'wz_n_zmod']]],
  ['klipper', null, 'Voron, Qidi, Sovol, Snapmaker U1', [['moonraker'], ['lan']]],
  ['octoprint', 'OctoPrint', 'Ender 3, Prusa MK3, Ultimaker 2', [['octoprint'], ['lan']]],
];
const WZ_OF = { bambu: 'bambu', anycubic: 'anycubic', creality: 'creality', elegoo: 'elegoo', prusa: 'prusa', prusaconnect: 'prusa', moonraker: 'klipper', octoprint: 'octoprint', lan: 'klipper' };
/**
 * Panel und Marke gehören zum offenen Brücken-Code (01.11.2026): Nach dem Neuladen ist cn leer, und fest 'prusa' schickte Flashforge-
 * und Klipper-Nutzer in die Prusa-Anleitung (17 von 18 Prusa-Panels im Trichter). WZ_OF allein reicht nicht, es machte aus Flashforge
 * „Klipper“ ohne ZMOD-Hinweis. Ohne passenden Merker (anderes Gerät, privates Fenster) gilt das allgemeine Heimnetz-Panel.
 */
function cnBrOrigin(code) {
  if (cn.open === 'lan' || cn.open === 'prusa') { pref('br_from', [code, cn.open, cn.brand || ''].join(' ')); return; }
  const [c, open, brand] = (pref('br_from') || '').split(' ');
  const ok = c === code && (open === 'lan' || open === 'prusa');
  cn.open = ok ? open : 'lan';
  if (ok && brand && !cn.brand) cn.brand = brand;
}
/** Geheimzahl für die Lesezeichen dieses Browsers (localStorage); ohne Speicher keine Übernahme per Lesezeichen. */
function bmNonce() {
  try {
    let n = localStorage.getItem('fm_bm_nonce');
    if (!/^[0-9a-f]{32}$/.test(n || '')) { n = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('fm_bm_nonce', n); }
    return n;
  } catch (e) { return 'x'; }
}
// Lesezeichen-Weg leichter (08.10.2026): am Handy (nichts zu ziehen, in der App keine Lesezeichen) „Link per E-Mail“ statt
// Anleitung; Einwilligung vorab → nach der Rückkehr verbindet die Seite selbst; Klick statt Ziehen und Ziehen selbst erklärt.
const BM_TOUCH = (() => { try { return matchMedia('(hover: none) and (pointer: coarse)').matches; } catch (e) { return false; } })();
const BM_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const BM_CONSENT_TTL = 30 * 60e3;   // Häkchen vor dem Weg zum Hersteller gilt für die Rückkehr höchstens 30 Min.
function bmConsentSet(prov, on) {
  try { on ? localStorage.setItem('fm_bm_consent', JSON.stringify({ prov, t: Date.now() })) : localStorage.removeItem('fm_bm_consent'); } catch (e) {}
}
function bmConsentGet(prov) {
  try { const c = JSON.parse(localStorage.getItem('fm_bm_consent') || 'null'); return !!c && c.prov === prov && Date.now() - c.t < BM_CONSENT_TTL; }
  catch (e) { return false; }
}
/** Hinweis unter dem Lesezeichen-Knopf (Klick statt Ziehen / nach dem Ziehen). */
function bmTip(a, key) {
  const li = a.closest('li') || a.parentNode;
  li.querySelector('.bm-tip')?.remove();
  li.insertAdjacentHTML('beforeend', `<div class="bm-tip">${esc(t(key))}</div>`);
  a.classList.remove('wiggle');
  if (key === 'bm_click_tip') { void a.offsetWidth; a.classList.add('wiggle'); }
}
/** Beim Ziehen oben „hier loslassen“ — pointer-events: none, damit der Hinweis das Ablegen nicht abfängt. */
function bmDrop(on) {
  const el = document.getElementById('bmDrop');
  if (!on) { el?.remove(); return; }
  if (!el) document.body.insertAdjacentHTML('beforeend', `<div id="bmDrop"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>${esc(t('bm_drop'))}</div>`);
}
// Anleitung als Animation (23.10.2026, User: „Erklärvideos, während der User versucht zu verbinden“): jeder Weg als gespieltes
// Browserfenster. Nur Englisch (User: „englisch reicht“). Arten: bm = Lesezeichen (Anycubic/Creality; Herstellerseiten sind
// Bildschirmfotos in img/howto/, aufgenommen bei 1000×600, Felder darauf als [links, oben, breit, hoch] in Prozent),
// pcn = Prusa Connect mit E-Mail-Code, el = Elegoo (E-Mail aus der App), br = Brücke (Terminal auf dem Pi, dann Drucker wählen).
// Jede Runde baut die Bühne neu auf (hwStage); läuft nur, solange sichtbar; Klick hält an.
const HW = {
  anycubic: { kind: 'bm', name: 'Anycubic', site: 'cloud-universe.anycubic.com', tab: 'Anycubic', printers: [['Kobra S1', 'Idle']],
    login: { img: 'ac-login', url: 'uc.makeronline.com/login', email: [29.6, 29.7, 43.2, 4], pw: [29.6, 41, 40.8, 4], btn: [26, 58.9, 48, 7.3] },
    after: { url: 'cloud-universe.anycubic.com/file' } },
  creality: { kind: 'bm', name: 'Creality', site: 'crealitycloud.com', tab: 'Creality Cloud', printers: [['K1C', 'Idle']],
    home: { img: 'cr-home', url: 'crealitycloud.com', btn: [90, 3, 8, 6.7] },
    login: { img: 'cr-modal', url: 'id.creality.com', email: [27.1, 33.8, 45.8, 7.7], pw: [27.1, 50.2, 40.9, 7.7], agree: [27, 73.7, 1.4, 2.3], btn: [27, 62, 46, 8] },
    after: { img: 'cr-home', url: 'crealitycloud.com', avatar: [89.6, 2.6, 9, 7.6] } },
  prusaconnect: { kind: 'pcn', name: 'Prusa Connect', printers: [['MK4S', 'Idle'], ['Core One', 'Printing · 42 %']],
    steps: ['Enter the email of your Prusa account', 'Then its password and Connect', 'Type the code Prusa emails you', 'Done – your printers appear'] },
  elegoo: { kind: 'el', name: 'Elegoo', printers: [['Centauri Carbon', 'Idle']],
    steps: ['Look up your email in the Elegoo app', 'Enter that email and your password', 'Tick the box', 'Connect – done'] },
  prusa: { kind: 'br', name: 'Prusa', type: 'Prusa (PrusaLink)', host: '192.168.1.50', model: 'MK4S', pw: 'PrusaLink password', printers: [['MK4S', 'Idle']],
    steps: ['Set up the bridge and copy the line', 'Paste it in a terminal on your Pi or NAS', 'Pick your printer from the list', 'Enter the PrusaLink password – done'] },
  lan: { kind: 'br', name: 'in your home network', type: 'Klipper (Moonraker)', host: '192.168.1.60', model: 'voron', printers: [['Voron 2.4', 'Idle']],
    steps: ['Set up the bridge and copy the line', 'Paste it in a terminal on your Pi or NAS', 'Pick your printer from the list', 'Add printer – done'] },
};
const HW_OK = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const hwSteps = c => c.steps || ['Tick the box', 'Drag the button into your bookmarks bar', `Sign in at ${c.name}`, 'Click the bookmark – done'];
/** Kasten unter dem Panel-Text: Titel, leere Bühne, Schritt-Kacheln. */
function hwHtml(prov) {
  const c = HW[prov];
  if (!c) return '';
  return `<div class="hw" data-hw="${prov}"><div class="hw-title"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>Watch how it works</div>
    <div class="hw-stage" aria-hidden="true"></div>
    <ol class="hw-steps">${hwSteps(c).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    <button type="button" class="btn sm hw-play" hidden>Play</button></div>`;
}
/** Inhalt der Bühne im Ausgangszustand (jede Runde neu). */
function hwStage(prov) {
  const c = HW[prov], n = esc(c.name), bm = c.kind === 'bm', pill = `3DSEARCH: ${n}`;
  const fld = (label, cls) => `<div class="hw-lbl">${label}</div><div class="hw-in ${cls}"></div>`;
  const cons = `<div class="hw-cons"><span class="hw-cb">${HW_OK}</span><span>I consent to 3DSEARCH sending my login details or access key to ${n} …</span></div>`;
  const done = `<div class="hw-sc hw-done"><b class="hw-h">Connect ${n}</b><div class="hw-wait">${bm ? 'Sign-in received – connecting …' : 'Connecting …'}</div>
    <div class="hw-ok">${HW_OK} ${c.kind === 'br' ? 'Printer added' : 'Connected to ' + n}</div>${c.printers.map(([p, s]) => `<div class="hw-prn"><i class="hw-dot"></i><b>${esc(p)}</b><span>${esc(s)}</span></div>`).join('')}</div>`;
  let page = '', extra = '';
  if (bm) {
    page = `<div class="hw-sc hw-ours"><b class="hw-h">Connect ${n}</b>${cons}<div class="hw-way">With a bookmark</div>
        <ol><li>Drag this button up into your bookmarks bar: <span class="hw-pill">${pill}</span></li><li>Sign in at <u class="hw-link">${esc(c.site)}</u></li><li>Click the bookmark there.</li></ol></div>
      <div class="hw-sc hw-shot"><img alt=""><span class="hw-f hw-email"></span><span class="hw-f hw-pw"></span><span class="hw-agree">${HW_OK}</span>
        <span class="hw-avatar"><i></i></span><span class="hw-signed">${HW_OK} Signed in</span><span class="hw-hot"></span></div>`;
    extra = `<span class="hw-ghost">${pill}</span>`;
  } else if (c.kind === 'pcn') {
    page = `<div class="hw-sc hw-ours"><b class="hw-h">Connect ${n}</b>${fld('Email of your Prusa account', 'hw-email')}${fld('Password', 'hw-pw')}
        <span class="hw-btn hw-go">Connect</span><div class="hw-tip">Signed up with Google or Apple? Set a password at account.prusa3d.com first.</div></div>
      <div class="hw-sc hw-otp"><b class="hw-h">Connect ${n}</b><p class="hw-p">Prusa wants to confirm the sign-in. Enter the code Prusa just emailed you.</p>
        ${fld('Verification code', 'hw-code')}<span class="hw-btn hw-go2">Confirm</span></div>`;
    extra = `<div class="hw-toast"><svg viewBox="0 0 24 24" width="1.6em" height="1.6em" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6l8.5 7 8.5-7"/></svg>
      <span><b>Prusa Account</b>Your verification code: <b class="hw-otpv">482913</b></span></div>`;
  } else if (c.kind === 'el') {
    page = `<div class="hw-sc hw-ours"><b class="hw-h">Connect ${n}</b>${fld('E-mail of your Elegoo account', 'hw-email')}${fld('Password', 'hw-pw')}${cons}<span class="hw-btn hw-go">Connect</span></div>`;
    extra = `<div class="hw-phone"><div class="hw-ph-bar">9:41</div><div class="hw-ph-h">Elegoo app · Me</div><div class="hw-ph-av"><i></i><b>Alex</b></div>
      <div class="hw-ph-row hw-ph-mail"><span>Email</span><b>you@example.com</b></div><div class="hw-ph-row"><span>My printers</span></div><div class="hw-ph-row"><span>Settings</span></div></div>`;
  } else {
    page = `<div class="hw-sc hw-ours"><b class="hw-h">Connect ${n}</b><div class="hw-need"><b>What you need</b> – a Raspberry Pi, NAS or PC that stays on, in the same network as the printer.</div>
        <span class="hw-btn hw-setup">Set up the bridge</span>
        <div class="hw-cmdbox"><div class="hw-tabsm"><span class="on">Raspberry Pi / Linux</span><span>NAS / Docker</span></div>
          <ol><li>Open a terminal on the device – or sign in via SSH.</li><li>Paste this line and press Enter:</li></ol>
          <div class="hw-cmd"><code>U=https://3dsearch.net/api/agent.sh; F=/tmp/3dsearch-agent.sh; (curl -fsSLk $U || wget -qO- …</code><span class="hw-btn sm hw-copy">Copy</span></div>
          <div class="hw-waitl"><i class="hw-spin"></i>Waiting for the bridge …</div></div></div>
      <div class="hw-sc hw-ours2"><b class="hw-h">Connect ${n}</b><div class="hw-ok hw-okb">${HW_OK} Bridge online · raspberrypi</div>
        <div class="hw-way">Found in your network (tap to use):</div><span class="hw-btn sm hw-found">${esc(c.type)} · ${esc(c.host)} · ${esc(c.model)}</span>
        <div class="hw-row2"><div>${fld('Printer address (IP)', 'hw-host')}</div><div>${c.pw ? fld(esc(c.pw), 'hw-pw') : fld('API key (usually not needed)', 'hw-apikey')}</div></div>
        <span class="hw-btn hw-add">Add printer</span></div>`;
    extra = `<div class="hw-term"><div class="hw-term-bar"><i></i><i></i><i></i><span>pi@raspberrypi: ~</span></div><pre class="hw-term-out"></pre></div><span class="hw-key"></span>`;
  }
  return `<div class="hw-tabs"><span class="hw-tab on"><i></i><b>3DSEARCH</b></span><span class="hw-tab t2"><i></i><b></b></span></div>
    <div class="hw-addr"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span class="hw-url">3dsearch.net/filament/#connect</span></div>
    ${bm ? `<div class="hw-bmbar"><span class="hw-bmph">Bookmarks bar</span><span class="hw-bmk">${pill}</span><span class="hw-drop">Drop it here</span></div>` : ''}
    <div class="hw-page">${page}${done}</div>${extra}<span class="hw-ring"></span>
    <svg class="hw-cur" viewBox="0 0 20 24" width="20" height="24" aria-hidden="true"><path d="M2 1.5v18.2l4.6-4.3 3 6.9 3.1-1.4-3-6.7 6.4-.3z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>
    <div class="hw-paused">Paused – tap to continue</div>`;
}
/** Abläufe je Art; h = Hilfsfunktionen aus hwMount, c = Eintrag aus HW. */
const HW_RUN = {
  async bm(h, c) {
    const { q, wait, go, click, type, step, url, box, put, xy, scene, cur } = h;
    box(q('.hw-email'), c.login.email); box(q('.hw-pw'), c.login.pw); box(q('.hw-agree'), c.login.agree); box(q('.hw-avatar'), null); box(q('.hw-hot'), null);
    const img = q('.hw-shot img'), page = p => { img.src = '/img/howto/' + p.img + '.webp'; url(p.url); };
    const hot = (b, ms) => { box(q('.hw-hot'), b); return go(q('.hw-hot'), ms); };
    step(0); await go(q('.hw-cb')); await click(); q('.hw-cons').classList.add('checked'); await wait(500);
    // Knopf in die Leiste ziehen: Geisterbild folgt dem Zeiger, oben „hier loslassen“
    step(1); const pill = q('.hw-pill'), ghost = q('.hw-ghost'); await go(pill);
    cur().classList.add('down'); const [px, py] = xy(pill); put(ghost, px, py, 0); ghost.classList.add('shown'); q('.hw-drop').classList.add('shown');
    await wait(250); const [bx, by] = xy(q('.hw-bmk')); put(ghost, bx, by, 1100); put(cur(), bx, by, 1100); await wait(1200);
    cur().classList.remove('down'); ghost.classList.remove('shown'); q('.hw-drop').classList.remove('shown'); q('.hw-bmk').classList.add('shown'); await wait(600);
    // Zur Herstellerseite (neuer Tab) und anmelden
    step(2); await go(q('.hw-link')); await click();
    const t2 = q('.hw-tab.t2'); t2.querySelector('b').textContent = c.tab; q('.hw-tab').classList.remove('on'); t2.classList.add('shown', 'on');
    scene('shot');
    if (c.home) { page(c.home); await wait(700); await hot(c.home.btn); await click(); await wait(200); }
    page(c.login); await wait(600);
    await go(q('.hw-email')); await click(); await type(q('.hw-email'), 'you@example.com');
    await go(q('.hw-pw'), 500); await click(); await type(q('.hw-pw'), '••••••••', 70);
    if (c.login.agree) { await go(q('.hw-agree'), 500); await click(); q('.hw-agree').classList.add('checked'); }
    await hot(c.login.btn, 600); await click(); await wait(300);
    box(q('.hw-email'), null); box(q('.hw-pw'), null); box(q('.hw-agree'), null);
    if (c.after.img) page(c.after); else url(c.after.url);
    box(q('.hw-avatar'), c.after.avatar); q('.hw-shot').classList.add('signed'); await wait(1000);
    // Lesezeichen klicken → zurück bei 3DSEARCH, verbindet von selbst (Häkchen war vorab gesetzt)
    step(3); await go(q('.hw-bmk')); await click();
    t2.querySelector('b').textContent = '3DSEARCH'; url('3dsearch.net/filament/#connect'); scene('done');
  },
  async pcn(h) {
    const { q, wait, go, click, type, step, scene } = h;
    step(0); await go(q('.hw-email')); await click(); await type(q('.hw-email'), 'you@example.com'); await wait(300);
    step(1); await go(q('.hw-pw'), 500); await click(); await type(q('.hw-pw'), '••••••••', 70); await go(q('.hw-go'), 600); await click(); await wait(500);
    // Neues Gerät → Prusa schickt einen Code per Mail
    step(2); scene('otp'); await wait(500); q('.hw-toast').classList.add('shown'); await wait(1600);
    await go(q('.hw-code')); await click(); await type(q('.hw-code'), '482913', 90); q('.hw-toast').classList.remove('shown');
    await go(q('.hw-go2'), 600); await click();
    step(3); scene('done');
  },
  async el(h) {
    const { q, wait, go, click, type, step, scene } = h;
    // Die Adresse muss die des Elegoo-Kontos sein („user not exist“ bei #2954): erst in der App nachsehen
    step(0); await wait(300); q('.hw-phone').classList.add('shown'); await wait(900); q('.hw-ph-mail').classList.add('hl'); await wait(1800);
    q('.hw-phone').classList.remove('shown'); await wait(400);
    step(1); await go(q('.hw-email')); await click(); await type(q('.hw-email'), 'you@example.com');
    await go(q('.hw-pw'), 500); await click(); await type(q('.hw-pw'), '••••••••', 70); await wait(300);
    step(2); await go(q('.hw-cb'), 600); await click(); q('.hw-cons').classList.add('checked'); await wait(400);
    step(3); await go(q('.hw-go'), 600); await click(); scene('done');
  },
  async br(h, c) {
    const { q, wait, go, click, type, step, scene } = h;
    const key = async k => { const e = q('.hw-key'); e.textContent = k; e.classList.add('shown'); await wait(700); e.classList.remove('shown'); await wait(150); };
    step(0); await go(q('.hw-setup')); await click(); q('.hw-ours').classList.add('code'); await wait(700);
    await go(q('.hw-copy'), 700); await click(); q('.hw-copy').textContent = 'Copied'; await wait(500);
    // Terminal auf dem Pi: einfügen, Enter, Ausgabe wie install.sh
    step(1); const term = q('.hw-term'), out = q('.hw-term-out'); term.classList.add('shown'); out.textContent = 'pi@raspberrypi:~ $ '; await wait(500);
    await go(term, 600); await click(); await key('Ctrl + V');
    out.textContent += 'U=https://3dsearch.net/api/agent.sh; F=/tmp/3dsearch-agent.sh; (curl -fsSLk $U || wget …) > $F && … sh $F bridge 7KQ2M9\n';
    await wait(400); await key('Enter');
    for (const l of ['checksum OK', '3DSEARCH bridge — setting up (systemd)', 'agent.py checksum OK', '', 'Done. Now add your printers on 3dsearch.net – the bridge already searches your network.', 'pi@raspberrypi:~ $ ']) {
      out.textContent += l + (l.endsWith('$ ') ? '' : '\n'); await wait(380);
    }
    await wait(900); term.classList.remove('shown'); await wait(300);
    // Die Seite aktualisiert sich von selbst, gefundene Drucker oben
    step(2); scene('ours2'); await wait(700); await go(q('.hw-found')); await click(); q('.hw-host').textContent = c.host; await wait(500);
    step(3); if (c.pw) { await go(q('.hw-pw'), 600); await click(); await type(q('.hw-pw'), '••••••••', 70); }
    await go(q('.hw-add'), 600); await click(); scene('done');
  },
};
/** Spielt die Animation in einem .hw-Kasten ab; wartet, solange er nicht sichtbar oder angehalten ist. */
function hwMount(el) {
  if (el.dataset.on) return;
  el.dataset.on = '1';
  const prov = el.dataset.hw, c = HW[prov], st = el.querySelector('.hw-stage');
  let vis = false, paused = false, running = false, loops = 0;
  for (const p of [c.home, c.login, c.after]) if (p && p.img) new Image().src = '/img/howto/' + p.img + '.webp';
  const q = s => st.querySelector(s), cur = () => q('.hw-cur');
  const wait = async ms => {
    for (let t = 0; t < ms;) { await new Promise(r => setTimeout(r, 50)); if (!el.isConnected) throw 0; if (vis && !paused) t += 50; }
  };
  const xy = e => { const a = e.getBoundingClientRect(), s = st.getBoundingClientRect(); return [a.left - s.left + a.width / 2, a.top - s.top + a.height / 2]; };
  const put = (e, x, y, ms) => { e.style.transitionDuration = `${ms}ms, ${ms}ms, .15s`; e.style.left = x + 'px'; e.style.top = y + 'px'; };
  const h = {
    q, cur, wait, xy, put,
    go: (e, ms = 700) => { const [x, y] = xy(e); put(cur(), x, y, ms); return wait(ms + 100); },
    click: async () => {
      const r = q('.hw-ring'); r.style.left = cur().style.left; r.style.top = cur().style.top;
      cur().classList.add('down'); r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
      await wait(180); cur().classList.remove('down'); await wait(150);
    },
    type: async (f, s, ms = 55) => { f.classList.add('focus'); for (const ch of s) { f.textContent += ch; await wait(ms); } f.classList.remove('focus'); },
    box: (e, b) => { if (!b) { e.hidden = true; return; } e.hidden = false; Object.assign(e.style, { left: b[0] + '%', top: b[1] + '%', width: b[2] + '%', height: b[3] + '%' }); },
    step: i => el.querySelectorAll('.hw-steps li').forEach((li, j) => li.classList.toggle('on', j === i)),
    url: u => { q('.hw-url').textContent = u; },
    scene: s => { st.dataset.sc = s; },
  };
  async function run() {
    running = true;
    try {
      for (;;) {
        st.innerHTML = hwStage(prov); h.scene('ours'); h.step(-1); put(cur(), st.clientWidth * .62, st.clientHeight * .9, 0);
        await wait(700);
        await HW_RUN[c.kind](h, c);
        await wait(1300); q('.hw-done').classList.add('on2'); await wait(2800);
        if (++loops === 1) cnEv('howto', prov + ':end');
      }
    } catch (e) { running = false; }
  }
  st.onclick = () => { if (!running) return; paused = !paused; st.classList.toggle('paused', paused); };
  const start = () => { if (running) return; cnEv('howto', prov); run(); };
  const play = el.querySelector('.hw-play');
  // Bei „Bewegung reduzieren“ nicht von selbst starten
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    st.innerHTML = hwStage(prov); h.scene('ours');
    play.hidden = false; play.onclick = () => { play.hidden = true; start(); };
  }
  new IntersectionObserver(es => { vis = es[0].isIntersecting; if (vis && play.hidden) start(); }, { threshold: .5 }).observe(st);
}
/** Beispielmodelle auf den Kacheln — Namen sind sprachneutral. */
const CN_EX = { anycubic: 'Kobra S1, Kobra 3, Kobra X', bambu: 'X1, P1, A1, H2D', creality: 'K1, K2, Ender-3 V3, Hi', elegoo: 'Centauri Carbon 2',
  prusa: 'MK4S, MK3.9, Core One, XL, MINI+', moonraker: 'Voron, Qidi, Sovol, Snapmaker U1', octoprint: 'Ender 3, Prusa MK3, Ultimaker 2', lan: 'Qidi, Sovol, Neptune 4, Flashforge (ZMOD)' };
/** Freitext aus „Drucker fehlt?“ → [Anschluss, Marke, Hinweis-Schlüssel?], wenn wir ihn schon können. Reihenfolge zählt („Kobra X1“ ist Anycubic,
 *  „Neptune 4“ ist Klipper); Harzdrucker (Photon, Saturn, Mars) bewusst nie. */
// Tippfehler in Markennamen („bambi“, „anycubik“, „pursa“) auf den Namen ziehen, damit „schon unterstützt“ greift
// (09.10.2026, Anfrage #32 „bambi“ = Bambu Lab ging als neue Anfrage durch). Nur Marken ab 5 Buchstaben — kurze
// Modellwörter (ender, kobra) träfen sonst normale Wörter („under“). Abstand mit Vertauschung (pursa → prusa = 1).
const CN_BRANDS = ['bambu', 'bambulab', 'anycubic', 'elegoo', 'creality', 'prusa', 'voron', 'sovol', 'flashforge', 'snapmaker', 'klipper', 'octoprint', 'moonraker', 'easythreed', 'kingroon'];
function cnDist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function cnFixTypos(s) {
  return s.replace(/\p{L}{4,}/gu, w => {
    const l = w.toLowerCase(); if (CN_BRANDS.includes(l)) return w;
    let best = null, bd = 9;
    for (const b of CN_BRANDS) { const x = cnDist(l, b); if (x < bd) { bd = x; best = b; } }
    return bd <= (l.length >= 7 ? 2 : 1) ? best : w;
  });
}
function cnKnownBrand(txt) {
  // Harz (Elegoo Mars/Saturn, Anycubic Photon …) geht nicht. \b stand hier als echtes Backspace-Zeichen in der Datei,
  // „mars“ und „sla“ griffen dadurch nie (09.10.2026)
  if (/photon|saturn|\bmars\b|resin|\bsla\b|harz/i.test(String(txt || ''))) return null;
  const s = cnFixTypos(String(txt || ''));
  for (const [re, prov, brand, mk] of [
    // Flashforge nur mit Community-Firmware ZMOD (Moonraker) über die Brücke — Original-Firmware nicht (08.10.2026).
    // „adventure 5m“ ohne r ging als neue Anfrage durch (18.10.2026, Anfrage #43)
    [/flash ?forge|\bad5[mx]\b|\badx5\b|adventurer? ?5/i, 'lan', 'Flashforge', 'cn_req_ff'],
    // Marlin ohne WLAN anderer Marken (Anycubic, Elegoo Neptune 1–3, Sovol SV01–06) → OctoPrint per USB — sonst „schon unterstützt“
    // über die Cloud bzw. Klipper (08.10.2026, Prüfung des Ablaufs); wer Klipper/OctoPrint dazuschreibt, kommt zu den Regeln unten.
    // „Neptune Pro 3“ (Pro vor der Zahl), „Neptune 2S“ und „Neptun“ ohne e gingen als neue Anfrage durch (28.10.2026, Anfrage #57)
    [/^(?!.*(klipper|moonraker|mainsail|fluidd|octo)).*(\bi3 ?mega|\bmega ?(x|s|zero|pro)\b|\bvyper\b|\bchiron\b|[kc]obra ?(2 ?)?neo\b|[kc]obra ?go\b|neptune? ?((pro|plus|max) ?)?([1-3][sd]?|x)\b|\bsv0?[1-6]\b)/i,
      'octoprint', 'Marlin', 'cn_req_marlin'],
    // Easythreed (K7, X1 …): kein WLAN, druckt aber per USB aus Cura → ebenfalls OctoPrint (20.10.2026, Anfrage #46);
    // „easythread“ und „easy 3d“ schreiben die Leute auch
    [/^(?!.*(klipper|moonraker|mainsail|fluidd|octo)).*\beasy[\s-]*(thre+a?d|3d)\b/i, 'octoprint', 'Easythreed', 'cn_req_marlin'],
    // Kingroon (Anfrage #52, 24.10.2026): KLP1 und KP3S Pro V2 haben ab Werk Klipper, KP3/KP3S/KP5L sind Marlin ohne WLAN;
    // bei nur „Kingroon“ nennt der Hinweis beide Wege, der Knopf öffnet OctoPrint
    [/\bklp ?1\b|\bkp3s? ?pro ?v2\b/i, 'moonraker', 'Kingroon'],
    [/^(?!.*(klipper|moonraker|mainsail|fluidd|octo)).*(kingroon|\bkp3s?\b|\bkp5l?\b)/i, 'octoprint', 'Kingroon', 'cn_req_kingroon'],
    // „Cobra 3 v2“ (Anfrage #51, 22.10.2026) — Kobra wird oft mit C geschrieben
    [/anycubic|[kc]obra/i, 'anycubic', 'Anycubic'],
    [/neptune? ?((pro|plus|max) ?)?4|voron|qidi|sovol|snapmaker ?u1|klipper|moonraker|mainsail|fluidd|rinkhals/i, 'moonraker', 'Klipper'],
    [/bambu|\bbamb|\bh2[ds]\b|\bp1[ps]\b|\bp2s\b|\ba1\b|\bx1c?\b/i, 'bambu', 'Bambu Lab'],
    // „CC2c“ allein (Centauri Carbon 2 Combo) ging als neue Anfrage durch (09.11.2026, Anfrage #76)
    [/elegoo|centauri|\bcc ?2 ?c?\b/i, 'elegoo', 'Elegoo'],
    // Ender ohne WLAN (V3 SE, S1, Pro, V2 …) kommen nie in die Creality Cloud → OctoPrint per USB (08.10.2026, Anfrage #30);
    // V3, V3 KE, V3 Plus, Ender-5 Max und CR-10 SE haben Creality OS mit WLAN
    [/v3[\s-]*(ke|plus\b|\+)|ender[\s-]*5[\s-]*max|cr[\s-]*10[\s-]*(se|smart)\b/i, 'creality', 'Creality'],
    [/ender[\s-]*3[\s-]*v3[\s-]*se\b|\bv3[\s-]*se\b/i, 'octoprint', 'Creality', 'cn_req_marlin'],
    [/ender[\s-]*3[\s-]*v3\b/i, 'creality', 'Creality'],
    [/\bender[\s-]*\d|\bcr[\s-]*(10|6)\b/i, 'octoprint', 'Creality', 'cn_req_marlin'],
    [/creality|ender|\bk1|\bk2\b/i, 'creality', 'Creality'],
    [/prusa|\bmk3|\bmk4|core ?one/i, 'prusa', 'Prusa'],
    [/octoprint|octopi/i, 'octoprint', 'OctoPrint'],
  ]) if (re.test(s)) return [prov, brand, mk];
  return null;
}
// Papierdrucker (Anfrage #59 „HP Officejet Pro 8600 Plus“, 29.10.2026, schon der dritte): Marken ohne 3D-Drucker für zu Hause,
// ihre Baureihen und „Tintenstrahl-/Laserdrucker“ in den 6 Sprachen. „Laser“ allein nicht (Lasergravierer); wer 3D, FDM oder
// Filament dazuschreibt, geht normal durch (HP Jet Fusion 3D ist ein echter, wenn auch industrieller 3D-Drucker)
function cnPaperPrinter(txt) {
  const s = String(txt || '');
  if (/\b3d\b|\bfdm\b|filament|klipper|marlin|octo|moonraker/i.test(s)) return false;
  return /\b(hp|hewlett|epson|canon|brother|lexmark|kyocera|xerox|ricoh|oki|konica|dymo|phomemo|niimbot)\b|officejet|deskjet|laserjet|pagewide|smart ?tank|\benvy\b|ecotank|workforce|pixma|maxify|megatank|imageclass|i-?sensys|selphy|\b(mfc|dcp)[\s-]?[a-z]{0,2}\d|\bhl[\s-]?l?\d{3,4}|inkjet|ink ?tank|tintenstrahl|tintendrucker|laser ?(printer|drucker)|jet d.encre|inyecci[oó]n de tinta|getto d.inchiostro|(imprimante|impresora|stampante|printer) (laser|láser)|etikettendrucker|label ?printer/i.test(s);
}
async function viewConnect_3ds() {
  clearInterval(cn.poll); clearInterval(cn.brwatch); clearInterval(cn.brpoll);
  const d = await get('connections');
  const bm = prov => {
    // Lesezeichen holt den Token auf der Herstellerseite und schickt ihn im #-Fragment zurück (kein Server-Log)
    // Mit Geheimzahl dieses Browsers: ein fremder Link #connect/anbieter=<Token des Angreifers> wird sonst als eigener
    // Token vorausgefüllt — ein Klick, und das Cloud-Konto des Angreifers hinge im Konto des Opfers (06.10.2026)
    const back = 'https://3dsearch.net/filament/#connect/' + prov + '=' + bmNonce() + '.';
    const get_ = { anycubic: 'var t=localStorage.getItem("XX-Token");',
      bambu: 'var m=document.cookie.match(/(?:^|; )token=([^;]+)/),t=m?m[1]:"";',
      creality: 'var c=document.cookie,a=c.match(/model_token=([^;]+)/),b=c.match(/model_user_id=([^;]+)/),t=a&&b?a[1]+"|"+b[1]:"";' }[prov];
    const miss = S[{ anycubic: 'pc_bm_missing_ac', bambu: 'pc_bm_missing_bb', creality: 'pc_bm_missing_cr' }[prov]];
    const js = '(function(){' + get_ + 'if(!t){alert(' + JSON.stringify(miss) + ');return}location.href=' + JSON.stringify(back) + '+encodeURIComponent(t)})()';
    return `<a class="bm" href="javascript:${esc(encodeURIComponent(js))}">3DSEARCH: ${PROV_NAME[prov]}</a>`;
  };
  const steps = arr => `<ol class="steps">${arr.map(s => `<li>${s}</li>`).join('')}</ol>`;
  const link = (u, l) => `<a href="${u}" target="_blank" rel="noopener">${l}</a>`;
  const consent = prov => consentBox(prov, d.consent_cc);
  // Häkchen steht über beiden Wegen (bmWays) und gehört per form="tf_…" trotzdem zu diesem Formular
  const tokForm = (act, prov, ph) => `<form class="tokform" data-a="${act}" id="tf_${prov}"><textarea class="in" name="token" id="tok_${prov}" required placeholder="${ph}" autocomplete="off" spellcheck="false" rows="3"></textarea>
    <div><button class="btn pri">${S.pc_connect_btn}</button></div></form>`;
  // Lesezeichen + Entwicklertools + Token-Feld; am Handy zuerst „Link per E-Mail“, die Anleitung eingeklappt darunter
  const bmWays = (prov, siteStep, devSteps, form) => {
    const cb = consent(prov).replace('<input ', `<input form="tf_${prov}" data-bmc="${prov}"${bmConsentGet(prov) ? ' checked' : ''} `);
    const ways = hwHtml(prov === 'bambu' ? '' : prov) + (cb ? `<div class="bm-consent">${cb}<p class="hint">${esc(t('bm_consent_first'))}</p></div>` : '')
      + `<p class="way">${S.pc_way_bm}</p>${steps([t('bm_step1', { k: esc(t(BM_MAC ? 'bm_keys_mac' : 'bm_keys')), b: bm(prov) }), siteStep, S.pc_bm_step3])}
        <p class="way">${S.pc_way_dev}</p>${steps(devSteps)}${form}`;
    if (!BM_TOUCH) return ways;
    return `<div class="note bm-mobile"><b>${esc(t('bm_mob_h'))}</b><p>${esc(t('bm_mob_p'))}</p>
      <button type="button" class="btn pri" data-bmmail="${prov}">${esc(t('bm_mob_btn'))}</button><div class="bm-mob-res"></div></div>
      <details class="bm-more"><summary>${esc(t('bm_mob_more'))}</summary>${ways}</details>`;
  };
  let h = prHead('connect') + `<p class="lead">${S.pc_intro}</p><div id="cmsg">${cn.msg ? msgBox(esc(S[cn.msg[0]] || cn.msg[0]), cn.msg[1]) : ''}</div>`;
  cn.msg = null; const bbTfa = cn.bbTfa; cn.bbTfa = false;
  // Verbindungen (05.10.2026 neu geordnet): oben die bestehenden, darunter Hersteller-Kacheln — ein Klick öffnet nur deren Anleitung
  let hc = '', tiles = '', panels = '';
  const CAP = { anycubic: ['cloud', 'print'], bambu: ['cloud', 'read'], creality: ['cloud', 'test'], elegoo: ['cloud', 'read'], prusaconnect: ['cloud', 'read'], moonraker: ['agent', 'print'], octoprint: ['agent', 'print'], prusa: ['bridge', 'print'], lan: ['bridge', 'print'] };
  if (cn.tokenFill) cn.open = cn.tokenFill[0];
  else if (d.bb_pending) cn.open = 'bambu';
  else if (d.br_code && !d.bridges.length) cnBrOrigin(d.br_code);
  else if (d.mr_code && !d.conns.moonraker && cn.open !== 'octoprint') cn.open = 'moonraker';
  // OctoPrint läuft über denselben Agenten (Anschluss „moonraker“) — eigene Kachel nur für die Anleitung
  // Prusa und „Im Heimnetz“ laufen über die Brücke (Agent im Brückenmodus) — auch nur Kacheln mit Anleitung
  for (const prov of ['anycubic', 'bambu', 'creality', 'elegoo', 'prusaconnect', 'prusa', 'moonraker', 'octoprint', 'lan']) {
    const c = d.conns[prov];
    // Bambu (11.11.2026, User: „nehmen wir derweil raus“): Cloudflare sperrt unseren Server bei Bambu → kein neues Verbinden,
    // bestehende Verbindungen behalten ihre Karte (Sperrhinweis + Trennen). Assistent zeigt stattdessen pc_bb_off + App-Weg.
    if (prov === 'bambu' && !c) continue;
    if (['moonraker', 'octoprint', 'prusa', 'lan'].includes(prov) && !c && !d.mr_visible) continue;
    if (c) {
      // Klipper: Zustand und Zeit von den Agenten — die Server-Zeile gleicht immer fehlerfrei ab, „Verbunden“ stand auch da,
      // wenn der Agent seit Tagen schwieg (Donnie, U1 nach Stromausfall, 21.10.2026)
      const mrOff = prov === 'moonraker' && d.agents.length > 0 && !d.agents.some(ag => ag.online);
      const syncAt = prov === 'moonraker' && d.agents.length ? d.agents.map(ag => ag.last_push_at || '').sort().pop() || null : c.last_sync_at;
      const bad = c.error || mrOff;
      hc += `<section class="ccard cdone" data-conn="${prov}"><div class="conn-bar" style="margin:0"><b>${prov === 'moonraker' ? t('prov_moonraker') : PROV_NAME[prov]}</b><span class="pstate ${bad ? 'off' : 'idle'}"><span class="dot ${bad ? '' : 'idle'}"></span>${c.error ? t('cn_err') : mrOff ? t('cn_mr_off') : t('cn_ok')}</span><span>${t('pr_last_sync', { t: ago(syncAt) })}</span>
        ${c.token_exp ? `<span>· ${S.pc_token_valid} ${date(c.token_exp)}</span>` : ''}<span class="grow"></span>
        <span class="cbtns"><button class="btn sm" data-c="sync">${t('pr_refresh')}</button><button class="btn sm danger" data-c="disconnect" data-prov="${prov}">${S.pc_disconnect_btn}</button></span></div>
        ${c.error && !c.auth_failed ? msgBox(c.blocked ? esc(S.pc_bb_blocked || '') + bbAlt() : `${S.pc_sync_error}<br><small>${esc(c.error)}</small>`, true) : ''}
        ${(d.consent_missing || []).includes(prov) ? consentAsk(prov, d.consent_cc) : ''}
        ${!c.printers.length && !(c.hidden || []).length && !c.error ? `<p class="hint">${S.pc_no_printers}</p>` : ''}`;
      if (prov === 'moonraker') {
        hc += `<div class="agents">${d.agents.map(ag => `<div class="agent"><span class="dot ${ag.online ? 'idle' : ''}"></span><b>${esc(ag.name)}</b>
          <span class="hint">${t('pr_last_sync', { t: ago(ag.last_push_at) })}${ag.version ? ' · Agent ' + esc(ag.version) : ''}</span><span class="grow"></span>
          <button class="lnk" data-c="mr_remove" data-agent="${ag.id}">${S.pc_mr_remove}</button></div>`).join('')}</div>
          <div class="mrbox">${mrInstall(d)}</div>
          <details class="uninst"><summary>${t('cn_uninstall')}</summary><p class="hint">${tf('pc_mr_uninstall', `<code class="cmd-inline">${esc(d.mr_uninstall)}</code>`)}</p></details>`;
      } else {
        // Wie die Klipper-Zeilen: jeder Drucker einzeln entfernbar (Konto liefert immer alle → ausblenden, 11.10.2026)
        if (c.printers.length) hc += `<div class="agents">${c.printers.map(p => `<div class="agent"><span class="dot ${!p.online ? '' : p.busy ? 'busy' : 'idle'}"></span><b>${esc(p.name)}</b><span class="grow"></span>
          <button class="lnk" data-c="printer_remove" data-prov="${prov}" data-pid="${esc(p.id)}" data-name="${esc(p.name)}">${S.pc_mr_remove}</button></div>`).join('')}</div>`;
        if ((c.hidden || []).length) hc += `<p class="hint">${esc(t('pr_hidden'))} ${c.hidden.map(p => `${esc(p.name)} (<button class="lnk" data-c="printer_unhide" data-prov="${prov}" data-pid="${esc(p.id)}">${esc(t('pr_unhide'))}</button>)`).join(' · ')}</p>`;
      }
      // Anmeldung abgelaufen/abgelehnt: hier neu anmelden statt trennen. Trennen löschte die Verbindung, Drucke aus der Ausfallzeit
      // galten danach als „vor dem Verbinden“ und wurden nie abgebucht (08.10.2026). Das Speichern aktualisiert die bestehende Zeile.
      // Panel auch bei Rückkehr vom Lesezeichen und beim Link aus der Warnmail (cn.open = Anbieter) — vorher gab es dort keins.
      const renew = prov !== 'moonraker' && (c.auth_failed || cn.open === prov);
      if (c.auth_failed) hc += `<div class="note err-note">${esc(t('cn_renew_p', { b: PROV_NAME[prov] || prov }))}
        <div style="margin-top:8px"><button type="button" class="btn sm pri" data-open="${prov}">${esc(t('cn_renew_btn'))}</button></div></div>`;
      hc += `</section>`;
      if (!renew) continue;
    }
    panels += `<section class="ccard cpanel" data-prov="${prov}"${cn.open === prov ? '' : ' hidden'}><h2 style="margin-top:0">${tf('pc_connect_prov', PROV_NAME[prov] || t('br_lan_name'))}${['moonraker', 'octoprint', 'creality', 'elegoo', 'prusa', 'prusaconnect', 'lan'].includes(prov) ? ' <span class="tag">Beta</span>' : ''}</h2>`;
    if (prov === 'prusa' || prov === 'lan') {
      panels += brPanel(d, prov);
    } else if (prov === 'moonraker' || prov === 'octoprint') {
      const op = prov === 'octoprint';
      panels += `<p class="hint">${op ? S.pc_op_intro : S.pc_mr_intro}</p><div class="mrbox">${mrInstall(d, op)}</div>
        <p class="hint">${op ? S.pc_op_note : S.pc_mr_note} ${tf('pc_mr_source', link('/api/agent.py', 'agent.py'), link('/api/agent.sh', 'agent.sh'))}</p>`;
    } else if (prov === 'anycubic' || prov === 'creality') {
      const site = prov === 'anycubic' ? link('https://cloud-universe.anycubic.com/file', 'cloud-universe.anycubic.com') : link('https://www.crealitycloud.com/', 'crealitycloud.com');
      const cmd = prov === 'anycubic' ? '<code>window.localStorage["XX-Token"]</code>'
        : '<code>document.cookie.match(/model_token=([^;]+)/)[1]+"|"+document.cookie.match(/model_user_id=([^;]+)/)[1]</code>';
      if (prov === 'creality') panels += `<p class="hint">${S.pc_cr_untested}</p>`;
      panels += bmWays(prov, tf('pc_step1', site), [tf('pc_step1', site), S.pc_step2, tf('pc_step3', cmd), S.pc_step4],
          tokForm(prov === 'anycubic' ? 'ac_connect' : 'cr_connect', prov, prov === 'anycubic' ? 'eyJ0eXAiOiJKV1Qi…' : 'a1b2c3…|1234567890'))
        + `<p class="hint">${prov === 'creality' ? S.pc_cr_note : S.pc_token_note}</p>`;
    } else if (prov === 'elegoo') {
      // Elegoo (nur lesend): Anmeldung mit E-Mail + Passwort des Elegoo-Kontos; gespeichert werden nur die Tokens
      panels += `<p class="hint">${S.pc_el_intro}</p>${hwHtml('elegoo')}<form class="stack" data-a="el_connect">
        <label class="fld"><span>${S.pc_el_email}</span><input class="in" type="email" name="email" required autocomplete="off" placeholder="name@example.com"></label>
        <label class="fld"><span>${S.pc_el_password}</span><input class="in" type="password" name="password" required autocomplete="new-password"></label>
        ${consent('elegoo')}<div><button class="btn pri">${S.pc_connect_btn}</button></div></form><p class="hint">${S.pc_el_note}</p>`;
    } else if (prov === 'prusaconnect') {
      // Prusa Connect (08.10.2026): Prusa-Konto (E-Mail + Passwort), bei 2FA zweiter Schritt mit dem Code; gespeichert werden nur Tokens
      panels += `<p class="hint">${esc(t('pc_pcn_intro'))}</p>${hwHtml('prusaconnect')}<form class="stack" data-a="pcn_connect">
        <label class="fld"><span>${esc(t('pc_pcn_email'))}</span><input class="in" type="email" name="email" required autocomplete="off" placeholder="name@example.com"></label>
        <label class="fld"><span>${S.pc_el_password}</span><input class="in" type="password" name="password" required autocomplete="new-password"></label>
        <details class="pcn-social"><summary>${esc(t('pc_pcn_social_h'))}</summary><p class="hint">${esc(t('pc_pcn_social_p'))} <a href="https://account.prusa3d.com/" target="_blank" rel="noopener">account.prusa3d.com</a></p></details>
        <div><button class="btn pri">${S.pc_connect_btn}</button></div></form>
        <form class="stack" data-a="pcn_otp" hidden><p class="hint">${esc(t('pc_pcn_otp_p'))}</p>
        <label class="fld"><span>${esc(t('pc_pcn_otp_h'))}</span><input class="in" name="otp" required autocomplete="one-time-code" autocapitalize="off" spellcheck="false" maxlength="12" placeholder="123456" style="max-width:200px"></label>
        <div><button class="btn pri">${esc(t('pc_pcn_otp_btn'))}</button></div></form>
        <p class="hint">${esc(t('pc_pcn_note'))}</p>`;
    } else if (!d.bb_pending) {
      panels += `<p class="hint">${S.pc_bb_intro}</p><form class="inline" data-a="bb_send_code"><input class="in grow" type="email" name="email" required autocomplete="email" placeholder="name@example.com">
        ${consent('bambu')}<button class="btn pri">${S.pc_bb_send_code}</button></form>
        <details class="bbtfa"${(cn.tokenFill && cn.tokenFill[0] === 'bambu') || bbTfa ? ' open' : ''}><summary class="way">${S.pc_bb_tfa_way}</summary>
          ${bmWays('bambu', tf('pc_bb_tok_step1', link('https://bambulab.com/en/sign-in', 'bambulab.com')),
            [tf('pc_bb_tok_step1', link('https://bambulab.com/en/sign-in', 'bambulab.com')), S.pc_bb_tok_step2, tf('pc_bb_tok_step3', '<code>token</code>')],
            tokForm('bb_token', 'bambu', 'eyJhbGciOi…'))}</details><p class="hint">${S.pc_token_note}</p>`;
    } else {
      panels += `<p class="hint">${d.bb_pending.tfa ? S.pc_bb_tfa : tf('pc_bb_enter_code', '<b>' + esc(d.bb_pending.email) + '</b>')}</p>
        <form class="inline" data-a="bb_code"><input class="in" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123456" style="max-width:160px">
        <button class="btn pri">${S.pc_connect_btn}</button></form><button class="lnk" data-c="bb_cancel" style="margin-top:8px">${S.pc_bb_restart}</button>`;
    }
    panels += `</section>`;
  }
  // Brücken im Heimnetz: Zustand, Drucker darüber, neu suchen, entfernen
  for (const b of d.bridges || []) {
    hc += `<section class="ccard cdone"><div class="conn-bar" style="margin:0"><b>${t('br_bridge')}: ${esc(b.name)}</b><span class="pstate ${b.online ? 'idle' : 'off'}"><span class="dot ${b.online ? 'idle' : ''}"></span>${b.online ? t('cn_ok') : t('br_offline')}</span>
      <span>${t('pr_last_sync', { t: ago(b.last_seen_at) })}${b.version ? ' · Agent ' + esc(b.version) : ''}</span><span class="grow"></span>
      <span class="cbtns"><button class="btn sm" data-c="br_scan" data-bridge="${b.id}"${b.scanning ? ' disabled' : ''}>${b.scanning ? t('br_scanning_short') : t('br_scan_btn')}</button>
      <button class="btn sm danger" data-c="br_remove" data-bridge="${b.id}">${t('br_remove')}</button></span></div>
      ${b.errors && b.errors.length ? msgBox(esc(t('br_task_failed', { e: b.errors[0].error })), true) : ''}
      <p class="hint">${b.printers.length ? t('br_printers_via', { n: b.printers.length }) + ' ' + b.printers.map(p => esc(p.name)).join(', ') : t('br_no_printers')}</p>
      <details class="uninst"><summary>${t('br_uninstall')}</summary><p class="hint">${tf('pc_mr_uninstall', `<code class="cmd-inline">${esc(b.docker ? d.br_docker_uninstall : d.br_uninstall)}</code>`)}</p></details></section>`;
  }
  if (hc) h += `<h2 class="csec">${t('cn_connected')}</h2>${hc}`;
  const listLink = `<a href="/supported-printers.php" target="_blank" rel="noopener">${esc(t('cn_list_link'))} →</a>`;
  h += `<div id="wz"></div>${panels}`;
  h += `<section class="ccard" id="preq"><h2 style="margin-top:0">${S.pc_req_h}</h2><p class="hint">${S.pc_req_p}</p><p class="hint cn-list">${listLink}</p>
    <form class="stack" data-a="printer_request"><label class="fld"><span>${S.pc_req_model}</span><input class="in" name="model" required minlength="2" maxlength="150" placeholder="${esc(S.pc_req_model_ph)}"></label>
    <label class="fld"><span>${S.pc_req_note}</span><textarea class="in" name="note" maxlength="1000" rows="2" placeholder="${esc(S.pc_req_note_ph)}"></textarea></label>
    <div><button class="btn pri">${S.pc_req_send}</button></div></form></section>`;
  view.innerHTML = h;
  bindConsent(view, () => viewConnect());

  // ── Assistent: 1 Marke, 2 Weg (entfällt bei nur einem), 3 Anleitung = das Panel des Wegs ──
  if (cn.open && !cn.brand) cn.brand = WZ_OF[cn.open] || null;
  const wayOk = p => !!d.conns[p] || !!view.querySelector(`.cpanel[data-prov="${p}"]`);
  const brandName = b => b[1] || t('wz_' + b[0]);
  const wayTitle = p => ({ moonraker: t('wz_w_agent'), octoprint: t('wz_w_octo'), lan: t('wz_w_bridge'), prusa: t('wz_w_bridge') })[p] || t('wz_w_cloud', { b: PROV_NAME[p] });
  const wayDesc = p => ({ moonraker: t('wz_d_agent'), octoprint: t('wz_d_octo'), lan: t('wz_d_bridge'), prusa: t('wz_d_prusa') })[p] || t('wz_d_cloud', { b: PROV_NAME[p] });
  const stepH = (n, txt) => `<div class="wz-h"><b>${n}</b><span>${txt}</span></div>`;
  function wzDraw() {
    const b = WZ_BRANDS.find(x => x[0] === cn.brand), other = cn.brand === 'other';
    const ways = b ? b[3].filter(([p]) => wayOk(p)) : [];
    let w = `<h2 class="csec">${t('cn_add')}</h2>`;
    if (!b && !other) {
      w += `<section class="wz-step">${stepH(1, t('wz_s1'))}<div class="ptiles">`
        + WZ_BRANDS.map(x => `<button type="button" class="ptile" data-brand="${x[0]}"><b>${esc(brandName(x))}</b><span class="ex">${esc(t('cn_ex', { m: x[2] }))}</span></button>`).join('')
        + `<button type="button" class="ptile" data-brand="other"><b>${esc(t('wz_other'))}</b><span class="ex">${esc(t('wz_other_d'))}</span></button></div>
        <p class="hint cn-list"><a href="/supported-printers.php" target="_blank" rel="noopener">${esc(t('cn_list_link'))} →</a></p></section>`;
    } else {
      w += `<div class="wz-done">${stepH(1, esc(other ? t('wz_other') : brandName(b)))}<button type="button" class="lnk" data-wz="brand">${esc(t('wz_change'))}</button></div>`;
      if (other) {
        w += `<section class="wz-step">${stepH(2, t('wz_s2'))}<p class="hint">${esc(t('wz_other_p'))}</p><button type="button" class="btn pri" data-wz="req">${esc(t('wz_other_btn'))}</button></section>`;
      } else if (!ways.length && cn.brand === 'bambu') {
        w += `<section class="wz-step">${stepH(2, t('wz_s2'))}<div class="note">${esc(S.pc_bb_off || S.pc_bb_blocked_login || '')}${bbAlt()}</div></section>`;
      } else if (!cn.open || !ways.some(([p]) => p === cn.open)) {
        w += `<section class="wz-step">${stepH(2, t('wz_s2'))}<div class="wz-ways">` + ways.map(([p, note], i) => {
          const done = !!d.conns[p];
          return `<button type="button" class="wz-way${done ? ' done' : ''}" data-way="${p}">
            <span class="wz-wt"><b>${esc(wayTitle(p))}</b>${i === 0 && ways.length > 1 ? `<span class="tag on">${esc(t('wz_rec'))}</span>` : ''}<span class="cap ${CAP[p][1]}">${esc(t('cn_cap_' + CAP[p][1]))}</span></span>
            <span class="hint">${esc(wayDesc(p))}</span>${note ? `<span class="hint wz-note">${esc(t(note))}</span>` : ''}
            ${done ? `<span class="hint ok-t">✓ ${esc(t('wz_connected'))}</span>` : ''}</button>`;
        }).join('') + `</div></section>`;
      } else {
        const note = (ways.find(([p]) => p === cn.open) || [])[1];
        w += `<div class="wz-done">${stepH(2, esc(wayTitle(cn.open)))}${ways.length > 1 ? `<button type="button" class="lnk" data-wz="way">${esc(t('wz_other_way'))}</button>` : ''}</div>
          ${note ? `<div class="note">${esc(t(note))}</div>` : ''}<div class="wz-h wz-h3"><b>3</b><span>${esc(t('wz_s3'))}</span></div>`;
      }
    }
    $('#wz').innerHTML = w;
    view.querySelectorAll('.cpanel').forEach(p => { p.hidden = !b || p.dataset.prov !== cn.open; });
    if (b && cn.open) cnEv('panel', cn.open);
    $('#wz').querySelectorAll('[data-brand]').forEach(x => x.onclick = () => {
      cn.brand = x.dataset.brand; cnEv('brand', cn.brand);
      const bb = WZ_BRANDS.find(y => y[0] === cn.brand), ws = bb ? bb[3].filter(([p]) => wayOk(p)) : [];
      cn.open = ws.length === 1 && !d.conns[ws[0][0]] ? ws[0][0] : null;   // nur ein Weg → gleich zur Anleitung
      wzDraw(); $('#wz').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    $('#wz').querySelectorAll('[data-way]').forEach(x => x.onclick = () => {
      const p = x.dataset.way;
      if (d.conns[p]) { const c = view.querySelector(`[data-conn="${p}"]`); if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      cn.open = p; wzDraw();
      const pan = view.querySelector(`.cpanel[data-prov="${p}"]`); if (pan) pan.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    $('#wz').querySelectorAll('[data-wz]').forEach(x => x.onclick = () => {
      if (x.dataset.wz === 'brand') { cn.brand = null; cn.open = null; wzDraw(); }
      else if (x.dataset.wz === 'way') { cn.open = null; wzDraw(); }
      else if (x.dataset.wz === 'req') { $('#preq').scrollIntoView({ block: 'center', behavior: 'smooth' }); $('#preq [name=model]').focus({ preventScroll: true }); }
    });
  }
  wzDraw();
  view.querySelectorAll('.hw').forEach(hwMount);
  cnEv('open',Object.keys(d.conns).length || d.agents.length ? 'has' : 'new');

  const show = (key, err) => { $('#cmsg').innerHTML = msgBox(esc(S[key] || t('err_generic')), err); $('#cmsg').scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  // Gefundenen Drucker anklicken → Formular vorausfüllen
  view.querySelectorAll('[data-fill]').forEach(b => b.addEventListener('click', () => {
    const x = JSON.parse(b.dataset.fill), f = b.closest('.cpanel').querySelector('form[data-a="br_add"]');
    f.host.value = x.host; if (f.type && f.type.tagName === 'SELECT') f.type.value = x.type; if (f.bridge) f.bridge.value = x.bridge;
    if (x.name && f.name && !f.name.value) f.name.value = x.name;
    (f.password || f.apikey || f.name).focus();
  }));
  view.querySelectorAll('form[data-a]').forEach(f => f.addEventListener('submit', async e => {
    e.preventDefault();
    cnEv('submit', f.dataset.a);
    if (f.dataset.a === 'printer_request' && !f.dataset.force) {
      const hit = cnKnownBrand(f.model.value);
      // Papierdrucker kann niemand anbinden: Hinweis ohne „Trotzdem senden“, erst ein anderes Modell schickt wieder ab
      if (!hit && cnPaperPrinter(f.model.value)) {
        cnEv('hint', 'paper');
        f.querySelector('.req-known')?.remove();
        const sendRow = f.lastElementChild;
        sendRow.hidden = true;
        sendRow.insertAdjacentHTML('beforebegin', `<div class="req-known">${msgBox(esc(t('cn_req_paper')))}</div>`);
        f.model.addEventListener('input', () => { f.querySelector('.req-known')?.remove(); sendRow.hidden = false; }, { once: true });
        return;
      }
      if (hit) {
        cnEv('hint', hit[1]);
        const [prov, brand, mk] = hit, label = PROV_NAME[prov] || t('br_lan_name'), tl = wayOk(prov);
        // Ist die Verbindung über diesen Weg vorhin gescheitert, den Grund nennen — eine Anfrage hilft dann nicht (13.10.2026)
        const failed = cn.fail && cn.fail.prov === prov ? S[cn.fail.key] || t('err_generic') : null;
        f.querySelector('.req-known')?.remove();
        const sendRow = f.lastElementChild;
        sendRow.hidden = true;   // „Trotzdem senden“ ersetzt den normalen Knopf, solange der Hinweis steht
        // „Trotzdem senden“ nur mit Begründung im Notizfeld: rund die Hälfte der Wünsche betraf schon unterstützte Drucker,
        // meist brandneue Konten, die am Handy hängen blieben (17.10.2026, Kobra 3) — so kommt wenigstens das Problem mit
        const why = f.note, whyLbl = why.previousElementSibling;
        whyLbl.dataset.orig ??= whyLbl.innerHTML; why.dataset.ph ??= why.placeholder;
        const whyOn = on => {
          if (on) { whyLbl.textContent = t('cn_req_why'); why.placeholder = t('cn_req_why_ph'); why.required = true; why.minLength = 10; }
          else { whyLbl.innerHTML = whyLbl.dataset.orig; why.placeholder = why.dataset.ph; why.required = false; why.removeAttribute('minlength'); f.known?.remove(); }
        };
        whyOn(true);
        f.model.addEventListener('input', () => { f.querySelector('.req-known')?.remove(); sendRow.hidden = false; whyOn(false); }, { once: true });
        // Bambu ist gerade abgeschaltet (Cloudflare-Sperre, Kachel ausgeblendet): nicht „schon unterstützt“ sagen, sondern den
        // Grund und den Weg über die App wie im Assistenten (Gloria #3836, 17.11.2026). Kommt die Kachel zurück, gilt wieder cn_req_known.
        const bbOff = prov === 'bambu' && !tl && !failed;
        sendRow.insertAdjacentHTML('beforebegin', `<div class="req-known">${msgBox(bbOff ? esc(S.pc_bb_off || '') + bbAlt() : esc(failed ? t('cn_req_failed', { b: brand, e: failed }) : t(mk || 'cn_req_known', { b: brand, t: label })) + ampHint())}
          <div class="row">${tl ? `<button type="button" class="btn pri" data-k="open">${esc(t('cn_req_open', { t: label }))}</button>` : ''}
          <button type="button" class="btn" data-k="send">${esc(t('cn_req_send_anyway'))}</button></div></div>`);
        const box = f.querySelector('.req-known');
        box.querySelector('[data-k="send"]').onclick = () => {
          if (!f.reportValidity()) return;   // leeres Pflichtfeld: der Browser zeigt die Meldung direkt am Feld
          f.dataset.force = '1'; box.remove(); sendRow.hidden = false;
          // vorne einfügen — sendRow muss das letzte Kind bleiben; der Server schreibt den Hinweis in die Anfrage
          (f.known || f.insertAdjacentElement('afterbegin', Object.assign(document.createElement('input'), { type: 'hidden', name: 'known' }))).value = brand;
          f.requestSubmit();
        };
        if (tl) box.querySelector('[data-k="open"]').onclick = () => {
          cn.brand = brand === 'Flashforge' ? 'flashforge' : WZ_OF[prov]; cn.open = d.conns[prov] ? null : prov;
          wzDraw(); $('#wz').scrollIntoView({ block: 'start', behavior: 'smooth' });
        };
        return;
      }
    }
    const b = f.querySelector('button'); b.disabled = true;
    // Verbinden dauert 5–15 s (der Server holt gleich den ersten Abgleich). Ohne Hinweis hielt ein Nutzer das für hängend und
    // drückte weiter unten auf „Senden“ (21.10.2026, A1 mini: 10 s zwischen Code und „Verbunden“) → Knopftext + Hinweis darunter
    const wp = { ac_connect: 'anycubic', cr_connect: 'creality', el_connect: 'elegoo', pcn_connect: 'prusaconnect', pcn_otp: 'prusaconnect',
                 bb_code: 'bambu', bb_token: 'bambu' }[f.dataset.a];
    const btxt = b.textContent;
    let wait = null;
    if (wp) {
      b.textContent = t('cn_wait_btn');
      wait = Object.assign(document.createElement('p'), { className: 'hint', textContent: t('cn_wait', { b: PROV_NAME[wp] }) });
      f.insertAdjacentElement('afterend', wait);
    }
    const waitEnd = () => { if (wait) { wait.remove(); wait = null; b.textContent = btxt; } };
    try {
      const r = await api(f.dataset.a, Object.fromEntries(new FormData(f)));
      waitEnd();
      cnEv('done', f.dataset.a + (r.msg ? ':' + r.msg : ''));
      if (r.otp) { f.hidden = true; const of = f.parentNode.querySelector('form[data-a="pcn_otp"]'); of.hidden = false; of.otp.focus(); b.disabled = false; return; }
      if (r.msg === 'pc_msg_connected') { cn.fail = null; toast(S.pc_msg_connected); location.hash = 'printers'; return; }
      if (f.dataset.a === 'br_add') cn.brWatchUntil = Date.now() + 180e3;   // „erscheint in wenigen Sekunden“ — dann auch nachladen
      cn.msg = r.msg ? [r.msg, false] : null; viewConnect();
    } catch (er) {
      waitEnd();
      cnEv('fail', f.dataset.a + ':' + er.message);
      const fp = { ac_connect: 'anycubic', cr_connect: 'creality', el_connect: 'elegoo', pcn_connect: 'prusa', pcn_otp: 'prusa',
                   bb_send_code: 'bambu', bb_code: 'bambu', bb_token: 'bambu' }[f.dataset.a];
      if (fp) cn.fail = { prov: fp, key: er.message };
      // Danach gilt der angezeigte Schritt nicht mehr (Bambu-Anmeldung verworfen, Prusa-Einmalcode abgelaufen): neu zeichnen,
      // bei Bambu-2FA gleich mit aufgeklappter Token-Anleitung — vorher stand nur noch das tote Code-Feld da (08.10.2026)
      if (['pc_bb_tfa_unsupported', 'pc_bb_expired', 'pc_pcn_otp_expired'].includes(er.message)) {
        cn.msg = [er.message, true]; cn.bbTfa = er.message === 'pc_bb_tfa_unsupported'; viewConnect(); return;
      }
      b.disabled = false; show(er.message, true);
    }
  }));
  // Lesezeichen: auf unserer Seite angeklickt statt gezogen → erklären statt „keine Anmeldung gefunden“; beim Ziehen Ziel zeigen
  view.querySelectorAll('a.bm').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); bmTip(a, 'bm_click_tip'); });
    a.addEventListener('dragstart', () => bmDrop(true));
    a.addEventListener('dragend', () => { bmDrop(false); bmTip(a, 'bm_dragged'); });
  });
  view.querySelectorAll('input[data-bmc]').forEach(c => c.addEventListener('change', () => bmConsentSet(c.dataset.bmc, c.checked)));
  view.querySelectorAll('[data-bmmail]').forEach(b => b.addEventListener('click', async () => {
    const res = b.parentNode.querySelector('.bm-mob-res');
    b.disabled = true;
    try { const r = await api('bm_mail', { provider: b.dataset.bmmail }); res.innerHTML = msgBox(esc(t('bm_mob_sent', { e: r.email || '' }))); }
    catch (er) { b.disabled = false; res.innerHTML = msgBox(esc(S[er.message] || t('err_generic')), true); }
  }));
  view.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', async () => {
    const c = b.dataset.c;
    if (c === 'disconnect' && !confirm(tf('pc_disconnect_confirm_prov', PROV_NAME[b.dataset.prov]))) return;
    if (c === 'mr_remove' && !confirm(S.pc_mr_remove_confirm)) return;
    if (c === 'br_remove' && !confirm(t('br_remove_confirm'))) return;
    if (c === 'printer_remove' && !confirm(t('pr_remove_confirm', { n: b.dataset.name }))) return;
    b.disabled = true;
    try {
      if (c === 'sync') await api('printer_sync', {});
      else await api(c, { provider: b.dataset.prov, agent: +(b.dataset.agent || 0), bridge: +(b.dataset.bridge || 0), printer: b.dataset.pid || '' });
      if (c === 'br_scan') cn.brWatchUntil = Date.now() + 180e3;
      viewConnect();
    } catch (er) { b.disabled = false; show(er.message, true); }
  }));
  view.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
    cn.open = cn.open === b.dataset.open ? null : b.dataset.open;
    view.querySelectorAll('[data-open]').forEach(x => { x.classList.toggle('on', x.dataset.open === cn.open); x.setAttribute('aria-expanded', x.dataset.open === cn.open); });
    view.querySelectorAll('.cpanel').forEach(p => { p.hidden = p.dataset.prov !== cn.open; });
    const p = cn.open && view.querySelector(`.cpanel[data-prov="${cn.open}"]`);
    if (p) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }));
  view.querySelectorAll('[data-brtab]').forEach(x => x.onclick = () => {
    const box = x.closest('.cpanel');
    box.querySelectorAll('[data-brtab]').forEach(y => y.classList.toggle('on', y === x));
    box.querySelectorAll('[data-brpane]').forEach(y => { y.hidden = y.dataset.brpane !== x.dataset.brtab; });
  });
  view.querySelectorAll('.mrcopy').forEach(copy => { copy.onclick = () => navigator.clipboard.writeText(copy.parentNode.querySelector('.mrcmd').textContent).then(() => { copy.textContent = S.pc_mr_copied; }); });
  // Brücke: warten, bis sie den Code eingelöst hat — dann bleibt die Seite offen, damit der Drucker gleich dazukommt
  if (d.br_code) {
    cn.brpoll = setInterval(async () => {
      if (route().v !== 'printers' || route().sub !== 'connect') { clearInterval(cn.brpoll); return; }
      const r = await get('br_poll', { code: d.br_code }).catch(() => null);
      if (r && r.paired) { clearInterval(cn.brpoll); toast(t('br_paired')); cn.brWatchUntil = Date.now() + 180e3; viewConnect(); }
      else if (r && r.expired) { clearInterval(cn.brpoll); viewConnect(); }   // abgelaufen: wieder den Knopf statt totem Befehl
    }, 3000);
  }
  // Brücke sucht (erste Suche nach dem Koppeln dauert bis ~1 Min., die Brücke holt einen neuen Suchauftrag erst mit dem
  // nächsten Herzschlag ab): nachladen, sobald sich Fundliste oder Suchstatus ändern — sonst bliebe „sucht …“ stehen
  const brSig = x => JSON.stringify((x.bridges || []).map(b => [b.scanning, b.discovered, b.printers, b.errors]));
  if ((d.bridges || []).some(b => b.scanning) || Date.now() < cn.brWatchUntil) {
    const sig = brSig(d);
    cn.brwatch = setInterval(async () => {
      if (route().v !== 'printers' || route().sub !== 'connect') { clearInterval(cn.brwatch); return; }
      const r = await get('connections').catch(() => null);
      if (!r) return;
      if (brSig(r) !== sig) { clearInterval(cn.brwatch); viewConnect(); }
      else if (!r.bridges.some(b => b.scanning) && Date.now() >= cn.brWatchUntil) clearInterval(cn.brwatch);
    }, 5000);
  }
  // Klipper: warten, bis der Drucker den Code eingelöst hat
  if (d.mr_code) {
    cn.poll = setInterval(async () => {
      if (route().v !== 'printers' || route().sub !== 'connect') { clearInterval(cn.poll); return; }
      const r = await get('mr_poll', { code: d.mr_code }).catch(() => null);
      if (r && r.paired) { clearInterval(cn.poll); toast(S.pc_msg_connected); location.hash = 'printers'; }
      else if (r && r.expired) { clearInterval(cn.poll); viewConnect(); }
    }, 3000);
  }
  // Token aus dem Lesezeichen (#connect/anbieter=…) eintragen
  if (cn.tokenFill) {
    const [prov, raw] = cn.tokenFill; cn.tokenFill = null;
    const ta = $('#tok_' + prov), pre = bmNonce() + '.';
    // Nur Token aus einem Lesezeichen, das in DIESEM Browser erzeugt wurde; fremde/alte Links nie vorausfüllen
    if (ta && pre !== 'x.' && raw.startsWith(pre)) {
      ta.value = raw.slice(pre.length);
      ta.closest('details')?.setAttribute('open', '');
      // Häkchen schon vor dem Weg zum Hersteller gesetzt (oder keins nötig) → gleich verbinden, sonst wie bisher ausfüllen + fragen
      const cbx = view.querySelector(`input[data-bmc="${prov}"]`);
      if (cbx && bmConsentGet(prov)) cbx.checked = true;
      if (!cbx || cbx.checked) {
        bmConsentSet(prov, false);
        ta.insertAdjacentHTML('beforebegin', msgBox(esc(t('bm_auto'))));
        ta.scrollIntoView({ block: 'center' });
        ta.form.requestSubmit();
      } else {
        ta.insertAdjacentHTML('beforebegin', msgBox(esc(S.pc_bm_filled)));
        cbx.closest('.bm-consent')?.classList.add('want');
        cbx.scrollIntoView({ block: 'center' });
      }
    }
    else if (ta) { ta.insertAdjacentHTML('beforebegin', msgBox(esc(t('bm_stale')), true)); ta.scrollIntoView({ block: 'center' }); }
  }
}
// Brücke im Heimnetz (Prusa über PrusaLink, Klipper/OctoPrint über das Netz): einrichten, dann Drucker hinzufügen
function brPanel(d, prov) {
  const brs = d.bridges || [];
  let h = `<p class="hint">${t(prov === 'prusa' ? 'br_prusa_intro' : 'br_lan_intro')}</p>`;
  if (!brs.length) {
    // „Das brauchst du“ vorab (nach SimplyPrint-Vorbild, 08.10.2026): Gerät, das an bleibt; nicht das eigene Handy; keine Portfreigabe
    h += `<div class="br-need"><b>${t('br_need_h')}</b><ul><li>${t('br_need1')}</li><li>${t('br_need2')}</li><li>${t('br_need3')}</li></ul></div>` + hwHtml(prov);
    if (!d.br_code) return h + `<button class="btn pri" data-c="br_code">${t('br_setup_btn')}</button>`;
    // Zwei Wege mit demselben Code als Reiter: eine Zeile per SSH (Pi/Linux) oder Docker (NAS, Unraid, Portainer)
    const box = txt => `<div class="cmd"><code class="mrcmd">${esc(txt)}</code><button class="btn sm mrcopy" type="button">${S.pc_mr_copy}</button></div>`;
    return h + `<div class="brtabs" role="tablist"><button type="button" class="on" data-brtab="pi">${t('br_tab_pi')}</button><button type="button" data-brtab="docker">${t('br_tab_docker')}</button></div>
      <div data-brpane="pi"><ol class="steps"><li>${t('br_pi1')}</li><li>${S.pc_mr_step2}</li></ol>${box(d.br_cmd)}</div>
      <div data-brpane="docker" hidden><p class="hint">${t('br_docker_intro')}</p>${box(d.br_docker[0])}<p class="hint">${t('br_compose_or')}</p>${box(d.br_docker[1])}
        <p class="hint">${t('br_docker_hint')}</p></div>
      <ol class="steps" start="3"><li>${t('br_pi3')}</li></ol>
      <p class="hint">${S.pc_mr_code_valid}</p><div class="wait"><span class="spin"></span>${t('br_waiting')}</div>`;
  }
  const types = prov === 'prusa' ? ['prusalink'] : ['moonraker', 'octoprint'];
  const found = brs.flatMap(b => (b.discovered || []).filter(x => types.includes(x.type)).map(x => ({ ...x, bridge: b.id })));
  if (found.length) {
    h += `<p class="way">${t('br_found')}</p><div class="brfound">${found.map(x => `<button type="button" class="btn sm" data-fill="${esc(JSON.stringify(x))}"${x.added ? ' disabled' : ''}>${esc(t('br_type_' + x.type))} · ${esc(x.host)}${x.name ? ' · ' + esc(x.name) : ''}${x.added ? ' · ' + t('br_already') : ''}</button>`).join(' ')}</div>`;
  } else {
    h += `<p class="hint">${brs.some(b => b.scanning) ? t('br_scanning') : t('br_none_found')}</p>`;
  }
  const one = brs.length === 1;
  h += `<form class="stack" data-a="br_add" autocomplete="off">
    ${one ? `<input type="hidden" name="bridge" value="${brs[0].id}">` : `<label class="fld"><span>${t('br_bridge')}</span><select class="in" name="bridge">${brs.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>`}
    ${types.length === 1 ? `<input type="hidden" name="type" value="${types[0]}">` : `<label class="fld"><span>${t('br_type')}</span><select class="in" name="type">${types.map(x => `<option value="${x}">${t('br_type_' + x)}</option>`).join('')}</select></label>`}
    <label class="fld"><span>${t('br_host')}</span><input class="in" name="host" required placeholder="192.168.1.50" spellcheck="false" autocomplete="off"></label>
    ${prov === 'prusa' ? `<label class="fld"><span>${t('br_password')}</span><input class="in" type="password" name="password" required autocomplete="new-password"></label><p class="hint">${t('br_password_hint')}</p>`
                       : `<label class="fld"><span>${t('br_apikey')}</span><input class="in" name="apikey" spellcheck="false" autocomplete="off"></label><p class="hint">${t('br_apikey_hint')}</p>`}
    <label class="fld"><span>${t('br_name')}</span><input class="in" name="name" maxlength="100" placeholder="${esc(t('br_name_ph'))}"></label>
    <div><button class="btn pri">${t('br_add_btn')}</button> <button type="button" class="btn" data-c="br_scan" data-bridge="${brs[0].id}">${t('br_scan_btn')}</button></div></form>`;
  return h;
}
function mrInstall(d, op) {
  if (!d.mr_code) return `<button class="btn${d.conns.moonraker ? '' : ' pri'}" data-c="mr_code">${d.conns.moonraker ? S.pc_mr_add : S.pc_mr_show_btn}</button>`;
  // OctoPrint: SSH auf den Raspberry Pi, danach im Browser „Erlauben“ (Application Keys)
  return `<ol class="steps"><li>${op ? S.pc_op_step1 : S.pc_mr_step1}</li><li>${S.pc_mr_step2}</li></ol>
    <div class="cmd"><code class="mrcmd">${esc(d.mr_cmd)}</code><button class="btn sm mrcopy" type="button">${S.pc_mr_copy}</button></div>
    ${op ? `<ol class="steps" start="3"><li>${S.pc_op_step3}</li></ol>` : ''}<p class="hint">${S.pc_mr_code_valid}</p><div class="wait"><span class="spin"></span>${S.pc_mr_waiting}</div>`;
}

// ── Ansicht: Drucken ───────────────────────────────────────────────────────
const ps = { data: null, job: null, timer: null, machines: null, viewer: null };
/** Übergabe von der Modellseite: einmal lesen und löschen; älter als eine Stunde zählt nicht. */
function pctaTake_3ds() {
  return new Promise(res => {
    try {
      const rq = indexedDB.open('3ds_print', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('h');
      rq.onerror = () => res(null);
      rq.onsuccess = () => {
        const os = rq.result.transaction('h', 'readwrite').objectStore('h'), g = os.get('cur');
        g.onsuccess = () => { const v = g.result; os.delete('cur'); res(v && v.file && Date.now() - v.ts < 3600e3 ? v : null); };
        g.onerror = () => res(null);
      };
    } catch (e) { res(null); }
  });
}
// ── Experten-Einstellungen beim Drucken (23.10.2026, User: „alles, was die Orca-CLI hergibt, plus Stützen und mehrere STL
// auf einer Platte, aufklappbar“). Feld x_<Schlüssel> → ps_x_clean (print_slice_lib.php); leer = Standard (Druckerprofil
// bzw. Werte aus der 3MF). Gemerkt je Browser (psd_x), außer Größe und Pausen — die gelten fast immer nur für ein Modell.
const PX_SEL = {
  print_sequence: ['by layer', 'by object'],
  sparse_infill_pattern: ['grid', 'gyroid', 'honeycomb', 'cubic', 'adaptivecubic', 'triangles', 'tri-hexagon', 'rectilinear', 'line', 'lightning', 'crosshatch', '3dhoneycomb'],
  seam_position: ['aligned', 'nearest', 'back', 'random'], ironing_type: ['no ironing', 'top', 'topmost', 'solid'], fuzzy_skin: ['none', 'external', 'all'],
  support_type: ['tree(auto)', 'organic', 'normal(auto)'], support_on_build_plate_only: ['1', '0'],
  brim_type: ['auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'brim_ears', 'no_brim'],
};
const PX_GROUPS = [
  ['plate', ['scale', 'orient', 'rot', 'print_sequence', 'pause']],
  ['quality', ['layer_height', 'wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density', 'sparse_infill_pattern', 'seam_position', 'ironing_type', 'fuzzy_skin']],
  ['support', ['support_type', 'support_threshold_angle', 'support_on_build_plate_only', 'support_top_z_distance', 'support_bottom_z_distance', 'support_object_xy_distance', 'support_interface_top_layers']],
  ['adhesion', ['brim_type', 'brim_width', 'skirt_loops']],
  // Düse + Temperatur (15.11.2026, Community-Wünsche): Düse = Orca-Profil derselben Druckerreihe (p.nozzles), je Drucker gemerkt;
  // Temperaturen überschreiben das Filamentprofil nur für diesen Druck (nie gemerkt — PLA bekäme sonst die PETG-Temperatur)
  ['temp', ['nozzle', 'nozzle_temperature', 'nozzle_temperature_initial_layer', 'bed_temperature']],
];
const PX_TEMP = ['x_nozzle_temperature', 'x_nozzle_temperature_initial_layer', 'x_bed_temperature'];
const pxNzGet = key => { try { return (JSON.parse(localStorage.getItem('psd_nz') || '{}') || {})[key] || ''; } catch (e) { return ''; } };
const pxNzSet = (key, v) => { try { const o = JSON.parse(localStorage.getItem('psd_nz') || '{}') || {}; if (v) o[key] = v; else delete o[key]; localStorage.setItem('psd_nz', JSON.stringify(o)); } catch (e) { /* privates Fenster */ } };
// Zahlenfelder: [min, max, Schritt, Einheit] — dieselben Grenzen prüft der Server (PS_X_PROC)
const PX_NUM = { scale: [1, 1000, 1, '%'], wall_loops: [1, 20, 1], top_shell_layers: [0, 50, 1], bottom_shell_layers: [0, 50, 1], sparse_infill_density: [0, 100, 1, '%'],
  support_threshold_angle: [0, 90, 1, '°'], support_top_z_distance: [0, 1, 0.01, 'mm'], support_bottom_z_distance: [0, 1, 0.01, 'mm'], support_object_xy_distance: [0, 5, 0.05, 'mm'],
  support_interface_top_layers: [0, 10, 1], brim_width: [0, 30, 0.5, 'mm'], skirt_loops: [0, 10, 1],
  nozzle_temperature: [150, 350, 1, '°C'], nozzle_temperature_initial_layer: [150, 350, 1, '°C'], bed_temperature: [0, 130, 1, '°C'] };
// Schichthöhen zur Auswahl; angeboten wird nur, was das Profil des Druckers (bzw. der gewählten Düse) erlaubt — 15.11.2026 für 0,2–0,8-mm-Düsen erweitert
const PX_LH = [0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.16, 0.2, 0.24, 0.28, 0.32, 0.36, 0.4, 0.48, 0.56];
const nf2 = new Intl.NumberFormat(LANG, { maximumFractionDigits: 2 });
const pxOpt = (k, v) => S['psd_xo_' + k + '_' + String(v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')] || v;
function xPanel() {
  const fld = k => {
    const lab = esc(S['psd_x_' + k] || k);
    if (k === 'orient' || k === 'rot') return `<label class="chk row px-chk" data-px="${k}"><input type="checkbox" id="px_${k}"${k === 'orient' ? ' checked' : ''}> <span>${lab}</span></label>`;
    if (k === 'pause') return `<label class="fld px-wide" data-px="pause"><span>${lab}</span><input class="in" name="x_pause" inputmode="decimal" maxlength="60" placeholder="${esc(S.psd_x_pause_ph)}"><small class="hint" id="px_pause_h"></small></label>`;
    if (k === 'layer_height') return `<label class="fld" data-px="${k}"><span>${lab}</span><select class="in" name="x_layer_height"></select></label>`;
    if (k === 'nozzle') return `<label class="fld" data-px="nozzle"><span>${lab}</span><select class="in" name="nozzle" id="pnozzle"></select></label>`;
    if (PX_SEL[k]) return `<label class="fld" data-px="${k}"><span>${lab}</span><select class="in" name="x_${k}"><option value="">${esc(S.psd_x_def)}</option>${PX_SEL[k].map(v => `<option value="${esc(v)}">${esc(pxOpt(k, v))}</option>`).join('')}</select></label>`;
    const [mn, mx, st, u] = PX_NUM[k];
    return `<label class="fld" data-px="${k}"><span>${lab}${u ? ` (${u})` : ''}</span><input class="in" type="number" name="x_${k}" min="${mn}" max="${mx}" step="${st}" inputmode="decimal"></label>`;
  };
  return `<details class="pexp" id="pexp"><summary><span>${esc(S.psd_x_h)}</span><span class="px-n" id="pxn" hidden></span></summary>
    <p class="hint">${esc(S.psd_x_hint)}</p><div class="amp-prof" id="ampprof"></div>
    ${PX_GROUPS.map(([g, keys]) => `<div class="px-g"><h4>${esc(S['psd_x_g_' + g])}</h4>${g === 'support' ? `<p class="hint">${esc(S.psd_x_sup_hint)}</p>` : g === 'temp' ? `<p class="hint">${esc(S.psd_x_temp_hint)}</p>` : ''}<div class="fgrid">${keys.map(fld).join('')}</div></div>`).join('')}
    <button type="button" class="lnk" id="pxreset">${esc(S.psd_x_reset)}</button></details>`;
}
async function viewPrint() {
  clearTimeout(ps.timer);
  ps.src = null;   // gespeicherte Datei als Quelle (useSrc)
  view.innerHTML = `<div class="loading">${t('loading')}</div>`;
  const d = await get('print_printers'); ps.data = d;
  // Beta (seit 04.10.2026 für alle): Rückmeldungen in den Sammelthread der Druckeranbindung
  const fbLink = `<a href="/feedback.php?id=43" target="_blank" rel="noopener">${esc(S.psd_feedback_link)}</a>`;
  let h = `<h1>${S.psd_title}</h1><p class="lead">${ampSliceIntro()}</p><div class="note">${ampSliceNote()}</div>`;
  if (!d.printers.length) {
    view.innerHTML = h + `<div class="empty"><b>${esc(t('amp_no_printers'))}</b><br><br><a class="btn pri" href="#connect">${esc(t('pr_tab_connect'))}</a></div>`;
    return;
  }
  // „Drucken“ an einem Drucker der Übersicht (23.10.2026): diesen vorwählen
  const want = d.printers.findIndex(p => p.can_print && p.key === pv.printKey);
  const first = want >= 0 ? want : d.printers.findIndex(p => p.can_print);
  pv.printKey = null;
  const plates = { textured: S.psd_plate_textured, smooth: S.psd_plate_smooth };
  // „Meine Druckdateien“ (16.10.2026): gespeicherte Aufträge ohne neues Slicen nochmal drucken
  h += `<section class="step pfiles" id="pfiles"></section>`;
  h += `<form id="pf" onsubmit="return false">
  <section class="step"><div class="step-h"><b>1</b>${S.psd_printer}</div><div class="pick-grid">
    ${d.printers.map((p, i) => `<label class="pick${p.can_print ? '' : ' off'}"><input type="radio" name="printer" value="${esc(p.key)}"${i === first ? ' checked' : ''}${p.can_print ? '' : ' disabled'}>
      ${printerPic(p)}
      <span class="t"><b>${esc(p.name)}</b><span class="hint">${tf('psd_via', t('prov_' + (p.via || p.provider)))}</span>
      <span class="pstate ${!p.online ? 'off' : p.busy ? 'busy' : 'idle'}"><span class="dot ${!p.online ? '' : p.busy ? 'busy' : 'idle'}"></span>${!p.online ? t('st_offline') : p.busy ? t('st_printing') : t('st_ready')}</span>
      ${p.testers_only ? `<span class="hint tnote">${tf('psd_cr_testers', fbLink)}</span>` : !p.can_print ? `<span class="hint">${S.psd_bambu_note}</span>` : !p.machine ? `<span class="hint err-t">${S.psd_err_no_profile}</span>`
        : !p.exact ? `<span class="hint">${tf('psd_similar', esc(p.machine.replace(' 0.4 nozzle', '')))}</span>` : ''}
      ${p.beta ? `<span class="hint">${esc(t('psd_beta'))}</span>` : ''}</span></label>`).join('')}
  </div><div class="prof" id="pprof"></div></section>
  <section class="step"><div class="step-h"><b>2</b>${S.psd_model}</div>
    <p class="hint" id="phand" hidden></p><input type="hidden" name="model_id" id="pmodel">
    <label class="drop big" id="pdrop"><input type="file" name="model" id="pfile" accept=".stl,.3mf,.gcode,.gco,.g" multiple>
      <span class="dico"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></span>
      <b id="pfname">${t('drop_here')}</b><span class="hint">${S.psd_file_hint}</span><span class="btn sm">${t('choose_file')}</span></label>
    <p class="hint gcnote" id="pgcnote" hidden>${esc(S.gc_note)}</p><p class="hint gcnote" id="psrc" hidden>${esc(S.pf_src_note)}</p>
    <div class="pplates" id="pplates" hidden></div><div class="pobjs" id="pobjs" hidden></div><input type="hidden" name="skip" id="pskip" value="">
    <div class="pstls" id="pstls" hidden></div><input type="file" id="pstladd" accept=".stl" multiple hidden></section>
  <section class="step"><div class="step-h"><b>3</b>${S.psd_settings}</div>
    <div class="fld"><span>${S.psd_slot}</span></div><p class="hint pmulti" id="pmulti" hidden></p><div class="pick-grid small" id="pslots"></div><p class="hint" id="pnote" hidden></p><div class="amp-seq" id="pseq" hidden></div>
    <div class="fgrid pfgrid" id="pfgrid" style="margin-top:12px">
      <label class="fld"><span>${S.psd_plate}</span><select class="in" name="bed" id="pbed"><option value="textured">${plates.textured}</option><option value="smooth">${plates.smooth}</option></select></label>
      <label class="fld"><span>${S.psd_supports}</span><select class="in" name="supports" id="psup"><option value="project" hidden>${S.psd_sup_project}</option><option value="off">${S.psd_sup_off}</option><option value="on">${S.psd_sup_on}</option></select></label>
    </div>
    ${xPanel()}
    <div class="plevel" id="plevel" hidden><label class="chk row"><input type="checkbox" id="plevelchk"> <span>${S.psd_level}</span></label><input type="hidden" name="level" id="plevelval" value=""><p class="hint" id="plevelnote" hidden></p></div><div class="amp-cal-w" id="pcal" hidden></div>
    <datalist id="pqprojl">${(d.pq_projects || []).map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    <label class="fld pqmulti" id="pqmultiw" hidden><span>${esc(S.pq_add_proj)}</span><input class="in" id="pqproj2" list="pqprojl" maxlength="80"></label>
    <div style="margin-top:16px"><button type="button" class="btn pri" id="pslice">${S.psd_slice_btn}</button></div><div class="status" id="pstatus" hidden></div><div class="pmap" id="pmap" hidden></div></section>
  </form>
  <section class="step" id="pprev" hidden><div class="step-h"><b>4</b>${S.psd_preview}</div>
    <div class="viewer" id="pviewer"><div class="gl"><canvas></canvas><div class="zoom"><button type="button" data-z="1.25" aria-label="+">+</button><button type="button" data-z="0.8" aria-label="−">−</button></div></div>
      <div class="layer"><input type="range" min="1" max="1" value="1"><span data-layer-txt></span></div></div>
    <div class="legend" id="plegend">${[['#ff8c00', 'psd_lg_outer'], ['#ffd23f', 'psd_lg_inner'], ['#c0392b', 'psd_lg_infill'], ['#9b59f6', 'psd_lg_solid'], ['#22c55e', 'psd_lg_support'], ['#14b8a6', 'psd_lg_brim']]
      .map(([c, k]) => `<span><i style="background:${c}"></i>${S[k]}</span>`).join('')}</div>
    <p class="hint">${S.psd_drag_hint}</p>
    <div class="kpis small"><div class="kpi"><span>${S.psd_time}</span><b id="ptime">–</b></div><div class="kpi"><span>${S.psd_filament}</span><b id="pgrams">–</b></div>
      <div class="kpi"><span>${S.psd_cost}</span><b id="pcost">–</b></div><div class="kpi"><span>${S.psd_layers}</span><b id="players">–</b></div></div>
    <ul class="notes" id="pnotes"></ul></section>
  <section class="step" id="psend" hidden><div class="step-h"><b>5</b>${S.psd_send}</div>
    <label class="chk"><input type="checkbox" id="pconfirm"> <span id="pconfirmtxt"></span></label><p class="hint">${S.psd_send_note}</p>
    <div class="pkeep" id="pkeepw"><label class="chk"><input type="checkbox" id="pkeep" checked> <span>${esc(S.pf_keep)}</span></label>
      <p class="hint">${esc(t('pf_keep_note', { n: d.files_limit, s: d.files_sup }))}</p></div>
    <div class="pqadd" id="pqaddw"><label class="fld"><span>${esc(S.pq_add_proj)}</span><input class="in" id="pqproj" list="pqprojl" maxlength="80"></label></div>
    <div class="actions"><button type="button" class="btn pri" id="psendbtn" disabled>${S.psd_send_btn}</button><button type="button" class="btn" id="puploadbtn" hidden>${S.psd_upload_btn}</button>
      <button type="button" class="btn" id="pqaddbtn">${esc(S.pq_add_btn)}</button>
      <a class="btn ghost" href="#print" id="pagain">${S.psd_again}</a></div><div class="status" id="psendstatus" hidden></div></section>`;
  view.innerHTML = h;
  ps.viewer = window.FMViewer ? window.FMViewer($('#pviewer'), S) : null;
  const printer = () => { const v = (view.querySelector('input[name=printer]:checked') || {}).value; return d.printers.find(p => p.key === v); };
  // Der Kreis bleibt stehen, wenn er schon da ist (21.11.2026: poll() rief das jede Sekunde mit neuem innerHTML auf → die Drehung begann
  // jedes Mal von vorn, der Kreis „hakte“) — nur der Text daneben wird getauscht, und nur, wenn er sich geändert hat
  const status = (el, html, spin, err) => {
    el.hidden = false;
    const tx = `<span${err ? ' class="err-t"' : ''}>${html}</span>`, sp = el.firstElementChild;
    if (spin && sp && sp.classList.contains('spin') && el.children.length === 2) { if (el.lastElementChild.outerHTML !== tx) el.lastElementChild.outerHTML = tx; return; }
    el.innerHTML = (spin ? '<span class="spin"></span>' : '') + tx;
  };
  const errText = r => r.error === 'slice' ? tf('psd_err_slice', esc(r.detail || '')) : r.error === 'send' ? tf('psd_err_send', esc(r.detail || ''))
    : r.error === 'agent_failed' ? tf('psd_err_agent_failed', esc(r.detail || '')) : S['psd_err_' + r.error] ? esc(S['psd_err_' + r.error]) : tf('psd_err_generic', esc(r.error || '?'));
  const pdur = m => m >= 60 ? tf('psd_h_min', Math.floor(m / 60), m % 60) : tf('psd_min', m);

  function renderFiles(files) {
    const box = $('#pfiles'); if (!box) return;
    ps.files = files;
    const ico = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
    box.innerHTML = `<div class="step-h"><b>${ico}</b>${esc(S.pf_h)}<span class="pf-count">${esc(t('pf_count', { c: files.length, n: d.files_limit }))}</span></div>`
      + (!files.length ? `<p class="hint">${esc(t('pf_empty', { n: d.files_limit, s: d.files_sup }))}</p>`
      : `<div class="pf-list">${files.map(f => {
          const sw = (f.paint || []).map(p => `<i style="${p.color ? 'background:' + esc(p.color) : ''}" title="${esc(p.material || '')}"></i>`).join('') || '<i></i>';
          const meta = [f.printer_name, f.grams != null ? nf1.format(f.grams) + ' g' : '', f.minutes != null ? pdur(f.minutes) : '', date(f.last_used_at)].filter(Boolean).join(' · ');
          return `<div class="pf-row"><span class="pf-sw">${sw}</span><span class="t"><b>${esc(f.name)}</b><span class="hint">${esc(meta)}${f.own_gcode ? ' · G-Code' : ''}</span></span>
            <span class="pf-act"><button type="button" class="btn sm pri" data-again="${f.id}">${esc(S.pf_again)}</button><button type="button" class="btn sm ghost" data-del="${f.id}">${esc(S.pf_del)}</button></span></div>`;
        }).join('')}</div><div class="status" id="pfstatus" hidden></div>`);
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = S.pf_del_sure; b.classList.add('danger'); return; }   // zweiter Klick löscht
      b.disabled = true;
      try { await api('print_file_del', { file: +b.dataset.del }); renderFiles(ps.files.filter(f => f.id !== +b.dataset.del)); } catch (e) { b.disabled = false; fail(e); }
    }));
    box.querySelectorAll('[data-again]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; status($('#pfstatus'), esc(S.pf_loading), true);
      const r = await fetch('api.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ a: 'print_reprint', file: +b.dataset.again }) }).then(x => x.json()).catch(e => ({ error: 'generic', detail: e.message }));
      b.disabled = false;
      if (!r.ok) { status($('#pfstatus'), errText(r), false, true); return; }
      $('#pfstatus').hidden = true;
      const fl = ps.files.find(x => x.id === +b.dataset.again);
      useSrc({ id: +b.dataset.again, name: fl ? fl.name : '' });
      $('#pprev').hidden = $('#psend').hidden = $('#pmap').hidden = true;
      if (plates[r.bed]) $('#pbed').value = r.bed;
      // Gespeicherter Drucker — außer der G-Code passt laut Kopf zu einem anderen eigenen Drucker (r.suggest). Dann und wenn
      // der gespeicherte fehlt: keine Vorschau, erst Fach wählen und „G-Code übernehmen“ (Denny 22.10.2026)
      const pick = k => { const x = k && view.querySelector(`input[name=printer][value="${CSS.escape(k)}"]`); return x && !x.disabled ? x : null; };
      const sug = r.suggest && r.suggest !== r.printer ? pick(r.suggest) : null, radio = sug || pick(r.printer);
      if (radio) { radio.checked = true; renderSlots(); }
      if (!radio || sug) {
        ps.job = null;
        if (sug) status($('#pstatus'), esc(t('pf_src_suggest', { name: printer().name })), false); else $('#pstatus').hidden = true;
        $('#pslots').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      // Fach wie beim letzten Mal, damit die Auswahl zum Auftrag passt
      const sl = r.slot != null && view.querySelector(`input[name=slot][value="${r.slot}"]`), mat = view.querySelector('#pslots select[name=material]');
      if (sl && !sl.disabled) sl.checked = true;
      if (mat && r.material) mat.value = r.material;
      ps.job = r.job; ps.gc = false;
      $('#pstatus').hidden = true;
      $('#pnotes').innerHTML = `<li>${esc(S.pf_reprint_note)}</li>`;
      poll();
    }));
  }
  renderFiles(d.files || []);
  // Gespeicherte Datei als Inhalt von Schritt 2: Sie bleibt beim Drucker- oder Fachwechsel stehen, „G-Code übernehmen“
  // bereitet sie dafür vor (print_retarget). Vorher war sie nach dem Wechsel weg, nichts ließ sich neu slicen (Denny 22.10.2026).
  function useSrc(src) {
    ps.src = src; ps.multi = null; ps.gcFile = true;
    $('#pfile').value = ''; $('#pqmultiw').hidden = true;
    $('#pdrop').classList.add('has'); $('#pfname').textContent = src.name || S.pf_h;
    $('#pgcnote').hidden = $('#pfgrid').hidden = $('#pexp').hidden = true; $('#psrc').hidden = false;
    ps.stls = null; ps.kind = 'gcode'; renderStls();
    ps.mf = null; setPeek(null); renderMulti();
  }
  $('#pqaddbtn').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    const r = await fetch('api.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ a: 'print_queue_add', job: ps.job, project: $('#pqproj').value.trim() }) }).then(x => x.json()).catch(er => ({ error: 'generic', detail: er.message }));
    if (!r.ok) { b.disabled = false; status($('#psendstatus'), errText(r), false, true); return; }
    status($('#psendstatus'), esc(S.pq_add_done) + ` <a href="/printqueue.php">${esc(S.pq_add_open)}</a>`);
    get('print_files').then(x => renderFiles(x.files)).catch(() => {});
  });
  // Von einer Karte der Druck-Warteschlange (#print/file/<id>): gleich wie „Nochmal drucken“ dieser Datei
  const rfile = route().file;
  if (rfile) {
    history.replaceState(null, '', '#print');
    const b = $(`#pfiles [data-again="${rfile}"]`);
    if (b) b.click(); else status($('#pstatus'), esc(S.psd_err_file_gone || t('err_generic')), false, true);
  }

  function renderSlots() {
    const p = printer(); if (!p) return;
    let html = '', def = null, note = '';
    if (p.slot_mode === 'material') {
      html = `<select class="in" name="material" style="max-width:260px">${d.materials.map(m => `<option>${esc(m)}</option>`).join('')}</select>`;
      note = S.psd_note_material;
    } else {
      const ok = s => s.material && s.remain !== 0 && !s.locked;
      p.slots.forEach(s => { if (def === null && ok(s) && /PLA/i.test(s.material)) def = s.index; });
      p.slots.forEach(s => { if (def === null && ok(s)) def = s.index; });
      html = p.slots.map(s => `<label class="pick${s.material || s.need_mat ? '' : ' off'}${s.locked ? ' off' : ''}"><input type="radio" name="slot" value="${s.index}"${s.index === def ? ' checked' : ''}${!(s.material || s.need_mat) || s.locked ? ' disabled' : ''}>
        <span class="sw lg${s.material ? '' : ' empty'}" style="${s.color ? 'background:' + esc(s.color) : ''}"></span><span class="t"><b>${esc(s.material || (s.need_mat ? t('amp_slot_need_mat') : t('slot_empty')))}</b><span class="hint">${tf('pc_slot_n', esc(s.label))}</span></span></label>`).join('');
      if (p.provider === 'creality') note = S.psd_note_creality;
      if (p.provider === 'moonraker' && p.ttg) note = S.psd_note_klipper_tool;
      if (p.provider === 'moonraker' && p.tool0 !== null) { const t0 = p.slots.find(s => s.index === p.tool0); note = tf('psd_note_klipper_mmu', t0 ? t0.label : String(p.tool0 + 1)); }
    }
    $('#pslots').innerHTML = html; if (window.ampSlotMat) ampSlotMat(p, d.materials);
    $('#pnote').hidden = !note; $('#pnote').textContent = note;
    renderProfile(false);
    renderMulti();
    renderLevel(); if (window.ampRenderCal) ampRenderCal(printer());
    renderStls(); renderX();   // Fach je STL und Profilgrenzen hängen am Drucker
  }
  // Bett nivellieren: je Weg anders (ps_level_info in print_slice_lib.php) — die Wahl merkt sich der Browser je Drucker
  function renderLevel() {
    const p = printer(), lv = (p && p.level) || { mode: 'none' }, chk = $('#plevelchk');
    let note = '', can = true, on = !!lv.def, saved = null;
    $('#plevel').hidden = lv.mode === 'none';
    if (lv.mode === 'none') { $('#plevelval').value = ''; return; }
    if (lv.mode === 'always') { can = false; on = true; note = lv.macro ? tf('psd_level_n_macro', lv.macro) : S.psd_level_n_always; }
    else if ((lv.mode === 'rinkhals' || lv.mode === 'u1') && !lv.agent_ok) { can = false; on = false; note = S.psd_level_n_agent; }
    else if (lv.mode === 'rinkhals' && lv.lan === false) { can = false; on = false; note = S.psd_level_n_rinkhals_cloud; }
    else if (lv.mode === 'rinkhals') note = S.psd_level_n_rinkhals;
    else if (lv.mode === 'insert') note = tf(lv.known ? 'psd_level_n_insert_ok' : 'psd_level_n_insert', lv.cmd);
    else if (p.provider === 'creality') note = S.psd_level_n_creality;
    try { saved = localStorage.getItem('psd_level_' + p.key); } catch (e) { /* privates Fenster */ }
    if (can && saved !== null) on = saved === '1';
    chk.checked = on; chk.disabled = !can;
    $('#plevelval').value = can ? (on ? '1' : '0') : '';
    $('#plevelnote').hidden = !note; $('#plevelnote').textContent = note;
    chk.onchange = () => {
      $('#plevelval').value = chk.checked ? '1' : '0';
      try { localStorage.setItem('psd_level_' + p.key, chk.checked ? '1' : '0'); } catch (e) { /* privates Fenster */ }
    };
  }
  async function renderProfile(open) {
    const p = printer(), el = $('#pprof');
    $('#pslice').disabled = !p.machine;
    if (p.machine && !open) {
      el.innerHTML = `<span>${S.psd_profile}: <b>${esc(p.machine.replace(/ \(?0\.4 nozzle\)?$/, ''))}</b></span> <button type="button" class="lnk" id="pprofopen">${S.psd_profile_change}</button><span class="nz">${esc(S.psd_nozzle_note)}</span>`;
      $('#pprofopen').onclick = () => renderProfile(true);
      return;
    }
    el.innerHTML = `<span>${esc(p.machine ? S.psd_profile : S.psd_profile_missing)}</span><select class="in" id="pprofsel"><option value="">…</option></select><button type="button" class="btn sm" id="pprofsave">${S.psd_profile_save}</button>`;
    if (!ps.machines) ps.machines = await get('machines').catch(() => ({}));
    let o = `<option value="">${p.chosen ? esc(S.psd_profile_auto) : '…'}</option>`;
    for (const v of Object.keys(ps.machines)) o += `<optgroup label="${esc(v)}">${ps.machines[v].map(m => `<option value="${esc(v + '|' + m)}"${p.vendor === v && p.machine === m ? ' selected' : ''}>${esc(m.replace(/ \(?0\.4 nozzle\)?$/, ''))}</option>`).join('')}</optgroup>`;
    $('#pprofsel').innerHTML = o;
    // Gewähltes, noch nicht gespeichertes Profil → Speichern orange, sonst übersieht man ihn (Denny 07.10.)
    const sel0 = $('#pprofsel').value;
    $('#pprofsel').onchange = e => $('#pprofsave').classList.toggle('pri', e.target.value !== sel0);
    $('#pprofsave').onclick = async () => { try { await api('print_profile', { printer: p.key, profile: $('#pprofsel').value }); viewPrint(); } catch (e) { fail(e); } };
  }
  // Fertige Vorschau gehört zum alten Stand — nach jeder Änderung neu slicen (wie der change-Hörer an #pf)
  const stale = () => { if (ps.job && !$('#pprev').hidden) { $('#pprev').hidden = $('#psend').hidden = true; $('#pstatus').hidden = true; } };
  // Mehrere STL auf eine Platte (23.10.2026): Liste mit Anzahl je Datei, am Mehrfarb-Drucker ab zwei Dateien auch das Fach
  // je Datei (leer = Fach aus Schritt 3). Orca ordnet alles auf einer Platte an; passt es nicht, sagt der Server wie viel passt.
  const fsize = b => b < 1048576 ? nf.format(Math.max(1, b / 1024)) + ' KB' : nf1.format(b / 1048576) + ' MB';
  function setStlName() {
    const L = ps.stls || [];
    $('#pfname').textContent = L.length === 1 ? `${L[0].file.name} · ${fsize(L[0].file.size)}`
      : t('psd_stl_files', { n: L.length, mb: fsize(L.reduce((a, x) => a + x.file.size, 0)) });
  }
  function renderStls() {
    if (window.ampSeqCheck) ampSeqCheck(ps, printer);
    const box = $('#pstls'); if (!box) return;
    const L = ps.stls;
    if (!L || !L.length) { box.hidden = true; box.innerHTML = ''; return; }
    const p = printer(), multi = !!(p && p.multi && p.slot_mode !== 'material' && L.length > 1);
    const usable = multi ? p.slots.filter(sl => sl.material && !sl.locked) : [];
    // Gewähltes Fach bleibt beim Wechsel auf einen Einfarb-Drucker gemerkt (der Server wertet es dort nicht aus)
    if (multi) L.forEach(x => { if (x.slot !== '' && !usable.some(sl => String(sl.index) === x.slot)) x.slot = ''; });
    const n = L.reduce((a, x) => a + x.copies, 0);
    box.innerHTML = `<p class="hint">${esc(t(L.length > 1 ? 'psd_stl_many' : 'psd_stl_one', { n }))}</p><div class="pstl-list">
      ${L.map((x, i) => `<div class="pstl" data-i="${i}"><span class="t"><b>${esc(x.file.name)}</b><span class="hint">${fsize(x.file.size)}</span></span>
        <label class="pstl-n"><span>${esc(S.psd_stl_count)}</span><input class="in" type="number" min="1" max="100" step="1" value="${x.copies}" data-cp></label>
        ${multi ? `<span class="pstl-sl"><span class="sw lg" data-sw></span><select class="in" data-fs aria-label="${esc(S.psd_stl_slot)}"><option value="">${esc(S.psd_stl_slot_def)}</option>
          ${usable.map(sl => `<option value="${sl.index}"${String(sl.index) === x.slot ? ' selected' : ''}>${esc(tf('pc_slot_n', sl.label) + ' · ' + sl.material)}</option>`).join('')}</select></span>` : ''}
        ${L.length > 1 ? `<button type="button" class="x-btn" data-rm aria-label="${esc(S.psd_stl_rm)}" title="${esc(S.psd_stl_rm)}">×</button>` : ''}</div>`).join('')}</div>
      <button type="button" class="btn sm" id="pstlmore">+ ${esc(S.psd_stl_add)}</button>${multi ? `<p class="hint">${esc(S.psd_stl_slot_hint)}</p>` : ''}`;
    box.hidden = false;
    if (typeof ampStlExtra === 'function') ampStlExtra(box, L, { redraw: () => { setStlName(); renderStls(); stale(); }, lib: () => ps.lib, setLib: v => { ps.lib = v; } });
    const main = () => { const c = view.querySelector('input[name=slot]:checked'); return c ? String(c.value) : ''; };
    const paint = row => {
      const sel = row.querySelector('[data-fs]'); if (!sel) return;
      const si = sel.value || main(), sl = p.slots.find(z => String(z.index) === si);
      row.querySelector('[data-sw]').style.background = sl && sl.color ? sl.color : '';
      row.querySelector('[data-sw]').classList.toggle('dim', !sel.value);
    };
    box.querySelectorAll('.pstl').forEach(row => {
      const x = L[+row.dataset.i];
      paint(row);
      row.querySelector('[data-cp]').addEventListener('change', e => {
        x.copies = Math.max(1, Math.min(100, Math.round(+e.target.value) || 1)); e.target.value = x.copies;
        box.querySelector(':scope > .hint').textContent = t(L.length > 1 ? 'psd_stl_many' : 'psd_stl_one', { n: L.reduce((a, y) => a + y.copies, 0) });
      });
      const fs = row.querySelector('[data-fs]');
      if (fs) fs.addEventListener('change', () => { x.slot = fs.value; paint(row); });
      const rm = row.querySelector('[data-rm]');
      if (rm) rm.addEventListener('click', () => { L.splice(+row.dataset.i, 1); setStlName(); renderStls(); stale(); });
    });
    $('#pstlmore').onclick = () => $('#pstladd').click();
    // Fachfarbe „wie Schritt 3“ folgt der Auswahl dort
    $('#pslots').onchange = () => box.querySelectorAll('.pstl').forEach(paint);
  }
  $('#pstladd').addEventListener('change', e => {
    const add = [...e.target.files].filter(f => /\.stl$/i.test(f.name));
    e.target.value = '';
    if (!add.length || !ps.stls) return;
    const room = 20 - ps.stls.length;   // PS_STL_MAX
    add.slice(0, Math.max(0, room)).forEach(file => ps.stls.push({ file, copies: 1, slot: '' }));
    if (add.length > room) status($('#pstatus'), esc(t('psd_stl_max', { n: 20 })), false, true);
    setStlName(); renderStls(); stale();
  });
  // Experten-Einstellungen: je Drucker Schichthöhen und Pause (caps), Platzhalter aus dem Profil (print_xdef)
  // Material des Drucks (Fach oder Materialwahl) — für die Temperatur-Platzhalter
  const pxMat = () => {
    const p = printer(); if (!p) return '';
    const m = view.querySelector('#pslots select[name=material]'); if (m) return m.value;
    const c = view.querySelector('input[name=slot]:checked'), sl = c && (p.slots || []).find(x => String(x.index) === c.value);
    return sl ? sl.material || (($('#pslotmat') || {}).disabled === false ? $('#pslotmat').value : '') : '';
  };
  const pxKey = p => [p.key, ($('#pnozzle') || {}).value || '', pxMat(), ($('#pbed') || {}).value || ''].join('|');
  function renderX() {
    const box = $('#pexp'); if (!box) return;
    const p = printer();
    // Düse: nur Größen mit Profil dieser Druckerreihe; „Standard“ = die des erkannten Profils (meist 0,4 mm)
    const nzs = (p && p.nozzles) || [], nzSel = box.querySelector('#pnozzle'), nzRow = box.querySelector('[data-px=nozzle]');
    const nzBase = nzs.find(n => n.machine === (p && p.machine));
    nzRow.hidden = nzs.length < 2;
    const nzWant = p ? pxNzGet(p.key) : '';
    nzSel.innerHTML = `<option value="">${esc(S.psd_x_def + (nzBase ? ` (${nf2.format(nzBase.d)} mm)` : ''))}</option>`
      + nzs.filter(n => n !== nzBase).map(n => `<option value="${n.d}">${nf2.format(n.d)} mm</option>`).join('');
    nzSel.value = nzs.some(n => n !== nzBase && String(n.d) === String(nzWant)) ? String(nzWant) : '';
    const nzCur = nzs.find(n => String(n.d) === nzSel.value);
    const caps = Object.assign({ pause: false, lh: [0.08, 0.32] }, (p && p.caps) || {}, nzCur ? { lh: nzCur.lh } : {}), def = (p && ps.xdef && ps.xdef[pxKey(p)]) || {};
    box.querySelector('[data-px=orient]').hidden = ps.kind !== 'stl';   // „auf die beste Seite drehen“ gibt es nur für STL
    const lh = box.querySelector('[name=x_layer_height]'), cur = lh.value;
    const opts = PX_LH.concat(cur && !PX_LH.some(v => String(v) === cur) ? [+cur] : []).filter(v => v >= caps.lh[0] - 1e-6 && v <= caps.lh[1] + 1e-6).sort((a, b) => a - b);
    lh.innerHTML = `<option value="">${esc(S.psd_x_def + (def.layer_height ? ` (${nf2.format(+def.layer_height)} mm)` : ''))}</option>`
      + opts.map(v => `<option value="${v}">${nf2.format(v)} mm</option>`).join('');
    lh.value = opts.some(v => String(v) === cur) ? cur : '';
    const pz = box.querySelector('[name=x_pause]');
    pz.disabled = !caps.pause; if (!caps.pause) pz.value = '';
    $('#px_pause_h').textContent = caps.pause ? S.psd_x_pause_hint : S.psd_x_pause_none;
    for (const k of Object.keys(PX_SEL)) {
      const sel = box.querySelector(`[name=x_${k}]`), dv = def[k];
      if (sel) sel.options[0].textContent = S.psd_x_def + (dv != null && dv !== '' ? ` (${k === 'support_on_build_plate_only' ? (dv === '1' ? S.psd_xo_support_on_build_plate_only_1 : S.psd_xo_support_on_build_plate_only_0) : pxOpt(k, dv)})` : '');
    }
    for (const k of Object.keys(PX_NUM)) {
      const inp = box.querySelector(`[name=x_${k}]`);
      const dv = def[k] != null ? parseFloat(String(def[k])) : NaN;
      if (inp) inp.placeholder = k === 'scale' ? '100' : isFinite(dv) ? nf2.format(dv) : '';
    }
    pxCount();
    if (box.open && p && p.machine && !(ps.xdef && ps.xdef[pxKey(p)])) pxLoad(p);
  }
  async function pxLoad(p) {
    ps.xdef = ps.xdef || {};
    const key = pxKey(p), [, nozzle, material, bed] = key.split('|');
    ps.xdef[key] = {};   // je Drucker/Düse/Material/Platte nur einmal fragen
    const r = await get('print_xdef', { printer: p.key, nozzle, material, bed }).catch(() => null);
    if (r && r.vals) { ps.xdef[key] = r.vals; if (printer() === p) renderX(); }
  }
  function pxCount() {
    const box = $('#pexp'); if (!box) return;
    let n = [...box.querySelectorAll('[name^=x_]')].filter(el => el.value !== '' && !el.disabled).length;
    if (($('#pnozzle') || {}).value) n++;
    if (!$('#px_orient').checked && ps.kind === 'stl') n++;
    if ($('#px_rot').checked) n++;
    $('#pxn').hidden = !n; $('#pxn').textContent = t('psd_x_n', { n });
  }
  function pxSave() {
    const o = {};
    $('#pexp').querySelectorAll('[name^=x_]').forEach(el => { if (el.value !== '' && el.name !== 'x_scale' && el.name !== 'x_pause' && !PX_TEMP.includes(el.name)) o[el.name] = el.value; });
    if (!$('#px_orient').checked) o.orient = '0';
    if ($('#px_rot').checked) o.rot = '1';
    try { localStorage.setItem('psd_x', JSON.stringify(o)); } catch (e) { /* privates Fenster */ }
  }
  {
    const box = $('#pexp');
    let o = {};
    try { o = JSON.parse(localStorage.getItem('psd_x') || '{}') || {}; } catch (e) { o = {}; }
    renderX();   // erst die Schichthöhen des Druckers, dann die gemerkten Werte
    for (const [k, v] of Object.entries(o)) { const el = /^x_\w+$/.test(k) && !PX_TEMP.includes(k) && box.querySelector(`[name="${k}"]`); if (el) el.value = v; }
    $('#px_orient').checked = o.orient !== '0'; $('#px_rot').checked = o.rot === '1';
    try { box.open = localStorage.getItem('psd_x_open') === '1'; } catch (e) { /* privates Fenster */ }
    pxCount();
    box.addEventListener('toggle', () => { try { localStorage.setItem('psd_x_open', box.open ? '1' : '0'); } catch (e) { /* privates Fenster */ } if (box.open) renderX(); });
    box.addEventListener('input', () => { pxCount(); pxSave(); });
    box.addEventListener('change', e => {
      // Düse gewechselt: je Drucker merken, Schichthöhen und Platzhalter der neuen Düse
      if (e.target && e.target.id === 'pnozzle') { const p = printer(); if (p) pxNzSet(p.key, e.target.value); renderX(); stale(); }
      pxCount(); pxSave();
    });
    // Fach, Material oder Platte gewechselt: Temperatur-Platzhalter neu (anderes Filamentprofil)
    (view.querySelector('#pf') || box).addEventListener('change', e => { if (e.target && e.target.matches && e.target.matches('input[name=slot], #pslots select[name=material], #pbed, #pslotmat')) renderX(); });
    if (typeof ampProfInit === 'function') ampProfInit(box, () => { pxCount(); pxSave(); stale(); });
    $('#pxreset').onclick = () => {
      box.querySelectorAll('[name^=x_]').forEach(el => { el.value = ''; });
      $('#px_orient').checked = true; $('#px_rot').checked = false;
      pxSave(); pxCount(); stale();
    };
  }
  view.querySelectorAll('input[name=printer]').forEach(r => r.addEventListener('change', renderSlots));
  renderSlots();
  // Ein fertiger Auftrag gehört fest zu Drucker/Fach/Platte/Stützen — nach einer Änderung neu slicen, sonst ginge
  // „Drucken“ an den alten Drucker. Datei bleibt, damit dasselbe Modell schnell an den nächsten Drucker kann (Denny 05.10.)
  $('#pf').addEventListener('change', e => {
    if (e.target.id === 'pfile' || !ps.job || $('#pprev').hidden) return;
    $('#pprev').hidden = $('#psend').hidden = true; $('#pstatus').hidden = true;
  });
  const dz = $('#pdrop');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('over')));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    const fl = [...e.dataTransfer.files].filter(f => /\.(stl|3mf|gcode|gco|g)$/i.test(f.name)); if (!fl.length) return;
    try { const dt = new DataTransfer(); fl.forEach(f => dt.items.add(f)); $('#pfile').files = dt.files; $('#pfile').dispatchEvent(new Event('change')); } catch (er) { /* alter Browser: nur Auswählen */ }
  });
  $('#pplates').addEventListener('change', e => {
    if (e.target.name !== 'plate') return;
    renderObjs(); ps.mf = mfOf(ps.pk, +e.target.value); renderMulti();
  });
  $('#pfile').addEventListener('change', e => {
    const f = e.target.files[0], is3mf = f && /\.3mf$/i.test(f.name), o = $('#psup').querySelector('option[value=project]');
    if (!(ps.lib && sameFile(f, ps.lib.file))) ps.lib = ps.wantPlate = null;
    ps.src = null; $('#psrc').hidden = true; $('#pstatus').hidden = true;   // alte Meldung gehört zur vorigen Datei
    // Eigener G-Code: nichts zu slicen → Stützen/Platte ohne Wirkung, Knopf „G-Code übernehmen“
    ps.gcFile = !!(f && /\.(gcode|gco|g)$/i.test(f.name));
    $('#pgcnote').hidden = !ps.gcFile; $('#pfgrid').hidden = $('#pexp').hidden = ps.gcFile;
    $('#pslice').textContent = ps.gcFile ? S.gc_btn : S.psd_slice_btn;
    $('#pdrop').classList.toggle('has', !!f); $('#pfname').textContent = f ? `${f.name} · ${nf1.format(f.size / 1048576)} MB` : t('drop_here');
    o.hidden = !is3mf;
    if (is3mf) $('#psup').value = 'project'; else if ($('#psup').value === 'project') $('#psup').value = 'off';
    ps.mf = null; setPeek(null); renderMulti();
    // Mehrere Dateien (22.10.2026): nur G-Code — sie gehen ohne Vorschau einzeln in die Druck-Warteschlange (batchQueue).
    // STL (23.10.2026): eine oder mehrere kommen zusammen auf eine Platte — Liste mit Anzahl und Fach je Datei (renderStls)
    ps.multi = null; $('#pqmultiw').hidden = true;
    const all = [...e.target.files];
    ps.stls = all.length && all.every(x => /\.stl$/i.test(x.name)) ? all.slice(0, 20).map(file => ({ file, copies: 1, slot: '' })) : null;
    ps.kind = !f ? null : ps.stls ? 'stl' : is3mf ? '3mf' : ps.gcFile ? 'gcode' : null;
    if (ps.stls) { setStlName(); if (all.length > 20) status($('#pstatus'), esc(t('psd_stl_max', { n: 20 })), false, true); }
    renderStls(); renderX();
    if (e.target.files.length > 1 && !ps.stls) {
      const fl = [...e.target.files];
      if (!fl.every(x => /\.(gcode|gco|g)$/i.test(x.name))) status($('#pstatus'), esc(S.gc_multi_only), false, true);
      else {
        ps.multi = fl; $('#pstatus').hidden = true; $('#pqmultiw').hidden = false;
        $('#pfname').textContent = t('gc_multi', { n: fl.length, mb: nf1.format(fl.reduce((a, x) => a + x.size, 0) / 1048576) });
        $('#pslice').textContent = t('gc_queue_all', { n: fl.length });
      }
    }
    if (is3mf) peek3mf(f).then(r => { if ($('#pfile').files[0] === f) { setPeek(r); renderMulti(); } }).catch(() => { /* keine lesbare 3MF: der Server meldet es beim Slicen */ });
  });
  // Mehrfarbige 3MF schon beim Wählen erkennen (wie ps_inspect_3mf: Extruder der Teile auf Platte 1). Die Zuordnung
  // Farbe → Fach kommt erst nach dem Klick (Status „mapping“) — vorher wirkte die Fachauswahl wie die endgültige Wahl
  // (User 09.10.2026). Bemalte 3MF lassen sich ohne die großen Modelldateien nicht sicher erkennen → „vielleicht“.
  async function peek3mf(f) {
    if (typeof DecompressionStream !== 'function') return null;
    const buf = await f.arrayBuffer(), dv = new DataView(buf), dec = new TextDecoder(), ents = {};
    let eocd = -1;
    for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    for (let k = 0, n = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true); k < n && dv.getUint32(p, true) === 0x02014b50; k++) {
      const nl = dv.getUint16(p + 28, true);
      ents[dec.decode(new Uint8Array(buf, p + 46, nl))] = { method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), size: dv.getUint32(p + 24, true), off: dv.getUint32(p + 42, true) };
      p += 46 + nl + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    const read = async (name, bin) => {
      const e = ents[name];
      if (!e || e.size > 8 << 20) return bin ? null : '';
      const raw = new Uint8Array(buf, e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true), e.csize);
      if (e.method === 0) return bin ? new Blob([raw], { type: 'image/png' }) : dec.decode(raw);
      if (e.method !== 8) return bin ? null : '';
      const res = new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
      return bin ? new Blob([await res.arrayBuffer()], { type: 'image/png' }) : res.text();
    };
    const ms = await read('Metadata/model_settings.config'), pj = await read('Metadata/project_settings.config');
    const doc = ms ? new DOMParser().parseFromString(ms, 'text/xml') : null, plates = [];
    let usedFn = null;
    if (doc) {
      const kids = (el, tag) => [...el.children].filter(c => c.tagName === tag);
      const meta = (el, key) => { const m = kids(el, 'metadata').find(c => c.getAttribute('key') === key); return m ? m.getAttribute('value') : null; };
      const objs = kids(doc.documentElement, 'object');
      const objName = {};
      objs.forEach(o => { objName[o.getAttribute('id')] = meta(o, 'name') || '#' + o.getAttribute('id'); });
      // Benutzte Extruder der Objekte einer Platte (leere Menge = alle Objekte, 3MF ohne Platten)
      const usedOf = ids => {
        const used = new Set();
        objs.forEach(o => {
          if (ids.size && !ids.has(o.getAttribute('id'))) return;
          const oe = +meta(o, 'extruder') || 1;
          const parts = kids(o, 'part').filter(pt => !pt.getAttribute('subtype') || pt.getAttribute('subtype') === 'normal_part');
          parts.forEach(pt => used.add(+meta(pt, 'extruder') || oe));
          if (!parts.length) used.add(oe);
        });
        return used;
      };
      usedFn = usedOf;
      // Nummer = Reihenfolge in der Datei — so zählen auch der Server (ps_inspect_3mf) und Orca (--slice N)
      kids(doc.documentElement, 'plate').forEach((pl, i) => {
        const ids = new Set(), insts = [];
        pl.querySelectorAll('model_instance').forEach(mi => {
          const id = meta(mi, 'object_id'), iid = meta(mi, 'identify_id');
          if (!id) return;
          ids.add(id);
          if (/^\d+$/.test(iid || '')) insts.push({ id: iid, obj: id, inst: +meta(mi, 'instance_id') || 0, name: objName[id] || '#' + id });
        });
        plates.push({ n: i + 1, name: meta(pl, 'plater_name') || '', parts: ids.size, ids, insts, used: usedOf(ids), thumb: (meta(pl, 'thumbnail_file') || '').replace(/^\//, '') });
      });
      if (!plates.length) plates.push({ n: 1, name: '', parts: 0, ids: new Set(), insts: [], used: usedOf(new Set()), thumb: '' });
      // Lage der Teile für die kleine Draufsicht: Position = Build-Eintrag im 3D/3dmodel.model (k-ter Eintrag eines Objekts
      // = instance_id k), Umriss aus Metadata/plate_N.json. Dessen Koordinaten zählen je Platte, die Build-Einträge im ganzen
      // Projekt → über den gemeinsamen Mittelpunkt angleichen und je Teil den nächsten Umriss nehmen.
      if (plates.some(p => p.insts.length > 1)) {
        const mm = await read('3D/3dmodel.model'), items = {}, bi = mm.indexOf('<build');
        for (const m of mm.slice(bi < 0 ? 0 : bi).matchAll(/<item\b[^>]*>/g)) {
          const oid = (m[0].match(/\bobjectid="(\d+)"/) || [])[1];
          const tr = ((m[0].match(/\btransform="([^"]+)"/) || [])[1] || '').trim().split(/\s+/).map(Number);
          if (oid) (items[oid] = items[oid] || []).push(tr.length === 12 && tr.every(isFinite) ? [tr[9], tr[10]] : null);
        }
        for (const p of plates) {
          if (p.insts.length < 2) continue;
          const pos = p.insts.map(x => (items[x.obj] || [])[x.inst] || null);
          if (pos.some(q => !q)) continue;
          let bb = [];
          try { bb = (JSON.parse(await read(`Metadata/plate_${p.n}.json`)).bbox_objects || []).map(b => b.bbox).filter(b => Array.isArray(b) && b.length === 4 && b.every(isFinite)); } catch (e) { /* ohne Umrisse: Quadrate */ }
          const mid = a => [a.reduce((s, q) => s + q[0], 0) / a.length, a.reduce((s, q) => s + q[1], 0) / a.length];
          let rects;
          if (bb.length === pos.length) {
            const cb = bb.map(b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]), mp = mid(pos), mb = mid(cb), free = new Set(bb.keys());
            rects = pos.map(q => {
              let best = -1, bd = Infinity;
              free.forEach(k => { const d = (cb[k][0] - q[0] - mb[0] + mp[0]) ** 2 + (cb[k][1] - q[1] - mb[1] + mp[1]) ** 2; if (d < bd) { bd = d; best = k; } });
              free.delete(best);
              const b = bb[best];
              return [b[0] - mb[0] + mp[0], b[1] - mb[1] + mp[1], b[2] - mb[0] + mp[0], b[3] - mb[1] + mp[1]];
            });
          } else {
            const xs = pos.map(q => q[0]), ys = pos.map(q => q[1]);
            const h = Math.max(5, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.06);
            rects = pos.map(q => [q[0] - h, q[1] - h, q[0] + h, q[1] + h]);
          }
          p.map = rects;
        }
      }
    }
    let cols = 0;
    try { cols = (JSON.parse(pj).filament_colour || []).length; } catch (e) { /* ohne Projekteinstellungen */ }
    // Vorschaubilder der Platten (Bambu/Orca legen je Platte eins in die 3MF) — nur nötig, wenn es etwas zu wählen gibt
    if (plates.length > 1) for (const p of plates) {
      const big = p.thumb || `Metadata/plate_${p.n}.png`, small = big.replace(/\.png$/, '_small.png');
      const b = await read(ents[small] ? small : big, true).catch(() => null);
      p.img = b ? URL.createObjectURL(b) : '';
    }
    return { plates, cols, usedOf: usedFn };
  }
  // Mehrfarbig-Hinweis für eine Platte: sicher, wenn die Teile verschiedene Filamente nutzen; „vielleicht“, wenn das
  // Projekt mehrere Farben hat (bemalt lässt sich ohne die großen Modelldateien nicht erkennen)
  function mfOf(pk, n, skip) {
    if (!pk) return null;
    const p = pk.plates.find(x => x.n === n) || pk.plates[0];
    const used = p && skip && skip.size && pk.usedOf ? pk.usedOf(keptObjs(p, skip)) : p && p.used;
    if (used && used.size > 1) return { n: used.size, sure: true };
    return pk.cols > 1 ? { n: pk.cols, sure: false } : null;
  }
  // Objekte, von denen mindestens eine Instanz gedruckt wird (Objekte ohne identify_id immer)
  function keptObjs(p, skip) {
    const k = new Set();
    p.ids.forEach(id => { const mine = p.insts.filter(x => x.obj === id); if (!mine.length || mine.some(x => !skip.has(x.id))) k.add(id); });
    return k;
  }
  // Teile weglassen (12.10.2026): bei mehr als einem Teil auf der Platte Häkchenliste + kleine Draufsicht mit Nummern —
  // vier gleichnamige Kopien unterscheidet man nur an der Lage. Weggelassen = identify_id in #pskip (Orca --skip-objects).
  function renderObjs() {
    const box = $('#pobjs'), pk = ps.pk;
    if (!box) return;
    const n = +((view.querySelector('input[name=plate]:checked') || {}).value || 1);
    const p = pk && (pk.plates.find(x => x.n === n) || pk.plates[0]);
    ps.skip = new Set(); $('#pskip').value = '';
    if (!p || p.insts.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
    let svg = '';
    if (p.map) {
      const r = p.map, x0 = Math.min(...r.map(q => q[0])), x1 = Math.max(...r.map(q => q[2])), y0 = Math.min(...r.map(q => q[1])), y1 = Math.max(...r.map(q => q[3]));
      const d = Math.max(x1 - x0, y1 - y0, 10), pad = Math.max(4, d * 0.05), fs = (d * 0.07).toFixed(1), f = v => v.toFixed(1);
      // Bett-Y zeigt nach hinten (oben in der Draufsicht) → im SVG gespiegelt
      svg = `<svg class="pobj-map" viewBox="${f(x0 - pad)} ${f(-y1 - pad)} ${f(x1 - x0 + 2 * pad)} ${f(y1 - y0 + 2 * pad)}" role="img" aria-hidden="true">
        ${r.map((q, i) => `<g data-i="${i}"><rect x="${f(q[0])}" y="${f(-q[3])}" width="${f(Math.max(q[2] - q[0], 1))}" height="${f(Math.max(q[3] - q[1], 1))}" rx="${f(d * 0.012)}"/>
          <text x="${f((q[0] + q[2]) / 2)}" y="${f(-(q[1] + q[3]) / 2)}" font-size="${fs}" dominant-baseline="central" text-anchor="middle">${i + 1}</text></g>`).join('')}</svg>`;
    }
    box.innerHTML = `<p class="hint">${esc(t('psd_obj_pick', { n: p.insts.length }))}</p><div class="pobj-wrap">${svg}<div class="pobj-list">
      ${p.insts.map((x, i) => `<label class="chk pobj"><input type="checkbox" data-skip="${esc(x.id)}" data-i="${i}" checked><span class="pobj-n">${i + 1}</span><span class="pobj-t">${esc(x.name)}</span></label>`).join('')}</div></div>
      <label class="chk row parr"><input type="checkbox" name="arrange" value="1"${ps.arrange ? ' checked' : ''}> <span>${esc(t('psd_arrange'))}</span></label><p class="hint">${esc(t('psd_arrange_hint'))}</p>`;
    box.hidden = false;
    const sync = () => {
      ps.skip = new Set([...box.querySelectorAll('input[data-skip]')].filter(c => !c.checked).map(c => c.dataset.skip));
      $('#pskip').value = [...ps.skip].join(',');
      box.querySelectorAll('input[data-skip]').forEach(c => { const g = box.querySelector(`.pobj-map g[data-i="${c.dataset.i}"]`); if (g) g.classList.toggle('off', !c.checked); });
      ps.mf = mfOf(ps.pk, n, ps.skip); renderMulti();
    };
    box.onchange = e => { if (e.target.dataset.skip) sync(); else if (e.target.name === 'arrange') ps.arrange = e.target.checked; };   // onchange statt addEventListener: renderObjs läuft je Platte neu
    box.querySelectorAll('.pobj-map g').forEach(g => g.addEventListener('click', () => {
      const c = box.querySelector(`input[data-i="${g.dataset.i}"]`);
      c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true }));
    }));
  }
  // Plattenauswahl (09.10.2026): bei mehr als einer Platte Kacheln mit Vorschaubild, Platte 1 vorgewählt
  function setPeek(pk) {
    (ps.pk && ps.pk.plates || []).forEach(p => { if (p.img) URL.revokeObjectURL(p.img); });
    ps.pk = pk;
    const box = $('#pplates');
    if (!box) return;
    const list = pk ? pk.plates : [];
    const want = list.some(p => p.n === ps.wantPlate) ? ps.wantPlate : 1;   // aus der Bibliothek: die dort gewählte Platte
    box.hidden = list.length < 2;
    box.innerHTML = list.length < 2 ? '' : `<p class="hint">${esc(t('psd_pl_pick', { n: list.length }))}</p><div class="pick-grid small">
      ${list.map(p => `<label class="pick pplate"><input type="radio" name="plate" value="${p.n}"${p.n === want ? ' checked' : ''}>
        ${p.img ? `<img src="${esc(p.img)}" alt="">` : `<span class="pc-ico">${p.n}</span>`}
        <span class="t"><b>${esc(t('psd_pl_n', { n: p.n }))}</b>${p.name ? `<span class="hint">${esc(p.name)}</span>` : ''}</span></label>`).join('')}</div>`;
    ps.mf = mfOf(pk, want);
    renderObjs();
  }
  function renderMulti() {
    if (window.ampSeqCheck) ampSeqCheck(ps, printer);
    const p = printer(), mf = ps.mf, el = $('#pmulti');
    if (!el || !$('#pslice')) return;
    const multi = !!(mf && p && p.multi);
    el.hidden = !(mf && p);
    if (mf && p) el.textContent = !p.multi ? (mf.sure ? S.psd_multi_single : '') : t(mf.sure ? 'psd_multi_hint' : 'psd_multi_maybe', { n: mf.n });
    if (!el.textContent) el.hidden = true;
    $('#pslots').classList.toggle('dim', multi && mf.sure);
    $('#pslice').textContent = ps.gcFile ? S.gc_btn : multi && mf.sure ? S.psd_next_map : S.psd_slice_btn;
  }
  // Datei von einer 3DSEARCH-Modellseite („Mit 3DSEARCH drucken“, js/print_cta.js) übernehmen
  pctaTake().then(h => {
    if (!h || !$('#pfile')) return;
    let ok = false;
    try { const dt = new DataTransfer(); dt.items.add(h.file); $('#pfile').files = dt.files; ok = $('#pfile').files.length === 1; } catch (e) { /* alter Safari: Datei neu wählen */ }
    if (ok) $('#pfile').dispatchEvent(new Event('change'));
    $('#pmodel').value = h.model_id || '';
    const name = /^\/[^/\\]/.test(h.url || '') ? `<a href="${esc(h.url)}">${esc(h.title || h.model_id)}</a>` : esc(h.title || h.model_id);
    $('#phand').innerHTML = t(h.source === 'generator' ? 'handoff_from_gen' : 'handoff_from', { model: name }) + (ok ? '' : ' ' + esc(t('handoff_again')));
    $('#phand').hidden = false;
  });
  // Aus der Bibliothek („Drucken“, 25.10.2026): Datei wie gewählt einsetzen und die Platte vorwählen. Beim Slicen schickt der
  // Browser nur die Nummer (lib_file), der Server nimmt seine gespeicherte Kopie — kein zweiter Upload.
  if (lb.hand) {
    const h = lb.hand; lb.hand = null;
    ps.lib = h; ps.wantPlate = h.plate;
    let ok = false;
    // „wie zuletzt“ (Bibliothek neu, 18.11.2026): letzter Drucker des Modells vorgewählt, wenn er hier wählbar ist
    if (h.printer) { const r0 = view.querySelector(`input[name="printer"][value="${h.printer}"]`); if (r0 && !r0.disabled && !r0.checked) { r0.checked = true; r0.dispatchEvent(new Event('change', { bubbles: true })); } }
    const hf = h.files && h.files.length ? h.files : [h.file];
    try { const dt = new DataTransfer(); hf.forEach(x => dt.items.add(x)); $('#pfile').files = dt.files; ok = $('#pfile').files.length === hf.length; } catch (e) { /* alter Safari */ }
    if (ok) {
      $('#pfile').dispatchEvent(new Event('change'));
      // Platte bearbeiten (19.11.2026): 3MF aus dem Editor — ein Fach → vorwählen, mehrere → Zuordnung (renderMap) nimmt h.edMap
      if (h.ed && h.edSlot != null) { const r1 = view.querySelector(`input[name="slot"][value="${h.edSlot}"]`); if (r1 && !r1.disabled && !r1.checked) { r1.checked = true; r1.dispatchEvent(new Event('change', { bubbles: true })); } }
      if (ps.stls) {   // Nummer aus der Bibliothek je Datei (Druckbuch), bei Platten auch Anzahl und Fach
        ps.stls.forEach((x, i) => { const pt = h.parts ? h.parts[i] : i === 0 ? { id: h.id } : null; if (!pt) return;
          x.lib = pt.id; if (pt.n) x.copies = Math.max(1, Math.min(100, +pt.n || 1)); if (pt.slot != null) x.slot = String(pt.slot); });
        setStlName(); renderStls();
      }
      $('#phand').innerHTML = h.ed ? ampEdHandTxt(h) : t('lib_handoff', { name: `<a href="#library/${h.id}">${esc(h.name)}</a>` }); $('#phand').hidden = false;
    } else ps.lib = ps.wantPlate = null;
  }
  // Mehrere G-Codes nacheinander: hochladen → Server prüft (ps_gcode_prepare) → als Datei mit Karte in die Druck-Warteschlange
  async function batchQueue(files) {
    const btn = $('#pslice'), proj = $('#pqproj2').value.trim(), fails = [], mism = [];
    if (!new FormData($('#pf')).get('printer')) { status($('#pstatus'), esc(S.psd_bambu_note), false, true); return; }
    btn.disabled = true; let ok = 0;
    for (let i = 0; i < files.length; i++) {
      status($('#pstatus'), esc(t('gc_batch_step', { i: i + 1, n: files.length, name: files[i].name })), true);
      const fd = new FormData($('#pf')); fd.set('model', files[i]); fd.append('a', 'print_slice');
      let r = await postForm(fd).catch(e => ({ error: 'generic', detail: e.message }));
      if (r.ok) {
        const job = r.job;
        for (let k = 0; k < 120; k++) {   // G-Code wird nur geprüft, nicht geslict: meist wenige Sekunden
          await new Promise(res => setTimeout(res, 1500));
          const j = await api('print_job', null, { job }).catch(() => null);
          if (j && j.status === 'done') { r = { ok: true }; if (j.gcode && j.gcode.mismatch) mism.push(j.gcode.mismatch); break; }
          if (j && j.status === 'error') { r = { error: 'slice', detail: j.job_error || '' }; break; }
          r = { error: 'generic', detail: 'timeout' };
        }
        if (r.ok) r = await fetch('api.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ a: 'print_queue_add', job, project: proj }) }).then(x => x.json()).catch(e => ({ error: 'generic', detail: e.message }));
      }
      if (r.ok) { ok++; continue; }
      fails.push(`${esc(files[i].name)}: ${errText(r)}`);
      if (r.error === 'files_full' || r.error === 'pq_limit') break;   // die übrigen scheitern genauso
    }
    btn.disabled = false;
    // Laut G-Code für ein anderes Modell als den gewählten Drucker? (Denny 22.10.2026: alle 15 landeten beim vorgewählten)
    const pn = (printer() || {}).name || '';
    status($('#pstatus'), esc(t('gc_batch_done', { ok, n: files.length })) + ` <a href="/printqueue.php">${esc(S.pq_add_open)}</a>`
      + (mism.length ? `<br><span class="warn-t">${esc(t('gc_batch_mismatch', { n: mism.length, a: mism[0], b: pn }))}</span>` : '')
      + (fails.length ? `<br><span class="err-t">${fails.join('<br>')}</span>` : ''), false);
    get('print_files').then(x => renderFiles(x.files)).catch(() => {});
  }
  $('#pslice').addEventListener('click', async () => {
    if (ps.multi) { batchQueue(ps.multi); return; }
    const f = ps.stls && ps.stls.length ? ps.stls[0].file : $('#pfile').files[0], btn = $('#pslice');
    if (ps.stls && ps.stls.reduce((a, x) => a + x.copies, 0) > 200) { status($('#pstatus'), esc(S.psd_err_too_many_objs), false, true); return; }
    if (!f && !ps.src) { status($('#pstatus'), esc(S.psd_no_file), false, true); return; }
    if (ps.skip && ps.skip.size && ps.skip.size === $('#pobjs').querySelectorAll('input[data-skip]').length) { status($('#pstatus'), esc(t('psd_err_skip_all')), false, true); return; }
    const fd = new FormData($('#pf')); fd.append('a', f ? 'print_slice' : 'print_retarget');
    if (!f) { fd.delete('model'); fd.set('file', ps.src.id); }   // gespeicherte Datei für diesen Drucker/dieses Fach vorbereiten
    // STL: alle Dateien der Liste samt Anzahl und Fach (gleiche Reihenfolge), Experten-Häkchen ausdrücklich mitschicken
    const fromLib = !FM.app && !!(f && ps.lib && sameFile(f, ps.lib.file));   // Bibliothek: Server nimmt seine Kopie (als erste Datei)
    if (f && ps.stls && ps.stls.length) {
      fd.delete('model');
      ps.stls.forEach((x, i) => { if (!(fromLib && i === 0)) fd.append('models[]', x.file, x.file.name); fd.append('copies[]', x.copies); fd.append('fslot[]', x.slot); });
    }
    if (fromLib) { fd.delete('model'); fd.set('lib_file', ps.lib.id); }
    // App: Datei geht mit, Nummern nur für „gedruckt am“ + Druckbuch — mehrere STL auf einer Platte: alle aus der Bibliothek, dazu die Platte (18.11.2026)
    if (FM.app && f) {
      const ids = ps.stls && ps.stls.some(x => x.lib) ? [...new Set(ps.stls.filter(x => x.lib).map(x => x.lib))] : ps.lib && ps.lib.libIds && sameFile(f, ps.lib.file) ? ps.lib.libIds : ps.lib && sameFile(f, ps.lib.file) && ps.lib.id ? [ps.lib.id] : [];
      if (ids.length) fd.set('amp_lib', ids.join(','));
      if (ps.lib && ps.lib.plateId) fd.set('amp_plate', ps.lib.plateId);
    }
    if (f) { fd.set('x_orient', $('#px_orient').checked ? '1' : '0'); fd.set('x_rot', $('#px_rot').checked ? '1' : '0'); }
    // Gesperrte Drucker (nur Tester, Bambu) sind deaktivierte Radios und fehlen im Formular — sonst kam „Drucker nicht
    // in der Verbindung“ (11.10.2026, Kelley, K2 über Creality-Cloud ohne Testerfreigabe)
    if (!fd.get('printer')) {
      const fbLink = `<a href="/feedback.php?id=43" target="_blank" rel="noopener">${esc(S.psd_feedback_link)}</a>`;
      status($('#pstatus'), ps.data.printers.some(p => p.testers_only) ? tf('psd_cr_testers', fbLink) : esc(S.psd_bambu_note), false, true);
      return;
    }
    btn.disabled = true; $('#pprev').hidden = $('#psend').hidden = $('#pmap').hidden = true;
    status($('#pstatus'), esc(S.psd_queued), true);
    const r = await postForm(fd).catch(e => ({ error: 'generic', detail: e.message }));
    if (!r.ok) { btn.disabled = false; status($('#pstatus'), errText(r), false, true); return; }
    ps.job = r.job; ps.gc = !!r.gcode;
    // „Vielleicht bemalt“ hat der Server jetzt geklärt: nicht mehrfarbig → kein Zuordnungsschritt, das sagen wir auch
    if (ps.mf && !ps.mf.sure && r.info3mf && !r.info3mf.multi && $('#pmulti')) { $('#pmulti').textContent = S.psd_multi_none; $('#pmulti').hidden = false; }
    const notes = [];
    if (r.info3mf) {
      notes.push(r.supports ? S.psd_sup_on_3mf : S.psd_sup_off_3mf);
      if (r.info3mf.keep && r.info3mf.keep.length) notes.push(S.psd_designer);
      if (r.info3mf.painted) notes.push(S.psd_painted);
      if (r.info3mf.plates > 1) notes.push(tf('psd_plates', r.info3mf.plates, r.info3mf.plate || 1));
      if (r.info3mf.off_plate) notes.push(tf('psd_off_plate', r.info3mf.off_plate.length, r.info3mf.off_plate.join(', ')));
    }
    $('#pnotes').innerHTML = notes.map(n => `<li>${esc(n)}</li>`).join('');
    if (r.mapping) { $('#pstatus').hidden = true; btn.disabled = false; renderMap(r.mapping); return; }
    poll();
  });
  // Mehrfarbig: je Projekt-Filament ein Fach wählen (vorbelegt nach Farbe/Material), dann erst slicen
  function renderMap(m) {
    const box = $('#pmap'), swOf = v => (m.slots.find(s => String(s.index) === String(v)) || {}).color || '';
    box.innerHTML = `<h3>${esc(S.psd_map_h)}</h3><p class="hint">${esc(tf('psd_map_note', m.fils.length))}</p>
      ${m.fils.map(f => `<div class="pmap-row"><span class="pmap-src"><span class="sw lg" style="${f.color ? 'background:' + esc(f.color) : ''}"></span>
        <span class="t"><b>${esc(tf('psd_map_fil', f.ext))}</b>${f.type ? `<span class="hint">${esc(tf('psd_map_mat', f.type))}</span>` : ''}${f.role ? `<span class="hint">${esc(S['psd_map_role_' + f.role] || '')}</span>` : ''}</span></span>
        <span class="hint">→</span><span class="sw lg" data-sw="${f.ext}"></span>
        <select class="in" data-ext="${f.ext}">${m.slots.map(s => `<option value="${s.index}"${(ps.lib && ps.lib.edMap && ps.lib.edMap[f.ext] != null ? +ps.lib.edMap[f.ext] : m.auto[f.ext]) === s.index ? ' selected' : ''}>${esc(tf('pc_slot_n', s.label) + ' · ' + s.material)}</option>`).join('')}</select></div>`).join('')}
      <div style="margin-top:12px"><button type="button" class="btn pri" id="pmapgo">${esc(S.psd_map_btn)}</button></div><div class="status" id="pmapstatus" hidden></div>`;
    box.hidden = false;
    if (ps.lib && ps.lib.edMap && m.fils.every(f => m.slots.some(s => s.index === +ps.lib.edMap[f.ext]))) setTimeout(() => { const g = $('#pmapgo'); if (g && !g.disabled) g.click(); }, 0);
    box.querySelectorAll('select').forEach(sel => {
      const paint = () => { box.querySelector(`[data-sw="${sel.dataset.ext}"]`).style.background = swOf(sel.value); };
      paint(); sel.addEventListener('change', paint);
    });
    $('#pmapgo').onclick = async e => {
      const map = {};
      box.querySelectorAll('select').forEach(sel => { map[sel.dataset.ext] = +sel.value; });
      e.target.disabled = true;
      try {
        const r = await fetch('api.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ a: 'print_map', job: ps.job, map }) }).then(x => x.json());
        if (!r.ok) { e.target.disabled = false; status($('#pmapstatus'), errText(r), false, true); return; }
        box.hidden = true; $('#pslice').disabled = true; status($('#pstatus'), esc(S.psd_queued), true); poll();
      } catch (err) { e.target.disabled = false; status($('#pmapstatus'), tf('psd_err_generic', esc(err.message)), false, true); }
    };
  }
  async function poll() {
    if (route().v !== 'print') return;
    const r = await get('print_job', { job: ps.job }).catch(() => null);
    if (!r) { ps.timer = setTimeout(poll, 2000); return; }
    if (r.status === 'queued') { status($('#pstatus'), esc(r.ahead ? tf('psd_queued_n', r.ahead) : S.psd_queued), true); ps.timer = setTimeout(poll, 1000); return; }
    if (r.status === 'slicing' && ps.gc) { status($('#pstatus'), esc(S.gc_wait), true); ps.timer = setTimeout(poll, 1000); return; }
    if (r.status === 'slicing') {
      const pg = r.progress;
      status($('#pstatus'), pg ? `<span class="pprog"><span>${esc(t('psd_progress', { step: t('psd_step_' + (pg.step || 'other')), p: pg.pct, s: r.elapsed || 0 }))}</span><span class="pbar"><i style="width:${+pg.pct}%"></i></span></span>`
        : esc(tf('psd_slicing', r.elapsed || 0)), true);
      ps.timer = setTimeout(poll, 1000); return;
    }
    $('#pslice').disabled = false;
    if (r.status === 'error') {
      const dims = a => a.filter(Boolean).map(x => nf1.format(x)).join(' × ') + ' mm';
      status($('#pstatus'), r.job_fit ? esc(t('psd_err_fit', { a: r.job_fit[0], n: r.job_fit[1] }))
        : r.job_bed ? esc(tf('psd_err_bed', dims(r.job_bed.model), dims(r.job_bed.bed))) : ((window.ampSeqErr && ampSeqErr(r.job_error)) || tf('psd_err_slice', esc(r.job_error || '?'))), false, true);
      return;
    }
    $('#pstatus').hidden = true;
    $('#ptime').textContent = r.stats.time != null ? pdur(r.stats.time) : '–';
    $('#pgrams').textContent = r.stats.grams != null ? nf1.format(r.stats.grams) + ' g' : '–';
    $('#pcost').textContent = r.cost != null ? cur.format(r.cost) : '–';
    $('#players').textContent = r.stats.layers || '–';
    const pn = $('#pnotes');
    if (r.fallback) {
      pn.insertAdjacentHTML('beforeend', `<li>${esc(r.fallback.single ? S.psd_multi_single : S.psd_fallback)}</li>`);
      if (r.fallback.skipped) pn.insertAdjacentHTML('beforeend', `<li>${esc(tf('psd_skipped', r.fallback.skipped))}</li>`);
    }
    // Mehrfarbig: Vorschau ist nach Fach gefärbt → Legende zeigt die Fächer statt der Linienarten
    const lg = $('#plegend');
    if (lg.dataset.base === undefined) lg.dataset.base = lg.innerHTML;
    if (typeof ampPrevTint === 'function') setTimeout(() => ampPrevTint(r, lg), 0);
    lg.innerHTML = r.paint ? r.paint.map(p => `<span><i style="background:${esc(p.color || '#888')}"></i>${esc(tf('pc_slot_n', p.label) + ' · ' + p.material)}</span>`).join('') : lg.dataset.base;
    if (r.paint) {
      r.paint.forEach(p => pn.insertAdjacentHTML('beforeend', `<li><span class="sw" style="${p.color ? 'background:' + esc(p.color) : ''}"></span> ${esc(tf('psd_map_line', p.label, p.material, nf1.format(p.g)))}</li>`));
      pn.insertAdjacentHTML('beforeend', `<li>${esc(S.psd_map_new)}</li>`);
    }
    if (r.skipped_objs) pn.insertAdjacentHTML('beforeend', `<li>${esc(t('psd_obj_skipped', { n: r.skipped_objs }))}</li>`);
    if (r.rearranged) pn.insertAdjacentHTML('beforeend', `<li>${esc(t('psd_arr_refit'))}</li>`);
    if (r.mix_temp) pn.insertAdjacentHTML('beforeend', `<li class="warn-t">${esc(t('psd_mix_temp', { a: r.mix_temp[0], b: r.mix_temp[1] }))}</li>`);
    // Mehrere STL / Experten-Einstellungen (23.10.2026)
    if (r.objs > 1) pn.insertAdjacentHTML('beforeend', `<li>${esc(t('psd_stl_done', { n: r.objs, f: r.files }))}</li>`);
    if (r.scale && r.scale !== 1) pn.insertAdjacentHTML('beforeend', `<li>${esc(t('psd_x_scaled', { p: nf1.format(r.scale * 100) }))}</li>`);
    if (r.x_applied) pn.insertAdjacentHTML('beforeend', `<li>${esc(t('psd_x_done', { n: r.x_applied }))}</li>`);
    if (r.x_clamped) pn.insertAdjacentHTML('beforeend', `<li class="warn-t">${esc(t('psd_x_lh_clamped', { a: nf2.format(r.x_clamped[1]), b: nf2.format(r.x_clamped[2]) }))}</li>`);
    if (r.pause && r.pause.length) pn.insertAdjacentHTML('beforeend', `<li class="warn-t">${esc(t('psd_x_paused', { z: r.pause.map(z => nf2.format(z)).join('; ') }))}</li>`);
    // Reicht die Spule? (16.10.2026) Braucht der Druck mehr, als auf der Spule im Fach ist → Hinweis + Nachkaufen (Partnerlink)
    (r.short || []).forEach(x => pn.insertAdjacentHTML('beforeend', `<li class="warn-t">${esc(t('pf_short', { slot: tf('pc_slot_n', x.slot), need: nf.format(x.need), left: nf.format(x.left), spool: x.spool }))}
      ${x.buy ? `<a href="${esc(x.buy)}" target="_blank" rel="sponsored nofollow noopener">${esc(t('buy_btn', { shop: x.shop }))} ↗</a> <small>(${esc(S.buy_tag)})</small>` : ''}</li>`));
    if (r.gcode) {
      pn.insertAdjacentHTML('beforeend', `<li>${esc(S.gc_note)}</li>`);
      const p = printer();
      if (r.gcode.mismatch) pn.insertAdjacentHTML('beforeend', `<li class="warn-t">${esc(t('gc_mismatch', { a: r.gcode.mismatch, b: p ? p.name : '' }))}</li>`);
      if (r.gcode.mat) pn.insertAdjacentHTML('beforeend', `<li class="warn-t">${esc(t('gc_mat', { a: r.gcode.mat[0], b: r.gcode.mat[1] }))}</li>`);
    }
    pn.insertAdjacentHTML('beforeend', `<li>${esc(r.profiles.machine + ' · ' + r.profiles.process + ' · ' + r.profiles.filament)}</li>`);
    $('#pconfirmtxt').textContent = r.gcode ? S.gc_confirm : tf('psd_confirm', plates[r.bed] || plates[$('#pbed').value]);
    $('#pkeepw').hidden = !!r.reprint;   // kam schon aus „Meine Druckdateien“
    $('#pqaddw').hidden = $('#pqaddbtn').hidden = !!r.reprint || !!r.sent; $('#pqaddbtn').disabled = false;
    $('#pconfirm').checked = false; $('#pconfirm').disabled = false; $('#psendbtn').disabled = true; $('#psendstatus').hidden = true;
    $('#pprev').hidden = false; $('#psend').hidden = !!r.sent;
    $('#puploadbtn').hidden = !r.upload_only; $('#puploadbtn').disabled = false;
    if (ps.viewer) ps.viewer.load('api.php?a=print_preview&job=' + encodeURIComponent(ps.job));
    $('#pprev').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#pconfirm').addEventListener('change', e => { $('#psendbtn').disabled = !e.target.checked; });
  const send = async (start, btn) => {
    btn.disabled = true;
    status($('#psendstatus'), esc(start ? S.psd_sending : S.psd_sending_up), true);
    try {
      const r = await fetch('api.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ a: 'print_send', job: ps.job, start: start ? 1 : 0, confirm: start ? 1 : 0, keep: $('#pkeep').checked && !$('#pkeepw').hidden ? 1 : 0, plate_ok: ps.plateOk ? 1 : 0 }) }).then(x => x.json());
      ps.plateOk = false;
      if (r.error === 'plate_check' && start) { if (confirm(t('amp_plate_ask'))) { ps.plateOk = true; return send(start, btn); } btn.disabled = false; status($('#psendstatus'), esc(t('amp_plate_stop')), false, true); return; }
      if (r.ok) keptDone(r.kept);
      if (r.ok && ps.src) get('print_files').then(x => renderFiles(x.files)).catch(() => {});   // umgestellte Datei folgt dem Drucker
      if (r.ok && r.pending) { if (start) $('#pconfirm').disabled = true; crPoll(btn); return; }
      if (r.ok) { status($('#psendstatus'), start ? esc(S.psd_sent) + ` <a href="#printers">${t('pr_h')}</a>` : esc(S.psd_uploaded)); if (start) $('#pconfirm').disabled = true; return; }
      btn.disabled = false; status($('#psendstatus'), errText(r), false, true);
    } catch (e) {
      // Antwort unterwegs verloren („Failed to fetch“: Handy gesperrt oder App gewechselt, während der Klipper-Agent bis 24 s
      // die Datei holt) — der Server sendet trotzdem fertig und der Drucker startet (24.10.2026, zweimal so gemeldet).
      // Erst beim Auftrag nachfragen, was daraus wurde; nur wenn sich nichts tut, den Fehler zeigen.
      let j = null;
      for (let i = 0; i < 15; i++) {
        await new Promise(ok => setTimeout(ok, 2000));
        j = await get('print_job', { job: ps.job }).catch(() => j);
        const a = j && j.agent, c = j && j.cr;
        if ((a && a.state !== 'failed') || (c && (CR_TXT[c.state] || c.state === 'sent')) || (j && j.sent)) {
          if (start) $('#pconfirm').disabled = true;
          if (ps.src) get('print_files').then(x => renderFiles(x.files)).catch(() => {});
          if (a || c) crPoll(btn); else status($('#psendstatus'), esc(S.psd_sent) + ` <a href="#printers">${t('pr_h')}</a>`);
          return;
        }
      }
      if (j && (j.agent || j.cr)) { crPoll(btn); return; }   // gescheitert: crPoll zeigt den Grund
      btn.disabled = false; status($('#psendstatus'), tf('psd_err_generic', esc(e.message)), false, true);
    }
  };
  // Gespeichert? Hinweis unter dem Senden + Liste oben neu (die gespeicherte Datei ist nicht mehr „neu“ zu speichern)
  function keptDone(k) {
    if (!k) return;
    if (k.error) { $('#pkeepw').insertAdjacentHTML('afterend', `<p class="hint pkept err-t">${errText(k)}</p>`); return; }
    $('#pkeepw').hidden = true;
    $('#pkeepw').insertAdjacentHTML('afterend', `<p class="hint pkept">${esc(k.dropped ? t('pf_replaced', { name: k.dropped }) : S.pf_saved)}</p>`);
    get('print_files').then(x => renderFiles(x.files)).catch(() => {});
  }
  // Creality: Upload, Cloud- und Druckerprüfung laufen im Worker — Stand abfragen, bis der Druckauftrag steht.
  // Klipper: der Agent überträgt die Datei noch (über langsames WLAN bis 25 Min.) — Stand abfragen, bis er fertig meldet.
  const CR_TXT = { upload: S.psd_cr_upload, cloud: S.psd_cr_cloud, device: S.psd_cr_device, task: S.psd_cr_task };
  const crPoll = async btn => {
    const r = await get('print_job', { job: ps.job }).catch(() => null);
    const a = r && r.agent;
    if (a && a.state === 'pending') { status($('#psendstatus'), esc(S.psd_agent_wait), true); setTimeout(() => crPoll(btn), 5000); return; }
    if (a && a.state === 'done') { status($('#psendstatus'), a.step === 'uploaded' ? esc(S.psd_uploaded) : esc(S.psd_sent) + ` <a href="#printers">${t('pr_h')}</a>`); return; }
    if (a) { btn.disabled = false; if (a.step === 'sent') $('#pconfirm').disabled = false; status($('#psendstatus'), errText({ error: 'agent_failed', detail: a.error }), false, true); return; }
    const c = (r && r.cr) || {};
    if (!r || CR_TXT[c.state]) { if (r) status($('#psendstatus'), esc(CR_TXT[c.state]), true); setTimeout(() => crPoll(btn), r ? 2000 : 3000); return; }
    if (c.state === 'sent') { status($('#psendstatus'), esc(S.psd_sent) + ` <a href="#printers">${t('pr_h')}</a>`); return; }
    btn.disabled = false; $('#pconfirm').disabled = false;
    status($('#psendstatus'), errText({ error: c.error || '?', detail: c.detail }), false, true);
  };
  $('#psendbtn').addEventListener('click', e => { if ($('#pconfirm').checked) send(true, e.target); });
  $('#puploadbtn').addEventListener('click', e => send(false, e.target));
  $('#pagain').addEventListener('click', e => { e.preventDefault(); viewPrint(); window.scrollTo(0, 0); });
}

// ── Ansicht: Benachrichtigungen ────────────────────────────────────────────
async function viewAlerts() {
  const d = await get('alerts'), p = d.prefs;
  // 05.10.2026 neu: Karten mit Schaltern statt Häkchen; je Warnung Titel + Beschreibung, Schwellwert daneben
  const tgl = k => `<label class="tgl" title=""><input type="checkbox" name="${k}" value="1"${+p[k] ? ' checked' : ''}><span></span></label>`;
  const row = (k, title, desc, extra) => `<div class="arow">${k ? tgl(k) : `<span class="tgl always" title="${esc(t('al_always'))}"><span></span></span>`}<span class="at"><b>${title}</b><span class="hint">${desc}</span></span>${extra || ''}</div>`;
  // Kanal mit Einrichtung (Telegram/Discord): Schalter erst nutzbar, wenn der Kanal eingerichtet ist
  const chRow = (k, title, desc, off) => `<div class="arow"><label class="tgl${off ? ' dis' : ''}"><input type="checkbox" name="${k}" value="1"${+p[k] && !off ? ' checked' : ''}${off ? ' disabled' : ''}><span></span></label><span class="at"><b>${title}</b><span class="hint">${desc}</span></span></div>`;
  const num = (n, v, min, max, pre) => `<label class="anum"><span>${pre}</span><input class="in num" type="number" name="${n}" value="${+v}" min="${min}" max="${max}"><span>%</span></label>`;
  view.innerHTML = prHead('alerts') + `<div id="amsg"></div><form id="af">
    <section class="card scard"><h2>${S.pa_when}</h2>
      ${row('on_low', esc(S.pa_low_t), esc(S.pa_on_low), num('low_pct', p.low_pct, 1, 50, esc(S.pa_below)))}
      ${row('on_humid', esc(S.pa_humid_t), esc(S.pa_on_humid), num('humid_pct', p.humid_pct, 20, 90, esc(S.pa_from)))}
      ${row('on_failed', esc(S.pa_failed_t), esc(S.pa_on_failed))}
      ${row('on_done', esc(S.pa_done_t), esc(S.pa_on_done))}
      ${row('on_maint', esc(t('al_maint')), `${esc(t('al_maint_s'))} <a href="#maint">${esc(t('pr_tab_maint'))}</a>`)}
      ${row('on_offline', esc(t('al_off')), esc(t('al_off_s')))}
      ${row('', esc(S.pa_conn_t), esc(t('al_conn_s')))}
    </section>
    <section class="card scard"><h2>${S.pa_how}</h2>
      ${row('via_email', esc(t('al_email')), esc(d.email))}
      ${row('via_push', esc(S.pa_via_push), `<span id="apush">${d.push_devices ? tf('pa_push_devices', d.push_devices) : S.pa_push_none}</span> <button type="button" class="lnk" id="apushbtn" hidden>${S.pa_push_enable}</button>`)}
      ${d.telegram.available ? chRow('via_telegram', 'Telegram', d.telegram.linked
        ? `${esc(t('al_tg_linked'))} · <button type="button" class="lnk" id="tgoff">${esc(t('al_disconnect'))}</button>`
        : `${esc(t('al_tg_s'))}<span class="ch-act"><button type="button" class="btn sm" id="tglink">${esc(t('al_tg_btn'))}</button></span><span id="tgwait" class="hint"></span>`, !d.telegram.linked) : ''}
      ${chRow('via_discord', 'Discord', d.discord.set
        ? `${esc(t('al_dc_set', { h: d.discord.hint || '' }))} · <button type="button" class="lnk" id="dcedit">${esc(t('change'))}</button> · <button type="button" class="lnk" id="dcoff">${esc(t('al_disconnect'))}</button><span id="dcform" hidden></span>`
        : `${esc(t('al_dc_s'))}<span id="dcform"></span>`, !d.discord.set)}
      <p class="hint" style="margin:12px 0 0">${S.pa_note}</p>
    </section>
    <div class="actions"><button class="btn pri">${S.pc_save}</button><button type="button" class="btn" id="atest">${S.pa_test_btn}</button></div></form>`;
  const show = (k, err) => { $('#amsg').innerHTML = msgBox(esc(S[k] || t('err_generic')), err); };
  $('#af').onsubmit = async e => {
    e.preventDefault();
    try { await api('alerts_save', Object.fromEntries(new FormData(e.target))); show('pa_msg_saved'); } catch (er) { show(er.message, true); }
  };
  $('#atest').onclick = async () => {
    try { const r = await api('alerts_test', {}); show(r.msg); } catch (er) { show(er.message, true); }
  };
  // Telegram: Einmal-Link öffnen, danach kurz nachfragen, bis der Bot die Kopplung gemeldet hat (höchstens 3 Min.)
  const tgl_ = $('#tglink');
  if (tgl_) tgl_.onclick = async () => {
    const w = window.open('about:blank', '_blank');   // vor dem await öffnen, sonst blockiert der Browser das Fenster
    try {
      const r = await api('tg_link', {});
      if (w) w.location = r.url; else location.href = r.url;
      $('#tgwait').textContent = ' ' + t('al_tg_wait');
      const g0 = navGen, t0 = Date.now();
      const poll = setInterval(async () => {
        if (g0 !== navGen || Date.now() - t0 > 180000) { clearInterval(poll); return; }
        try { const a = await get('alerts'); if (a.telegram.linked) { clearInterval(poll); toast(t('al_tg_ok')); viewAlerts(); } } catch (e) { /* weiter */ }
      }, 3000);
    } catch (er) { if (w) w.close(); show(er.message, true); }
  };
  const tgo = $('#tgoff');
  if (tgo) tgo.onclick = async () => { try { await api('tg_unlink', {}); viewAlerts(); } catch (er) { show(er.message, true); } };
  // Discord: Webhook-Adresse eingeben (wird verschlüsselt gespeichert und nie wieder angezeigt)
  const dcForm = () => {
    const box = $('#dcform'); box.hidden = false;
    box.innerHTML = `<span class="ch-form"><input class="in" id="dcurl" type="url" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" aria-label="Discord Webhook">
      <button type="button" class="btn sm pri" id="dcsave">${esc(t('save'))}</button></span><span class="hint ch-help">${esc(t('al_dc_help'))}</span>`;
    $('#dcsave').onclick = async () => {
      const u = $('#dcurl').value.trim(); if (!u) return;
      try { await api('discord_save', { url: u }); toast(t('al_dc_ok')); viewAlerts(); } catch (er) { show(er.message, true); }
    };
  };
  if (!d.discord.set) dcForm();
  const dce = $('#dcedit'); if (dce) dce.onclick = dcForm;
  const dco = $('#dcoff'); if (dco) dco.onclick = async () => { try { await api('discord_save', { url: '' }); viewAlerts(); } catch (er) { show(er.message, true); } };
  const pb = $('#apushbtn');
  if (window.pushStatus && window.enablePush && 'PushManager' in window) {
    try {
      if (await window.pushStatus() !== 'subscribed') {
        pb.hidden = false;
        pb.onclick = async () => { const r = await window.enablePush().catch(() => ({ ok: false })); if (r && r.ok) viewAlerts(); else pb.textContent = S.pa_push_blocked; };
      }
    } catch (e) { /* kein Push */ }
  }
}

// ── Eigene Felder ──────────────────────────────────────────────────────────
async function loadFields(force) { if (!st.fields || force) st.fields = (await get('fields')).fields; return st.fields; }
const fieldsOf = e => (st.fields || []).filter(f => f.entity === e);
function fieldInput(f, v) {
  const n = 'cf_' + f.id, val = v ?? '';
  if (f.type === 'bool') return `<label class="chk" style="height:38px"><input type="checkbox" name="${n}" value="1"${val === '1' ? ' checked' : ''}> ${esc(f.label)}</label>`;
  if (f.type === 'select') return `<label class="fld"><span>${esc(f.label)}</span><select class="in" name="${n}"><option value=""></option>${String(f.options || '').split(',').map(o => o.trim()).filter(Boolean)
    .map(o => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  const type = { number: 'number', date: 'date', url: 'url' }[f.type] || 'text';
  return `<label class="fld"><span>${esc(f.label)}</span><input class="in" name="${n}" type="${type}"${type === 'number' ? ' step="any"' : ''} value="${esc(val)}" maxlength="500"></label>`;
}
function fieldValues(form, fields) {
  const out = {};
  fields.forEach(f => { const el = form.elements['cf_' + f.id]; if (el) out[f.id] = f.type === 'bool' ? (el.checked ? '1' : '') : el.value; });
  return out;
}
function fieldShow(f, v) {
  if (f.type === 'bool') return v === '1' ? '✓' : '–';
  if (f.type === 'url') return /^https?:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v.replace(/^https?:\/\//, '').slice(0, 40))}</a>` : esc(v);
  if (f.type === 'date') return date(v + ' 00:00:00');
  return esc(v);
}

// ── Filament aus dem Katalog: Details + eigene Felder (Filament/Hersteller) ─
async function filamentDialog(it) {
  await loadFields();
  const d = await get('filament_custom', { filament: it.id }).catch(fail); if (!d) return;
  const f = d.filament, ff = fieldsOf('filament'), fv = fieldsOf('vendor');
  const kv = [[t('f_brand'), esc(f.vendor)], [t('f_material'), esc(f.material)], [t('c_net'), f.weight_g ? g(f.weight_g) : '–'],
    [t('c_spool'), f.spool_weight_g ? g(f.spool_weight_g) : f.vendor_spool ? '~' + g(f.vendor_spool) : '–'], [t('f_diameter'), dia(+f.diameter)],
    f.density && [t('f_density'), f.density + ' g/cm³'], f.extruder_temp && [t('f_temps'), `${f.extruder_temp} °C / ${f.bed_temp ?? '–'} °C`],
    [t('in_stock'), d.in_stock.n ? `${d.in_stock.n} · ${g(d.in_stock.g)}` : '–']].filter(Boolean);
  dlg.innerHTML = `<form method="dialog" id="ffd"><div class="dlg-h"><span class="sw lg" style="background:${esc(it.color || '#888')}"></span><b>${esc(catName(it))}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b"><dl class="kv" style="margin:0">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${ff.length ? `<div class="fld"><span>${t('fields_filament')}</span></div><div class="fgrid">${ff.map(x => fieldInput(x, d.values[x.id])).join('')}</div>` : ''}
    ${fv.length ? `<div class="fld"><span>${t('fields_vendor', { v: esc(f.vendor) })}</span></div><div class="fgrid">${fv.map(x => fieldInput(x, d.values[x.id])).join('')}</div>` : ''}
    ${!ff.length && !fv.length ? `<p class="hint" style="margin:0">${t('fields_none_cat')} <a href="#settings">${t('tab_settings')}</a></p>` : ''}</div>
    <div class="dlg-f"><button type="button" class="btn" id="ffadd">+ ${t('add_short')}</button><span style="flex:1"></span><button type="button" class="btn ghost" data-x>${t('cancel')}</button>
    ${ff.length || fv.length ? `<button class="btn pri">${t('save')}</button>` : ''}</div></form>`;
  const form = $('#ffd');
  form.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  $('#ffadd').onclick = () => { dlg.close(); editSpool(null, it); };
  form.onsubmit = async e => {
    e.preventDefault();
    try { await api('filament_custom_save', { filament: it.id, values: fieldValues(form, ff.concat(fv)) }); dlg.close(); toast(t('saved')); } catch (er) { fail(er); }
  };
  dlg.showModal();
}

// ── Ansicht: Einstellungen (eigene Felder, Etiketten, Import) ──────────────
const ENT = () => ({ spool: t('ent_spool'), filament: t('ent_filament'), vendor: t('ent_vendor') });
const TYPES = () => ({ text: t('ft_text'), number: t('ft_number'), date: t('ft_date'), select: t('ft_select'), bool: t('ft_bool'), url: t('ft_url') });
// Einstellungen (05.10.2026 angeglichen): einheitlicher Kartenkopf mit Symbol, Aktion rechts
const SICO = {
  fields: '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/>',
  label: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  imp: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  exp: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/>',
  ha: '<path d="M3 11 12 3l9 8"/><path d="M5 9.5V21h14V9.5"/><circle cx="12" cy="14" r="2"/><path d="M12 16v5"/>',
  cost: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' };
const HA_REPO = 'https://github.com/nolimitek/ha-3dsearch';
const sHead = (ico, title, desc, action) => `<div class="shead"><span class="sico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SICO[ico]}</svg></span>
  <div class="sh-t"><h2>${title}</h2><p class="hint">${desc}</p></div>${action || ''}</div>`;
async function viewSettings_3ds() {
  await loadFields(true);
  const ent = ENT(), types = TYPES();
  const fieldRow = f => `<li data-id="${f.id}"><span><b>${esc(f.label)}</b> <span class="hint">${types[f.type]}${f.type === 'select' ? ': ' + esc(f.options) : ''}</span></span>
    <span class="grow"></span><button class="icon-btn" data-fup="${f.id}" aria-label="${esc(t('move_up'))}" title="${esc(t('move_up'))}">↑</button>
    <button class="lnk" data-fedit="${f.id}">${t('act_edit')}</button><button class="lnk" style="color:var(--bad)" data-fdel="${f.id}">${t('act_delete')}</button></li>`;
  view.innerHTML = `<h1>${t('settings_h')}</h1><p class="lead">${t('settings_lead')}</p>
  <section class="ccard">${sHead('fields', t('fields_h'), t('fields_lead'))}
    ${(st.fields || []).length ? ['spool', 'filament', 'vendor'].filter(e => fieldsOf(e).length).map(e => `<div class="fgroup"><div class="group-h">${ent[e]}</div>
      <ul class="flist">${fieldsOf(e).map(fieldRow).join('')}</ul></div>`).join('') : `<p class="hint sempty">${t('fields_empty')}</p>`}
    <form class="fgrid" id="fnew" style="margin-top:14px;align-items:end">
      <label class="fld"><span>${t('field_label')}</span><input class="in" name="label" required maxlength="60" placeholder="${esc(t('field_label_ph'))}"></label>
      <label class="fld"><span>${t('field_for')}</span><select class="in" name="entity">${Object.entries(ent).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="fld"><span>${t('field_type')}</span><select class="in" name="type">${Object.entries(types).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="fld" id="fopts" hidden><span>${t('field_options')}</span><input class="in" name="options" maxlength="500" placeholder="${esc(t('field_options_ph'))}"></label>
      <div><button class="btn pri">+ ${t('field_add')}</button></div>
    </form></section>
  <section class="ccard">${sHead('label', t('lbl_title'), t('labels_set_lead'), `<button class="btn" id="lblset">${t('labels_set_btn')}</button>`)}</section>
  <section class="ccard" id="costs">${sHead('cost', t('cost_h'), t('cost_lead'))}<div id="costbox"><div class="loading">${t('loading')}</div></div></section>
  ${FM.embed ? '' : `<section class="ccard" id="ha">${sHead('ha', 'Home Assistant', t('ha_lead'), `<a class="btn" href="${HA_REPO}" target="_blank" rel="noopener">GitHub</a>`)}
    <ol class="steps"><li>${tf('ha_s1', `<a href="${HA_REPO}" target="_blank" rel="noopener">nolimitek/ha-3dsearch</a>`)}</li><li>${t('ha_s2')}</li><li>${t('ha_s3')}</li></ol>
    <div id="hanewkey"></div><div id="hakeys"></div>
    <form class="inline" id="hanew" style="margin-top:10px"><input class="in" name="name" maxlength="60" placeholder="Home Assistant" style="flex:1;min-width:200px" aria-label="${esc(t('ha_name'))}"><button class="btn pri">+ ${t('ha_create')}</button></form>
  </section>`}
  ${ioHtml()}`;
  const nf_ = $('#fnew');
  nf_.type.onchange = () => { $('#fopts').hidden = nf_.type.value !== 'select'; };
  nf_.onsubmit = async e => { e.preventDefault(); try { await api('field_save', Object.fromEntries(new FormData(nf_))); toast(t('saved')); viewSettings(); } catch (er) { fail(er); } };
  view.querySelectorAll('[data-fdel]').forEach(b => b.onclick = async () => {
    if (!confirm(t('field_del_confirm'))) return;
    try { await api('field_delete', { id: +b.dataset.fdel }); viewSettings(); } catch (er) { fail(er); }
  });
  view.querySelectorAll('[data-fup]').forEach(b => b.onclick = async () => {
    const f = st.fields.find(x => x.id === +b.dataset.fup), list = fieldsOf(f.entity).map(x => x.id), i = list.indexOf(f.id);
    if (i < 1) return; [list[i - 1], list[i]] = [list[i], list[i - 1]];
    try { await api('field_order', { ids: list }); viewSettings(); } catch (er) { fail(er); }
  });
  view.querySelectorAll('[data-fedit]').forEach(b => b.onclick = () => {
    const f = st.fields.find(x => x.id === +b.dataset.fedit);
    dlg.innerHTML = `<form method="dialog" id="fed"><div class="dlg-h"><b>${esc(f.label)}</b><button type="button" class="x-btn" data-x>×</button></div><div class="dlg-b fgrid">
      <label class="fld"><span>${t('field_label')}</span><input class="in" name="label" required maxlength="60" value="${esc(f.label)}"></label>
      <label class="fld"><span>${t('field_type')}</span><select class="in" name="type">${Object.entries(types).map(([k, v]) => `<option value="${k}"${k === f.type ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="fld wide"><span>${t('field_options')}</span><input class="in" name="options" maxlength="500" value="${esc(f.options || '')}" placeholder="${esc(t('field_options_ph'))}"></label></div>
      <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form>`;
    const fe = $('#fed');
    fe.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
    fe.onsubmit = async e => { e.preventDefault(); try { await api('field_save', { id: f.id, ...Object.fromEntries(new FormData(fe)) }); dlg.close(); viewSettings(); } catch (er) { fail(er); } };
    dlg.showModal();
  });
  if (!FM.embed) bindHA();
  bindCosts();
  $('#lblset').onclick = async () => { if (!st.spools.length) await loadSpools(); window.open('label.php?ids=' + st.spools.filter(s => !s.archived).slice(0, 12).map(s => s.id).join(','), '_blank'); };
  bindIO();
}

// ── Einstellungen: Home Assistant (persönliche API-Schlüssel, Gegenstelle /api/ha.php) ──
function haKeys(keys) {
  $('#hakeys').innerHTML = keys.length ? `<ul class="flist hakeys">${keys.map(k => `<li><span><b>${esc(k.name)}</b> <span class="hint">3ds_…${esc(k.hint)} · ${t('ha_created', { d: date(k.created) })} · ${k.used ? t('ha_used', { t: ago(k.used) }) : t('ha_never')}</span></span>
    <span class="grow"></span><button class="lnk" style="color:var(--bad)" data-krev="${k.id}">${t('ha_revoke')}</button></li>`).join('')}</ul>` : `<p class="hint sempty">${t('ha_none')}</p>`;
  view.querySelectorAll('[data-krev]').forEach(b => b.onclick = async () => {
    if (!confirm(t('ha_revoke_confirm'))) return;
    try { const d = await api('api_key_revoke', { id: +b.dataset.krev }); $('#hanewkey').innerHTML = ''; haKeys(d.keys); } catch (er) { fail(er); }
  });
}
async function bindHA() {
  const f = $('#hanew');
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      const d = await api('api_key_create', { name: f.name.value });
      f.reset(); haKeys(d.keys);
      // Der Schlüssel steht nur in dieser Antwort — danach kennt ihn auch der Server nicht mehr
      $('#hanewkey').innerHTML = `<div class="note hakey"><b>${t('ha_key_once')}</b><div class="cmd"><code id="hakeyval">${esc(d.key)}</code><button class="btn sm" type="button" id="hacopy">${S.pc_mr_copy}</button></div></div>`;
      $('#hacopy').onclick = () => navigator.clipboard.writeText(d.key).then(() => { $('#hacopy').textContent = S.pc_mr_copied; });
    } catch (er) { fail(er); }
  };
  try { haKeys((await get('api_keys')).keys); } catch (er) { fail(er); }
}

// ── Einstellungen: Druckkosten (Strompreis, Verschleiß je Stunde, Leistung je Drucker; 07.10.2026) ──
async function bindCosts() {
  const d = await get('costs').catch(fail); if (!d) return;
  const c = d.cfg, num = v => v === null || v === undefined ? '' : v;
  const curName = (() => { try { const dn = new Intl.DisplayNames(LANG, { type: 'currency' }); return c => dn.of(c); } catch (e) { return c => c; } })();
  $('#costbox').innerHTML = `<div class="fgrid"><label class="fld"><span>${esc(t('cur_label'))}</span><select class="in" id="fcur">${(d.currencies || ['EUR']).map(c =>
      `<option value="${c}"${c === FM.cur ? ' selected' : ''}>${esc(c + ' · ' + curName(c))}</option>`).join('')}</select></label></div>
    <p class="hint">${esc(t('cur_hint'))}</p>
    <form id="fcost"><div class="fgrid">
      <label class="fld"><span>${esc(t('cost_kwh', { c: CSYM }))}</span><input class="in num" name="kwh" type="number" min="0" max="5" step="0.001" value="${num(c.kwh)}" placeholder="0.30"></label>
      <label class="fld"><span>${esc(t('cost_wear', { c: CSYM }))}</span><input class="in num" name="wear_h" type="number" min="0" max="100" step="0.01" value="${num(c.wear_h)}" placeholder="0.00"></label></div>
    ${d.printers.length ? `<div class="fld" style="margin-top:12px"><span>${t('cost_power')}</span></div>
      <ul class="flist cost-pr">${d.printers.map(p => `<li><span class="grow"><b>${esc(p.name)}</b> <span class="hint">${esc(p.model && p.model !== p.name ? p.model : t('prov_' + p.provider))}</span></span>
        <label class="anum"><input class="in num" type="number" min="1" max="3000" step="1" data-pw="${esc(p.provider + ':' + p.pid)}" value="${num(p.power_w)}" placeholder="–" aria-label="${esc(p.name)} W"><span>W</span></label></li>`).join('')}</ul>
      <p class="hint">${t('cost_power_hint')}</p>` : `<p class="hint">${t('cost_no_printers')}</p>`}
    <div class="actions" style="margin-top:10px"><button class="btn pri">${t('save')}</button></div></form>`;
  $('#fcur').onchange = async e => {
    e.target.disabled = true;
    try { await api('settings_save', { k: 'currency', v: { c: e.target.value } }); toast(t('saved')); location.reload(); }
    catch (er) { e.target.disabled = false; fail(er); }
  };
  $('#fcost').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, power = {};
    f.querySelectorAll('[data-pw]').forEach(i => { power[i.dataset.pw] = i.value; });
    try { await api('costs_save', { kwh: f.kwh.value, wear_h: f.wear_h.value, power }); toast(t('saved')); } catch (er) { fail(er); }
  };
}

// ── Druck-Warteschlange (#queue, 22.10.2026; vorher eigene Seite printqueue.php der Hauptseite — leitet jetzt hierher) ──
// Daten und alle Änderungen über /printqueue_api.php (list, move, reorder, update, remove, set_project, cloud_*): die Regeln für
// Statuswechsel, Filamentabzug und Kartenlimit bleiben an einer Stelle (printqueue_lib.php). Karten sind Modelle (model_id) oder
// eigene Druckdateien (model_id „file:<id>“, „In die Warteschlange“ im Druck-Dialog). Ziehen mit SortableJS (cdnjs, bei Bedarf geladen).
const QCOLS = ['queue', 'slicing', 'printing', 'done'];
const qdur = m => m >= 60 ? tf('psd_h_min', Math.floor(m / 60), m % 60) : tf('psd_min', m);
const qs = { d: null, filter: '*', sort: [], col: 'queue' };
const qApi = body => fetch('/printqueue_api.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(r => r.json()).catch(() => ({ ok: false }));
const qLimit = r => { if (r && r.error === 'limit') { toast(tf('pq_limit_hit', r.max)); return true; } return false; };
let qSortLib = null;
const qLoadSortable = () => qSortLib || (qSortLib = new Promise((res, rej) => {
  if (window.Sortable) return res();
  const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.6/Sortable.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s);
}));
async function viewQueue() {
  view.innerHTML = prHead('queue') + `<div class="loading">${t('loading')}</div>`;
  const d = await fetch('/printqueue_api.php?action=list', { credentials: 'same-origin' }).then(r => r.json());
  if (!d.ok) throw new Error('generic');
  qs.d = d;
  try { qs.filter = localStorage.getItem('pq_proj') ?? '*'; qs.col = QCOLS.includes(localStorage.getItem('pq_col')) ? localStorage.getItem('pq_col') : 'queue'; } catch (e) { qs.filter = '*'; }
  drawQueue();
}
function drawQueue() {
  const d = qs.d, cards = d.cards;
  const projects = {}; let noProj = 0;
  cards.forEach(c => { if (c.project) projects[c.project] = (projects[c.project] || 0) + 1; else noProj++; });
  const pnames = Object.keys(projects).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (qs.filter !== '*' && !(qs.filter === '' ? noProj && pnames.length : projects[qs.filter])) qs.filter = '*';
  const shown = c => qs.filter === '*' || (c.project || '') === qs.filter;
  let h = prHead('queue');
  // Cloud: fertiger Druck → passende Karte auf „Fertig“ (pc_open_suggestions)
  const open = cards.filter(c => c.status !== 'done');
  d.suggest.forEach(sg => {
    h += `<div class="note qsug" data-sug="${sg.id}"><span class="grow">${tf('pq_cloud_done', `<b>${esc(sg.title)}</b>`, esc(sg.printer))}${sg.grams ? ` · ${nf.format(sg.grams)} g` : ''}${sg.card ? '' : `<br><span class="hint">${esc(t('pq_cloud_no_match'))}</span>`}</span>
      ${open.length ? `<select class="in"><option value="">${esc(t('pq_cloud_pick_card'))}</option>${open.map(c => `<option value="${c.id}"${c.id === sg.card ? ' selected' : ''}>${esc(c.name.length > 60 ? c.name.slice(0, 59) + '…' : c.name)}</option>`).join('')}</select>
      <button type="button" class="btn sm pri" data-sok>${esc(t('pq_cloud_mark_done'))}</button>` : ''}<button type="button" class="btn sm ghost" data-sno>${esc(t('pq_cloud_ignore'))}</button></div>`;
  });
  if (!cards.length) {
    view.innerHTML = h + `<div class="empty"><b>${esc(t('pq_onboard_title'))}</b>${esc(t('pq_onboard_desc'))}<br><br>
      <a class="btn pri" href="/">${esc(t('pq_onboard_browse'))}</a> <a class="btn" href="#print">${esc(t('pq_add_btn'))}</a></div>`;
    qBindSug(); return;
  }
  if (!d.supporter && d.limit < 1e9) h += `<p class="hint qquota">${esc(t('q_quota', { n: d.active, max: d.limit }))} <a href="/supporter.php">${esc(t('sup_become'))}</a></p>`;
  h += `<div class="qbar"><div class="chips">
      <button type="button" class="chip${qs.filter === '*' ? ' on' : ''}" data-p="*">${esc(t('pq_proj_all'))} <b>${cards.length}</b></button>
      ${pnames.map(p => `<button type="button" class="chip${qs.filter === p ? ' on' : ''}" data-p="${esc(p)}">${esc(p)} <b>${projects[p]}</b></button>`).join('')}
      ${pnames.length && noProj ? `<button type="button" class="chip${qs.filter === '' ? ' on' : ''}" data-p="">${esc(t('pq_proj_none'))} <b>${noProj}</b></button>` : ''}</div>
    <button type="button" class="btn sm ghost" id="qselbtn">${esc(t('pq_proj_select'))}</button></div>
    <div class="note qselbar" id="qselbar" hidden><b id="qseln"></b><input class="in" id="qselproj" list="qprojl" maxlength="80" placeholder="${esc(t('pq_proj_ph'))}">
      <button type="button" class="btn sm pri" id="qselgo">${esc(t('pq_proj_move'))}</button><button type="button" class="btn sm ghost" id="qselx">${esc(t('pq_cancel'))}</button>
      <span class="hint">${esc(t('pq_proj_hint'))}</span></div>
    <datalist id="qprojl">${pnames.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
    <div class="qtabs" role="tablist">${QCOLS.map(st => `<button type="button" role="tab" class="qtab${qs.col === st ? ' on' : ''}" data-col="${st}" aria-selected="${qs.col === st}">${esc(t('pq_' + st))} <b>${cards.filter(c => c.status === st && shown(c)).length}</b></button>`).join('')}</div>
    <div class="qboard" id="qboard" data-col="${qs.col}">${QCOLS.map(st => {
      const list = cards.filter(c => c.status === st && shown(c));
      return `<section class="qcol" data-st="${st}"><div class="qcol-h"><b>${esc(t('pq_' + st))}</b><span class="qn">${list.length}</span></div>
        <div class="qlist" data-st="${st}">${list.map(qCard).join('') || `<p class="qempty">${esc(t('pq_empty'))}</p>`}</div></section>`;
    }).join('')}</div>`;
  view.innerHTML = h;
  qBindSug();
  view.querySelectorAll('.qbar [data-p]').forEach(b => b.onclick = () => { qs.filter = b.dataset.p; try { localStorage.setItem('pq_proj', qs.filter); } catch (e) {} drawQueue(); });
  // Handy (≤ 760 px): eine Spalte, Umschalter oben statt seitlich wischen (User 22.10.2026: „mobil passt das nicht“)
  view.querySelectorAll('.qtab').forEach(b => b.onclick = () => {
    qs.col = b.dataset.col; try { localStorage.setItem('pq_col', qs.col); } catch (e) {}
    $('#qboard').dataset.col = qs.col;
    view.querySelectorAll('.qtab').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
  });
  view.querySelectorAll('[data-qmove]').forEach(s => s.onchange = () => qMove(s.dataset.qmove, s.value));
  view.querySelectorAll('[data-qedit]').forEach(b => b.onclick = () => qEdit(qs.d.cards.find(c => c.model_id === b.dataset.qedit)));
  view.querySelectorAll('[data-qdel]').forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.classList.add('danger'); b.title = t('pq_remove_confirm'); toast(t('pq_remove_confirm')); return; }   // zweiter Klick löscht
    await qApi({ action: 'remove', model_id: b.dataset.qdel }); qs.d.cards = qs.d.cards.filter(c => c.model_id !== b.dataset.qdel); drawQueue();
  });
  // Mehrfachauswahl → Projekt
  const selOn = on => {
    $('#qboard').classList.toggle('qsel', on); $('#qselbar').hidden = !on; $('#qselbtn').classList.toggle('on', on);
    qs.sort.forEach(s => s.option('disabled', on));
    if (!on) view.querySelectorAll('.qchk input').forEach(i => { i.checked = false; });
    else if (qs.filter !== '*') $('#qselproj').value = qs.filter;
    selN();
  };
  const selN = () => { $('#qseln').textContent = tf('pq_proj_n', view.querySelectorAll('.qchk input:checked').length); };
  $('#qselbtn').onclick = () => selOn($('#qselbar').hidden);
  $('#qselx').onclick = () => selOn(false);
  view.querySelectorAll('.qchk input').forEach(i => i.onchange = selN);
  view.querySelectorAll('.qcard').forEach(c => c.addEventListener('click', e => {
    if (!$('#qboard').classList.contains('qsel') || e.target.closest('button, select, a, .qchk')) return;
    const i = c.querySelector('.qchk input'); i.checked = !i.checked; selN();
  }));
  $('#qselgo').onclick = async () => {
    const ids = [...view.querySelectorAll('.qchk input:checked')].map(i => i.closest('.qcard').dataset.mid);
    if (!ids.length) return;
    const p = $('#qselproj').value.trim();
    const r = await qApi({ action: 'set_project', model_ids: ids, project: p });
    if (!r.ok) { toast(t('err_generic')); return; }
    qs.d.cards.forEach(c => { if (ids.includes(c.model_id)) c.project = p || null; });
    qs.filter = p || '*'; try { localStorage.setItem('pq_proj', qs.filter); } catch (e) {}
    drawQueue();
  };
  // Ziehen zwischen den Spalten (Reihenfolge + Status) — wie die alte Seite: reorder mit allen Karten der Zielspalte
  qLoadSortable().then(() => {
    if (!$('#qboard')) return;
    qs.sort = [...view.querySelectorAll('.qlist')].map(el => Sortable.create(el, { group: 'pq', animation: 150, filter: '.qempty, select, button, a, input', preventOnFilter: false,
      // eigener Zieh-Modus statt HTML5-Drag: gleich mit Maus und Finger; am Handy erst nach kurzem Halten, damit Wischen scrollt
      forceFallback: true, fallbackTolerance: 4, delay: 180, delayOnTouchOnly: true,
      ghostClass: 'qghost', onEnd: async ev => {
        if (ev.from === ev.to && ev.oldIndex === ev.newIndex) return;
        const st = ev.to.dataset.st, mid = ev.item.dataset.mid;
        // gefilterte Karten fehlen im DOM → Reihenfolge der sichtbaren Karten, die ausgeblendeten bleiben dahinter
        const ids = [...ev.to.querySelectorAll('.qcard')].map(c => c.dataset.mid);
        qs.d.cards.filter(c => c.status === st && !ids.includes(c.model_id) && c.model_id !== mid).forEach(c => ids.push(c.model_id));
        const r = await qApi({ action: 'reorder', status: st, model_ids: ids });
        if (qLimit(r)) return viewQueue();
        const c = qs.d.cards.find(x => x.model_id === mid); if (c) c.status = st;
        qs.d.cards.sort((a, b) => ids.indexOf(a.model_id) - ids.indexOf(b.model_id));
        drawQueue();
      } }));
  }).catch(() => { /* ohne SortableJS bleibt „Verschieben“ */ });
}
function qCard(c) {
  const sel = `<select class="in sm qmove" data-qmove="${esc(c.model_id)}"><option value="">${esc(t('pq_move'))}</option>${QCOLS.filter(s => s !== c.status).map(s => `<option value="${s}">${esc(t('pq_' + s))}</option>`).join('')}</select>`;
  const pr = c.printer_id && qs.d.printers.find(p => p.id === c.printer_id), fl = c.filament_id && qs.d.filaments.find(f => f.id === c.filament_id);
  const tags = [c.project ? `<span class="tag on qproj">${I_FOLDER}${esc(c.project)}</span>` : '', pr ? `<span class="tag">${esc(pr.name)}</span>` : '',
    fl ? `<span class="tag"><i class="qsw" style="background:${esc(fl.color || '#888')}"></i>${esc(fl.name)}</span>` : c.filament ? `<span class="tag">${esc(c.filament)}</span>` : '',
    c.print_time ? `<span class="tag">${esc(c.print_time)}</span>` : '', c.weight ? `<span class="tag">${nf.format(c.weight)} g</span>` : '',
    c.status === 'done' && c.completed_at ? `<span class="tag">${esc(date(c.completed_at))}</span>` : ''].join('');
  const f = c.file;
  const meta = f ? [f.printer, f.grams != null ? nf.format(Math.round(f.grams)) + ' g' : '', f.minutes != null ? qdur(f.minutes) : ''].filter(Boolean).join(' · ')
    : [c.source, c.designer].filter(Boolean).join(' · ');
  return `<article class="qcard" data-mid="${esc(c.model_id)}"><label class="qchk"><input type="checkbox" aria-label="${esc(c.name)}"></label>
    ${f ? `<div class="qfile">${I_GCODE}<span>G-Code</span>${(f.paint || []).slice(0, 6).map(p => `<i style="background:${esc(p.color || '#888')}" title="${esc(p.material || '')}"></i>`).join('')}</div>`
        : c.img ? `<img class="qimg" src="${esc(c.img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    <div class="qbody"><b class="qname">${esc(c.name)}</b>${meta ? `<span class="hint">${esc(meta)}</span>` : ''}${c.notes ? `<span class="qnotes">${esc(c.notes)}</span>` : ''}${tags ? `<div class="qtags">${tags}</div>` : ''}</div>
    <div class="qact">${sel}<button type="button" class="icon-btn" data-qedit="${esc(c.model_id)}" title="${esc(t('pq_edit'))}" aria-label="${esc(t('pq_edit'))}">${I_PEN}</button>
      ${f ? `<a class="btn sm pri" href="#print/file/${f.id}" title="${esc(t('pq_send_printer'))}">${I_PRINTER_S} ${esc(t('pq_send_short'))}</a>`
          : `<a class="icon-btn" href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(t('pq_view'))}" aria-label="${esc(t('pq_view'))}">${sdIco('ext', 16)}</a>`}
      <span class="grow"></span><button type="button" class="icon-btn" data-qdel="${esc(c.model_id)}" title="${esc(t('pq_remove'))}" aria-label="${esc(t('pq_remove'))}">${I_TRASH}</button></div></article>`;
}
async function qMove(mid, st) {
  if (!st) return;
  const r = await qApi({ action: 'move', model_id: mid, status: st, sort_order: 999 });
  if (qLimit(r)) return drawQueue();
  if (!r.ok) { toast(t('err_generic')); return drawQueue(); }
  viewQueue();   // Fertig-Datum, Filamentabzug: frisch vom Server
}
function qBindSug() {
  view.querySelectorAll('[data-sug]').forEach(box => {
    const id = +box.dataset.sug;
    const ok = box.querySelector('[data-sok]'), no = box.querySelector('[data-sno]');
    if (ok) ok.onclick = async () => {
      const card = +box.querySelector('select').value; if (!card) { box.querySelector('select').focus(); return; }
      await qApi({ action: 'cloud_accept', job_id: id, card_id: card }); viewQueue();
    };
    no.onclick = async () => { await qApi({ action: 'cloud_dismiss', job_id: id }); qs.d.suggest = qs.d.suggest.filter(s => s.id !== id); drawQueue(); };
  });
}
function qEdit(c) {
  if (!c) return;
  const d = qs.d, projects = [...new Set(d.cards.map(x => x.project).filter(Boolean))];
  dlg.innerHTML = `<form method="dialog" id="qf"><div class="dlg-h"><b>${esc(c.name)}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">
      <label class="fld"><span>${esc(t('pq_project'))}</span><input class="in" name="project" list="qprojd" maxlength="80" value="${esc(c.project || '')}" placeholder="${esc(t('pq_proj_ph'))}"></label>
      <datalist id="qprojd">${projects.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
      <label class="fld"><span>${esc(t('pq_notes'))}</span><textarea class="in" name="notes" rows="3" placeholder="${esc(t('pq_notes_placeholder'))}">${esc(c.notes)}</textarea></label>
      ${d.printers.length ? `<label class="fld"><span>${esc(t('pq_printers'))}</span><select class="in" name="printer_id"><option value="">${esc(t('pq_none'))}</option>${d.printers.map(p => `<option value="${p.id}"${p.id === c.printer_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
      ${d.filaments.length ? `<label class="fld"><span>${esc(t('pq_filament'))}</span><select class="in" name="filament_id"><option value="">${esc(t('pq_none'))}</option>${d.filaments.map(f => `<option value="${f.id}"${f.id === c.filament_id ? ' selected' : ''}>${esc(f.name + (f.material ? ' (' + f.material + ')' : ''))}</option>`).join('')}</select></label>` : ''}
      <div class="fgrid"><label class="fld"><span>${esc(t('pq_weight'))}</span><input class="in num" name="weight_grams" type="number" min="0" value="${c.weight ?? ''}" placeholder="${esc(t('pq_weight_placeholder'))}"></label>
        <label class="fld"><span>${esc(t('pq_print_time'))}</span><input class="in" name="print_time" maxlength="40" value="${esc(c.print_time)}" placeholder="${esc(t('pq_time_placeholder'))}"></label></div>
      <label class="fld"><span>${esc(t('pq_filament_text'))}</span><input class="in" name="filament" maxlength="100" value="${esc(c.filament)}" placeholder="${esc(t('pq_filament_placeholder'))}"></label>
    </div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('pq_cancel'))}</button><button class="btn pri">${esc(t('pq_save'))}</button></div></form>`;
  const f = $('#qf');
  f.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  f.onsubmit = async e => {
    e.preventDefault();
    const body = { action: 'update', model_id: c.model_id, project: f.project.value, notes: f.notes.value, weight_grams: f.weight_grams.value, print_time: f.print_time.value, filament: f.filament.value };
    if (f.printer_id) body.printer_id = f.printer_id.value;
    if (f.filament_id) body.filament_id = f.filament_id.value;
    const r = await qApi(body);
    if (!r.ok) { toast(t('err_generic')); return; }
    dlg.close(); viewQueue();
  };
  dlg.showModal();
}
const I_FOLDER = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const I_GCODE = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>';

// ── Bibliothek (#library, 25.10.2026, User: „gratis 0, supporter 1 GB, später premium 10 GB … nur für mich sichtbar“) ──
// Eigene Modelldateien aufbewahren, umbenennen, in Ordner legen, 3D-Vorschau je Platte (libview.js, three.js erst bei Bedarf)
// und drucken über den Druckdialog (lb.hand → viewPrint schickt beim Slicen nur die Nummer, lib_file). Server: library_api.php,
// library_lib.php; Netz und Bild baut library_worker.php (Cron), bis dahin fragt die Liste alle 3 s nach.
const lb = { d: null, folder: '*', q: '', sort: 'new', timer: 0, hand: null, cur: null, viewer: null, ups: [] };
const LB_SORTS = ['new', 'name', 'size', 'printed'];
const fsize = b => b >= 1073741824 ? nf1.format(b / 1073741824) + ' GB' : b >= 1048576 ? nf1.format(b / 1048576) + ' MB' : b <= 0 ? '0 KB' : nf.format(Math.max(1, Math.round(b / 1024))) + ' KB';
const lbPending = f => f.preview === 'queued' || f.preview === 'busy';
const lbIsGc = f => ['gcode', 'gco', 'g', 'bgcode'].includes(f.ext);
const sameFile = (a, b) => !!(a && b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified);
const I_BOX = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/></svg>';
const I_UPLOAD = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const I_DL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>';
const LB_VIEWS = { iso: '<path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/>', top: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16" opacity=".5"/>',
  front: '<rect x="4" y="7" width="16" height="13" rx="1.5"/><path d="M4 7l3-3h13l-3 3" opacity=".5"/>' };

async function viewLib(open) {
  view.innerHTML = prHead('library') + `<div class="loading">${t('loading')}</div>`;
  lb.sel = null; lb.mode = ''; lb.tag = null; lb.view = 'all'; lb.want = !!(window.ampLbJump && window.ampLbJump.want); window.ampLbJump = null;   // Auswahl/Tag-/Gemerkt-Filter gelten nur bis zum Verlassen; Sprung aus der Modellsuche (msToLib) darf „Gemerkt“ vorwählen
  lb.d = await get('lib_list');
  lb.folder = pref('lib_f') ?? '*';
  lb.sort = LB_SORTS.includes(pref('lib_s')) ? pref('lib_s') : 'new';
  drawLib();
  libPoll();
  if (window.ampLibScan) ampLibScan(false);
  const f = open && lb.d.files.find(x => x.id === open);
  if (f) libOpen(f);
}
// Solange Vorschauen gebaut werden: Liste nachladen (endet von selbst beim Ansichtswechsel)
function libPoll() {
  clearTimeout(lb.timer);
  if (!lb.d || !lb.d.files.some(lbPending)) return;
  const g = navGen;
  lb.timer = setTimeout(async () => {
    if (g !== navGen) return;
    try {
      const before = new Map(lb.d.files.map(f => [f.id, f.preview]));
      const d = await get('lib_list');
      lb.d = d;
      drawLib();
      const f = lb.cur && d.files.find(x => x.id === lb.cur);
      if (f && dlg.open && before.get(f.id) !== f.preview && !(lb.dirty && lb.dirty())) libOpen(f);   // offene Datei: jetzt mit Vorschau (nicht mitten in einer Eingabe)
    } catch (e) { if (e.message === STALE) return; }
    libPoll();
  }, 3000);
}
function drawLib_3ds() {
  const d = lb.d, files = d.files, y = window.scrollY;
  const folders = {}; let noF = 0;
  files.forEach(f => { if (f.folder) folders[f.folder] = (folders[f.folder] || 0) + 1; else noF++; });
  const fnames = Object.keys(folders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (lb.folder !== '*' && !(lb.folder === '' ? noF && fnames.length : folders[lb.folder])) lb.folder = '*';
  const q = lb.q.trim().toLowerCase();
  const list = files.filter(f => (lb.folder === '*' || (f.folder || '') === lb.folder) && (!q || f.name.toLowerCase().includes(q) || (f.folder || '').toLowerCase().includes(q)));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  list.sort({ new: (a, b) => b.id - a.id, name: byName, size: (a, b) => b.size - a.size, printed: (a, b) => tsv(b.printed) - tsv(a.printed) || b.id - a.id }[lb.sort]);
  const free = d.quota === 0, pct = free ? 0 : Math.min(100, d.used / d.quota * 100), canUp = !free && d.used < d.quota;
  let h = prHead('library') + `<p class="lead">${esc(t('lib_lead'))}</p>`;
  // Kostenlos (0 GB, seit der Freigabe für alle 25.10.2026): ohne Dateien eine Einladung statt „0 von 0 belegt“ + „lade hoch“;
  // mit Dateien (Abo abgelaufen) bleibt alles sichtbar, nur Hochladen fehlt
  if (free && !files.length) {
    view.innerHTML = h + `<div class="empty lbfree">${I_BOX}<b>${esc(t('lib_free_h'))}</b>${esc(t('lib_free_p', { q: fsize(d.sup_quota) }))}
      <div><a class="btn pri" href="/supporter.php">${esc(t('sup_become'))}</a></div></div>`;
    return;
  }
  h += `<div class="lbtop${free ? ' free' : ''}"><div class="lbq"><div class="lbq-t"><b>${fsize(d.used)}</b> <span>${esc(free ? t('lib_used') : t('lib_of', { q: fsize(d.quota) }))}</span></div>
      ${free ? '' : `<div class="lbq-bar${pct >= 90 ? ' warn' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div>`}
      ${free ? `<p class="hint">${esc(t('lib_free_kept'))} <a href="/supporter.php">${esc(t('sup_become'))}</a></p>`
        : !canUp ? `<p class="hint">${esc(t('lib_full'))}</p>` : ''}</div>
    ${d.quota > 0 ? `<label class="drop big lbdrop${canUp ? '' : ' off'}" id="lbdrop"><input type="file" id="lbfile" multiple accept="${d.exts.map(x => '.' + x).join(',')}"${canUp ? '' : ' disabled'}>
      <span class="dico">${I_UPLOAD}</span><b>${esc(t('lib_drop'))}</b><span class="hint">${esc(t('lib_drop_hint', { mb: fsize(d.max) }))}</span><span class="btn sm">${esc(t('choose_file'))}</span></label>` : ''}</div>
    <div class="lbups" id="lbups">${lb.ups.map(lbUpRow).join('')}</div>${window.ampLibScanBar ? ampLibScanBar(d) : ''}`;
  if (!files.length) {
    view.innerHTML = h + `<div class="empty"><b>${esc(t('lib_empty_h'))}</b>${esc(t('lib_empty_p'))}</div>`;
    lbBind(); return;
  }
  h += `<div class="qbar lbbar"><div class="chips">
      <button type="button" class="chip${lb.folder === '*' ? ' on' : ''}" data-f="*">${esc(t('lib_all'))} <b>${files.length}</b></button>
      ${fnames.map(p => `<button type="button" class="chip${lb.folder === p ? ' on' : ''}" data-f="${esc(p)}">${I_FOLDER} ${esc(p)} <b>${folders[p]}</b></button>`).join('')}
      ${fnames.length && noF ? `<button type="button" class="chip${lb.folder === '' ? ' on' : ''}" data-f="">${esc(t('lib_no_folder'))} <b>${noF}</b></button>` : ''}</div>
    <input class="in lbsearch" type="search" id="lbq" placeholder="${esc(t('lib_search'))}" value="${esc(lb.q)}" aria-label="${esc(t('lib_search'))}">
    <select class="in" id="lbsort" aria-label="${esc(t('lib_sort'))}">${LB_SORTS.map(s => `<option value="${s}"${lb.sort === s ? ' selected' : ''}>${esc(t('lib_sort_' + s))}</option>`).join('')}</select></div>
    <div class="lbgrid" id="lbgrid">${list.map(lbCard).join('') || `<p class="hint">${esc(t('lib_none_match'))}</p>`}</div>`;
  view.innerHTML = h;
  window.scrollTo(0, y);
  lbBind();
}
function lbCard_3ds(f) {
  const p1 = (f.plates || []).find(p => !p.empty);
  const pic = (f.preview === 'ok' || f.thumbs) && (f.mesh || f.thumbs) && p1 && p1.thumb ? `<img src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=${p1.n}&amp;v=${f.v}" alt="" loading="lazy">`
    : lbPending(f) ? `<span class="lbph"><span class="spin"></span><small>${esc(t('lib_building'))}</small></span>`
    : `<span class="lbph">${lbIsGc(f) ? I_GCODE : I_BOX}<small>${esc(f.ext.toUpperCase())}</small></span>`;
  const np = (f.plates || []).filter(p => !p.empty).length;
  const meta = [f.gone ? t('amp_lib_gone') : '', f.ext.toUpperCase(), fsize(f.size), np > 1 ? t('lib_plates_n', { n: np }) : '', f.gcode && f.gcode.printer ? f.gcode.printer : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="lbcard" data-id="${f.id}"><span class="lbpic">${pic}</span>
    <span class="lbt"><b>${esc(f.name)}</b><span class="hint">${esc(meta)}</span>${f.folder ? `<span class="tag on qproj">${I_FOLDER}${esc(f.folder)}</span>` : ''}</span></button>`;
}
function lbBind_3ds() {
  const inp = $('#lbfile'), dz = $('#lbdrop');
  if (inp) inp.onchange = () => { lbUpload(inp.files); inp.value = ''; };
  if (dz && !inp.disabled) {
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('over')));
    dz.addEventListener('drop', e => { e.preventDefault(); lbUpload(e.dataTransfer.files); });
  }
  view.querySelectorAll('.lbbar [data-f]').forEach(b => b.onclick = () => { lb.folder = b.dataset.f; pref('lib_f', lb.folder); drawLib(); });
  const qi = $('#lbq');
  if (qi) qi.oninput = () => {   // nur die Kacheln neu, sonst verliert das Suchfeld beim Tippen den Fokus
    lb.q = qi.value;
    const keep = lb.q; drawLib();
    const n = $('#lbq'); if (n) { n.focus(); n.setSelectionRange(keep.length, keep.length); }
  };
  if ($('#lbsort')) $('#lbsort').onchange = e => { lb.sort = e.target.value; pref('lib_s', lb.sort); drawLib(); };
  view.querySelectorAll('.lbcard').forEach(c => c.onclick = () => { const f = lb.d.files.find(x => x.id === +c.dataset.id); if (f) libOpen(f); });
  lbUpBox();
}
// Nur die Upload-Zeilen neu (Fortschritt) — lbBind() hängt die Drop-Hörer an, das darf je Zeichnen nur einmal passieren
function lbUpBox() {
  const b = $('#lbups'); if (!b) return;
  b.innerHTML = lb.ups.map(lbUpRow).join('');
  b.querySelectorAll('[data-upx]').forEach(x => x.onclick = () => { lb.ups.splice(+x.dataset.upx, 1); lbUpBox(); });
}

// Hochladen: nacheinander, je Datei mit Fortschritt; Endung, Größe und Platz schon vorher prüfen (spart den Upload)
function lbUpRow(u, i) {
  const st = u.state === 'up' ? `<span class="lbbar-p"><i style="width:${(u.pct || 0).toFixed(0)}%"></i></span>`
    : u.state === 'wait' ? `<span class="hint">${esc(t('lib_up_wait'))}</span>`
    : u.state === 'ok' ? `<span class="ok-t">${esc(t('lib_up_ok'))}</span>` : `<span class="err-t">${esc(u.err)}</span>`;
  return `<div class="lbup ${u.state}"><span class="lbup-n">${esc(u.file.name)}</span>${st}${u.state === 'err' || u.state === 'ok' ? `<button type="button" class="icon-btn" data-upx="${i}" aria-label="${esc(t('close'))}">×</button>` : ''}</div>`;
}
function lbUpload(fl) {
  const files = [...(fl || [])];
  if (!files.length) return;
  lb.ups = lb.ups.filter(u => u.state !== 'ok');
  const folder = lb.folder !== '*' ? lb.folder : '';   // in den gerade gewählten Ordner
  files.forEach(file => lb.ups.push({ file, folder, state: 'wait', pct: 0 }));
  lbUpBox();
  lbUpNext();
}
function lbUpNext() {
  if (lb.ups.some(u => u.state === 'up')) return;
  const u = lb.ups.find(x => x.state === 'wait'), box = lbUpBox;
  if (!u) { if (view.querySelector('#lbups')) drawLib(); libPoll(); return; }
  const d = lb.d, ext = (u.file.name.split('.').pop() || '').toLowerCase();
  const err = !d.exts.includes(ext) ? t('lib_e_type') : u.file.size > d.max ? t('lib_e_too_big', { mb: fsize(d.max) }) : d.used + u.file.size > d.quota ? t('lib_e_quota') : '';
  if (err) { u.state = 'err'; u.err = err; box(); lbUpNext(); return; }
  u.state = 'up'; box();
  if (FM.app) { ampLibUp(u, d, box, () => { if (view.querySelector('#lbups')) drawLib(); else box(); lbUpNext(); }); return; }
  const fd = new FormData(); fd.append('a', 'lib_upload'); fd.append('file', u.file, u.file.name); if (u.folder) fd.append('folder', u.folder);
  const x = new XMLHttpRequest();
  x.open('POST', 'api.php');
  if (FM.tok) x.setRequestHeader('Authorization', 'Bearer ' + FM.tok);
  x.upload.onprogress = e => {
    if (!e.lengthComputable) return;
    u.pct = e.loaded / e.total * 100;
    const i = view.querySelector(`#lbups .lbup:nth-child(${lb.ups.indexOf(u) + 1}) .lbbar-p i`); if (i) i.style.width = u.pct.toFixed(0) + '%';
  };
  x.onload = () => {
    let r = null; try { r = JSON.parse(x.responseText); } catch (e) { /* kein JSON: z. B. 413 von nginx */ }
    if (r && r.ok && r.file) { u.state = 'ok'; d.files.unshift(r.file); d.used = r.used; }
    else {
      u.state = 'err';
      const c = r && r.error ? String(r.error).replace(/^lib_/, '') : x.status === 413 ? 'too_big' : 'upload';
      u.err = c === 'dupe' ? t('lib_e_dupe', { name: r.name }) : S['lib_e_' + c] ? t('lib_e_' + c, { mb: fsize(d.max) }) : t('lib_e_upload');
    }
    if (u.state === 'ok' && view.querySelector('#lbups')) drawLib(); else box();
    lbUpNext();
  };
  x.onerror = () => { u.state = 'err'; u.err = t('lib_e_upload'); box(); lbUpNext(); };
  x.send(fd);
}

// Eine Datei: 3D-Vorschau (Platten als Reiter), umbenennen, Ordner, herunterladen, drucken, löschen
function libOpen_3ds(f) {
  if (lb.viewer) { lb.viewer.destroy(); lb.viewer = null; }
  lb.cur = f.id;
  const plates = (f.plates || []).filter(p => !p.empty);
  const folders = [...new Set(lb.d.files.map(x => x.folder).filter(Boolean))].sort();
  const canPrint = f.print && ps_ok();
  let plate = plates.length ? plates[0].n : 1;
  const tools = Object.keys(LB_VIEWS).map(k => `<button type="button" class="icon-btn" data-view="${k}" title="${esc(t('lib_v_' + k))}" aria-label="${esc(t('lib_v_' + k))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LB_VIEWS[k]}</svg></button>`).join('');
  let pv;
  if (FM.app && window.ampLibPv && !(f.mesh && f.preview === 'ok')) { pv = ampLibPv(f, plates); } else if ((lb.ampPlate = null) || (f.mesh && f.preview === 'ok' && plates.length)) {
    pv = `${plates.length > 1 ? `<div class="chips lbpls">${plates.map(p => `<button type="button" class="chip${p.n === plate ? ' on' : ''}" data-n="${p.n}">${esc(t('psd_pl_n', { n: p.n }))}${p.name ? ` · ${esc(p.name)}` : ''}</button>`).join('')}</div>` : ''}
      <div class="lbv" id="lbv"><div class="lbv-tools">${tools}</div><div class="lbv-msg" id="lbvmsg"><span class="spin"></span></div></div><p class="hint lbinfo" id="lbinfo"></p>`;
  } else if (f.mesh && lbPending(f)) {
    pv = `<div class="lbv lbv-wait"><div class="lbv-msg"><span class="spin"></span>${esc(t('lib_building'))}</div></div>`;
  } else if (f.mesh) {
    pv = `<div class="lbv lbv-wait"><div class="lbv-msg">${I_BOX}<span>${esc(t(/^too_complex/.test(f.err || '') ? 'lib_fail_complex' : 'lib_preview_fail'))}</span>
      <button type="button" class="btn sm" id="lbretry">${esc(t('lib_retry'))}</button></div></div>`;
  } else if (f.gcode) {
    const g = f.gcode;
    pv = `<div class="lbnone">${I_GCODE}<span>${esc(g.printer ? t('lib_gcode_for', { p: g.printer }) : t('lib_gcode'))}${g.types && g.types.length ? ' · ' + esc(g.types.join(', ')) : ''}</span></div>`;
  } else {
    pv = `<div class="lbnone">${I_BOX}<span>${esc(t('lib_no_preview_type', { ext: f.ext.toUpperCase() }))}</span></div>`;
  }
  dlg.innerHTML = `<form method="dialog" class="lbf" id="lbf"><div class="dlg-h"><b id="lbname">${esc(f.name)}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">${pv}
      <div class="lbmeta"><label class="fld"><span>${esc(t('lib_name'))}</span><input class="in" data-k="name" maxlength="120" value="${esc(f.name)}" autocomplete="off"></label>
        <label class="fld"><span>${esc(t('lib_folder'))}</span><input class="in" data-k="folder" list="lbfl" maxlength="80" value="${esc(f.folder || '')}" placeholder="${esc(t('lib_folder_ph'))}" autocomplete="off"></label>
        <button type="button" class="btn" id="lbsave" disabled><span>${esc(t('save'))}</span></button></div>
      <p class="hint lbfhint">${esc(t('lib_folder_hint'))}</p>
      <datalist id="lbfl">${folders.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <p class="hint">${esc([f.orig, fsize(f.size), t('lib_added', { d: date(f.created) }), f.printed ? t('lib_printed_at', { d: date(f.printed) }) : '', FM.app && window.ampLibWhereTxt ? ampLibWhereTxt(f) : ''].filter(Boolean).join(' · '))}</p></div>
    <div class="dlg-f lbf-f"><button type="button" class="btn ghost" id="lbdel">${I_TRASH}<span>${esc(t('lib_delete'))}</span></button><span class="grow"></span>
      <button type="button" class="btn lbclose" data-x>${esc(t('close'))}</button>
      ${FM.app ? `<button type="button" class="btn" id="amplbsave">${I_DL} ${esc(t('amp_lib_saveas'))}</button>` : `<a class="btn" href="api.php?a=lib_get&amp;id=${f.id}" download>${I_DL} ${esc(t('lib_download'))}</a>`}
      ${canPrint ? `<button type="button" class="btn pri" id="lbprint">${I_PRINTER_S} <span>${esc(t('lib_print'))}</span></button>` : ''}</div></form>`;
  if (!dlg.open) {
    dlg.classList.add('wide');
    dlg.addEventListener('close', () => {
      if (lb.save) lb.save();   // Geändert, aber nicht gespeichert (× oder Esc): trotzdem sichern
      lb.save = lb.dirty = null;
      dlg.classList.remove('wide'); if (lb.viewer) { lb.viewer.destroy(); lb.viewer = null; } lb.cur = null;
    }, { once: true });
    dlg.showModal();
  }
  const fm = $('#lbf');
  fm.onsubmit = e => e.preventDefault();   // Enter im Namensfeld schließt sonst den Dialog (method=dialog)
  fm.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  // Name/Ordner: Knopf „Speichern“ (User 25.10.2026: still beim Verlassen des Felds zu speichern war verwirrend) — erst aktiv,
  // wenn sich etwas geändert hat; Enter speichert, Schließen mit Änderungen auch (lb.save im close-Hörer oben)
  const fld = k => fm.querySelector(`input[data-k="${k}"]`), sv = $('#lbsave');
  const vals = () => ({ name: fld('name').value.trim(), folder: fld('folder').value.trim() });
  const dirty = () => { const v = vals(); return (v.name !== '' && v.name !== f.name) || v.folder !== (f.folder || ''); };
  const mark = () => { const d = dirty(); sv.disabled = !d; sv.classList.toggle('pri', d); if (d) sv.innerHTML = `<span>${esc(t('save'))}</span>`; };
  let saving = false;
  const save = async () => {
    if (saving || !dirty()) return;
    const v = vals(), body = { id: f.id, folder: v.folder };
    if (v.name) body.name = v.name;
    saving = true; sv.disabled = true;
    try {
      const r = await api('lib_update', body);
      Object.assign(f, r.file);
      if (lb.cur === f.id && $('#lbname')) {
        $('#lbname').textContent = f.name; fld('name').value = f.name; fld('folder').value = f.folder || '';
        sv.classList.remove('pri'); sv.innerHTML = `${I_CHECK}<span>${esc(t('saved'))}</span>`;
      } else toast(t('saved'));
      if (view.querySelector('.lbtop')) drawLib();
    } catch (e) { sv.disabled = false; fail(e); }
    saving = false;
  };
  lb.save = save; lb.dirty = dirty;
  sv.onclick = save;
  fm.querySelectorAll('input[data-k]').forEach(inp => {
    inp.oninput = mark;
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  });
  $('#lbdel').onclick = async e => {
    const b = e.currentTarget;
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.classList.add('danger'); b.querySelector('span').textContent = t('lib_delete_sure'); return; }   // zweiter Klick löscht
    try {
      const r = await api('lib_delete', { id: f.id });
      lb.d.files = lb.d.files.filter(x => x.id !== f.id); lb.d.used = r.used;
      lb.save = null; dlg.close(); toast(t('deleted')); drawLib();
    } catch (er) { fail(er); }
  };
  if ($('#lbretry')) $('#lbretry').onclick = async () => {
    try { await api('lib_rebuild', { id: f.id }); f.preview = 'queued'; libOpen(f); drawLib(); libPoll(); } catch (e) { fail(e); }
  };
  // Drucken: Datei holen und dem Druckdialog geben (Platten/Teile liest er im Browser); hochgeladen wird sie nicht noch einmal
  if ($('#lbprint')) $('#lbprint').onclick = async () => {
    const b = $('#lbprint'), lbl = b.querySelector('span');
    b.disabled = true; lbl.textContent = t('lib_loading_file');
    try {
      const r = await fetch('api.php?a=lib_get&id=' + f.id, { credentials: 'same-origin', headers: AUTH });
      if (!r.ok) throw new Error('http_' + r.status);
      const blob = await r.blob();
      lb.hand = { id: f.id, name: f.name, plate: lb.ampPlate || plate, file: new File([blob], `${f.name}.${f.ext}`, { type: 'application/octet-stream', lastModified: Date.now() }) };
      dlg.close(); location.hash = 'print';
    } catch (e) { b.disabled = false; lbl.textContent = t('lib_print'); fail(e); }
  };
  if (!$('#lbv') || !$('#lbvmsg')) return;
  if (!window.FMLibView) { $('#lbvmsg').textContent = t('lib_err_view'); return; }
  lb.viewer = window.FMLibView($('#lbv'));
  const show = async n => {
    plate = n;
    const p = plates.find(x => x.n === n) || plates[0];
    fm.querySelectorAll('.lbpls [data-n]').forEach(c => c.classList.toggle('on', +c.dataset.n === n));
    if ($('#lbprint') && plates.length > 1) $('#lbprint').querySelector('span').textContent = t('lib_print_plate', { n });
    $('#lbinfo').textContent = [p.dims ? t('lib_dims', { x: nf1.format(p.dims[0]), y: nf1.format(p.dims[1]), z: nf1.format(p.dims[2]) }) : '',
      p.objs > 1 ? t('lib_objs', { n: p.objs }) : '', t('lib_tris', { n: nf.format(p.src_tris || p.tris) }), p.dec ? t('lib_simplified') : ''].filter(Boolean).join(' · ');
    const msg = $('#lbvmsg'); msg.hidden = false; msg.innerHTML = '<span class="spin"></span>';
    try { await lb.viewer.load(`api.php?a=lib_mesh&id=${f.id}&n=${n}&v=${f.v}`); if (lb.cur === f.id && plate === n) msg.hidden = true; }
    catch (e) { console.error(e); msg.textContent = t('lib_err_view'); }
  };
  fm.querySelectorAll('.lbpls [data-n]').forEach(c => c.onclick = () => show(+c.dataset.n));
  fm.querySelectorAll('[data-view]').forEach(b => b.onclick = () => lb.viewer && lb.viewer.view(b.dataset.view));
  show(plate);
}

// ── Druckerwartung (#maint, 07.10.2026): Aufgaben je Drucker, fällig nach Stunden / kg / Drucken / Tagen ──
const MT_PRESETS = [['bed', null, null, 30, null], ['nozzle', 300, null, null, null], ['belts', 300, null, null, 90], ['rails', 200, null, null, 90],
  ['gears', null, 10, null, null], ['fans', 500, null, null, null], ['ptfe', 500, null, null, null], ['screws', null, null, null, 180]];
const mt = { data: null };
const mtEvery = x => [x.every.hours && t('mt_every_h', { n: nf.format(x.every.hours) }), x.every.grams && t('mt_every_kg', { n: nf1.format(x.every.grams / 1000) }),
  x.every.prints && t('mt_every_p', { n: nf.format(x.every.prints) }), x.every.days && t('mt_every_d', { n: nf.format(x.every.days) })].filter(Boolean).join(' · ');
const mtUsed = x => [x.every.hours && nf1.format(x.used.hours) + ' h', x.every.grams && kg(x.used.grams), x.every.prints && t('st_prints_n', { n: nf.format(x.used.prints) }),
  x.every.days && t('days', { n: nf.format(x.used.days) })].filter(Boolean).join(' · ');
async function viewMaint() {
  view.innerHTML = prHead('maint') + `<div class="loading">${t('loading')}</div>`;
  const d = await get('maint').catch(fail); if (!d) return;
  mt.data = d; drawMaint();
}
function drawMaint() {
  const d = mt.data, y = window.scrollY;
  let h = prHead('maint') + `<p class="lead">${t('mt_lead')}</p>`;
  if (!d.printers.length && !d.tasks.length) {
    view.innerHTML = h + `<div class="empty"><b>${t('pr_none_h')}</b>${t('pr_none_txt')}<br><br><a class="btn pri" href="#connect">${t('pr_connect')}</a></div>`;
    return;
  }
  const due = d.tasks.filter(x => x.state === 'due').length, soon = d.tasks.filter(x => x.state === 'soon').length;
  if (d.tasks.length) h += `<div class="skpis"><div class="${due ? 'warn' : ''}"><small>${t('mt_due')}</small><b>${nf.format(due)}</b></div><div><small>${t('mt_soon')}</small><b>${nf.format(soon)}</b></div><div><small>${t('mt_tasks')}</small><b>${nf.format(d.tasks.length)}</b></div></div>`;
  const known = new Set(d.printers.map(p => p.provider + ':' + p.pid));
  const card = (p, tasks, gone) => `<section class="card mcard"><div class="mc-h">${printerPic(p)}
      <div class="mc-t"><b>${esc(p.name)}</b><span class="hint">${esc([p.model && p.model !== p.name ? p.model : '', gone ? t('mt_gone') : '', p.hours ? t('mt_total_h', { n: nf.format(p.hours) }) : ''].filter(Boolean).join(' · '))}</span></div>
      ${gone ? '' : `<button class="btn sm" data-madd="${esc(p.provider + '|' + p.pid)}">+ ${t('mt_add')}</button>`}</div>
    ${tasks.length ? tasks.sort((a, b) => b.ratio - a.ratio).map(x => mtRow(x, p)).join('') : `<p class="hint mc-none">${t('mt_none')}</p>`}</section>`;
  for (const p of d.printers) h += card(p, d.tasks.filter(x => x.provider === p.provider && x.pid === p.pid), false);
  // Aufgaben von Druckern, die nicht mehr verbunden sind (z. B. Agent neu gekoppelt) — nur noch löschen
  const lost = d.tasks.filter(x => !known.has(x.provider + ':' + x.pid));
  if (lost.length) h += card({ name: t('mt_gone_h'), model: '', img: '' }, lost, true);
  view.innerHTML = h;
  window.scrollTo(0, y);
  view.querySelectorAll('[data-madd]').forEach(b => b.onclick = () => { const [pv_, pid] = b.dataset.madd.split('|'); maintDialog(null, d.printers.find(p => p.provider === pv_ && p.pid === pid)); });
  view.querySelectorAll('[data-medit]').forEach(b => b.onclick = () => maintDialog(d.tasks.find(x => x.id === +b.dataset.medit)));
  view.querySelectorAll('[data-mdone]').forEach(b => b.onclick = () => maintDone(d.tasks.find(x => x.id === +b.dataset.mdone)));
}
// Passendes Ersatzteil zur Aufgabe (22.10.2026): Server liefert je Drucker die Teile aus dem Feed (aff_part_offer in affiliate_lib.php),
// zugeordnet über den Aufgabentitel in allen Sprachen der Vorlagen (mt_p_*); eigene Titel greifen, wenn sie das Wort enthalten
const MT_PART = [[/düse|nozzle|buse|boquilla|ugello|spuitmond/i, ['nozzle', 'hotend']], [/hotend/i, ['hotend', 'nozzle']],
  [/platte|plate|plateau|placa|piatto|printplaat|druckbett|\bbed\b|\bcama\b/i, ['plate']], [/riemen|\bbelts?\b|courroie|correa|cinghi|\briem/i, ['belt']]];
function mtPart(x, p) {
  const o = p && p.parts;
  if (!o) return '';
  for (const [rx, types] of MT_PART) if (rx.test(x.title)) for (const ty of types) if (o.parts[ty]) {
    const q = o.parts[ty];
    let pr = '';
    try { pr = new Intl.NumberFormat(FM.lang, { style: 'currency', currency: q.cur }).format(q.price); } catch (e) { pr = q.price + ' ' + q.cur; }
    return `<a class="mbuy${x.state !== 'ok' ? ' hot' : ''}" href="${esc(q.url)}" target="_blank" rel="sponsored nofollow noopener"><img src="${esc(q.img)}" alt="" width="40" height="40" loading="lazy">
      <span><b>${esc(t('mt_buy_' + ty, { p: p.model || o.p }))}</b><small>${esc(q.name)}</small><small>${esc(pr)} · ${esc(q.shop)} · ${esc(t('mt_buy_tag'))}</small></span>${sdIco('ext', 14)}</a>`;
  }
  return '';
}
function mtRow(x, p) {
  const pct = Math.round(Math.min(1, x.ratio) * 100);
  const col = x.state === 'due' ? 'var(--bad)' : x.state === 'soon' ? 'var(--warn)' : 'var(--ok)';
  const st_ = { due: ['fail', t('mt_st_due')], soon: ['run', t('mt_st_soon')], ok: ['ok', t('mt_st_ok')] }[x.state];
  const log = (mt.data.log[x.id] || []);
  return `<div class="mrow ${x.state}">${pctRing(pct, col, x.ratio >= 1 ? '!' : pct + '%')}
    <span class="mt"><b>${esc(x.title)}</b><span class="hint">${esc(mtEvery(x))}</span>
      <span class="hint">${esc(t('mt_since', { d: date(x.last_done_at), u: mtUsed(x) }))}</span>
      ${mtPart(x, p)}
      ${log.length ? `<details class="mlog"><summary>${t('mt_log', { n: log.length })}</summary><ul>${log.map(l => `<li>${date(l.at)}${l.hours !== null ? ' · ' + nf1.format(l.hours) + ' h' : ''}${l.prints ? ' · ' + esc(t('st_prints_n', { n: l.prints })) : ''}${l.note ? ' · ' + esc(l.note) : ''}</li>`).join('')}</ul></details>` : ''}</span>
    <span class="mact"><span class="jst ${st_[0]}">${esc(st_[1])}</span>
      <span class="mbtns"><button class="btn sm${x.state !== 'ok' ? ' pri' : ''}" data-mdone="${x.id}">${t('mt_done')}</button>
      <button class="icon-btn" data-medit="${x.id}" title="${esc(t('act_edit'))}" aria-label="${esc(t('act_edit'))}">${I_PEN}</button></span></span></div>`;
}
function maintDialog(x, printer) {
  const isNew = !x, e = x ? x.every : {};
  const today = new Date().toLocaleDateString('sv');
  dlg.innerHTML = `<form method="dialog" id="fm_"><div class="dlg-h"><b>${isNew ? t('mt_add_h', { p: esc(printer.name) }) : esc(x.title)}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">
      ${isNew ? `<div class="fld"><span>${t('mt_presets')}</span></div><div class="chips mt-pre">${MT_PRESETS.map(([k], i) => `<button type="button" class="chip" data-i="${i}">${esc(t('mt_p_' + k))}</button>`).join('')}</div>` : ''}
      <label class="fld"><span>${t('mt_title')}</span><input class="in" name="title" required maxlength="80" value="${esc(x ? x.title : '')}" placeholder="${esc(t('mt_title_ph'))}"></label>
      <div class="fld"><span>${t('mt_every')}</span></div>
      <div class="fgrid mt-every">
        <label class="fld"><span>${t('mt_f_h')}</span><input class="in num" name="every_hours" type="number" min="1" max="20000" value="${e.hours ?? ''}"></label>
        <label class="fld"><span>${t('mt_f_kg')}</span><input class="in num" name="every_kg" type="number" min="0.01" max="1000" step="0.01" value="${e.grams ? e.grams / 1000 : ''}"></label>
        <label class="fld"><span>${t('mt_f_p')}</span><input class="in num" name="every_prints" type="number" min="1" max="20000" value="${e.prints ?? ''}"></label>
        <label class="fld"><span>${t('mt_f_d')}</span><input class="in num" name="every_days" type="number" min="1" max="3650" value="${e.days ?? ''}"></label>
      </div>
      <p class="hint" style="margin:0">${t('mt_every_hint')}</p>
      <label class="fld"><span>${t('mt_last')}</span><input class="in" name="last_done" type="date" max="${today}" value="${x ? x.last_done_at.slice(0, 10) : today}"></label>
      <p class="hint" style="margin:0">${t('mt_last_hint')}</p>
    </div>
    <div class="dlg-f">${isNew ? '' : `<button type="button" class="btn ghost danger" id="fmdel">${t('act_delete')}</button>`}<span style="flex:1"></span>
      <button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form>`;
  const f = $('#fm_');
  f.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  f.querySelectorAll('.mt-pre [data-i]').forEach(b => b.onclick = () => {
    const [k, hh, kgv, pp, dd] = MT_PRESETS[+b.dataset.i];
    f.title.value = t('mt_p_' + k); f.every_hours.value = hh ?? ''; f.every_kg.value = kgv ?? ''; f.every_prints.value = pp ?? ''; f.every_days.value = dd ?? '';
    f.querySelectorAll('.mt-pre .chip').forEach(c => c.classList.toggle('on', c === b));
  });
  const del = $('#fmdel');
  if (del) del.onclick = async () => {
    if (!confirm(t('mt_del_confirm'))) return;
    try { await api('maint_delete', { id: x.id }); dlg.close(); toast(t('deleted')); viewMaint(); } catch (er) { fail(er); }
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    // „Zuletzt erledigt“ nur mitschicken, wenn geändert — sonst setzte jedes Bearbeiten den Zähler auf 12:00 dieses Tages
    if (x && body.last_done === x.last_done_at.slice(0, 10)) delete body.last_done;
    if (isNew && body.last_done === today) delete body.last_done;
    try { await api('maint_save', { ...body, id: x ? x.id : 0, provider: printer ? printer.provider : '', pid: printer ? printer.pid : '' }); dlg.close(); toast(t('saved')); viewMaint(); }
    catch (er) { fail(er); }
  };
  dlg.showModal();
}
function maintDone(x) {
  dlg.innerHTML = `<form method="dialog" id="fmd"><div class="dlg-h"><b>${esc(x.title)}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p style="margin:0">${t('mt_done_p', { u: esc(mtUsed(x)) })}</p>
      <label class="fld"><span>${t('use_note')}</span><input class="in" name="note" maxlength="255" placeholder="${esc(t('mt_note_ph'))}"></label></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn pri" id="fmdgo">${t('mt_done')}</button></div></form>`;
  const f = $('#fmd');
  f.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  f.onsubmit = async ev => {
    ev.preventDefault(); $('#fmdgo').disabled = true;
    try { await api('maint_done', { id: x.id, note: f.note.value }); dlg.close(); toast(t('mt_done_ok')); viewMaint(); }
    catch (er) { $('#fmdgo').disabled = false; fail(er); }
  };
  dlg.showModal();
}

// ── Einstellungen: Import & Export (#io springt hierher) ───────────────────
function ioHtml() {
  const fmt = (name, tags, body) => `<div class="iofmt"><b>${name}${tags.map(x => `<span class="ftag">${x}</span>`).join('')}</b>${body}</div>`;
  return `<section class="ccard" id="io">${sHead('imp', t('io_imp_h'), t('imp_lead'))}
    <div class="iofmts">
      ${fmt('Spoolman', ['JSON', 'URL'], `<ol class="steps"><li>${t('imp_s1')}</li><li>${t('imp_s2')}</li></ol><p class="hint">${t('io_spoolman_url')}</p>`)}
      ${fmt('3D Filament Profiles / SpoolDB', ['CSV', 'JSON'], `<p class="hint">${t('imp_spooldb')}</p>`)}
      ${fmt('OctoPrint FilamentManager', ['ZIP'], `<p class="hint">${t('imp_octofm')}</p>`)}
      ${fmt('OctoPrint SpoolManager', ['CSV'], `<p class="hint">${t('imp_octosm')}</p>`)}
      ${fmt(t('io_own_name'), ['CSV'], `<p class="hint">${t('io_own_desc')}</p>`)}
      ${fmt(t('imp_generic_h'), ['CSV'], `<p class="hint">${t('imp_generic')}</p>`)}
    </div>
    <p class="hint">${t('imp_s3')}</p>
    <div class="inline"><label class="btn pri"><input type="file" id="impfile" accept=".json,.csv,.zip,application/json,text/csv,application/zip" hidden>${t('imp_file')}</label>
      <span class="hint" style="align-self:center">${t('imp_or')}</span>
      <input class="in grow" id="impurl" type="url" placeholder="https://spoolman.example.org" style="flex:1;min-width:220px"><button class="btn" id="impurlbtn">${t('imp_url_btn')}</button></div>
    <p class="hint">${t('imp_url_hint')}</p><div id="impres"></div></section>
  <section class="ccard">${sHead('exp', t('exp_h'), t('exp_lead'))}
    <label class="trow"><span class="tgl"><input type="checkbox" id="exparch" checked><span></span></span><span>${t('exp_archived')}</span></label>
    <div class="inline" style="margin-top:10px"><a class="btn pri" id="expcsv" href="export.php">${t('exp_csv')}</a><a class="btn" id="expxls" href="export.php?sep=semicolon">${t('exp_excel')}</a></div>
    <p class="hint">${t('exp_hint')}</p></section>`;
}
function bindIO() {
  const arch = $('#exparch');
  const links = () => { const q = arch.checked ? '' : 'archived=0'; $('#expcsv').href = 'export.php' + (q ? '?' + q : ''); $('#expxls').href = 'export.php?sep=semicolon' + (q ? '&' + q : ''); };
  arch.onchange = links;
  // Import: erst Vorschau (nichts gespeichert), dann übernehmen
  const runImport = async (src, mode) => {
    const box = $('#impres'); box.innerHTML = `<div class="wait"><span class="spin"></span>${t('loading')}</div>`;
    try {
      const d = await api('spoolman_import', { ...src, mode });
      const r = d.result;
      box.innerHTML = `<div class="note">${d.committed ? `<b>${t('imp_done')}</b><br>` : ''}${t('imp_summary', { n: r.spools, a: r.archived, nw: r.new, up: r.update, m: r.catalog_match, f: r.filaments_new, v: r.vendors_new, l: r.locations })}
        ${r.fields.length ? '<br>' + t('imp_fields', { f: r.fields.map(esc).join(', ') }) : ''}</div>
        ${d.committed ? `<a class="btn pri" href="#spools">${t('tab_spools')} →</a>` : `<button class="btn pri" id="impgo">${t('imp_go', { n: r.spools })}</button>`}`;
      if (!d.committed) $('#impgo').onclick = () => runImport(src, 'commit');
      else { st.spools = []; st.reach = null; }
    } catch (er) { box.innerHTML = `<div class="note err-note">${t('err_' + er.message) !== 'err_' + er.message ? t('err_' + er.message) : t('err_generic')}</div>`; }
  };
  $('#impfile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    // ZIP (OctoPrint FilamentManager) als base64, alles andere als Text
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip') {
      if (f.size > 5 * 1024 * 1024) { $('#impres').innerHTML = `<div class="note err-note">${t('err_import_bad')}</div>`; return; }
      const rd = new FileReader();
      rd.onload = () => runImport({ zip: String(rd.result).split(',')[1] || '' }, 'preview');
      rd.readAsDataURL(f);
    } else f.text().then(txt => runImport({ data: txt }, 'preview'));
  };
  $('#impurlbtn').onclick = () => { const u = $('#impurl').value.trim(); if (u) runImport({ url: u }, 'preview'); };
}

// ── Ansicht: Lagerorte (Spulen per Ziehen verschieben) ─────────────────────
async function viewLocations() {
  await loadSpools();
  const locs = (await get('locations')).locations;
  const spoolsAt = n => st.spools.filter(s => !s.archived && (s.location || '') === n).sort(bySlot);
  // „Ohne Lagerort“ nur vorne, wenn dort Spulen liegen — leer kostete sie am Handy die ganze erste Bildschirmbreite
  const cols = spoolsAt('').length ? [{ id: 0, name: '' }].concat(locs) : locs.concat([{ id: 0, name: '' }]);
  const chip = s => `<div class="lchip" draggable="true" data-id="${s.id}" tabindex="0">${ring(s)}<span class="t"><b>${esc(title(s))}</b><span>${esc(sub(s))} · ${g(s.left)}</span>
    ${s.slots.length ? `<span class="tag on">${esc(slotTxt(s.slots[0]))}</span>` : ''}</span></div>`;
  view.innerHTML = `<h1>${t('spools_h')}</h1>${spoolTabs('locations')}<p class="lead">${t('loc_lead')}</p>
    <div class="bar"><form id="lnew" class="inline" style="margin:0"><input class="in" name="name" required maxlength="60" placeholder="${esc(t('loc_new_ph'))}"><button class="btn pri">+ ${t('loc_add')}</button></form></div>
    <div class="board">${cols.map(c => {
      const ss = spoolsAt(c.name);
      return `<section class="lcol" data-loc="${esc(c.name)}" data-lid="${c.id}"><header><b>${esc(c.name || t('no_location'))}</b><span class="hint">${ss.length} · ${kg(ss.reduce((a, s) => a + s.left, 0))}</span>
        ${c.id ? `<span class="grow"></span><button class="icon-btn" data-lup="${c.id}" aria-label="${esc(t('move_left'))}" title="${esc(t('move_left'))}">←</button><button class="lnk" data-lren="${c.id}">${t('rename')}</button><button class="lnk" style="color:var(--bad)" data-ldel="${c.id}">${t('act_delete')}</button>` : ''}</header>
        <div class="ldrop">${ss.map(chip).join('') || `<p class="hint">${t('loc_empty')}</p>`}</div></section>`;
    }).join('')}</div>`;
  // Ziehen (Maus) — auf dem Handy: antippen → Ziel wählen
  let dragId = null;
  view.querySelectorAll('.lchip').forEach(c => {
    c.addEventListener('dragstart', e => { dragId = +c.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('drag'); });
    c.addEventListener('dragend', () => c.classList.remove('drag'));
    const pick = () => moveDialog(+c.dataset.id, cols);
    c.addEventListener('click', pick);
    c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
  view.querySelectorAll('.lcol').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async e => {
      e.preventDefault(); col.classList.remove('over');
      const id = dragId || +e.dataTransfer.getData('text/plain'); dragId = null;
      if (id) await moveSpool(id, col.dataset.loc);
    });
  });
  $('#lnew').onsubmit = async e => { e.preventDefault(); try { await api('location_save', { name: e.target.name.value }); viewLocations(); } catch (er) { fail(er); } };
  view.querySelectorAll('[data-lren]').forEach(b => b.onclick = async () => {
    const c = cols.find(x => x.id === +b.dataset.lren), n = prompt(t('loc_rename_prompt'), c.name);
    if (!n || !n.trim() || n.trim() === c.name) return;
    try { await api('location_save', { id: c.id, name: n.trim() }); viewLocations(); } catch (er) { fail(er); }
  });
  view.querySelectorAll('[data-ldel]').forEach(b => b.onclick = async () => {
    if (!confirm(t('loc_del_confirm'))) return;
    try { await api('location_delete', { id: +b.dataset.ldel }); viewLocations(); } catch (er) { fail(er); }
  });
  view.querySelectorAll('[data-lup]').forEach(b => b.onclick = async () => {
    const ids = locs.map(l => l.id), i = ids.indexOf(+b.dataset.lup);
    if (i < 1) return; [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
    try { await api('location_order', { ids }); viewLocations(); } catch (er) { fail(er); }
  });
}
async function moveSpool(id, loc) {
  try { const d = await api('spool_move', { id, location: loc }); replaceSpool(d.spool); toast(t('saved')); viewLocations(); } catch (er) { fail(er); }
}
function moveDialog(id, cols) {
  const s = st.spools.find(x => x.id === id);
  dlg.innerHTML = `<form method="dialog"><div class="dlg-h"><b>${esc(title(s))} · #${s.id}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b"><span class="hint">${t('loc_move_to')}</span><div class="results">${cols.map(c => `<button type="button" data-loc="${esc(c.name)}"${(s.location || '') === c.name ? ' disabled' : ''}>${esc(c.name || t('no_location'))}</button>`).join('')}</div></div>
    <div class="dlg-f"><a class="btn" href="#s${s.id}" id="mdopen">${t('loc_open_spool')}</a><span style="flex:1"></span><button type="button" class="btn ghost" data-x>${t('cancel')}</button></div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  $('#mdopen').onclick = () => dlg.close();
  dlg.querySelectorAll('[data-loc]').forEach(b => b.onclick = () => { dlg.close(); moveSpool(id, b.dataset.loc); });
  dlg.showModal();
}
const spoolTabs = a => `<div class="subtabs"><a href="#spools" class="${a === 'spools' ? 'on' : ''}">${t('tab_spools')}</a><a href="#locations" class="${a === 'locations' ? 'on' : ''}">${t('tab_locations')}</a><a href="#catalog" class="${a === 'catalog' ? 'on' : ''}">${t('tab_catalog')}</a></div>`;

// ── QR-Scanner (Kamera) ────────────────────────────────────────────────────
let scanStream = null;
function stopScan() { if (scanStream) { scanStream.getTracks().forEach(tr => tr.stop()); scanStream = null; } }
async function openScanner() {
  dlg.innerHTML = `<form method="dialog"><div class="dlg-h"><b>${t('scan_h')}</b><button type="button" class="x-btn" data-x>×</button></div>
    <div class="dlg-b"><div class="scanbox"><video id="scv" playsinline muted></video><span class="scanframe"></span></div><p class="hint" id="scmsg" style="margin:0">${t('scan_hint')}</p></div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  dlg.addEventListener('close', stopScan, { once: true });
  dlg.showModal();
  const msg = m => { const el = $('#scmsg'); if (el) el.textContent = m; };
  try { scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch (e) { msg(t('scan_nocam')); return; }
  const video = $('#scv'); video.srcObject = scanStream; await video.play().catch(() => {});
  let detect;
  if ('BarcodeDetector' in window) {
    const bd = new BarcodeDetector({ formats: ['qr_code'] });
    detect = async () => { const r = await bd.detect(video).catch(() => []); return r[0] && r[0].rawValue; };
  } else {
    if (!window.jsQR) await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = FM.jsqr; sc.onload = ok; sc.onerror = no; document.head.appendChild(sc); }).catch(() => {});
    if (!window.jsQR) { msg(t('scan_nocam')); return; }
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      if (!video.videoWidth) return null;
      const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
      cv.width = w; cv.height = h; cx.drawImage(video, 0, 0, w, h);
      const r = window.jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      return r && r.data;
    };
  }
  let busy = false, last = '';
  const tick = async () => {
    if (!scanStream || !dlg.open) return;
    if (!busy) {
      busy = true;
      const code = await detect();
      if (code && code !== last) {
        last = code;
        const r = await get('resolve_qr', { code }).catch(() => ({ error: 'qr_unknown' }));
        if (r.agent && window.ampAgentLink) { dlg.close(); ampAgentLink(r.agent); return; }
        if (r.spool) { dlg.close(); if (!st.spools.length) await loadSpools(); location.hash = 's' + r.spool; return; }
        msg(t('scan_unknown'));
      }
      busy = false;
    }
    requestAnimationFrame(tick);
  };
  tick();
}
const scanBtn = document.getElementById('fmScan');
if (scanBtn) scanBtn.addEventListener('click', openScanner);

// ── Aufträge für Kunden (31.10.2026) ───────────────────────────────────────
// Drucke, Arbeitszeit und Posten je Auftrag (orders_api.php), PDF über order_pdf.php. #orders = Liste, #order-<ID> = ein Auftrag.
// Eingebettet (Home Assistant) nicht: prHead zeigt den Reiter dort nicht.
const ov = { f: pref('ordf') || '', d: null, o: null };
const ORD_ST = ['open', 'active', 'done', 'billed'];
const ORD_JST = { open: '', active: 'run', done: 'ok', billed: 'ok' };
const ordSt = s => `<span class="jst ${ORD_JST[s]}">${esc(t('ord_st_' + s))}</span>`;
const ordHm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
const ordLate = o => !!o.due && ['open', 'active'].includes(o.status) && o.due < new Date().toLocaleDateString('sv');
const ordDue = o => o.due ? `<span class="${ordLate(o) ? 'ord-late' : ''}">${esc(date(o.due + ' 12:00:00'))}</span>` : '';
const ordBar = o => {
  if (!o.budget) return '';
  const over = o.calc.total > o.budget;
  return `<span class="ord-bar${over ? ' over' : ''}"><i style="width:${Math.min(100, Math.round(o.calc.total / o.budget * 100))}%"></i></span>`;
};
function ordRow(o) {
  return `<a class="ord-row" href="#order-${o.id}"><span class="ord-no">#${o.no}</span>
    <span class="ord-t"><b>${esc(o.title)}</b><small>${[o.customer ? esc(o.customer) : '', ordDue(o)].filter(Boolean).join(' · ')}</small></span>
    ${ordSt(o.status)}<span class="ord-sum"><b>${cur.format(o.calc.total)}</b>${o.budget ? `<small>${esc(t('ord_of', { v: cur.format(o.budget) }))}</small>${ordBar(o)}` : ''}</span></a>`;
}
async function viewOrders(id) {
  view.innerHTML = prHead('orders') + `<div class="loading">${t('loading')}</div>`;
  if (id) return viewOrder(id);
  const d = await get('orders').catch(fail); if (!d) return;
  ov.d = d; drawOrders();
}
function drawOrders() {
  const all = ov.d.orders, act = all.filter(o => o.status === 'open' || o.status === 'active');
  if (ov.f && !ORD_ST.includes(ov.f)) ov.f = '';
  const list = all.filter(o => !ov.f || o.status === ov.f), late = act.filter(ordLate).length;
  let h = prHead('orders') + `<p class="lead">${t('ord_lead')}</p>`;
  if (all.length) h += `<div class="skpis"><div><small>${t('ord_open_n')}</small><b>${nf.format(act.length)}</b></div>
    <div><small>${t('ord_open_val')}</small><b>${cur.format(act.reduce((a, o) => a + o.calc.total, 0))}</b></div>
    <div class="${late ? 'warn' : ''}"><small>${t('ord_late')}</small><b>${nf.format(late)}</b></div></div>`;
  h += `<div class="bar">${all.length ? `<div class="chips" id="ochips">${[['', t('ord_all')], ...ORD_ST.map(s => [s, t('ord_st_' + s)])].map(([k, l]) => `<button type="button" class="chip${k === ov.f ? ' on' : ''}" data-f="${k}">${esc(l)}</button>`).join('')}</div>` : ''}
    <span class="grow"></span><button class="btn" id="obiz">${t('ord_biz_btn')}</button><button class="btn pri" id="oadd">+ ${t('ord_add')}</button></div>`;
  if (!all.length) h += `<div class="empty"><b>${t('ord_empty_h')}</b>${t('ord_empty_p')}</div>`;
  else if (!list.length) h += `<div class="empty">${t('ord_no_match')}</div>`;
  else h += `<div class="ord-list">${list.map(ordRow).join('')}</div>`;
  view.innerHTML = h;
  $('#oadd').onclick = () => orderDialog(null);
  $('#obiz').onclick = () => bizDialog();
  const ch = $('#ochips');
  if (ch) ch.onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; ov.f = b.dataset.f; pref('ordf', ov.f); drawOrders(); };
}
async function viewOrder(id) {
  const g_ = navGen;
  const d = await get('order', { id }).catch(fail);
  if (!d) { if (g_ === navGen) location.hash = 'orders'; return; }
  ov.o = d.order; drawOrder();
}
function drawOrder() {
  const o = ov.o, c = o.calc, y = window.scrollY;
  const calc = [[t('ord_c_material'), c.material], [t('ord_c_run'), c.run], [t('ord_c_labor'), c.labor], [t('ord_c_items'), c.items],
    c.markup ? [t('ord_c_markup', { p: nf1.format(o.markup) }), c.markup] : null,
    o.vat ? [t('ord_c_sub'), c.sub] : null, o.vat ? [t('ord_c_vat', { p: nf1.format(o.vat) }), c.vat] : null].filter(Boolean);
  const diff = o.budget ? o.budget - c.total : 0;
  const line = l => l.kind === 'time'
    ? `<div class="ord-l"><span class="ord-lt"><b>${esc(l.label || t('ord_time_def'))}</b><small>${[ordHm(l.minutes), l.day ? esc(date(l.day + ' 12:00:00')) : ''].filter(Boolean).join(' · ')}</small></span>
        <span class="ord-la">${cur.format(l.amount)}</span><button class="icon-btn" data-oled="${l.id}" title="${esc(t('act_edit'))}" aria-label="${esc(t('act_edit'))}">${I_PEN}</button></div>`
    : `<div class="ord-l"><span class="ord-lt"><b>${esc(l.label)}</b><small>${esc(nf1.format(l.qty))} × ${cur.format(l.price)}</small></span>
        <span class="ord-la">${cur.format(l.amount)}</span><button class="icon-btn" data-oled="${l.id}" title="${esc(t('act_edit'))}" aria-label="${esc(t('act_edit'))}">${I_PEN}</button></div>`;
  const job = j => `<div class="ord-l"><span class="ord-lt"><b>${esc(j.title)}</b><small>${[j.printer ? esc(j.printer) : '', j.end ? esc(date(j.end)) : '', j.grams !== null ? g(j.grams) : '', j.secs ? ordHm(Math.round(j.secs / 60)) : ''].filter(Boolean).join(' · ')}</small></span>
      ${j.status === 3 ? `<span class="jst fail">${t('js_cancelled')}</span>` : ''}<span class="ord-la">${cur.format(j.material + j.run)}</span>
      <button class="icon-btn" data-ojdel="${j.id}" title="${esc(t('ord_job_del'))}" aria-label="${esc(t('ord_job_del'))}">×</button></div>`;
  const times = o.lines.filter(l => l.kind === 'time'), items = o.lines.filter(l => l.kind === 'item');
  const notes = [c.no_price ? t('ord_no_price', { n: c.no_price }) : '', times.length && !o.rate ? t('ord_no_rate') : ''].filter(Boolean);
  view.innerHTML = prHead('orders') + `<a class="ord-back" href="#orders">${esc(t('ord_back'))}</a>
    <div class="ord-head"><div class="ord-ht"><small>#${o.no}</small><h2>${esc(o.title)}</h2><p class="hint">${[o.customer ? esc(o.customer) : '', ordDue(o)].filter(Boolean).join(' · ')}</p></div>
      <div class="ord-acts"><select class="in" id="ostatus" aria-label="${esc(t('ord_status'))}">${ORD_ST.map(s => `<option value="${s}"${s === o.status ? ' selected' : ''}>${esc(t('ord_st_' + s))}</option>`).join('')}</select>
      <button class="btn" id="oedit">${t('act_edit')}</button></div></div>
    <div class="skpis"><div><small>${t('ord_c_total')}</small><b>${cur.format(c.total)}</b></div>
      ${o.budget ? `<div class="${diff < 0 ? 'warn' : ''}"><small>${t('ord_c_budget')}</small><b>${cur.format(o.budget)}</b></div>` : ''}
      <div><small>${t('ord_c_labor')}</small><b>${ordHm(c.minutes)}</b></div><div><small>${t('ord_c_material')}</small><b>${kg(c.grams)}</b></div></div>
    <div class="ord-grid"><div class="ord-main">
    <section class="card ord-sec"><div class="ord-sh"><h3>${t('ord_sec_prints')}</h3><button class="btn sm" id="oaddj">+ ${t('ord_add_print')}</button></div>
      ${o.jobs.length ? o.jobs.map(job).join('') : `<p class="hint">${t('ord_no_prints')}</p>`}</section>
    <section class="card ord-sec"><div class="ord-sh"><h3>${t('ord_sec_time')}</h3><button class="btn sm${o.timer_at ? ' pri' : ''}" id="otimer">${t(o.timer_at ? 'ord_timer_stop' : 'ord_timer_start')}</button><button class="btn sm" id="oaddt">+ ${t('ord_add_time')}</button></div>
      ${o.timer_at ? `<p class="note ord-run">${esc(t('ord_timer_run', { t: dtime(o.timer_at) }))}</p>` : ''}
      ${times.length ? times.map(line).join('') : `<p class="hint">${t('ord_no_time')}</p>`}</section>
    <section class="card ord-sec"><div class="ord-sh"><h3>${t('ord_sec_items')}</h3><button class="btn sm" id="oaddi">+ ${t('ord_add_item')}</button></div>
      ${items.length ? items.map(line).join('') : `<p class="hint">${t('ord_no_items')}</p>`}</section>
    </div><aside class="ord-side">
    <section class="card ord-sec"><div class="ord-sh"><h3>${t('ord_sec_calc')}</h3></div>
      <dl class="ord-calc">${calc.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${cur.format(v)}</dd></div>`).join('')}
        <div class="tot"><dt>${t('ord_c_total')}</dt><dd>${cur.format(c.total)}</dd></div></dl>
      ${o.budget ? `${ordBar(o)}<p class="hint${diff < 0 ? ' ord-late' : ''}">${esc(t(diff < 0 ? 'ord_c_over' : 'ord_c_left', { v: cur.format(Math.abs(diff)) }))}</p>` : ''}
      ${notes.map(x => `<p class="hint">${esc(x)}</p>`).join('')}
      <div class="ord-pdf"><a class="btn pri" href="order_pdf.php?id=${o.id}&amp;doc=quote" target="_blank" rel="noopener">${t('ord_pdf_quote')}</a>
        <a class="btn" href="order_pdf.php?id=${o.id}&amp;doc=statement" target="_blank" rel="noopener">${t('ord_pdf_stmt')}</a></div>
      <p class="hint">${t('ord_pdf_hint')}</p></section>
    ${o.notes ? `<section class="card ord-sec"><div class="ord-sh"><h3>${t('ord_f_notes')}</h3></div><p class="ord-notes">${esc(o.notes)}</p></section>` : ''}
    </aside></div>`;
  window.scrollTo(0, y);
  const save = async (a, body) => { try { ov.o = (await api(a, { id: o.id, ...body })).order; drawOrder(); } catch (e) { fail(e); } };
  $('#ostatus').onchange = e => save('order_status', { status: e.target.value });
  $('#oedit').onclick = () => orderDialog(o);
  $('#oaddj').onclick = () => jobsDialog(o);
  $('#oaddt').onclick = () => lineDialog(o, 'time', null);
  $('#oaddi').onclick = () => lineDialog(o, 'item', null);
  $('#otimer').onclick = () => save('order_timer', { on: !o.timer_at });
  view.querySelectorAll('[data-ojdel]').forEach(b => b.onclick = () => save('order_job_del', { job: +b.dataset.ojdel }));
  view.querySelectorAll('[data-oled]').forEach(b => b.onclick = () => { const l = o.lines.find(x => x.id === +b.dataset.oled); lineDialog(o, l.kind, l); });
}
function orderDialog(o) {
  const b = (ov.d && ov.d.business) || {}, isNew = !o;
  const v = o || { rate: b.rate, markup: b.markup || 0, vat: b.vat || 0 };
  dlg.innerHTML = `<form method="dialog" id="fo_"><div class="dlg-h"><b>${t(isNew ? 'ord_new_h' : 'ord_edit_h')}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">
      <label class="fld"><span>${t('ord_f_title')}</span><input class="in" name="title" required maxlength="160" value="${esc(v.title || '')}" placeholder="${esc(t('ord_f_title_ph'))}"></label>
      <div class="fgrid">
        <label class="fld"><span>${t('ord_f_customer')}</span><input class="in" name="customer" maxlength="160" value="${esc(v.customer || '')}"></label>
        <label class="fld"><span>${t('ord_f_due')}</span><input class="in" name="due" type="date" value="${esc(v.due || '')}"></label>
      </div>
      <label class="fld"><span>${t('ord_f_addr')}</span><textarea class="in" name="customer_addr" rows="3" maxlength="500">${esc(v.customer_addr || '')}</textarea></label>
      <p class="hint" style="margin:0">${t('ord_cust_hint')}</p>
      <div class="fgrid">
        <label class="fld"><span>${t('ord_f_budget')} (${esc(CSYM)})</span><input class="in num" name="budget" type="number" min="0" step="0.01" value="${v.budget ?? ''}"></label>
        <label class="fld"><span>${t('ord_f_rate')} (${esc(CSYM)})</span><input class="in num" name="rate" type="number" min="0" step="0.01" value="${v.rate ?? ''}"></label>
        <label class="fld"><span>${t('ord_f_markup')}</span><input class="in num" name="markup" type="number" min="0" max="1000" step="0.1" value="${v.markup ?? 0}"></label>
        <label class="fld"><span>${t('ord_f_vat')}</span><input class="in num" name="vat" type="number" min="0" max="100" step="0.1" value="${v.vat ?? 0}"></label>
      </div>
      <label class="fld"><span>${t('ord_f_notes')}</span><textarea class="in" name="notes" rows="3" maxlength="5000">${esc(v.notes || '')}</textarea></label>
    </div>
    <div class="dlg-f">${isNew ? '' : `<button type="button" class="btn ghost danger" id="fodel">${t('act_delete')}</button>`}<span style="flex:1"></span>
      <button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form>`;
  const f = $('#fo_');
  f.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
  const del = $('#fodel');
  if (del) del.onclick = async () => {
    if (!confirm(t('ord_del_confirm'))) return;
    try { await api('order_delete', { id: o.id }); dlg.close(); toast(t('deleted')); location.hash = 'orders'; } catch (er) { fail(er); }
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    try {
      const r = await api('order_save', { ...Object.fromEntries(new FormData(f)), id: o ? o.id : 0 });
      dlg.close(); toast(t('saved'));
      if (isNew) location.hash = 'order-' + r.order.id; else { ov.o = r.order; drawOrder(); }
    } catch (er) { fail(er); }
  };
  dlg.showModal();
}
function lineDialog(o, kind, l) {
  const time = kind === 'time', today = new Date().toLocaleDateString('sv');
  dlg.innerHTML = `<form method="dialog" id="fl_"><div class="dlg-h"><b>${t(time ? 'ord_add_time' : 'ord_add_item')}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">
      <label class="fld"><span>${t('ord_line_label')}</span><input class="in" name="label" maxlength="160"${time ? '' : ' required'} value="${esc((l && l.label) || '')}" placeholder="${esc(t(time ? 'ord_time_ph' : 'ord_item_ph'))}"></label>
      <div class="fgrid">${time ? `
        <label class="fld"><span>${t('ord_line_hours')}</span><input class="in num" name="h" type="number" min="0" max="1000" value="${l ? Math.floor(l.minutes / 60) : ''}"></label>
        <label class="fld"><span>${t('ord_line_min')}</span><input class="in num" name="m" type="number" min="0" max="59" value="${l ? l.minutes % 60 : ''}"></label>
        <label class="fld"><span>${t('ord_line_day')}</span><input class="in" name="day" type="date" value="${esc((l && l.day) || today)}"></label>` : `
        <label class="fld"><span>${t('ord_line_qty')}</span><input class="in num" name="qty" type="number" min="0.01" step="0.01" required value="${l ? l.qty : 1}"></label>
        <label class="fld"><span>${t('ord_line_price')} (${esc(CSYM)})</span><input class="in num" name="price" type="number" step="0.01" required value="${l ? l.price : ''}"></label>`}
      </div>
    </div>
    <div class="dlg-f">${l ? `<button type="button" class="btn ghost danger" id="fldel">${t('act_delete')}</button>` : ''}<span style="flex:1"></span>
      <button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form>`;
  const f = $('#fl_');
  f.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
  const del = $('#fldel');
  if (del) del.onclick = async () => {
    try { ov.o = (await api('order_line_del', { id: o.id, line: l.id })).order; dlg.close(); drawOrder(); } catch (er) { fail(er); }
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const b = Object.fromEntries(new FormData(f));
    if (time) { b.minutes = (+b.h || 0) * 60 + (+b.m || 0); delete b.h; delete b.m; }
    try { ov.o = (await api('order_line_save', { ...b, id: o.id, kind, line: l ? l.id : 0 })).order; dlg.close(); toast(t('saved')); drawOrder(); } catch (er) { fail(er); }
  };
  dlg.showModal();
}
async function jobsDialog(o) {
  dlg.innerHTML = `<div class="dlg-h"><b>${t('ord_jobs_h')}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><input class="in" id="ojq" type="search" placeholder="${esc(t('ord_jobs_search'))}" aria-label="${esc(t('ord_jobs_search'))}"><div id="ojl" class="ord-jobs"><div class="loading">${t('loading')}</div></div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button type="button" class="btn pri" id="ojgo" disabled>${esc(t('ord_jobs_add', { n: 0 }))}</button></div>`;
  dlg.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
  dlg.showModal();
  const d = await api('order_jobs_free').catch(e => { fail(e); return null; });
  if (!d || !dlg.open) return;
  const pick = new Set();
  const draw = () => {
    const q = $('#ojq').value.trim().toLowerCase();
    const list = d.jobs.filter(j => !q || (j.title + ' ' + (j.printer || '')).toLowerCase().includes(q));
    $('#ojl').innerHTML = list.length ? list.map(j => `<label class="ord-j"><input type="checkbox" value="${j.id}"${pick.has(j.id) ? ' checked' : ''}>
      <span><b>${esc(j.title)}</b><small>${[j.printer ? esc(j.printer) : '', esc(date(j.end)), j.grams !== null ? g(j.grams) : '', j.status === 3 ? esc(t('js_cancelled')) : ''].filter(Boolean).join(' · ')}</small></span></label>`).join('')
      : `<p class="hint">${t('ord_jobs_none')}</p>`;
  };
  draw();
  $('#ojq').oninput = draw;
  $('#ojl').onchange = e => {
    const id = +e.target.value;
    if (e.target.checked) pick.add(id); else pick.delete(id);
    const b = $('#ojgo'); b.disabled = !pick.size; b.textContent = t('ord_jobs_add', { n: pick.size });
  };
  $('#ojgo').onclick = async () => {
    try { ov.o = (await api('order_jobs_add', { id: o.id, jobs: [...pick] })).order; dlg.close(); toast(t('saved')); drawOrder(); } catch (er) { fail(er); }
  };
}
function bizDialog() {
  const b = ov.d.business;
  dlg.innerHTML = `<form method="dialog" id="fb_"><div class="dlg-h"><b>${t('ord_biz_h')}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p class="hint" style="margin:0">${t('ord_biz_lead')}</p>
      <div class="fld"><span>${t('ord_biz_logo')}</span><div class="ord-logo"><span id="blogo">${b.logo ? `<img src="${esc(b.logo)}" alt="">` : ''}</span>
        <label class="btn sm">${t('ord_biz_logo_pick')}<input type="file" id="blfile" accept="image/jpeg,image/png,image/webp" hidden></label>
        <button type="button" class="btn sm ghost" id="bldel"${b.logo ? '' : ' hidden'}>${t('ord_biz_logo_del')}</button></div></div>
      <label class="fld"><span>${t('ord_biz_name')}</span><input class="in" name="name" maxlength="160" value="${esc(b.name)}"></label>
      <label class="fld"><span>${t('ord_biz_addr')}</span><textarea class="in" name="addr" rows="3" maxlength="500">${esc(b.addr)}</textarea></label>
      <div class="fgrid">
        <label class="fld"><span>${t('ord_biz_contact')}</span><input class="in" name="contact" maxlength="200" value="${esc(b.contact)}"></label>
        <label class="fld"><span>${t('ord_biz_vatid')}</span><input class="in" name="vat_id" maxlength="40" value="${esc(b.vat_id)}"></label>
      </div>
      <label class="fld"><span>${t('ord_biz_footer')}</span><textarea class="in" name="footer" rows="2" maxlength="500" placeholder="${esc(t('ord_biz_footer_ph'))}">${esc(b.footer)}</textarea></label>
      <div class="fld"><span>${t('ord_biz_defaults')}</span></div>
      <div class="fgrid">
        <label class="fld"><span>${t('ord_f_rate')} (${esc(CSYM)})</span><input class="in num" name="rate" type="number" min="0" step="0.01" value="${b.rate ?? ''}"></label>
        <label class="fld"><span>${t('ord_f_markup')}</span><input class="in num" name="markup" type="number" min="0" max="1000" step="0.1" value="${b.markup ?? 0}"></label>
        <label class="fld"><span>${t('ord_f_vat')}</span><input class="in num" name="vat" type="number" min="0" max="100" step="0.1" value="${b.vat ?? 0}"></label>
      </div>
    </div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form>`;
  const f = $('#fb_');
  f.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
  const shown = uri => { b.logo = uri; $('#blogo').innerHTML = uri ? `<img src="${esc(uri)}" alt="">` : ''; $('#bldel').hidden = !uri; };
  $('#blfile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('a', 'business_logo'); fd.append('logo', file);
    try {
      const r = await fetch('api.php', { method: 'POST', credentials: 'same-origin', headers: AUTH, body: fd });
      const d = await r.json().catch(() => ({ error: 'http_' + r.status }));
      if (d.error) throw new Error(d.error);
      shown(d.logo);
    } catch (er) { fail(er); }
    e.target.value = '';
  };
  $('#bldel').onclick = async () => { try { await api('business_logo_del', {}); shown(null); } catch (er) { fail(er); } };
  f.onsubmit = async ev => {
    ev.preventDefault();
    try { const r = await api('business_save', Object.fromEntries(new FormData(f))); ov.d.business = r.business; dlg.close(); toast(t('saved')); } catch (er) { fail(er); }
  };
  dlg.showModal();
}

// ── Aktive Spule: Klipper-Makro für Drucker ohne MMU ───────────────────────
const MACRO_CFG = '[gcode_macro _3DSEARCH]\nvariable_spool: 0\ngcode:\n\n[gcode_macro SET_3DSEARCH_SPOOL]\ndescription: Aktive Spule für 3DSEARCH (Nummer vom Etikett)\ngcode:\n  SET_GCODE_VARIABLE MACRO=_3DSEARCH VARIABLE=spool VALUE={params.ID|default(0)|int}';

// ── Router ─────────────────────────────────────────────────────────────────
function route() {
  const h = location.hash.slice(1);
  const m = h.match(/^s(\d+)$/);
  if (m) return { v: 'spools', spool: +m[1] };
  if (h === 'jobs' || h === 'alerts' || h === 'maint' || h === 'queue') return { v: 'printers', sub: h };
  if (h === 'orders') return { v: 'printers', sub: 'orders' };
  const om = /^order-(\d+)$/.exec(h);
  if (om) return { v: 'printers', sub: 'orders', order: +om[1] };
  const lbm = /^library(?:\/(\d+))?$/.exec(h);   // Bibliothek, #library/<Nr> öffnet die Datei
  if (lbm && FM.lib) return { v: 'printers', sub: 'library', file: lbm[1] ? +lbm[1] : null };
  if (h === 'adopt') return { v: 'printers', adopt: true };   // Link aus der Mail „Druck nicht abgebucht“ (?go=adopt)
  const sh = h.match(/^share(?:-(\d+))?$/);   // Druck teilen (Link aus „Druck fertig“: ?go=share&job=…)
  if (sh) return { v: 'printers', sub: 'jobs', share: sh[1] ? +sh[1] : -1 };
  // Link aus der Mail „Lesezeichen am Computer“ (bm_mail): #connect/anbieter öffnet dessen Anleitung
  const co = h.match(/^connect\/(anycubic|bambu|creality|elegoo|prusaconnect)$/);
  if (co) return { v: 'printers', sub: 'connect', open: co[1] };
  const c = h.match(/^connect(?:\/(anycubic|bambu|creality)=(.+))?$/);
  if (c) return { v: 'printers', sub: 'connect', fill: c[1] ? [c[1], c[2]] : null };
  // Alte Lesezeichen zeigen auf printer_connect.php#pc_<anbieter>=Token — die Weiterleitung hierher behält das #
  const o = h.match(/^pc_(anycubic|bambu|creality)=(.+)$/);
  if (o) return { v: 'printers', sub: 'connect', fill: [o[1], o[2]] };
  if (h === 'locations') return { v: 'locations', tab: 'spools' };
  if (h === 'catalog') return { v: 'catalog', tab: 'spools' };
  if (h === 'print') return { v: 'print', tab: 'print' };
  if (h === 'edit') return { v: 'edit', tab: 'print' };
  if (h === 'gcode') return { v: 'gcode', tab: 'print' };
  if (h === 'models') return { v: 'models', tab: 'models' };
  if (h.startsWith('models/')) { let id = ''; try { id = decodeURIComponent(h.slice(7)); } catch (e) {} return id ? { v: 'model', tab: 'models', id } : { v: 'models', tab: 'models' }; }
  if (h === 'contests') return { v: 'contests', tab: 'models' };
  if (h.startsWith('contests/')) { const id = parseInt(h.slice(9), 10); return id > 0 ? { v: 'contest', tab: 'models', id } : { v: 'contests', tab: 'models' }; }
  if (h === 'labels') return { v: 'labels', tab: 'spools' };
  if (h === 'guide' || h.startsWith('guide/')) return { v: 'guide', tab: 'printers', sec: h.slice(6) };
  if (h === 'import') return { v: 'import', tab: 'spools' };
  if (h === 'news') return { v: 'news', tab: 'settings' };
  const pfm = /^print\/file\/(\d+)$/.exec(h);   // „Drucken“ auf einer Karte der Druck-Warteschlange (printqueue.php, 22.10.2026)
  if (pfm) return { v: 'print', tab: 'printers', file: +pfm[1] };
  const sgm = /^settings\/(general|print|spools|alerts|agent|data)$/.exec(h);
  if (sgm) return { v: 'settings', group: sgm[1], anchor: 'sg-' + sgm[1] };
  if (h === 'io') return { v: 'settings', anchor: 'io' };
  if (h === 'community' && !FM.community) return { v: 'printers' };
  return { v: ['printers', 'print', 'spools', 'catalog', 'history', 'stats', 'community', 'settings'].includes(h) ? h : 'printers' };
}
// Unterreiter, wenn sie nicht in eine Zeile passen (Handy, sieben Reiter seit der Bibliothek, 25.10.2026): den aktiven Reiter in
// die Mitte schieben. Neu gezeichnete Leisten (Druckerübersicht alle 10 s) behalten die Wischposition, solange derselbe Reiter aktiv ist.
const stPos = { href: '', left: 0 };
function subtabsKeep() {
  const bar = view.querySelector(':scope > .subtabs');
  if (!bar || bar.dataset.kept) return;
  bar.dataset.kept = '1';
  const on = bar.querySelector('a.on');
  if (!on || bar.scrollWidth <= bar.clientWidth + 1) return;
  const href = on.getAttribute('href');
  bar.scrollLeft = href === stPos.href ? stPos.left
    : on.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft - (bar.clientWidth - on.offsetWidth) / 2;
  stPos.href = href; stPos.left = bar.scrollLeft;
  bar.addEventListener('scroll', () => { stPos.left = bar.scrollLeft; }, { passive: true });
}
new MutationObserver(subtabsKeep).observe(view, { childList: true });
// Bereichs-Auswahl am Handy (.subdd statt der sieben Reiter, User 25.10.2026: „wischen ist nicht gut … evtl. ein Dropdown“):
// Tippen daneben oder Esc schließt
document.addEventListener('click', e => { document.querySelectorAll('details.subdd[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; }); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('details.subdd[open]').forEach(d => { d.open = false; }); });
/** Aktives Ziel markieren: Kopfleiste (Desktop), untere Leiste + „Mehr“ (Handy). */
function navMark(v) {
  document.querySelectorAll('#tabs a, #fmBottom a, #fmMoreSheet a[data-v]').forEach(a => a.classList.toggle('on', a.dataset.v === v));
  const more = document.getElementById('fmMore');
  if (more) more.classList.toggle('on', !!document.querySelector(`#fmMoreSheet a[data-v="${v}"]`));
}
async function render() {
  const r = route();
  // Zurück-Wischen (vor allem iPhone) wechselt die Ansicht — ein offener Dialog darf nicht über der neuen stehen bleiben
  if (dlg.open) dlg.close();
  if (r.spool) {
    // Spule über der aktuellen Ansicht öffnen (z. B. aus einem Druckerfach); nur bei direktem Link die Spulenliste dahinter
    if (!lastView) { lastView = 'spools'; navMark('spools'); await loadSpools().catch(fail); viewSpools(); }
    if (!st.spools.length) await loadSpools().catch(fail);
    showSpool(r.spool);
    return;
  }
  navMark(r.v === 'printers' && r.sub === 'library' ? 'library' : r.tab || r.v);
  if (r.v === 'printers' && r.sub === 'library') document.querySelectorAll('#fmBottom a[data-v="printers"]').forEach(a => a.classList.add('on'));
  closeSheet();
  stopPoll();
  navGen++;   // echter Ansichtswechsel (nicht beim Spulenblatt oben) — alte Lese-Antworten verfallen
  lastView = r.sub || r.v;
  try {
    if (r.v === 'printers' && r.sub === 'connect') {
      if (r.fill) {   // Token aus dem Lesezeichen: sofort aus Adresszeile und Verlauf nehmen
        try { cn.tokenFill = [r.fill[0], decodeURIComponent(r.fill[1])]; } catch (e) { cn.tokenFill = null; }
        history.replaceState(null, '', '#connect'); lastView = 'connect';
      }
      if (r.open) { cn.open = r.open; cn.brand = WZ_OF[r.open] || null; history.replaceState(null, '', '#connect'); lastView = 'connect'; }
      view.innerHTML = prHead('connect') + `<div class="loading">${t('loading')}</div>`;
      await viewConnect();
    }
    else if (r.v === 'printers' && r.sub === 'alerts') { view.innerHTML = prHead('alerts') + `<div class="loading">${t('loading')}</div>`; await viewAlerts(); }
    else if (r.v === 'printers' && r.sub === 'maint') await viewMaint();
    else if (r.v === 'printers' && r.sub === 'queue') await viewQueue();
    else if (r.v === 'printers' && r.sub === 'library') await viewLib(r.file);
    else if (r.v === 'printers' && r.sub === 'orders') await viewOrders(r.order);
    else if (r.v === 'print') await viewPrint();
    else if (r.v === 'edit') await viewEdit();
    else if (r.v === 'gcode') await viewGcode();
    else if (r.v === 'models') await viewModels();
    else if (r.v === 'model') await viewModel(r.id);
    else if (r.v === 'contests') await viewContests();
    else if (r.v === 'contest') await viewContest(r.id);
    else if (r.v === 'labels') await viewLabels();
    else if (r.v === 'guide') await viewGuide(r.sec);
    else if (r.v === 'import') await viewImport();
    else if (r.v === 'news') await viewNews();
    else if (r.v === 'printers' && r.share) {
      history.replaceState(null, '', '#jobs'); lastView = 'jobs';
      await viewPrinters('jobs');
      shareDialog(r.share > 0 ? r.share : null);
    }
    else if (r.v === 'printers' && r.adopt) {
      history.replaceState(null, '', '#printers');
      await viewPrinters('overview');
      adoptDialog(null);   // nichts mehr zu übernehmen → bleibt einfach die Übersicht
    }
    else if (r.v === 'printers') await viewPrinters(r.sub || 'overview');
    else if (r.v === 'spools') { await loadSpools(); viewSpools(); }
    else if (r.v === 'catalog') await viewCatalog();
    else if (r.v === 'history') await viewHistory();
    else if (r.v === 'stats') { if (!(await ampAplLocked('stats'))) await viewStats(); }
    else if (r.v === 'community') await viewCommunity();
    else if (r.v === 'settings') await viewSettings(r.group);
    else if (r.v === 'locations') await viewLocations();
  } catch (e) { fail(e); }
  const anc = r.anchor && document.getElementById(r.anchor);
  if (anc) anc.scrollIntoView(); else window.scrollTo(0, 0);
}
// Weiterleitung von den alten 3dsearch-Seiten (printers.php, printer_connect.php, print_send.php): ?go=<Ansicht>;
// ein mitgebrachtes # (Token aus einem alten Lesezeichen) hat Vorrang
// ?go=connect&prov=anycubic (Mail-Link, übersteht die Anmeldung — der Teil hinter # ginge dabei verloren) → #connect/anycubic
// Token vom Lesezeichen, den die Gäste-Seite vor der Anmeldung aus der Adresse genommen hat (header.php) → wieder einsetzen
try { const f = sessionStorage.getItem('fm_bm_fill'); if (f) { sessionStorage.removeItem('fm_bm_fill'); if (location.hash.length < 2) history.replaceState(null, '', location.pathname + location.search + f); } } catch (e) {}
{ const qs = new URLSearchParams(location.search), go = qs.get('go'), pv = qs.get('prov') || '';
  const sub = go === 'connect' && /^(anycubic|bambu|creality|elegoo|prusaconnect)$/.test(pv) ? '/' + pv
    : go === 'share' && /^\d+$/.test(qs.get('job') || '') ? '-' + qs.get('job') : '';
  if (go !== null) history.replaceState(null, '', location.pathname + (location.hash || (/^[a-z]+$/.test(go) ? '#' + go + sub : ''))); }
// Feedback-Runde (22.10.2026): Hinweis oben, bis weggeklickt oder geöffnet (FM.fbk nur für Werkstatt-Nutzer, index.php)
if (FM.fbk && !FM.embed) {
  const k = 'fm_fbk_' + FM.fbk.replace(/\D+/g, '');
  let off = false; try { off = localStorage.getItem(k) === '1'; } catch (e) {}
  if (!off) {
    const b = document.createElement('div');
    b.className = 'note fbk';
    b.innerHTML = `<span class="grow"><b>${esc(t('fbk_h'))}</b> ${esc(t('fbk_p'))}</span>
      <a class="btn sm pri" href="${esc(FM.fbk)}" target="_blank" rel="noopener">${esc(t('fbk_btn'))}</a>
      <button type="button" class="x-btn" aria-label="${esc(t('close'))}">×</button>`;
    const hide = () => { try { localStorage.setItem(k, '1'); } catch (e) {} b.remove(); };
    b.querySelector('a').addEventListener('click', hide);
    b.querySelector('button').addEventListener('click', hide);
    view.before(b);
  }
}
// Freunde einladen (22.10.2026): gleicher Platz wie der Feedback-Hinweis, nie beide zugleich (FM.rfi nur mit fertigem Druck, index.php)
if (FM.rfi && !FM.embed && !document.querySelector('.note.fbk')) {
  const k = 'fm_rfi_v1';
  let off = false; try { off = localStorage.getItem(k) === '1'; } catch (e) {}
  if (!off) {
    const b = document.createElement('div');
    b.className = 'note fbk rfi';
    const m = t(FM.rfi.n === 1 ? 'rfi_m1' : 'rfi_mn', { n: FM.rfi.n });
    b.innerHTML = `<span class="grow"><b>${esc(t('rfi_h'))}</b> ${esc(t('rfi_p', { m }))}</span>
      <a class="btn sm pri" href="${esc(FM.rfi.url)}">${esc(t('rfi_btn'))}</a>
      <button type="button" class="x-btn" aria-label="${esc(t('close'))}">×</button>`;
    const hide = () => { try { localStorage.setItem(k, '1'); } catch (e) {} b.remove(); };
    b.querySelector('a').addEventListener('click', hide);
    b.querySelector('button').addEventListener('click', hide);
    view.before(b);
  }
}
window.addEventListener('hashchange', render);
// Klick auf einen Reiter, dessen Adresse schon in der Zeile steht (z. B. nach replaceState beim Schließen der Spule), löst kein hashchange aus → selbst neu zeichnen
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (a && a.getAttribute('href') === location.hash && !e.ctrlKey && !e.metaKey) { e.preventDefault(); render(); }
});
// Eingebettet: der Seitenleiste melden, dass die Werkstatt läuft (sonst zeigt sie nach 20 s „lädt nicht“)
if (FM.embed) try { window.parent.postMessage({ type: '3dsearch-embed-ready' }, '*'); } catch (e) { /* ohne Rahmen */ }
if (FM.embed) document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (a && !a.getAttribute('href').startsWith('#') && !a.target) { a.target = '_blank'; a.rel = 'noopener'; }
}, true);
facets().catch(() => {});
// Eingebettet: Währung erst über den Schlüssel bekannt
(FM.embed && FM.tok ? get('settings_get', { k: 'currency' }).then(d => setCur(d.v && d.v.c)).catch(() => {}) : Promise.resolve()).then(render);
// ═══════════════════════════════════════════════════════════════════════════
// AllMyPrinters — eigene Ansichten. Wird vom Bauskript (tools/build_web.py) VOR das Ende der app.js-Hülle von /filament
// gesetzt und sieht deshalb alle ihre Bausteine (t, esc, view, dlg, api, get, prHead, printerArt, loadPrinters …).
// Ersetzt dort: viewConnect (Drucker im WLAN finden), viewPrint (G-Code an den Drucker), viewSettings (Sprache, Sicherung).
// ═══════════════════════════════════════════════════════════════════════════

const I_SEARCH = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const MODELS_URL = 'https://3dsearch.net/?utm_source=allmyprinters&utm_medium=app';
const spin = txt => `<span class="amp-spin"></span>${esc(txt)}`;

/** Hinweis an der Druckerkarte, wenn das Handy den Drucker nicht erreicht. */
/** Das Betriebssystem lässt die Verbindung ins Heimnetz nicht raus (EACCES/EPERM) — Firewall, Virenschutz oder VPN auf dem Rechner mit dem Agenten */
function ampBlockedNote(host, win, code, sec) {
  // Windows: das wahrscheinlich sperrende Programm beim Namen nennen (VPN, fremde Firewall/Virenschutz oder Windows-Firewall)
  const who = sec ? (sec.kind === 'win' ? t('amp_blocked_by_win') : t('amp_blocked_by', { x: sec.name })) : '';
  const pub = sec && sec.pub && sec.pub.length ? t('amp_blocked_pub', { n: sec.pub.join(', ') }) : '';
  return `<div class="note warn-note amp-blocked"><b>${esc(t('amp_blocked_h'))}</b><br>${esc(host ? t('amp_blocked', { h: host }) : t('amp_blocked_scan'))}${who ? `<br><b>${esc(who)}</b>` : ''}${pub ? `<br>${esc(pub)}` : ''}<br>${esc(t(win ? 'amp_blocked_win' : 'amp_blocked_other'))}${code ? `<br><small>${esc(code)}</small>` : ''}</div>`;
}
function ampUnreach(p) {
  // Hersteller-Konto (nur ansehen, 19.11.2026): Anmeldung abgelaufen, Drucker offline gemeldet, Konto entfernt
  if (p.ro && ['cloud_login', 'cloud_off', 'cloud_gone'].includes(p.amp_err)) {
    const lbl = t('prov_' + ((p.agent && p.agent.cloud) || ''));
    return `<div class="note warn-note">${esc(t('amp_' + p.amp_err.replace('cloud_', 'cl_e_card_'), { p: lbl }))}${p.amp_err === 'cloud_off' ? '' : `<div class="amp-acts"><a class="btn sm" href="#connect">${esc(t('amp_cl_relogin'))}</a></div>`}</div>`;
  }
  if (!p.amp_err && p.amp_devmode === false) return `<div class="note warn-note">${esc(t('amp_bb_devmode'))}${ampHelpLinks('bambu')}</div>`;
  const be = p.agent && p.agent.backend;
  const k = p.amp_err === 'key' ? (be === 'bambu' ? 'amp_bb_wrong' : be === 'elegoo' ? 'amp_cc_wrong' : be === 'flashforge' ? 'amp_ff_wrong' : 'amp_unreach_key')
    : p.amp_err === 'lan' ? (be === 'anycubic' ? 'amp_ac_lan' : 'amp_ff_lan') : null;
  // Nicht erreichbar: vielleicht neue IP → „Adresse ändern“ gleich hier (10.11.2026)
  if (!k && p.amp_err === 'unreach' && p.amp_block) return ampBlockedNote(p.host, p.amp_block_win, p.amp_block, p.amp_block_sec);
  const addr = !k && p.amp_err === 'unreach' ? `<div class="amp-acts"><button type="button" class="btn sm" data-act="amp_addr" data-pid="${esc(p.id)}" data-name="${esc(p.name)}">${esc(t('amp_addr_btn'))}</button></div>` : '';
  return `<div class="note warn-note">${esc(k ? t(k) : t('amp_unreach', { h: p.host || '' }))}${p.amp_detail ? `<br><small>${esc(String(p.amp_detail).slice(0, 160))}</small>` : ''}${ampHelpLinks(be || 'moonraker')}${addr}</div>`;
}

// ── Adresse ändern (neue IP des Druckers) — Fächer, Spulen, Profil, Foto und Codes bleiben ─────────────────
const I_ADDR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/></svg>';
window.ampAddrBtn = (prov, p) => p.ro ? '' : `<button class="icon-btn" title="${esc(t('amp_addr_btn'))}" aria-label="${esc(t('amp_addr_btn'))}" data-act="amp_addr" data-pid="${esc(p.id)}" data-name="${esc(p.name)}">${I_ADDR}</button>`;
window.ampAddrDialog = async ds => {
  const p = ((AMP.db && AMP.db.printers) || []).find(x => x.id === ds.pid);
  if (!p) return;
  const withPort = a => a ? a.host + (['moonraker', 'octoprint', 'prusalink'].includes(p.kind || 'moonraker') && a.port && a.port !== 7125 && a.port !== 80 ? ':' + a.port : '') : '';
  const cur = withPort(p.main || p), alt0 = withPort(p.alt);
  // Zweite Adresse (10.11.2026): z. B. Tailscale/VPN für unterwegs — ein Eintrag statt zwei (zwei buchten jeden Druck doppelt)
  const fld = (id, lbl, val, hint) => `<label class="fld"><span>${esc(lbl)}</span><input class="in" id="${id}" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="done" value="${esc(val)}"></label>${hint ? `<p class="hint amp-addr-h">${esc(hint)}</p>` : ''}`;
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_addr_btn'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p class="hint">${esc(t('amp_addr_p', { n: p.name }))}</p>
      ${fld('ampaddr', t('amp_addr_lbl'), cur, '')}
      ${fld('ampaddr2', t('amp_addr_alt_lbl'), alt0, t('amp_addr_alt_hint'))}
      ${p.alt && p.on_alt ? `<p class="hint">${esc(t('amp_addr_on_alt'))}</p>` : ''}
      <div id="ampaddrmsg"></div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button type="button" class="btn" id="ampaddrforce" hidden>${esc(t('amp_addr_force'))}</button>
      <button type="button" class="btn pri" id="ampaddrok">${esc(t('save'))}</button></div>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const inp = dlg.querySelector('#ampaddr'), inp2 = dlg.querySelector('#ampaddr2'), msg = dlg.querySelector('#ampaddrmsg'), force = dlg.querySelector('#ampaddrforce');
  const save = async f => {
    const h = inp.value.trim(), h2 = inp2.value.trim();
    msg.innerHTML = `<p class="hint">${esc(t('amp_slc_testing'))}</p>`;
    try {
      const r = await api('amp_set_host', { printer: p.id, host: h, alt: h2, force: !!f });
      if (r.ok) { dlg.close(); toast(t('saved')); await loadPrinters(true); drawPrinters(); return; }
      const hh = (r.field === 'alt' ? h2 : h).split(':')[0];
      msg.innerHTML = `<div class="note err-note">${esc(t('amp_addr_err_' + r.error, { h: hh, n: r.name || '' }))}</div>`;
      // „Trotzdem speichern“: niemand antwortet, oder unter der zweiten Adresse ein anderer Rechnername (z. B. umbenannt)
      force.hidden = !(r.error === 'notfound' || (r.error === 'other' && r.field === 'alt'));
    } catch (e) {
      const m = String(e.message || '').split('\n')[0];
      msg.innerHTML = `<div class="note err-note">${esc(m === 'exists' ? t('amp_exists') : m === 'host' ? t('amp_addr_err_host') : t('err_generic'))}</div>`;
    }
  };
  dlg.querySelector('#ampaddrok').onclick = () => save(false);
  force.onclick = () => save(true);
  inp.onkeydown = inp2.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(false); } };
  dlg.showModal(); inp.focus(); inp.select();
};
// Drucker unter neuer Adresse wiedergefunden (backend relocateLost) → kurz sagen, Liste neu
AMP.on('relocated', d => {
  if (d && d.how === 'auto') toast(t('amp_moved', { n: d.name || '', h: d.host || '' }));
  if (!dlg.open && (location.hash === '' || location.hash === '#printers')) loadPrinters(false).then(drawPrinters).catch(() => {});
});

// ── Drucker hinzufügen ─────────────────────────────────────────────────────
const ac = { found: null, scanned: false };
function devRow(d, i) {
  const sub = [d.model && d.model !== d.name ? d.model : '', d.rinkhals ? 'Rinkhals' : d.kind && d.kind !== 'moonraker' ? t('prov_' + d.kind) : '', d.host + ':' + d.port].filter(Boolean).join(' · ');
  return `<div class="amp-dev"><span class="pc-art">${printerArt(d.model || d.name)}</span><span class="t"><b>${esc(d.name)}</b><small>${esc(sub)}</small></span>
    ${d.added ? `<span class="tag">${esc(t('amp_added'))}</span>` : `<button type="button" class="btn sm pri" data-add="${i}">${esc(t('amp_add_btn'))}</button>`}</div>`;
}
function addDialog(d) {
  const kind = d.kind || 'moonraker';
  dlg.innerHTML = `<form method="dialog" id="fadd"><div class="dlg-h"><b>${esc(t('amp_add_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><div class="amp-dev"><span class="pc-art">${printerArt(d.model || d.name)}</span><span class="t"><b>${esc(d.model || d.name)}</b><small>${esc(t('prov_' + kind) + ' · ' + d.host + ':' + d.port)}</small></span></div>
      <label class="fld"><span>${esc(t('amp_name_lbl'))}</span><input class="in" name="name" maxlength="60" value="${esc(kind === 'moonraker' ? d.name : '')}" placeholder="${esc(d.model || d.name)}"></label>
      ${kind === 'prusalink' ? `<label class="fld"><span>${esc(t('amp_pl_pass'))}</span><input class="in" name="pass" type="password" maxlength="100" autocomplete="off" required></label><p class="hint" style="margin:0">${esc(t('amp_pl_pass_p'))}</p>` : ''}
      ${kind === 'bambu' ? `<label class="fld"><span>${esc(t('amp_bb_code'))}</span><input class="in" name="code" maxlength="20" autocomplete="off" autocapitalize="off" required></label>
        <label class="fld"><span>${esc(t('amp_bb_serial'))}</span><input class="in" name="serial" maxlength="40" autocomplete="off" autocapitalize="characters" value="${esc(d.serial || '')}"></label>
        <p class="hint" style="margin:0">${esc(t('amp_bb_p'))}</p>` : ''}
      ${kind === 'cc2' ? `<label class="fld"><span>${esc(t('amp_cc_code'))}</span><input class="in" name="code" maxlength="20" autocomplete="off" autocapitalize="off"${d.need_code ? ' required' : ''}></label>
        ${d.serial ? '' : `<label class="fld"><span>${esc(t('amp_bb_serial'))}</span><input class="in" name="serial" maxlength="40" autocomplete="off" autocapitalize="characters" required></label>`}
        ${d.lan_only === false ? `<div class="note warn-note">${esc(t('amp_cc_lan'))}</div>` : ''}<p class="hint" style="margin:0">${esc(t('amp_cc_p'))}</p>` : ''}
      ${kind === 'acl' ? `${d.lan === false ? `<div class="note warn-note">${esc(t('amp_ac_lan'))}</div>` : ''}<p class="hint" style="margin:0">${esc(t('amp_ac_p'))}</p>` : ''}
      ${kind === 'flashforge' ? `<label class="fld"><span>${esc(t('amp_ff_code'))}</span><input class="in" name="code" maxlength="20" autocomplete="off" autocapitalize="off" inputmode="numeric" required></label>
        ${d.serial ? '' : `<label class="fld"><span>${esc(t('amp_bb_serial'))}</span><input class="in" name="serial" maxlength="60" autocomplete="off" autocapitalize="characters" placeholder="SN…" required></label>`}
        <p class="hint" style="margin:0">${esc(t('amp_ff_p'))}</p>${/creator\s*5/i.test(d.model || d.name || '') ? '' : `<div class="note amp-beta">${esc(t('amp_ff_beta'))}</div>`}` : ''}
      ${kind === 'octoprint' ? `<p class="hint" style="margin:0">${esc(t('amp_op_p'))}</p><details><summary class="hint">${esc(t('amp_op_manual'))}</summary><label class="fld"><span>${esc(t('amp_key_lbl'))}</span><input class="in" name="key" maxlength="100" autocomplete="off" autocapitalize="off"></label></details>` : ''}
      ${d.need_key && kind === 'moonraker' ? `<label class="fld"><span>${esc(t('amp_mr_key'))}</span><input class="in" name="key" maxlength="100" autocomplete="off" autocapitalize="off" required></label><p class="hint" style="margin:0">${esc(t('amp_mr_key_p'))}</p>` : ''}
      <div id="faddmsg"></div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button class="btn pri">${esc(t(kind === 'octoprint' ? 'amp_op_btn' : 'amp_add_btn'))}</button></div></form>`;
  let stop = false;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { stop = true; dlg.close(); });
  dlg.addEventListener('close', () => { stop = true; }, { once: true });
  const msg = (h, err) => { $('#faddmsg').innerHTML = `<div class="note${err ? ' warn-note' : ''}">${h}</div>`; };
  const errTxt = m => esc(m === 'exists' ? t('amp_exists') : m === 'clients' ? t('amp_cc_clients') : m === 'lan' ? t(kind === 'acl' ? 'amp_ac_lan' : 'amp_ff_lan') : m === 'acl_old' ? t('amp_ac_old')
    : m === 'login' ? t(kind === 'prusalink' ? 'amp_pl_wrong' : kind === 'bambu' ? 'amp_bb_wrong' : kind === 'cc2' ? 'amp_cc_wrong' : kind === 'flashforge' ? 'amp_ff_wrong' : kind === 'moonraker' ? 'amp_mr_wrong' : 'amp_op_wrong')
    : m === 'serial' ? t('amp_bb_need_serial') : m === 'unreach' ? t('amp_unreach', { h: d.host }) : m === 'plan' ? t('err_plan') : t('err_generic'));
  $('#fadd').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), btn = e.target.querySelector('.btn.pri'); btn.disabled = true;
    let key = (f.get('key') || '').trim();
    try {
      if (kind === 'octoprint' && !key) {
        // Freigabe über OctoPrints „Application Keys“: OctoPrint fragt den angemeldeten Nutzer, wir warten bis zu 3 Minuten
        const rq = await api('amp_octo_request', { found: d });
        msg(`${esc(t('amp_op_wait'))}<br><a href="${esc(rq.url)}" target="_blank" rel="noopener">${esc(t('amp_op_open'))}</a>`);
        for (let i = 0; i < 90 && !stop && !key; i++) {
          await new Promise(z => setTimeout(z, 2000));
          const r = await api('amp_octo_poll', { found: d, token: rq.token }).catch(() => ({ wait: true }));
          if (r.key) key = r.key;
          if (r.denied) { msg(esc(t('amp_op_denied')), true); btn.disabled = false; return; }
        }
        if (!key) { if (!stop) { msg(esc(t('amp_op_timeout')), true); btn.disabled = false; } return; }
      }
      if (['bambu', 'cc2', 'creality', 'flashforge', 'acl'].includes(kind)) msg(spin(t('amp_bb_connecting')));
      await api('amp_add', { found: d, name: f.get('name'), key, pass: f.get('pass') || '', code: f.get('code') || '', serial: f.get('serial') || '' });
      dlg.close(); toast(t('amp_added_ok')); pv.data = null; location.hash = 'printers';
    } catch (er) { btn.disabled = false; msg(errTxt(er.message) + (er.msg ? `<br><small>${esc(String(er.msg).slice(0, 160))}</small>` : ''), true); }
  };
  dlg.showModal();
}
// ── Hersteller-Konten (nur im Agenten, nur ansehen; 19.11.2026) ─────────────────────────────────────────────
const CL_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/></svg>';
async function ampCloudCard() {
  const box = $('#acloud'); if (!box) return;
  let d; try { d = await api('cloud_list'); } catch (e) { return; }
  if (!d.available || !$('#acloud')) return;
  const acc = d.accounts.map(a => `<li class="amp-clacc"><span class="amp-clacc-t"><b>${esc(a.label)}</b><span class="hint">${esc([a.user, t('amp_cl_n_pr', { n: a.printers.length })].filter(Boolean).join(' · '))}</span>
      ${a.err === 'auth' ? `<span class="amp-clbad">${esc(t('amp_cl_expired'))}</span>` : ''}</span>
      <span class="amp-acts">${a.err === 'auth' ? `<button type="button" class="btn sm pri" data-cllogin="${esc(a.prov)}">${esc(t('amp_cl_relogin'))}</button>`
        : `<button type="button" class="btn sm" data-clpick="${esc(a.id)}">${esc(t('amp_cl_pick'))}</button>`}
      <button type="button" class="btn sm ghost" data-clrm="${esc(a.id)}" data-cllbl="${esc(a.label)}">${esc(t('amp_cl_remove'))}</button></span></li>`).join('');
  box.innerHTML = `<h2>${CL_ICON} ${esc(t('amp_cl_h'))}</h2><p class="hint">${esc(t('amp_cl_lead'))}</p>
    <div class="amp-clprovs">${d.provs.map(P => `<button type="button" class="btn" data-cllogin="${esc(P.prov)}">${esc(P.label)}</button>`).join('')}</div>
    ${acc ? `<ul class="amp-claccs">${acc}</ul>` : ''}`;
  box.hidden = false;
  box.querySelectorAll('[data-cllogin]').forEach(b => b.onclick = () => ampCloudLogin(d.provs.find(P => P.prov === b.dataset.cllogin)));
  box.querySelectorAll('[data-clpick]').forEach(b => b.onclick = () => ampCloudPick(b.dataset.clpick));
  box.querySelectorAll('[data-clrm]').forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = t('amp_cl_remove_sure'); return; }   // zweiter Klick löscht (keine confirm()-Fenster)
    b.disabled = true;
    try { await api('cloud_remove', { id: b.dataset.clrm }); toast(t('amp_cl_removed', { p: b.dataset.cllbl })); pv.data = null; ampCloudCard(); } catch (e) { b.disabled = false; toast(t('err_generic')); }
  });
}
const clErr = (e, prov) => {
  const k = 'amp_cl_e_' + (e && e.message || '');
  const txt = (window.FM && FM.S && FM.S[k]) ? t(k) : t('amp_cl_e_http');
  return esc(txt) + (e && e.msg ? `<br><small>${esc(String(e.msg).slice(0, 160))}</small>` : '');
};
/** Anmeldung Schritt für Schritt: Felder kommen vom Anbieter (steps), Texte amp_cl_<prov>_<schritt> und amp_cl_f_<feld>. */
function ampCloudLogin(P, step, st, hint) {
  if (!P) return;
  step = step || P.first || 'start';
  const fields = (P.steps || {})[step] || [];
  const inp = f => f.type === 'textarea' ? `<textarea class="in" name="${esc(f.k)}" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea>`
    : `<input class="in${f.type === 'code' ? ' amp-clcode' : ''}" name="${esc(f.k)}" type="${f.type === 'password' ? 'password' : f.type === 'email' ? 'email' : 'text'}"${f.type === 'code' ? ' inputmode="numeric" autocomplete="one-time-code" maxlength="8"' : f.type === 'email' ? ' autocomplete="email"' : ' autocomplete="off"'} autocapitalize="off" spellcheck="false" required>`;
  dlg.innerHTML = `<form method="dialog" id="fcl"><div class="dlg-h"><b>${esc(t('amp_cl_login_h', { p: P.label }))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">${hint ? `<div class="note">${esc(t(hint, { e: st && st.email || '' }))}</div>` : ''}<p class="hint" style="margin-top:0">${esc(t('amp_cl_' + P.prov + '_' + step))}</p>
      ${fields.map(f => `<label class="fld"><span>${esc(t('amp_cl_f_' + f.k))}</span>${inp(f)}</label>`).join('')}
      <p class="hint amp-clpriv">${esc(t('amp_cl_priv', { p: P.label }))}</p><div id="fclmsg"></div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button class="btn pri">${esc(t('amp_cl_next'))}</button></div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  $('#fcl').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn.pri'); btn.disabled = true; btn.innerHTML = spin(t('loading'));
    const vals = {}; fields.forEach(f => { const v = String(new FormData(e.target).get(f.k) || ''); vals[f.k] = f.type === 'password' ? v : v.trim(); });
    try {
      const r = await api('cloud_login', { prov: P.prov, step, inp: vals, st: st || {} });
      if (r.done) { ampCloudPick(r.id, r.devices); return; }
      ampCloudLogin(P, r.step, r.st, r.hint);
    } catch (er) { btn.disabled = false; btn.textContent = t('amp_cl_next'); $('#fclmsg').innerHTML = `<div class="note warn-note">${clErr(er, P.prov)}</div>`; }
  };
  if (!dlg.open) dlg.showModal();
  const first = dlg.querySelector('input, textarea'); if (first) first.focus();
}
/** Drucker aus dem Konto wählen (schon hinzugefügte ausgegraut). */
async function ampCloudPick(id, devices) {
  if (!devices) { try { devices = (await api('cloud_devices', { id })).devices; } catch (e) { toast(e.message === 'auth' ? t('amp_cl_e_auth') : t('amp_cl_e_http')); ampCloudCard(); return; } }
  const open = devices.filter(d => !d.added);
  dlg.innerHTML = `<form method="dialog" id="fclp"><div class="dlg-h"><b>${esc(t('amp_cl_pick_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">${devices.length ? `<p class="hint" style="margin-top:0">${esc(t('amp_cl_pick_p'))}</p><div class="amp-cldevs">${devices.map(d => `<label class="amp-cldev${d.added ? ' off' : ''}">
        <input type="checkbox" name="dev" value="${esc(d.dev)}"${d.added ? ' disabled checked' : ' checked'}><span><b>${esc(d.name)}</b><span class="hint">${esc([d.model, d.added ? t('amp_cl_added') : d.online === false ? t('amp_cl_offline') : ''].filter(Boolean).join(' · '))}</span></span></label>`).join('')}</div>`
      : `<div class="note">${esc(t('amp_cl_none'))}</div>`}<p class="hint">${esc(t('amp_cl_ro_p'))}</p><div id="fclpmsg"></div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t(open.length ? 'cancel' : 'close'))}</button>${open.length ? `<button class="btn pri">${esc(t('amp_cl_add', { n: open.length }))}</button>` : ''}</div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { dlg.close(); ampCloudCard(); });
  const upd = () => { const n = dlg.querySelectorAll('input[name=dev]:checked:not(:disabled)').length, b = dlg.querySelector('#fclp .btn.pri'); if (b) { b.textContent = t('amp_cl_add', { n }); b.disabled = !n; } };
  dlg.querySelectorAll('input[name=dev]').forEach(c => c.onchange = upd);
  const f = $('#fclp');
  f.onsubmit = async e => {
    e.preventDefault();
    const devs = [...dlg.querySelectorAll('input[name=dev]:checked:not(:disabled)')].map(c => c.value);
    if (!devs.length) return;
    const btn = f.querySelector('.btn.pri'); btn.disabled = true;
    try { await api('cloud_add', { id, devs }); dlg.close(); toast(t('amp_cl_added_ok', { n: devs.length })); pv.data = null; location.hash = 'printers'; }
    catch (er) { btn.disabled = false; $('#fclpmsg').innerHTML = `<div class="note warn-note">${er.message === 'plan' || er.code === 'printers' ? esc(t('amp_cl_e_plan')) : clErr(er)}</div>`; }
  };
  if (!dlg.open) dlg.showModal();
}
/** Eigene iOS-App (nicht Agent-Modus: dort beantwortet der Agent native('info') und sucht selbst im Netz). */
let ampIosP = null;
const ampIsIOS = () => ampIosP || (ampIosP = AMP.native('info', {}).then(i => !!i && i.platform === 'ios').catch(() => false));
async function viewConnect() {
  view.innerHTML = prHead('connect') + `
    <section class="card amp-card"><h2>${esc(t('amp_add_h'))}</h2><p class="hint">${esc(t('amp_add_lead'))}</p>${ampHelpLinks('')}
      <div class="amp-row"><button type="button" class="btn pri" id="ascan">${esc(t('amp_scan_btn'))}</button></div><div id="ares"></div></section>
    <section class="card amp-card"><h2>${esc(t('amp_manual_h'))}</h2>
      <form class="amp-row" id="aman"><input class="in grow" id="ahost" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(t('amp_manual_ph'))}">
        <button class="btn">${esc(t('amp_check_btn'))}</button></form><div id="amres"></div></section>
    <section class="card amp-card amp-clcard" id="acloud" hidden></section>
    <p class="hint">${esc(t('amp_supported'))}</p>`;
  ampCloudCard();
  const draw = (el, list) => {
    el.innerHTML = `<div class="amp-found">${list.map(devRow).join('')}</div>`;
    el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addDialog(list[+b.dataset.add]));
  };
  const scan = async () => {
    const b = $('#ascan'), res = $('#ares'); if (!b) return;
    b.disabled = true; b.innerHTML = spin(t('amp_scanning')); res.innerHTML = '';
    try {
      const d = await api('amp_scan', {});
      ac.found = d.hosts; ac.scanned = true;
      if (!$('#ares')) return;
      if (!d.net || !d.net.ip) res.innerHTML = `<div class="note warn-note">${esc(t('amp_scan_nowifi'))}</div>`;
      else if (!d.hosts.length && d.blocked) res.innerHTML = ampBlockedNote('', d.win, d.blocked);
      else if (!d.hosts.length) {
        // Leere Suche (Meldung #34, 24.11.2026: Kobra S1 am iPhone „0 found“): am iPhone blockt iOS ohne Erlaubnis „Lokales Netzwerk“
        // jede Verbindung ins Heimnetz. Kein eigener Anycubic-Hinweis (User 25.11.: steht schon unter „Was braucht mein Drucker“)
        const ios = await ampIsIOS(); if (!$('#ares')) return;
        res.innerHTML = `<div class="note amp-scan0"><p>${esc(t('amp_scan_none'))}</p>${ios ? `<p>${esc(t('amp_scan_ios'))}</p>` : ''}${ampHelpLinks('')}</div>`;
      }
      else draw(res, d.hosts);
    } catch (e) { res.innerHTML = `<div class="note warn-note">${esc(t('err_generic'))}</div>`; }
    if ($('#ascan')) { b.disabled = false; b.textContent = t('amp_scan_btn'); }
  };
  $('#ascan').onclick = scan;
  if (ac.found && ac.found.length) draw($('#ares'), ac.found);
  $('#aman').onsubmit = async e => {
    e.preventDefault();
    const host = $('#ahost').value.trim(), el = $('#amres'), btn = e.target.querySelector('.btn');
    if (!host) return;
    btn.disabled = true; el.innerHTML = `<p class="hint">${spin(t('loading'))}</p>`;
    try {
      const d = await api('amp_probe', { host });
      if (d.found) draw(el, [{ ...d.found, added: false }]);
      else if (d.blocked) el.innerHTML = ampBlockedNote(host.replace(/^https?:\/\//, '').split(/[/:]/)[0], d.win, d.blocked);
      else el.innerHTML = `<div class="note warn-note">${esc(t('amp_not_found'))}${ampHelpLinks('')}</div>`;
    } catch (er) { el.innerHTML = `<div class="note warn-note">${esc(t('amp_not_found'))}${ampHelpLinks('')}</div>`; }
    btn.disabled = false;
  };
  // Erster Besuch ohne Drucker: gleich suchen
  if (!ac.scanned) { try { const c = await api('amp_counts', {}); if (!c.printers) scan(); } catch (e) {} }
}

// ── Drucken ────────────────────────────────────────────────────────────────
const pr = { file: null, meta: null, printer: null, busy: false, err: '', lib: null };   // lib: aus der Bibliothek (Druckbuch)
// Fertig geslicte 3MF (.gcode.3mf aus Bambu Studio/OrcaSlicer, 24.11.2026, Druckstarts 23.11.: ~20 vergebliche Versuche, so eine Datei in der
// Druckansicht slicen zu lassen — „can not be parsed“): gehört wie G-Code in „Fertige Datei senden“ (#gcode) und geht unverändert an den
// Drucker (backend printSend). Erkannt am Namen; in der Druckansicht auch am Inhalt (Metadata/plate_N.gcode, AMPMesh.isSliced).
const ampIsG3 = n => /\.gcode\.3mf$/i.test(String(n || ''));
const ampLibIsG3 = f => !!f && f.ext === '3mf' && [f.orig, f.name, (f.name || '') + '.3mf'].some(ampIsG3);
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp || inp.id !== 'pfile' || !inp.files || inp.files.length !== 1 || !window.AMPMesh) return;
  const f = inp.files[0];
  if (!/\.3mf$/i.test(f.name || '')) return;
  let sliced = ampIsG3(f.name);
  if (!sliced) { try { sliced = await AMPMesh.isSliced(f); } catch (er) { sliced = false; } }
  if (!sliced || inp.files[0] !== f) return;
  toast(t('amp_g3_moved'));
  try { const token = await ampStash(f); pr.file = { token, name: f.name, size: f.size }; pr.meta = null; pr.err = ''; pr.lib = null; location.hash = 'gcode'; }
  catch (er) { fail(er); }
});
const ampSize = n => n >= 1048576 ? nf1.format(n / 1048576) + ' MB' : nf.format(Math.round(n / 1024)) + ' KB';
async function pickFile() {
  try {
    const f = await AMP.native('pick', {});
    if (!f) return;
    pr.file = f; pr.meta = null; pr.err = ''; pr.lib = null;
    viewGcode();
  } catch (e) { fail(e); }
}
// Datei aus einer anderen App („Teilen“ / „Öffnen mit“) → direkt in die Druckansicht
// G-Code → direkt senden (ohne Server); STL/3MF → Slicer-Ansicht von /filament (Datei über pctaTake übergeben)
let ampHand = null;
AMP.on('file', async f => {
  if (await ampWantShare(f)) return;   // gehört zu einem gemerkten Modell (13.11.2026)
  if (/\.(gcode|gco|g)$/i.test(f.name || '') || ampIsG3(f.name)) { pr.file = f; pr.meta = null; pr.err = ''; pr.lib = null; if (location.hash === '#gcode') viewGcode(); else location.hash = 'gcode'; return; }
  ampHand = f;
  if (location.hash === '#print') viewPrint(); else location.hash = 'print';
});
/** Ersetzt pctaTake von /filament (Übergabe von einer 3DSEARCH-Modellseite): hier die geteilte Datei aus einer anderen App. */
async function pctaTake() {
  const h = ampHand; ampHand = null;
  if (!h) return null;
  try {
    const blob = await (await fetch((window.AMP_BASE || '') + '/file?t=' + encodeURIComponent(h.token))).blob();
    return { file: new File([blob], h.name), model_id: '', title: h.name, url: '', source: 'app' };
  } catch (e) { return null; }
}
/** Hinweis oben in der Slicer-Ansicht: wohin das Modell geht, und der Weg ohne Server. */
// Hinweis + Einleitung der Druckansicht passend zum Slicer (10.11.2026, Adam: eigener Container, Text sprach trotzdem von
// „unserem Server (3dsearch.net)“). Gleiche Prüfung wie backend.js slicer().
const ampSlicerOwn = () => { const s = (AMP.db && AMP.db.settings && AMP.db.settings.slicer) || {}; return s.mode === 'own' && /^https?:\/\/[^\s\/?#]+/i.test(s.url || '') ? s.url : null; };
const ampSliceNote = () => {
  const own = ampSlicerOwn(); let h = '';
  try { h = own ? new URL(own).host : ''; } catch (e) { h = own || ''; }
  if (own) setTimeout(ampSlcCheck, 0);   // Hinweis „Container aktualisieren“ kommt nach, sobald die Ansicht steht
  setTimeout(ampLibHook, 0);              // „In Bibliothek speichern“ für die gewählte Datei
  setTimeout(ampEdNoteHook, 0);            // „Platte bearbeiten“ (Editor, 19.11.2026)
  return `${esc(own ? t('amp_slice_note_own', { h }) : t('amp_slice_note'))} <a href="#gcode">${esc(t('amp_gcode_link'))}</a> · <button type="button" class="lnk amp-edopen" id="ampedopen">${esc(t('amp_ed_open'))}</button>${own ? '<span id="ampslcupd"></span>' : ''}`;
};
const ampSliceIntro = () => ampSlicerOwn() ? esc(t('amp_slice_intro_own')) : S.psd_intro;
// Eigener Container zu alt für eine Funktion dieser App-Version (10.11.2026): Hinweis mit Update-Befehl, blockiert nichts
const AMP_SLC_PULL = 'docker pull ghcr.io/nolimitek/allmyprinters-slicer:latest';
// bambu: Container 1.0.4–1.0.7 — Bambu lädt beim Start kein Filament aus dem AMS (17.11.2026), eigener, deutlicher Text
const ampSlcUpd = (v, need, inline, bambu) => {
  const msg = esc(t(bambu ? 'amp_slc_bambu' : 'amp_slc_update', { v: v || '?', n: need || '' }));
  return inline ? `<span class="amp-slc-upd"><br><br><b>${msg}</b><br><code>${esc(AMP_SLC_PULL)}</code></span>`
    : `<div class="note warn-note amp-slc-upd">${msg}<br><code>${esc(AMP_SLC_PULL)}</code></div>`;
};
/** Druckansicht: Platzhalter #ampslcupd (in ampSliceNote) nachträglich füllen, wenn der eigene Container eine Funktion nicht kann. */
function ampSlcCheck() {
  if (!ampSlicerOwn()) return;
  api('amp_slicer_caps', {}).then(r => {
    const el = document.getElementById('ampslcupd');
    if (el && r && (r.missing || []).length) el.innerHTML = ampSlcUpd(r.version, r.need, true, r.bambu);
  }).catch(() => {});
}

async function viewGcode() {
  const g_ = navGen;
  const head = `<h1>${esc(t('amp_print_h'))}</h1><p class="lead">${esc(t('amp_print_lead'))}</p>`;
  const models = `<a class="card amp-card amp-models" href="#models">${I_SEARCH}<span><b>${esc(t('amp_search_models'))}</b><br><span class="hint">${esc(t('amp_search_models_p'))}</span></span></a>`;
  if (!pr.file) {
    view.innerHTML = head + `<section class="card amp-card"><button type="button" class="btn pri" id="ppick">${esc(t('amp_pick_btn'))}</button>
      <p class="hint" style="margin:10px 0 0">${esc(t('amp_gcode_only'))} <a href="#print">${esc(t('amp_slice_link'))}</a></p></section>` + models;
    $('#ppick').onclick = pickFile;
    return;
  }
  if (!pr.meta && !pr.err) {
    view.innerHTML = head + `<div class="loading">${esc(t('amp_reading'))}</div>`;
    try { pr.meta = await api('amp_file_meta', { file: pr.file }); } catch (e) { pr.err = 'read'; }
    if (g_ !== navGen) return;
  }
  // Druckerliste frisch halten (neu hinzugefügt, gerade fertig geworden …), beim Umschalten des Druckers aber nicht jedes Mal
  if (!pv.data || Date.now() - (pr.dataAt || 0) > 10000 || pr.dataFor !== pr.file.token) {   // neue Datei → frische Liste
    try { await loadPrinters(false); pr.dataAt = Date.now(); pr.dataFor = pr.file.token; } catch (e) { if (e.message === STALE) return; }
  }
  if (g_ !== navGen) return;
  const ps = ((pv.data && pv.data.connections) || []).flatMap(c => c.printers);
  if (!pr.printer || !ps.some(p => p.id === pr.printer)) {
    const want = pv.printKey ? pv.printKey.split(':').pop() : null;
    pr.printer = (ps.find(p => p.id === want) || ps.find(p => p.online && !p.busy) || ps[0] || {}).id || null;
  }
  const p = ps.find(x => x.id === pr.printer);
  const md = pr.meta || {};
  const ws = (md.weights || []).map((w, i) => ({ w, i })).filter(x => x.w > 0);
  const tot = ws.reduce((a, x) => a + x.w, 0);
  let h = head + `<section class="card amp-card"><div class="amp-file"><span class="amp-thumb">${md.thumb ? `<img src="${esc(md.thumb)}" alt="">` : I_PRINTER}</span>
      <div class="t"><b>${esc(pr.file.name)}</b><span class="hint">${esc(ampSize(pr.file.size))}${md.slicer ? ' · ' + esc(md.slicer) : ''}</span>
      <div class="amp-kv">${md.time_s ? `<span><small>${esc(t('amp_time'))}</small><b>${esc(dur(Math.round(md.time_s / 60)))}</b></span>` : ''}
        ${tot ? `<span><small>${esc(t('amp_grams'))}</small><b>${esc(gUse(tot))}</b></span>` : ''}</div></div></div>
      ${md.g3mf ? `<p class="hint amp-g3">${esc(t('amp_g3_note'))}</p>` : ''}
      <div class="amp-acts" style="margin-top:10px"><button type="button" class="btn sm" id="pother">${esc(t('amp_pick_other'))}</button></div></section>`;
  if (pr.err) h += `<div class="note warn-note">${esc(t('amp_file_bad'))}</div>`;
  if (!ps.length) {
    h += `<div class="empty"><b>${esc(t('amp_no_printers'))}</b><br><br><a class="btn pri" href="#connect">${esc(t('pr_tab_connect'))}</a></div>`;
  } else {
    const opt = x => `<option value="${esc(x.id)}"${x.id === pr.printer ? ' selected' : ''}${!x.online || x.busy ? ' disabled' : ''}>${esc(x.name)}${!x.online ? ' · ' + t('amp_offline') : x.busy ? ' · ' + t('amp_busy') : ''}</option>`;
    h += `<section class="card amp-card"><label class="fld"><span>${esc(t('amp_printer_lbl'))}</span><select class="in" id="pprn">${ps.map(opt).join('')}</select></label>`;
    if (p && ws.length) {
      const single = !p.slots.length || p.slots.every(s => s.single);
      const ttg = p.ttg_map || [];
      h += `<div class="fld" style="margin-top:12px"><span>${esc(t('amp_tools_h'))}</span></div><div class="amp-tools">` + ws.map(({ w, i }) => {
        const sl = single ? p.slots[0] : p.slots.find(s => s.index === (ttg[i] ?? i));
        const sp = sl && sl.spool_id ? st.spools.find(s => s.id === sl.spool_id) : null;
        const fmat = md.types[i] || '', fcol = /^#[0-9a-f]{6}/i.test(md.colors[i] || '') ? md.colors[i].slice(0, 7) : '#888';
        const smat = sp ? sp.material : sl && sl.material;
        const bad = fmat && smat && fmat.toUpperCase().replace(/[^A-Z]/g, '') !== String(smat).toUpperCase().replace(/[^A-Z]/g, '');
        const where = sl ? slotName(sl) : '–';
        return `<div class="amp-tool"><span class="sw" style="background:${esc(fcol)}"></span>
          <span><b>${esc(ws.length > 1 ? t('amp_tool', { n: i + 1 }) + ' · ' : '')}${esc(fmat || '?')} · ${esc(gUse(w))}</b>
            <small>${sp ? esc(t('amp_charge')) + ' ' + esc(title(sp) + ' · ' + sub(sp)) + ' (' + esc(where) + ')' : esc(where) + ' – ' + esc(t('amp_no_spool'))}</small>
            ${bad ? `<small class="warn-t">${esc(t('amp_mismatch', { m: smat, f: fmat }))}</small>` : ''}</span>
          ${sl ? `<button type="button" class="btn sm ghost" data-act="assign" ${slotAttrs(p, sl)}>${esc(sp ? t('slot_change') : t('slot_assign'))}</button>` : '<span></span>'}</div>`;
      }).join('') + `</div>`;
    } else if (p && !pr.err) h += `<p class="hint">${esc(t('amp_no_grams'))}</p>`;
    // Reicht die Spule? (16.11.2026) Bedarf je Fach gegen den Rest der Spule darin — Hinweis direkt über dem Startknopf, Drucken bleibt möglich
    if (p && ws.length) {
      const sh = await api('print_short', { printer: p.id, weights: md.weights }).then(r => r.short || []).catch(() => []);
      if (g_ !== navGen) return;
      if (sh.length) h += `<div class="note warn-note amp-short">${sh.map(x => esc(t('pf_short', { slot: tf('pc_slot_n', x.slot), need: nf.format(x.need), left: nf.format(x.left), spool: x.spool }))).join('<br>')}</div>`;
    }
    const can = p && p.online && !p.busy && !pr.busy && !pr.err;
    // Bett vor dem Druck nivellieren (17.11.2026, Wunsch YvonneOliver Community #39): Anycubic LAN, seit 21.11.2026 auch Elegoo CC2 (p.lvl),
    // Wahl je Drucker wie in der Druckansicht (psd_level_<key>)
    if (p && (p.lvl || (p.agent && p.agent.backend === 'anycubic'))) {
      let on = true; try { const sv = localStorage.getItem('psd_level_moonraker:' + p.id); if (sv !== null) on = sv === '1'; } catch (e) { /* privates Fenster */ }
      h += `<label class="chk row amp-lvl"><input type="checkbox" id="plvl"${on ? ' checked' : ''}> ${esc(t('psd_level'))}</label>`;
    }
    if (p && p.cal) h += ampCalHtml(p.cal, 'moonraker:' + p.id, false);
    // Flashforge noch in der Testphase (22.11.2026, User: „Hinweis …, dass es eben noch in Testung ist und dass Fehler passieren können“);
    // Creator 5 / 5 Pro seit 0.19.5 ohne (am echten C5 Pro bestätigt, #30/#31) — wie backend ffBeta
    if (p && p.agent && p.agent.backend === 'flashforge' && !/creator\s*5/i.test(p.model || '')) h += `<div class="note amp-beta">${esc(t('amp_ff_beta'))}</div>`;
    h += `<div id="pprog"></div><div class="amp-acts"><button type="button" class="btn pri" id="pgo"${can ? '' : ' disabled'}>${esc(t('amp_start_btn'))}</button>
        <button type="button" class="btn" id="pup"${can ? '' : ' disabled'}>${esc(t('amp_upload_only'))}</button></div></section>`;
  }
  view.innerHTML = h + models;
  $('#pother').onclick = pickFile;
  const sel = $('#pprn'); if (sel) sel.onchange = () => { pr.printer = sel.value; viewGcode(); };
  const lvl = $('#plvl'); if (lvl) lvl.onchange = () => { try { localStorage.setItem('psd_level_moonraker:' + pr.printer, lvl.checked ? '1' : '0'); } catch (e) { /* privates Fenster */ } };
  ampCalWire(view, 'moonraker:' + pr.printer);
  view.querySelectorAll('[data-act="assign"]').forEach(b => b.onclick = e => { e.stopPropagation(); assignDialog(b.dataset); });
  const send = async (start, plateOk) => {
    pr.busy = true;
    view.querySelectorAll('#pgo, #pup').forEach(b => { b.disabled = true; });
    const box = $('#pprog');
    box.innerHTML = `<div class="amp-prog"><i style="width:0%"></i></div><p class="hint" id="pptxt">${esc(t('amp_uploading', { p: 0 }))}</p>`;
    const off = AMP.on('upload', d => {
      const pc = d.total ? Math.min(100, Math.round(d.sent / d.total * 100)) : 0;
      const bar = box.querySelector('.amp-prog i'); if (bar) bar.style.width = pc + '%';
      const tx = $('#pptxt'); if (tx) tx.textContent = pc >= 100 && start ? t('amp_starting') : t('amp_uploading', { p: pc });
    });
    try {
      const lv = $('#plvl'), cv = $('#pcal_vib'), cf = $('#pcal_flow');
      const r = await api('amp_print', { printer: pr.printer, file: pr.file, meta: pr.meta, start, lib: pr.lib, ...(lv ? { level: !!lv.checked } : {}),
        ...(cv && cv.checked ? { vib: true } : {}), ...(cf && cf.checked ? { flow: true } : {}), ...(plateOk ? { plate_ok: true } : {}) });
      toast(t(r.started ? 'amp_started' : 'amp_uploaded'));
      pr.file = null; pr.meta = null; pr.lib = null; pv.data = null;
      location.hash = 'printers';
    } catch (e) {
      // „Platte leer?“ (Agent mit Überwachung): Kamerabild weicht vom Referenzbild ab → nachfragen, auf Ja noch einmal mit plate_ok
      if (e.message === 'plate_check' && start) {
        off(); pr.busy = false;
        if (confirm(t('amp_plate_ask'))) return await send(start, true);   // await: das finally hier läuft erst nach dem zweiten Senden
        box.innerHTML = `<div class="note warn-note">${esc(t('amp_plate_stop'))}</div>`; view.querySelectorAll('#pgo, #pup').forEach(b => { b.disabled = false; }); return;
      }
      box.innerHTML = `<div class="note warn-note">${esc(e.message === 'printer_busy' ? t('amp_busy') : t('err_generic'))}${e.msg ? ' (' + esc(e.msg) + ')' : ''}</div>`;
      view.querySelectorAll('#pgo, #pup').forEach(b => { b.disabled = false; });
    } finally { off(); pr.busy = false; }
  };
  const go = $('#pgo'), up = $('#pup');
  if (go) go.onclick = () => send(true);
  if (up) up.onclick = () => send(false);
}

// ── Einstellungen ──────────────────────────────────────────────────────────
const AMP_CUR = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'ILS', 'JPY', 'CNY', 'HKD', 'TWD', 'SGD', 'KRW', 'INR', 'BRL', 'MXN', 'ZAR'];
const ampTimeMode = () => { let v = ''; try { v = localStorage.getItem('amp_time') || ''; } catch (e) {} return v === '24' || v === '12' ? v : 'auto'; };
const LANG_NAME = { de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español', it: 'Italiano', nl: 'Nederlands' };
// ── Einstellungen: aufklappbare Gruppen (17.11.2026) ──
// #settings/<gruppe> öffnet die Gruppe; sonst die zuletzt offene (localStorage amp_set_open). Immer nur eine offen.
const AMP_SG = ['general', 'print', 'spools', 'alerts', 'agent', 'data'];
const AMP_SG_IC = {
  general: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14v7h10v-7"/></svg>',
  spools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6"/></svg>',
  alerts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
};
function ampSgWant(group) {
  if (AMP_SG.includes(group)) { try { localStorage.setItem('amp_set_open', group); } catch (e) {} return group; }
  let g = null; try { g = localStorage.getItem('amp_set_open'); } catch (e) {}
  return AMP_SG.includes(g) ? g : null;
}
function ampSgWire() {
  const all = [...view.querySelectorAll('.amp-sg')];
  all.forEach(d => d.addEventListener('toggle', () => {
    if (d.open) {
      all.forEach(x => { if (x !== d && x.open) x.open = false; });
      try { localStorage.setItem('amp_set_open', d.dataset.g); } catch (e) {}
      // Kopf der Gruppe sichtbar halten (die vorige, darüber liegende klappt gerade zu)
      setTimeout(() => { const r = d.getBoundingClientRect(); if (r.top < 60 || r.top > innerHeight * 0.6) d.scrollIntoView({ block: 'start' }); }, 30);
    } else if (!all.some(x => x.open)) { try { localStorage.setItem('amp_set_open', ''); } catch (e) {} }
  }));
}

async function viewSettings(group) {
  let info = {}, appInfo = null;
  try { info = await AMP.native('info', {}); } catch (e) {}
  // Mit Agent beantwortet der Agent native('info') → bisher stand dort nur seine Version (Denny, Thema 36). In der gekoppelten
  // App kommt die App-Version direkt vom Handy (loader.js window.AMPApp), im Browser gibt es nur den Agenten.
  if (info.agent && window.AMPApp) { try { appInfo = await window.AMPApp.call('info', {}); } catch (e) {} }
  const verLines = !info.agent ? `<p>AllMyPrinters · ${esc(t('amp_version', { v: info.version || '?' }))}</p>`
    : (appInfo ? `<p>AllMyPrinters App · ${esc(t('amp_version', { v: appInfo.version || '?' }))}</p>` : '')
      + `<p>AllMyPrinters Agent · ${esc(t('amp_version', { v: info.version || '?' }))}</p>`;
  const theme = AMP_THEME.mode;   // system | light | dark
  const slc = ((await api('settings_get').catch(() => ({}))).settings || {}).slicer || {};
  // Gruppen (17.11.2026): je Gruppe die unveränderten Karten; leere Gruppen (z. B. „Agent“ im Browser ohne Agent) entfallen
  const SG = [
    ['general', `
    <section class="card amp-card amp-set">
      <label class="fld"><span>${esc(t('amp_lang'))}</span><select class="in" id="slang">${FM.LANGS.map(l => `<option value="${l}"${l === LANG ? ' selected' : ''}>${LANG_NAME[l]}</option>`).join('')}</select></label>
      <div class="fld"><span>${esc(t('amp_theme'))}</span><span class="seg" id="sth">${['system', 'light', 'dark'].map(m => `<button type="button" data-th="${m}" class="${theme === m ? 'on' : ''}">${esc(t('amp_' + m))}</button>`).join('')}</span></div>
      <div class="fld"><span>${esc(t('amp_time_h'))}</span><span class="seg" id="stime">${['auto', '24', '12'].map(m => `<button type="button" data-tm="${m}" class="${ampTimeMode() === m ? 'on' : ''}">${esc(t('amp_time_' + m))}</button>`).join('')}</span></div>
      <label class="fld"><span>${esc(t('amp_currency'))}</span><select class="in" id="scur">${AMP_CUR.map(c => `<option${c === FM.cur ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
    </section>
    <section class="card amp-card amp-about"><h2>${esc(t('amp_about_h'))}</h2>${verLines}
      <p class="hint">${esc(t('amp_credits'))}</p><p class="hint"><a href="https://allmyprinters.com/${LANG === 'de' ? 'de' : 'en'}/app-privacy/" target="_blank" rel="noopener">${esc(t('amp_privacy'))}</a> · allmyprinters.com</p></section>`],
    ['print', `
    <section class="card amp-card amp-slc"><h2>${esc(t('amp_slc_h'))}</h2><p class="hint">${esc(t('amp_slc_p'))}</p>
      <span class="seg" id="sslc"><button type="button" data-sm="default" class="${slc.mode !== 'own' ? 'on' : ''}">${esc(t('amp_slc_default'))}</button><button type="button" data-sm="own" class="${slc.mode === 'own' ? 'on' : ''}">${esc(t('amp_slc_own'))}</button></span>
      <div class="amp-srep" id="ssrepw"><label class="chk row"><input type="checkbox" id="ssrep"> ${esc(t('amp_srep_on'))}</label><p class="hint">${esc(t('amp_srep_p'))}</p></div>
      <div class="amp-slc-own" id="sslcown"${slc.mode === 'own' ? '' : ' hidden'}>
        <div class="amp-pf-row"><input class="in" id="sslcurl" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="go" placeholder="${esc(t('amp_slc_url_ph'))}" value="${esc(slc.url || '')}">
          <button type="button" class="btn sm pri" id="sslctest">${esc(t('amp_slc_test'))}</button></div>
        <div id="sslcmsg" class="amp-pf-msg">${slc.mode === 'own' ? `<p class="hint">${esc(t('amp_slc_using', { u: slc.url }))}</p>` : ''}</div>
        <p class="hint">${esc(t('amp_slc_howto'))} <a href="https://allmyprinters.com/${['de', 'en', 'fr', 'es', 'it', 'nl'].includes(LANG) ? LANG : 'en'}/slicer/install/" target="_blank" rel="noopener">allmyprinters.com/slicer/install</a></p>
      </div></section>
    <section class="card amp-card amp-costs"><h2>${esc(t('cost_h'))}</h2><p class="hint">${esc(t('cost_lead'))}</p><div id="scosts"></div></section>`],
    ['spools', `
    <section class="card amp-card amp-lowset"><h2>${esc(t('amp_low_h'))}</h2><p class="hint">${esc(t('amp_low_p'))}</p><div id="slow"></div></section>
    <section class="card amp-card amp-adj"><h2>${esc(t('amp_adj_h'))}</h2><p class="hint">${esc(t('amp_adj_p'))}</p><div id="sadj"></div></section>
    <section class="card amp-card amp-spush"><h2>${esc(t('amp_spush_h'))}</h2><p class="hint">${esc(t('amp_spush_p'))}</p>
      <label class="chk row"><input type="checkbox" id="sspush"> ${esc(t('amp_spush_on'))}</label></section>`],
    ['alerts', `
    ${window.AMPNative || AMP.agent ? '<section class="card amp-card amp-notif" id="snotif"></section>' : ''}
    <section class="card amp-card amp-watch" id="swatch"></section>`],
    ['agent', `
    ${window.AMPNative && !AMP.agent ? '<section class="card amp-card amp-agentc" id="sagent"></section>' : ''}
    ${AMP.remote ? '<section class="card amp-card amp-remote" id="sremote"></section>' : ''}
    ${AMP.agent && AMP.remote ? '<section class="card amp-card amp-pw" id="spw"></section>' : ''}
    ${AMP.agent && AMP.remote ? '<section class="card amp-card amp-ha" id="sha"></section>' : ''}
    ${AMP.agent && AMP.remote ? '<section class="card amp-card amp-plan" id="splan"></section>' : ''}`],
    ['data', `
    <section class="card amp-card amp-libloc"><h2>${esc(t('amp_lib_loc_h'))}</h2><div id="slibloc"></div></section>
    <section class="card amp-card"><h2>${esc(t('amp_backup_h'))}</h2><p class="hint">${esc(t('amp_backup_p'))}</p>
      <div class="amp-acts"><button type="button" class="btn" id="sexp">${esc(t('amp_export'))}</button><button type="button" class="btn" id="simp">${esc(t('amp_import'))}</button></div></section>
    <a class="card amp-card amp-models" href="#import">${I_IMP}<span><b>${esc(t('amp_imp_h'))}</b><br><span class="hint">${esc(t('amp_imp_more'))}</span></span></a>`],
  ];
  const sgOpen = ampSgWant(group);
  view.innerHTML = `<h1>${esc(t('amp_set_h'))}</h1><div class="amp-sgs">` + SG.filter(([, h]) => h.trim()).map(([g, h]) => `<details class="amp-sg" id="sg-${g}" data-g="${g}"${g === sgOpen ? ' open' : ''}>
      <summary><span class="amp-sg-ic" aria-hidden="true">${AMP_SG_IC[g]}</span><span class="amp-sg-t"><b>${esc(t('amp_sg_' + g))}</b><small>${esc(t('amp_sg_' + g + (g === 'agent' && AMP.agent ? '_sa' : '_s')))}</small></span><i class="amp-sg-chev" aria-hidden="true"></i></summary>
      <div class="amp-sg-b">${h}</div></details>`).join('') + `</div>`;
  ampSgWire();
  $('#slang').onchange = e => { try { localStorage.setItem('amp_lang', e.target.value); } catch (er) {} location.reload(); };
  if (AMP.remote) ampRemoteDraw();
  if (AMP.agent && AMP.remote) ampPwDraw();
  if (AMP.agent && AMP.remote) ampHaDraw();
  if (AMP.agent && AMP.remote) ampPlanDraw();
  ampNotifDraw();
  ampWatchDraw();
  ampAgentDraw();
  ampLibLocDraw();
  ampLowDraw();
  ampCostsDraw();
  // Zeitformat (23.11.2026, #53): gilt je Gerät; neu laden, damit alle Uhrzeiten (HC in app.js) es übernehmen
  view.querySelectorAll('#stime [data-tm]').forEach(b => b.onclick = () => {
    if (b.classList.contains('on')) return;
    try { if (b.dataset.tm === 'auto') localStorage.removeItem('amp_time'); else localStorage.setItem('amp_time', b.dataset.tm); } catch (e) {}
    location.reload();
  });
  view.querySelectorAll('[data-th]').forEach(b => b.onclick = () => {
    AMP_THEME.set(b.dataset.th);
    view.querySelectorAll('[data-th]').forEach(x => x.classList.toggle('on', x === b));
  });
  ampAdjDraw();
  // Spule im Fach auch am Drucker eintragen (16.11.2026, Bambu-AMS + Elegoo CC2): Standard an
  api('settings_get', {}).then(r => {
    const cb = $('#sspush'); if (!cb) return;
    cb.checked = !(r.settings || {}).amp_slot_push_off;
    cb.onchange = async () => { await api('settings_save', { k: 'amp_slot_push_off', v: !cb.checked }).catch(() => {}); toast(t('amp_saved')); };
    // Rückmeldung zum Druckstart (17.11.2026): Standard an, ab 0.9.10 für jeden Weg (auch eigener Slicer); Agent mit AMP_PING=off → aus und gesperrt
    const rb = $('#ssrep'); if (!rb) return;
    rb.checked = !r.start_locked && !(r.settings || {}).amp_start_report_off; rb.disabled = !!r.start_locked;
    rb.onchange = async () => { await api('settings_save', { k: 'amp_start_report_off', v: !rb.checked }).catch(() => {}); toast(t('amp_saved')); };
  }).catch(() => {});
  // Slicer (10.11.2026): Standard = unser Container; eigener erst nach erfolgreichem Verbindungstest gespeichert
  const slcBox = $('#sslcown'), slcMsg = $('#sslcmsg');
  const slcSeg = m => view.querySelectorAll('[data-sm]').forEach(x => x.classList.toggle('on', x.dataset.sm === m));
  view.querySelectorAll('[data-sm]').forEach(b => b.onclick = async () => {
    if (b.dataset.sm === 'default') {
      slcSeg('default'); slcBox.hidden = true;
      await api('settings_save', { k: 'slicer', v: { mode: 'default', url: $('#sslcurl').value } }).catch(() => {});
      toast(t('amp_saved'));
    } else { if (await ampAplDenied('own_slicer')) return; slcSeg('own'); slcBox.hidden = false; $('#sslcurl').focus(); }
  });
  const slcTest = async () => {
    const btn = $('#sslctest'); btn.disabled = true;
    slcMsg.innerHTML = `<p class="hint">${esc(t('amp_slc_testing'))}</p>`;
    try {
      const r = await api('amp_slicer_test', { url: $('#sslcurl').value });
      if (r.ok) {
        $('#sslcurl').value = r.url;
        await api('settings_save', { k: 'slicer', v: { mode: 'own', url: r.url } });
        slcMsg.innerHTML = `<div class="note ok-note">${esc(t('amp_slc_ok', { v: r.version, o: r.orca }))}</div>` + ((r.missing || []).length ? ampSlcUpd(r.version, r.need, false, r.bambu) : '');
      } else {
        slcMsg.innerHTML = `<div class="note err-note">${esc(t('amp_slc_err_' + r.error, { u: r.url || '' }))}</div>`;
      }
    } catch (e) { slcMsg.innerHTML = `<div class="note err-note">${esc(t('err_generic'))}</div>`; }
    finally { btn.disabled = false; }
  };
  $('#sslctest').onclick = slcTest;
  $('#sslcurl').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); slcTest(); } };
  $('#scur').onchange = e => { try { localStorage.setItem('amp_cur', e.target.value); } catch (er) {} setCur(e.target.value); api('settings_save', { k: 'currency', v: { c: e.target.value } }).catch(() => {}); toast(t('amp_saved')); };
  $('#sexp').onclick = async () => {
    try {
      const d = await api('amp_export', {});
      const r = await AMP.native('export', { name: 'allmyprinters-' + new Date().toISOString().slice(0, 10) + '.json', text: d.text });
      if (r && r.ok) toast(t('amp_saved'));
    } catch (e) { fail(e); }
  };
  $('#simp').onclick = async () => {
    try {
      const f = await AMP.native('import', {});
      if (!f || !f.text) return;
      if (!confirm(t('amp_import_confirm'))) return;
      const r = await api('amp_import', { text: f.text });
      toast(t('amp_import_ok', { s: r.spools, p: r.printers }));
      st.spools = []; pv.data = null;
    } catch (e) { toast(e.message === 'bad_file' ? t('amp_file_bad') : t('err_generic')); }
  };
}

// ── App: mit dem AllMyPrinters-Agenten verbinden (11.11.2026) ──────────────────────────────────────────
// Die App wird dann zum Fenster auf den Agenten (MainActivity lädt allmyprinters.com/web) und bucht nicht mehr selbst.
// Daten der App gehen beim Koppeln mit (die Startseite fragt, welche der Agent behält); Trennen geht dort jederzeit.
function ampAgentDraw() {
  const box = $('#sagent'); if (!box) return;
  box.innerHTML = `<h2>${esc(t('amp_ag_h'))}</h2><p class="hint">${esc(t('amp_ag_p'))}</p><p class="hint">${esc(t('amp_ag_how'))}</p>
    <div class="amp-acts"><button type="button" class="btn pri" id="sagscan">${esc(t('amp_ag_scan'))}</button></div>
    <form class="amp-pf-row" id="sagf" style="margin-top:10px"><input class="in" id="sagin" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${esc(t('amp_ag_paste_ph'))}">
      <button type="submit" class="btn sm">${esc(t('amp_ag_go'))}</button></form>`;
  $('#sagscan').onclick = () => openScanner();
  $('#sagf').onsubmit = e => { e.preventDefault(); ampAgentLink($('#sagin').value.trim()); };
}
const AMP_PAIR_RE = /^https:\/\/allmyprinters\.com\/web\/?#pair=[A-Za-z0-9_-]{100,}$/;
window.ampAgentLink = async url => {
  if (!AMP_PAIR_RE.test(String(url || ''))) { toast(t('amp_ag_bad')); return; }
  if (!confirm(t('amp_ag_confirm'))) return;
  try {
    // vollständig (mit NAS-Zugang der Bibliothek): geht nur Ende-zu-Ende verschlüsselt an den eigenen Agenten
    const [ex, n] = await Promise.all([api('amp_export', { full: true }), api('amp_counts', {})]);
    await AMP.native('agent_couple', { url, export: ex.text, spools: n.spools || 0, printers: n.printers || 0 });
  } catch (e) { fail(e); }
};
// Nach dem Trennen: den mitgebrachten Stand des Agenten übernehmen (einmal, Datei löscht die App erst nach erfolgreichem Import)
if (window.AMPNative && !AMP.agent) setTimeout(async () => {
  let r = null; try { r = await AMP.native('agent_restore', { op: 'get' }); } catch (e) { return; }
  if (!r || !r.text) return;
  try {
    await api('amp_import', { text: r.text });
    await AMP.native('agent_restore', { op: 'done' });
    toast(r.kind === 'copy' ? t('amp_ag_restored_copy', { d: new Date(+r.at).toLocaleString(LANG, { dateStyle: 'medium', timeStyle: 'short', ...HC }) }) : t('amp_ag_restored'));
    st.spools = []; if (typeof pv !== 'undefined') pv.data = null;
    render();
    // 3D-Netze der Bibliothek liegen nur dort, wo sie gebaut wurden → hier neu bauen, eins nach dem anderen
    const libs = ((await api('lib_list', {}).catch(() => ({}))).files || []).filter(f => f.can3d);
    for (const f of libs) { await api('lib_rebuild', { id: f.id }).catch(() => {}); await new Promise(z => setTimeout(z, 4000)); }
  } catch (e) { console.error('agent_restore', e); }
}, 600);

// ── Benachrichtigungen + Neuigkeiten (14.11.2026) ──────────────────────────────────────────
// Drucke: NUR mit Agent (läuft rund um die Uhr, die App nicht): Agent → allmyprinters.com/api/push.php → Firebase → App.
// Inhalt Ende-zu-Ende: den Schlüssel erzeugt das Handy, er geht nur durch den Tunnel an den Agenten (Einstellungen je Handy im Agenten).
// Neuigkeiten an alle App-Nutzer OHNE Firebase: allmyprinters.com/news.json (Android-Job etwa alle 12 h + hier beim Öffnen),
// Liste unter Mehr → Neuigkeiten, Punkt am Mehr-Knopf bei Ungelesenem. Geschrieben im AllMyPrinters-Admin (allmyprinters.com/admin/).
const AMP_NT_EV = ['done', 'cancel', 'error', 'pause', 'start', 'low', 'humid', 'offline', 'fail', 'maint'];   // low/humid/offline ab Agent 0.5.6, fail (Fehldruck-Verdacht) ab 0.8.0, maint (Wartung fällig) ab 0.18.0 (push.events)
const AMP_NT_ERR = ['denied', 'not_ready', 'no_gms', 'net', 'off', 'push_off', 'not_on'];
let ampNtMsg = null;   // Hinweis nach dem letzten Versuch (bleibt beim Neuzeichnen stehen)
let ampNtDenied = false;   // Android-Abfrage abgelehnt → nur noch der Weg über die Android-Einstellungen
function ampNtErr(e) {
  const m = String((e && e.message) || e || ''), x = String((e && (e.msg || (e.data && e.data.msg))) || '');
  if (/unknown method (push|news)/.test(m + ' ' + x)) return t('amp_nt_err_app_old');
  if (m === 'bad_action') return t('amp_nt_err_agent_old');
  if (m === 'push_off') return t('amp_nt_err_off');
  return AMP_NT_ERR.includes(m) ? t('amp_nt_err_' + m) : t('amp_nt_err_other', { e: m || '?' });
}
// ── Überwachung (17.11.2026): „Platte leer“ + Fehldruck-Erkennung — läuft nur im Agenten (Premium); ohne Agent nur der Hinweis ──
async function ampWatchDraw() {
  const box = $('#swatch'); if (!box) return;
  const L2 = ['de', 'en', 'fr', 'es', 'it', 'nl'].includes(LANG) ? LANG : 'en';
  const head = `<h2>${esc(t('amp_w_h'))}</h2><p class="hint">${esc(t('amp_w_p'))}</p>`;
  if (!(AMP.agent && AMP.remote)) {
    box.innerHTML = head + `<ul class="amp-w-list"><li>${esc(t('amp_w_plate_h'))}</li><li>${esc(t('amp_w_ai_h'))}</li></ul>
      <p class="hint">${esc(t('amp_w_need_agent'))}</p><p class="hint"><a href="https://allmyprinters.com/${L2}/agent/" target="_blank" rel="noopener">${esc(t('amp_nt_agent_link'))}</a></p>`;
    return;
  }
  let w;
  try { w = await AMP.remote('watch_get'); } catch (e) { box.innerHTML = head + `<div class="note warn-note">${esc(t('amp_w_old'))}</div>`; return; }
  if (!$('#swatch')) return;
  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? t('amp_w_now') : m < 120 ? t('amp_w_min', { n: m }) : t('amp_w_hours', { n: Math.round(m / 60) }); };
  const plateTxt = l => !l ? '' : l.state === 'empty' ? t('amp_w_res_empty') : l.state === 'check' ? t('amp_w_res_check') : t('amp_w_res_unknown');
  const verdictTxt = r => !r ? '' : r.err ? t('amp_w_ai_err', { e: r.err }) : t('amp_w_v_' + (r.verdict || 'warmup'), { n: r.n || 0 });
  const plan = w.plan || {};
  let h = head;
  // Platte leer
  h += `<h3>${esc(t('amp_w_plate_h'))}</h3>`;
  if (!plan.plate) h += `<div class="note">${esc(t('amp_w_plan'))}</div>`;
  else {
    h += `<label class="chk row"><input type="checkbox" id="swplate"${w.plate.on ? ' checked' : ''}> ${esc(t('amp_w_plate_on'))}</label><p class="hint">${esc(t('amp_w_plate_p'))}</p>`;
    h += `<div class="amp-w-pr">` + w.printers.map(p => `<div class="amp-w-row" data-pid="${esc(p.id)}">
        <span class="amp-w-ref">${p.ref ? `<img alt="" data-ref="${esc(p.id)}">` : I_PRINTER}</span>
        <span class="amp-w-t"><b>${esc(p.name)}</b><small>${esc(p.ref ? t('amp_w_ref_at', { t: ago(p.refAt || Date.now()) }) : t('amp_w_no_ref'))}${p.last ? ' · ' + esc(plateTxt(p.last)) : ''}</small></span>
        <span class="amp-w-b"><button type="button" class="btn sm" data-wref="${esc(p.id)}">${esc(t(p.ref ? 'amp_w_ref_new' : 'amp_w_ref'))}</button>
          ${p.ref ? `<button type="button" class="btn sm ghost" data-wchk="${esc(p.id)}">${esc(t('amp_w_check'))}</button>` : ''}</span></div>`).join('') + `</div>`;
  }
  // Fehldruck-Erkennung
  h += `<h3>${esc(t('amp_w_ai_h'))}</h3>`;
  if (!plan.ai) h += `<div class="note">${esc(t('amp_w_plan'))}</div>`;
  else {
    const st = w.ai.on ? (w.ai.ok ? `<div class="note ok-note">${esc(t('amp_w_ai_ok'))}</div>` : w.ai.ok === false ? `<div class="note warn-note">${esc(t('amp_w_ai_down', { u: w.ai.url || w.ai.def }))}. ${esc(t('amp_w_ai_down2'))}</div>` : '') : '';
    // Einrichten: Link auf Schritt 6 der Installationsanleitung (#ki) — dort steht der Befehl je System (17.11.2026: der Compose-Befehl
    // allein verwirrte, er passt nur zu compose.example.yml)
    const guide = `<a href="https://allmyprinters.com/${L2}/agent/install/#ki" target="_blank" rel="noopener">${esc(t('amp_w_ai_guide'))}</a>`;
    h += `<label class="chk row"><input type="checkbox" id="swai"${w.ai.on ? ' checked' : ''}> ${esc(t('amp_w_ai_on'))}</label><p class="hint">${esc(t('amp_w_ai_p'))}</p>
      <p class="hint">${esc(t('amp_w_ai_setup'))} ${guide}</p>${st}
      <div class="amp-w-ai"${w.ai.on ? '' : ' hidden'}>
        <label class="fld"><span>${esc(t('amp_w_ai_url'))}</span><span class="amp-pf-row"><input class="in" id="swurl" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="${esc(w.ai.def)}" value="${esc(w.ai.url)}"><button type="button" class="btn sm" id="swtest">${esc(t('amp_w_ai_test'))}</button></span></label>
        <div class="fld"><span>${esc(t('amp_w_sens'))}</span><span class="seg" id="swsens">${['low', 'mid', 'high'].map(k => `<button type="button" data-sens="${k}" class="${w.ai.sens === k ? 'on' : ''}">${esc(t('amp_w_sens_' + k))}</button>`).join('')}</span></div>
        <label class="fld"><span>${esc(t('amp_w_act'))}</span><select class="in" id="swact"><option value="notify"${w.ai.act === 'notify' ? ' selected' : ''}>${esc(t('amp_w_act_notify'))}</option><option value="pause"${w.ai.act === 'pause' ? ' selected' : ''}>${esc(t('amp_w_act_pause'))}</option></select></label>
        <div class="amp-w-pr">` + w.printers.map(p => `<label class="chk row amp-w-row2"><input type="checkbox" data-wai="${esc(p.id)}"${p.ai ? ' checked' : ''}> <span>${esc(p.name)}${p.run ? ` <small class="hint">· ${esc(verdictTxt(p.run))}</small>` : ''}</span></label>`).join('') + `</div>
      </div>`;
  }
  box.innerHTML = h;
  // Referenzbilder nachladen
  box.querySelectorAll('img[data-ref]').forEach(img => AMP.remote('watch_ref_img', { printer: img.dataset.ref }).then(r => { if (r && r.img) img.src = r.img; }).catch(() => {}));
  const save = async b => { try { await AMP.remote('watch_save', b); toast(t('amp_saved')); } catch (e) { toast(t('err_generic')); } };
  const pl = $('#swplate'); if (pl) pl.onchange = () => save({ plate: { on: pl.checked } });
  const ai = $('#swai'); if (ai) ai.onchange = async () => { await save({ ai: { on: ai.checked } }); ampWatchDraw(); };
  const act = $('#swact'); if (act) act.onchange = () => save({ ai: { act: act.value } });
  box.querySelectorAll('[data-sens]').forEach(b => b.onclick = () => { box.querySelectorAll('[data-sens]').forEach(x => x.classList.toggle('on', x === b)); save({ ai: { sens: b.dataset.sens } }); });
  box.querySelectorAll('[data-wai]').forEach(c => c.onchange = () => save({ printer: c.dataset.wai, aiOn: c.checked }));
  const url = $('#swurl'), test = $('#swtest');
  if (test) test.onclick = async () => {
    test.disabled = true;
    try { await AMP.remote('watch_save', { ai: { url: url.value.trim() } }); const r = await AMP.remote('watch_test'); toast(r && r.ok ? t('amp_w_ai_ok') : t('amp_w_ai_down', { u: url.value.trim() || w.ai.def })); }
    catch (e) { toast(t('err_generic')); } finally { test.disabled = false; ampWatchDraw(); }
  };
  box.querySelectorAll('[data-wref]').forEach(b => b.onclick = async () => {
    if (!confirm(t('amp_w_ref_ask'))) return;
    b.disabled = true; b.textContent = t('amp_w_busy');
    try { await AMP.remote('watch_ref', { printer: b.dataset.wref }); toast(t('amp_w_ref_done')); } catch (e) { toast(e.message === 'plan' ? t('amp_w_plan') : t('amp_w_cam_err')); }
    ampWatchDraw();
  });
  box.querySelectorAll('[data-wchk]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = t('amp_w_busy');
    try { const r = await AMP.remote('watch_check', { printer: b.dataset.wchk }); toast(plateTxt(r) || t('amp_w_res_unknown')); } catch (e) { toast(t('amp_w_cam_err')); }
    ampWatchDraw();
  });
}

async function ampNotifDraw() {
  const box = $('#snotif'); if (!box) return;
  const app = !!window.AMPNative, agentApp = app && AMP.agent && !!AMP.remote;
  let news = null, push = null;
  if (app) { try { news = await AMP.native('news', { op: 'state', lang: LANG }); } catch (e) { news = { err: e }; } }
  if (agentApp) { try { push = await AMP.remote('push_get'); } catch (e) { push = { err: e }; } }
  if (!$('#snotif')) return;
  const L2 = ['de', 'en', 'fr', 'es', 'it', 'nl'].includes(LANG) ? LANG : 'en';
  let h = `<h2>${esc(t('amp_nt_h'))}</h2>`;
  if (news && !news.err) {
    h += `<label class="chk row amp-nt-news"><input type="checkbox" id="sntnews"${news.on ? ' checked' : ''}> <span><b>${esc(t('amp_nt_news'))}</b><br><span class="hint">${esc(t('amp_nt_news_p'))}</span></span></label>`;
  }
  const blocked = news && !news.err && news.perm === false && (news.on || (push && push.on));
  // Noch nie gefragt (frisch installiert, Android 13+): „Erlauben“ öffnet die Android-Abfrage; erst nach Ablehnen der Weg in die Einstellungen
  if (blocked) h += ampNtDenied ? `<div class="note warn-note">${esc(t('amp_nt_err_denied'))} <button type="button" class="btn sm" id="sntperm">${esc(t('amp_nt_open_settings'))}</button></div>`
    : `<div class="note">${esc(t('amp_nt_perm_need'))} <button type="button" class="btn sm pri" id="sntallow">${esc(t('amp_nt_allow'))}</button></div>`;
  h += `<h3>${esc(t('amp_nt_print_h'))}</h3>`;
  if (!app) h += `<p class="hint">${esc(t('amp_nt_browser'))}</p>`;
  else if (!agentApp) h += `<p class="hint">${esc(t('amp_nt_need_agent'))}</p><p class="hint"><a href="https://allmyprinters.com/${L2}/agent/" target="_blank" rel="noopener">${esc(t('amp_nt_agent_link'))}</a></p>`;
  else if (push.err) h += `<div class="note warn-note">${esc(ampNtErr(push.err))}</div>`;
  else if (!push.avail) h += `<div class="note">${esc(t('amp_nt_err_off'))}</div>`;
  else {
    h += `<p class="hint">${esc(t('amp_nt_print_p'))}</p>`;
    if (push.on) {
      const ev = push.ev || [];
      const evs = AMP_NT_EV.filter(k => !Array.isArray(push.events) || push.events.includes(k));   // älterer Agent: nur, was er kann
      h += `<div class="amp-nt-evs">${evs.map(k => `<label class="chk row"><input type="checkbox" data-ntev="${k}"${ev.includes(k) ? ' checked' : ''}> <span>${esc(t('amp_nt_ev_' + k))}</span></label>`
          + (k === 'humid' ? `<label class="amp-nt-hp"${ev.includes('humid') ? '' : ' hidden'}><span>${esc(t('amp_nt_hp'))}</span><input class="in num" type="number" id="snthp" min="20" max="90" step="1" inputmode="numeric" value="${+push.hp || 40}"><span>%</span></label>` : '')).join('')}</div>
        <div class="amp-acts"><button type="button" class="btn" id="snttest">${esc(t('amp_nt_test'))}</button><button type="button" class="btn" id="sntoff">${esc(t('amp_nt_off'))}</button></div>`;
    } else h += `<div class="amp-acts"><button type="button" class="btn pri" id="snton">${esc(t('amp_nt_on'))}</button></div>`;
  }
  if (news && news.err && agentApp && !(push && push.err)) h += `<p class="hint">${esc(ampNtErr(news.err))}</p>`;
  if (ampNtMsg) h += `<div class="note ${ampNtMsg.ok ? 'ok-note' : 'warn-note'}">${esc(ampNtMsg.text)}</div>`;
  h += `<p class="hint amp-nt-newslink"><a href="#news">${esc(t('amp_news_open'))}</a></p>`;
  box.innerHTML = h;
  const msg = (text, ok) => { ampNtMsg = { text, ok }; };
  const nw = $('#sntnews');
  if (nw) nw.onchange = async () => {
    ampNtMsg = null;
    try { const r = await AMP.native('news', { op: 'set', on: nw.checked }); if (nw.checked && r && r.perm === false) ampNtDenied = true; else toast(t('amp_saved')); }
    catch (e) { msg(ampNtErr(e)); }
    ampNotifDraw();
  };
  const pm = $('#sntperm'); if (pm) pm.onclick = () => AMP.native('news', { op: 'settings' }).catch(() => {});
  const al = $('#sntallow');
  if (al) al.onclick = async () => { al.disabled = true; try { const r = await AMP.native('news', { op: 'set', on: true }); if (r && r.perm === false) ampNtDenied = true; } catch (e) {} ampNotifDraw(); };
  const on = $('#snton');
  if (on) on.onclick = async () => {
    on.disabled = true; ampNtMsg = null;
    try {
      const n = await AMP.native('push', { op: 'enable' });   // Erlaubnis, Firebase-Werte vom Server, Token, Schlüssel
      await AMP.remote('push_set', { token: n.token, key: n.key, kid: n.kid });
      await AMP.native('push', { op: 'registered', token: n.token }).catch(() => {});
      msg(t('amp_nt_on_ok'), true);
    } catch (e) { if (String(e && e.message) === 'denied') ampNtDenied = true; msg(ampNtErr(e)); }
    ampNotifDraw();
  };
  box.querySelectorAll('[data-ntev]').forEach(c => c.onchange = async () => {
    const ev = [...box.querySelectorAll('[data-ntev]')].filter(x => x.checked).map(x => x.dataset.ntev);
    const hpRow = box.querySelector('.amp-nt-hp'); if (hpRow) hpRow.hidden = !ev.includes('humid');
    try { await AMP.remote('push_set', { ev }); toast(t('amp_saved')); } catch (e) { fail(e); }
  });
  const hp = $('#snthp');
  if (hp) hp.onchange = async () => {
    const v = Math.max(20, Math.min(90, Math.round(+hp.value || 40))); hp.value = v;
    try { await AMP.remote('push_set', { hp: v }); toast(t('amp_saved')); } catch (e) { fail(e); }
  };
  const ts_ = $('#snttest');
  if (ts_) ts_.onclick = async () => {
    ts_.disabled = true; ampNtMsg = null;
    try { const r = await AMP.remote('push_test'); msg(r.sent ? t('amp_nt_sent') : ampNtErr(r.error), !!r.sent); } catch (e) { msg(ampNtErr(e)); }
    ampNotifDraw();
  };
  const of = $('#sntoff');
  if (of) of.onclick = async () => {
    of.disabled = true; ampNtMsg = null;
    try { await AMP.remote('push_off'); await AMP.native('push', { op: 'disable' }).catch(() => {}); toast(t('amp_saved')); } catch (e) { msg(ampNtErr(e)); }
    ampNotifDraw();
  };
}

// Neuigkeiten: Liste (#news) + Punkt am Mehr-Knopf. Gelesen = höchste Nummer in localStorage (je Oberfläche) und im Handy
// (der Android-Job meldet dann nichts mehr, was schon in der App gelesen wurde).
const AMP_NEWS_URL = () => { try { return localStorage.getItem('amp_news_url') || 'https://allmyprinters.com/news.json'; } catch (e) { return 'https://allmyprinters.com/news.json'; } };
let ampNews = null;
async function ampNewsLoad(force) {
  if (ampNews && !force && Date.now() - ampNews.at < 300000) return ampNews.items;
  const r = await fetch(AMP_NEWS_URL() + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
  if (!r.ok) throw new Error('http_' + r.status);
  const d = await r.json();
  ampNews = { items: Array.isArray(d.items) ? d.items.filter(x => x && +x.id > 0) : [], at: Date.now() };
  return ampNews.items;
}
const ampNewsSeen = () => { try { return +localStorage.getItem('amp_news_seen') || 0; } catch (e) { return 0; } };
async function ampNewsDot() {
  let items; try { items = await ampNewsLoad(); } catch (e) { return; }
  const seen = ampNewsSeen();
  document.body.classList.toggle('amp-news-new', items.some(x => +x.id > seen && Date.now() - Date.parse(x.at) < 30 * 864e5));
}
async function viewNews() {
  view.innerHTML = `<h1>${esc(t('amp_news_h'))}</h1><div id="nwl"><div class="loading">…</div></div>`;
  let items;
  try { items = await ampNewsLoad(true); } catch (e) { const b = $('#nwl'); if (b) b.innerHTML = `<div class="note">${esc(t('amp_news_err'))}</div>`; return; }
  const box = $('#nwl'); if (!box) return;
  const L2 = LANG === 'de' ? 'de' : 'en', seen = ampNewsSeen(), tx = (o) => (o || {})[L2] || (o || {}).en || '';
  box.innerHTML = (items.length ? items.map(x => `<article class="card amp-card amp-news${+x.id > seen ? ' new' : ''}">
      <p class="hint">${esc(new Date(x.at).toLocaleDateString(LANG, { dateStyle: 'long' }))}</p><h2>${esc(tx(x.t))}</h2><p class="amp-news-b">${esc(tx(x.b))}</p>
      ${/^https:\/\/[^\s"<>]+$/.test(x.u || '') ? `<p><a class="btn sm" href="${esc(x.u)}" target="_blank" rel="noopener">${esc(t('amp_news_more'))}</a></p>` : ''}</article>`).join('')
    : `<p class="hint">${esc(t('amp_news_empty'))}</p>`)
    + `<p class="hint amp-news-rel"><a href="https://allmyprinters.com/${LANG}/releases/" target="_blank" rel="noopener">${esc(t('amp_rel_link'))}</a></p>`   // Versionen auf allmyprinters.com (15.11.2026)
    + (window.AMPNative ? `<p class="hint amp-news-set"><a href="#settings/alerts">${esc(t('amp_news_set'))}</a></p>` : '');
  // Passender Moment für die Android-Erlaubnis: wer hier liest, will Neues vermutlich auch gemeldet bekommen
  if (window.AMPNative) AMP.native('news', { op: 'state' }).then(st => {
    if (!st || !st.on || st.perm !== false || !$('#nwl')) return;
    $('#nwl').insertAdjacentHTML('afterbegin', `<div class="card amp-card amp-news-ask"><p>${esc(t('amp_news_ask'))}</p><div class="amp-acts"><button type="button" class="btn pri" id="nwask">${esc(t('amp_news_ask_btn'))}</button></div></div>`);
    $('#nwask').onclick = async () => { try { const r = await AMP.native('news', { op: 'set', on: true }); const c = view.querySelector('.amp-news-ask'); if (c && r && r.perm) c.remove(); else if (c) c.innerHTML = `<p class="hint">${esc(t('amp_nt_err_denied'))}</p>`; } catch (e) {} };
  }).catch(() => {});
  const max = items.reduce((a, x) => Math.max(a, +x.id || 0), 0);
  if (max > seen) { try { localStorage.setItem('amp_news_seen', String(max)); } catch (e) {} }
  if (window.AMPNative && max) AMP.native('news', { op: 'seen', id: max }).catch(() => {});
  document.body.classList.remove('amp-news-new');
}
// Beim Start: Sprache fürs Handy (Benachrichtigungstexte), Sprung aus einer angetippten Benachrichtigung, Push-Token erneuert?
AMP.on('go', d => { if (d && /^(news|printers|maint|s\d+)$/.test(d.v)) location.hash = '#' + d.v; });   // s<Nr> = Spule (Warnung „bald leer“), maint = Wartung fällig
setTimeout(async () => {
  if (window.AMPNative) {
    try { const r = await AMP.native('news', { op: 'state', lang: LANG }); if (r && r.go) location.hash = '#' + r.go; } catch (e) {}
    // Datei, mit der die App gestartet wurde („Öffnen mit“ bei geschlossener App, 16.11.2026): Bridge.kt hat sie gemerkt, bis wir fragen
    try { const r = await AMP.native('fileTake', {}); if (r && r.file && r.file.token) window.AMP_ev('file', r.file); } catch (e) {}
    if (AMP.agent && AMP.remote) {
      try {
        const s = await AMP.native('push', { op: 'state' });
        if (s && s.token && s.changed) { await AMP.remote('push_set', { token: s.token, key: s.key, kid: s.kid }); await AMP.native('push', { op: 'registered', token: s.token }); }
      } catch (e) {}
    }
  }
  ampNewsDot();
}, 1500);
AMP.on('resume', () => ampNewsDot());

// ── Abo-Weichen (nur Agent, 16.11.2026): Plan anzeigen, Abo-Funktionen nennen, Sperrseite, wenn der Agent selbst abopflichtig ist ──
// Was kostenlos ist, entscheidet allmyprinters.com (Admin → Abo); der Agent prüft den signierten Plan (agent/src/plan.js).
const PLAN_F = ['pair', 'remote', 'push', 'camera', 'ha', 'library', 'print', 'models', 'spoolman', 'stats', 'plate', 'ai', 'plates', 'editor'];   // plate/ai: Überwachung, plates: Platten (18.11.2026), editor: Platte bearbeiten (19.11.2026)
async function ampPlanDraw() {
  const box = $('#splan'); if (!box) return;
  let s; try { s = await AMP.remote('plan_status'); } catch (e) { box.hidden = true; return; }
  const day = iso => new Date(iso).toLocaleDateString(LANG, { dateStyle: 'medium' });
  const head = s.src === 'offline' ? t('amp_plan_offline') : s.plan === 'beta' ? t('amp_plan_beta')
    : s.plan === 'pro' ? (s.until ? t('amp_plan_pro_until', { d: day(s.until) }) : t('amp_plan_pro')) : t('amp_plan_free');
  const locked = PLAN_F.filter(k => s.f && s.f[k] === false);
  box.innerHTML = `<h2>${esc(t('amp_plan_h'))}</h2><p class="amp-plan-st">${esc(head)}</p>
    ${locked.length ? `<p class="hint">${esc(t('amp_plan_locked'))}</p><ul class="amp-plan-l">${locked.map(k => `<li>${esc(t('amp_plan_f_' + k))}</li>`).join('')}</ul>` : ''}
    ${s.printers != null ? `<p class="hint">${esc(t('amp_plan_printers', { n: s.printers }))}</p>` : ''}
    <p class="hint">${esc(t('amp_plan_code', { c: s.code }))}${s.checked ? ' · ' + esc(t('amp_plan_checked', { d: new Date(s.checked).toLocaleString(LANG, { dateStyle: 'short', timeStyle: 'short', ...HC }) })) : ''}</p>
    <div class="amp-acts"><button type="button" class="btn sm" id="splanre">${esc(t('amp_plan_refresh'))}</button></div>`;
  $('#splanre').onclick = async () => { try { await AMP.remote('plan_refresh'); } catch (e) { fail(e); } ampPlanDraw(); };
}
/** Ohne Abo, wenn „Agent überhaupt“ abopflichtig ist: Sperrseite mit Sicherung (die Daten bleiben erreichbar). */
async function ampPlanLock() {
  let s; try { s = await AMP.remote('plan_status'); } catch (e) { return; }
  if (!s || !s.f || s.f.agent !== false || document.getElementById('amp-plan-lock')) return;
  const d = document.createElement('div');
  d.id = 'amp-plan-lock'; d.className = 'amp-plan-lock'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
  d.innerHTML = `<div class="amp-plan-lockc"><h2>${esc(t('amp_plan_lock_h'))}</h2><p>${esc(t('amp_plan_lock_p'))}</p><p class="hint">${esc(t('amp_plan_code', { c: s.code }))}</p>
    <div class="amp-acts"><button type="button" class="btn pri" id="plexp">${esc(t('amp_export'))}</button><button type="button" class="btn" id="plre">${esc(t('amp_plan_refresh'))}</button></div></div>`;
  document.body.appendChild(d);
  d.querySelector('#plexp').onclick = async () => {
    try { const x = await api('amp_export', {}); const r = await AMP.native('export', { name: 'allmyprinters-' + new Date().toISOString().slice(0, 10) + '.json', text: x.text }); if (r && r.ok) toast(t('amp_saved')); } catch (e) { fail(e); }
  };
  d.querySelector('#plre').onclick = async () => { try { const r = await AMP.remote('plan_refresh'); if (r && r.f && r.f.agent !== false) location.reload(); else toast(t('amp_plan_still')); } catch (e) { fail(e); } };
}
if (AMP.agent && AMP.remote) setTimeout(ampPlanLock, 1200);

// ── Passwort im Browser (nur Agent, 18.11.2026): agent/src/auth.js. AMP_PASSWORD fest → nur Hinweis; als HA-App keine Karte ──────
async function ampPwDraw() {
  const box = $('#spw'); if (!box) return;
  let s;
  try { s = await AMP.remote('auth_status'); } catch (e) { box.hidden = true; return; }
  if (s.ingress) { box.hidden = true; return; }
  const forgot = s.win ? t('amp_pw_forgot_win', { f: s.file }) : t('amp_pw_forgot_docker');
  box.innerHTML = `<h2>${esc(t('amp_pw_h'))}</h2><p class="hint">${esc(t('amp_pw_p'))}</p>` + (s.env
    ? `<div class="note">${esc(t('amp_pw_env'))}</div>`
    : `<p><b>${esc(t(s.set ? 'amp_pw_on' : 'amp_pw_off'))}</b></p>
      <label class="fld"><span>${esc(t(s.set ? 'amp_pw_change' : 'amp_pw_new'))}</span><input class="in" type="password" id="spwin" autocomplete="new-password" maxlength="200"></label>
      <div class="amp-acts"><button type="button" class="btn" id="spwset">${esc(t('amp_pw_save'))}</button>${s.set ? `<button type="button" class="btn ghost" id="spwoff">${esc(t('amp_pw_remove'))}</button>` : ''}</div>
      <p class="hint">${esc(forgot)}</p>`);
  if (s.env) return;
  $('#spwset').onclick = async () => {
    const v = $('#spwin').value;
    if (v.length < 6) { toast(t('amp_pw_short')); $('#spwin').focus(); return; }
    try { await AMP.remote('auth_set', { pw: v }); toast(t('amp_pw_saved')); } catch (e) { fail(e); }
    ampPwDraw();
  };
  if (s.set) $('#spwoff').onclick = async () => {
    if (!confirm(t('amp_pw_remove_q'))) return;
    try { await AMP.remote('auth_clear'); toast(t('amp_pw_removed')); } catch (e) { fail(e); }
    ampPwDraw();
  };
}

// ── Home Assistant (nur Agent, 16.11.2026): Schlüssel für die Integration ha-allmyprinters ──────────────────────
// Läuft der Agent als Home-Assistant-App, findet HA ihn selbst (Discovery); sonst Adresse + Schlüssel in HA eintragen.
async function ampHaDraw() {
  const box = $('#sha'); if (!box) return;
  let s;
  try { s = await AMP.remote('ha_status'); } catch (e) { box.hidden = true; return; }
  const local = !window.AMP_BASE && !AMP.viaRemote && /^https?:$/.test(location.protocol);
  const addr = local ? `http://${location.hostname}:${s.port}` : '';
  box.innerHTML = `<h2>${esc(t('amp_ha_h'))}</h2><p class="hint">${esc(t('amp_ha_p'))}</p>
      ${s.app ? `<div class="note">${esc(t('amp_ha_app'))}</div>` : ''}
      ${addr ? `<label class="fld"><span>${esc(t('amp_ha_addr'))}</span><input class="in" readonly value="${esc(addr)}"></label>` : ''}
      <label class="fld"><span>${esc(t('amp_ha_key'))}</span><span class="amp-pf-row"><input class="in amp-ha-key" id="shakey" readonly value="${esc(s.token)}" spellcheck="false"><button type="button" class="btn sm" id="shacopy">${esc(t('amp_ha_copy'))}</button></span></label>
      <p class="hint">${esc(t('amp_ha_key_p'))}</p>
      <div class="amp-acts"><button type="button" class="btn" id="shanew">${esc(t('amp_ha_new'))}</button>
        <a class="btn ghost" href="https://github.com/nolimitek/ha-allmyprinters#readme" target="_blank" rel="noopener">${esc(t('amp_ha_howto'))}</a></div>`;
  const key = $('#shakey');
  key.onfocus = () => key.select();
  $('#shacopy').onclick = async () => {
    // http im Heimnetz ist kein „sicherer Kontext“ → navigator.clipboard fehlt; dann markieren + execCommand
    try { await navigator.clipboard.writeText(key.value); } catch (e) { key.focus(); key.select(); try { document.execCommand('copy'); } catch (e2) {} }
    toast(t('amp_ha_copied'));
  };
  $('#shanew').onclick = async () => {
    if (!confirm(t('amp_ha_new_confirm'))) return;
    try { await AMP.remote('ha_new'); } catch (e) { fail(e); }
    ampHaDraw();
  };
}

// ── Geräte koppeln + Zugriff von unterwegs (nur Agent, 11.11.2026) ──────────────────────────────────────────
// Koppeln (QR/Link) geht immer, auch ohne Weiterleiter (App im selben WLAN); „Zugriff von unterwegs“ ist ein eigener Schalter.
// Läuft die Oberfläche in der App (Agent-Modus), steht hier „Diese App vom Agenten trennen“.
let ampRmPoll = null;
async function ampRemoteDraw(pair) {
  const box = $('#sremote');
  clearTimeout(ampRmPoll);
  if (!box) return;
  let s;
  try { s = await AMP.remote('status'); } catch (e) { box.hidden = true; return; }
  const when = ms => new Date(ms).toLocaleString(LANG, { dateStyle: 'medium', timeStyle: 'short', ...HC });
  if (s.locked) { box.innerHTML = `<h2>${esc(t('amp_dev_h'))}</h2><div class="note">${esc(t('amp_rm_locked'))}</div>`; return; }
  const stTxt = s.state === 'online' ? t('amp_rm_online') : s.state === 'error' ? t('amp_rm_err') : t('amp_rm_connecting');
  const now = d => d.via === 'lan' ? t('amp_rm_now_lan') : t('amp_rm_now_relay');
  const devs = s.devices.length ? `<ul class="amp-rm-devs">${s.devices.map(d => `<li><span><b>${esc(d.name)}</b><br><span class="hint">${esc(d.now ? now(d) : d.last ? t('amp_rm_last', { d: when(d.last) }) : t('amp_rm_added', { d: when(d.added) }))}</span></span>
      <button type="button" class="btn sm" data-rmdev="${esc(d.id)}">${esc(t('amp_rm_remove'))}</button></li>`).join('')}</ul>` : `<p class="hint">${esc(t('amp_rm_nodev'))}</p>`;
  box.innerHTML = `<h2>${esc(t('amp_dev_h'))}</h2><p class="hint">${esc(t('amp_dev_p'))}</p>
      <div id="srmqr"></div>
      <div class="amp-acts"><button type="button" class="btn pri" id="srmpair">${esc(t('amp_rm_add'))}</button></div>
      <h3>${esc(t('amp_rm_devs'))}</h3>${devs}
      ${AMP.inApp && AMP.leave ? `<div class="amp-rm-leave"><p class="hint">${esc(t('amp_rm_leave_p'))}</p><button type="button" class="btn" id="srmleave">${esc(t('amp_rm_leave'))}</button></div>` : ''}
      <h3>${esc(t('amp_rm_h'))}</h3><p class="hint">${esc(t('amp_rm_p'))}</p>
      ${s.enabled ? `<p class="amp-rm-st amp-rm-${esc(s.state)}"><i></i>${esc(stTxt)}</p>${AMP.viaRemote && !AMP.inApp ? `<p class="hint">${esc(t('amp_rm_via'))}</p>` : ''}` : ''}
      <div class="amp-acts">${s.enabled ? `<button type="button" class="btn" id="srmoff">${esc(t('amp_rm_off'))}</button>` : `<button type="button" class="btn" id="srmon">${esc(t('amp_rm_on'))}</button>`}</div>`;
  const on = $('#srmon');
  if (on) on.onclick = async () => { on.disabled = true; try { await AMP.remote('enable'); } catch (e) { fail(e); } ampRemoteDraw(); };
  const off = $('#srmoff');
  if (off) off.onclick = async () => {
    if (!confirm(t(AMP.viaRemote && !AMP.inApp ? 'amp_rm_off_confirm_remote' : 'amp_rm_off_confirm'))) return;
    try { await AMP.remote('disable'); } catch (e) { fail(e); }
    ampRemoteDraw();
  };
  const lv = $('#srmleave');
  if (lv) lv.onclick = async () => { if (!confirm(t('amp_rm_leave_confirm'))) return; lv.disabled = true; try { await AMP.leave(); } catch (e) { lv.disabled = false; fail(e); } };
  box.querySelectorAll('[data-rmdev]').forEach(b => b.onclick = async () => {
    if (!confirm(t('amp_rm_remove_confirm'))) return;
    try { await AMP.remote('remove', { id: b.dataset.rmdev }); } catch (e) { fail(e); }
    ampRemoteDraw();
  });
  const pb = $('#srmpair');
  if (pb) pb.onclick = async () => {
    pb.disabled = true;
    try { const r = await AMP.remote('pair'); ampRemoteDraw(Object.assign(r, { n: s.devices.length })); } catch (e) { fail(e); pb.disabled = false; }
  };
  if (pair && pair.exp > Date.now()) {
    const qr = $('#srmqr');
    if (!window.QRCode) await new Promise(ok => { const sc = document.createElement('script'); sc.src = 'vendor/qrcode.min.js'; sc.onload = ok; sc.onerror = ok; document.head.appendChild(sc); });
    qr.innerHTML = `<div class="amp-rm-qr"><div class="qr" id="srmcode"></div><div><p>${esc(t('amp_rm_qr_p'))}</p>
      ${!pair.relay ? `<p class="hint">${esc(t('amp_rm_qr_lan'))}</p>` : ''}
      <div class="amp-pf-row"><input class="in" id="srmlink" readonly value="${esc(pair.url)}"><button type="button" class="btn sm" id="srmcopy">${esc(t('amp_rm_copy'))}</button></div></div></div>`;
    if (window.QRCode) new QRCode($('#srmcode'), { text: pair.url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
    $('#srmlink').onfocus = e => e.target.select();
    $('#srmcopy').onclick = async () => { try { await navigator.clipboard.writeText(pair.url); toast(t('amp_rm_copied')); } catch (e) { $('#srmlink').select(); } };
    if (pb) pb.textContent = t('amp_rm_add_new');
    // Bis das neue Gerät auftaucht (oder der Code abläuft) nachsehen
    ampRmPoll = setTimeout(async function poll() {
      if (!$('#srmqr')) return;
      let x; try { x = await AMP.remote('status'); } catch (e) { x = null; }
      if (x && x.devices.length > pair.n) { toast(t('amp_rm_paired')); ampRemoteDraw(); return; }
      if (Date.now() > pair.exp) { ampRemoteDraw(); return; }
      ampRmPoll = setTimeout(poll, 2500);
    }, 2500);
  } else if (s.enabled && s.state !== 'online') ampRmPoll = setTimeout(() => { if ($('#sremote') && !$('#srmqr .qr')) ampRemoteDraw(); }, 4000);
}

// ── Zurück-Taste (MainActivity fragt hier zuerst) und Rückkehr in die App ──
window.AMP_back = () => {
  if (dlg.open) { dlg.close(); return true; }
  if (cam.full) { const b = view.querySelector('.pcam.amp-full'); if (b) b.classList.remove('amp-full'); cam.full = null; return true; }
  if (window.AMP_moreClose && window.AMP_moreClose()) return true;
  if (sheet.classList.contains('on')) { history.replaceState(null, '', '#' + (lastView === 'overview' ? 'printers' : lastView || 'spools')); closeSheet(); return true; }
  const h = location.hash.slice(1);
  if (h && h !== 'printers') { if (history.length > 1) history.back(); else location.hash = 'printers'; return true; }
  return false;
};
AMP.on('resume', () => { if (!dlg.open && (location.hash === '' || location.hash === '#printers')) render(); });
// Darstellung „System“: Handy auf hell/dunkel umgeschaltet (MainActivity → night) oder zurück aus dem Hintergrund
AMP.on('night', () => { if (AMP_THEME.mode === 'system') AMP_THEME.apply(); });
AMP.on('resume', () => { if (AMP_THEME.mode === 'system') AMP_THEME.apply(); });

// ── Live-Bild als echter Livestream (ersetzt camBlock/camTick/camDrop von /filament) ─────────────────────────
// Das Video-/Bildelement je Drucker bleibt bestehen, auch wenn die Druckerkarte alle 10 s neu gezeichnet wird
// (camReattach direkt nach dem Neuzeichnen, im selben Takt → <video> pausiert nicht). H.264/FLV über flv.js (MSE),
// MJPEG direkt im <img>, Kameras ohne Stream: Einzelbilder über den Android-Teil (/cam/frame), so schnell sie kommen.
Object.assign(cam, { el: {}, src: {}, idx: {}, player: {}, starting: new Set(), full: null, live: {}, lastT: {} });
const camLive = u => (window.AMP_BASE || '') + '/cam/live?u=' + encodeURIComponent(u);   // AMP_BASE: Agent in der HA-Seitenleiste (Ingress)
let camN = 0;
function camBlock(p) {
  const pid = esc(p.id);
  // 18.11.2026 (User: „Button Live-Bild dominanter, dass man das besser sieht zum Einschalten“): großer Knopf statt „btn sm“
  if (!cam.open.has(p.id)) return `<div class="pcam-bar"><button type="button" class="btn amp-camon" data-act="cam" data-pid="${pid}"><span class="amp-camdot" aria-hidden="true"></span>${I_CAM}<span>${esc(t('amp_cam_on'))}</span></button></div>`;
  const s = cam.src[p.id], on = cam.live[p.id];
  return `<div class="pcam${cam.full === p.id ? ' amp-full' : ''}" data-cam="${pid}"><div class="pcam-img" data-camslot="${pid}" title="${esc(t('amp_cam_full'))}">
      ${on ? '' : `<span class="pcam-wait">${esc(cam.msg[p.id] || t('cam_wait'))}</span>`}${on ? '<span class="pcam-live">LIVE</span>' : ''}</div>
    <div class="pcam-f"><span class="hint pcam-st">${esc(on ? t('amp_cam_note') + (s ? ' · ' + (s.kind === 'flv' ? 'H.264' : s.kind === 'mjpeg' ? 'MJPEG' : t('amp_cam_frames')) : '') : '')}</span>
      <button type="button" class="btn sm ghost" data-act="cam" data-pid="${pid}">${esc(t('cam_hide'))}</button></div></div>`;
}
/** Nach jedem Neuzeichnen: bestehende Stream-Elemente in ihre Plätze zurück. */
function camReattach() {
  view.querySelectorAll('[data-camslot]').forEach(slot => {
    const pid = slot.dataset.camslot, el = cam.el[pid];
    if (!el) return;
    slot.prepend(el);
    if (el.tagName === 'VIDEO' && el.paused) el.play().catch(() => {});
  });
}
function camDrop(pid) {
  const pl = cam.player[pid];
  if (pl) { try { pl.pause(); pl.unload(); pl.detachMediaElement(); pl.destroy(); } catch (e) {} }
  const el = cam.el[pid];
  if (el) { if (el.tagName === 'IMG') el.src = ''; el.remove(); }
  if (cam.src[pid] && cam.src[pid].kind !== 'flv') AMP.native('cam_stop', { key: pid }).catch(() => {});
  if (cam.src[pid] && /:\d+\/video$/.test(cam.src[pid].url || '')) AMP.api('amp_cam_off', { printer: pid }).catch(() => {});   // Elegoo: Kamera am Drucker aus
  if (cam.reconnect) delete cam.reconnect[pid];
  delete cam.player[pid]; delete cam.el[pid]; delete cam.src[pid]; delete cam.msg[pid]; delete cam.live[pid]; delete cam.lastT[pid];
  if (cam.full === pid) cam.full = null;
}
function camRedraw() { if (!dlg.open && view.querySelector('[data-cam]')) drawPrinters(); }
function camSetLive(pid) { if (!cam.live[pid]) { cam.live[pid] = true; delete cam.msg[pid]; camRedraw(); } }
/** Nächste Quelle versuchen (Fehler oder kein Bild in 10 s). */
function camNext(pid) {
  // Grund fürs Protokoll merken (Cam.kt liest MJPEG/Einzelbilder; z. B. „not in home network“, HTTP 404, Zeitüberschreitung)
  const cur = cam.src[pid];
  if (cur && (cur.kind === 'mjpeg' || cur.kind === 'snap') && !cur.why) AMP.native('cam_status', { key: pid }).then(st => { cur.why = String((st && st.err) || 'no_frame'); }).catch(() => {});
  else if (cur && !cur.why) cur.why = 'no_frame';
  const keep = cam.src[pid] ? cam.idx[pid] : -1;
  const list = cam.srcs && cam.srcs[pid] || [];
  camDrop(pid);
  if (!cam.open.has(pid)) return;
  cam.idx[pid] = keep + 1;
  camPlay(pid, list);
}
// Abbrüche heilen sich selbst: Strom weg → dieselbe Quelle sofort neu (Bild bleibt stehen, unten „verbinde neu …“);
// erst wenn eine Quelle nie ein Bild geliefert hat oder 3× hintereinander ohne Bild scheitert, kommt die nächste dran.
function camStatus(pid, txt) {
  const box = view.querySelector(`[data-cam="${CSS.escape(pid)}"] .pcam-st`);
  if (box) box.textContent = txt || '';
}
function camNote(pid) {
  const s = cam.src[pid];
  return t('amp_cam_note') + (s ? ' · ' + (s.kind === 'flv' ? 'H.264' : s.kind === 'webrtc' ? 'WebRTC' : s.kind === 'mjpeg' ? 'MJPEG' : t('amp_cam_frames')) : '');
}
function camPlay(pid, list) {
  (cam.srcs = cam.srcs || {})[pid] = list;
  const s = list[cam.idx[pid] || 0];
  if (!s) {
    cam.msg[pid] = t('cam_none'); cam.live[pid] = false; camRedraw();
    // Quellen gefunden, aber keine lieferte ein Bild → ins Protokoll (09.11.2026: KX-Bridge mit „.local“ — gefunden, nie ein Bild, nichts protokolliert)
    if (list.length) setTimeout(() => AMP.api('amp_cam_fail', { printer: pid, list: list.map(x => ({ kind: x.kind, url: x.url, why: x.why || '' })) }).catch(() => {}), 800);
    return;
  }
  cam.src[pid] = s;
  cam.fails = cam.fails || {}; cam.fails[pid] = 0;
  let ever = false;   // diese Quelle hat schon ein Bild geliefert
  const giveUp = setTimeout(() => { if (cam.src[pid] === s && !ever) camNext(pid); }, 12000);
  const good = () => { ever = true; cam.fails[pid] = 0; clearTimeout(giveUp); camSetLive(pid); };
  const broke = () => {   // false = aufgeben (nächste Quelle)
    cam.fails[pid] = (cam.fails[pid] || 0) + 1;
    if (!ever || cam.fails[pid] > 3) { clearTimeout(giveUp); camNext(pid); return false; }
    camStatus(pid, t('amp_cam_reconnect'));
    return true;
  };
  if (s.kind === 'flv' && window.flvjs && flvjs.isSupported()) {
    const v = document.createElement('video');
    v.muted = true; v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.disablePictureInPicture = true;
    cam.el[pid] = v;
    const connect = () => {
      const old = cam.player[pid];
      if (old) { try { old.pause(); old.unload(); old.detachMediaElement(); old.destroy(); } catch (e) {} }
      if (cam.el[pid] !== v) return;
      const pl = flvjs.createPlayer({ type: 'flv', isLive: true, hasAudio: false, url: location.origin + camLive(s.url) },
        { enableStashBuffer: false, enableWorker: false, lazyLoad: false, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 10 });
      pl.attachMediaElement(v);
      pl.on(flvjs.Events.ERROR, () => { if (cam.player[pid] === pl && broke()) setTimeout(connect, 600); });
      pl.load(); v.play().catch(() => {});
      cam.player[pid] = pl;
      cam.lastT[pid] = { t: -1, at: Date.now() };
    };
    v.addEventListener('playing', () => { good(); camStatus(pid, camNote(pid)); });
    v.addEventListener('ended', () => { if (cam.el[pid] === v && broke()) setTimeout(connect, 600); });
    cam.reconnect = cam.reconnect || {}; cam.reconnect[pid] = () => { if (broke()) connect(); };
    connect();
  } else if (s.kind === 'webrtc' && window.RTCPeerConnection) {
    // Creality (K1C/K1 Max neu, K2, Hi): WebRTC direkt mit dem Drucker. Angebot/Antwort laufen über die App (backend amp_webrtc →
    // POST :8000/call/webrtc_local, base64-JSON), das Bild selbst kommt per UDP aus dem Heimnetz. Ohne Trickle-ICE: erst alle Kandidaten.
    const v = document.createElement('video');
    v.muted = true; v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.disablePictureInPicture = true;
    cam.el[pid] = v;
    const pc = new RTCPeerConnection({ iceServers: [] });
    cam.player[pid] = { pause() {}, unload() {}, detachMediaElement() {}, destroy() { try { pc.close(); } catch (e) {} } };
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = e => { if (cam.el[pid] !== v) return; v.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]); v.play().catch(() => {}); };
    pc.onconnectionstatechange = () => { if (cam.el[pid] === v && pc.connectionState === 'failed') { clearTimeout(giveUp); camNext(pid); } };
    v.addEventListener('playing', () => { good(); camStatus(pid, camNote(pid)); });
    (async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise(z => { if (pc.iceGatheringState === 'complete') return z(); const tm = setTimeout(z, 3000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(tm); z(); } }); });
        const ans = await api('amp_webrtc', { printer: pid, url: s.url, sdp: pc.localDescription.sdp });
        if (cam.el[pid] === v) await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp });
      } catch (e) { if (cam.el[pid] === v) { clearTimeout(giveUp); camNext(pid); } }
    })();
  } else if (s.kind === 'mjpeg' || s.kind === 'snap') {
    // MJPEG und Einzelbilder: der Android-Teil (Cam.kt) liest die Kamera, zerlegt den Strom in Bilder und verbindet selbst neu,
    // wenn er abbricht. Hier immer das nächste neue Bild holen, erst laden, dann tauschen (kein Flackern).
    const img = new Image();
    img.alt = t('cam_alt', { n: pid });
    cam.el[pid] = img;
    const loop = async () => {
      let prev = null, miss = 0;
      while (cam.el[pid] === img) {
        try {
          const r = await fetch((window.AMP_BASE || '') + '/cam/frame?k=' + encodeURIComponent(pid) + '&n=' + (++camN), { cache: 'no-store' });
          if (r.status !== 200) {
            // 204 = 2,5 s kein neues Bild: Strom weg, Cam.kt verbindet neu — Hinweis zeigen, nach ~30 s ohne Bild aufgeben
            if (++miss === 1 && ever) camStatus(pid, t('amp_cam_reconnect'));
            if (miss > 12 && !broke()) break;
            await new Promise(z => setTimeout(z, 300));
            continue;
          }
          const u = URL.createObjectURL(await r.blob());
          await new Promise(z => { img.onload = z; img.onerror = z; img.src = u; });
          if (prev) URL.revokeObjectURL(prev);
          prev = u;
          if (miss || !ever) { miss = 0; good(); camStatus(pid, camNote(pid)); }
        } catch (e) { await new Promise(z => setTimeout(z, 800)); }
      }
      if (prev) URL.revokeObjectURL(prev);
    };
    AMP.native('cam', { key: pid, urls: [s.url] }).then(loop).catch(() => camNext(pid));
  } else { clearTimeout(giveUp); camNext(pid); return; }
  camRedraw();
}
async function camStart(pid) {
  if (cam.starting.has(pid) || cam.el[pid]) return;
  cam.starting.add(pid);
  try {
    const d = await api('amp_cam', { printer: pid });
    if (!cam.open.has(pid)) return;
    cam.idx[pid] = 0;
    camPlay(pid, d.sources || []);
  } catch (e) { cam.msg[pid] = t('cam_none'); camRedraw(); }
  finally { cam.starting.delete(pid); }
}
async function camTick() {
  if (!cam.timer) cam.timer = setInterval(camTick, 2000);
  // Ansicht verlassen oder Karte zugeklappt: Stream beenden (Verbindung zur Kamera geht zu)
  for (const pid of [...cam.open]) if (!view.querySelector(`[data-cam="${CSS.escape(pid)}"]`) && !view.querySelector(`[data-act="cam"][data-pid="${CSS.escape(pid)}"]`)) { cam.open.delete(pid); camDrop(pid); }
  for (const pid of Object.keys(cam.el)) if (!cam.open.has(pid)) camDrop(pid);
  if (!cam.open.size) { clearInterval(cam.timer); cam.timer = null; return; }
  if (camAwayAt) return;   // im Hintergrund nichts (neu) starten — camBack übernimmt
  for (const pid of cam.open) {
    if (!cam.el[pid] && !cam.starting.has(pid) && !cam.msg[pid]) camStart(pid);
    const v = cam.el[pid];
    if (v && v.tagName === 'VIDEO' && cam.live[pid]) {
      // Livestream bleibt live: Rückstand über 1,5 s → nach vorn springen; steht das Bild 8 s → neu verbinden
      const b = v.buffered, end = b.length ? b.end(b.length - 1) : 0;
      if (end - v.currentTime > 1.5) v.currentTime = Math.max(0, end - 0.3);
      const last = cam.lastT[pid] || { t: -1, at: Date.now() };
      if (v.currentTime !== last.t) cam.lastT[pid] = { t: v.currentTime, at: Date.now() };
      else if (!document.hidden && Date.now() - last.at > 6000 && cam.reconnect && cam.reconnect[pid]) { cam.lastT[pid] = { t: -1, at: Date.now() }; cam.reconnect[pid](); }
    }
  }
}
// Antippen: Vollbild an/aus
document.addEventListener('click', e => {
  const im = e.target.closest('.pcam-img');
  if (!im) return;
  const pid = im.dataset.camslot;
  cam.full = cam.full === pid ? null : pid;
  const box = im.closest('.pcam'); if (box) box.classList.toggle('amp-full', cam.full === pid);
});
// App im Hintergrund (10.11.2026, User: „Standbild beim Video, muss den Stream schließen und neu öffnen“): Android bzw. der Drucker
// trennt die Kamera, und ein bloßes Neuverbinden reicht nicht — Anycubic braucht wieder startCapture. Darum: nach 5 s im Hintergrund
// Kamera freigeben (Akku, Daten, der eine Zuschauerplatz am Drucker), zurück im Vordergrund neu starten wie Schließen + Öffnen.
// Kürzer weg (Benachrichtigungen, kurzer App-Wechsel): Bild läuft einfach weiter. pause/resume kommen aus MainActivity, dazu visibilitychange.
let camAwayAt = 0, camAwayT = null;
function camAway() {
  if (camAwayAt) return;
  camAwayAt = Date.now();
  camAwayT = setTimeout(() => { camAwayT = null; Object.keys(cam.el).forEach(camDrop); }, 5000);
}
function camBack() {
  if (!camAwayAt) return;
  const away = Date.now() - camAwayAt;
  camAwayAt = 0; clearTimeout(camAwayT); camAwayT = null;
  // Zeitgeber im Hintergrund eingefroren? Dann zählt die Zeit weg, nicht ob er schon lief
  if (away >= 5000) {
    [...cam.open].forEach(camDrop);
    if (cam.open.size) { camRedraw(); camTick(); }
    return;
  }
  Object.values(cam.el).forEach(v => { if (v.tagName === 'VIDEO') v.play().catch(() => {}); });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) camAway(); else camBack(); });
AMP.on('pause', camAway);
AMP.on('resume', camBack);

// ── QR-Scanner oben in der Kopfleiste (wie /filament auf dem Handy; dort steckt er auch nicht in der Werkzeugleiste) ─────
{ const sc = document.getElementById('fmScan'); if (sc) sc.addEventListener('click', () => openScanner()); }

// ── Etiketten: /filament label.php in der App (Daten aus dem Handy, Vorlage im Handy, Druck über Androids Druckdienst) ──
const lab = { ids: [] };
/** Ersetzt window.open('label.php?ids=…') von /filament. */
function ampLabels(ids) { lab.ids = (ids || []).map(Number).filter(Boolean); location.hash = 'labels'; }
async function viewLabels() {
  const S = FM.S, g_ = navGen;
  view.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
  if (!window.QRCode) await new Promise(ok => { const sc = document.createElement('script'); sc.src = 'vendor/qrcode.min.js'; sc.onload = ok; sc.onerror = ok; document.head.appendChild(sc); });
  const all = ((await api('spools').catch(() => ({}))).spools || []);
  if (g_ !== navGen) return;
  const chosen = lab.ids.length ? all.filter(s => lab.ids.includes(s.id)) : all.filter(s => !s.archived);
  const SPOOLS = chosen.map(s => ({ id: s.id, brand: s.brand || '', material: s.material, color_name: s.color_name || '', color: s.color || '#888888', net: s.total,
    lot: s.lot_nr || '', location: s.location || '', temps: s.extruder_temp ? s.extruder_temp + ' °C / ' + (s.bed_temp || 0) + ' °C' : '' }));
  const PAPER = { a4: [210, 297], letter: [215.9, 279.4] };
  const PRESETS = {
    roll_50x30: { name: S.lbl_p_roll + ' 50 × 30 mm', mode: 'roll', w: 50, h: 30 },
    roll_62x29: { name: S.lbl_p_roll + ' 62 × 29 mm (Brother DK-11209)', mode: 'roll', w: 62, h: 29 },
    roll_40x30: { name: S.lbl_p_roll + ' 40 × 30 mm', mode: 'roll', w: 40, h: 30 },
    a4_3475: { name: 'A4 · 70 × 36 mm · 3 × 8 (Avery Zweckform 3475)', mode: 'sheet', paper: 'a4', w: 70, h: 36, cols: 3, rows: 8, mt: 4.5, ml: 0, gx: 0, gy: 0 },
    a4_l7160: { name: 'A4 · 63,5 × 38,1 mm · 3 × 7 (Avery L7160)', mode: 'sheet', paper: 'a4', w: 63.5, h: 38.1, cols: 3, rows: 7, mt: 15.15, ml: 7.21, gx: 2.54, gy: 0 },
    a4_3657: { name: 'A4 · 48,5 × 25,4 mm · 4 × 10 (Avery Zweckform 3657)', mode: 'sheet', paper: 'a4', w: 48.5, h: 25.4, cols: 4, rows: 10, mt: 21.5, ml: 8, gx: 0, gy: 0 },
    letter_5160: { name: 'Letter · 66,7 × 25,4 mm · 3 × 10 (Avery 5160)', mode: 'sheet', paper: 'letter', w: 66.675, h: 25.4, cols: 3, rows: 10, mt: 12.7, ml: 4.76, gx: 3.175, gy: 0 },
    custom: { name: S.lbl_p_custom },
  };
  const FIELDS = [['qr', S.lbl_f_qr], ['brand', S.lbl_f_brand], ['material', S.lbl_f_material], ['color', S.lbl_f_color], ['temps', S.lbl_f_temps],
                  ['net', S.lbl_f_net], ['lot', S.lbl_f_lot], ['location', S.lbl_f_location], ['id', S.lbl_f_id]];
  const DEF = { preset: 'roll_50x30', mode: 'roll', paper: 'a4', w: 50, h: 30, cols: 3, rows: 8, mt: 10, ml: 10, gx: 2, gy: 2, fields: ['qr', 'brand', 'material', 'color', 'temps', 'id'] };
  let saved = null; try { saved = JSON.parse(localStorage.getItem('amp_label') || 'null'); } catch (e) {}
  const cfg = Object.assign({}, DEF, saved || {});
  const NUMS = ['w', 'h', 'cols', 'rows', 'mt', 'ml', 'gx', 'gy'];
  NUMS.forEach(k => { const n = Number(cfg[k]); cfg[k] = isFinite(n) ? n : DEF[k]; });
  if (!Array.isArray(cfg.fields)) cfg.fields = DEF.fields;
  const num = (id, lbl, attrs) => `<label class="fld"><span>${esc(lbl)}</span><input class="in num" id="lb_${id}" type="number" ${attrs}></label>`;
  view.innerHTML = `<div class="amp-lw">
    <aside class="amp-lw-side" id="lbside">
      <div class="amp-lw-top"><button type="button" class="btn sm ghost" id="lbback">← ${esc(t('tab_spools'))}</button><h1>${esc(S.lbl_title)}</h1></div>
      <label class="fld"><span>${esc(S.lbl_preset)}</span><select class="in" id="lb_preset">${Object.keys(PRESETS).map(k => `<option value="${k}">${esc(PRESETS[k].name)}</option>`).join('')}</select></label>
      <div class="amp-lw-g2"><label class="fld"><span>${esc(S.lbl_mode)}</span><select class="in" id="lb_mode"><option value="roll">${esc(S.lbl_mode_roll)}</option><option value="sheet">${esc(S.lbl_mode_sheet)}</option></select></label>
        <label class="fld" data-sheet><span>${esc(S.lbl_paper)}</span><select class="in" id="lb_paper"><option value="a4">A4</option><option value="letter">Letter</option></select></label></div>
      <div class="amp-lw-g2">${num('w', S.lbl_w, 'min="15" max="200" step="0.1"')}${num('h', S.lbl_h, 'min="10" max="200" step="0.1"')}</div>
      <div class="amp-lw-g2" data-sheet>${num('cols', S.lbl_cols, 'min="1" max="10"')}${num('rows', S.lbl_rows, 'min="1" max="30"')}</div>
      <div class="amp-lw-g2" data-sheet>${num('mt', S.lbl_mt, 'min="0" max="60" step="0.01"')}${num('ml', S.lbl_ml, 'min="0" max="60" step="0.01"')}</div>
      <div class="amp-lw-g2" data-sheet>${num('gx', S.lbl_gx, 'min="0" max="30" step="0.01"')}${num('gy', S.lbl_gy, 'min="0" max="30" step="0.01"')}</div>
      <label class="fld" data-sheet><span>${esc(S.lbl_skip)}</span><input class="in num" id="lb_skip" type="number" min="0" max="300" value="0"><span class="hint">${esc(S.lbl_skip_hint)}</span></label>
      <div class="fld"><span>${esc(S.lbl_content)}</span><div class="amp-lw-flds">${FIELDS.map(f => `<label><input type="checkbox" value="${f[0]}"> ${esc(f[1])}</label>`).join('')}</div></div>
      <div class="amp-row"><button class="btn pri" id="lbprint">${esc(S.lbl_print)}</button><button class="btn" id="lbsave">${esc(S.lbl_save)}</button></div>
      <span class="hint" id="lbsaved"></span><p class="hint">${esc(S.lbl_print_hint)}</p>
    </aside>
    <div class="amp-lw-prev"><div class="hint amp-lw-info" id="lbinfo"></div><div id="lbpages"></div></div></div>`;
  // Klasse für @media print (nur die Etiketten drucken), beim Verlassen der Ansicht wieder weg
  document.body.classList.add('amp-lbl');
  window.addEventListener('hashchange', function off() { if (location.hash !== '#labels') { document.body.classList.remove('amp-lbl'); window.removeEventListener('hashchange', off); } });
  let ps = document.getElementById('amppagestyle'); if (!ps) { ps = document.createElement('style'); ps.id = 'amppagestyle'; document.head.appendChild(ps); }
  const $l = id => document.getElementById('lb_' + id);
  const toForm = () => {
    $l('preset').value = PRESETS[cfg.preset] ? cfg.preset : 'custom'; $l('mode').value = cfg.mode; $l('paper').value = cfg.paper;
    NUMS.forEach(k => { $l(k).value = cfg[k]; });
    view.querySelectorAll('.amp-lw-flds input').forEach(c => { c.checked = cfg.fields.includes(c.value); });
  };
  const fromForm = () => {
    cfg.mode = $l('mode').value; cfg.paper = $l('paper').value;
    NUMS.forEach(k => { const v = parseFloat($l(k).value); if (!isNaN(v)) cfg[k] = v; });
    cfg.fields = [...view.querySelectorAll('.amp-lw-flds input:checked')].map(c => c.value);
  };
  const labelHtml = s => {
    const has = k => cfg.fields.includes(k), lines = [];
    if (has('brand') && s.brand) lines.push(`<span class="b">${esc(s.brand)}</span>`);
    if (has('material')) lines.push(`<span class="m">${esc(s.material)}</span>`);
    if (has('color')) lines.push(`<span class="c"><i style="background:${esc(s.color)}"></i><span class="cn">${esc(s.color_name)}</span></span>`);
    if (has('temps') && s.temps) lines.push(`<span>${esc(s.temps)}</span>`);
    if (has('net') && s.net) lines.push(`<span>${esc(s.net >= 1000 ? (s.net / 1000).toLocaleString() + ' kg' : s.net + ' g')}</span>`);
    if (has('location') && s.location) lines.push(`<span>${esc(s.location)}</span>`);
    const foot = [has('id') ? '#' + s.id : '', has('lot') && s.lot ? s.lot : ''].filter(Boolean).join(' · ');
    if (foot) lines.push(`<span class="id">${esc(foot)}</span>`);
    const q = has('qr') ? Math.max(8, Math.min(cfg.h - 3.2, cfg.w * 0.55)) : 0;
    // QR → https://allmyprinters.com/s/<Nummer>; der Scanner der App öffnet damit die Spule
    return (q ? `<div class="qr" data-url="https://allmyprinters.com/s/${s.id}" style="width:${q}mm;height:${q}mm"></div>` : '') + `<div class="tx">${lines.join('')}</div>`;
  };
  const fit = () => {
    const box = view.querySelector('.amp-lw-prev'), pg = document.getElementById('lbpages'); if (!box || !pg) return;
    pg.style.transform = ''; pg.style.width = '';
    const first = pg.firstElementChild; if (!first || first.tagName === 'P') return;
    let k = Math.min(1, (box.clientWidth - 24) / first.offsetWidth);
    if (cfg.mode === 'roll') k = Math.min(2.5, (box.clientWidth - 24) / (first.offsetWidth * 2 + 18));
    pg.style.transform = 'scale(' + k + ')'; pg.style.width = (100 / k) + '%';
  };
  const render = () => {
    fromForm();
    view.querySelectorAll('[data-sheet]').forEach(el => { el.hidden = cfg.mode !== 'sheet'; });
    const W = cfg.w, H = cfg.h, fs = Math.max(1.9, Math.min(4.2, H * 0.085));
    const cell = s => `<div class="lbl${s ? '' : ' blank'}" style="width:${W}mm;height:${H}mm;--fs:${fs}mm">${s ? labelHtml(s) : ''}</div>`;
    let html = '', pages = 0;
    if (cfg.mode === 'roll') {
      ps.textContent = `@page { size: ${W}mm ${H}mm; margin: 0; }`;
      SPOOLS.forEach(s => { html += `<div class="pg" style="width:${W}mm;height:${H}mm">${cell(s)}</div>`; });
      pages = SPOOLS.length;
    } else {
      const P = PAPER[cfg.paper] || PAPER.a4, per = Math.max(1, cfg.cols * cfg.rows), skip = Math.max(0, parseInt($l('skip').value, 10) || 0) % per;
      ps.textContent = `@page { size: ${cfg.paper === 'letter' ? 'letter' : 'A4'}; margin: 0; }`;
      const list = new Array(skip).fill(null).concat(SPOOLS);
      for (let i = 0; i < list.length; i += per) {
        const chunk = list.slice(i, i + per); while (chunk.length < per) chunk.push(null);
        html += `<div class="pg" style="width:${P[0]}mm;height:${P[1]}mm"><div class="lsheet" style="padding:${cfg.mt}mm 0 0 ${cfg.ml}mm;grid-template-columns:repeat(${cfg.cols},${W}mm);grid-auto-rows:${H}mm;column-gap:${cfg.gx}mm;row-gap:${cfg.gy}mm">${chunk.map(cell).join('')}</div></div>`;
        pages++;
      }
      const usedW = cfg.ml + cfg.cols * W + (cfg.cols - 1) * cfg.gx, usedH = cfg.mt + cfg.rows * H + (cfg.rows - 1) * cfg.gy;
      if (usedW > P[0] + 0.5 || usedH > P[1] + 0.5) html = `<p class="err-t">${esc(S.lbl_too_big)}</p>` + html;
    }
    document.getElementById('lbpages').innerHTML = html;
    document.getElementById('lbinfo').textContent = String(S.lbl_info || '').replace('{n}', SPOOLS.length).replace('{p}', pages);
    if (window.QRCode) view.querySelectorAll('#lbpages .qr').forEach(el => { new QRCode(el, { text: el.dataset.url, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M }); });
    view.querySelectorAll('#lbpages .lbl .tx').forEach(tx => {   // lange Farbnamen und volle Etiketten verkleinern (wie label.php)
      const c = tx.querySelector('.c'), cn = tx.querySelector('.cn'); let cf = 1, f = fs;
      while (cn && cn.scrollHeight > cn.clientHeight + 1 && cf > 0.7) { cf -= 0.05; c.style.fontSize = cf + 'em'; }
      const over = () => tx.scrollHeight > tx.clientHeight + 1 || [...tx.querySelectorAll('.tx > span:not(.c)')].some(el => el.scrollWidth > el.clientWidth + 1);
      while (over() && f > 1.4) { f -= 0.15; tx.style.fontSize = f + 'mm'; }
    });
    fit();
  };
  $l('preset').addEventListener('change', function () {
    const p = PRESETS[this.value]; cfg.preset = this.value;
    if (p && this.value !== 'custom') { ['mode', 'paper', 'w', 'h', 'cols', 'rows', 'mt', 'ml', 'gx', 'gy'].forEach(k => { if (p[k] !== undefined) cfg[k] = p[k]; }); toForm(); }
    render();
  });
  view.querySelectorAll('#lbside input, #lb_mode, #lb_paper').forEach(el => el.addEventListener('input', () => {
    if (el.id !== 'lb_skip' && el.type !== 'checkbox') { cfg.preset = 'custom'; $l('preset').value = 'custom'; } render();
  }));
  document.getElementById('lbback').onclick = () => { location.hash = 'spools'; };
  document.getElementById('lbsave').onclick = () => { fromForm(); try { localStorage.setItem('amp_label', JSON.stringify(cfg)); document.getElementById('lbsaved').textContent = S.lbl_saved; } catch (e) {} };
  document.getElementById('lbprint').onclick = async () => {
    // Android-WebView kennt window.print() nicht → Druckdienst über den Android-Teil (druckt diese Ansicht; @media print zeigt nur die Etiketten)
    try { await AMP.native('print', { title: S.lbl_title }); } catch (e) { toast(t('err_generic')); }
  };
  window.addEventListener('resize', fit);
  toForm(); render();
}

// ═══ Design „Klar“ (09.11.2026): Spulen je Fach, Spulenbild, Anleitung je Druckerfamilie, Problem melden ═══

// ── Verbrauchsausgleich (10.11.2026, backend.js adjLearn) ──
const ampPct = f => new Intl.NumberFormat(LANG, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format((f - 1) * 100) + ' %';
/** Einstellungen → Verbrauch: Schalter + gelernter Aufschlag je Drucker (mit Zurücksetzen). */
async function ampAdjDraw() {
  const box = document.getElementById('sadj'); if (!box) return;
  let d; try { d = await api('amp_adj', {}); } catch (e) { return; }
  const rows = d.printers.filter(p => p.f !== null);
  box.innerHTML = `<label class="chk row"><input type="checkbox" id="sadjon"${d.off ? '' : ' checked'}> ${esc(t('amp_adj_on'))}</label>
    ${rows.length ? `<ul class="amp-adj-l">${rows.map(p => `<li><span><b>${esc(p.name)}</b> ${esc(ampPct(p.f))}<br><span class="hint">${esc(t(p.n === 1 ? 'amp_adj_n1' : 'amp_adj_nn', { n: p.n }))}</span></span>
      <button type="button" class="btn sm ghost" data-adjreset="${esc(p.id)}">${esc(t('amp_adj_reset'))}</button></li>`).join('')}</ul>` : `<p class="hint">${esc(t('amp_adj_none'))}</p>`}`;
  box.querySelector('#sadjon').onchange = async e => { await api('settings_save', { k: 'amp_adj_off', v: !e.target.checked }).catch(() => {}); toast(t('amp_saved')); };
  box.querySelectorAll('[data-adjreset]').forEach(b => b.onclick = async () => { await api('amp_adj_reset', { printer: b.dataset.adjreset }).catch(() => {}); ampAdjDraw(); });
}
// Spule auch am Drucker eingetragen (backend.js slotPush, 16.11.2026): kurz bestätigen
document.addEventListener('amp-slot-push', e => { const d = e.detail || {}; if (d.printer) setTimeout(() => toast(t('amp_spush_done', { s: d.slot || '', p: d.printer })), 300); });
// Gelernt (Spule leer gemeldet): kurz sagen, was sich ändert
document.addEventListener('amp-adj', e => {
  const x = (e.detail || [])[0];
  if (x && x.name && Math.abs(x.f - 1) >= 0.001) setTimeout(() => toast(t('amp_adj_toast', { p: x.name, v: ampPct(x.f) })), 400);
});

/** Spulenbild für die Karten: wie spoolFace, mit Rest in Prozent darunter (CSS ordnet die Karte senkrecht an). */
const ampSpool = s => `<span class="amp-sf">${spoolFace(s)}</span>`;

/** Spulen je Fach oben in der Druckerkarte (10.11.2026, vorher Füllstandsröhren): gezeichnete Spule wie auf /filament, nur größer;
 *  Wicklung = Rest der zugeordneten Spule (sonst Meldung des Druckers), die Spule im druckenden Fach dreht sich.
 *  Antippen klappt „Fächer und Spulen“ auf und springt zum Fach. Ein-Spulen-Drucker: keine Reihe. */
const ampSlotsOpen = new Set();
function ampTubes(prov, p) {
  if ((p.slots || []).length < 2) return '';
  const going = p.online && p.busy && !(p.job && p.job.paused);
  // Neue Anordnung (20.11.2026): Kopfzeile „Fächer · ACE“ mit Feuchte bzw. Trocknen — die Box selbst steht unter „Steuern“
  const bx = (p.boxes || []).length === 1 ? p.boxes[0] : null;
  const bxName = bx ? (bx.builtin ? t('box_builtin') : prov === 'moonraker' && bx.label ? bx.label : BOX_NAME[prov] || 'ACE') : '';
  const bxTxt = bx ? (bx.dry ? t('dry_active', { n: bx.dry.target }) : bx.humidity != null ? t('box_hum', { n: bx.humidity }) : '') : '';
  const head = `<div class="amp-tubes-h"><b>${esc(t('amp_tubes_h') + (bxName ? ' · ' + bxName : ''))}</b>${bxTxt ? `<span class="${bx && bx.dry ? 'amp-dry' : bx && bx.humidity >= 40 ? 'warn-t' : ''}">${esc(bxTxt)}</span>` : ''}</div>`;
  return head + `<div class="amp-tubes" role="list">${p.slots.map(sl => {
    const label = sl.label ?? String(sl.index + 1), sp = sl.spool_id ? st.spools.find(x => x.id === sl.spool_id) : null;
    const empty = !sp && (!sl.material || !sl.color) && !sl.unknown;
    const pct = sp ? Math.max(0, Math.min(100, +sp.pct || 0)) : sl.remain_pct != null ? Math.max(0, Math.min(100, +sl.remain_pct)) : empty ? 0 : 100;
    const low = sp && !sp.archived && isLow(sp), crit = low && isCrit(sp);
    const val = empty ? t('amp_tube_empty') : sp ? g(sp.left) : sl.material || '';
    const face = empty ? '+' : spoolFace(sp || { color: sl.color || '#888888', pct });
    const mat = empty ? t('amp_tube_empty') : sl.material || (sp && sp.material) || '?';
    const stx = empty ? '' : sl.inuse && going ? t('amp_tube_run') : sp ? (low ? t('amp_tube_low', { g: g(sp.left) }) : g(sp.left)) : sl.locked ? '' : t('amp_tube_assign');
    const scls = sl.inuse && going ? ' run' : !empty && !sp && !sl.locked ? ' asg' : '';
    // Kachel (24.11.2026): Marke · Farbe der Spule und ein Restbalken (am Handy blendet CSS die Zeile aus)
    const sub = sp ? [ampBrand(sp.brand), sp.color_name].filter(Boolean).join(' · ') : '';
    return `<button type="button" role="listitem" class="amp-tube${empty ? ' amp-te' : ''}${sl.inuse ? ' inuse' : ''}${sl.inuse && going ? ' run' : ''}${low ? ' low' : ''}${crit ? ' crit' : ''}" data-tube="${esc(String(sl.slot_id))}" data-pid="${esc(p.id)}"
      aria-label="${esc(t('amp_tube_open', { s: label }) + ' · ' + (sl.material || '') + ' · ' + val)}"><span class="amp-tube-g">${face}</span>
      <span class="amp-tube-l">${esc(label === 'Ext' ? t('slot_ext') : label)}</span><b class="amp-tube-v">${esc(mat)}</b>${sub ? `<span class="amp-tube-b">${esc(sub)}</span>` : ''}${empty ? '' : `<span class="amp-tube-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>`}${stx ? `<span class="amp-tube-s${scls}">${esc(stx)}</span>` : ''}</button>`;
  }).join('')}</div>`;
}
/** Fachkarten (zum Zuordnen) unter den Spulen zum Aufklappen; offen, wenn etwas zu tun ist oder der Nutzer sie offen ließ. */
// Von Hand zugeklappt (10.11.2026, Denny: „klappt nach ein paar Sekunden wieder auf“ — jedes Neuzeichnen öffnete ihn, solange ein
// Fach etwas braucht): bleibt zu, auch nach App-Neustart, bis MEHR Fächer etwas brauchen als beim Zuklappen.
const ampSlotsShut = (() => { try { return JSON.parse(localStorage.getItem('amp_slots_shut') || '{}') || {}; } catch (e) { return {}; } })();
const ampShutSave = () => { try { localStorage.setItem('amp_slots_shut', JSON.stringify(ampSlotsShut)); } catch (e) {} };
function ampSlotsWrap(p, inner) {
  if ((p.slots || []).length < 2) return inner;
  const need = (inner.match(/class="slot needs|slot-out/g) || []).length;
  if (p.id in ampSlotsShut) {
    if (need > ampSlotsShut[p.id]) { delete ampSlotsShut[p.id]; ampShutSave(); }          // neues Fach braucht etwas → wieder auf
    else if (need < ampSlotsShut[p.id]) { ampSlotsShut[p.id] = need; ampShutSave(); }     // weniger zu tun → Maßstab mitnehmen
  }
  const open = ampSlotsOpen.has(p.id);   // Neue Anordnung (20.11.2026): Fächer stehen oben als Spulen, die Liste nur auf Wunsch
  return `<details class="amp-slots" data-pid="${esc(p.id)}" data-need="${need}"${open ? ' open' : ''}><summary>${esc(t('amp_slots_h'))}</summary>${inner}</details>`;
}
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches || !d.matches('details.amp-slots')) return;
  const pid = d.dataset.pid;
  if (d.open) { ampSlotsOpen.add(pid); if (pid in ampSlotsShut) { delete ampSlotsShut[pid]; ampShutSave(); } }
  else { ampSlotsOpen.delete(pid); ampSlotsShut[pid] = +d.dataset.need || 0; ampShutSave(); }
}, true);
document.addEventListener('click', e => {
  const tb = e.target.closest('[data-tube]');
  if (tb) {
    const card = tb.closest('.pcard'), d = card && card.querySelector('details.amp-slots');
    if (d) { d.open = true; ampSlotsOpen.add(d.dataset.pid); }
    const at = card && card.querySelector(`[data-slot="${CSS.escape(tb.dataset.tube)}"]`);
    const slot = at && at.closest('.slot');
    // Neue Anordnung (20.11.2026, „Tippen = zuweisen“): Fach ohne Spule → gleich der Zuordnen-Dialog
    const asg = tb.querySelector('.amp-tube-s.asg') && slot && slot.querySelector('[data-act="assign"]');
    if (asg) { asg.click(); return; }
    if (slot) { slot.scrollIntoView({ behavior: 'smooth', block: 'center' }); slot.classList.add('amp-flash'); setTimeout(() => slot.classList.remove('amp-flash'), 1400); }
    return;
  }
  const rp = e.target.closest('[data-report]');
  if (rp) { e.preventDefault(); if (window.AMP_moreClose) window.AMP_moreClose(); ampReport(rp.dataset.report || ''); }
});

// ── Kalibrieren vor dem Druck (21.11.2026, User: „Vibrationstest vor dem Druck … mit Flusskalibrierung“) ──────────
// Häkchen „Vibrationsausgleich“ / „Flusskalibrierung“ unter „Bett nivellieren“ — nur, was der Startbefehl kann (backend.js calOf → p.cal).
// Wahl je Drucker gemerkt (psd_vib_<key>, psd_flow_<key>), Vorgabe aus. Druckansicht (app.js): Hidden-Felder vib/flow im Slice-Formular
// (backend form()), G-Code-Ansicht: amp_print vib/flow.
const ampCalGet = (k, key) => { try { return localStorage.getItem('psd_' + k + '_' + key) === '1'; } catch (e) { return false; } };
function ampCalHtml(cal, key, form) {
  const ks = ['vib', 'flow'].filter(k => cal && cal[k]);
  if (!ks.length) return '';
  return `<div class="amp-cal">${ks.map(k => `<label class="chk row"><input type="checkbox" id="pcal_${k}" data-cal="${k}"${ampCalGet(k, key) ? ' checked' : ''}> <span>${esc(t('amp_cal_' + k))}</span></label>`
    + (form ? `<input type="hidden" name="${k}" id="pcalv_${k}" value="${ampCalGet(k, key) ? '1' : '0'}">` : '')).join('')}<p class="hint">${esc(t('amp_cal_note'))}</p></div>`;
}
function ampCalWire(root, key) {
  root.querySelectorAll('[data-cal]').forEach(c => c.onchange = () => {
    const k = c.dataset.cal, hv = root.querySelector('#pcalv_' + k);
    if (hv) hv.value = c.checked ? '1' : '0';
    try { localStorage.setItem('psd_' + k + '_' + key, c.checked ? '1' : '0'); } catch (e) { /* privates Fenster */ }
  });
}
/** Druckansicht (app.js renderPrinters → build_web.py-Patch): Häkchen für den gewählten Drucker in #pcal. */
window.ampRenderCal = p => {
  const box = document.getElementById('pcal');
  if (!box) return;
  const h = p ? ampCalHtml(p.cal, p.key, true) : '';
  box.innerHTML = h; box.hidden = !h;
  if (h) ampCalWire(box, p.key);
};

// ── „Objekt für Objekt“ vorschlagen (24.11.2026, User 23.11.: „Ja, merk dir das für morgen“, 24.11.: „Das bauen wir ein“) ────────────────
// Anlass Druckstarts 23.11.: 2 einfarbige Würfel (rot/weiß) auf einem P1S — Schicht für Schicht 2 h 49 / 36 g, Objekt für Objekt 1 h 16 / 24 g
// (Orca lässt dabei den Reinigungsturm weg, je Teil nur ein Farbwechsel). Vorschlag nur, wenn der Drucker mehrfarbig kann, mindestens
// 2 Teile auf der Platte liegen, jedes Teil genau EINE Farbe hat (STL: ein Fach je Datei; 3MF: ein Filament je Objekt samt Teilen und
// nicht bemalt, AMPMesh.painted) und mindestens zwei Farben vorkommen. Der Knopf setzt die Experten-Einstellung „Druckreihenfolge“
// und gilt nur für diese Platte (amp_seq_auto: passt eine spätere Platte nicht, geht sie von selbst auf Standard zurück; wer die
// Einstellung selbst wählt, dem fassen wir sie nie an). Abstand und Höhe (Freihöhe des Druckkopfs) prüft Orca; scheitert es daran,
// erklärt ampSeqErr das statt der englischen Orca-Meldung (5 Würfel am 23.11.: „An error occurred when auto-arranging object(s)“).
// Hängt über build_web.py an renderMulti/renderStls (#pseq unter den Fächern); gilt in App und Agent gleich.
let ampSeqCtx = null, ampSeqT = null, ampSeqBusy = false;
const ampSeqPaint = new WeakMap();   // Datei → Promise<true|false|null> (bemalt?)
const ampSeqSel = () => view.querySelector('select[name="x_print_sequence"]');
const ampSeqAuto = v => {
  try { if (v === undefined) return localStorage.getItem('amp_seq_auto') === '1'; if (v) localStorage.setItem('amp_seq_auto', '1'); else localStorage.removeItem('amp_seq_auto'); } catch (e) { /* privates Fenster */ }
  return false;
};
function ampSeqSet(v, auto) {
  const sel = ampSeqSel(); if (!sel) return;
  ampSeqBusy = true;
  sel.value = v;
  sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true }));   // Zähler + Merken wie von Hand
  ampSeqBusy = false;
  ampSeqAuto(auto);
}
window.ampSeqCheck = (ps, printer) => { ampSeqCtx = { ps, printer }; clearTimeout(ampSeqT); ampSeqT = setTimeout(ampSeqRun, 60); };
/** Passt die Platte? → { n: Teile, cols: Farben } oder null */
async function ampSeqInfo(ps, p) {
  if (!p || !p.multi || !ps || !ps.kind) return null;
  if (ps.kind === 'stl') {
    const L = ps.stls || [];
    if (p.slot_mode === 'material' || L.length < 2) return null;
    const c = view.querySelector('input[name=slot]:checked'), main = c ? String(c.value) : '';
    const cols = new Set(L.map(x => x.slot || main).filter(Boolean)), n = L.reduce((a, x) => a + (x.copies || 1), 0);
    return n >= 2 && cols.size >= 2 ? { n, cols: cols.size } : null;
  }
  if (ps.kind !== '3mf' || !ps.pk || !ps.pk.usedOf) return null;
  const pk = ps.pk, want = +((view.querySelector('input[name=plate]:checked') || {}).value || 1);
  const pl = pk.plates.find(x => x.n === want) || pk.plates[0];
  if (!pl || !pl.ids) return null;
  const skip = ps.skip || new Set(), cols = new Set();
  let n = 0;
  for (const id of pl.ids) {
    const mine = (pl.insts || []).filter(x => x.obj === id), kept = mine.length ? mine.filter(x => !skip.has(x.id)).length : 1;
    if (!kept) continue;
    const u = pk.usedOf(new Set([id]));
    if (u.size !== 1) return null;   // Teil aus mehreren Farben (Unterteile mit eigenem Filament)
    n += kept; cols.add([...u][0]);
  }
  if (n < 2 || cols.size < 2) return null;
  const f = (view.querySelector('#pfile') || {}).files && view.querySelector('#pfile').files[0];
  if (!f || !window.AMPMesh || !AMPMesh.painted) return null;
  if (!ampSeqPaint.has(f)) ampSeqPaint.set(f, AMPMesh.painted(f).catch(() => null));
  return (await ampSeqPaint.get(f)) === false ? { n, cols: cols.size } : null;   // bemalt oder zu groß zum Prüfen → kein Vorschlag
}
async function ampSeqRun() {
  const box = view.querySelector('#pseq'); if (!box || !ampSeqCtx) return;
  const { ps } = ampSeqCtx, p = ampSeqCtx.printer();
  let info = null; try { info = await ampSeqInfo(ps, p); } catch (e) { info = null; }
  const sel = ampSeqSel();
  if (!view.contains(box) || !sel) return;
  const on = sel.value === 'by object';
  if (!info) {
    if (on && ampSeqAuto()) ampSeqSet('', false);   // vom Vorschlag gesetzt, diese Platte passt nicht → zurück auf Standard
    box.hidden = true; box.innerHTML = ''; return;
  }
  box.innerHTML = on
    ? `<div class="note"><p><b>${esc(t('amp_seq_on'))}</b></p><p class="hint">${esc(t('amp_seq_note'))}</p><div class="amp-acts"><button type="button" class="btn sm" data-seq="">${esc(t('amp_seq_off'))}</button></div></div>`
    : `<div class="note"><p><b>${esc(t('amp_seq_h'))}</b> ${esc(t('amp_seq_p', { n: info.n }))}</p><div class="amp-acts"><button type="button" class="btn sm pri" data-seq="by object">${esc(t('amp_seq_btn'))}</button></div></div>`;
  box.hidden = false;
  box.querySelector('[data-seq]').onclick = e => { const v = e.currentTarget.dataset.seq; ampSeqSet(v, v === 'by object'); ampSeqRun(); };
}
// Änderungen, die renderMulti/renderStls nicht auslösen: Fach je STL, Anzahl, Hauptfach, Experten-Einstellung von Hand
document.addEventListener('change', e => {
  const el = e.target; if (!ampSeqCtx || !el || !el.closest || !view.querySelector('#pseq')) return;
  if (el.name === 'x_print_sequence' && !ampSeqBusy) ampSeqAuto(false);   // selbst gewählt → nie wieder von selbst zurücksetzen
  if (el.matches('[data-fs], [data-cp], input[name=slot], input[name=plate], input[data-skip], select[name="x_print_sequence"]')) window.ampSeqCheck(ampSeqCtx.ps, ampSeqCtx.printer);
});
/** Slicen gescheitert: bei „Objekt für Objekt“ und Anordnungs-/Kollisionsfehlern von Orca eine verständliche Meldung (sonst ''). */
window.ampSeqErr = err => {
  const sel = ampSeqSel();
  return sel && sel.value === 'by object' && /arrang|collid|too tall|too close|clearance|sequential/i.test(String(err || '')) ? esc(t('amp_seq_err')) : '';
};

// ── Lüfter und Licht (12.11.2026, User: „so schön drehend und eben ein Lichtschalter“) ──────────────────────────
// Kacheln unter Live-Bild/Druck: Lüfter drehen sich so schnell, wie sie laufen (Phase hängt an der Uhr → kein Ruck beim
// Neuzeichnen alle paar Sekunden), Antippen = Stufen wählen; Licht = Schalter. Stand und Befehle: backend.js entry.ctl / ctlSet.
const I_FAN = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor">'
  + [0, 120, 240].map(r => `<path transform="rotate(${r} 12 12)" d="M12 12c-1.5-2.3-1.9-6.3.3-8.3 1.5-1.4 4.1-1 4.6 1 .6 2.4-1.8 4.7-4.9 7.3z"/>`).join('')
  + '<circle cx="12" cy="12" r="2.4"/></g><circle cx="12" cy="12" r="1" fill="var(--panel, #fff)"/></svg>';
const I_BULB = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path class="amp-bulb-g" d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2v.4h5.2v-.4c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/><path d="M9.6 19h4.8M10.6 21.5h2.8"/>'
  + '<path class="amp-bulb-r" d="M12 .2v.9M3.6 3.6l.7.7M20.4 3.6l-.7.7M.6 11h1M22.4 11h1"/></svg>';
const ampCtlName = (x, light) => x.k ? t((light ? 'amp_light_' : 'amp_fan_') + x.k) : String(x.name || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const ampFanTxt = f => f.pct == null ? '–' : f.pct > 0 ? (f.onoff ? t('amp_ctl_on') : f.pct + ' %') : t('amp_ctl_off');
/** Drehdauer je Umdrehung: 100 % ≈ 0,5 s, langsam laufende Lüfter sichtbar langsamer; Startwinkel aus der Uhr. */
const ampSpinStyle = pct => { const d = 0.5 / Math.max(0.15, pct / 100); return `--d:${d.toFixed(2)}s;--o:-${((Date.now() / 1000) % d).toFixed(2)}s`; };
// Druckgeschwindigkeit (21.11.2026, User: „Kobra S1 … Speed in 3 Stufen … gibt es das auch für andere Drucker“): Stufen über den
// Kacheln, nur während eines Drucks (backend.js ctl.speed: lv, cur, pct). Ein Tipp = Stufe gesetzt; Prozent-Drucker zeigen den Wert dazu.
const ampSpdBlock = (p, pid) => {
  const s = p.ctl && p.ctl.speed;
  if (!s || !(s.lv || []).length) return '';
  const lbl = esc(t('amp_speed'));
  return `<div class="amp-spd"><div class="amp-ctl-h">${lbl}${s.pct != null ? ` <small>${esc(s.pct + ' %')}</small>` : ''}</div>
    <div class="amp-seg amp-spdseg${s.lv.length > 3 ? ' n4' : ''}" style="--n:${s.lv.length}" role="radiogroup" aria-label="${lbl}">${s.lv.map(k => `<button type="button" role="radio" aria-checked="${k === s.cur ? 'true' : 'false'}"${k === s.cur ? ' class="on"' : ''} data-ampspd="${esc(k)}" data-pid="${pid}">${esc(t('amp_spd_' + k))}</button>`).join('')}</div></div>`;
};
window.ampCtlBlock = (prov, p) => {
  const c = p.ctl;
  if (!c || !p.online || p.locked || (!(c.fans || []).length && !(c.lights || []).length && !c.speed)) return '';
  const pid = esc(p.id);
  const fans = (c.fans || []).map(f => {
    const run = f.pct > 0;
    return `<button type="button" class="amp-ct${run ? ' on' : ''}${f.set === false ? ' ro' : ''}" data-ampfan="${esc(f.id)}" data-pid="${pid}" aria-label="${esc(ampCtlName(f) + ': ' + ampFanTxt(f))}">
      <span class="amp-ct-t"><b>${esc(ampCtlName(f))}</b><small>${esc(ampFanTxt(f))}</small></span><span class="amp-ct-i amp-fan"${run ? ` style="${ampSpinStyle(f.pct)}"` : ''}>${I_FAN}</span></button>`;
  });
  const lights = (c.lights || []).map(l => `<button type="button" class="amp-ct lt${l.on ? ' on' : ''}" role="switch" aria-checked="${l.on ? 'true' : 'false'}" data-amplight="${esc(l.id)}" data-on="${l.on ? 1 : 0}" data-pid="${pid}" aria-label="${esc(ampCtlName(l, true))}">
      <span class="amp-ct-t"><b>${esc(ampCtlName(l, true))}</b><small>${esc(l.on == null ? '–' : t(l.on ? 'amp_ctl_on' : 'amp_ctl_off'))}</small></span><span class="amp-ct-i amp-bulb">${I_BULB}</span></button>`);
  const tiles = fans.concat(lights);
  return `<div class="amp-ctl">${ampSpdBlock(p, pid)}${tiles.length ? `<div class="amp-ctl-h">${esc(t('amp_ctl_h'))}</div><div class="amp-ct-g">${tiles.join('')}</div>` : ''}</div>`;
};
const ampCtlOf = (pid, kind, id) => { for (const cn of (pv.data && pv.data.connections) || []) for (const p of cn.printers || []) if (String(p.id) === String(pid)) return (((p.ctl || {})[kind]) || []).find(x => String(x.id) === String(id)) || null; return null; };
const ampCtlErr = (e, cmd) => toast(String((e && e.message) || '').split('\n')[0] === 'print_only' ? t(cmd === 'speed' ? 'amp_spd_print_only' : 'amp_ctl_print_only') : t('amp_ctl_err'));
async function ampCtlSend(body) {
  pv.busy = true;
  try { await api('printer_cmd', body); }
  catch (e) { ampCtlErr(e, body.cmd); }
  finally { pv.busy = false; }
  // Kurz warten: Dauerverbindungen (Bambu, Elegoo, Creality, Anycubic) melden den neuen Stand erst nach dem Befehl
  setTimeout(async () => { try { await loadPrinters(false); if (!dlg.open && view.querySelector('.pcard')) drawPrinters(); } catch (e) {} }, 700);
}
function ampFanDlg(pid, f) {
  const cur = f.pct == null ? -1 : f.pct, steps = [0, 25, 50, 75, 100];
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(ampCtlName(f))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><div class="amp-fan-steps">${steps.map(v => `<button type="button" class="btn${cur === v ? ' pri' : ''}" data-v="${v}">${v ? v + ' %' : esc(t('amp_ctl_off'))}</button>`).join('')}</div>
      <label class="amp-fan-sl"><input type="range" min="0" max="100" step="5" value="${Math.max(0, cur)}" id="ampfanr" aria-label="${esc(ampCtlName(f))}"><b id="ampfanv">${Math.max(0, cur)} %</b></label></div>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const go = v => { dlg.close(); ampCtlSend({ printer: pid, cmd: 'fan', id: f.id, pct: v }); };
  dlg.querySelectorAll('[data-v]').forEach(b => b.onclick = () => go(+b.dataset.v));
  const r = dlg.querySelector('#ampfanr'), rv = dlg.querySelector('#ampfanv');
  r.oninput = () => { rv.textContent = r.value + ' %'; };
  r.onchange = () => go(+r.value);
  dlg.showModal();
}
document.addEventListener('click', e => {
  const sb = e.target.closest('[data-ampspd]');
  if (sb) {
    if (sb.classList.contains('on')) return;
    // Sofort markieren (der Drucker meldet die neue Stufe teils erst Sekunden später)
    sb.parentElement.querySelectorAll('[data-ampspd]').forEach(b => { const on = b === sb; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    ampCtlSend({ printer: sb.dataset.pid, cmd: 'speed', lv: sb.dataset.ampspd });
    return;
  }
  const fb = e.target.closest('[data-ampfan]');
  if (fb) {
    const f = ampCtlOf(fb.dataset.pid, 'fans', fb.dataset.ampfan);
    if (!f) return;
    if (f.set === false) { toast(t('amp_ctl_print_only')); return; }
    if (f.onoff) { fb.classList.toggle('on'); ampCtlSend({ printer: fb.dataset.pid, cmd: 'fan', id: f.id, pct: f.pct > 0 ? 0 : 100 }); return; }
    ampFanDlg(fb.dataset.pid, f);
    return;
  }
  const lb = e.target.closest('[data-amplight]');
  if (lb) {
    const on = lb.dataset.on !== '1';
    // Sofort umschalten (der Drucker meldet den neuen Stand teils erst Sekunden später)
    lb.dataset.on = on ? '1' : '0'; lb.classList.toggle('on', on); lb.setAttribute('aria-checked', on ? 'true' : 'false');
    const sm = lb.querySelector('small'); if (sm) sm.textContent = t(on ? 'amp_ctl_on' : 'amp_ctl_off');
    ampCtlSend({ printer: lb.dataset.pid, cmd: 'light', id: lb.dataset.amplight, on });
  }
});

// ── Was braucht mein Drucker? ──────────────────────────────────────────────
const GUIDE = [
  ['bambu', 'Bambu Lab', '8883'], ['acl', 'Anycubic', '18910'], ['klipper', 'Klipper', '7125'], ['creality', 'Creality', '9999'],
  ['elegoo', 'Elegoo', '3030 / 1883'], ['flashforge', 'Flashforge', '8898'], ['prusa', 'Prusa', '80'], ['octoprint', 'OctoPrint', '80 / 5000'],
];
/** Treiber der App → Abschnitt der Anleitung. */
const guideOf = kind => ({ bambu: 'bambu', acl: 'acl', anycubic: 'acl', moonraker: 'klipper', creality: 'creality', sdcp: 'elegoo', cc2: 'elegoo', elegoo: 'elegoo',
  flashforge: 'flashforge', prusalink: 'prusa', octoprint: 'octoprint' })[kind] || '';
const ampHelpLinks = kind => `<div class="amp-help"><a href="#guide${guideOf(kind) ? '/' + guideOf(kind) : ''}">${esc(t('amp_guide_link'))}</a><a href="#printers" data-report="">${esc(t('amp_rep_btn'))}</a></div>`;
async function viewGuide(sec) {
  const li = k => String(t(k) || '').split('|').filter(Boolean);
  view.innerHTML = `<div class="amp-guide"><div class="amp-back"><a href="#connect" class="btn ghost sm">‹ ${esc(t('pr_tab_connect'))}</a></div>
    <h1>${esc(t('amp_guide_h'))}</h1>
    <section class="amp-gall"><b>${esc(t('amp_guide_all_h'))}</b><p>${esc(t('amp_guide_all_p'))}</p></section>
    <section class="amp-gall"><b>${esc(t('amp_guide_ip_h'))}</b><p>${esc(t('amp_guide_ip_p'))}</p></section>
    ${GUIDE.map(([k, name, port]) => {
      const note = t('gd_' + k + '_n');
      return `<section class="card amp-gcard${sec === k ? ' on' : ''}" id="gd-${k}"><div class="amp-gh"><h2>${esc(name)}</h2><span class="amp-port">${esc(t('amp_guide_port', { p: port }))}</span></div>
        <p class="hint">${esc(t('gd_' + k + '_m'))}</p><ol>${li('gd_' + k + '_s').map(x => `<li>${esc(x)}</li>`).join('')}</ol>
        ${note && note !== 'gd_' + k + '_n' ? `<div class="note${/LAN|Cloud|cloud|nube|nuvola/.test(note) ? ' warn-note' : ''}">${esc(note)}</div>` : ''}</section>`;
    }).join('')}
    <section class="card amp-gcard amp-gnf"><h2>${esc(t('amp_guide_nf_h'))}</h2><ul>${li('amp_guide_nf_s').map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      <button type="button" class="btn pri" data-report="">${esc(t('amp_rep_btn'))}</button></section></div>`;
  if (sec) { const el = document.getElementById('gd-' + sec); if (el) setTimeout(() => el.scrollIntoView({ block: 'start' }), 30); }
  else window.scrollTo(0, 0);
}

// ── Problem melden ────────────────────────────────────────────────────────
async function ampReport(pid) {
  const list = (AMP.db && AMP.db.printers) || [];
  dlg.innerHTML = `<form method="dialog" id="frep" class="amp-rep"><div class="dlg-h"><b>${esc(t('amp_rep_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">
      <label class="fld"><span>${esc(t('amp_rep_what'))}</span><textarea class="in" name="text" rows="4" maxlength="4000" required placeholder="${esc(t('amp_rep_ph'))}"></textarea></label>
      <label class="fld"><span>${esc(t('amp_rep_printer'))}</span><select class="in" name="printer">
        ${list.length > 1 ? `<option value="">${esc(t('amp_rep_all'))}</option>` : ''}${list.map(p => `<option value="${esc(p.id)}"${p.id === pid ? ' selected' : ''}>${esc(p.name + (p.model && p.model !== p.name ? ' · ' + p.model : ''))}</option>`).join('')}
        <option value="-"${!list.length ? ' selected' : ''}>${esc(t('amp_rep_none'))}</option></select></label>
      <fieldset class="amp-rep-inc"><legend>${esc(t('amp_rep_inc_h'))}</legend>
        <label><input type="checkbox" name="app" checked> ${esc(t('amp_rep_inc_app'))}</label>
        <label><input type="checkbox" name="pr" checked> ${esc(t('amp_rep_inc_printer'))}</label>
        <label><input type="checkbox" name="log" checked> ${esc(t('amp_rep_inc_log'))}</label>
        <p class="hint">${esc(t('amp_rep_never'))} <button type="button" class="linkbtn" id="repprev">${esc(t('amp_rep_preview'))}</button></p>
        <pre class="amp-rep-pre" id="reppre" hidden></pre></fieldset>
      <label class="fld"><span>${esc(t('amp_rep_email'))}</span><input class="in" name="email" type="email" maxlength="200" autocomplete="email"></label>
      <p class="hint">${esc(t('amp_rep_note'))}</p><p class="hint amp-rep-cm">${esc(t('amp_rep_cm'))} <a href="https://allmyprinters.com/${LANG}/community/" target="_blank" rel="noopener">${esc(t('amp_cm_link'))}</a></p><div id="repmsg"></div></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button class="btn pri">${esc(t('amp_rep_send'))}</button></div></form>`;
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const fm = $('#frep');
  const inc = () => ({ app: fm.app.checked, printer: fm.pr.checked && fm.printer.value !== '-', log: fm.log.checked });
  $('#repprev').onclick = async () => {
    const pre = $('#reppre'), d = await api('amp_diag', {}).catch(() => ({})), i = inc(), pv = {};
    if (i.app) pv.app = d.app;
    if (i.printer) pv.printers = (d.printers || []).filter((x, n) => !fm.printer.value || (list[n] && list[n].id === fm.printer.value));
    if (i.log) pv.log = d.log;
    pre.textContent = JSON.stringify(pv, null, 2); pre.hidden = false;
  };
  fm.onsubmit = async e => {
    e.preventDefault();
    const btn = fm.querySelector('.btn.pri'), text = fm.text.value.trim();
    const msg = (k, bad) => { $('#repmsg').innerHTML = `<div class="note${bad ? ' warn-note' : ''}">${esc(t(k))}</div>`; };
    if (text.length < 5) return msg('amp_rep_err_text', true);
    btn.disabled = true; btn.innerHTML = spin(t('amp_rep_send'));
    try {
      await api('amp_report', { text, email: fm.email.value.trim(), printer: fm.printer.value === '-' ? '' : fm.printer.value, inc: inc() });
      dlg.close(); toast(t('amp_rep_sent'));
    } catch (er) {
      btn.disabled = false; btn.textContent = t('amp_rep_send');
      msg(er.message === 'text' ? 'amp_rep_err_text' : er.message === 'offline' ? 'amp_rep_err_offline' : er.message === 'too_many' ? 'amp_rep_err_many' : 'err_generic', true);
    }
  };
  dlg.showModal();
}

// ── Spulen übernehmen (3DSEARCH, Spoolman, SpoolDB, OctoPrint, Tabellen) ──
const I_IMP = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';
const IMP_NAME = { '3dsearch': '3DSEARCH', spoolman: 'Spoolman', spooldb: 'SpoolDB', octosm: 'OctoPrint SpoolManager' };
async function viewImport() {
  const li = k => String(t(k) || '').split('|').filter(Boolean);
  let last = ''; try { last = localStorage.getItem('amp_spoolman') || ''; } catch (e) {}
  view.innerHTML = `<div class="amp-imp"><div class="amp-back"><a href="#spools" class="btn ghost sm">‹ ${esc(t('tab_spools'))}</a></div>
    <h1>${esc(t('amp_imp_h'))}</h1><p class="lead">${esc(t('amp_imp_lead'))}</p>
    <section class="card amp-gcard" id="imp-3ds"><div class="amp-gh"><h2>${esc(t('amp_imp_3ds_h'))}</h2><span class="amp-port">CSV</span></div>
      <ol>${li('amp_imp_3ds_s').map(x => `<li>${esc(x)}</li>`).join('')}</ol>
      <div class="amp-acts"><a class="btn" href="https://3dsearch.net/filament/#io" target="_blank" rel="noopener">${esc(t('amp_imp_3ds_open'))} ↗</a><button type="button" class="btn pri" data-impfile="">${esc(t('amp_imp_file'))}</button></div>
      <p class="hint">${esc(t('amp_imp_3ds_n'))}</p></section>
    <section class="card amp-gcard" id="imp-sm"><div class="amp-gh"><h2>${esc(t('amp_imp_sm_h'))}</h2><span class="amp-port">${esc(t('amp_guide_port', { p: 7912 }))}</span></div>
      <p class="hint">${esc(t('amp_imp_sm_p'))}</p>
      <form class="amp-imp-url" id="impurlf"><input class="in" id="impurl" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="192.168.1.20:7912" value="${esc(last)}"><button class="btn pri">${esc(t('amp_imp_sm_go'))}</button></form>
      <p class="hint">${esc(t('amp_imp_sm_file'))} <button type="button" class="linkbtn" data-impfile="">${esc(t('amp_imp_file'))}</button></p></section>
    <section class="card amp-gcard" id="imp-other"><div class="amp-gh"><h2>${esc(t('amp_imp_other_h'))}</h2><span class="amp-port">CSV · JSON</span></div>
      <p class="hint">${esc(t('amp_imp_other_p'))}</p>
      <div class="amp-acts"><button type="button" class="btn" data-impfile="">${esc(t('amp_imp_file'))}</button></div></section>
    <div id="impres" class="amp-impres" aria-live="polite"></div></div>`;
  window.scrollTo(0, 0);
  const box = $('#impres');
  const run = async (src, mode) => {
    box.innerHTML = `<div class="wait"><span class="spin"></span>${esc(t('loading'))}</div>`;
    box.scrollIntoView({ block: 'nearest' });
    try {
      const d = await api('amp_spool_import', { ...src, mode }), r = d.result;
      const sum = t('amp_imp_sum', { n: r.spools, f: IMP_NAME[r.format] || t('amp_imp_tbl'), nw: r.new, up: r.update, m: r.catalog_match, a: r.archived, l: r.locations });
      box.innerHTML = `<section class="card amp-card amp-impok"><p>${d.committed ? `<b>${esc(t('amp_imp_done'))}</b><br>` : ''}${esc(sum)}${r.extra ? '<br><span class="hint">' + esc(t('amp_imp_extra')) + '</span>' : ''}${r.renumbered ? '<br><span class="hint">' + esc(t('amp_imp_renum', { n: r.renumbered })) + '</span>' : ''}</p>
        ${d.committed ? `<a class="btn pri" href="#spools">${esc(t('amp_imp_to_spools'))} →</a>` : `<button type="button" class="btn pri" id="impgo">${esc(t('amp_imp_go', { n: r.spools }))}</button>`}</section>`;
      if (!d.committed) $('#impgo').onclick = () => run(src, 'commit');
      else { st.spools = []; if (typeof pv !== 'undefined') pv.data = null; }
      box.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      const k = { import_url: 'amp_imp_err_url', import_backup: 'amp_imp_err_backup', import_bad: 'amp_imp_err_bad' }[e.message] || 'err_generic';
      box.innerHTML = `<div class="note err-note">${esc(t(k))}</div>`;
    }
  };
  view.querySelectorAll('[data-impfile]').forEach(b => b.onclick = async () => {
    let f = null; try { f = await AMP.native('import', {}); } catch (e) {}
    if (f && f.text) run({ data: f.text }, 'preview');
  });
  $('#impurlf').onsubmit = ev => {
    ev.preventDefault();
    const u = $('#impurl').value.trim(); if (!u) return;
    try { localStorage.setItem('amp_spoolman', u); } catch (e) {}
    run({ url: u }, 'preview');
  };
}

// ── Startbildschirm (E1): ausblenden, sobald die erste Ansicht steht (mind. 0,9 s, sonst blitzt er nur; höchstens 3 s) ──
(() => {
  const sp = document.getElementById('amp-splash'); if (!sp) return;
  const t0 = performance.now();
  let done = false;
  const off = () => { if (done) return; done = true; sp.classList.add('off'); setTimeout(() => sp.remove(), 400); };
  const ready = () => { const v = document.getElementById('view'); return v && v.children.length && !v.querySelector(':scope > .wait'); };
  const tick = () => { if (done) return; if (ready()) setTimeout(off, Math.max(0, 900 - (performance.now() - t0))); else setTimeout(tick, 120); };
  tick(); setTimeout(off, 3000);
})();

// ── Eigene Slicer-Profile in den Experten-Einstellungen (Speichern, Wählen, OrcaSlicer-Prozessprofil importieren) ──
// Aufruf aus viewPrint (/filament) über den Patch in build_web.py; after() = pxCount + pxSave + stale dort.
window.ampProfInit = (box, after) => {
  const host = box.querySelector('#ampprof'); if (!host) return;
  // Temperaturen gehören nicht in ein Prozessprofil (gelten nur für einen Druck, 15.11.2026)
  const fields = () => [...box.querySelectorAll('[name^=x_]')].filter(el => el.name !== 'x_scale' && el.name !== 'x_pause' && !/^x_(nozzle_temperature|nozzle_temperature_initial_layer|bed_temperature)$/.test(el.name));
  const lab = k => t('psd_x_' + k) !== 'psd_x_' + k ? t('psd_x_' + k) : k;
  const apply = vals => {
    fields().forEach(el => { el.value = ''; });
    for (const [k, v] of Object.entries(vals || {})) {
      const el = box.querySelector(`[name="x_${k}"]`); if (!el) continue;
      // Schichthöhe aus Orca (z. B. 0.15) steht nicht in der Auswahl → als eigene Option dazu
      if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === v)) el.add(new Option(k === 'layer_height' ? v.replace('.', ',') + ' mm' : v, v));
      el.value = v;
    }
    after();
  };
  const cur = () => { const o = {}; fields().forEach(el => { if (el.value !== '' && !el.disabled) o[el.name.slice(2)] = el.value; }); return o; };
  const draw = async (sel, msg) => {
    let list = [];
    try { list = (await api('amp_profiles', {})).profiles; } catch (e) {}
    host.innerHTML = `<div class="amp-pf-row"><select class="in" id="amppfsel" aria-label="${esc(t('amp_pf_choose'))}"><option value="">${esc(t('amp_pf_choose'))}</option>
        ${list.map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <button type="button" class="btn sm" id="amppfsave">${esc(t('amp_pf_save'))}</button><button type="button" class="btn sm" id="amppfimp">${esc(t('amp_pf_import'))}</button></div>
      <div class="amp-pf-row" id="amppfnamef" hidden><input class="in" id="amppfname" maxlength="40" enterkeyhint="done" placeholder="${esc(t('amp_pf_name'))}"><button type="button" class="btn sm pri" id="amppfok">${esc(t('amp_pf_ok'))}</button></div>
      ${sel ? `<button type="button" class="linkbtn amp-pf-del" id="amppfdel">${esc(t('amp_pf_delete'))}</button>` : ''}
      <div id="amppfmsg" class="amp-pf-msg">${msg || `<p class="hint">${esc(t('amp_pf_hint'))}</p>`}</div>`;
    const s = host.querySelector('#amppfsel');
    s.onchange = () => { const p = list.find(x => x.id === +s.value); if (p) { apply(p.vals); draw(p.id, `<p class="hint">${esc(t('amp_pf_applied', { n: p.name }))}</p>`); } else draw(0); };
    host.querySelector('#amppfsave').onclick = () => {
      const f = host.querySelector('#amppfnamef'); f.hidden = !f.hidden;
      const p = list.find(x => x.id === sel); host.querySelector('#amppfname').value = p ? p.name : '';
      if (!f.hidden) host.querySelector('#amppfname').focus();
    };
    // Kein <form>: der Bereich steht im Formular der Druckansicht (#pf), ein inneres Formular verwirft der Browser
    const doSave = async () => {
      if (!host.querySelector('#amppfname').value.trim()) { host.querySelector('#amppfname').focus(); return; }
      try { const r = await api('amp_profile_save', { name: host.querySelector('#amppfname').value, vals: cur() }); draw(r.profile.id, `<p class="hint">${esc(t('amp_pf_saved', { n: r.profile.name }))}</p>`); }
      catch (e) { host.querySelector('#amppfmsg').innerHTML = `<div class="note err-note">${esc(t(String(e.message).split('\n')[0] === 'pf_empty' ? 'amp_pf_empty' : 'err_generic'))}</div>`; }
    };
    host.querySelector('#amppfok').onclick = doSave;
    host.querySelector('#amppfname').onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); doSave(); } };
    if (sel) host.querySelector('#amppfdel').onclick = async () => { await api('amp_profile_delete', { id: sel }).catch(() => {}); draw(0, `<p class="hint">${esc(t('amp_pf_deleted'))}</p>`); };
    host.querySelector('#amppfimp').onclick = async () => {
      let f = null; try { f = await AMP.native('import', {}); } catch (e) {}
      if (!f || !f.text) return;
      try {
        const r = await api('amp_profile_import', { text: f.text, file: f.name || '' });
        apply(r.profile.vals);
        const ks = Object.keys(r.profile.vals), o = r.other, parts = [];
        if (o.speed) parts.push(t('amp_pf_g_speed', { n: o.speed }));
        if (o.accel) parts.push(t('amp_pf_g_accel', { n: o.accel }));
        if (o.width) parts.push(t('amp_pf_g_width', { n: o.width }));
        if (o.rest) parts.push(t('amp_pf_g_rest', { n: o.rest }));
        let m = `<b>${esc(t('amp_pf_imp_ok', { n: r.profile.name, k: ks.length }))}</b> ${esc(ks.map(lab).join(', '))}`;
        if (parts.length) m += `<br>${esc(t('amp_pf_imp_other', { list: parts.join(', ') }))}`;
        if (r.bad.length) m += `<br>${esc(t('amp_pf_imp_bad', { list: r.bad.map(lab).join(', ') }))}`;
        if (r.sup !== null) m += `<br>${esc(t(r.sup ? 'amp_pf_sup_on' : 'amp_pf_sup_off', { s: t('psd_supports') }))}`;
        m += `<br><span class="hint">${esc(t('amp_pf_imp_base'))}</span>`;
        draw(r.profile.id, `<div class="note">${m}</div>`);
      } catch (e) {
        const k = { pf_zip: 'amp_pf_err_zip', pf_type: 'amp_pf_err_type', pf_bad: 'amp_pf_err_bad', pf_none: 'amp_pf_err_none', pf_range: 'amp_pf_err_none' }[String(e.message).split('\n')[0]] || 'err_generic';
        host.querySelector('#amppfmsg').innerHTML = `<div class="note err-note">${esc(t(k))}</div>`;
      }
    };
  };
  draw(0);
};

// ── NFC-Tags (10.11.2026, User: „bau mal“ — nur lesen): Handy an den Tag halten → Spule öffnen; im Dialog „Spule zuordnen“ →
// Spule ins Fach; unbekannter Tag → verknüpfen oder neue Spule (OpenSpool-Inhalt vorbelegt). Android liefert AMP_ev('nfc').
window.AMP_NFC = { available: false, enabled: false };
const ampNfcState = () => AMP.native('nfc_state').then(s => { window.AMP_NFC = s || window.AMP_NFC; }).catch(() => {});
ampNfcState();
AMP.on('resume', () => { const was = window.AMP_NFC.enabled; ampNfcState().then(() => { if (was !== window.AMP_NFC.enabled && sheet.classList.contains('on') && ampNfcSheetSpool) showSpool(ampNfcSheetSpool); }); });
let ampNfcWait = null, ampNfcLast = { uid: '', at: 0 }, ampNfcSheetSpool = null;
const I_NFC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8.3a6 6 0 0 1 0 7.4"/><path d="M9.5 6a10 10 0 0 1 0 12"/><path d="M13 4a14 14 0 0 1 0 16"/><circle cx="3.5" cy="12" r="1"/></svg>';
/** Bereich „NFC-Tags“ in der Spulenansicht (build_web-Patch an showSpool). */
window.ampNfcBlock = s => {
  ampNfcSheetSpool = s.id;
  const N = window.AMP_NFC || {};
  if (!N.available) return '';
  const list = (s.nfc || []).map(u => `<li data-uid="${esc(u)}"><code>${esc(u.replace(/(..)(?=.)/g, '$1:'))}</code><button type="button" class="btn sm ghost" data-nfc="del" data-uid="${esc(u)}" data-sid="${s.id}">${esc(t('amp_nfc_del'))}</button></li>`).join('');
  return `<section class="sd-sec amp-nfc"><h3>${I_NFC} ${esc(t('amp_nfc_h'))}</h3>
    ${list ? `<ul class="amp-nfc-l">${list}</ul>` : `<p class="hint">${esc(t('amp_nfc_none'))}</p>`}
    ${N.enabled ? `<div class="amp-acts"><button type="button" class="btn sm" data-nfc="link" data-sid="${s.id}" data-sname="${esc(title(s))}">${I_NFC} ${esc(t('amp_nfc_link'))}</button><button type="button" class="btn sm" data-nfc="write" data-sid="${s.id}">${esc(t('amp_nfc_write'))}</button></div><p class="hint">${esc(t('amp_nfc_hint'))}</p>`
      : `<p class="hint">${esc(t('amp_nfc_off'))} <button type="button" class="btn sm" data-nfc="on">${esc(t('amp_nfc_on_btn'))}</button></p>`}</section>`;
};
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-nfc]'); if (!b) return;
  const a = b.dataset.nfc;
  if (a === 'on') { AMP.native('nfc_settings').catch(() => {}); return; }
  if (a === 'del') { try { await api('amp_nfc_unlink', { spool: +b.dataset.sid, uid: b.dataset.uid }); await loadSpools(); showSpool(+b.dataset.sid); } catch (err) { fail(err); } return; }
  if (a === 'link') ampNfcLinkWait(+b.dataset.sid, b.dataset.sname || '');
  if (a === 'write') ampNfcWriteDlg(+b.dataset.sid);
});

// ── Tag beschreiben (15.11.2026, Community-Wunsch „Write NFC tags for spools“): OpenSpool auf NTAG215/216 ──
// Format: github.com/spuder/OpenSpool (min/max_temp als Text) + Felder der Snapmaker-U1-Extended-Firmware (subtype, bed_*, weight,
// diameter, additional_color_hexes). Der Android-Teil schreibt den NÄCHSTEN angetippten Tag (Nfc.kt arm), Ergebnis „nfc_write“.
// Danach wird der Tag mit der Spule verknüpft (wie „Tag verknüpfen“). Anycubic ACE liest diese Tags nicht (eigenes Format).
const OS_DEF = [['PETG', 230, 250, 70, 80], ['PLA', 190, 220, 50, 60], ['ABS', 240, 260, 90, 100], ['ASA', 240, 260, 90, 100], ['TPU', 210, 230, 40, 60],
  ['PC', 260, 280, 100, 110], ['PA', 250, 270, 80, 100], ['PVA', 190, 210, 50, 60], ['HIPS', 230, 250, 90, 100], ['PET', 230, 250, 70, 80]];
let ampNfcWriting = null;   // { sid, json, force }
function ampNfcWriteDlg(sid) {
  const s = (st.spools || []).find(x => x.id === sid); if (!s) return;
  const mat = String(s.material || 'PLA').trim(), parts = mat.split(/\s+/), type = (parts.shift() || 'PLA').toUpperCase(), sub = parts.join(' ');
  const d = OS_DEF.find(x => type.startsWith(x[0])) || OS_DEF[1];
  const T = +s.extruder_temp > 0 ? +s.extruder_temp : 0, B = +s.bed_temp > 0 ? +s.bed_temp : 0;
  const v = { tmin: T ? T - 10 : d[1], tmax: T ? T + 10 : d[2], bmin: B ? Math.max(0, B - 5) : d[3], bmax: B ? B + 5 : d[4] };
  const hex = String(s.color || '#888888').replace('#', '').slice(0, 6).toUpperCase();
  const num = (n, val, min, max) => `<input class="in num" type="number" name="${n}" min="${min}" max="${max}" step="1" inputmode="numeric" value="${val}" required>`;
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_nfc_w_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <form class="dlg-b amp-nfcw" id="nfcwf">
      <p class="hint">${esc(t('amp_nfc_w_p'))}</p>
      <p class="amp-nfcw-sp"><i style="background:#${esc(hex)}"></i><b>${esc(title(s))}</b> <span class="hint">#${esc(hex)}${s.total ? ' · ' + s.total + ' g' : ''} · ${esc(String(s.diameter || 1.75).replace('.', ','))} mm</span></p>
      <div class="fgrid">
        <label class="fld"><span>${esc(t('amp_nfc_w_type'))}</span><input class="in" name="type" maxlength="12" value="${esc(type)}" required></label>
        <label class="fld"><span>${esc(t('amp_nfc_w_sub'))}</span><input class="in" name="sub" maxlength="20" value="${esc(sub)}"></label>
        <label class="fld"><span>${esc(t('amp_nfc_w_brand'))}</span><input class="in" name="brand" maxlength="30" value="${esc(s.brand || '')}" placeholder="Generic"></label>
      </div>
      <div class="fgrid">
        <div class="fld"><span>${esc(t('amp_nfc_w_noz'))}</span><span class="amp-nfcw-r">${num('tmin', v.tmin, 150, 350)}<b>–</b>${num('tmax', v.tmax, 150, 350)}</span></div>
        <div class="fld"><span>${esc(t('amp_nfc_w_bed'))}</span><span class="amp-nfcw-r">${num('bmin', v.bmin, 0, 130)}<b>–</b>${num('bmax', v.bmax, 0, 130)}</span></div>
      </div>
      <div id="nfcwmsg"></div>
    </form>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button><button type="submit" form="nfcwf" class="btn pri" id="nfcwgo">${esc(t('amp_nfc_w_go'))}</button></div>`;
  dlg.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
  dlg.addEventListener('close', () => { if (ampNfcWriting) { ampNfcWriting = null; AMP.native('nfc_write_cancel').catch(() => {}); } }, { once: true });
  dlg.querySelector('#nfcwf').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target)), n = k => Math.round(+f[k]);
    if (!/^[A-Za-z0-9+ -]{2,12}$/.test(f.type.trim()) || n('tmin') > n('tmax') || n('bmin') > n('bmax')) { ampNfcWMsg(t('amp_nfc_w_bad'), 'warn-note'); return; }
    const o = { protocol: 'openspool', version: '1.0', type: f.type.trim().toUpperCase(), color_hex: hex, brand: f.brand.trim() || 'Generic',
                min_temp: String(n('tmin')), max_temp: String(n('tmax')), bed_min_temp: n('bmin'), bed_max_temp: n('bmax') };
    if (f.sub.trim()) o.subtype = f.sub.trim();
    const more = (s.colors || []).slice(1, 5).map(c => String(c).replace('#', '').slice(0, 6).toUpperCase()).filter(c => /^[0-9A-F]{6}$/.test(c));
    if (more.length) o.additional_color_hexes = more;
    if (+s.total > 0) o.weight = +s.total;
    o.diameter = +s.diameter || 1.75;
    ampNfcArm({ sid, json: JSON.stringify(o), force: false });
  };
  dlg.showModal();
}
const ampNfcWMsg = (txt, cls, retry) => {
  const m = dlg.querySelector('#nfcwmsg'); if (!m) return;
  const f = dlg.querySelector('#nfcwf'), go = dlg.querySelector('#nfcwgo');
  if (f) f.classList.remove('armed');
  if (go) { go.hidden = false; go.disabled = false; }
  m.innerHTML = `<div class="note ${cls || ''}">${esc(txt)}${retry ? ` <button type="button" class="btn sm" id="nfcwre">${esc(t('amp_nfc_w_retry'))}</button>` : ''}</div>`;
  const r = m.querySelector('#nfcwre'); if (r) r.onclick = () => ampNfcArm(retry);
};
async function ampNfcArm(w) {
  try { const r = await AMP.native('nfc_write', { json: w.json, force: !!w.force }); if (!r || !r.ok) throw new Error((r && r.error) || 'bad'); }
  catch (e) { ampNfcWMsg(t('amp_nfc_w_bad'), 'warn-note'); return; }
  ampNfcWriting = w;
  const f = dlg.querySelector('#nfcwf'), m = dlg.querySelector('#nfcwmsg'), go = dlg.querySelector('#nfcwgo');
  if (f) f.classList.add('armed');
  if (go) go.hidden = true;
  if (m) m.innerHTML = `<div class="amp-nfc-wait amp-nfcw-arm">${I_NFC.replace('width="18" height="18"', 'width="56" height="56"')}<p class="amp-nfcw-wait">${esc(t(w.force ? 'amp_nfc_w_again' : 'amp_nfc_w_wait'))}</p></div>`;
}
// Erfolg bleibt im Dialog stehen, bis „Fertig“ (Denny 16.11.: Toast verpasst, weil das Handy noch an der Spule lag).
// Danach springt die Spulenansicht zum Bereich „NFC-Tags“ und hebt den neuen Tag kurz hervor.
const I_OK = '<svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m7.5 12.5 3 3 6-6.5"/></svg>';
function ampNfcWDone(w, r, linked, other) {
  const s = (st.spools || []).find(x => x.id === w.sid);
  const p = linked ? t('amp_nfc_w_done_p', { s: s ? title(s) : '#' + w.sid }) : other ? t('amp_nfc_w_done_other', { n: other }) : t('amp_nfc_w_done_nolink');
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_nfc_w_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b amp-nfc-wait amp-nfcw-done" role="status">${I_OK}<p class="amp-nfcw-done-t">${esc(t('amp_nfc_w_done_h'))}</p><p>${esc(p)}</p>
      <p class="hint"><code>${esc(String(r.uid || '').replace(/(..)(?=.)/g, '$1:'))}</code></p></div>
    <div class="dlg-f"><button type="button" class="btn pri" data-x id="nfcwdone">${esc(t('amp_nfc_w_done_btn'))}</button></div>`;
  dlg.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
  dlg.addEventListener('close', () => ampNfcFlash(r.uid), { once: true });
  if (!dlg.open) dlg.showModal();
  const b = dlg.querySelector('#nfcwdone'); if (b) b.focus();
}
function ampNfcFlash(uid) {
  const sec = document.querySelector('#sheet.on .amp-nfc'); if (!sec) return;
  try { sec.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { sec.scrollIntoView(); }
  const li = /^[0-9A-F]+$/.test(uid || '') && sec.querySelector(`li[data-uid="${uid}"]`);
  if (li) { li.classList.remove('amp-nfc-fresh'); void li.offsetWidth; li.classList.add('amp-nfc-fresh'); }
}
AMP.on('nfc_write', async r => {
  const w = ampNfcWriting; if (!w || !r) return;
  ampNfcWriting = null;
  if (r.ok) {
    // verknüpfen wie „Tag verknüpfen“, aber mit EINEM Hinweis am Ende (Tag gehörte einer anderen Spule → fragen)
    let linked = false, other = '';
    try {
      const q = { spool: w.sid, uid: r.uid, type: r.type || 'ntag' };
      let lr = await api('amp_nfc_link', q);
      if (lr.error === 'taken') {
        if (confirm(t('amp_nfc_taken', { n: lr.name || '#' + lr.other }))) lr = await api('amp_nfc_link', { ...q, move: true });
        else other = lr.name || '#' + lr.other;
      }
      linked = !!lr && !lr.error;
    } catch (e) { console.error('nfc_link', e); }
    await loadSpools().catch(() => {});
    await showSpool(w.sid);
    ampNfcWDone(w, r, linked, other);
    return;
  }
  if (r.error === 'foreign') {
    if (confirm(t('amp_nfc_w_foreign'))) { ampNfcArm({ ...w, force: true }); return; }
    ampNfcWMsg(t('amp_nfc_w_err_kept'), '');
    return;
  }
  const known = ['mifare', 'readonly', 'too_small', 'unsupported', 'io'];
  ampNfcWMsg(t('amp_nfc_w_err_' + (known.includes(r.error) ? r.error : 'io')), 'warn-note', r.error === 'io' ? w : null);
});
/** „Tag verknüpfen“: Dialog „Handy an den Tag halten“, der nächste angetippte Tag gehört dieser Spule. */
function ampNfcLinkWait(sid, sname) {
  ampNfcWait = { sid };
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_nfc_link'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b amp-nfc-wait">${I_NFC.replace('width="18" height="18"', 'width="56" height="56"')}<p>${esc(t('amp_nfc_wait_p', { s: sname }))}</p></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button></div>`;
  dlg.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
  dlg.addEventListener('close', () => { ampNfcWait = null; }, { once: true });
  dlg.showModal();
}
async function ampNfcLink(sid, ev) {
  let r = await api('amp_nfc_link', { spool: sid, uid: ev.uid, type: ev.type });
  if (r.error === 'taken') {
    if (!confirm(t('amp_nfc_taken', { n: r.name || '#' + r.other }))) return false;
    r = await api('amp_nfc_link', { spool: sid, uid: ev.uid, type: ev.type, move: true });
  }
  toast(t('amp_nfc_linked'));
  return true;
}
AMP.on('nfc', async ev => {
  if (!ev || !ev.uid) return;
  // Reader Mode meldet einen liegenden Tag mehrfach → dieselbe UID innerhalb 2 s nur einmal
  if (ev.uid === ampNfcLast.uid && Date.now() - ampNfcLast.at < 2000) return;
  ampNfcLast = { uid: ev.uid, at: Date.now() };
  try {
    if (ampNfcWait) {   // „Tag verknüpfen“ wartet
      const sid = ampNfcWait.sid;
      if (await ampNfcLink(sid, ev)) { ampNfcWait = null; if (dlg.open) dlg.close(); await loadSpools(); showSpool(sid); }
      return;
    }
    const r = await api('amp_nfc_tag', ev);
    const fa = dlg.open && dlg.querySelector('#fa');
    if (fa) {   // Dialog „Spule zuordnen“: Spule zu diesem Tag wählen (Spulen aus anderen Fächern fragen dort selbst nach)
      if (!r.spool) { toast(t('amp_nfc_unknown_assign')); return; }
      const cur = dlg.querySelector('.sp-cur .sp-no'), btn = dlg.querySelector(`.spools-pick button[data-id="${r.spool}"]`);
      if (btn) btn.click();
      else if (cur && st.spools.some(s => s.id === r.spool && s.slots.length)) toast(t('amp_nfc_in_slot'));
      else toast(t('amp_nfc_not_listed'));
      return;
    }
    if (dlg.open) return;   // anderer Dialog offen (z. B. Bearbeiten) → nichts dazwischenwerfen
    if (r.spool) { if (!st.spools.length) await loadSpools(); showSpool(r.spool); return; }
    ampNfcUnknown(ev, r);
  } catch (err) { console.error('nfc', err); }
});
// ── QR-Code scannen im Dialog „Spule zuordnen“ (24.11.2026, Community #54 Sebastian S.: „beim Wechseln der Spule auch den QR-Code
// scannen statt nur aus der Liste wählen“) ─────────────────────────────────────────────────────────────────────────────────────
// Kamera im Dialog selbst (kein zweites Fenster, die Liste bleibt darunter), Erkennung wie openScanner (BarcodeDetector, sonst jsQR),
// Spule über resolve_qr (unsere Etiketten, Spoolman, „#31“). Gewählt wird über pickId des Dialogs → Rückfrage „aus anderem Fach
// umsetzen?“ und Zuordnen wie beim Antippen. Nur was die Liste anbietet (sonst Hinweis). Kamera braucht eine sichere Seite (App,
// allmyprinters.com/web) — direkt im Browser über http://agent gibt es sie nicht, dann fehlt der Knopf. Build_web-Patch in assignDialog.
const I_QRS = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 8h3v3H8zM13 13h3v3h-3zM13 8h3M8 13v3"/></svg>';
const ampAsgCam = () => !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
window.ampAsgScanBtn = () => !ampAsgCam() ? '' : `<button type="button" class="btn" id="fascan">${I_QRS} ${esc(t('amp_asg_scan'))}</button>
  <div class="amp-asg-scan" id="fascanw" hidden><div class="scanbox"><video id="fascv" playsinline muted></video><span class="scanframe"></span></div>
    <p class="hint" id="fascmsg">${esc(t('scan_hint'))}</p><div class="amp-acts"><button type="button" class="btn sm ghost" id="fascstop">${esc(t('cancel'))}</button></div></div>`;
window.ampAsgScanWire = (pickId, ids, curId) => {
  const btn = dlg.querySelector('#fascan'); if (!btn) return;
  const box = dlg.querySelector('#fascanw'), ok = new Set(ids.map(Number));
  const msg = m => { const el = dlg.querySelector('#fascmsg'); if (el) el.textContent = m; };
  let stream = null, on = false;
  const stop = () => { on = false; if (stream) { stream.getTracks().forEach(tr => tr.stop()); stream = null; } if (box) box.hidden = true; btn.hidden = false; };
  dlg.addEventListener('close', stop, { once: true });
  dlg.querySelector('#fascstop').onclick = stop;
  btn.onclick = async () => {
    btn.hidden = true; box.hidden = false; msg(t('scan_hint'));
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
    catch (e) { msg(t('scan_nocam')); return; }
    if (!dlg.open || box.hidden) { stop(); return; }
    const video = dlg.querySelector('#fascv'); video.srcObject = stream; await video.play().catch(() => {});
    let detect;
    if ('BarcodeDetector' in window) {
      const bd = new BarcodeDetector({ formats: ['qr_code'] });
      detect = async () => { const r = await bd.detect(video).catch(() => []); return r[0] && r[0].rawValue; };
    } else {
      if (!window.jsQR) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = FM.jsqr; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }).catch(() => {});
      if (!window.jsQR) { msg(t('scan_nocam')); return; }
      const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
      detect = async () => {
        if (!video.videoWidth) return null;
        const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
        cv.width = w; cv.height = h; cx.drawImage(video, 0, 0, w, h);
        const r = window.jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        return r && r.data;
      };
    }
    on = true; let last = '';
    const tick = async () => {
      if (!on || !dlg.open) return;
      const code = await detect();
      if (code && code !== last) {
        last = code;
        const r = await api('resolve_qr', null, { code }).catch(() => ({}));
        const id = r && r.spool ? +r.spool : 0;
        if (!id) msg(t('scan_unknown'));
        else if (curId != null && id === +curId) msg(t('amp_nfc_in_slot'));
        else if (!ok.has(id)) msg(t('amp_asg_not_listed'));
        else { stop(); pickId(id); return; }
      }
      setTimeout(tick, 120);   // ~8 Bilder/s reichen und schonen den Akku
    };
    tick();
  };
};
/** Unbekannter Tag: mit vorhandener Spule verknüpfen (Liste mit Suche) oder neue Spule anlegen (OpenSpool-Inhalt vorbelegt). */
async function ampNfcUnknown(ev, r) {
  if (!st.spools.length) await loadSpools();
  const os = r.os;
  // Vorhandene Spule zuerst (User: „nicht dass er nur eine neue anlegt“): Spulen OHNE Tag vorn (das ist fast immer die gesuchte),
  // passend zum OpenSpool-Inhalt (Material, Farbe) ganz oben; „Neue Spule“ nur als kleiner Knopf unten
  const hasTag = s => (s.nfc || []).length > 0;
  const cands = st.spools.filter(s => !s.archived).map(s => ({ s, score: (hasTag(s) ? 5000 : 0) + (os && os.material && s.material.toUpperCase() === os.material.toUpperCase() ? colorDist(s.color, os.color || s.color) : 1000) }))
    .sort((a, b) => a.score - b.score || b.s.id - a.s.id);
  const match = cands.filter(x => x.score < 120), rest = cands.filter(x => x.score >= 120);
  const item = x => `<button type="button" data-id="${x.s.id}">${ring(x.s)}<span class="t"><b><span class="sp-no">${esc(spoolNo(x.s))}</span> ${esc(title(x.s))}</b><br><span>${esc(sub(x.s))} · ${g(x.s.left)}${x.s.location ? ' · ' + esc(x.s.location) : ''}</span></span></button>`;
  const osTxt = os ? [os.brand, os.material].filter(Boolean).join(' ') : '';
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_nfc_unknown_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p class="hint" style="margin:0">${esc(t('amp_nfc_unknown_p'))}</p>
      ${os ? `<div class="picked"><span class="sw" style="background:${esc(os.color || '#888')};width:22px;height:22px"></span><span class="t"><b>${esc(osTxt || 'OpenSpool')}</b><span>${esc(t('amp_nfc_unknown_os'))}</span></span></div>` : ''}
      <div class="fld"><span>${esc(t('amp_nfc_pick'))}</span></div>
      ${pickSearchHtml(cands.length)}
      <div id="falist">${match.length ? `<div><div class="fld"><span>${esc(t('assign_match'))}</span></div><div class="results spools-pick">${match.map(item).join('')}</div></div>` : ''}
        ${rest.length ? `<div>${match.length ? `<div class="fld"><span>${esc(t('assign_other'))}</span></div>` : ''}<div class="results spools-pick">${rest.map(item).join('')}</div></div>` : ''}</div>
      <p class="hint amp-nfc-new">${esc(t('amp_nfc_new_hint'))} <button type="button" class="btn sm" id="ampnfcnew">+ ${esc(t('amp_nfc_new'))}</button></p></div>
    <div class="dlg-f"><button type="button" class="btn ghost" data-x>${esc(t('cancel'))}</button></div>`;
  dlg.querySelectorAll('[data-x]').forEach(x => x.onclick = () => dlg.close());
  const choose = async id => { if (await ampNfcLink(id, ev).catch(fail)) { dlg.close(); await loadSpools(); showSpool(id); } };
  const bind = root => root.querySelectorAll('.spools-pick button').forEach(b => b.onclick = () => choose(+b.dataset.id));
  bind(dlg);
  pickSearch(cands, item, bind, choose);
  dlg.querySelector('#ampnfcnew').onclick = () => { dlg.close();
    editSpool(null, null, { copy: os ? { brand: os.brand || '', material: os.material || 'PLA', color: os.color || '#f26a12' } : {}, material: os && os.material, color: os && os.color,
      onCreated: async ids => { await ampNfcLink(ids[0], ev).catch(fail); await loadSpools(); showSpool(ids[0]); } }); };
  dlg.showModal();
}

// ── Bibliothek (10.11.2026, User: „ja bau 1“): /filament-Ansicht (app.js drawLib/libOpen) mit Speicher im Handy bzw. einem
// gewählten Ordner. Hier: Hochladen über den Android-Teil (stash → lib_upload), STL-Vorschaubild, Plattenbilder statt 3D-Ansicht,
// „Speichern unter“, Speicherort in den Einstellungen, „In Bibliothek speichern“ in der Druckansicht.
/** Datei stückweise an den Android-Teil (wie backend slcStash), mit Fortschritt 0–100. */
async function ampStash(f, onPct) {
  let token = '';
  for (let o = 0; o < f.size || !token; o += 1 << 20) {
    const b = new Uint8Array(await f.slice(o, o + (1 << 20)).arrayBuffer());
    let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    token = (await AMP.native('stash', { token, b64: btoa(bin), name: f.name })).token;
    if (onPct) onPct(Math.min(100, (o + b.length) / Math.max(1, f.size) * 100));
  }
  return token;
}
/** Upload-Zeile u ({file, folder}) in die Bibliothek; d = lib_list-Stand (wird ergänzt), done() zeichnet neu (app.js-Patch). */
window.ampLibUp = async (u, d, box, done) => {
  const setPct = p => { u.pct = p; const i = view.querySelector(`#lbups .lbup:nth-child(${(lb.ups || []).indexOf(u) + 1}) .lbbar-p i`); if (i) i.style.width = p.toFixed(0) + '%'; };
  let r = null, token = '';
  // Teil aus einer ZIP (ampLibAdd): erst jetzt entpacken, damit nie mehr als ein Teil im Speicher liegt
  if (u.lazy) {
    try { u.file = new File([await u.lazy()], u.file.name, { type: 'application/octet-stream' }); u.lazy = null; }
    catch (e) { u.state = 'err'; u.err = t('amp_lib_zip_bad'); done(); return; }
  }
  try {
    const thumb = /\.stl$/i.test(u.file.name) ? await ampStlThumb(u.file).catch(() => null) : null;
    token = await ampStash(u.file, setPct);
    r = await api('lib_upload', { token, name: u.file.name, size: u.file.size, folder: u.folder || '', thumb });
  } catch (e) { r = { error: 'lib_upload' }; }
  finally { if (token) AMP.native('fileDrop', { token }).catch(() => {}); }
  if (r && r.ok && r.file) {
    u.state = 'ok'; d.files.unshift(r.file); d.used = r.used;
    if (u.zipGo && lb.zipGo === u.zipGo) {   // erstes Teil einer einzelnen ZIP da → ihren Ordner zeigen
      const ff = r.file.folder || ''; lb.folder = ff === u.zipGo || ff.startsWith(u.zipGo + '/') ? u.zipGo : ff; lb.view = 'all'; pref('lib_f', lb.folder); lb.zipGo = null;
    }
  } else {
    u.state = 'err';
    const c = r && r.error ? String(r.error).replace(/^lib_/, '') : 'upload';
    u.err = c === 'dupe' ? t('lib_e_dupe', { name: r.name }) : c === 'dir' ? t('amp_lib_e_dir') : /^dav_/.test(c) ? t('amp_dav_err_' + c.slice(4), { s: '' })
      : S['lib_e_' + c] ? t('lib_e_' + c, { mb: fsize(d.max || 0) }) : t('lib_e_upload');
  }
  done();
};
// ── ZIP in die Bibliothek (23.11.2026, Wunsch #45 Tropisch: „Manche Modelle bestehen aus mehreren separaten Dateien“, lädt bei vielen
// Teilen die ZIP von Printables/Thingiverse). Die Oberfläche entpackt selbst (DecompressionStream, ohne Bibliothek): nur das Inhalts-
// verzeichnis wird sofort gelesen, jedes Teil erst beim Hochladen. Teile mit erlaubter Endung kommen in die normale Warteschlange, Ordner
// = gerade gewählter Ordner + Name der ZIP (+ Unterordner aus der ZIP ohne den gemeinsamen Anfang, z. B. Thingiverse „…/files/“).
// Bilder, Texte, Lizenzdateien zählen als „übersprungen“; __MACOSX und versteckte Dateien gar nicht.
const ZIP_437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
/** Einträge einer ZIP (Blob): { list: [{ path, base, meth, csz, usz, lho }], skipped } — wirft zip_bad / zip_old */
async function ampUnzip(zf, exts) {
  if (typeof DecompressionStream !== 'function') throw new Error('zip_old');
  try { new DecompressionStream('deflate-raw'); } catch (e) { throw new Error('zip_old'); }
  const tl = Math.min(zf.size, 65557), tail = new DataView(await zf.slice(zf.size - tl).arrayBuffer());
  let eo = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  if (eo < 0) throw new Error('zip_bad');
  let n = tail.getUint16(eo + 10, true), cdSize = tail.getUint32(eo + 12, true), cdOff = tail.getUint32(eo + 16, true);
  if ((n === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) && eo >= 20 && tail.getUint32(eo - 20, true) === 0x07064b50) {   // ZIP64
    const o = Number(tail.getBigUint64(eo - 12, true)), z = new DataView(await zf.slice(o, o + 56).arrayBuffer());
    if (z.byteLength >= 56 && z.getUint32(0, true) === 0x06064b50) { n = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true)); }
  }
  if (cdOff + cdSize > zf.size) throw new Error('zip_bad');
  const cd = new DataView(await zf.slice(cdOff, cdOff + cdSize).arrayBuffer()), list = [];
  let skipped = 0;
  for (let k = 0, p = 0; k < n && p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50; k++) {
    const flag = cd.getUint16(p + 8, true), meth = cd.getUint16(p + 10, true), nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    let csz = cd.getUint32(p + 20, true), usz = cd.getUint32(p + 24, true), lho = cd.getUint32(p + 42, true);
    const raw = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, Math.min(nl, cd.byteLength - p - 46));
    for (let q = p + 46 + nl, e = Math.min(q + xl, cd.byteLength); q + 4 <= e;) {   // ZIP64-Zusatzfeld: echte Größen/Lage
      const id = cd.getUint16(q, true), l = cd.getUint16(q + 2, true);
      if (id === 1) {
        let r = q + 4;
        if (usz === 0xffffffff && r + 8 <= e) { usz = Number(cd.getBigUint64(r, true)); r += 8; }
        if (csz === 0xffffffff && r + 8 <= e) { csz = Number(cd.getBigUint64(r, true)); r += 8; }
        if (lho === 0xffffffff && r + 8 <= e) lho = Number(cd.getBigUint64(r, true));
      }
      q += 4 + l;
    }
    p += 46 + nl + xl + cl;
    // Name: UTF-8 (Kennzeichen 0x800 oder gültig), sonst DOS-Zeichensatz wie der Windows-Explorer
    let path;
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch (e) { path = [...raw].map(b => b < 128 ? String.fromCharCode(b) : ZIP_437[b - 128]).join(''); }
    path = path.replace(/\\/g, '/');
    if (path.endsWith('/')) continue;   // Ordner
    const base = path.split('/').pop();
    if (/(^|\/)__MACOSX\//.test(path) || base.startsWith('.')) continue;
    const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
    if (!exts.includes(ext) || (flag & 1) || (meth !== 0 && meth !== 8)) { skipped++; continue; }   // anderer Typ, verschlüsselt, unbekanntes Verfahren
    list.push({ path, base, meth, csz, usz, lho });
  }
  return { list, skipped };
}
/** Ein Eintrag aus ampUnzip → Blob (entpackt) */
async function ampUnzipEntry(zf, e) {
  const lh = new DataView(await zf.slice(e.lho, e.lho + 30).arrayBuffer());
  if (lh.byteLength < 30 || lh.getUint32(0, true) !== 0x04034b50) throw new Error('zip_bad');
  const o = e.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true), data = zf.slice(o, o + e.csz);
  if (e.meth === 0) return data;
  return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
}
/** Dateien aus Auswahl/Ablegen: ZIPs entpacken (Teile in den Ordner der ZIP), alles andere wie bisher über lbUpload */
async function ampLibAdd(fl) {
  const all = [...(fl || [])], zips = all.filter(f => /\.zip$/i.test(f.name)), rest = all.filter(f => !zips.includes(f));
  if (rest.length) lbUpload(rest);
  if (!zips.length) return;
  if (!rest.length) lb.ups = lb.ups.filter(u => u.state !== 'ok');
  const d = lb.d, base = lb.folder !== '*' ? lb.folder : '';
  let to = null;
  for (const zf of zips) {
    const row = { file: zf, folder: base, state: 'up', pct: 0 };   // „wird gelesen“ — hält die Warteschlange an, bis die Teile drin sind
    lb.ups.push(row); lbUpBox();
    let r = null, code = '';
    try { r = await ampUnzip(zf, d.exts); } catch (e) { code = e.message === 'zip_old' ? 'zip_old' : 'zip_bad'; }
    if (!code && !r.list.length) code = 'zip_none';
    if (code) { row.state = 'err'; row.err = t('amp_lib_' + code); lbUpBox(); continue; }
    const zn = zf.name.replace(/\.zip$/i, '').replace(/[\/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'ZIP';
    const dirs = r.list.map(e => e.path.split('/').slice(0, -1));
    let k = 0; while (dirs.every(x => x.length > k && x[k] === dirs[0][k])) k++;
    // wie backend libFolder (je Teil ≤ 60 Zeichen, gesamt ≤ 160), damit der Ordner nachher genau so heißt
    const libF = x => String(x ?? '').split('/').map(y => y.replace(/[\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean).join('/').slice(0, 160);
    const folder = libF([base, zn].filter(Boolean).join('/')), one = zips.length === 1 && !rest.length;
    const rows = r.list.map((e, j) => ({ file: { name: e.base, size: e.usz }, lazy: () => ampUnzipEntry(zf, e), folder: libF([folder, ...dirs[j].slice(k)].join('/')), state: 'wait', pct: 0, zipGo: one ? folder : null }));
    lb.ups.splice(lb.ups.indexOf(row), 1, ...rows);
    toast([t('amp_lib_zip_done', { n: rows.length, f: zn }), r.skipped ? t('amp_lib_zip_skip', { n: r.skipped }) : ''].filter(Boolean).join(' '));
    to = folder;
  }
  // Genau eine ZIP: ihren Ordner zeigen, sobald das erste Teil da ist (ein leerer Ordner springt in drawLib sonst auf „Alle“ zurück)
  lb.zipGo = zips.length === 1 && !rest.length ? to : null;
  lbUpBox(); lbUpNext();
}
/** STL → Vorschaubild (PNG, data:-Adresse): Schrägansicht wie im Slicer, flach schattiert, bis 250 000 Dreiecke (sonst ausgedünnt). */
async function ampStlThumb(file) {
  if (file.size > 200 * 1048576) return null;
  const buf = await file.arrayBuffer(), dv = new DataView(buf);
  let tri;
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  if (n > 0 && 84 + n * 50 === buf.byteLength) {
    const step = Math.max(1, Math.ceil(n / 250000)); tri = new Float32Array(Math.ceil(n / step) * 9); let k = 0;
    for (let i = 0; i < n; i += step) { const o = 84 + i * 50 + 12; for (let j = 0; j < 9; j++) tri[k++] = dv.getFloat32(o + j * 4, true); }
    tri = tri.subarray(0, k);
  } else {
    const txt = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 80 * 1048576))), v = [];
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g; let m;
    while ((m = re.exec(txt)) && v.length < 2250000) v.push(+m[1], +m[2], +m[3]);
    tri = Float32Array.from(v.slice(0, v.length - v.length % 9));
  }
  const nt = tri.length / 9;
  if (!nt) return null;
  // Drehen um Z (−45°), dann kippen (≈ 35°): x = rechts, y = Tiefe, z = oben
  const a = -Math.PI / 4, b = 0.62, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const P = new Float32Array(nt * 9);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < nt * 3; i++) {
    const x = tri[i * 3], y = tri[i * 3 + 1], z = tri[i * 3 + 2];
    const xr = x * ca - y * sa, yr = x * sa + y * ca;
    const d = yr * cb + z * sb, up = z * cb - yr * sb;
    P[i * 3] = xr; P[i * 3 + 1] = up; P[i * 3 + 2] = d;
    if (xr < x0) x0 = xr; if (xr > x1) x1 = xr; if (up < y0) y0 = up; if (up > y1) y1 = up;
  }
  const W = 320, H = 320, sc = 0.86 * Math.min(W / Math.max(1e-6, x1 - x0), H / Math.max(1e-6, y1 - y0));
  const ox = W / 2 - (x0 + x1) / 2 * sc, oy = H / 2 + (y0 + y1) / 2 * sc;
  const order = [], depth = new Float32Array(nt), shade = new Float32Array(nt);
  const L = [-0.35, -0.55, 0.76];
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2], vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
    // zum Betrachter zeigt −Tiefe; Rückseiten weglassen (STL-Normalen nicht vertrauen: nur die Wicklung zählt)
    if (nz > 0) continue;
    depth[t] = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
    shade[t] = 0.38 + 0.62 * Math.max(0, -(nx * L[0] + ny * L[1] + nz * L[2]));
    order.push(t);
  }
  order.sort((p, q) => depth[q] - depth[p]);   // hinten zuerst
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  for (const t of order) {
    const o = t * 9, s = shade[t];
    g.fillStyle = g.strokeStyle = `rgb(${Math.round(70 + 120 * s)},${Math.round(115 + 110 * s)},${Math.round(125 + 105 * s)})`;
    g.beginPath(); g.moveTo(ox + P[o] * sc, oy - P[o + 1] * sc); g.lineTo(ox + P[o + 3] * sc, oy - P[o + 4] * sc); g.lineTo(ox + P[o + 6] * sc, oy - P[o + 7] * sc); g.closePath();
    g.fill(); g.lineWidth = 0.6; g.stroke();
  }
  return cv.toDataURL('image/png');
}
/** Ort + wie oft gedruckt — in der Infozeile des Datei-Dialogs (app.js-Patch), für Bild- und 3D-Ansicht */
window.ampLibWhereTxt = f => (f.gone ? t('amp_lib_gone') + ' · ' : '') + t(f.loc === 'dir' ? 'amp_lib_in_dir' : f.loc === 'dav' ? 'amp_lib_in_dav' : 'amp_lib_in_app') + (f.prints ? ' · ' + t('amp_lib_prints', { n: f.prints }) + (f.printer ? ' (' + f.printer + ')' : '') : '');
// ── Ordner einlesen (12.11.2026, Denny): Leiste über der Liste, beim Öffnen der Bibliothek automatisch (backend höchstens alle 10 s) ──
window.ampStlThumb = ampStlThumb;   // backend.js libPvNext zeichnet damit Bilder für eingelesene STL
window.ampLibScanBar = d => d && d.scan ? `<div class="amp-lbscan"><span class="hint">${esc(t('amp_lib_scan_h', { n: d.scan.name || '' }))}</span>
  <button type="button" class="btn sm" id="amplbscan">${esc(t('amp_lib_scan'))}</button></div>` : '';
window.ampLibScan = async (force, btn) => {
  if (btn) { btn.disabled = true; btn.innerHTML = spin(t('amp_lib_scanning')); }
  let r;
  try { r = await api('lib_scan', { force: !!force }); } catch (e) { r = { error: 'lib_dav_net' }; }
  const changed = r && !r.error && (r.added || r.gone || r.back);
  if (r && r.error) { if (force) toast(t(String(r.error).startsWith('lib_dav_') ? 'amp_lib_scan_err_dav' : 'amp_lib_scan_err_dir')); }
  else if (changed) toast([r.added ? t('amp_lib_scan_new', { n: r.added }) : '', r.gone ? t('amp_lib_scan_gone', { n: r.gone }) : ''].filter(Boolean).join(' ') || t('amp_saved'));
  else if (force && r && !r.skipped) toast(t('amp_lib_scan_none'));
  if (changed && view.querySelector('.lbtop')) { try { lb.d = await get('lib_list'); drawLib(); libPoll(); } catch (e) {} }
  else if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = t('amp_lib_scan'); }
};
document.addEventListener('click', e => { const b = e.target.closest('#amplbscan'); if (b && !b.disabled) ampLibScan(true, b); });
/** Dialog einer Datei: Plattenbild(er) statt 3D-Ansicht (app.js libOpen-Patch); Platte wählen = Platte zum Drucken. */
window.ampLibPv = (f, plates) => {
  lb.ampPlate = plates.length ? plates[0].n : 1;
  setTimeout(() => ampLibPvBind(f, plates), 0);
  const where = ''
    // 3D-Ansicht: wird gebaut / bauen lassen (alte Einträge, Fehler); zu komplex fürs Handy → Bild bleibt
    + (f.can3d && !f.mesh ? (f.preview === 'busy' ? `<p class="hint amp-lb3d"><span class="spin"></span> ${esc(t('lib_building'))}</p>`
      : `<p class="amp-lb3d">${f.err === 'too_complex' ? `<span class="hint">${esc(t('amp_lib_3d_complex'))}</span>` : `<button type="button" class="btn sm" id="amplb3d">${esc(t('amp_lib_3d'))}</button>`}</p>`) : '');
  if (!plates.some(p => p.thumb)) {
    const gc = lbIsGc(f) ? t('lib_gcode') + (f.gcode && f.gcode.types && f.gcode.types.length ? ' · ' + f.gcode.types.join(', ') : '') : t('amp_lib_no_pic');
    return `<div class="lbnone">${lbIsGc(f) ? I_GCODE : I_BOX}<span>${esc(gc)}</span></div>${where}`;
  }
  return `${plates.length > 1 ? `<div class="chips lbpls">${plates.map(p => `<button type="button" class="chip${p.n === lb.ampPlate ? ' on' : ''}" data-amppl="${p.n}">${esc(t('psd_pl_n', { n: p.n }))}</button>`).join('')}</div>` : ''}
    <div class="amp-lbimg"><img id="amplbimg" src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=${lb.ampPlate}&amp;v=${f.v}" alt="" onerror="this.style.visibility='hidden'"></div>${where}`;
};
function ampLibPvBind(f, plates) {
  dlg.querySelectorAll('[data-amppl]').forEach(c => c.onclick = () => {
    const n = +c.dataset.amppl; lb.ampPlate = n;
    dlg.querySelectorAll('[data-amppl]').forEach(x => x.classList.toggle('on', x === c));
    const img = document.getElementById('amplbimg'); if (img) { img.style.visibility = ''; img.src = `api.php?a=lib_thumb&id=${f.id}&n=${n}&v=${f.v}`; }
    const pb = document.getElementById('lbprint'); if (pb && plates.length > 1) pb.querySelector('span').textContent = t('lib_print_plate', { n });
  });
  const b3 = document.getElementById('amplb3d');
  if (b3) b3.onclick = async () => { b3.disabled = true; try { await api('lib_rebuild', { id: f.id }); f.preview = 'busy'; libOpen(f); libPoll(); } catch (e) { b3.disabled = false; fail(e); } };
}
// „Speichern unter“ im Datei-Dialog (Bild- und 3D-Ansicht): Kopie an einen Ort nach Wahl
document.addEventListener('click', async e => {
  const b = e.target.closest('#amplbsave'); if (!b || !lb.cur) return;
  b.disabled = true;
  try { const r = await api('amp_lib_save_as', { id: lb.cur }); if (r && r.ok) toast(t('saved')); else if (r && r.error) toast(t('amp_dav_err_' + String(r.error).replace(/^lib_dav_/, ''), { s: '' })); } catch (er) { fail(er); }
  b.disabled = false;
});
// ── Bibliothek ordnen + Druckbuch (13.11.2026, User: „mach 2 und 3“, „nur die App“, „Agent nicht vergessen“) ──────────────
// Ersetzt drawLib/lbCard/lbBind/libOpen von /filament (build_web.py benennt die dortigen in *_3ds um; /filament bleibt unberührt).
// Unterordner = Pfad „A/B“ mit Brotkrumen; ein Ordner zeigt auch alles darunter. Tags als Filter, Suche auch in Tags und Notizen.
// Auswählen: mehrere Dateien verschieben, Tag setzen/entfernen, löschen (backend amp_lib_bulk). Im Dialog: Tags, Notizen,
// Foto vom Druck (Bild Nr. 0, ersetzt in der Liste das Plattenbild) und Druckbuch (amp_lib_book, Zeilen wie unter Druckaufträge).
lb.tag = null; lb.sel = null; lb.vis = [];
const lbCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const lbSegs = p => p ? String(p).split('/') : [];
/** Datei f liegt im Ordner p (oder darunter); '*' = alle, '' = ohne Ordner */
const lbInF = (f, p) => p === '*' || (p === '' ? !f.folder : (f.folder || '') === p || (f.folder || '').startsWith(p + '/'));
/** Alle Ordnerpfade samt Elternordnern (für die Auswahlliste) */
const lbPaths = files => { const s = new Set(); files.forEach(f => { const ps = lbSegs(f.folder); ps.forEach((_, i) => s.add(ps.slice(0, i + 1).join('/'))); }); return [...s].sort(lbCmp); };
/** Alle Tags, Schreibweise der ersten Fundstelle */
const lbAllTags = files => [...new Map(files.flatMap(f => f.tags || []).map(x => [x.toLowerCase(), x])).values()].sort(lbCmp);
const lbHasTag = (f, tg) => (f.tags || []).some(x => x.toLowerCase() === String(tg).toLowerCase());
const I_TAG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/></svg>';
const I_SELECT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/></svg>';

/** Größe für den Speicherplatz (Handy/NAS: Terabyte statt „3.144,5 GB“) */
const ampBig = b => b >= 1099511627776 ? new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 1 }).format(b / 1099511627776) + ' TB' : fsize(b);
// ═══ Bibliothek neu (18.11.2026, User: „langweilig und nicht intuitiv“ → Entwurf A + aus C Maße/„passt auf“/Druckbuch) ══════════
// Desktop: eigener Kopf (Bibliothek steht oben in der Leiste), links Ansichten + Ordnerbaum + häufige Tags. Handy: Kopf von „Drucker“
// bleibt (Bibliothek ist dort Unterreiter), Ansichten und Ordner in EINEM Dropdown (keine Wischleisten). Darüber „Weiter drucken“,
// ruhigere Karten (Druckstatus, Filamentfarben, Hinweise auf dem Bild, Tags nur im Detail), am Desktop Schnellaktionen beim
// Darüberfahren. Filter „Passt auf <Drucker>“ mit den Bettmaßen aus dem Slicer (≥ 1.0.10, backend amp_lib_beds).
const LB_LISTV = ['all', 'recent', 'never', 'multi', 'plates', 'want'];
lb.view = 'all'; lb.fit = (() => { try { return pref('lib_fit') || ''; } catch (e) { return ''; } })();
// Dateityp-Filter (19.11.2026, User: „Filter in der Bibliothek STL 3MF G-Code“): leer = alle; Platten/Gemerktes haben keinen Typ
lb.types = new Set((() => { try { return String(pref('lib_types') || '').split(',').filter(x => ['stl', '3mf', 'gcode'].includes(x)); } catch (e) { return []; } })());
const lbTypeOf = f => f.plate || f.want ? '' : lbIsGc(f) ? 'gcode' : f.ext === '3mf' ? '3mf' : f.ext === 'stl' ? 'stl' : '';
const LB_TYPES = [['stl', 'STL'], ['3mf', '3MF'], ['gcode', 'G-Code']];
const lbViewOk = (f, v) => v === 'recent' ? !!f.printed && !f.want : v === 'never' ? !f.want && !f.plate && !f.prints && !f.printed
  : v === 'multi' ? !!f.multi && !f.want : v === 'plates' ? !!f.plate : v === 'want' ? !!f.want : true;
/** Maße [x, y, z] je Platte (aus dem 3D-Netz); Platte: Maße ihrer Teile (Orca ordnet an) */
const lbDimsOf = f => f.plate ? (f.parts || []).flatMap(p => { const x = (lb.d.files || []).find(y => y.id === p.id); return x ? lbDimsOf(x) : []; })
  : (f.plates || []).filter(p => p.dims && !p.empty).map(p => p.dims);
const lbFits = (m, bed) => ((m[0] <= bed[0] && m[1] <= bed[1]) || (m[1] <= bed[0] && m[0] <= bed[1])) && (!bed[2] || m[2] <= bed[2]);
/** true/false = passt (nicht), null = Maße unbekannt (G-Code, ohne 3D-Ansicht) */
const lbFitOf = (f, bed) => { const ds = lbDimsOf(f); return ds.length ? ds.every(m => lbFits(m, bed)) : null; };
const lbDimTxt = m => m ? `${nf.format(Math.round(m[0]))} × ${nf.format(Math.round(m[1]))} × ${nf.format(Math.round(m[2]))} mm` : '';
const lbStatus = f => f.prints ? t('amp_lib_st_n', { n: f.prints, when: f.printed ? ago(f.printed) : '' }) : t('amp_lib_st_never');
const lbViewTxt = v => t('amp_lv_' + v);
const lbFolderTxt = p => p === '' ? t('lib_no_folder') : lbSegs(p).pop();
const I_LBGRID = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"></rect><rect x="13" y="4" width="7" height="7" rx="1.5"></rect><rect x="4" y="13" width="7" height="7" rx="1.5"></rect><rect x="13" y="13" width="7" height="7" rx="1.5"></rect></svg>';
const I_HIST = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path></svg>';

function drawLib() {
  const d = lb.d, files = d.files, y = window.scrollY;
  if (lb.want) { lb.view = 'want'; lb.want = false; }   // Sprung „Gemerkt“ aus der Modellsuche (ampLbJump → viewLib)
  if (!LB_LISTV.includes(lb.view)) lb.view = 'all';
  if (lb.folder === '' ? !files.some(f => !f.folder) : lb.folder !== '*' && !files.some(f => lbInF(f, lb.folder))) lb.folder = '*';
  // Bettmaße einmal je Öffnen holen (Profil vom Slicer), danach neu zeichnen — „Passt auf“ erscheint erst mit Maßen
  if (!lb.beds && !lb.bedsAsk) {
    lb.bedsAsk = true;
    api('amp_lib_beds').then(r => { lb.beds = ((r && r.printers) || []).filter(p => Array.isArray(p.bed)); if (lb.beds.length && view.querySelector('.lbtop')) drawLib(); })
      .catch(() => { lb.beds = []; });
  }
  const beds = lb.beds || [], fitP = lb.fit ? beds.find(p => p.id === lb.fit) : null;
  if (lb.fit && lb.beds && !fitP) lb.fit = '';
  const q = lb.q.trim().toLowerCase();
  const scope = files.filter(f => lbInF(f, lb.folder) && lbViewOk(f, lb.view));
  const tags = {};
  scope.forEach(f => (f.tags || []).forEach(x => { const k = x.toLowerCase(); (tags[k] = tags[k] || { tg: x, n: 0 }).n++; }));
  if (lb.tag && !tags[lb.tag.toLowerCase()]) lb.tag = null;
  const list = scope.filter(f => (!lb.tag || lbHasTag(f, lb.tag)) && (!fitP || lbFitOf(f, fitP.bed) === true) && (!lb.types.size || lb.types.has(lbTypeOf(f)))
    && (!q || [f.name, f.folder, (f.tags || []).join(' '), f.notes, f.orig].join(' ').toLowerCase().includes(q)));
  const byName = (a, b) => lbCmp(a.name, b.name);
  list.sort(lb.view === 'recent' ? (a, b) => tsv(b.printed) - tsv(a.printed) || b.id - a.id
    : { new: (a, b) => b.id - a.id, name: byName, size: (a, b) => b.size - a.size, printed: (a, b) => tsv(b.printed) - tsv(a.printed) || b.id - a.id }[lb.sort]);
  lb.vis = list.map(f => f.id);
  if (lb.sel) for (const id of [...lb.sel]) if (!files.some(f => f.id === id)) lb.sel.delete(id);
  const free = d.quota === 0, pct = free ? 0 : Math.min(100, d.used / d.quota * 100), canUp = !free && d.used < d.quota;
  const nM = files.filter(f => !f.want && !f.plate).length, nP = files.filter(f => f.plate).length;
  // Neue Anordnung (20.11.2026, Entwurf „Aufgeräumt“): ein Kopf für Handy und PC — Überschrift ist die Bereichsauswahl, daneben
  // Hochladen (am PC dazu Neue Platte / Auf eine Platte), darunter klein Anzahl und Speicher; das Ablegefeld steht am PC unten, am Handy nur als Knopf
  // Feinschliff 24.11.2026: „Neue Platte“ + „Auf eine Platte“ als EIN Knopf „Platte ▾“ (PC; am Handy über den Editor/Auswählen)
  const acts = `<details class="smenu amp-lbplm" data-k="lbplm"><summary class="btn">${I_PLATE}<span>${esc(t('amp_ed_plate_pick'))}</span>${I_CHEV}</summary><div class="smenu-l"><button type="button" id="amplbnew">${I_PLATE}<span>${esc(t('amp_ed_new'))}</span></button>${files.some(f => f.ext === 'stl') ? `<button type="button" id="amplbhdplate">${I_SELECT}<span>${esc(t('amp_plate_make'))}</span></button>` : ''}</div></details>`
    + (d.quota > 0 ? `<button type="button" class="btn pri" id="amplbhdadd"${canUp ? '' : ' disabled'}>${I_UPLOAD}<span>${esc(t('amp_lib_up'))}</span></button>` : '');
  const subl = [t('amp_lib_hd_sub', { n: nM }), nP ? t('amp_lib_hd_p', { n: nP }) : '', `${fsize(d.used)} ${free ? t('lib_used') : t('lib_of', { q: ampBig(d.quota) })}`].filter(Boolean).join(' · ');
  let h = `<div class="amp-lbph">${prHead('library', acts)}<p class="amp-phsub">${esc(subl)}${!canUp && !free ? ` · <span class="warn-t">${esc(t('lib_full'))}</span>` : ''}</p></div>`;
  const drop = d.quota > 0 ? `<div class="lbtop amp-lbtop${files.length ? '' : ' amp-lbtop0'}"><label class="amp-lbnew${canUp ? '' : ' off'}" id="lbdrop"><input type="file" id="lbfile" multiple accept="${[...d.exts, 'zip'].map(x => '.' + x).join(',')}"${canUp ? '' : ' disabled'}>
      <span class="amp-lbnew-i">${I_UPLOAD}</span><span class="amp-lbnew-t"><b>${esc(t('amp_lib_add'))}</b><small>${esc(t('amp_lib_drop_hint', { mb: fsize(d.max) }))}</small></span></label></div>` : '';
  if (!files.length) h += drop;
  h += `<div class="lbups" id="lbups">${lb.ups.map(lbUpRow).join('')}</div>${ampLibScanBar(d)}`;
  if (!files.length) {
    view.innerHTML = h + `<div class="empty"><b>${esc(t('lib_empty_h'))}</b>${esc(t('lib_empty_p'))}</div>`;
    lbBind(); return;
  }
  // Ansichten (leere weglassen, „Alle“ immer) und Ordnerbaum
  const views = LB_LISTV.map(v => ({ v, n: files.filter(f => lbViewOk(f, v)).length })).filter(x => x.v === 'all' || x.n);
  const paths = lbPaths(files), noF = files.filter(f => !f.folder).length;
  const fcnt = p => files.filter(f => lbInF(f, p)).length;
  const folders = paths.map(p => ({ p, dep: lbSegs(p).length - 1, n: fcnt(p) })).concat(paths.length && noF ? [{ p: '', dep: 0, n: noF }] : []);
  const isV = v => lb.folder === '*' && lb.view === v, isF = p => lb.folder === p;
  const vBtn = x => `<button type="button" class="amp-lbnav${isV(x.v) ? ' on' : ''}" data-lv="${x.v}"${isV(x.v) ? ' aria-current="true"' : ''}><span>${esc(lbViewTxt(x.v))}</span><b>${x.n}</b></button>`;
  const fBtn = x => `<button type="button" class="amp-lbnav${isF(x.p) ? ' on' : ''}" data-f="${esc(x.p)}" style="padding-left:${10 + x.dep * 16}px"${isF(x.p) ? ' aria-current="true"' : ''}><span>${I_FOLDER} ${esc(lbFolderTxt(x.p))}</span><b>${x.n}</b></button>`;
  const tks = Object.keys(tags).sort((a, b) => tags[b].n - tags[a].n || lbCmp(tags[a].tg, tags[b].tg));
  // Bibliothek-Umbau (19.11.2026, Entwurf claude.ai/artifact/2ZS7ZUQqUM2C47W6So3prt, User: „ja viel besser“): Kästen wie die Modellsuche
  const sec = (k, ic, title, small, body) => `<details class="amp-sbsec amp-lbsec2" data-sec="${k}"${(lb.closed || {})[k] ? '' : ' open'}><summary>${ic}<span>${esc(title)}</span>${small ? `<small>${esc(small)}</small>` : ''}${I_CHEV}</summary><div class="amp-sbbody">${body}</div></details>`;
  const chk = on => `<span class="amp-chkbox${on ? ' on' : ''}" aria-hidden="true">${on ? I_CHECK : ''}</span>`;
  const tyN = k => files.filter(f => lbInF(f, lb.folder) && lbViewOk(f, lb.view) && lbTypeOf(f) === k).length;
  const fitN = bed => files.filter(f => lbInF(f, lb.folder) && lbViewOk(f, lb.view) && lbFitOf(f, bed) === true).length;
  const I_TYPE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
  const I_PRN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14v18H5z"/><path d="M5 8h14"/><path d="M9 14h6"/></svg>';
  const I_TAGS = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12.5 12 4h7.5v7.5L11 20z"/><circle cx="15.5" cy="8.5" r="1.3"/></svg>';
  const side = `<aside class="amp-lbside" aria-label="${esc(t('amp_lv_h'))}">
      ${sec('views', I_LBGRID, t('amp_lv_h'), '', views.map(x => `<button type="button" class="amp-sbrow amp-lbnav${isV(x.v) ? ' on' : ''}" data-lv="${x.v}"${isV(x.v) ? ' aria-current="true"' : ''}><span>${esc(lbViewTxt(x.v))}</span><b>${x.n}</b></button>`).join(''))}
      ${sec('types', I_TYPE, t('amp_lib_type_h'), lb.types.size ? t('amp_sb_of', { n: lb.types.size, t: 3 }) : '', LB_TYPES.map(([k, l]) => `<button type="button" class="amp-sbrow${lb.types.has(k) ? ' on' : ''}" data-ty="${k}" aria-pressed="${lb.types.has(k)}">${chk(lb.types.has(k))}<span class="amp-lbty amp-lbty-${k}">${l}</span><span></span><b>${tyN(k)}</b></button>`).join(''))}
      ${beds.length ? sec('fit', I_PRN, t('amp_lib_fit_h'), '', `<button type="button" class="amp-sbrow${fitP ? '' : ' on'}" data-fit=""><span>${esc(t('amp_lib_fit_any'))}</span></button>`
        + beds.map(p => `<button type="button" class="amp-sbrow${fitP && fitP.id === p.id ? ' on' : ''}" data-fit="${esc(p.id)}"><span>${esc(p.name)}</span><b>${fitN(p.bed)}</b></button>`).join('')) : ''}
      ${folders.length ? sec('folders', I_FOLDER, t('amp_lf_h'), '', `<button type="button" class="amp-sbrow amp-lbnav${lb.folder === '*' ? ' on' : ''}" data-f="*"><span>${esc(t('amp_lib_all_folders'))}</span><b>${files.length}</b></button>`
        + folders.map(x => `<button type="button" class="amp-sbrow amp-lbnav${isF(x.p) ? ' on' : ''}" data-f="${esc(x.p)}" style="padding-left:${10 + x.dep * 16}px"${isF(x.p) ? ' aria-current="true"' : ''}><span>${esc(lbFolderTxt(x.p))}</span><b>${x.n}</b></button>`).join('')) : ''}
      ${tks.length ? sec('tags', I_TAGS, t('amp_lt_h'), lb.tag ? '#' + lb.tag : '', tks.slice(0, lb.allTags ? 200 : 8).map(k => { const on = !!(lb.tag && lb.tag.toLowerCase() === k);
          return `<button type="button" class="amp-sbrow${on ? ' on' : ''}" data-tg="${esc(tags[k].tg)}" aria-pressed="${on}">${chk(on)}<span>#${esc(tags[k].tg)}</span><b>${tags[k].n}</b></button>`; }).join('')
        + (tks.length > 8 && !lb.allTags ? `<button type="button" class="lnk amp-lbmoretags" data-alltags="1">${esc(t('amp_lib_tags_all', { n: tks.length }))}</button>` : '')) : ''}</aside>`;
  // Handy: ein Dropdown mit Ansichten und Ordnern (Muster .subdd: Tippen daneben oder Esc schließt)
  const cur = lb.folder !== '*' ? { label: lbFolderTxt(lb.folder), n: fcnt(lb.folder) } : { label: lbViewTxt(lb.view), n: (views.find(x => x.v === lb.view) || { n: 0 }).n };
  const ddI = (on, attrs, label, n) => `<button type="button" class="${on ? 'on' : ''}" ${attrs}><span>${label}</span><b>${n}</b>${on ? I_CHECK : ''}</button>`;
  const dd = `<details class="subdd amp-lbdd"><summary>${I_LBGRID}<span><b>${esc(cur.label)}</b> · ${cur.n}</span>${I_CHEV}</summary>
      <nav class="subdd-list" aria-label="${esc(t('amp_lv_h'))}"><p class="amp-lbddh">${esc(t('amp_lv_h'))}</p>${views.map(x => ddI(isV(x.v), `data-lv="${x.v}"`, esc(lbViewTxt(x.v)), x.n)).join('')}
      ${folders.length ? `<p class="amp-lbddh">${esc(t('amp_lf_h'))}</p>${folders.map(x => ddI(isF(x.p), `data-f="${esc(x.p)}" style="padding-left:${12 + x.dep * 16}px"`, esc(lbFolderTxt(x.p)), x.n)).join('')}` : ''}</nav></details>`;
  // Brotkrumen nur in Unterordnern
  let crumb = '';
  if (lb.folder !== '*' && lb.folder !== '' && lbSegs(lb.folder).length > 1) {
    const segs = lbSegs(lb.folder);
    crumb = `<nav class="amp-lbcrumb" aria-label="${esc(t('lib_folder'))}"><button type="button" class="lnk" data-f="*">${esc(t('lib_all'))}</button>`
      + segs.map((s, i) => ` › ${i === segs.length - 1 ? `<b>${I_FOLDER} ${esc(s)}</b>` : `<button type="button" class="lnk" data-f="${esc(segs.slice(0, i + 1).join('/'))}">${esc(s)}</button>`}`).join('') + `</nav>`;
  }
  const tagSel = tks.length ? `<select class="in amp-lbtagsel${lb.tag ? ' on' : ''}" id="amplbtag" aria-label="${esc(t('amp_lib_tags'))}"><option value="">${esc(t('amp_lib_tag_all'))}</option>${tks.sort((a, b) => lbCmp(tags[a].tg, tags[b].tg)).map(k =>
    `<option value="${esc(tags[k].tg)}"${lb.tag && lb.tag.toLowerCase() === k ? ' selected' : ''}>#${esc(tags[k].tg)} (${tags[k].n})</option>`).join('')}</select>` : '';
  const fitSel = beds.length ? `<select class="in amp-lbfit${fitP ? ' on' : ''}" id="amplbfit" aria-label="${esc(t('amp_lib_fit_all'))}"><option value="">${esc(t('amp_lib_fit_all'))}</option>${beds.map(p =>
    `<option value="${esc(p.id)}"${fitP && fitP.id === p.id ? ' selected' : ''}>${esc(t('amp_lib_fit', { p: p.name }))}</option>`).join('')}</select>` : '';
  const selT = t(lb.sel ? 'amp_lib_sel_done' : 'amp_lib_select');
  const lbFN = lb.types.size + (fitP ? 1 : 0) + (lb.tag ? 1 : 0) + (lb.view !== 'recent' && lb.sort !== 'new' ? 1 : 0);
  // Weiter drucken: die letzten drei Drucke aus der Bibliothek (nur in „Alle“ ohne Suche/Filter)
  const rec = lb.view === 'all' && lb.folder === '*' && !q && !lb.tag && !lb.sel && !fitP
    ? files.filter(f => !f.want && f.printed && f.print !== false).sort((a, b) => tsv(b.printed) - tsv(a.printed)).slice(0, 3) : [];
  const recPic = f => { const p1 = (f.plates || []).find(p => p.thumb); return f.photo ? `<img src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=0&amp;v=${f.v}" alt="" loading="lazy">`
    : p1 ? `<img src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=${p1.n}&amp;v=${f.v}" alt="" loading="lazy">` : (f.plate ? I_PLATE : lbIsGc(f) ? I_GCODE : I_BOX); };
  const recRow = f => { const l = f.last || {};
    return `<div class="amp-lbrc"><span class="amp-lbrcpic">${recPic(f)}</span><span class="amp-lbrct"><b>${esc(f.name)}</b>
      <span class="hint">${esc([f.printed ? ago(f.printed) : '', l.printer].filter(Boolean).join(' · '))}</span>
      <span class="hint">${esc([l.s ? dur(Math.max(1, Math.round(l.s / 60))) : '', l.g ? gUse(l.g) : ''].filter(Boolean).join(' · '))}</span></span>
      ${ps_ok() ? `<button type="button" class="btn sm" data-again="${f.id}"><span>${esc(t('amp_lib_again'))}</span></button>` : ''}</div>`; };
  h += `<div class="amp-lbwrap">${side}<div class="amp-lbmain">${dd}${crumb}
    <div class="lbbar amp-lbbar"><div class="amp-lbf${lb.fopen ? ' amp-fopen' : ''}"><span class="amp-lbqw"><input class="in lbsearch" type="search" id="lbq" placeholder="${esc(t('lib_search'))}" value="${esc(lb.q)}" aria-label="${esc(t('lib_search'))}">
      <button type="button" class="amp-lbfb${lbFN ? ' on' : ''}" id="amplbfb" aria-expanded="${!!lb.fopen}" aria-controls="amplbfr" aria-label="${esc(t('amp_mf_btn') + (lbFN ? ' (' + lbFN + ')' : ''))}">${I_FILTER2}${lbFN ? `<span class="amp-fcount">${lbFN}</span>` : ''}</button></span>
      <div class="amp-lbf-r" id="amplbfr"><select class="in amp-lbtysel${lb.types.size ? ' on' : ''}" id="amplbtype" aria-label="${esc(t('amp_lib_type_h'))}"><option value="">${esc(t('amp_lib_type_all'))}</option>${LB_TYPES.map(([k, l]) => `<option value="${k}"${lb.types.size === 1 && lb.types.has(k) ? ' selected' : ''}>${l}</option>`).join('')}</select>${fitSel}${tagSel}${lb.view === 'recent' ? '' : `<select class="in" id="lbsort" aria-label="${esc(t('lib_sort'))}">${LB_SORTS.map(s => `<option value="${s}"${lb.sort === s ? ' selected' : ''}>${esc(t('lib_sort_' + s))}</option>`).join('')}</select>`}</div>
      <button type="button" class="btn sm amp-lbselb${lb.sel ? ' pri' : ''}" id="amplbselbtn" aria-pressed="${!!lb.sel}" title="${esc(selT)}" aria-label="${esc(selT)}">${I_SELECT}<span>${esc(selT)}</span></button></div></div>
    ${lb.sel ? ampLibSelBar() : ''}${lbChips(list.length, fitP)}
    ${rec.length ? `<section class="amp-lbrec" aria-label="${esc(t('amp_lib_recent_h'))}"><h2>${I_HIST} ${esc(t('amp_lib_recent_h'))}</h2><div class="amp-lbrcs">${rec.map(recRow).join('')}</div></section>` : ''}
    <div class="lbgrid" id="lbgrid">${list.map(lbCard).join('') || `<p class="hint">${esc(fitP ? t('amp_lib_fit_none', { p: fitP.name }) : t('lib_none_match'))}</p>`}</div>${drop}</div></div>`;
  view.innerHTML = h;
  window.scrollTo(0, y);
  lbBind();
}
/** Gesetzte Filter als ×-Chips mit Trefferzahl und „Alle zurücksetzen“ (wie die Modellsuche) */
function lbChips(n, fitP) {
  const ch = [];
  const c = (k, label) => ch.push(`<button type="button" class="chip on amp-qx" data-lclr="${esc(k)}" aria-label="${esc(t('amp_mf_off', { f: label }))}"><span>${esc(label)}</span><span aria-hidden="true">×</span></button>`);
  if (lb.view !== 'all') c('view', lbViewTxt(lb.view));
  LB_TYPES.forEach(([k, l]) => { if (lb.types.has(k)) c('ty:' + k, l); });
  if (fitP) c('fit', t('amp_lib_fit', { p: fitP.name }));
  if (lb.folder !== '*') c('folder', lbFolderTxt(lb.folder));
  if (lb.tag) c('tag', '#' + lb.tag);
  if (lb.q.trim()) c('q', '„' + lb.q.trim() + '“');
  return `<div class="amp-lbchips${ch.length ? '' : ' amp-lbchips0'}"><b>${esc(n === 1 ? t('amp_lib_n1') : t('amp_lib_n', { n }))}</b>${ch.join('')}${ch.length ? `<button type="button" class="lnk" data-lclr="all">${esc(t('amp_lib_reset'))}</button>` : ''}</div>`;
}
function lbCard(f) {
  if (f.want) return ampWantCard(f);
  const p1 = (f.plates || []).find(p => !p.empty);
  const pic = f.photo ? `<img class="amp-photo" src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=0&amp;v=${f.v}" alt="" loading="lazy">`
    : (f.preview === 'ok' || f.thumbs) && (f.mesh || f.thumbs) && p1 && p1.thumb ? `<img src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=${p1.n}&amp;v=${f.v}" alt="" loading="lazy">`
    : lbPending(f) ? `<span class="lbph"><span class="spin"></span><small>${esc(t('lib_building'))}</small></span>`
    : f.plate ? `<span class="lbph">${I_PLATE}<small>${esc(t('amp_plate_badge'))}</small></span>`
    : `<span class="lbph">${lbIsGc(f) ? I_GCODE : I_BOX}<small>${esc(f.ext.toUpperCase())}</small></span>`;
  const np = (f.plates || []).filter(p => !p.empty).length, miss = f.plate ? f.parts.filter(p => !p.ok).length : 0;
  // Feinschliff 24.11.2026: höchstens zwei Abzeichen (Dateityp + das wichtigste: fehlt > Platte(n) > Mehrfarbig); Warnungen orange
  const bw = [f.gone ? t('amp_lib_gone') : '', miss ? t('amp_plate_missing_n', { n: miss }) : ''].filter(Boolean);
  const bdg = [...bw, f.plate ? t('amp_plate_badge') : '', !f.plate && np > 1 ? t('lib_plates_n', { n: np }) : '', f.multi ? t('amp_lv_multi') : ''].filter(Boolean).slice(0, lbTypeOf(f) ? 1 : 2);
  const dims = f.plate ? null : lbDimsOf(f)[0];
  const meta = f.plate ? t('amp_plate_parts', { n: f.parts.length }) : [f.ext.toUpperCase(), dims ? lbDimTxt(dims) : fsize(f.size), f.gcode && f.gcode.printer ? f.gcode.printer : ''].filter(Boolean).join(' · ');
  const dots = (f.last && f.last.cols) || [];
  // Ordner nur zeigen, wenn die Karte nicht ohnehin in diesem Ordner liegt
  const fo = f.folder && f.folder !== lb.folder ? (lb.folder !== '*' && lb.folder && f.folder.startsWith(lb.folder + '/') ? f.folder.slice(lb.folder.length + 1) : f.folder) : '';
  const on = !!(lb.sel && lb.sel.has(f.id));
  const qa = !lb.sel && f.print !== false && ps_ok() && !f.gone
    ? `<span class="amp-lbqa"><button type="button" class="btn sm pri" data-qa="print"><span>${esc(t('lib_print'))}</span></button>${f.ext === 'stl' || (f.ext === '3mf' && !lbIsGc(f)) ? `<button type="button" class="btn sm" data-qa="edit" title="${esc(t('amp_ed_edit'))}" aria-label="${esc(t('amp_ed_edit'))}">${I_PEN}</button>` : ''}</span>` : '';
  return `<article class="lbcard amp-lbc${f.plate ? ' amp-plcard' : ''}${lb.sel ? ' amp-selm' : ''}${on ? ' amp-on' : ''}" data-id="${f.id}">
    <button type="button" class="amp-lbhit" aria-label="${esc(f.name)}"${lb.sel ? ` aria-pressed="${on}"` : ''}></button>${lb.sel ? `<span class="amp-chk" aria-hidden="true">${on ? I_CHECK : ''}</span>` : ''}
    <span class="lbpic">${pic}${lbTypeOf(f) || bdg.length ? `<span class="amp-lbbdg">${lbTypeOf(f) ? `<span class="amp-lbty amp-lbty-${lbTypeOf(f)}">${esc((LB_TYPES.find(x => x[0] === lbTypeOf(f)) || [])[1])}</span>` : ''}${bdg.map(b => `<span${bw.includes(b) ? ' class="amp-lbbw"' : ''}>${esc(b)}</span>`).join('')}</span>` : ''}${qa}</span>
    <span class="lbt"><b>${esc(f.name)}</b><span class="hint">${esc(fo ? meta + ' · ' + fo : meta)}</span>
      <span class="amp-lbst"><span class="${f.prints ? '' : 'amp-lbnever'}">${esc(lbStatus(f))}</span>${dots.length ? `<span class="amp-dots" aria-hidden="true">${dots.map(c => `<i style="background:${esc(c)}"></i>`).join('')}</span>` : ''}</span></span></article>`;
}
/** Drucken aus der Bibliothek (Dialog, Karte, „Weiter drucken“): Platte → alle Teile, G-Code → direkt senden, sonst Druckansicht.
 *  Wie zuletzt: der letzte Drucker ist in der Druckansicht vorgewählt (lb.hand.printer, build_web.py-Patch). o: { btn, lbl, plate, err } */
async function ampLibPrint(f, o = {}) {
  const b = o.btn || null, lbl = o.lbl || null, base = lbl ? lbl.textContent : '', t0 = Date.now();
  const setL = x => { if (lbl) lbl.textContent = x; };
  const back = () => { if (b) b.disabled = false; setL(base); };
  if (b) b.disabled = true; setL(t('lib_loading_file'));
  // #23 (Denny, NAS): Sekunden mitzählen, damit man sieht, dass noch geladen wird; nach 60 s ohne Daten kommt ein klarer Fehler
  const tick = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); if (s >= 5) setL(`${t('lib_loading_file')} ${s} s`); }, 1000);
  const davFail = (c, s) => Object.assign(new Error(c), { status: s || 0 });
  const printer = f.last && f.last.pid ? 'moonraker:' + f.last.pid : null;
  try {
    if (f.plate) {   // gespeicherte Platte: alle vorhandenen Teile laden, Anzahl und Fach wie gespeichert
      if (!(await ampPlateAllowed())) { back(); return false; }
      const laid = f.parts.some(p => p.ok && Array.isArray(p.inst) && p.inst.length) && await ampFeat('editor');
      const items = await ampPlateFetch(f.parts.filter(p => p.ok).map(p => ({ id: p.id, name: p.name, n: p.n, slot: p.slot, inst: laid ? p.inst : null, sup: laid ? p.sup || '' : '' })), (i, n) => setL(t('amp_plate_loading', { i, n })));
      if (laid) { setL(t('amp_ed_building')); await ampEdPrintPlate(f, items, printer); return true; }   // Anordnung aus dem Editor (19.11.2026)
      ampPlateGo(items, f, printer);
      return true;
    }
    if (lbIsGc(f) || ampLibIsG3(f)) {   // + fertig geslicte 3MF (24.11.2026)
      const r = await api('amp_lib_token', { id: f.id });
      if (r.error || !r.token) throw davFail(r.error || 'lib_upload', r.status);
      pr.file = { token: r.token, name: r.name, size: r.size }; pr.meta = null; pr.err = ''; pr.lib = f.id;
      if (dlg.open) dlg.close();
      if (location.hash === '#gcode') viewGcode(); else location.hash = 'gcode';
      return true;
    }
    const r = await fetch('api.php?a=lib_get&id=' + f.id, { credentials: 'same-origin', headers: AUTH });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (x) {} throw davFail(j.error || 'http_' + r.status, j.status); }
    const blob = await r.blob();
    lb.hand = { id: f.id, name: f.name, plate: o.plate || 1, printer, file: new File([blob], `${f.name}.${f.ext}`, { type: 'application/octet-stream', lastModified: Date.now() }) };
    if (dlg.open) dlg.close();
    location.hash = 'print';
    return true;
  } catch (e) {
    back();
    // NAS-Fehler mit eigenem Text (kein NAS, zu langsam, Datei weg, Anmeldung …) statt „Etwas ist schiefgelaufen“
    if (/^lib_dav_/.test(e.message) || e.part) {
      const msg = /^lib_dav_/.test(e.message) && e.part ? e.part + ': ' + ampPlateErr(e) : ampPlateErr(e);
      if (o.err) o.err(msg); else toast(msg);
    } else fail(e);
    return false;
  } finally { clearInterval(tick); }
}
/** Mit diesem Modell eine Platte beginnen: Auswahl an, das Modell ist schon gewählt */
function ampLibToPlate(f) {
  if (dlg.open) dlg.close();
  lb.sel = new Set([f.id]); lb.mode = ''; lb.view = 'all';
  if (view.querySelector('.lbtop')) drawLib();
  toast(t('amp_plate_pick_more'));
}
/** Leiste der Mehrfachauswahl (lb.mode: '' | 'move' | 'tag' | 'del') */
function ampLibSelBar() {
  const n = lb.sel.size, allOn = lb.vis.length && lb.vis.every(id => lb.sel.has(id)), dis = n ? '' : ' disabled';
  const form = lb.mode === 'move'
    ? `<div class="amp-lbself"><input class="in" id="amplbselin" list="amplbselfl" maxlength="160" placeholder="${esc(t('amp_lib_move_ph'))}" autocomplete="off">
        <datalist id="amplbselfl">${lbPaths(lb.d.files).map(p => `<option value="${esc(p)}">`).join('')}</datalist>
        <button type="button" class="btn sm pri" data-sa="move_go">${esc(t('amp_lib_move_go'))}</button></div>`
    : lb.mode === 'tag'
    ? `<div class="amp-lbself"><input class="in" id="amplbselin" list="amplbseltl" maxlength="30" placeholder="${esc(t('amp_lib_tag_ph'))}" autocomplete="off">
        <datalist id="amplbseltl">${lbAllTags(lb.d.files).map(x => `<option value="${esc(x)}">`).join('')}</datalist>
        <button type="button" class="btn sm pri" data-sa="tag_add">${esc(t('amp_lib_tag_add'))}</button><button type="button" class="btn sm" data-sa="tag_del">${esc(t('amp_lib_tag_del'))}</button></div>` : '';
  return `<div class="amp-lbsel" id="amplbsel"><div class="amp-lbsel-r"><b>${esc(t('amp_lib_sel_n', { n }))}</b>
      <button type="button" class="lnk" data-sa="all">${esc(t(allOn ? 'amp_lib_sel_none' : 'amp_lib_sel_all'))}</button><span class="grow"></span>
      <button type="button" class="btn sm" data-sa="plate"${dis}>${I_PLATE} <span>${esc(t('amp_plate_make'))}</span></button>
      <button type="button" class="btn sm${lb.mode === 'move' ? ' on' : ''}" data-sa="move"${dis}>${I_FOLDER} ${esc(t('amp_lib_move'))}</button>
      <button type="button" class="btn sm${lb.mode === 'tag' ? ' on' : ''}" data-sa="tag"${dis}>${I_TAG} ${esc(t('amp_lib_tags'))}</button>
      <button type="button" class="btn sm ghost${lb.mode === 'del' ? ' danger' : ''}" data-sa="del"${dis}>${I_TRASH} <span>${esc(lb.mode === 'del' ? t('amp_lib_del_sure', { n }) : t('lib_delete'))}</span></button></div>${form}</div>`;
}
async function ampLibSelAct(k) {
  const ids = [...lb.sel];
  if (k === 'plate') {   // Platte zusammenstellen (18.11.2026): ausgewählte STL bzw. gespeicherte Platten → Druckansicht
    if (!ids.length || !(await ampPlateAllowed())) return;
    // Reihenfolge wie angetippt (lb.sel ist ein Set) — nicht die der Liste (neueste zuerst)
    const { parts, skip } = ampPlatePartsOf(ids.map(id => lb.d.files.find(f => f.id === id)).filter(Boolean));
    if (!parts.length) { toast(t('amp_plate_need_stl')); return; }
    if (parts.length > PLATE_MAX) { toast(t('psd_stl_max', { n: PLATE_MAX })); return; }
    const b = view.querySelector('[data-sa="plate"]'), sp = b && b.querySelector('span');
    if (b) b.disabled = true;
    try {
      const items = await ampPlateFetch(parts, (i, n) => { if (sp) sp.textContent = t('amp_plate_loading', { i, n }); });
      const one = ids.length === 1 && lb.d.files.find(f => f.id === ids[0] && f.plate);
      lb.sel = null; lb.mode = '';
      if (skip.length) toast(t('amp_plate_skipped', { n: skip.length }));
      if (await ampFeat('editor')) { await ampEdOpen(items, one || null, one && one.last && one.last.pid ? 'moonraker:' + one.last.pid : null); return; }   // Platte bearbeiten (19.11.2026)
      ampPlateGo(items, one || null);
    } catch (e) { if (b) { b.disabled = false; if (sp) sp.textContent = t('amp_plate_make'); } toast(ampPlateErr(e)); }
    return;
  }
  if (k === 'all') { const allOn = lb.vis.every(id => lb.sel.has(id)); lb.vis.forEach(id => allOn ? lb.sel.delete(id) : lb.sel.add(id)); drawLib(); return; }
  if (k === 'move' || k === 'tag') { lb.mode = lb.mode === k ? '' : k; drawLib(); const i = $('#amplbselin'); if (i) i.focus(); return; }
  if (k === 'del' && lb.mode !== 'del') { lb.mode = 'del'; drawLib(); return; }   // zweiter Klick löscht
  if (!ids.length) return;
  const val = ($('#amplbselin') || {}).value || '';
  const body = { ids };
  if (k === 'del') body.del = true;
  else if (k === 'move_go') body.folder = val;
  else if (k === 'tag_add' || k === 'tag_del') { if (!val.trim()) { $('#amplbselin').focus(); return; } body[k] = val.trim(); }
  else return;
  try {
    const r = await api('amp_lib_bulk', body);
    if (k === 'del') { lb.d.files = lb.d.files.filter(f => !lb.sel.has(f.id)); lb.d.used = r.used; lb.sel.clear(); toast(t('amp_lib_deleted_n', { n: r.n })); }
    else {
      (r.files || []).forEach(nf_ => { const f = lb.d.files.find(x => x.id === nf_.id); if (f) Object.assign(f, nf_); });
      toast(t(k === 'move_go' ? 'amp_lib_moved_n' : k === 'tag_add' ? 'amp_lib_tagged_n' : 'amp_lib_untagged_n', { n: r.n }));
      if (k === 'move_go') { lb.folder = body.folder ? body.folder.split('/').map(s => s.trim()).filter(Boolean).join('/') : '*'; pref('lib_f', lb.folder); }
    }
    lb.mode = '';
    drawLib();
  } catch (e) { fail(e); }
}
// ═══ Platte zusammenstellen (18.11.2026, User: „Stufe 1 und 2 finde ich super“; Wunsch #45 Tropisch) ═══════════════════════
// Stufe 1: mehrere STL aus der Bibliothek zusammen auf eine Platte — „Auswählen“ → „Auf eine Platte“, in der Druckansicht
// „Aus der Bibliothek“. Die Druckansicht (/filament renderStls) konnte mehrere STL mit Anzahl und Fach je Datei schon (Orca ordnet an).
// Stufe 2: „Als Platte speichern“ legt einen Bibliothekseintrag ohne eigene Datei an (backend amp_lib_plate_save, loc 'plate'):
// Teile + Anzahl + Fach, Collage der Teilbilder als Bild, eigenes Druckbuch, „Drucken“ lädt alle Teile wieder in die Druckansicht.
// Grenzen wie die Druckansicht: nur STL (3MF/G-Code bringen eigene Platten bzw. sind fertig), höchstens 20 Dateien.
const PLATE_MAX = 20;
const I_PLATE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 17.5 12 21l9.5-3.5L12 14z"/><path d="M7 15.6V10l3-1.2 3 1.2v4"/><path d="M14.5 15.2V12l2.5-1 2.5 1v3.6"/></svg>';
const ampPlateOk = f => f && f.ext === 'stl' && !f.want && !f.gone && !f.plate;
// Abo-Weiche „plates“ (User 18.11.: „als Option einbauen für das Abo-Modell“): im Agenten nach Plan (Admin „Abo“, ohne Einstellung nur
// im Abo, in der Beta frei); die App ohne Agent hat noch keine Weichen (erst nach dem geschlossenen Test, app-abo-grenzen-plan).
// Der Agent sperrt amp_lib_plate_save selbst; die Oberfläche prüft vorher, damit niemand erst Dateien lädt und dann scheitert.
// ── App ohne Agent: Weichen (24.11.2026, backend.js planAllows/planStatus, Admin → Abo → „App ohne Agent“) ─────────────────────
// In der Beta nie zu sehen. Gesperrtes bleibt im Menü sichtbar; Antippen zeigt, dass es mit dem Agenten geht, + Knopf zur
// Installationsanleitung — ohne Preis, ohne Kaufknopf, ohne „kaufen/Abo/Upgrade“ (Store-Regeln, memory app-abo-grenzen-plan).
// Im Agenten (AMP.agent) gilt weiter sein eigener Plan (ampFeat unten, Texte agent-i18n).
const APL_FS = ['models', 'slice', 'own_slicer', 'plates', 'editor', 'stats', 'printers'];
const aplApp = () => !AMP.agent && !!AMP.plan;
const aplGuideUrl = () => `https://allmyprinters.com/${['de', 'en', 'fr', 'es', 'it', 'nl'].includes(LANG) ? LANG : 'en'}/agent/install/`;
const aplP = f => { const n = AMP.plan ? AMP.plan.status().printers : null; return t('amp_apl_' + f + '_p', { n: n == null ? '' : n }); };
const aplGo = () => `<a class="btn pri amp-apl-go" href="${aplGuideUrl()}" target="_blank" rel="noopener">${esc(t('amp_apl_btn'))}</a>`;
/** Hinweis als Fenster (gesperrte Aktion: Drucker hinzufügen, Slicen, Platte speichern, eigener Slicer) */
window.ampPlanHint = f => {
  if (!APL_FS.includes(f)) return;
  let d = document.getElementById('amp-apl');
  if (d && d.open) return;
  if (!d) { d = document.createElement('dialog'); d.id = 'amp-apl'; d.className = 'dlg amp-apl-dlg'; document.body.appendChild(d); }
  d.dataset.f = f;
  d.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_apl_' + f + '_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b amp-apl"><p>${esc(aplP(f))}</p><p class="hint">${esc(t('amp_apl_more'))}</p></div>
    <div class="dlg-f">${aplGo()}</div>`;
  d.querySelectorAll('[data-x]').forEach(b => b.onclick = () => d.close());
  d.querySelector('.amp-apl-go').addEventListener('click', () => setTimeout(() => d.close(), 300));
  d.showModal();
};
/** Hinweis als Seite (gesperrte Ansicht: Modellsuche, Statistik) */
function ampPlanPage(f) {
  view.innerHTML = `<section class="card amp-card amp-apl amp-apl-page" data-f="${f}"><h1>${esc(t('amp_apl_' + f + '_h'))}</h1><p>${esc(aplP(f))}</p>
    <p class="hint">${esc(t('amp_apl_more'))}</p><div class="amp-acts">${aplGo()}</div></section>`;
}
/** Ansicht gesperrt? Dann Hinweisseite zeigen und true (nur App ohne Agent) */
async function ampAplLocked(f) {
  if (!aplApp()) return false;
  await AMP.plan.ready();
  if (AMP.plan.allows(f)) return false;
  ampPlanPage(f); return true;
}
/** Aktion gesperrt? Dann Hinweisfenster und true (nur App ohne Agent) */
async function ampAplDenied(f) {
  if (!aplApp()) return false;
  await AMP.plan.ready();
  if (AMP.plan.allows(f)) return false;
  ampPlanHint(f); return true;
}
/** Gesperrt: in der App Hinweis auf den Agenten, im Agenten wie bisher „gehört zum Abo“ */
const ampPlanDeny = f => { if (aplApp()) ampPlanHint(f); else toast(t('err_plan')); };
/** Mindestversion (Admin → Abo → „App ohne Agent“): ältere App → Seite „Bitte aktualisieren“ mit Store-Knopf und Sicherung. */
async function ampUpdLock() {
  if (!aplApp()) return;
  await AMP.plan.ready();
  const s = AMP.plan.status();
  let d = document.getElementById('amp-upd');
  if (!s.min) { if (d) d.remove(); return; }
  if (d) return;
  d = document.createElement('div');
  d.id = 'amp-upd'; d.className = 'amp-plan-lock'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
  const upd = /^https:\/\/[^\s"<>]+$/i.test(s.upd || '') ? s.upd : '';
  d.innerHTML = `<div class="amp-plan-lockc"><h2>${esc(t('amp_upd_h'))}</h2><p>${esc(t('amp_upd_p'))}</p><p class="hint">${esc(t('amp_upd_ver', { v: s.version, m: s.min }))}</p>
    <div class="amp-acts">${upd ? `<button type="button" class="btn pri" id="updgo">${esc(t('amp_upd_btn'))}</button>` : ''}<button type="button" class="btn" id="updexp">${esc(t('amp_export'))}</button></div></div>`;
  document.body.appendChild(d);
  if (upd) d.querySelector('#updgo').onclick = () => AMP.native('open', { url: upd }).catch(() => {});
  d.querySelector('#updexp').onclick = async () => {
    try { const x = await api('amp_export', {}); const r = await AMP.native('export', { name: 'allmyprinters-' + new Date().toISOString().slice(0, 10) + '.json', text: x.text }); if (r && r.ok) toast(t('amp_saved')); } catch (e) { fail(e); }
  };
}
if (aplApp()) {
  setTimeout(ampUpdLock, 1200);
  AMP.on('plan', () => {
    ampUpdLock();
    const pg = document.querySelector('#view .amp-apl-page');   // Hinweisseite offen, Funktion inzwischen frei → Ansicht neu zeichnen
    if (pg && AMP.plan.allows(pg.dataset.f)) render();
  });
  AMP.on('plan_hint', d => ampPlanHint(d && d.f));   // backend.js: gesperrte Aktion (Slicen, Drucker hinzufügen, Platte speichern …)
}

let ampFeatC = null;
async function ampFeat(k) {
  if (aplApp()) { await AMP.plan.ready(); return AMP.plan.allows(k); }   // App ohne Agent (24.11.2026)
  if (!AMP.agent || !AMP.remote) return true;
  try { if (!ampFeatC || Date.now() - ampFeatC.at > 60000) ampFeatC = { at: Date.now(), s: await AMP.remote('plan_status') }; } catch (e) { return true; }
  return !(ampFeatC.s && ampFeatC.s.f && ampFeatC.s.f[k] === false);
}
const ampPlateAllowed = async () => { if (await ampFeat('plates')) return true; ampPlanDeny('plates'); return false; };
/** Dateien der Teile holen (wie „Drucken“ einer Datei, mit NAS-Fehlern) → [{ id, name, n, slot, file }] */
async function ampPlateFetch(parts, prog) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (prog) prog(i + 1, parts.length);
    const r = await fetch('api.php?a=lib_get&id=' + p.id, { credentials: 'same-origin', headers: AUTH });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (x) {} throw Object.assign(new Error(j.error || 'http_' + r.status), { status: j.status || 0, part: p.name }); }
    const blob = await r.blob();
    out.push({ ...p, file: new File([blob], `${p.name}.${p.ext === '3mf' ? '3mf' : 'stl'}`, { type: 'application/octet-stream', lastModified: Date.now() }) });
  }
  return out;
}
const ampPlateErr = e => /^lib_dav_/.test(String(e && e.message)) ? t('amp_dav_err_' + e.message.slice(8), { s: e.status || '' }) : t('amp_plate_load_fail', { name: (e && e.part) || '?' });
/** Geholte Teile an die Druckansicht übergeben (/filament viewPrint, build_web.py-Patch liest h.files/h.parts/plateId) */
function ampPlateGo(items, plate, printer) {
  const first = items[0];
  lb.hand = { printer: printer || null, id: plate ? plate.id : first.id, name: plate ? plate.name : items.length > 1 ? t('amp_plate_n_models', { n: items.length }) : first.name, plate: 1,
              file: first.file, files: items.map(x => x.file), parts: items.map(x => ({ id: x.id, n: x.n || 1, slot: x.slot ?? '' })), plateId: plate ? plate.id : null };
  if (dlg.open) dlg.close();
  location.hash = 'print';
}
/** Auswahl → Teile: STL-Dateien einzeln, gespeicherte Platten mit ihren Teilen; gleiche Datei nur einmal (Anzahl addiert) */
function ampPlatePartsOf(sel) {
  const parts = [], skip = [];
  const add = (id, name, n, slot, inst, sup) => { const o = parts.find(x => x.id === id); if (o) { o.n = Math.min(100, o.n + n); o.inst = null; } else parts.push({ id, name, n, slot, inst: inst || null, sup: sup || '' }); };
  const lone = sel.length === 1;   // nur bei einer einzelnen Platte bleibt deren Anordnung (Editor), sonst ordnet der Editor neu an
  for (const f of sel) {
    if (f.plate) f.parts.filter(p => p.ok).forEach(p => add(p.id, p.name, p.n || 1, p.slot || '', lone ? p.inst : null, lone ? p.sup : ''));
    else if (ampPlateOk(f)) add(f.id, f.name, 1, '');
    else skip.push(f);
  }
  return { parts, skip };
}
/** Collage der Teilbilder als Bild der Platte (PNG, 480 px): 1 Bild groß, 2 nebeneinander, bis 4 im 2×2-, sonst im 3×3-Raster */
async function ampPlateThumb(parts, files) {
  const ims = [];
  for (const p of parts) {
    const f = files.find(x => x.id === p.id), th = f && (f.plates || []).find(x => x.thumb);
    if (!th) continue;
    const im = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = `api.php?a=lib_thumb&id=${f.id}&n=${th.n}&v=${f.v || 1}`; });
    if (im && im.naturalWidth) ims.push(im);
    if (ims.length >= 9) break;
  }
  if (!ims.length) return null;
  const S_ = 480, n = ims.length, cols = n === 1 ? 1 : n <= 4 ? 2 : 3, rows = n === 2 ? 1 : Math.ceil(n / cols);
  const cw = S_ / cols, ch = n === 2 ? S_ : S_ / rows, oy = n === 2 ? 0 : (S_ - ch * rows) / 2;
  const c = document.createElement('canvas'); c.width = c.height = S_;
  const x = c.getContext('2d');
  ims.forEach((im, i) => {
    const cx = (i % cols) * cw, cy = oy + Math.floor(i / cols) * ch, pad = 6;
    const k = Math.min((cw - pad * 2) / im.naturalWidth, (ch - pad * 2) / im.naturalHeight), w = im.naturalWidth * k, h = im.naturalHeight * k;
    x.drawImage(im, cx + (cw - w) / 2, cy + (ch - h) / 2, w, h);
  });
  try { return c.toDataURL('image/png'); } catch (e) { return null; }
}
/** Druckansicht, Liste der STL (renderStls-Patch): „Aus der Bibliothek“ und „Als Platte speichern“ bzw. „Platte speichern“ */
function ampStlExtra(box, L, ctx) {
  const more = box.querySelector('#pstlmore'); if (!more) return;
  const row = document.createElement('div'); row.className = 'amp-stlx';
  more.replaceWith(row); row.appendChild(more);
  row.insertAdjacentHTML('beforeend', `<button type="button" class="btn sm" id="amppllib">${I_LIB} ${esc(t('amp_plate_from_lib'))}</button>`);
  const lib = ctx.lib(), pid = lib && lib.plateId, allLib = L.length > 0 && L.every(x => x.lib);
  if (allLib && (L.length > 1 || pid)) row.insertAdjacentHTML('beforeend', `<button type="button" class="btn sm" id="ampplsave">${I_PLATE} ${esc(t(pid ? 'amp_plate_update' : 'amp_plate_save'))}</button>`);
  else if (L.length > 1 && L.some(x => x.lib)) row.insertAdjacentHTML('afterend', `<p class="hint">${esc(t('amp_plate_lib_only'))}</p>`);
  row.insertAdjacentHTML('beforeend', `<button type="button" class="btn sm" id="ampplsedit">${I_PEN} ${esc(t('amp_ed_edit'))}</button>`);
  row.querySelector('#ampplsedit').onclick = () => { const lib = ctx.lib();
    ampEdOpen(L.map(x => ({ id: x.lib || null, name: x.file.name.replace(/\.stl$/i, ''), file: x.file, n: x.copies || 1, slot: x.slot || '' })), lib && lib.plateId ? (lb.d && lb.d.files || []).find(f => f.id === lib.plateId) || { id: lib.plateId, name: lib.name } : null, (view.querySelector('input[name="printer"]:checked') || {}).value || null); };
  row.querySelector('#amppllib').onclick = async () => { if (await ampPlateAllowed()) ampPlatePick(L, ctx); };
  const sv = row.querySelector('#ampplsave'); if (sv) sv.onclick = async () => { if (await ampPlateAllowed()) ampPlateSaveDlg(L, ctx); };
}
/** Druckansicht: STL aus der Bibliothek dazunehmen (Mehrfachauswahl, Suche) */
async function ampPlatePick(L, ctx) {
  let d; try { d = await api('lib_list'); } catch (e) { fail(e); return; }
  const files = (d.files || []).filter(ampPlateOk).sort((a, b) => lbCmp(a.name, b.name));
  const have = new Set(L.map(x => x.lib).filter(Boolean)), room = PLATE_MAX - L.length, sel = new Set();
  const pic = f => { const th = (f.plates || []).find(x => x.thumb); return th ? `<img src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=${th.n}&amp;v=${f.v || 1}" alt="" loading="lazy">` : I_BOX; };
  dlg.innerHTML = `<form method="dialog" class="amp-plpick"><div class="dlg-h"><b>${esc(t('amp_plate_pick_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">${files.length ? `<input class="in" type="search" id="ampplq" placeholder="${esc(t('lib_search'))}" aria-label="${esc(t('lib_search'))}" autocomplete="off">
      ${room < files.length ? `<p class="hint">${esc(t('psd_stl_max', { n: PLATE_MAX }))}</p>` : ''}
      <div class="amp-plpl" id="ampplpl">${files.map(f => `<button type="button" class="amp-plpi" data-id="${f.id}" aria-pressed="false" data-q="${esc([f.name, f.folder, (f.tags || []).join(' ')].join(' ').toLowerCase())}">
        <span class="amp-chk" aria-hidden="true"></span><span class="pic">${pic(f)}</span>
        <span class="t"><b>${esc(f.name)}</b><small>${esc([f.folder, fsize(f.size), have.has(f.id) ? t('amp_plate_on') : ''].filter(Boolean).join(' · '))}</small></span></button>`).join('')}</div>`
      : `<p class="hint">${esc(t('amp_plate_pick_none'))}</p>`}</div>
    <div class="dlg-f"><button type="button" class="btn" data-x>${esc(t('cancel'))}</button>
      <button type="button" class="btn pri" id="ampplgo" disabled>${esc(t('amp_plate_pick_add', { n: 0 }))}</button></div></form>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const go = dlg.querySelector('#ampplgo');
  const upd = () => { go.disabled = !sel.size; go.textContent = t('amp_plate_pick_add', { n: sel.size }); };
  dlg.querySelectorAll('.amp-plpi').forEach(b => b.onclick = () => {
    const id = +b.dataset.id;
    if (sel.has(id)) sel.delete(id); else if (sel.size < room) sel.add(id); else { toast(t('psd_stl_max', { n: PLATE_MAX })); return; }
    b.setAttribute('aria-pressed', sel.has(id)); b.classList.toggle('amp-on', sel.has(id)); b.querySelector('.amp-chk').innerHTML = sel.has(id) ? I_CHECK : '';
    upd();
  });
  const q = dlg.querySelector('#ampplq');
  if (q) q.oninput = () => { const v = q.value.trim().toLowerCase(); dlg.querySelectorAll('.amp-plpi').forEach(b => { b.hidden = !!v && !b.dataset.q.includes(v); }); };
  go.onclick = async () => {
    const parts = files.filter(f => sel.has(f.id)).map(f => ({ id: f.id, name: f.name, n: 1, slot: '' }));
    go.disabled = true;
    try {
      const items = await ampPlateFetch(parts, (i, n) => { go.textContent = t('amp_plate_loading', { i, n }); });
      items.forEach(x => L.push({ file: x.file, copies: 1, slot: '', lib: x.id }));
      dlg.close(); ctx.redraw();
    } catch (e) { upd(); toast(ampPlateErr(e)); }
  };
}
/** „Als Platte speichern“: Name + Ordner, Collage als Bild; danach zählt jeder Druck auch im Druckbuch der Platte */
async function ampPlateSaveDlg(L, ctx) {
  let d; try { d = await api('lib_list'); } catch (e) { fail(e); return; }
  const files = d.files || [], lib = ctx.lib(), pid = lib && lib.plateId, cur = pid ? files.find(x => x.id === pid) : null;
  const parts = L.filter(x => x.lib).map(x => ({ id: x.lib, n: x.copies, slot: x.slot || '' }));
  const fo = [...new Set(parts.map(p => (files.find(x => x.id === p.id) || {}).folder || ''))];
  const nm0 = L[0].file.name.replace(/\.stl$/i, '');
  const name = cur ? cur.name : L.length > 1 ? `${nm0} + ${L.length - 1}` : nm0, folder = cur ? cur.folder || '' : fo.length === 1 ? fo[0] : '';
  dlg.innerHTML = `<form method="dialog" class="amp-plsave"><div class="dlg-h"><b>${esc(t(pid ? 'amp_plate_update' : 'amp_plate_save'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p class="hint">${esc(t('amp_plate_save_hint'))}</p>
      <label class="fld"><span>${esc(t('lib_name'))}</span><input class="in" id="ampplnm" maxlength="120" value="${esc(name)}" autocomplete="off"></label>
      <label class="fld"><span>${esc(t('lib_folder'))}</span><input class="in" id="ampplfo" list="ampplfl" maxlength="160" value="${esc(folder)}" placeholder="${esc(t('amp_lib_folder_ph'))}" autocomplete="off"></label>
      <datalist id="ampplfl">${lbPaths(files).map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <p class="hint">${esc(t('amp_plate_parts', { n: parts.length }))} · ${esc(L.map(x => `${x.copies}× ${x.file.name.replace(/\.stl$/i, '')}`).join(', '))}</p></div>
    <div class="dlg-f"><button type="button" class="btn" data-x>${esc(t('cancel'))}</button><button type="submit" class="btn pri" id="ampplok">${esc(t('save'))}</button></div></form>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const fm = dlg.querySelector('form'), ok = dlg.querySelector('#ampplok');
  fm.onsubmit = async e => {
    e.preventDefault();
    ok.disabled = true;
    try {
      const thumb = await ampPlateThumb(parts, files);
      const r = await api('amp_lib_plate_save', { id: pid || null, name: dlg.querySelector('#ampplnm').value.trim(), folder: dlg.querySelector('#ampplfo').value.trim(), parts, thumb });
      if (r.error) throw new Error(r.error);
      const l = ctx.lib();
      if (l) l.plateId = r.file.id; else ctx.setLib({ id: r.file.id, plateId: r.file.id, name: r.file.name, file: L[0].file, plate: 1 });
      dlg.close(); toast(t('amp_plate_saved', { name: r.file.name })); ctx.redraw();
    } catch (er) { ok.disabled = false; fail(er); }
  };
}
/** Bibliothek → Platte: Vorschau (Collage) und Teile */
function ampPlatePv(f) {
  const img = f.thumbs ? `<img src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=1&amp;v=${f.v}" alt="">` : `<span class="lbnone">${I_PLATE}<span>${esc(t('amp_plate_badge'))}</span></span>`;
  const miss = f.parts.filter(p => !p.ok).length;
  return `<div class="amp-plpv">${img}</div>
    <section class="amp-lbsec"><h3>${esc(t('amp_plate_parts_h'))}</h3><ul class="amp-plparts">${f.parts.map(p => `<li class="${p.ok ? '' : 'off'}">
      <span class="pic">${p.thumb ? `<img src="api.php?a=lib_thumb&amp;id=${p.id}&amp;n=1&amp;v=${p.v}" alt="" loading="lazy">` : I_BOX}</span>
      <span class="t"><b>${esc(p.name)}</b>${p.ok ? '' : `<small>${esc(t('amp_plate_missing'))}</small>`}</span><span class="n">${p.n}×</span></li>`).join('')}</ul>
      <p class="hint">${esc(t(miss ? 'amp_plate_missing_hint' : 'amp_ed_plate_hint'))}</p></section>`;
}

// ── Vorschau in Filamentfarbe (18.11.2026, User: „ist es möglich die ausgewählte Farbe gleich am Modell richtig anzuzeigen?“) ──
// Einfarbig: Vorschau in der Farbe des gewählten Fachs (viewer.js tint), Umschalter „Filamentfarbe / Linienarten“ in der Legende,
// Wahl gemerkt (localStorage amp_pv_col). Mehrfarbig (r.paint) färbt der Slicer schon nach Fach; ohne Fachfarbe (Materialwahl) wie bisher.
let ampPvMode = (() => { try { return localStorage.getItem('amp_pv_col') || 'fil'; } catch (e) { return 'fil'; } })();
function ampPrevTint(r, lg) {
  if (!ps.viewer || !ps.viewer.tint) return;
  const pk = (view.querySelector('input[name=printer]:checked') || {}).value;
  const p = ((ps.data || {}).printers || []).find(x => x.key === pk);
  const si = (view.querySelector('input[name=slot]:checked') || {}).value;
  const sl = !r.paint && p && p.slot_mode !== 'material' ? (p.slots || []).find(z => String(z.index) === String(si)) : null;
  const col = sl && /^#[0-9a-f]{6}$/i.test(sl.color || '') ? sl.color : null;
  if (!col) { ps.viewer.tint(null); return; }
  const base = lg.dataset.base;
  const draw = () => {
    ps.viewer.tint(ampPvMode === 'fil' ? col : null);
    lg.innerHTML = `<span class="seg amp-pvseg" role="group"><button type="button" data-pv="fil" class="${ampPvMode === 'fil' ? 'on' : ''}">${esc(t('amp_pv_fil'))}</button>`
      + `<button type="button" data-pv="lines" class="${ampPvMode !== 'fil' ? 'on' : ''}">${esc(t('amp_pv_lines'))}</button></span>`
      + (ampPvMode === 'fil' ? `<span><i style="background:${esc(col)}"></i>${esc(tf('pc_slot_n', sl.label) + (sl.material ? ' · ' + sl.material : ''))}</span>` : base);
    lg.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => { ampPvMode = b.dataset.pv; try { localStorage.setItem('amp_pv_col', ampPvMode); } catch (e) {} draw(); });
  };
  draw();
}

function lbBind() {
  const inp = $('#lbfile'), dz = $('#lbdrop');
  if (inp) inp.onchange = () => { const fl = [...inp.files]; inp.value = ''; ampLibAdd(fl); };   // ZIP → Teile in den Ordner der ZIP (23.11.2026)
  if (dz && inp && !inp.disabled) {
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('over')));
    dz.addEventListener('drop', e => { e.preventDefault(); ampLibAdd(e.dataTransfer.files); });
  }
  // Ansicht bzw. Ordner wählen (Seitenleiste, Dropdown, Brotkrumen): das eine setzt das andere zurück
  view.querySelectorAll('.amp-lbmain [data-f], .amp-lbside [data-f]').forEach(b => b.onclick = () => { lb.folder = b.dataset.f; lb.view = 'all'; pref('lib_f', lb.folder); drawLib(); window.scrollTo(0, 0); });
  view.querySelectorAll('[data-lv]').forEach(b => b.onclick = () => { lb.view = b.dataset.lv; lb.folder = '*'; pref('lib_f', '*'); drawLib(); window.scrollTo(0, 0); });
  view.querySelectorAll('[data-tg]').forEach(b => b.onclick = () => { lb.tag = lb.tag && lb.tag.toLowerCase() === b.dataset.tg.toLowerCase() ? null : b.dataset.tg; drawLib(); });
  if ($('#amplbtag')) $('#amplbtag').onchange = e => { lb.tag = e.target.value || null; drawLib(); };
  if ($('#amplbfit')) $('#amplbfit').onchange = e => { lb.fit = e.target.value || ''; pref('lib_fit', lb.fit); drawLib(); };
  if ($('#amplbhdadd')) $('#amplbhdadd').onclick = () => { const i = $('#lbfile'); if (i) i.click(); };
  if ($('#amplbhdplate')) $('#amplbhdplate').onclick = () => { lb.sel = new Set(); lb.mode = ''; drawLib(); toast(t('amp_plate_pick_more')); };
  if ($('#amplbnew')) $('#amplbnew').onclick = () => ampEdNew();   // Neue Platte: leerer Editor (19.11.2026)
  // Bibliothek-Umbau (19.11.2026): Dateityp, Passt auf, alle Tags, ×-Chips, Kästen auf/zu merken
  const tySave = () => pref('lib_types', [...lb.types].join(','));
  view.querySelectorAll('[data-ty]').forEach(b => b.onclick = () => { const k = b.dataset.ty; if (lb.types.has(k)) lb.types.delete(k); else lb.types.add(k); tySave(); drawLib(); });
  if ($('#amplbtype')) $('#amplbtype').onchange = e => { lb.types = new Set(e.target.value ? [e.target.value] : []); tySave(); drawLib(); };
  view.querySelectorAll('.amp-lbside [data-fit]').forEach(b => b.onclick = () => { lb.fit = b.dataset.fit || ''; pref('lib_fit', lb.fit); drawLib(); });
  view.querySelectorAll('[data-alltags]').forEach(b => b.onclick = () => { lb.allTags = true; drawLib(); });
  view.querySelectorAll('.amp-lbsec2').forEach(d => d.addEventListener('toggle', () => { lb.closed = lb.closed || {}; lb.closed[d.dataset.sec] = !d.open; }));
  view.querySelectorAll('[data-lclr]').forEach(b => b.onclick = () => { const k = b.dataset.lclr;
    if (k === 'all') { lb.types.clear(); lb.fit = ''; lb.tag = null; lb.folder = '*'; lb.view = 'all'; lb.q = ''; pref('lib_fit', ''); pref('lib_f', '*'); }
    else if (k.startsWith('ty:')) lb.types.delete(k.slice(3)); else if (k === 'fit') { lb.fit = ''; pref('lib_fit', ''); } else if (k === 'tag') lb.tag = null;
    else if (k === 'folder') { lb.folder = '*'; pref('lib_f', '*'); } else if (k === 'view') lb.view = 'all'; else if (k === 'q') lb.q = '';
    tySave(); drawLib(); });
  view.querySelectorAll('[data-again]').forEach(b => b.onclick = () => { const f = lb.d.files.find(x => x.id === +b.dataset.again); if (f) ampLibPrint(f, { btn: b, lbl: b.querySelector('span') }); });
  const qi = $('#lbq');
  if (qi) qi.oninput = () => {   // nur neu zeichnen und Fokus zurück, sonst verliert das Suchfeld beim Tippen den Fokus
    lb.q = qi.value;
    const keep = lb.q; drawLib();
    const n = $('#lbq'); if (n) { n.focus(); n.setSelectionRange(keep.length, keep.length); }
  };
  if ($('#lbsort')) $('#lbsort').onchange = e => { lb.sort = e.target.value; pref('lib_s', lb.sort); drawLib(); };
  if ($('#amplbselbtn')) $('#amplbselbtn').onclick = () => { lb.sel = lb.sel ? null : new Set(); lb.mode = ''; drawLib(); };
  if ($('#amplbfb')) $('#amplbfb').onclick = () => { lb.fopen = !lb.fopen; const f = view.querySelector('.amp-lbf'); if (f) f.classList.toggle('amp-fopen', lb.fopen); $('#amplbfb').setAttribute('aria-expanded', String(lb.fopen)); };
  view.querySelectorAll('#amplbsel [data-sa]').forEach(b => b.onclick = () => ampLibSelAct(b.dataset.sa));
  const si = $('#amplbselin');
  if (si) si.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ampLibSelAct(lb.mode === 'move' ? 'move_go' : 'tag_add'); } };
  view.querySelectorAll('.lbcard').forEach(c => c.onclick = e => {
    const id = +c.dataset.id, f = lb.d.files.find(x => x.id === id);
    const qa = e.target.closest && e.target.closest('[data-qa]');
    if (qa && f) {   // Schnellaktionen der Karte (Desktop, beim Darüberfahren)
      e.stopPropagation();
      if (qa.dataset.qa === 'plate') ampLibToPlate(f);
      else if (qa.dataset.qa === 'edit') { qa.disabled = true; ampEdFromLib([{ id: f.id, name: f.name, n: 1, slot: '', ext: f.ext, plate3: 1 }], null, { printer: f.last && f.last.pid ? 'moonraker:' + f.last.pid : null }).then(ok => { if (!ok) qa.disabled = false; }); }
      else ampLibPrint(f, { btn: qa, lbl: qa.querySelector('span') });
      return;
    }
    if (lb.sel) { lb.sel.has(id) ? lb.sel.delete(id) : lb.sel.add(id); if (lb.mode === 'del') lb.mode = ''; drawLib(); return; }
    if (f) libOpen(f);
  });
  lbUpBox();
}

// Eine Datei: Vorschau (Bild bzw. 3D), Name, Ordner, Tags, Notizen, Foto vom Druck, Druckbuch, Speichern unter, drucken, löschen
function libOpen(f) {
  if (lb.viewer) { lb.viewer.destroy(); lb.viewer = null; }
  lb.cur = f.id;
  const plates = (f.plates || []).filter(p => !p.empty);
  const canPrint = f.print && ps_ok();
  let plate = plates.length ? plates[0].n : 1;
  const tools = Object.keys(LB_VIEWS).map(k => `<button type="button" class="icon-btn" data-view="${k}" title="${esc(t('lib_v_' + k))}" aria-label="${esc(t('lib_v_' + k))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LB_VIEWS[k]}</svg></button>`).join('');
  let pv;
  lb.ampPlate = null;
  if (f.want) pv = ampWantPv(f);
  else if (f.plate) pv = ampPlatePv(f);
  else if (!(f.mesh && f.preview === 'ok')) pv = ampLibPv(f, plates);
  else if (plates.length) {
    pv = `${plates.length > 1 ? `<div class="chips lbpls">${plates.map(p => `<button type="button" class="chip${p.n === plate ? ' on' : ''}" data-n="${p.n}">${esc(t('psd_pl_n', { n: p.n }))}${p.name ? ` · ${esc(p.name)}` : ''}</button>`).join('')}</div>` : ''}
      <div class="lbv" id="lbv"><div class="lbv-tools">${tools}</div><div class="lbv-msg" id="lbvmsg"><span class="spin"></span></div></div><p class="hint lbinfo" id="lbinfo"></p>`;
  } else pv = `<div class="lbnone">${I_BOX}<span>${esc(t('lib_preview_fail'))}</span></div>`;
  let tags = (f.tags || []).slice();
  // Fakten (Bibliothek neu, 18.11.2026): Maße, „passt auf“ je Drucker mit bekannten Bettmaßen, letzter Druck
  const fdims = f.want ? [] : lbDimsOf(f), fbeds = lb.beds || [];
  const facts = f.want ? '' : [
    fdims.length && !f.plate && !(f.mesh && f.preview === 'ok') ? `<div><span>${esc(t('amp_lib_dims'))}</span><b>${esc(lbDimTxt(fdims[0]))}${fdims.length > 1 ? ' …' : ''}</b></div>` : '',
    f.last ? `<div><span>${esc(t('amp_lib_last'))}</span><b>${esc([f.last.at ? ago(f.last.at) : '', f.last.printer].filter(Boolean).join(' · '))}</b></div>` : '',
    fdims.length && fbeds.length ? `<div class="amp-lbfits">${fbeds.map(p => { const ok = lbFitOf(f, p.bed); return `<span class="tag ${ok ? 'amp-fit' : 'amp-nofit'}">${esc(t(ok ? 'amp_lib_fit_ok' : 'amp_lib_fit_no', { p: p.name }))}</span>`; }).join('')}</div>` : ''
  ].filter(Boolean).join('');
  const ph = f.photo ? `<img src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=0&amp;v=${f.v}" alt="">` : '';
  dlg.innerHTML = `<form method="dialog" class="lbf" id="lbf"><div class="dlg-h"><b id="lbname">${esc(f.name)}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">${pv}${facts ? `<div class="amp-lbfacts">${facts}</div>` : ''}
      <div class="lbmeta"><label class="fld"><span>${esc(t('lib_name'))}</span><input class="in" data-k="name" maxlength="120" value="${esc(f.name)}" autocomplete="off"></label>
        <label class="fld"><span>${esc(t('lib_folder'))}</span><input class="in" data-k="folder" list="lbfl" maxlength="160" value="${esc(f.folder || '')}" placeholder="${esc(t('amp_lib_folder_ph'))}" autocomplete="off"></label></div>
      <p class="hint lbfhint">${esc(t('amp_lib_folder_hint'))}</p>
      <div class="fld amp-tagf"><span>${esc(t('amp_lib_tags'))}</span><div class="in amp-tagbox" id="amptagbox"><span id="amptags"></span><input id="amptagin" list="lbtl" maxlength="30" placeholder="${esc(t('amp_lib_tag_ph'))}" autocomplete="off" enterkeyhint="done"></div></div>
      <label class="fld amp-notef"><span>${esc(t('amp_lib_notes'))}</span><textarea class="in" data-k="notes" rows="3" maxlength="4000" placeholder="${esc(t('amp_lib_notes_ph'))}">${esc(f.notes || '')}</textarea></label>
      <div class="amp-lbsave"><button type="button" class="btn" id="lbsave" disabled><span>${esc(t('save'))}</span></button></div>
      <datalist id="lbfl">${lbPaths(lb.d.files).map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <datalist id="lbtl">${lbAllTags(lb.d.files).map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      ${f.want ? `<p class="hint">${esc(t('amp_want_since', { d: date(f.created) }))}</p>` : f.plate ? `<p class="hint">${esc([t('amp_plate_parts', { n: f.parts.length }), t('lib_added', { d: date(f.created) }), f.printed ? t('lib_printed_at', { d: date(f.printed) }) : ''].filter(Boolean).join(' · '))}</p>` : `<p class="hint">${esc([f.orig, fsize(f.size), t('lib_added', { d: date(f.created) }), f.printed ? t('lib_printed_at', { d: date(f.printed) }) : '', ampLibWhereTxt(f)].filter(Boolean).join(' · '))}</p>${ampRemoteLine(f)}`}
      ${f.want ? '' : `<section class="amp-lbsec"><h3>${esc(t('amp_lib_photo'))}</h3><div class="amp-lbphoto">${ph ? `<span class="amp-lbph">${ph}</span>` : ''}<div>
        <p class="hint">${esc(t(f.photo ? 'amp_lib_photo_on' : 'amp_lib_photo_hint'))}</p>
        <label class="btn sm"><input type="file" id="amplbph" accept="image/*" hidden>${esc(t(f.photo ? 'amp_lib_photo_change' : 'amp_lib_photo_add'))}</label>
        ${f.photo ? `<button type="button" class="btn sm ghost" id="amplbphdel">${esc(t('amp_lib_photo_del'))}</button>` : ''}</div></div></section>
      <section class="amp-lbsec"><h3>${esc(t('amp_lib_book'))}</h3><div id="amplbbook"><span class="spin"></span></div></section>`}</div>
    <div class="dlg-f lbf-f"><button type="button" class="btn ghost" id="lbdel">${I_TRASH}<span>${esc(t(f.want ? 'amp_want_del' : 'lib_delete'))}</span></button><span class="grow"></span>
      <button type="button" class="btn lbclose" data-x>${esc(t('close'))}</button>
      ${f.want || f.plate ? '' : `<button type="button" class="btn" id="amplbsave">${I_DL} ${esc(t('amp_lib_saveas'))}</button>`}
      ${canPrint && f.ext === 'stl' && !f.gone ? `<button type="button" class="btn" id="amplbtoplate" title="${esc(t('amp_lib_toplate'))}">${I_PLATE} ${esc(t('amp_lib_toplate'))}</button>` : ''}
      ${canPrint && (((f.ext === 'stl' || (f.ext === '3mf' && !lbIsGc(f))) && !f.gone && !f.want) || (f.plate && f.parts.some(p => p.ok))) ? `<button type="button" class="btn" id="amplbedit">${I_PEN} <span>${esc(t('amp_ed_edit'))}</span></button>` : ''}
      ${canPrint ? `<button type="button" class="btn pri amp-lbpbtn" id="lbprint">${I_PRINTER_S} <span>${esc(t(lb.ampPlate && plates.length > 1 ? 'lib_print_plate' : 'lib_print', { n: lb.ampPlate }))}</span>${f.last && f.last.printer && !lbIsGc(f) ? `<small>${esc(t('amp_lib_print_on', { p: f.last.printer }))}</small>` : ''}</button>` : ''}</div></form>`;
  if (!dlg.open) {
    dlg.classList.add('wide');
    dlg.addEventListener('close', () => {
      if (lb.save) lb.save();   // Geändert, aber nicht gespeichert (× oder Esc): trotzdem sichern
      lb.save = lb.dirty = null;
      dlg.classList.remove('wide'); if (lb.viewer) { lb.viewer.destroy(); lb.viewer = null; } lb.cur = null;
    }, { once: true });
    dlg.showModal();
  }
  const fm = $('#lbf');
  fm.onsubmit = e => e.preventDefault();
  fm.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  // Name, Ordner, Tags, Notizen: ein Knopf „Speichern“, aktiv sobald sich etwas geändert hat; Schließen mit Änderungen speichert auch
  const fld = k => fm.querySelector(`[data-k="${k}"]`), sv = $('#lbsave'), tin = $('#amptagin');
  const tagKey = a => a.map(x => x.toLowerCase()).join('\n');
  const vals = () => ({ name: fld('name').value.trim(), folder: fld('folder').value.trim(), notes: fld('notes').value, tags });
  const dirty = () => { const v = vals(); return (v.name !== '' && v.name !== f.name) || v.folder !== (f.folder || '') || v.notes !== (f.notes || '') || tagKey(v.tags) !== tagKey(f.tags || []) || !!tin.value.trim(); };
  const mark = () => { const d = dirty(); sv.disabled = !d; sv.classList.toggle('pri', d); if (d) sv.innerHTML = `<span>${esc(t('save'))}</span>`; };
  const drawTags = () => {
    $('#amptags').innerHTML = tags.map((x, i) => `<span class="tag on amp-tagx">${esc(x)}<button type="button" data-tx="${i}" aria-label="${esc(t('amp_lib_tag_del'))}: ${esc(x)}">×</button></span>`).join('');
    $('#amptags').querySelectorAll('[data-tx]').forEach(b => b.onclick = () => { tags.splice(+b.dataset.tx, 1); drawTags(); mark(); });
  };
  const addTag = () => {
    const parts = tin.value.split(',').map(x => x.replace(/#/g, '').trim().slice(0, 30)).filter(Boolean);
    for (const x of parts) if (!tags.some(y => y.toLowerCase() === x.toLowerCase()) && tags.length < 20) tags.push(x);
    tin.value = ''; drawTags(); mark();
  };
  drawTags();
  tin.onkeydown = e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } else if (e.key === 'Backspace' && !tin.value && tags.length) { tags.pop(); drawTags(); mark(); } };
  tin.oninput = () => { if (tin.value.includes(',')) addTag(); else mark(); };
  tin.onchange = () => { if (tin.value.trim()) addTag(); };   // Auswahl aus der Vorschlagsliste
  $('#amptagbox').onclick = e => { if (e.target.id === 'amptagbox' || e.target.id === 'amptags') tin.focus(); };
  let saving = false;
  const save = async () => {
    if (tin.value.trim()) addTag();
    if (saving || !dirty()) return;
    const v = vals(), body = { id: f.id, folder: v.folder, tags: v.tags, notes: v.notes };
    if (v.name) body.name = v.name;
    saving = true; sv.disabled = true;
    try {
      const r = await api('lib_update', body);
      Object.assign(f, r.file); tags = (f.tags || []).slice();
      if (lb.cur === f.id && $('#lbname')) {
        $('#lbname').textContent = f.name; fld('name').value = f.name; fld('folder').value = f.folder || ''; fld('notes').value = f.notes || ''; drawTags();
        sv.classList.remove('pri'); sv.innerHTML = `${I_CHECK}<span>${esc(t('saved'))}</span>`;
      } else toast(t('saved'));
      if (view.querySelector('.lbtop')) drawLib();
    } catch (e) { sv.disabled = false; fail(e); }
    saving = false;
  };
  lb.save = save; lb.dirty = dirty;
  sv.onclick = save;
  fm.querySelectorAll('input[data-k]').forEach(inp => {
    inp.oninput = mark;
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  });
  fld('notes').oninput = mark;
  $('#lbdel').onclick = async e => {
    const b = e.currentTarget;
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.classList.add('danger'); b.querySelector('span').textContent = t('lib_delete_sure'); return; }   // zweiter Klick löscht
    try {
      const r = await api('lib_delete', { id: f.id });
      lb.d.files = lb.d.files.filter(x => x.id !== f.id); lb.d.used = r.used;
      lb.save = null; dlg.close(); toast(t('deleted')); drawLib();
    } catch (er) { fail(er); }
  };
  // Foto vom Druck: verkleinert (längste Seite 1280 px, JPEG) als Bild Nr. 0
  const phIn = $('#amplbph');
  if (phIn) phIn.onchange = async () => {
    const file = phIn.files && phIn.files[0]; phIn.value = '';
    if (!file) return;
    try {
      const b64 = await ampPhotoShrink(file, 1280);
      const r = await api('amp_lib_photo', { id: f.id, b64 });
      Object.assign(f, r.file); toast(t('saved'));
      if (lb.save) await lb.save();
      libOpen(f); if (view.querySelector('.lbtop')) drawLib();
    } catch (e) { toast(t('amp_lib_photo_err')); }
  };
  if ($('#amplbphdel')) $('#amplbphdel').onclick = async () => {
    try { const r = await api('amp_lib_photo', { id: f.id, remove: true }); Object.assign(f, r.file); if (lb.save) await lb.save(); libOpen(f); if (view.querySelector('.lbtop')) drawLib(); } catch (e) { fail(e); }
  };
  if (!f.want) ampLibBook(f);
  // Drucken: STL/3MF → Druckansicht (Slicen); G-Code → direkt senden (viewGcode), beides zählt ins Druckbuch
  // Drucken: gemeinsamer Ablauf (ampLibPrint) — Platte, G-Code direkt, sonst Druckansicht mit dem letzten Drucker vorgewählt.
  // NAS-Fehler fest im Dialog über den Knöpfen (ein Toast wäre für den Text zu kurz)
  if ($('#lbprint')) $('#lbprint').onclick = () => {
    const b = $('#lbprint'); document.getElementById('lbperr')?.remove();
    ampLibPrint(f, { btn: b, lbl: b.querySelector('span'), plate: lb.ampPlate || plate, err: msg => {
      const foot = b.closest('.dlg-f');
      if (foot) { foot.insertAdjacentHTML('beforebegin', '<div class="note err-note" id="lbperr"></div>'); document.getElementById('lbperr').textContent = msg; } else toast(msg);
    } });
  };
  if ($('#amplbtoplate')) $('#amplbtoplate').onclick = () => ampLibToPlate(f);
  // Platte bearbeiten (19.11.2026): Modell bzw. Platte mit ihren Teilen (und gespeicherter Anordnung) im Editor öffnen
  if ($('#amplbedit')) $('#amplbedit').onclick = async () => {
    const b = $('#amplbedit'), sp = b.querySelector('span'), b0 = sp.textContent; b.disabled = true;
    const list = f.plate ? f.parts.filter(p => p.ok).map(p => ({ id: p.id, name: p.name, n: p.n, slot: p.slot, inst: p.inst || null, sup: p.sup || '' })) : [{ id: f.id, name: f.name, n: 1, slot: '', ext: f.ext, plate3: lb.ampPlate || 1 }];
    const ok = await ampEdFromLib(list, f.plate ? f : null, { printer: f.last && f.last.pid ? 'moonraker:' + f.last.pid : null, prog: (i, n) => { sp.textContent = t('amp_plate_loading', { i, n }); } });
    if (!ok) { b.disabled = false; sp.textContent = b0; }
  };
  if (!$('#lbv') || !$('#lbvmsg')) return;
  if (!window.FMLibView) { $('#lbvmsg').textContent = t('lib_err_view'); return; }
  lb.viewer = window.FMLibView($('#lbv'));
  const show = async n => {
    plate = n;
    const p = plates.find(x => x.n === n) || plates[0];
    fm.querySelectorAll('.lbpls [data-n]').forEach(c => c.classList.toggle('on', +c.dataset.n === n));
    if ($('#lbprint') && plates.length > 1) $('#lbprint').querySelector('span').textContent = t('lib_print_plate', { n });
    $('#lbinfo').textContent = [p.dims ? t('lib_dims', { x: nf1.format(p.dims[0]), y: nf1.format(p.dims[1]), z: nf1.format(p.dims[2]) }) : '',
      p.objs > 1 ? t('lib_objs', { n: p.objs }) : '', t('lib_tris', { n: nf.format(p.src_tris || p.tris) }), p.dec ? t('lib_simplified') : ''].filter(Boolean).join(' · ');
    const msg = $('#lbvmsg'); msg.hidden = false; msg.innerHTML = '<span class="spin"></span>';
    try { await lb.viewer.load(`api.php?a=lib_mesh&id=${f.id}&n=${n}&v=${f.v}`); if (lb.cur === f.id && plate === n) msg.hidden = true; }
    catch (e) { console.error(e); msg.textContent = t('lib_err_view'); }
  };
  fm.querySelectorAll('.lbpls [data-n]').forEach(c => c.onclick = () => show(+c.dataset.n));
  fm.querySelectorAll('[data-view]').forEach(b => b.onclick = () => lb.viewer && lb.viewer.view(b.dataset.view));
  show(plate);
}
/** Druckbuch in den offenen Dialog: jeder Druck aus der Bibliothek wie unter Druckaufträge (jobRow), ältere nur gezählt */
async function ampLibBook(f) {
  let r;
  try { r = await api('amp_lib_book', { id: f.id }); } catch (e) { r = { jobs: [], before: 0 }; }
  const box = $('#amplbbook'); if (!box || lb.cur !== f.id) return;
  const ok = r.jobs.filter(j => j.status === 2).length, bad = r.jobs.filter(j => j.status === 3).length, gs = r.jobs.reduce((a, j) => a + (j.grams || 0), 0);
  box.innerHTML = (r.jobs.length ? `<p class="hint amp-booksum">${esc([t('amp_lib_book_ok', { n: ok }), bad ? t('amp_lib_book_fail', { n: bad }) : '', gs ? gUse(gs) : ''].filter(Boolean).join(' · '))}</p>
      <div class="amp-book">${r.jobs.map(jobRow).join('')}</div>` : `<p class="hint">${esc(t('amp_lib_book_none'))}</p>`)
    + (r.before ? `<p class="hint">${esc(t('amp_lib_book_before', { n: r.before }))}</p>` : '');
}
/** Bild verkleinern → data:image/jpeg (längste Seite max px) */
async function ampPhotoShrink(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}
// ── 3DSEARCH in der App (13.11.2026, User: „baus mal so“): Modelle suchen und merken (#models), gemerkte Einträge in der Bibliothek
// (Datei fehlt), Datei anhängen über „Datei auswählen“ oder „Teilen / Öffnen mit“. Keine Erkennung über Name/Zeitpunkt, kein
// Download-Ordner; die Datei lädt der Nutzer selbst auf der Plattform herunter. Daten: api/v1 von 3DSEARCH über backend.js.
const S3D_SRC = { printables: 'Printables', makerworld: 'MakerWorld', thingiverse: 'Thingiverse', cults3d: 'Cults3D', myminifactory: 'MyMiniFactory', thangs: 'Thangs',
  crealitycloud: 'Creality Cloud', makeronline: 'MakerOnline', sketchfab: 'Sketchfab', nexprint: 'NexPrint', grabcad: 'GrabCAD' };
const s3dName = k => S3D_SRC[k] || k || '3DSEARCH';
// Filter (13.11.2026, User: „besserer Filter wie auf 3DSEARCH, Downloads lassen wir weg“): Blatt mit Sortierung, Preis,
// Plattformen (mehrere) und Bereich (Hauptgruppen wie /categories, api/v1 group=). Gemerkt in pref ms_f.
const MS_SRC = Object.keys(S3D_SRC);
const MS_SORT = ['relevance', 'first_seen', 'likes', 'makes'];
const MS_GROUPS = ['printer', 'minis', 'toys', 'art', 'decor', 'fashion', 'home', 'organize', 'tools', 'tech', 'vehicles', 'outdoor', 'edu', 'music', 'other'];
const MS_F0 = { src: [], price: '', group: '', sort: 'relevance' };
const msF = (() => { try { const o = JSON.parse(pref('ms_f') || '{}');
  return { src: (Array.isArray(o.src) ? o.src : []).filter(k => MS_SRC.includes(k)), price: ['free', 'paid'].includes(o.price) ? o.price : '',
           group: MS_GROUPS.includes(o.group) ? o.group : '', sort: MS_SORT.includes(o.sort) ? o.sort : 'relevance' }; } catch (e) { return { ...MS_F0 }; } })();
const msFN = f => (f.src.length ? 1 : 0) + (f.price ? 1 : 0) + (f.group ? 1 : 0) + (f.sort !== 'relevance' ? 1 : 0);   // Plattformen zählen seit 18.11. als ein Filter
const I_FILTER2 = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
const I_FOLDER2 = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const I_MARK = on => `<svg viewBox="0 0 24 24" width="18" height="18" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>`;
const I_EXT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
// Modellsuche neu (14.11.2026, User: „Modellseite optimieren, so gut wie 3DSEARCH“ → alle 8 Punkte): Suchleiste oben und klebend,
// Schnellfilter als Chips, Vorschläge beim Tippen (Begriffe, Modelle, Designer, zuletzt gesucht), Startseite „Gerade beliebt“ +
// Bereiche statt Zufallsliste, Karten mit Plattform/Bezahlt/Likes/Makes und kleinerem Merken-Knopf, automatisch nachladen mit
// Platzhaltern, Modell-Dialog mit Ähnlichen/Tags/Designer, Bibliothek als ein Knopf neben der Suche.
// Die Leiste wird einmal gebaut, danach erneuern msDrawBar/msDrawBody nur ihre Teile — so bleibt das Suchfeld beim Laden bedienbar.
const ms = { q: '', designer: '', page: 1, pages: 0, found: 0, hits: [], err: '', loaded: false, loading: false, busy: false, gen: 0, trend: null, trendAt: 0, trendErr: '', fresh: null, freshPage: 0, freshPages: 0, freshErr: '', rel: [], listY: null, came: false,
  total: 0, cont: null, contAt: 0, trendAll: false, sbSrc: null, sbShut: new Set(['src', 'area']) };   // 18.11.2026: Zahl der Modelle, laufende Wettbewerbe, Seitenleiste; Plattformen + Bereiche anfangs zu (20.11.2026)
const MS_QSRC = ['printables', 'makerworld', 'thingiverse', 'cults3d', 'myminifactory', 'thangs', 'makeronline', 'crealitycloud', 'nexprint', 'grabcad', 'sketchfab'];
// Farben der Plattformen wie die Quellen-Symbole auf 3dsearch.net
const MS_COL = { thingiverse: '#248bfb', printables: '#fa6831', cults3d: '#d63384', makerworld: '#00ae42', myminifactory: '#2db280', makeronline: '#0096d6',
  grabcad: '#c4352c', crealitycloud: '#00a86b', sketchfab: '#1caad9', nexprint: '#e5399c', thangs: '#2f76ff' };
const msStart = () => !ms.q && !ms.designer && !msFN(msF);
const msImg = (u, cls) => u ? `<img${cls ? ` class="${cls}"` : ''} src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : I_BOX;
const msSvg = (d, w = 18) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I_HEART = msSvg('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>', 13);
const I_MAKE = msSvg('<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>', 13);
const I_CLOCK = msSvg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 16);
const I_USER = msSvg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>', 16);
// Symbole der 15 Bereiche (Hauptgruppen wie /categories)
const MS_GICON = {
  printer: msSvg('<path d="M4 3h16v18H4zM4 8h16"/><path d="M10.5 8v3l1.5 2 1.5-2V8M8 18h8"/>', 22),
  minis: msSvg('<circle cx="12" cy="6.5" r="3"/><path d="M7 21v-3.5a5 5 0 0 1 10 0V21M9.5 13.5 8 10M14.5 13.5 16 10"/>', 22),
  toys: msSvg('<rect x="3.5" y="12" width="7.5" height="7.5" rx="1"/><rect x="13" y="12" width="7.5" height="7.5" rx="1"/><rect x="8.2" y="4" width="7.5" height="7.5" rx="1"/>', 22),
  art: msSvg('<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.9 0-1.2-1-1.6-1-2.6 0-1 .8-1.5 1.8-1.5H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>', 22),
  decor: msSvg('<path d="m12 3 2.6 5.5 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.3l1.2-6L3.4 9.2l6-.7z"/>', 22),
  fashion: msSvg('<path d="M7 3.5h10l3.5 5L12 20.5 3.5 8.5z"/><path d="M3.5 8.5h17M9.5 8.5 12 20.5l2.5-12M7 3.5l2.5 5 2.5-5 2.5 5 2.5-5"/>', 22),
  home: msSvg('<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5M10 20v-5.5h4V20"/>', 22),
  organize: msSvg('<rect x="3.5" y="4" width="17" height="16" rx="1.5"/><path d="M3.5 12h17M10 8h4M10 16h4"/>', 22),
  tools: msSvg('<path d="M14.5 6.2a4 4 0 0 0-5.3 5.3L3.5 17.2l3.3 3.3 5.7-5.7a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z"/>', 22),
  tech: msSvg('<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>', 22),
  vehicles: msSvg('<path d="M3.5 16.5v-4l2-5h13l2 5v4z"/><path d="M3.5 12.5h17"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/>', 22),
  outdoor: msSvg('<path d="m3 20 6-9.5 4 6 2.5-3.5L21 20z"/><circle cx="17" cy="6" r="2.2"/>', 22),
  edu: msSvg('<path d="M2.5 9 12 4.5 21.5 9 12 13.5z"/><path d="M6.5 11v5c3 2.2 8 2.2 11 0v-5M21.5 9v5"/>', 22),
  music: msSvg('<path d="M9 18V5.5l10.5-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17" cy="16" r="2.5"/>', 22),
  other: msSvg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><circle cx="16.75" cy="16.75" r="3.25"/>', 22),
};
/** Kurze Zahl für die Kartenzeile: 6401 → 6,4k, 1203127 → 1,2M (Trennzeichen je Sprache; Intl „compact“ kürzt im Deutschen keine Tausender) */
function nshort(n) {
  n = +n || 0;
  const f = (x, d) => { try { return new Intl.NumberFormat(LANG, { maximumFractionDigits: d }).format(x); } catch (e) { return String(Math.round(x)); } };
  return n < 1000 ? String(n) : n < 1e6 ? f(n / 1000, n < 1e4 ? 1 : 0) + 'k' : f(n / 1e6, 1) + 'M';
}
// Zuletzt gesucht (nur auf diesem Gerät, höchstens 8)
const msRecent = () => { try { const a = JSON.parse(pref('ms_recent') || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x).slice(0, 8) : []; } catch (e) { return []; } };
function msRecentAdd(q) { q = String(q || '').trim(); if (q) pref('ms_recent', JSON.stringify([q, ...msRecent().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8))); }
function msRecentDel(q) { pref('ms_recent', JSON.stringify(q === null ? [] : msRecent().filter(x => x !== q))); }
/** Treffer in allen Listen der Seite (Suche, Gerade beliebt, Ähnliche) */
const msFind = id => [ms.hits, ms.trend || [], ms.fresh || [], ms.rel || [], ct.models].map(L => L.find(z => z.id === id)).find(Boolean);

async function viewModels() {
  if (await ampAplLocked('models')) return;   // App ohne Agent, Weiche „models“ (24.11.2026)
  const g_ = navGen, gen = ms.gen, y = ms.listY;
  ms.listY = null; ms.came = false;
  const need = msStart() ? !ms.trend || Date.now() - ms.trendAt > 900000 : !ms.loaded;
  ms.loading = need;
  msDraw();
  const back = y != null && !need;   // zurück von der Modellseite: gleiche Stelle (render() scrollt danach nach oben → rAF)
  if (back) window.scrollTo(0, y);
  await Promise.all([msLibLoad(), msContLoad(), need ? (msStart() ? Promise.all([msTrendLoad(), msNewLoad(false)]) : msLoad(false)) : null]);
  if (g_ !== navGen || gen !== ms.gen) return;
  ms.loading = false; msDraw();
  if (back) requestAnimationFrame(() => { if (g_ === navGen) window.scrollTo(0, y); });
}
// Bibliothek aus der Modellsuche erreichen (13.11.2026, User: „gleich zu den Gemerkten oder zu den Sammlungen“); seit 14.11. als Knopf neben der Suche
async function msLibLoad() { try { ms.lib = await api('amp_lib_folders'); } catch (e) { ms.lib = null; } }
/** In die Bibliothek springen: folder = Sammlung ('*' = alles), want = Filter „Gemerkt“ vorwählen (viewLib liest ampLbJump einmal, build_web.py) */
function msToLib(folder, want) {
  window.ampLbJump = { want: !!want }; lb.q = ''; pref('lib_f', folder);
  if (dlg.open) dlg.close();
  closeSheet();
  location.hash = 'library';
}
const I_LIB = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h4v16H4zM10 4h4v16h-4zM16.5 4.5l3.8 1-3.9 14.6-3.8-1z"/></svg>';
/** Blatt „Deine Bibliothek“: Bibliothek, Gemerkt, Sammlungen (oberste Ordner) */
function msLibSheet() {
  const L = ms.lib || { folders: [], total: 0, want: 0 }, tops = (L.folders || []).filter(f => !f.path.includes('/'));
  const row = (attrs, ico, label, n) => `<button type="button" class="amp-mslrow" ${attrs}>${ico}<span>${esc(label)}</span><b>${n || 0}</b></button>`;
  openSheet(`<div class="sheet-h"><b>${esc(t('amp_mslib_h'))}</b><button type="button" class="x-btn" id="mslx" aria-label="${esc(t('close'))}">×</button></div>
    <div class="sheet-b amp-mslibs">${row('data-lib="*"', I_LIB, t('tab_library'), L.total)}${L.want ? row('data-lib="*" data-libw="1"', I_MARK(true), t('amp_want_filter'), L.want) : ''}
      ${tops.length ? `<h3>${esc(t('amp_ms_colls'))}</h3>` + tops.map(f => row(`data-lib="${esc(f.path)}"`, I_FOLDER2, f.path, f.n)).join('') : ''}</div>`);
  $('#mslx').onclick = () => closeSheet();
  sheet.querySelectorAll('[data-lib]').forEach(b => b.onclick = () => msToLib(b.dataset.lib, !!b.dataset.libw));
}
/** Suche laden. Gehört die Antwort zu einer älteren Suche (gen), wird sie verworfen. */
async function msLoad(more) {
  const gen = ms.gen;
  let r; try { r = await api('amp_s3d_search', { q: ms.q, designer: ms.designer, page: more ? ms.page + 1 : 1, sources: msF.src, price: msF.price, group: msF.group, sort: msF.sort }); } catch (e) { r = { error: 'net' }; }
  if (gen !== ms.gen) return false;
  ms.loaded = true;
  if (r.error) { ms.err = r.error; if (!more) ms.hits = []; return true; }
  ms.err = ''; ms.page = r.page; ms.pages = r.pages; ms.found = r.found || 0;
  ms.hits = more ? ms.hits.concat(r.hits.filter(h => !ms.hits.some(x => x.id === h.id))) : r.hits;
  return true;
}
async function msTrendLoad() {
  let r; try { r = await api('amp_s3d_trending', { n: 12 }); } catch (e) { r = { error: 'net' }; }
  if (r.error) { ms.trendErr = r.error; if (!ms.trend) ms.trend = []; }
  else { ms.trend = r.hits || []; ms.trendErr = ''; ms.trendAt = Date.now(); }
}
// „Neu hinzugekommen“ (17.11.2026, User: „wie auf 3DSEARCH, nicht nebeneinander wie Gerade beliebt, sondern gelistet“): Raster wie Suchtreffer, Mehr laden
async function msNewLoad(more) {
  let r; try { r = await api('amp_s3d_new', { page: more ? ms.freshPage + 1 : 1 }); } catch (e) { r = { error: 'net' }; }
  if (r.error) { ms.freshErr = r.error; if (!ms.fresh) ms.fresh = []; return false; }
  const old = more ? ms.fresh || [] : [];
  ms.freshErr = ''; ms.freshPage = r.page; ms.freshPages = r.pages; if (r.found) ms.total = r.found;
  ms.fresh = old.concat((r.hits || []).filter(h => !old.some(x => x.id === h.id)));
  return true;
}
// ── Modellsuche wie 3DSEARCH (18.11.2026, User: „fast genau so wie auf 3DSEARCH, nicht von den Farben, sondern vom Aufbau, auch die
// Wettbewerbe“ → Entwürfe claude.ai/artifact/MYEvfYoKtFHrFoKn4nNqRX, „finde ich gut, das machen wir“): ab 1001 px Seitenleiste wie
// 3DSEARCH (Plattformen mit Häkchen + Anwenden, Wettbewerbe, Sortierung, Preis, Bereiche, Bibliothek), am Handy dasselbe als Filterblatt.
// Karten wie 3DSEARCH: Plattform oben links, Merken + Zur Sammlung oben rechts, Designer, Likes/Makes, Tags. Gesetzte Filter als ×-Chips.
// Plattformen: msF.src leer = alle (wie bisher); in Seitenleiste und Blatt erscheinen dann alle mit Häkchen (3DSEARCH-Art).
const MS_SBSRC = ['thingiverse', 'printables', 'cults3d', 'makerworld', 'myminifactory', 'makeronline', 'thangs', 'grabcad', 'crealitycloud', 'nexprint', 'sketchfab'];   // Reihenfolge wie 3DSEARCH
const msSrcOn = (src, k) => !src.length || src.includes(k);
/** Häkchen umschalten (leer = alle): das letzte lässt sich nicht abwählen, alle gewählt = leer */
function msSrcToggle(src, k) {
  let s = src.length ? src.slice() : MS_SBSRC.slice();
  if (s.includes(k)) { if (s.length === 1) return src; s = s.filter(x => x !== k); } else s.push(k);
  return s.length >= MS_SBSRC.length ? [] : MS_SBSRC.filter(x => s.includes(x));
}
const I_TROPHY = msSvg('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4"/>', 18);
const I_TROPHY_S = msSvg('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4"/>', 14);
const I_GLOBE = msSvg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.6 5.2 3.6 8.5s-1.1 6.1-3.6 8.5c-2.5-2.4-3.6-5.2-3.6-8.5s1.1-6.1 3.6-8.5z"/>', 18);
const I_SORT = msSvg('<path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/>', 18);
const I_PRICE = msSvg('<path d="M3.5 12.5 12 4h7.5v7.5L11 20z"/><circle cx="15.5" cy="8" r="1.4"/>', 18);
const I_AREAS = msSvg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>', 18);
const I_FOLDERP = msSvg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>', 18);
const I_CHEVR = msSvg('<path d="m9 6 6 6-6 6"/>', 16);
const I_ARROWR = msSvg('<path d="M5 12h14M13 6l6 6-6 6"/>', 16);
const I_USER_S = msSvg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>', 13);
const I_CLOCK_S = msSvg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 13);
/** 9455883 → „9,5 Mio.“ (de) bzw. „9.5M“ (en) */
const ncompact = n => { try { return new Intl.NumberFormat(LANG, { notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch (e) { return nshort(n); } };
function msCard(h) {
  const on = !!h.saved, inC = !!(h.saved && h.folder), tags = (h.tags || []).slice(0, 3);
  const lbl = t('amp_ms_likes', { n: nfmt(h.likes || 0) }) + ', ' + t('amp_ms_makes', { n: nfmt(h.makes || 0) });
  return `<div class="lbcard amp-mcard"><button type="button" class="amp-mopen" data-open="${esc(h.id)}"><span class="lbpic">${msImg(h.img, 'amp-photo')}
      <span class="amp-msrc"><i style="background:${MS_COL[h.source] || '#6b7280'}"></i>${esc(s3dName(h.source))}</span>${h.is_free === false ? `<span class="amp-mpaid">${esc(t('amp_ms_paid'))}</span>` : ''}${h.winner ? `<span class="amp-mwin">${esc(t('amp_ct_winner'))}</span>` : ''}</span>
      <span class="lbt"><b>${esc(h.name)}</b>${h.designer ? `<span class="hint amp-mdes">${I_USER_S}<span>${esc(h.designer)}</span></span>` : ''}<span class="amp-mstat" aria-label="${esc(lbl)}"><span>${I_HEART}${esc(nshort(h.likes))}</span><span>${I_MAKE}${esc(nshort(h.makes))}</span></span>${tags.length ? `<span class="amp-mtags">${tags.map(x => `<span>${esc(x)}</span>`).join('')}</span>` : ''}</span></button>
    <span class="amp-macts"><button type="button" class="amp-markbtn${on ? ' on' : ''}" data-mark="${esc(h.id)}" aria-pressed="${on}" aria-label="${esc(t(on ? 'amp_wanted' : 'amp_want'))}: ${esc(h.name)}" title="${esc(t(on ? 'amp_wanted' : 'amp_want'))}">${I_MARK(on)}</button><button type="button" class="amp-collbtn${inC ? ' on' : ''}" data-coll2="${esc(h.id)}" aria-label="${esc(t('amp_coll_btn'))}: ${esc(h.name)}" title="${esc(inC ? t('amp_coll_in', { f: h.folder }) : t('amp_coll_btn'))}">${I_FOLDERP}</button></span></div>`;
}
/** Eine Karte neu zeichnen (nach Merken/Sammlung), überall wo sie steht */
function msCardRe(h) { view.querySelectorAll(`[data-mark="${CSS.escape(String(h.id))}"]`).forEach(b => { const c = b.closest('.amp-mcard'); if (c) c.outerHTML = msCard(h); }); }
/** Graue Platzhalterkarten, solange geladen wird */
const msSkel = n => Array.from({ length: n }, () => '<div class="lbcard amp-skel" aria-hidden="true"><span class="lbpic"></span><span class="lbt"><i></i><i></i></span></div>').join('');
const nfmt = n => { try { return new Intl.NumberFormat(LANG).format(n); } catch (e) { return String(n); } };
function msSave() { pref('ms_f', JSON.stringify(msF)); }
/** Filterblatt am Handy (gleiche Reihenfolge wie die Seitenleiste): Auswahl erst mit „Anzeigen“ übernehmen, Schließen verwirft sie */
function msFilter() {
  const d = { src: msF.src.slice(), price: msF.price, group: msF.group, sort: msF.sort };
  let ddOpen = false;
  const draw = () => {
    const nOn = d.src.length || MS_SBSRC.length, cn = ms.cont && ms.cont.active;
    openSheet(`<div class="sheet-h"><b>${esc(t('amp_mf_h'))}</b><button type="button" class="x-btn" id="mfx" aria-label="${esc(t('close'))}">×</button></div>
      <div class="sheet-b amp-mfs">
        <section><h3>${I_GLOBE}<span>${esc(t('amp_mf_src'))}</span><small>${esc(t('amp_sb_of', { n: nOn, t: MS_SBSRC.length }))}</small></h3>
          <div class="amp-mflist">${MS_SBSRC.map(k => { const on = msSrcOn(d.src, k); return `<button type="button" class="amp-mfrow" data-mfs="${k}" aria-pressed="${on}"><i class="amp-dot" style="background:${MS_COL[k]}"></i><span>${esc(s3dName(k))}</span><span class="amp-chkbox${on ? ' on' : ''}" aria-hidden="true">${on ? I_CHECK : ''}</span></button>`; }).join('')}</div>
          <button type="button" class="amp-mflink" id="mfall"${d.src.length ? '' : ' disabled'}>${esc(t('amp_sb_all'))}</button></section>
        <a class="amp-mfcont" href="#contests" id="mfcont">${I_TROPHY}<span>${esc(t('amp_ct_h'))}</span>${cn ? `<b>${esc(t('amp_ct_run_n', { n: cn }))}</b>` : ''}${I_CHEVR}</a>
        <section><h3>${I_SORT}<span>${esc(t('amp_mf_sort'))}</span></h3><div class="amp-mflist" role="radiogroup" aria-label="${esc(t('amp_mf_sort'))}">${MS_SORT.map(k => `<button type="button" class="amp-mfrow" role="radio" aria-checked="${d.sort === k}" data-mf="sort" data-v="${k}"><span>${esc(t('amp_mf_s_' + k))}</span><span class="amp-radio${d.sort === k ? ' on' : ''}" aria-hidden="true"></span></button>`).join('')}</div></section>
        <section><h3>${I_PRICE}<span>${esc(t('amp_mf_price'))}</span></h3><div class="amp-seg amp-mfseg" role="group" aria-label="${esc(t('amp_mf_price'))}">${[['', 'amp_mf_p_all'], ['free', 'amp_models_free'], ['paid', 'amp_mf_p_paid']].map(([v, k]) => `<button type="button" class="${d.price === v ? 'on' : ''}" data-mf="price" data-v="${v}" aria-pressed="${d.price === v}">${esc(t(k))}</button>`).join('')}</div></section>
        <section><h3>${I_AREAS}<span>${esc(t('amp_mf_area'))}</span></h3><details class="subdd amp-mfdd" id="mfdd"${ddOpen ? ' open' : ''}><summary><span>${esc(d.group ? t('amp_g_' + d.group) : t('amp_mf_area_all'))}</span>${I_CHEV}</summary>
          <div class="subdd-list">${['', ...MS_GROUPS].map(k => `<button type="button" class="${d.group === k ? 'on' : ''}" data-mf="group" data-v="${k}" aria-pressed="${d.group === k}">${k ? MS_GICON[k] : I_AREAS}<span>${esc(k ? t('amp_g_' + k) : t('amp_mf_area_all'))}</span>${d.group === k ? I_CHECK : ''}</button>`).join('')}</div></details></section>
      </div>
      <div class="amp-mff"><button type="button" class="btn" id="mfreset"${msFN(d) ? '' : ' disabled'}>${esc(t('amp_mf_reset'))}</button><button type="button" class="btn pri" id="mfgo">${esc(t('amp_mf_apply'))}</button></div>`);
    sheet.querySelectorAll('[data-mf]').forEach(x => x.onclick = () => { d[x.dataset.mf] = x.dataset.v; if (x.dataset.mf === 'group') ddOpen = false; redraw(); });
    sheet.querySelectorAll('[data-mfs]').forEach(x => x.onclick = () => { d.src = msSrcToggle(d.src, x.dataset.mfs); redraw(); });
    $('#mfdd').addEventListener('toggle', () => { ddOpen = $('#mfdd').open; });
    $('#mfall').onclick = () => { d.src = []; redraw(); };
    $('#mfcont').onclick = e => { e.preventDefault(); closeSheet(); location.hash = 'contests'; };
    $('#mfx').onclick = () => closeSheet();
    $('#mfreset').onclick = () => { Object.assign(d, { ...MS_F0, src: [] }); redraw(); };
    $('#mfgo').onclick = () => { Object.assign(msF, d); msSave(); closeSheet(); msGo(); };
  };
  const redraw = () => { const b = sheet.querySelector('.sheet-b'), y = b ? b.scrollTop : 0; draw(); const n = sheet.querySelector('.sheet-b'); if (n) n.scrollTop = y; };
  draw();
}
/** Seite der Modellsuche: Gerüst (Seitenleiste, Leiste, Chips, Inhalt) einmal bauen, danach nur Teile erneuern */
function msDraw() {
  if (!document.getElementById('msbar')) {
    view.innerHTML = `<h1 class="amp-vh">${esc(t('amp_models_h'))}</h1>
      <div class="amp-mslay"><aside class="amp-msside" id="msside" aria-label="${esc(t('amp_mf_h'))}"></aside>
      <div class="amp-msmain">
      <div class="amp-msbar" id="msbar">
        <form class="amp-msf" id="msf" role="search" autocomplete="off">
          <div class="amp-msq"><button type="submit" class="amp-msgo" aria-label="${esc(t('amp_models_go'))}">${I_SEARCH}</button>
            <input class="in" type="search" id="msq" value="${esc(ms.q)}" placeholder="${esc(t('amp_models_ph'))}" aria-label="${esc(t('amp_models_ph'))}" enterkeyhint="search" autocomplete="off" spellcheck="false"
              role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="mssug">
            <button type="button" class="amp-msclr" id="msclr" aria-label="${esc(t('amp_ms_clear'))}"${ms.q ? '' : ' hidden'}>×</button>
            <div class="amp-mssug" id="mssug" role="listbox" aria-label="${esc(t('amp_models_ph'))}" hidden></div></div>
          <span class="amp-msbtns" id="msbtns"></span>
        </form>
      </div>
      <div class="amp-msquick" id="msquick" role="group" aria-label="${esc(t('amp_mf_h'))}" hidden></div>
      <div id="msbody"></div></div></div>`;
    msBind();
  }
  msDrawSide(); msDrawBar(); msDrawBody();
}
/** Seitenleiste (nur ab 1001 px sichtbar): Plattformen (Entwurf in ms.sbSrc bis „Anwenden“), Wettbewerbe, Sortierung, Preis, Bereiche, Bibliothek */
function msDrawSide() {
  const box = document.getElementById('msside'); if (!box) return;
  const sel = ms.sbSrc || msF.src, nOn = sel.length || MS_SBSRC.length, dirty = ms.sbSrc && ms.sbSrc.join() !== msF.src.join();
  const sec = (k, ico, title, extra, body) => `<details class="amp-sbsec" data-sb="${k}"${ms.sbShut.has(k) ? '' : ' open'}><summary>${ico}<span>${esc(title)}</span>${extra || ''}${I_CHEV}</summary><div class="amp-sbbody">${body}</div></details>`;
  const opt = (attr, on, label, ico) => `<button type="button" class="amp-sbrow${on ? ' on' : ''}" ${attr} aria-pressed="${on}">${ico || ''}<span>${esc(label)}</span></button>`;
  const L = ms.lib || { folders: [], total: 0, want: 0 }, tops = (L.folders || []).filter(f => !f.path.includes('/')).slice(0, 6), cn = ms.cont && ms.cont.active;
  box.innerHTML = sec('src', I_GLOBE, t('amp_mf_src'), `<small>${esc(t('amp_sb_of', { n: nOn, t: MS_SBSRC.length }))}</small>`,
      MS_SBSRC.map(k => { const on = msSrcOn(sel, k); return `<button type="button" class="amp-sbrow amp-sbsrc" data-sbsrc="${k}" aria-pressed="${on}"><i class="amp-dot" style="background:${MS_COL[k]}"></i><span>${esc(s3dName(k))}</span><span class="amp-chkbox${on ? ' on' : ''}" aria-hidden="true">${on ? I_CHECK : ''}</span></button>`; }).join('')
      + `<div class="amp-sbbtns"><button type="button" class="btn sm" id="sball"${sel.length ? '' : ' disabled'}>${esc(t('amp_sb_all'))}</button><button type="button" class="btn sm pri" id="sbapply"${dirty ? '' : ' disabled'}>${esc(t('amp_sb_apply'))}</button></div>`
      + `<a class="amp-sbcont" href="#contests">${I_TROPHY}<span>${esc(t('amp_ct_h'))}</span>${cn ? `<b>${esc(t('amp_ct_run_n', { n: cn }))}</b>` : ''}</a>`)
    + sec('sort', I_SORT, t('amp_mf_sort'), '', MS_SORT.map(k => opt(`data-sbsort="${k}"`, msF.sort === k, t('amp_mf_s_' + k))).join(''))
    + sec('price', I_PRICE, t('amp_mf_price'), '', [['', 'amp_mf_p_all'], ['free', 'amp_models_free'], ['paid', 'amp_mf_p_paid']].map(([v, k]) => opt(`data-sbprice="${v}"`, msF.price === v, t(k))).join(''))
    + sec('area', I_AREAS, t('amp_ms_areas'), '', ['', ...MS_GROUPS].map(k => opt(`data-sbg="${k}"`, msF.group === k, k ? t('amp_g_' + k) : t('amp_mf_area_all'), k ? MS_GICON[k] : I_AREAS)).join(''))
    + sec('lib', I_LIB, t('amp_mslib_h'), '', `<button type="button" class="amp-sbrow" data-lib="*">${I_LIB}<span>${esc(t('tab_library'))}</span><b>${L.total || 0}</b></button>`
      + (L.want ? `<button type="button" class="amp-sbrow" data-lib="*" data-libw="1">${I_MARK(true)}<span>${esc(t('amp_want_filter'))}</span><b>${L.want}</b></button>` : '')
      + tops.map(f => `<button type="button" class="amp-sbrow" data-lib="${esc(f.path)}">${I_FOLDER2}<span>${esc(f.path)}</span><b>${f.n}</b></button>`).join(''));
}
function msDrawBar() {
  const nf = msFN(msF), L = ms.lib, n = L ? L.total || 0 : 0;
  $('#msbtns').innerHTML = `<button type="submit" class="btn pri amp-msgo2">${esc(t('amp_models_go'))}</button>`
    + `<button type="button" class="btn amp-msfb${nf ? ' on' : ''}" id="msfb" aria-haspopup="dialog" aria-label="${esc(t('amp_mf_h') + (nf ? ' (' + nf + ')' : ''))}">${I_FILTER2}<span class="amp-mslbl">${esc(t('amp_mf_btn'))}</span>${nf ? `<span class="amp-fcount">${nf}</span>` : ''}</button>`
    + `<button type="button" class="btn amp-mslb" id="mslb" aria-haspopup="dialog" aria-label="${esc(t('amp_mslib_h') + (n ? ' (' + n + ')' : ''))}">${I_LIB}<span class="amp-mslbl">${esc(t('tab_library'))}</span>${n ? `<span class="amp-lbcount">${n}</span>` : ''}</button>`;
  // Gesetzte Filter als ×-Chips (wie die Filterzeile über den Treffern auf 3DSEARCH); keine Wischleiste, die Chips brechen um
  const q = document.getElementById('msquick'); if (!q) return;
  const x = [], chip = (attr, label, pre) => `<button type="button" class="chip on amp-qx" ${attr} aria-label="${esc(t('amp_mf_off', { f: label }))}">${pre || ''}<span>${esc(label)}</span><span aria-hidden="true">×</span></button>`;
  if (ms.designer) x.push(chip('data-clr="designer"', ms.designer, I_USER));
  if (msF.src.length) {
    if (msF.src.length <= 3) msF.src.forEach(k => x.push(chip(`data-clr="src" data-v="${k}"`, s3dName(k), `<i style="background:${MS_COL[k]}"></i>`)));
    else x.push(chip('data-clr="src" data-v="*"', t('amp_ms_srcs_n', { n: msF.src.length, t: MS_SBSRC.length })));
  }
  if (msF.price) x.push(chip('data-clr="price"', t(msF.price === 'free' ? 'amp_models_free' : 'amp_mf_p_paid')));
  if (msF.group) x.push(chip('data-clr="group"', t('amp_g_' + msF.group)));
  if (msF.sort !== 'relevance') x.push(chip('data-clr="sort"', t('amp_mf_s_' + msF.sort)));
  if (x.length > 1) x.push(`<button type="button" class="amp-qreset" data-reset>${esc(t('amp_ms_reset_all'))}</button>`);
  q.innerHTML = x.join(''); q.hidden = !x.length;
}
/** Laufende Wettbewerbe auf der Startseite: Desktop vier Karten, Handy eine Kachel (beides im HTML, CSS zeigt eins) */
function msContHtml() {
  const C = ms.cont; if (!C || !C.list.length) return '';
  const f = C.list[0], lf = ctLeft(f);
  return `<section class="amp-mssec amp-mscont"><div class="amp-msh"><h2>${esc(t('amp_ct_running_h'))}</h2><span class="hint">${esc(t('amp_ct_on_n', { n: C.active, p: C.nplat }))}</span><a class="amp-msall" href="#contests">${esc(t('amp_ct_all'))}${I_ARROWR}</a></div>
      <div class="amp-ctgrid">${C.list.slice(0, 4).map(ctCard).join('')}</div></section>
    <a class="amp-cttile" href="#contests"><span class="amp-cttop"><span class="amp-ctico">${I_TROPHY}</span><span class="amp-cttx"><b>${esc(t('amp_ct_tile', { n: C.active }))}</b><span${lf.urgent ? ' class="warn"' : ''}>${esc(f.name)}${lf.txt ? ' · ' + esc(lf.txt) : ''}</span></span>${I_CHEVR}</span>
      <span class="amp-ctmini" aria-hidden="true">${C.list.slice(0, 3).map(c => `<span>${ctImg(c.img)}</span>`).join('')}</span></a>`;
}
function msDrawBody() {
  const b = document.getElementById('msbody'); if (!b) return;
  const y = window.scrollY, nf = msFN(msF);
  let h = '';
  if (msStart()) {
    const rec = msRecent().slice(0, 6);
    h += ms.total ? `<p class="amp-mslead">${esc(t('amp_ms_stats', { n: ncompact(ms.total), p: MS_SBSRC.length }))}</p>` : '';
    h += rec.length ? `<section class="amp-mssec"><h2>${esc(t('amp_ms_recent'))}</h2><div class="amp-msrow">${rec.map(q => `<button type="button" class="chip amp-rq" data-rq="${esc(q)}">${I_CLOCK}<span>${esc(q)}</span></button>`).join('')}</div></section>` : '';
    h += msContHtml();
    const tn = (ms.trend || []).length;
    h += `<section class="amp-mssec"><div class="amp-msh"><h2>${esc(t('amp_ms_trend'))}</h2>${tn > 4 ? `<button type="button" class="amp-msall amp-dtonly" id="mstrendmore" aria-expanded="${!!ms.trendAll}" aria-controls="mstrend">${esc(t(ms.trendAll ? 'amp_ms_less' : 'amp_ms_more_s'))}</button>` : ''}</div>`
      + (ms.loading ? `<div class="amp-msstrip amp-trend">${msSkel(4)}</div>` : ms.trendErr && !tn ? `<div class="note warn-note">${esc(t('amp_models_err'))}</div>`
         : `<div class="amp-msstrip amp-trend${ms.trendAll ? ' amp-all' : ''}" id="mstrend">${(ms.trend || []).map(msCard).join('')}</div>`) + '</section>';
    h += `<section class="amp-mssec"><h2>${esc(t('amp_ms_new'))}</h2>`
      + (ms.loading ? `<div class="lbgrid amp-msgrid amp-msnew">${msSkel(6)}</div>` : ms.freshErr && !(ms.fresh || []).length ? `<div class="note warn-note">${esc(t('amp_models_err'))}</div>`
         : `<div class="lbgrid amp-msgrid amp-msnew" id="msnew">${(ms.fresh || []).map(msCard).join('')}</div>`
           + (ms.freshPage < ms.freshPages ? `<div class="amp-msmore"><button type="button" class="btn" id="msnewmore">${esc(t('amp_models_more'))}</button></div>` : '')) + '</section>';
  } else if (ms.loading) h += `<p class="hint amp-msn">&nbsp;</p><div class="lbgrid amp-msgrid">${msSkel(6)}</div>`;
  else if (ms.err && !ms.hits.length) h += `<div class="note warn-note">${esc(t('amp_models_err'))}</div>`;
  else if (!ms.hits.length) h += `<div class="empty">${esc(t(nf || ms.designer ? 'amp_mf_none' : 'amp_models_none'))}${nf || ms.designer ? `<p><button type="button" class="btn" data-reset>${esc(t('amp_ms_reset_all'))}</button></p>` : ''}</div>`;
  else h += (ms.found ? `<p class="hint amp-msn">${esc(t('amp_mf_found', { n: nfmt(ms.found) }))}</p>` : '') + `<div class="lbgrid amp-msgrid">${ms.hits.map(msCard).join('')}</div>`
    + (ms.page < ms.pages ? `<div class="amp-msmore"><button type="button" class="btn" id="msmore">${esc(t('amp_models_more'))}</button></div>` : '');
  h += `<p class="hint amp-msweb"><a href="${MODELS_URL}" target="_blank" rel="noopener">${esc(t('amp_models_web'))}</a></p>`;
  b.innerHTML = h;
  if (!ms.loading) window.scrollTo(0, y);
  msObserve();
}
/** Filter aus Seitenleiste oder ×-Chip übernehmen und neu suchen */
function msApply(fn) { fn(); ms.sbSrc = null; msSave(); msGo(); }
/** Ereignisse einmal je Aufbau, über Delegation (Karten und Chips werden laufend ersetzt) */
function msBind() {
  const inp = $('#msq'), sug = $('#mssug');
  // Höhe der Kopfzeile → die Suchleiste klebt direkt darunter
  const top = document.querySelector('.fmx-top'); document.documentElement.style.setProperty('--amp-toph', (top ? top.offsetHeight : 0) + 'px');
  $('#msf').onsubmit = e => { e.preventDefault(); msSugHide(); msRecentAdd(inp.value.trim()); inp.blur(); msGo(); };
  inp.addEventListener('input', () => { $('#msclr').hidden = !inp.value; msSugShow(); });
  inp.addEventListener('focus', () => msSugShow());
  inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) msSugHide(); }, 150));
  inp.addEventListener('keydown', e => { if (e.key === 'Escape') msSugHide(); });
  $('#msclr').onclick = () => { inp.value = ''; $('#msclr').hidden = true; inp.focus(); if (ms.q) msGo(); else msSugShow(); };
  // Tippen in die Vorschläge nimmt dem Suchfeld nicht den Fokus (sonst schließt die Liste vor dem Klick)
  sug.addEventListener('pointerdown', e => e.preventDefault());
  sug.addEventListener('mousedown', e => e.preventDefault());
  sug.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.srm !== undefined) { msRecentDel(b.dataset.srm); msSugShow(); inp.focus(); return; }
    if (b.dataset.sclr !== undefined) { msRecentDel(null); msSugHide(); msDrawBody(); return; }
    msSugHide();
    if (b.dataset.sq !== undefined) { inp.value = b.dataset.sq; ms.designer = ''; msRecentAdd(b.dataset.sq); inp.blur(); msGo(); }
    else if (b.dataset.sd !== undefined) { inp.value = ''; ms.designer = b.dataset.sd; inp.blur(); msGo(); }
    else if (b.dataset.sm !== undefined) { const m = (ms.sug || []).find(z => z.id === b.dataset.sm); inp.blur(); if (m) msOpen({ ...m, designer: null, tags: [] }); }
  };
  $('#msbar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.closest('#mssug')) return;
    if (b.id === 'msfb') return msFilter();
    if (b.id === 'mslb') return msLibSheet();
  });
  $('#msquick').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.reset !== undefined) return msApply(() => { Object.assign(msF, { ...MS_F0, src: [] }); ms.designer = ''; });
    const k = b.dataset.clr; if (!k) return;
    msApply(() => {
      if (k === 'designer') ms.designer = '';
      else if (k === 'src') msF.src = b.dataset.v === '*' ? [] : msF.src.filter(z => z !== b.dataset.v);
      else msF[k] = MS_F0[k];
    });
  });
  $('#msside').addEventListener('toggle', e => { const d = e.target.closest && e.target.closest('[data-sb]'); if (d) { if (d.open) ms.sbShut.delete(d.dataset.sb); else ms.sbShut.add(d.dataset.sb); } }, true);
  $('#msside').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sbsrc) { ms.sbSrc = msSrcToggle(ms.sbSrc || msF.src, b.dataset.sbsrc); return msDrawSide(); }
    if (b.id === 'sball') return msApply(() => { msF.src = []; });
    if (b.id === 'sbapply') return msApply(() => { if (ms.sbSrc) msF.src = ms.sbSrc; });
    if (b.dataset.sbsort) return msApply(() => { msF.sort = b.dataset.sbsort; });
    if (b.dataset.sbprice !== undefined) return msApply(() => { msF.price = b.dataset.sbprice; });
    if (b.dataset.sbg !== undefined) return msApply(() => { msF.group = b.dataset.sbg; });
    if (b.dataset.lib) return msToLib(b.dataset.lib, !!b.dataset.libw);
  });
  $('#msbody').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.open) { const x = msFind(b.dataset.open); if (x) msOpen(x); }
    else if (b.dataset.mark) { const x = msFind(b.dataset.mark); if (x) msMark(x); }
    else if (b.dataset.coll2) { const x = msFind(b.dataset.coll2); if (x) msColl(x, () => { if (dlg.open) dlg.close(); msCardRe(x); }); }
    else if (b.dataset.rq) { inp.value = b.dataset.rq; msRecentAdd(b.dataset.rq); msGo(); }
    else if (b.dataset.reset !== undefined) msApply(() => { Object.assign(msF, { ...MS_F0, src: [] }); ms.designer = ''; });
    else if (b.id === 'msmore') msMore();
    else if (b.id === 'msnewmore') msNewMore();
    else if (b.id === 'mstrendmore') { ms.trendAll = !ms.trendAll; const g = $('#mstrend'); if (g) g.classList.toggle('amp-all', ms.trendAll); b.textContent = t(ms.trendAll ? 'amp_ms_less' : 'amp_ms_more_s'); b.setAttribute('aria-expanded', ms.trendAll); }
  });
}
// ── Vorschläge beim Tippen: leer = zuletzt gesucht; ab 2 Zeichen „Nach … suchen“, Begriffe, Modelle mit Bild, Designer ──
let msSugT = 0, msSugN = 0;
function msSugHide() { const s = $('#mssug'), i = $('#msq'); if (s) s.hidden = true; if (i) i.setAttribute('aria-expanded', 'false'); clearTimeout(msSugT); msSugN++; }
function msSugOpen(html) {
  const s = $('#mssug'), i = $('#msq'); if (!s || !i || document.activeElement !== i) return;
  if (!html) return msSugHide();
  s.innerHTML = html; s.hidden = false; i.setAttribute('aria-expanded', 'true');
}
function msSugShow() {
  const inp = $('#msq'); if (!inp) return;
  const v = inp.value.trim();
  clearTimeout(msSugT); const n = ++msSugN;
  if (!v) {
    const rec = msRecent();
    return msSugOpen(rec.length ? `<div class="amp-sugh"><span>${esc(t('amp_ms_recent'))}</span><button type="button" class="amp-suglink" data-sclr>${esc(t('amp_ms_recent_clear'))}</button></div>`
      + rec.map(q => `<div class="amp-sugrow"><button type="button" class="amp-sug" role="option" data-sq="${esc(q)}">${I_CLOCK}<span>${esc(q)}</span></button><button type="button" class="amp-sugx" data-srm="${esc(q)}" aria-label="${esc(t('amp_ms_recent_del'))}: ${esc(q)}">×</button></div>`).join('') : '');
  }
  const first = `<button type="button" class="amp-sug" role="option" data-sq="${esc(v)}">${I_SEARCH}<span>${esc(t('amp_ms_search_for', { q: v }))}</span></button>`;
  if (v.length < 2) return msSugOpen(first);
  msSugT = setTimeout(async () => {
    let r; try { r = await api('amp_s3d_suggest', { q: v }); } catch (e) { r = null; }
    if (n !== msSugN) return;
    const terms = ((r && r.terms) || []).filter(x => x.toLowerCase() !== v.toLowerCase()).slice(0, 5), mods = (r && r.models) || [], des = (r && r.designers) || [];
    ms.sug = mods;
    msSugOpen(first
      + terms.map(x => `<button type="button" class="amp-sug" role="option" data-sq="${esc(x)}">${I_SEARCH}<span>${esc(x)}</span></button>`).join('')
      + (mods.length ? `<div class="amp-sugh"><span>${esc(t('amp_ms_sug_models'))}</span></div>` + mods.map(m => `<button type="button" class="amp-sug amp-sugm" role="option" data-sm="${esc(m.id)}"><span class="amp-sugpic">${msImg(m.img)}</span><span><b>${esc(m.name)}</b><span class="hint">${esc(s3dName(m.source))}</span></span></button>`).join('') : '')
      + (des.length ? `<div class="amp-sugh"><span>${esc(t('amp_ms_sug_designers'))}</span></div>` + des.map(d => `<button type="button" class="amp-sug" role="option" data-sd="${esc(d)}">${I_USER}<span>${esc(t('amp_ms_models_by', { d }))}</span></button>`).join('') : ''));
  }, 220);
}
// ── Nachladen beim Scrollen: der Knopf „Mehr laden“ bleibt als Rückfall, ein Beobachter drückt ihn rechtzeitig selbst ──
let msIO = null;
function msObserve() {
  if (msIO) { msIO.disconnect(); msIO = null; }
  const el = document.getElementById('msmore') || document.getElementById('msnewmore'); if (!el || !('IntersectionObserver' in window)) return;
  msIO = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) (el.id === 'msnewmore' ? msNewMore : msMore)(); }, { rootMargin: '0px 0px 700px 0px' });
  msIO.observe(el);
}
/** „Neu hinzugekommen“ weiterladen (Startseite). Bei Fehler bleibt der Knopf zum Antippen, ohne automatisch neu zu versuchen. */
async function msNewMore() {
  if (ms.busy || ms.loading || !msStart() || ms.freshPage >= ms.freshPages) return;
  ms.busy = true;
  const g_ = navGen, gen = ms.gen, n0 = (ms.fresh || []).length, btn = $('#msnewmore');
  if (btn) { btn.disabled = true; btn.innerHTML = spin(t('loading')); }
  const g0 = $('#msnew'); if (g0) g0.insertAdjacentHTML('beforeend', msSkel(4).replace(/amp-skel"/g, 'amp-skel amp-skelmore"'));
  const ok = await msNewLoad(true);
  ms.busy = false;
  if (g_ !== navGen || gen !== ms.gen || location.hash !== '#models' || !msStart()) return;
  const gr = $('#msnew'), b2 = $('#msnewmore');
  if (!gr) return msDrawBody();
  gr.querySelectorAll('.amp-skelmore').forEach(x => x.remove());
  if (ok) gr.insertAdjacentHTML('beforeend', ms.fresh.slice(n0).map(msCard).join(''));
  if (b2) {
    if (ok && ms.freshPage >= ms.freshPages) b2.closest('.amp-msmore').remove();
    else { b2.disabled = false; b2.textContent = t('amp_models_more'); }
  }
  if (ok) msObserve();
}
async function msMore() {
  if (ms.busy || ms.loading || ms.page >= ms.pages) return;
  ms.busy = true;
  const g_ = navGen, gen = ms.gen, n0 = ms.hits.length, grid = view.querySelector('.amp-msgrid'), btn = $('#msmore');
  if (btn) { btn.disabled = true; btn.innerHTML = spin(t('loading')); }
  if (grid) grid.insertAdjacentHTML('beforeend', msSkel(4).replace(/amp-skel"/g, 'amp-skel amp-skelmore"'));
  const ok = await msLoad(true);
  ms.busy = false;
  if (!ok || g_ !== navGen || gen !== ms.gen || location.hash !== '#models') return;
  const gr = view.querySelector('.amp-msgrid'), more = view.querySelector('.amp-msmore');
  if (!gr) return msDrawBody();
  gr.querySelectorAll('.amp-skelmore').forEach(x => x.remove());
  gr.insertAdjacentHTML('beforeend', ms.hits.slice(n0).map(msCard).join(''));
  if (more) {
    if (ms.err || ms.page >= ms.pages) more.remove();
    else { const b = more.querySelector('button'); b.disabled = false; b.textContent = t('amp_models_more'); }
  }
  msObserve();
}
/** Neue Suche mit dem Text im Suchfeld und den Filtern; Platzhalter, bis die Antwort da ist */
async function msGo() {
  const g_ = navGen, inp = $('#msq');
  if (inp) ms.q = inp.value.trim();
  if ($('#msclr')) $('#msclr').hidden = !(inp && inp.value);
  const gen = ++ms.gen;
  const need = msStart() ? !ms.trend || Date.now() - ms.trendAt > 900000 : true;
  ms.loading = need; ms.hits = need && !msStart() ? [] : ms.hits; ms.page = 1; ms.pages = 0;
  window.scrollTo(0, 0);
  if (location.hash === '#models') msDraw();
  if (need) { if (msStart()) await Promise.all([msTrendLoad(), msNewLoad(false), msContLoad()]); else await msLoad(false); }
  if (g_ !== navGen || gen !== ms.gen) return;
  ms.loading = false;
  if (location.hash === '#models') { msDraw(); window.scrollTo(0, 0); }
}
/** Merken (oder schon gemerkt → zur Bibliothek). folder gesetzt = „Zur Sammlung“: merken bzw. verschieben, Ansicht bleibt. */
async function msMark(h, folder) {
  if (h.saved && folder === undefined) { if (dlg.open) dlg.close(); location.hash = 'library/' + h.saved; return; }
  try {
    const r = await api('amp_lib_want', folder === undefined ? { hit: h } : { hit: h, folder });
    const was = h.saved;
    h.saved = r.file.id; h.folder = r.file.folder || '';
    for (const L of [ms.hits, ms.trend || [], ms.fresh || [], ms.rel || [], ct.models]) { const x = L.find(z => z.id === h.id); if (x) { x.saved = h.saved; x.folder = h.folder; } }
    toast(folder === undefined ? t('amp_want_saved') : h.folder ? t(was ? 'amp_coll_moved' : 'amp_coll_added', { f: h.folder }) : t(was ? 'amp_coll_out' : 'amp_want_saved'));
    if (location.hash === '#models') { await msLibLoad(); msDraw(); }
  } catch (e) { fail(e); }
}
/** „Zur Sammlung …“ auf der Modellseite (Dialog): Sammlung = Ordner der Bibliothek. Vorhandene wählen oder neue anlegen; back = zurück zum Modell. */
async function msColl(m, back) {
  if (!dlg.open) { dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_coll_h'))}</b></div><div class="dlg-b"><div class="loading">${esc(t('loading'))}</div></div>`; dlg.showModal(); }
  let fs = []; try { fs = (await api('amp_lib_folders')).folders || []; } catch (e) {}
  if (!dlg.open) return;
  const cur = m.saved ? m.folder || '' : null;
  dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_coll_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p class="hint amp-collp">${esc(t('amp_coll_p', { n: m.name }))}</p>
      ${fs.length ? `<div class="amp-colls" role="list">${fs.map(f => `<button type="button" class="amp-collrow${cur === f.path ? ' on' : ''}" data-coll="${esc(f.path)}" role="listitem"${cur === f.path ? ' aria-current="true"' : ''}>${I_FOLDER2}<span>${esc(f.path)}</span><b>${cur === f.path ? I_CHECK : f.n}</b></button>`).join('')}
        ${cur ? `<button type="button" class="amp-collrow amp-collnone" data-coll="" role="listitem">${esc(t('amp_coll_none'))}</button>` : ''}</div>` : `<p class="empty">${esc(t('amp_coll_empty'))}</p>`}
      <form class="amp-collnew" id="mscollf"><label class="fld"><span>${esc(t('amp_coll_new'))}</span><input class="in" id="mscolln" maxlength="160" placeholder="${esc(t('amp_coll_new_ph'))}" autocomplete="off" enterkeyhint="done"></label>
        <button type="submit" class="btn pri">${esc(t('amp_coll_make'))}</button></form></div>
    <div class="dlg-f"><button type="button" class="btn" id="mscollback">${esc(t('amp_coll_back'))}</button></div>`;
  dlg.querySelector('[data-x]').onclick = () => dlg.close();
  $('#mscollback').onclick = back;
  const go = async f => { await msMark(m, f); if (dlg.open) back(); };
  dlg.querySelectorAll('[data-coll]').forEach(b => b.onclick = () => { if (b.dataset.coll === cur) return back(); go(b.dataset.coll); });
  $('#mscollf').onsubmit = e => { e.preventDefault(); const v = $('#mscolln').value.trim(); if (!v) { $('#mscolln').focus(); return; } go(v); };
}
// ── Modellseite (15.11.2026, User: „kein Popup, sondern eigene Seite mit Pfeil zurück wie auf 3DSEARCH; Bilder nicht nebeneinander,
// sondern zum Wischen, am PC mit Pfeilen“): #models/<id> statt Dialog. Kopf mit Zurück-Pfeil + Name, Galerie wie model.php (eine
// Spur je Bild, Scroll-Snap, Punkte + Zähler, Pfeile nur mit Maus), daneben (breit) bzw. darunter (Handy) Designer/Plattform/Tags/
// Knöpfe/Beschreibung, darunter Ähnliche. Zurück zur Liste landet an derselben Stelle (ms.listY, viewModels).
const msSeen = new Map();   // zuletzt geöffnete Treffer: Name und Bild sofort zeigen, bis die Details da sind
function msOpen(h) {
  if (!h || !h.id) return;
  const id = String(h.id);
  msSeen.delete(id); msSeen.set(id, h);
  if (msSeen.size > 60) msSeen.delete(msSeen.keys().next().value);
  if (location.hash === '#models') ms.listY = window.scrollY;
  ms.came = true;   // Zurück-Pfeil darf history.back() nehmen; direkt geöffnet (Neuladen) → zur Suche
  location.hash = 'models/' + encodeURIComponent(id);
}
const I_BACK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
const I_FWD = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
/** Galerie: alle Bilder nebeneinander in einer Spur, Wischen und Einrasten macht der Browser; msGalBind führt Punkte/Zähler nach */
function msGal(imgs) {
  if (!imgs.length) return `<div class="amp-gal amp-gal0" id="mpgal">${I_BOX}</div>`;
  const n = imgs.length;
  return `<div class="amp-gal${n > 1 ? ' multi' : ''}" id="mpgal">
    <div class="amp-galtrack" id="mpgt" tabindex="0" role="group" aria-label="${esc(t('amp_ms_imgs', { n }))}">${imgs.map((u, i) => `<div class="amp-galslide"><img src="${esc(u)}" alt="" ${i > 1 ? 'loading="lazy" ' : ''}referrerpolicy="no-referrer" draggable="false"></div>`).join('')}</div>
    <button type="button" class="amp-galnav prev" data-gs="-1" aria-label="${esc(t('amp_ms_prev'))}" disabled>${I_BACK}</button><button type="button" class="amp-galnav next" data-gs="1" aria-label="${esc(t('amp_ms_next'))}">${I_FWD}</button>
    <div class="amp-galdots" aria-hidden="true"></div><div class="amp-galcount" aria-hidden="true"></div></div>`;
}
function msGalBind() {
  const root = $('#mpgal'), track = $('#mpgt'); if (!root || !track) return;
  let cur = 0, raf = 0;
  const sync = () => {
    const n = track.children.length;
    if (!n) { root.className = 'amp-gal amp-gal0'; root.innerHTML = I_BOX; return; }   // kein Bild ließ sich laden
    cur = Math.max(0, Math.min(cur, n - 1));
    root.classList.toggle('multi', n > 1);
    root.querySelector('.amp-galdots').innerHTML = n > 1 && n <= 12 ? Array.from({ length: n }, (_, i) => `<i${i === cur ? ' class="on"' : ''}></i>`).join('') : '';
    root.querySelector('.amp-galcount').innerHTML = `<span>${cur + 1}</span>/${n}`;
    root.querySelectorAll('.amp-galnav').forEach(b => { b.disabled = +b.dataset.gs < 0 ? cur === 0 : cur >= n - 1; });
  };
  const go = i => { const n = track.children.length; if (i < 0 || i >= n) return; track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' }); cur = i; sync(); };
  track.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; const i = Math.round(track.scrollLeft / (track.clientWidth || 1)); if (i !== cur) { cur = i; sync(); } });
  }, { passive: true });
  track.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur - 1); } else if (e.key === 'ArrowRight') { e.preventDefault(); go(cur + 1); } });
  root.addEventListener('click', e => { const b = e.target.closest('[data-gs]'); if (b) go(cur + +b.dataset.gs); });
  // Kaputte Bilder fallen raus (Punkte und Zähler zählen nur, was da ist)
  track.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { const s = img.closest('.amp-galslide'); if (s) s.remove(); sync(); }));
  sync();
}
let msPageN = 0;
/** Modellseite: erst mit dem, was die Liste schon weiß (Name, Bild), dann Details (alle Bilder, Tags, Beschreibung), dann Ähnliche */
async function viewModel(id) {
  if (await ampAplLocked('models')) return;
  const g_ = navGen, tok = ++msPageN;
  const live = () => g_ === navGen && tok === msPageN && !!view.querySelector('.amp-mp');
  const h = msSeen.get(id) || msFind(id) || { id };
  let m = { ...h }, state = h.name ? 'part' : 'load', rel = null;   // part = Details laden noch, full = fertig, err = nichts da
  const toSearch = (q, designer) => {
    ms.q = q; ms.designer = designer || ''; if (q) msRecentAdd(q);
    ms.gen++; ms.loaded = false; ms.hits = []; ms.listY = null;
    location.hash = 'models';
  };
  const relHtml = () => `<div class="amp-msstrip amp-msrel">${rel === null ? msSkel(4) : rel.map(msCard).join('')}</div>`;
  const drawInfo = () => {
    const box = $('#mpinfo'); if (!box) return;
    const st = [m.likes ? t('amp_ms_likes', { n: nfmt(m.likes) }) : '', m.makes ? t('amp_ms_makes', { n: nfmt(m.makes) }) : ''].filter(Boolean).join(' · ');
    box.innerHTML = `<p class="amp-msby">${m.designer ? `<button type="button" class="amp-mslink" id="msdes" title="${esc(t('amp_ms_more_by', { d: m.designer }))}">${I_USER}<span>${esc(m.designer)}</span></button><span aria-hidden="true">·</span>` : ''}<span class="amp-msrcl"><i style="background:${MS_COL[m.source] || '#6b7280'}"></i>${esc(s3dName(m.source))}</span>${m.is_free === false ? ` <span class="tag">${esc(t('amp_ms_paid'))}</span>` : m.is_free ? ` <span class="tag on">${esc(t('amp_models_free'))}</span>` : ''}${m.license ? ` <span class="tag">${esc(m.license)}</span>` : ''}</p>
      ${st ? `<p class="hint amp-msst">${esc(st)}</p>` : ''}
      ${(m.tags || []).length ? `<div class="amp-lbtags amp-mstags">${m.tags.slice(0, 10).map(x => `<button type="button" class="tag amp-ctag amp-tagbtn" data-tq="${esc(x)}" title="${esc(t('amp_ms_search_for', { q: x }))}">${esc(x)}</button>`).join('')}</div>` : ''}
      ${m.saved && m.folder ? `<button type="button" class="amp-mscoll" id="mscollgo">${I_FOLDER2}<span>${esc(t('amp_coll_in', { f: m.folder }))}</span></button>` : ''}
      <div class="amp-mpacts amp-msdf"><button type="button" class="btn pri" id="msmark">${I_MARK(!!m.saved)} <span>${esc(t(m.saved ? 'amp_want_open' : 'amp_want_lib'))}</span></button>
        <button type="button" class="btn" id="mscoll">${I_FOLDER2} <span>${esc(t('amp_coll_btn'))}</span></button>
        ${m.url ? `<a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener">${I_EXT} ${esc(t('amp_want_on', { s: s3dName(m.source) }))}</a>` : ''}</div>
      <p class="hint">${esc(t('amp_want_hint', { s: s3dName(m.source) }))}</p>
      ${m.designer ? `<p class="amp-msmoreby"><button type="button" class="btn" id="msdes2">${I_USER} <span>${esc(t('amp_ms_more_by', { d: m.designer }))}</span></button></p>` : ''}
      ${state === 'part' ? `<p class="hint">${esc(t('loading'))}</p>` : m.summary ? `<section class="amp-mpdesc"><h2>${esc(t('amp_ms_desc'))}</h2><p class="amp-mssum">${esc(m.summary)}</p></section>` : ''}`;
    $('#mscoll').onclick = () => msColl(m, () => { if (dlg.open) dlg.close(); h.saved = m.saved; h.folder = m.folder; if (live()) drawInfo(); });
    if ($('#mscollgo')) $('#mscollgo').onclick = () => msToLib(m.folder, false);
    for (const x of ['#msdes', '#msdes2']) if ($(x)) $(x).onclick = () => toSearch('', m.designer);
    box.querySelectorAll('[data-tq]').forEach(b => b.onclick = () => toSearch(b.dataset.tq, ''));
    $('#msmark').onclick = async () => {
      if (m.saved) { location.hash = 'library/' + m.saved; return; }
      await msMark(m); h.saved = m.saved; h.folder = m.folder; if (live()) drawInfo();
    };
  };
  const draw = () => {
    const imgs = [...new Set((m.imgs && m.imgs.length ? m.imgs : [m.img]).filter(Boolean))];
    view.innerHTML = `<div class="amp-mp">
      <div class="amp-mphead"><button type="button" class="amp-mpback" id="mpback" aria-label="${esc(t('amp_ms_back'))}" title="${esc(t('amp_ms_back'))}">${I_BACK}</button><h1 class="amp-mph1">${esc(m.name || '')}</h1></div>
      ${state === 'err' ? `<div class="note warn-note">${esc(t('amp_models_err'))}</div>` : state === 'load' ? `<div class="loading">${esc(t('loading'))}</div>`
        : `<div class="amp-mphero">${msGal(imgs)}<div class="amp-mpinfo" id="mpinfo"></div></div>
      <section class="amp-msrelw" id="mprelw"><h2>${esc(t('amp_ms_rel'))}</h2><div id="msrel">${relHtml()}</div></section>`}</div>`;
    $('#mpback').onclick = () => { if (ms.came && history.length > 1) history.back(); else location.hash = 'models'; };
    msGalBind(); drawInfo();
    const rb = $('#msrel');
    if (rb) rb.onclick = async e => {
      const b = e.target.closest('button'); if (!b || !rel) return;
      const x = rel.find(z => z.id === (b.dataset.open || b.dataset.mark)); if (!x) return;
      if (b.dataset.open) return msOpen(x);
      await msMark(x); if (live() && $('#msrel')) $('#msrel').innerHTML = relHtml();
    };
  };
  draw(); window.scrollTo(0, 0);
  // Laden ohne render() warten zu lassen — render() scrollt danach nach oben, das darf nicht erst nach dem Laden passieren
  (async () => {
    let r = null; try { r = await api('amp_s3d_model', { id }); } catch (e) {}
    if (!live()) return;
    if (r && r.model) m = { ...h, ...r.model, saved: h.saved || r.model.saved, likes: h.likes || r.model.likes, makes: h.makes || r.model.makes };
    state = r && r.model ? 'full' : h.name ? 'full' : 'err';
    const y = window.scrollY; draw(); window.scrollTo(0, y);
    if (state === 'err') return;
    let q = null; try { q = await api('amp_s3d_related', { id: m.id }); } catch (e) {}
    if (!live()) return;
    rel = ((q && q.hits) || []).filter(x => x.id !== m.id); ms.rel = rel;
    const box = $('#msrel');
    if (box) { if (rel.length) box.innerHTML = relHtml(); else $('#mprelw').remove(); }
  })();
}

// ── Wettbewerbe (18.11.2026, Teil von „Modellsuche wie 3DSEARCH“): #contests = Liste (laufend/beendet, Plattform), #contests/<id> = ein
// Wettbewerb mit Preisen, Beschreibung und eingereichten Modellen (merken, zur Sammlung). Mitmachen geht auf der Seite des Veranstalters.
// Daten: 3DSEARCH api/v1/contests (Bilder über den 3DSEARCH-Proxy). Plattformwahl: Desktop Chips, Handy Dropdown (keine Wischleiste).
const CT_PLATS = ['makerworld', 'printables', 'crealitycloud', 'nexprint', 'makeronline'];
const ct = { status: 'open', platform: '', list: [], page: 0, pages: 0, found: 0, active: 0, past: 0, plats: [], err: '', loading: false, busy: false, gen: 0, at: 0, key: '', listY: null,
  dTok: 0, models: [], mPage: 0, mPages: 0, mSort: 'likes', mErr: '', mLoading: false };
const ctDate = d => { try { return new Intl.DateTimeFormat(LANG, { day: 'numeric', month: 'numeric', year: 'numeric' }).format(d); } catch (e) { return d.toISOString().slice(0, 10); } };
/** Restzeit nach Kalendertagen (Ortszeit): heute / morgen / noch n Tage; beendet → Datum */
function ctLeft(c) {
  const end = c && c.ends ? new Date(c.ends) : null, now = new Date();
  if (!end || isNaN(end)) return { txt: '', urgent: false, until: '' };
  if (end <= now) return { txt: t('amp_ct_ended', { d: ctDate(end) }), urgent: false, until: '' };
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = Math.round((day(end) - day(now)) / 864e5);
  return { txt: n <= 0 ? t('amp_ct_left_0') : n === 1 ? t('amp_ct_left_1') : t('amp_ct_left_n', { n }), urgent: n <= 1, until: t('amp_ct_until', { d: ctDate(end) }) };
}
const ctImg = u => u ? `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : '';
function ctCard(c) {
  const l = ctLeft(c);
  return `<a class="amp-ccard" href="#contests/${c.id}" data-ct="${c.id}"><span class="amp-cpic">${ctImg(c.img)}<span class="amp-msrc"><i style="background:${MS_COL[c.platform] || '#6b7280'}"></i>${esc(s3dName(c.platform))}</span>${c.noai ? `<span class="amp-cnoai">${esc(t('amp_ct_noai'))}</span>` : ''}</span>
    <span class="amp-cbody"><b>${esc(c.name)}</b><span class="amp-cprize">${I_TROPHY_S}<span>${esc(c.prize || t('amp_ct_prize_on', { s: s3dName(c.platform) }))}</span></span>
      <span class="amp-cchips">${l.txt ? `<span class="amp-cchip${l.urgent ? ' warn' : ''}">${I_CLOCK_S}${esc(l.txt)}</span>` : ''}<span class="amp-cchip">${I_MAKE}${esc(t('amp_ct_entries', { n: nfmt(c.entries) }))}</span></span></span></a>`;
}
const ctSkel = n => Array.from({ length: n }, () => '<span class="amp-ccard amp-skel" aria-hidden="true"><span class="amp-cpic lbpic"></span><span class="amp-cbody lbt"><i></i><i></i></span></span>').join('');
/** Laufende Wettbewerbe für die Startseite der Modellsuche (und die Zahl in Seitenleiste/Filterblatt), 15 Min. im Speicher */
async function msContLoad() {
  if (ms.cont && Date.now() - ms.contAt < 900000) return;
  let r; try { r = await api('amp_s3d_contests', { status: 'open', n: 4 }); } catch (e) { r = { error: 'net' }; }
  if (r.error) return;   // ohne Wettbewerbe geht die Startseite trotzdem
  ms.cont = { list: r.contests || [], active: r.active || 0, nplat: (r.platforms || []).length }; ms.contAt = Date.now();
}
async function ctLoad(more) {
  let r; try { r = await api('amp_s3d_contests', { status: ct.status, platform: ct.platform, page: more ? ct.page + 1 : 1, n: 24 }); } catch (e) { r = { error: 'net' }; }
  if (r.error) { ct.err = r.error; if (!more) ct.list = []; return false; }
  ct.err = ''; ct.page = r.page; ct.pages = r.pages; ct.found = r.found; ct.active = r.active; ct.past = r.past; ct.plats = r.platforms || []; ct.at = Date.now();
  ct.list = more ? ct.list.concat(r.contests.filter(c => !ct.list.some(x => x.id === c.id))) : r.contests;
  return true;
}
async function viewContests() {
  if (await ampAplLocked('models')) return;
  const g_ = navGen, gen = ++ct.gen, y = ct.listY, key = ct.status + '|' + ct.platform;
  ct.listY = null;
  // Zurück von einem Wettbewerb: Liste ohne Neuladen an derselben Stelle
  if (ct.list.length && ct.key === key && Date.now() - ct.at < 300000 && !ct.err) {
    ctDraw();
    if (y != null) requestAnimationFrame(() => { if (g_ === navGen) window.scrollTo(0, y); });
    return;
  }
  ct.loading = true; ct.key = key; ctDraw();
  await ctLoad(false);
  if (g_ !== navGen || gen !== ct.gen) return;
  ct.loading = false; ctDraw();
}
function ctDraw() {
  const open = ct.status === 'open', cnt = k => (ct.plats.find(p => p.platform === k) || {}).n || 0;
  const pl = [...new Set([...ct.plats.map(p => p.platform), ...CT_PLATS])];
  const lab = k => k ? s3dName(k) : t('amp_ct_allplat'), num = k => open ? (k ? cnt(k) : ct.active) : null;
  const dot = k => k ? `<i class="amp-dot" style="background:${MS_COL[k] || '#6b7280'}"></i>` : I_TROPHY;
  view.innerHTML = `<div class="amp-ctl">
    <a href="#models" class="amp-ctback">${I_BACK}<span>${esc(t('amp_models_h'))}</span></a>
    <div class="amp-cthead"><div class="amp-cthd"><h1>${I_TROPHY}<span>${esc(t('amp_ct_h'))}</span></h1><p class="hint">${esc(t('amp_ct_sub'))}</p></div>
      <div class="amp-seg" role="group" aria-label="${esc(t('amp_ct_h'))}"><button type="button" data-cts="open" class="${open ? 'on' : ''}" aria-pressed="${open}">${esc(t('amp_ct_open', { n: ct.active }))}</button><button type="button" data-cts="past" class="${open ? '' : 'on'}" aria-pressed="${!open}">${esc(t('amp_ct_past', { n: ct.past }))}</button></div></div>
    <div class="chips amp-ctplats" role="group" aria-label="${esc(t('amp_ct_allplat'))}">${['', ...pl].map(k => `<button type="button" class="chip${ct.platform === k ? ' on' : ''}" data-ctp="${k}" aria-pressed="${ct.platform === k}">${k ? dot(k) : ''}<span>${esc(lab(k))}</span>${num(k) !== null ? `<small>${num(k)}</small>` : ''}</button>`).join('')}</div>
    <details class="subdd amp-ctdd" id="ctdd"><summary>${dot(ct.platform)}<span><b>${esc(lab(ct.platform))}</b>${num(ct.platform) !== null ? ' · ' + num(ct.platform) : ''}</span>${I_CHEV}</summary>
      <div class="subdd-list">${['', ...pl].map(k => `<button type="button" class="${ct.platform === k ? 'on' : ''}" data-ctp="${k}">${dot(k)}<span>${esc(lab(k))}</span>${num(k) !== null ? `<b>${num(k)}</b>` : ''}${ct.platform === k ? I_CHECK : ''}</button>`).join('')}</div></details>
    ${ct.loading ? `<div class="amp-ctgrid">${ctSkel(8)}</div>` : ct.err && !ct.list.length ? `<div class="note warn-note">${esc(t('amp_models_err'))}</div>` : !ct.list.length ? `<div class="empty">${esc(t('amp_ct_none'))}</div>`
      : `<div class="amp-ctgrid" id="ctgrid">${ct.list.map(ctCard).join('')}</div>${ct.page < ct.pages ? `<div class="amp-msmore"><button type="button" class="btn" id="ctmore">${esc(t('amp_models_more'))}</button></div>` : ''}`}
  </div>`;
  view.querySelector('.amp-ctl').addEventListener('click', async e => {
    const card = e.target.closest('[data-ct]'); if (card) { ct.listY = window.scrollY; return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cts && b.dataset.cts !== ct.status) { ct.status = b.dataset.cts; ct.list = []; window.scrollTo(0, 0); return viewContests(); }
    if (b.dataset.ctp !== undefined) { const d = $('#ctdd'); if (d) d.open = false; if (b.dataset.ctp === ct.platform) return; ct.platform = b.dataset.ctp; ct.list = []; return viewContests(); }
    if (b.id === 'ctmore' && !ct.busy) {
      ct.busy = true; b.disabled = true; b.innerHTML = spin(t('loading'));
      const g_ = navGen, n0 = ct.list.length, ok = await ctLoad(true);
      ct.busy = false;
      if (g_ !== navGen || location.hash !== '#contests') return;
      const gr = $('#ctgrid');
      if (gr && ok) gr.insertAdjacentHTML('beforeend', ct.list.slice(n0).map(ctCard).join(''));
      if (!ok || ct.page >= ct.pages) { const m = b.closest('.amp-msmore'); if (m && ok) m.remove(); else { b.disabled = false; b.textContent = t('amp_models_more'); } }
      else { b.disabled = false; b.textContent = t('amp_models_more'); }
    }
  });
}
async function ctModelsLoad(cid, more) {
  const tok = ct.dTok, sort = ct.mSort;
  ct.mLoading = true;
  let r; try { r = await api('amp_s3d_contest_models', { id: cid, sort, page: more ? ct.mPage + 1 : 1 }); } catch (e) { r = { error: 'net', hits: [] }; }
  if (tok !== ct.dTok || sort !== ct.mSort) return false;
  ct.mLoading = false;
  if (r.error) { ct.mErr = r.error; return false; }
  ct.mErr = ''; ct.mPage = r.page; ct.mPages = r.pages;
  ct.models = more ? ct.models.concat(r.hits.filter(h => !ct.models.some(x => x.id === h.id))) : r.hits;
  return true;
}
/** Ein Wettbewerb: erst mit dem, was die Liste schon weiß, dann Details (Beschreibung, Preise, Link) und eingereichte Modelle */
async function viewContest(id) {
  if (await ampAplLocked('models')) return;
  const g_ = navGen, tok = ++ct.dTok, cid = parseInt(id, 10) || 0;
  const live = () => g_ === navGen && tok === ct.dTok && !!view.querySelector('.amp-ctd');
  let c = ct.list.concat(ms.cont ? ms.cont.list : []).find(x => x.id === cid) || null, full = false, err = false, more = false;
  Object.assign(ct, { models: [], mPage: 0, mPages: 0, mSort: 'likes', mErr: '', mLoading: true });
  const back = `<a href="#contests" class="amp-ctback">${I_BACK}<span>${esc(t('amp_ct_h'))}</span></a>`;
  const drawModels = () => {
    const box = $('#ctm'); if (!box) return;
    box.innerHTML = ct.mLoading && !ct.models.length ? `<div class="lbgrid amp-msgrid">${msSkel(8)}</div>` : ct.mErr && !ct.models.length ? `<div class="note warn-note">${esc(t('amp_models_err'))}</div>`
      : !ct.models.length ? `<p class="empty">${esc(t('amp_ct_nomodels'))}</p>`
      : `<div class="lbgrid amp-msgrid" id="ctmgrid">${ct.models.map(msCard).join('')}</div>${ct.mPage < ct.mPages ? `<div class="amp-msmore"><button type="button" class="btn" id="ctmmore">${esc(t('amp_models_more'))}</button></div>` : ''}`;
    view.querySelectorAll('[data-cms]').forEach(b => { const on = b.dataset.cms === ct.mSort; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  };
  const prize = p => { const m = p.match(/^([^:]{2,40}):\s*(.+)$/); return m ? `<li><span>${esc(m[1])}</span><b>${esc(m[2])}</b></li>` : `<li><b>${esc(p)}</b></li>`; };
  const draw = () => {
    if (!c) { view.innerHTML = `<div class="amp-ctd">${back}${err ? `<div class="note warn-note">${esc(t('amp_models_err'))}</div>` : `<div class="loading">${esc(t('loading'))}</div>`}</div>`; return; }
    const l = ctLeft(c), desc = c.description || c.snippet || '', long = desc.length > 420, pz = c.prizes || [];
    view.innerHTML = `<div class="amp-ctd">${back}
      <div class="amp-ctdhero">
        <div class="amp-ctdl"><div class="amp-ctdimg">${ctImg(c.img)}</div></div>
        <div class="amp-ctdr"><section class="amp-ctdsec amp-ctdinfo"><span class="amp-msrcl amp-ctpill"><i style="background:${MS_COL[c.platform] || '#6b7280'}"></i>${esc(s3dName(c.platform))}</span>
            <h1>${esc(c.name)}</h1>
            <div class="amp-cchips">${l.txt ? `<span class="amp-cchip${l.urgent ? ' warn' : ''}">${I_CLOCK_S}${esc(l.txt)}</span>` : ''}${l.until ? `<span class="amp-cchip">${esc(l.until)}</span>` : ''}<span class="amp-cchip">${I_MAKE}${esc(t('amp_ct_entries', { n: nfmt(c.entries) }))}</span>${c.noai ? `<span class="amp-cchip">${esc(t('amp_ct_noai'))}</span>` : ''}</div>
            ${c.url ? `<a class="btn pri amp-ctjoin" id="ctjoin" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(t(l.until ? 'amp_ct_join' : 'amp_ct_view', { s: s3dName(c.platform) }))}${I_EXT}</a>` : ''}</section></div></div>
      ${desc || pz.length || full ? `<div class="amp-ctdhero">
        <div class="amp-ctdl">${desc ? `<section class="amp-ctdsec"><h2>${esc(t('amp_ct_about'))}</h2><p class="amp-ctdesc${long && !more ? ' amp-clip' : ''}" id="ctdesc">${esc(desc)}</p>${long && !more ? `<button type="button" class="amp-mslink" id="ctfull"><span>${esc(t('amp_ct_full'))}</span></button>` : ''}</section>` : ''}</div>
        <div class="amp-ctdr amp-ctdprz">${pz.length ? `<section class="amp-ctdsec"><h2>${I_TROPHY}<span>${esc(t('amp_ct_prizes'))}</span></h2><ul class="amp-ctprizes">${pz.map(prize).join('')}</ul></section>`
          : full ? `<p class="hint amp-ctnoprize">${esc(t('amp_ct_prize_on', { s: s3dName(c.platform) }))}</p>` : ''}</div></div>` : ''}
      <section class="amp-ctdm"><div class="amp-msh"><h2>${esc(t('amp_ct_models'))}</h2><div class="amp-seg" role="group" aria-label="${esc(t('amp_mf_sort'))}"><button type="button" data-cms="likes">${esc(t('amp_ct_s_likes'))}</button><button type="button" data-cms="new">${esc(t('amp_ct_s_new'))}</button></div></div><div id="ctm"></div></section></div>`;
    drawModels();
    const root = view.querySelector('.amp-ctd');
    root.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'ctfull') { more = true; const p = $('#ctdesc'); if (p) p.classList.remove('amp-clip'); b.remove(); return; }
      if (b.dataset.cms && b.dataset.cms !== ct.mSort) { ct.mSort = b.dataset.cms; ct.models = []; ct.mLoading = true; drawModels(); await ctModelsLoad(cid, false); if (live()) drawModels(); return; }
      if (b.id === 'ctmmore' && !ct.busy) { ct.busy = true; b.disabled = true; b.innerHTML = spin(t('loading')); await ctModelsLoad(cid, true); ct.busy = false; if (live()) { const y = window.scrollY; drawModels(); window.scrollTo(0, y); } return; }
      if (b.dataset.open) { const x = msFind(b.dataset.open); if (x) msOpen(x); }
      else if (b.dataset.mark) { const x = msFind(b.dataset.mark); if (x) { await msMark(x); if (live()) msCardRe(x); } }
      else if (b.dataset.coll2) { const x = msFind(b.dataset.coll2); if (x) msColl(x, () => { if (dlg.open) dlg.close(); if (live()) msCardRe(x); }); }
    });
  };
  draw(); window.scrollTo(0, 0);
  const [d] = await Promise.all([api('amp_s3d_contest', { id: cid }).catch(() => null), ctModelsLoad(cid, false)]);
  if (g_ !== navGen || tok !== ct.dTok) return;
  if (d && d.contest) { c = { ...(c || {}), ...d.contest }; full = true; } else if (!c) err = true;
  const y = window.scrollY; draw(); window.scrollTo(0, y);
}

// ── Gemerkte Einträge in der Bibliothek ──
function ampWantCard(f) {
  const r = f.remote || {}, on = !!(lb.sel && lb.sel.has(f.id));
  const tg = (f.tags || []).slice(0, 3).map(x => `<span class="tag amp-ctag">${esc(x)}</span>`).join('');
  const fo = f.folder && f.folder !== lb.folder ? `<span class="tag on qproj">${I_FOLDER}${esc(f.folder)}</span>` : '';
  return `<button type="button" class="lbcard amp-want${lb.sel ? ' amp-selm' : ''}${on ? ' amp-on' : ''}" data-id="${f.id}"${lb.sel ? ` aria-pressed="${on}"` : ''}>${lb.sel ? `<span class="amp-chk" aria-hidden="true">${on ? I_CHECK : ''}</span>` : ''}
    <span class="lbpic">${msImg(r.img, 'amp-photo')}<span class="amp-wantbadge">${esc(t('amp_want_missing'))}</span></span>
    <span class="lbt"><b>${esc(f.name)}</b><span class="hint">${esc([s3dName(r.source), t('amp_wanted')].join(' · '))}</span>${fo || tg ? `<span class="amp-lbtags">${fo}${tg}</span>` : ''}</span></button>`;
}
/** Quelle eines Eintrags (gemerkt oder mit Datei aus einem gemerkten Modell) */
function ampRemoteLine(f) {
  const r = f.remote; if (!r) return '';
  return `<p class="hint amp-remote">${esc(t('amp_want_src') + ': ' + [s3dName(r.source), r.designer ? t('amp_want_by', { d: r.designer }) : '', r.license || ''].filter(Boolean).join(' · '))}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(t('amp_want_page'))}</a>` : ''}</p>`;
}
/** Dialog eines gemerkten Eintrags: Bild aus 3DSEARCH, Quelle, „Datei fehlt noch“ mit Download-Link und „Datei auswählen“ */
function ampWantPv(f) {
  const r = f.remote || {}, src = s3dName(r.source);
  setTimeout(() => { const i = $('#ampwantf'); if (i) i.onchange = () => { const file = i.files && i.files[0]; i.value = ''; if (file) ampWantAttach(f, file); }; }, 0);
  return `<div class="amp-lbimg amp-wantimg">${msImg(r.img)}</div>${ampRemoteLine(f)}
    <section class="amp-wantbox" aria-label="${esc(t('amp_want_missing_h'))}"><b>${esc(t('amp_want_missing_h'))}</b>
      ${r.url ? `<a class="btn pri" href="${esc(r.url)}" target="_blank" rel="noopener">${I_EXT} ${esc(t('amp_want_dl', { s: src }))}</a>` : ''}
      <p>${esc(t('amp_want_how'))}</p>
      <label class="btn"><input type="file" id="ampwantf" hidden accept="${(lb.d && lb.d.exts || ['stl', '3mf', 'gcode']).map(x => '.' + x).join(',')}">${esc(t('amp_want_pick'))}</label>
      <div class="lbups" id="ampwantup"></div></section>`;
}
const ampLibErr = r => { const c = r && r.error ? String(r.error).replace(/^lib_/, '') : 'upload';
  return c === 'dupe' ? t('lib_e_dupe', { name: r.name }) : c === 'dir' ? t('amp_lib_e_dir') : /^dav_/.test(c) ? t('amp_dav_err_' + c.slice(4), { s: '' }) : S['lib_e_' + c] ? t('lib_e_' + c, { mb: fsize((lb.d && lb.d.max) || 0) }) : t('lib_e_upload'); };
/** Datei (aus dem Dateifeld) an den gemerkten Eintrag hängen */
async function ampWantAttach(f, file) {
  const box = $('#ampwantup'); if (!box) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase(), d = lb.d || {};
  if (d.exts && !d.exts.includes(ext)) { box.innerHTML = `<div class="lbup err"><span class="lbup-n">${esc(file.name)}</span><span class="err-t">${esc(t('lib_e_type'))}</span></div>`; return; }
  if (lb.save) await lb.save();   // Änderungen an Name/Ordner/Tags erst sichern — sie gehen auf den neuen Eintrag über
  box.innerHTML = `<div class="lbup up"><span class="lbup-n">${esc(file.name)}</span><span class="lbbar-p"><i style="width:0%"></i></span></div>`;
  let token = '', r = null;
  try {
    const thumb = ext === 'stl' ? await ampStlThumb(file).catch(() => null) : null;
    token = await ampStash(file, p => { const i = box.querySelector('i'); if (i) i.style.width = p.toFixed(0) + '%'; });
    r = await api('amp_lib_attach', { id: f.id, token, name: file.name, size: file.size, thumb });
  } catch (e) { r = { error: e.message || 'lib_upload', name: e.name }; }
  finally { if (token) AMP.native('fileDrop', { token }).catch(() => {}); }
  ampWantDone(f, r, box, file.name);
}
function ampWantDone(f, r, box, name) {
  if (!r || !r.ok) { if (box) box.innerHTML = `<div class="lbup err"><span class="lbup-n">${esc(name || '')}</span><span class="err-t">${esc(ampLibErr(r))}</span></div>`; return false; }
  if (lb.d) { lb.d.files = lb.d.files.filter(x => x.id !== f.id); lb.d.files.unshift(r.file); lb.d.used = r.used; }
  lb.save = lb.dirty = null;   // der gemerkte Eintrag ist weg — nichts mehr dorthin speichern
  toast(t('amp_want_added'));
  if (dlg.open && lb.cur === f.id) libOpen(r.file);
  if (view.querySelector('.lbtop')) { drawLib(); libPoll(); }
  return true;
}
/** „Teilen / Öffnen mit AllMyPrinters“: gibt es gemerkte Modelle, fragen, ob die Datei zu einem davon gehört. true = erledigt. */
async function ampWantShare(f) {
  if (!f || !f.token || !/\.(stl|3mf|gcode|gco|g)$/i.test(f.name || '')) return false;
  let ws = []; try { ws = (await api('lib_list')).files.filter(x => x.want); } catch (e) {}
  if (!ws.length) return false;
  return new Promise(res => {
    let done = false; const fin = v => { if (!done) { done = true; res(v); } };
    if (dlg.open) dlg.close();
    dlg.innerHTML = `<div class="dlg-h"><b>${esc(t('amp_want_share_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
      <div class="dlg-b"><p class="hint">${esc(t('amp_want_share_p', { n: f.name }))}</p>
        <div class="amp-wantlist">${ws.map(w => `<button type="button" class="amp-wantrow" data-w="${w.id}"><span class="amp-wantrow-i">${msImg(w.remote && w.remote.img, 'amp-photo')}</span>
          <span class="amp-wantrow-t"><b>${esc(w.name)}</b><span class="hint">${esc(s3dName(w.remote && w.remote.source))}</span></span></button>`).join('')}</div>
        <div class="lbups" id="ampwantup"></div></div>
      <div class="dlg-f"><button type="button" class="btn" id="ampwantno">${esc(t('amp_want_share_no'))}</button></div>`;
    dlg.addEventListener('close', () => fin(false), { once: true });
    dlg.showModal();
    dlg.querySelector('[data-x]').onclick = () => dlg.close();
    $('#ampwantno').onclick = () => dlg.close();
    dlg.querySelectorAll('[data-w]').forEach(b => b.onclick = async () => {
      dlg.querySelectorAll('[data-w]').forEach(x => { x.disabled = true; });
      const w = ws.find(x => x.id === +b.dataset.w);
      let r; try { r = await api('amp_lib_attach', { id: w.id, token: f.token, name: f.name, size: f.size }); } catch (e) { r = { error: e.message }; }
      if (!r || !r.ok) { $('#ampwantup').innerHTML = `<div class="lbup err"><span class="lbup-n">${esc(f.name)}</span><span class="err-t">${esc(ampLibErr(r))}</span></div>`; dlg.querySelectorAll('[data-w]').forEach(x => { x.disabled = false; }); return; }
      done = true; res(true); dlg.close();
      toast(t('amp_want_added'));
      location.hash = 'library/' + r.file.id;
      if (r.file.ext === 'stl' && !(r.file.plates || []).some(p => p.thumb)) ampWantStlThumb(r.file).catch(() => {});
    });
  });
}
/** STL aus „Teilen“ hat kein Bild (die Oberfläche hatte die Datei nie): aus der abgelegten Datei zeichnen und nachreichen */
async function ampWantStlThumb(f) {
  const rs = await fetch('api.php?a=lib_get&id=' + f.id); if (!rs.ok) return;
  const b64 = await ampStlThumb(new File([await rs.blob()], f.name + '.stl'));
  if (!b64) return;
  await api('amp_lib_setthumb', { id: f.id, b64 });
  if (view.querySelector('.lbtop')) { try { lb.d = await get('lib_list'); drawLib(); } catch (e) {} }
}
/** Einstellungen → Bibliothek: Speicherort — im Handy, Ordner nach Wahl (Google Drive, Nextcloud-App …) oder NAS per WebDAV
 *  (UGREEN, Synology, QNAP, Nextcloud …) samt täglicher Sicherung der App-Daten. */
let ampLibMode = null;
async function ampLibLocDraw() {
  const box = document.getElementById('slibloc'); if (!box) return;
  const r = await api('amp_lib_loc').catch(() => ({ loc: 'app' }));
  const mode = ampLibMode || r.loc;
  const seg = `<span class="seg" id="slibmode">${['app', 'dir', 'dav'].map(k => `<button type="button" data-lm="${k}" class="${mode === k ? 'on' : ''}">${esc(t('amp_lib_mode_' + k))}</button>`).join('')}</span>`;
  let body = '';
  if (mode === 'app') body = `<p><b>${esc(t('amp_lib_loc_app'))}</b></p><p class="hint">${esc(t('amp_lib_loc_hint'))}</p>`;
  else if (mode === 'dir') body = `${r.loc === 'dir' ? `<p><b>${esc(t('amp_lib_loc_dir', { n: r.name || '' }))}</b></p>` : ''}
      ${r.loc === 'dir' && r.ok === false ? `<div class="note warn-note">${esc(t('amp_lib_loc_lost'))}</div>` : ''}
      <p class="hint">${esc(t('amp_lib_loc_hint'))}</p><div class="amp-acts"><button type="button" class="btn${r.loc === 'dir' ? '' : ' pri'}" id="slibpick">${esc(t('amp_lib_loc_pick'))}</button></div>`;
  else {
    const on = r.loc === 'dav';
    body = `${on ? `<div class="note ok-note">${esc(t('amp_dav_ok', { n: r.name || '' }))}</div>` : ''}
      <p class="hint">${esc(t('amp_dav_hint'))}</p>
      <label class="fld"><span>${esc(t('amp_dav_url'))}</span><input class="in" id="sdavurl" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="http://192.168.1.20:5005/AllMyPrinters" value="${esc(on ? r.url : '')}"></label>
      <label class="fld"><span>${esc(t('amp_dav_user'))}</span><input class="in" id="sdavuser" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(on ? r.user || '' : '')}"></label>
      <label class="fld"><span>${esc(t('amp_dav_pass'))}</span><input class="in" id="sdavpass" type="password" autocomplete="off" placeholder="${on && r.has_pass ? esc(t('amp_dav_pass_keep')) : ''}"></label>
      <div class="amp-acts"><button type="button" class="btn pri" id="sdavgo">${esc(t('amp_dav_connect'))}</button></div><div id="sdavmsg"></div>
      ${on ? `<div class="amp-dav-bk"><label class="chk"><input type="checkbox" id="sdavbk"${r.backup ? ' checked' : ''}> ${esc(t('amp_dav_backup'))}</label>
        <p class="hint" id="sdavbkinfo">${esc(r.backup_at ? t('amp_dav_backup_last', { d: dtime(r.backup_at) }) : t('amp_dav_backup_never'))}${r.backup_err ? ' · ' + esc(t('amp_dav_backup_fail', { s: r.backup_err })) : ''}</p>
        <div class="amp-acts"><button type="button" class="btn" id="sdavbknow">${esc(t('amp_dav_backup_now'))}</button></div>
        <p class="hint">${esc(t('amp_dav_backup_note'))}</p></div>` : ''}`;
  }
  box.innerHTML = seg + `<div class="amp-libloc-b">${body}</div>`;
  box.querySelectorAll('[data-lm]').forEach(b => b.onclick = async () => {
    const k = b.dataset.lm;
    if (k === 'app') { ampLibMode = null; await api('amp_lib_app'); toast(t('saved')); return ampLibLocDraw(); }
    ampLibMode = k;
    if (k === 'dir') { const x = await api('amp_lib_dir').catch(() => null); if (x && x.ok) { ampLibMode = null; toast(t('saved')); } }
    ampLibLocDraw();
  });
  const pick = document.getElementById('slibpick');
  if (pick) pick.onclick = async () => { const x = await api('amp_lib_dir').catch(() => null); if (x && x.ok) { ampLibMode = null; toast(t('saved')); } ampLibLocDraw(); };
  const go = document.getElementById('sdavgo');
  if (go) go.onclick = async () => {
    const msg = document.getElementById('sdavmsg'); go.disabled = true;
    msg.innerHTML = `<p class="hint">${esc(t('amp_slc_testing'))}</p>`;
    try {
      const x = await api('amp_lib_dav', { url: document.getElementById('sdavurl').value, user: document.getElementById('sdavuser').value, pass: document.getElementById('sdavpass').value });
      if (x.ok) { ampLibMode = null; toast(t('saved')); return ampLibLocDraw(); }
      msg.innerHTML = `<div class="note err-note">${esc(t('amp_dav_err_' + (x.error || 'other'), { s: x.status || '' }))}</div>`;
    } catch (e) { msg.innerHTML = `<div class="note err-note">${esc(t('err_generic'))}</div>`; }
    go.disabled = false;
  };
  const bk = document.getElementById('sdavbk');
  if (bk) bk.onchange = () => api('amp_dav_backup', { on: bk.checked }).catch(() => {});
  const now = document.getElementById('sdavbknow');
  if (now) now.onclick = async () => {
    now.disabled = true;
    const x = await api('amp_dav_backup', { now: true }).catch(() => ({ ok: false }));
    toast(x.ok ? t('amp_dav_backup_ok') : t('amp_dav_backup_fail', { s: x.err || '' }));
    ampLibLocDraw();
  };
}
/** Druckansicht: gewählte Datei mit einem Tippen in die Bibliothek (nicht, wenn sie schon von dort kommt). */
function ampLibHook() {
  const inp = document.getElementById('pfile'); if (!inp || inp.dataset.amplib) return;
  inp.dataset.amplib = '1';
  const bar = document.createElement('p'); bar.className = 'amp-lbadd'; bar.hidden = true;
  bar.innerHTML = `<button type="button" class="btn sm" id="amplbadd">+ ${esc(t('amp_lib_save'))}</button>`;
  (document.getElementById('pdrop') || inp).insertAdjacentElement('afterend', bar);
  const sync = () => { const f = inp.files && inp.files[0]; bar.hidden = !f || !!(ps.lib && sameFile(f, ps.lib.file)); };
  inp.addEventListener('change', () => setTimeout(sync, 0));
  setTimeout(sync, 300);
  bar.querySelector('button').onclick = async e => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const b = e.currentTarget; b.disabled = true;
    const u = { file: f, folder: '' };
    await ampLibUp(u, { files: [], used: 0, max: 0 }, () => {}, () => {});
    b.disabled = false;
    if (u.state === 'ok') { toast(t('amp_lib_saved')); bar.hidden = true; } else toast(u.err || t('lib_e_upload'));
  };
}

// ── Warnschwellen (10.11.2026, Donnie: Reinigungsstäbchen 50 × 0,3 g zeigten immer „fast leer“) ──────────────────────────────
// Einstellungen: zwei Stufen „bald leer“ / „kritisch“ in Gramm oder Prozent. Spule: Standard, eigene Schwelle oder nie warnen.
/** Eingabe: Einheit (g / %) + zwei Zahlen; id-Präfix p, Werte c */
const ampLowForm = (p, c) => `<div class="amp-lowf"><span class="seg" id="${p}mode">${['g', 'pct'].map(m => `<button type="button" data-lmode="${m}" class="${(c.mode || 'g') === m ? 'on' : ''}">${esc(t('amp_low_unit_' + m))}</button>`).join('')}</span>
  <label class="fld"><span>${esc(t('amp_low_low'))}</span><input class="in num" id="${p}low" type="number" min="0" step="any" inputmode="decimal" value="${c.low ?? ''}"></label>
  <label class="fld"><span>${esc(t('amp_low_crit'))}</span><input class="in num" id="${p}crit" type="number" min="0" step="any" inputmode="decimal" value="${c.crit ?? ''}" placeholder="${esc(t('amp_low_off_ph'))}"></label></div>`;
const ampLowRead = p => { const on = document.querySelector(`#${p}mode .on`); return { mode: on ? on.dataset.lmode : 'g', low: document.getElementById(p + 'low').value, crit: document.getElementById(p + 'crit').value }; };
const ampLowSeg = p => document.querySelectorAll(`#${p}mode [data-lmode]`).forEach(b => b.onclick = () => { document.querySelectorAll(`#${p}mode [data-lmode]`).forEach(x => x.classList.toggle('on', x === b)); });
// Druckkosten (15.11.2026): wie /filament bindCosts, aber ohne Währungswahl (steht oben in den Einstellungen).
// Gerechnet im Backend (runCost): Watt × Laufzeit × Strompreis + Verschleiß je Stunde → Druckaufträge, Monat, Statistik.
async function ampCostsDraw() {
  const box = $('#scosts'); if (!box) return;
  let d; try { d = await api('costs'); } catch (e) { box.innerHTML = `<p class="hint">${esc(t('err_generic'))}</p>`; return; }
  if (!$('#scosts')) return;
  const c = d.cfg || {}, num = v => v === null || v === undefined ? '' : v;
  box.innerHTML = `<form id="fcost"><div class="fgrid">
      <label class="fld"><span>${esc(t('cost_kwh', { c: CSYM }))}</span><input class="in num" name="kwh" type="number" min="0" max="5" step="0.001" inputmode="decimal" value="${num(c.kwh)}" placeholder="0.30"></label>
      <label class="fld"><span>${esc(t('cost_wear', { c: CSYM }))}</span><input class="in num" name="wear_h" type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${num(c.wear_h)}" placeholder="0.00"></label></div>
    ${d.printers.length ? `<div class="fld" style="margin-top:12px"><span>${esc(t('cost_power'))}</span></div>
      <ul class="flist cost-pr">${d.printers.map(p => `<li><span class="grow"><b>${esc(p.name)}</b>${p.model && p.model !== p.name ? ` <span class="hint">${esc(p.model)}</span>` : ''}</span>
        <label class="anum"><input class="in num" type="number" min="1" max="3000" step="1" inputmode="numeric" data-pw="${esc(p.provider + ':' + p.pid)}" value="${num(p.power_w)}" placeholder="–" aria-label="${esc(p.name)} W"><span>W</span></label></li>`).join('')}</ul>
      <p class="hint">${esc(t('cost_power_hint'))}</p>` : `<p class="hint">${esc(t('cost_no_printers'))}</p>`}
    <div class="amp-acts"><button class="btn pri">${esc(t('save'))}</button></div></form>`;
  $('#fcost').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, power = {};
    f.querySelectorAll('[data-pw]').forEach(i => { power[i.dataset.pw] = i.value; });
    try { await api('costs_save', { kwh: f.kwh.value, wear_h: f.wear_h.value, power }); toast(t('amp_saved')); } catch (er) { fail(er); }
  };
}

async function ampLowDraw() {
  const box = document.getElementById('slow'); if (!box) return;
  const r = await api('amp_low').catch(() => ({ cfg: { mode: 'g', low: 100, crit: 30 } }));
  box.innerHTML = ampLowForm('slw', r.cfg) + `<div class="amp-acts"><button type="button" class="btn pri" id="slwsave">${esc(t('save'))}</button></div>`;
  ampLowSeg('slw');
  document.getElementById('slwsave').onclick = async () => {
    try { await api('amp_low_save', ampLowRead('slw')); await loadSpools().catch(() => {}); toast(t('saved')); } catch (e) { fail(e); }
  };
}
/** Bereich „Warnung bei wenig Filament“ in der Spulenansicht (build_web-Patch an showSpool). */
window.ampWarnBlock = s => {
  if (s.archived) return '';
  const w = s.warn, cur = !w ? 'def' : w.off ? 'off' : 'own';
  return `<section class="sd-sec amp-warn"><h3>${esc(t('amp_low_h'))}</h3>
    <span class="seg" id="swmode">${['def', 'own', 'off'].map(k => `<button type="button" data-wk="${k}" data-sid="${s.id}" class="${cur === k ? 'on' : ''}">${esc(t('amp_low_k_' + k))}</button>`).join('')}</span>
    <div id="swbody">${cur === 'own' ? ampLowForm('sws', w) + `<div class="amp-acts"><button type="button" class="btn sm pri" data-wsave="${s.id}">${esc(t('save'))}</button></div>`
      : `<p class="hint">${esc(t(cur === 'off' ? 'amp_low_never_p' : 'amp_low_def_p'))}</p>`}</div></section>`;
};
document.addEventListener('click', async e => {
  const k = e.target.closest('[data-wk]'), sv = e.target.closest('[data-wsave]');
  if (k) {
    const id = +k.dataset.sid, wk = k.dataset.wk;
    if (wk === 'own') {   // erst eingeben, dann speichern
      document.querySelectorAll('#swmode [data-wk]').forEach(x => x.classList.toggle('on', x === k));
      const sp = st.spools.find(x => x.id === id) || {}, base = sp.warn && sp.warn.mode ? sp.warn : (await api('amp_low').catch(() => ({ cfg: {} }))).cfg;
      document.getElementById('swbody').innerHTML = ampLowForm('sws', base) + `<div class="amp-acts"><button type="button" class="btn sm pri" data-wsave="${id}">${esc(t('save'))}</button></div>`;
      ampLowSeg('sws');
      return;
    }
    try { await api('amp_spool_warn', { id, warn: wk === 'off' ? 'off' : 'default' }); await loadSpools(); showSpool(id); toast(t('saved')); } catch (er) { fail(er); }
    return;
  }
  if (sv) { const id = +sv.dataset.wsave; try { await api('amp_spool_warn', { id, warn: ampLowRead('sws') }); await loadSpools(); showSpool(id); toast(t('saved')); } catch (er) { fail(er); } }
});

// ── Neue Anordnung „Aufgeräumt“ (20.11.2026) ───────────────────────────────────────────────────────────────────────
// User 20.11.2026: zurück zum alten Aussehen (Türkis, Manrope, weiße Karten), aber neu angeordnet — Entwurf 1 der Leinwand
// claude.ai/artifact/WFLVyf5Uctsr1ZC9sKs8Yp („gefällt mir so … bau um“). Überschrift = Bereichsauswahl, Drucken daneben, keine
// Erklärsätze; Einrichtung als schmale Zeile; jedes Fach nur einmal (Spulen oben, Liste auf Wunsch); Lüfter/Licht/Box hinter „Steuern“.
const I_PRINT_S = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
const I_SLIDERS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
const I_PLUS_S = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
/** Kopf der Druckerseiten: Überschrift als Auswahl (Übersicht · Druckaufträge · Bibliothek · Drucker hinzufügen), rechts Drucken
 *  bzw. eigene Knöpfe ($acts). Ersetzt prHead von /filament (dort prHead_3ds) auf Handy und PC. */
function prHead(active, acts) {
  const tabs = [['overview', '#printers', t('pr_tab_overview')], ['jobs', '#jobs', t('pr_tab_jobs')], ['maint', '#maint', t('pr_tab_maint')], ['library', '#library', t('tab_library')], ['connect', '#connect', t('pr_tab_connect')]];
  const cur = tabs.find(x => x[0] === active) || tabs[0], title = cur[0] === 'overview' ? t('pr_h') : cur[2];
  const go = acts !== undefined ? acts : ps_ok() ? `<a class="btn pri amp-phgo" href="#print">${I_PRINT_S}<span>${esc(t('tab_print'))}</span></a>` : '';
  return `<div class="ph-row amp-ph"><details class="subdd amp-hdd"><summary aria-label="${esc(t('amp_area_switch') + ': ' + title)}"><h1>${esc(title)}</h1>${I_CHEV}</summary>
      <nav class="subdd-list">${tabs.map(([k, h, l]) => `<a href="${h}" class="${cur[0] === k ? 'on' : ''}">${esc(l)}${cur[0] === k ? I_CHECK : ''}</a>`).join('')}</nav></details>
    ${go ? `<div class="ph-acts">${go}</div>` : ''}</div>`;
}
/** Druckerkarten nach dem Zeichnen ordnen (läuft vor dem Binden der Knöpfe, drawPrinters → build_web.py). */
// Feinschliff 24.11.2026 (Leinwand claude.ai/artifact/L4u7b8AvmW7L36AdRobGyA, User: „bau es um“): Stand + Jetzt abfragen in der
// Kopfzeile, ⋯-Menü (Umbenennen/Adresse/Entfernen) statt drei kleiner Symbole am Namen, Infozeile mit „Lüfter & Licht“ (öffnet
// Steuern), Fächer als Kacheln, „Zuletzt …“ und eine Knopfzeile Drucken · Kamera · Steuern — am Handy UND am PC. Steuern (Lüfter,
// Licht, ACE/AMS/CFS) klappt in der Karte auf (vorher am PC eigene rechte Spalte); rechts am PC nur „Bald leer“ + „Zuletzt gedruckt“.
// Druckt der Drucker, sitzt „Kamera“ mit Pause/Abbrechen in einer Reihe im Druckblock.
const ampSteer = new Set();   // „Steuern“ offen je Drucker — bleibt beim Neuzeichnen alle 10 s offen
let ampObOpen = false;
const I_SYNC = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>';
/** Anzeige: Markennamen in Großbuchstaben (ANYCUBIC, SUNLU) wie die anderen schreiben — nur Anzeige, die Daten bleiben. */
const ampBrand = b => { const x = String(b || '').trim(); return /^[A-ZÄÖÜ][A-ZÄÖÜ&.\- ]{3,}$/.test(x) ? x.split(/(\s+|-)/).map(w => w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w).join('') : x; };
/** „Anycubic PETG“ — Marke + Material (ohne Marke: Name der Spule) */
const ampSpName = s => s.brand ? `${ampBrand(s.brand)} ${s.material || ''}`.trim() : (s.name || s.material || '');
function ampPrTidy() {
  const ob = view.querySelector(':scope > section.ob');
  if (ob) ampObSlim(ob);
  ampStandHead();
  const pc = ampPcMode();
  view.dataset.amppc = pc ? '1' : '0';
  view.querySelectorAll(':scope > .pcard:not(.pmini):not(.locked)').forEach(card => {
    const any = card.querySelector('[data-pid]'), pid = any ? any.dataset.pid : '';
    if (!pid) return;
    ampPrMenu(card, pid);
    const ctl = card.querySelector(':scope > .amp-ctl'), boxes = card.querySelector(':scope > .boxes'), bar = card.querySelector(':scope > .pcam-bar');
    const camb = bar && bar.querySelector('[data-act="cam"]'), pcam = card.querySelector(':scope > .pcam');
    const prov = ((card.querySelector('[data-prov]') || {}).dataset || {}).prov || '';
    const job = card.querySelector(':scope > .job'), jobActs = job && job.querySelector('.actions');
    if (ctl) ampPrInfo(card, ctl, pid);
    const acts = document.createElement('div');
    acts.className = 'amp-pacts';
    if (prov === 'moonraker' && ps_ok() && !job) {   // Drucken mit diesem Drucker vorgewählt (pv.printKey über data-pkey, /filament bindet es)
      const a = document.createElement('a');
      a.className = 'btn pri amp-pa amp-papr'; a.href = '#print'; a.dataset.pkey = 'moonraker:' + pid;
      a.innerHTML = `${I_PRINT_S}<span>${esc(t('tab_print'))}</span>`;
      acts.append(a);
    }
    if (camb) {   // „Live-Bild einschalten“ als Knopf; während eines Drucks neben Pause/Abbrechen
      camb.className = 'btn amp-pa amp-pacam' + (jobActs ? ' sm' : '');
      camb.innerHTML = `${I_CAM}<span>${esc(t('amp_pa_cam'))}</span>`;
      (jobActs || acts).append(camb); bar.remove();
    }
    if (ctl || boxes) {
      const open = ampSteer.has(pid);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn amp-pa amp-steerb' + (open ? ' on' : ''); b.dataset.ampsteer = pid; b.setAttribute('aria-expanded', String(open));
      b.innerHTML = `${I_SLIDERS}<span>${esc(t('amp_pa_ctl'))}</span>`;
      acts.append(b);
    }
    if (jobActs) jobActs.classList.add('amp-jacts');
    // Live-Bild (eingeschaltet) direkt unter dem Druck bzw. über den Fächern
    if (pcam) {
      const after = job ? (job.nextElementSibling && job.nextElementSibling.matches('.runout') ? job.nextElementSibling : job) : null;
      const before = card.querySelector(':scope > .ad-bar') || card.querySelector(':scope > .amp-tubes-h') || card.querySelector(':scope > .amp-tubes') || card.querySelector(':scope > details.amp-slots') || card.querySelector(':scope > .slots');
      if (after) after.after(pcam); else if (before) before.before(pcam);
    }
    const anchor = card.querySelector(':scope > details.amp-slots') || card.querySelector(':scope > .slots') || card.querySelector(':scope > .amp-tubes')
      || card.querySelector(':scope > .ad-bar') || card.querySelector(':scope > .job, :scope > .done-now') || card.querySelector(':scope > .pc-live') || card.querySelector(':scope > .pc-top');
    const last = document.createElement('div'); last.className = 'amp-plast'; last.dataset.plast = pid; last.hidden = true;
    anchor.after(last);
    if (acts.childElementCount) last.after(acts);
    if (ctl || boxes) {
      const pan = document.createElement('div');
      pan.className = 'amp-steer'; pan.dataset.steer = pid; pan.hidden = !ampSteer.has(pid);
      if (ctl) pan.append(ctl);
      if (boxes) pan.append(boxes);
      (acts.childElementCount ? acts : last).after(pan);
    }
  });
  ampPrLastFill();
  ampPrExtras();
}
/** PC-Ansicht ab 1001 px: links die Druckerkarten, rechts „Bald leer“ + „Zuletzt gedruckt“ (ampPrExtras). */
const ampPcMode = () => window.matchMedia('(min-width: 1001px)').matches;
/** „Stand: gerade eben“ + „Jetzt abfragen“ (eigene Zeile über den Karten) in die Kopfzeile neben die Überschrift. Steht dort etwas
 *  anderes (Fehler, Hinweise), bleibt die Zeile, wie sie ist. */
function ampStandHead() {
  const bar = view.querySelector(':scope > .conn-bar.pr-bar'), ph = view.querySelector(':scope > .ph-row.amp-ph');
  if (!bar || !ph) return;
  const sync = bar.querySelector(':scope > [data-sync]'), txt = [...bar.children].find(x => x.tagName === 'SPAN' && !x.classList.contains('grow'));
  if (!sync || [...bar.children].some(x => x !== sync && x !== txt && !x.classList.contains('grow'))) return;
  const w = document.createElement('div'); w.className = 'amp-stand';
  if (txt) w.append(txt);
  const lbl = sync.textContent.trim();
  sync.className = 'icon-btn amp-sync'; sync.setAttribute('aria-label', lbl); sync.title = lbl; sync.innerHTML = I_SYNC;
  w.append(sync);
  const hdd = ph.querySelector(':scope > details.amp-hdd');
  if (hdd) hdd.after(w); else ph.prepend(w);
  bar.remove();
}
/** Umbenennen · Adresse ändern · Entfernen hinter ⋯ (dieselben Knöpfe, /filament bindet sie danach; data-k hält das Menü beim Neuzeichnen offen) */
function ampPrMenu(card, pid) {
  const n1 = card.querySelector('.pc-n1'), top = card.querySelector(':scope > .pc-top');
  const bs = n1 ? [...n1.querySelectorAll(':scope > .icon-btn[data-act]')] : [];
  if (!bs.length || !top) return;
  const d = document.createElement('details');
  d.className = 'smenu amp-pmenu'; d.dataset.k = 'pm' + pid;
  d.innerHTML = `<summary class="icon-btn" title="${esc(t('pr_more'))}" aria-label="${esc(t('pr_more'))}">${I_DOTS}</summary><div class="smenu-l"></div>`;
  const l = d.querySelector('.smenu-l');
  bs.forEach(b => { const lbl = b.getAttribute('aria-label') || b.title || ''; b.className = b.dataset.act === 'remove' ? 'bad' : ''; b.removeAttribute('title'); b.type = 'button'; b.textContent = lbl; l.append(b); });
  // Dateien am Drucker (Klipper, Community #57) — vor „Entfernen“
  const pr = ((pv.data && pv.data.connections) || []).flatMap(c => c.printers || []).find(x => String(x.id) === String(pid));
  if (pr && pr.files) {
    const f = document.createElement('button'); f.type = 'button'; f.dataset.amppf = pid; f.textContent = t('amp_dpf_menu');
    const rm = l.querySelector('.bad'); if (rm) rm.before(f); else l.append(f);
  }
  top.append(d);
}
/** Infozeile: „Lüfter & Licht · aus“ bzw. was läuft (Luftfilter 60 %, Licht an) — Antippen öffnet Steuern. */
function ampPrInfo(card, ctl, pid) {
  const live = card.querySelector(':scope > .pc-live'); if (!live) return;
  const on = [...ctl.querySelectorAll('.amp-ct.on')].map(b => { const n = (b.querySelector('.amp-ct-t b') || {}).textContent || '', v = (b.querySelector('.amp-ct-t small') || {}).textContent || ''; return `${n} ${v}`.trim(); }).filter(Boolean);
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'tchip amp-ctlchip'; b.dataset.ampsteer = pid; b.setAttribute('aria-expanded', String(ampSteer.has(pid)));
  b.innerHTML = `<small>${esc(t('amp_info_ctl'))}</small><b>${esc(on.length ? on.join(' · ') : t('amp_info_off'))}</b>`;
  const grow = live.querySelector(':scope > .grow');
  if (grow) grow.before(b); else live.append(b);
}
/** „Zuletzt: Zuckerstangenwichtel · 64 g · heute 17:00“ je Drucker aus den letzten Aufträgen (get('jobs') höchstens jede Minute). */
function ampPrLastFill() {
  const jobs = ampRecent.jobs || [];
  view.querySelectorAll('.amp-plast[data-plast]').forEach(el => {
    const card = el.closest('.pcard'), name = ((card && card.querySelector('.pc-n1 b')) || {}).textContent || '';
    const j = jobs.find(x => x.printer && x.printer === name.trim());
    // läuft ein Druck oder steht „Fertig gerade eben“ da, wäre „Zuletzt …“ doppelt
    if (!j || (card && card.querySelector(':scope > .job, :scope > .done-now'))) { el.hidden = true; return; }
    el.innerHTML = `<span>${esc(t('amp_pr_last'))}</span><b>${esc(j.title)}</b><span>${esc([j.grams ? gUse(j.grams) : '', dtime(j.end || j.start)].filter(Boolean).join(' · '))}</span>`;
    el.hidden = false;
  });
}
/** Einrichtung als schmale Zeile: „Einrichtung · 1 von 4“, vier Striche, nächster Schritt; Antippen klappt die Schritte auf.
 *  Zu bleiben die Knöpfe des aktuellen Schritts sichtbar (Spulen übernehmen, Jetzt verbinden …). */
function ampObSlim(ob) {
  const li = [...ob.querySelectorAll('.ob-steps > li')], n = li.filter(x => x.classList.contains('ok')).length, cur = ob.querySelector('.ob-steps > li.cur');
  // Schild „Optional“ (21.11.2026) steckt im <b> — in der Zeile als „Nächster Schritt: Spulen anlegen · Optional“
  const cb = cur && cur.querySelector('b'), opt = cb && cb.querySelector('.ob-opt');
  const nx = cb ? [...cb.childNodes].filter(x => x !== opt).map(x => x.textContent).join('').trim() + (opt ? ' · ' + opt.textContent : '') : '';
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'amp-obbar'; b.setAttribute('aria-expanded', String(ampObOpen));
  b.innerHTML = `<span class="amp-obl"><b>${esc(t('amp_ob_h'))}</b><span>${esc(t('amp_ob_n', { n, m: li.length }))}</span></span>`
    + `<span class="amp-obseg" aria-hidden="true">${li.map(x => `<i class="${x.classList.contains('ok') ? 'ok' : ''}"></i>`).join('')}</span>`
    + (nx ? `<span class="amp-obnx">${esc(t('amp_ob_next', { s: nx }))}</span>` : '') + I_CHEV;
  ob.prepend(b);
  ob.classList.add('amp-ob');
  ob.classList.toggle('amp-obopen', ampObOpen);
}
document.addEventListener('click', e => {
  const sb = e.target.closest && e.target.closest('[data-ampsteer]');
  if (sb) {
    const pid = sb.dataset.ampsteer, open = !ampSteer.has(pid);
    if (open) ampSteer.add(pid); else ampSteer.delete(pid);
    document.querySelectorAll(`[data-ampsteer="${CSS.escape(pid)}"]`).forEach(x => { x.classList.toggle('on', open); x.setAttribute('aria-expanded', String(open)); });
    const pan = sb.closest('.pcard') && sb.closest('.pcard').querySelector(`.amp-steer[data-steer="${CSS.escape(pid)}"]`);
    if (pan) pan.hidden = !open;
    return;
  }
  const obb = e.target.closest && e.target.closest('.amp-obbar');
  if (obb) {
    ampObOpen = !ampObOpen;
    obb.setAttribute('aria-expanded', String(ampObOpen));
    const ob = obb.closest('.ob'); if (ob) ob.classList.toggle('amp-obopen', ampObOpen);
    return;
  }
  // Menü „Mehr“ oben am PC: Tippen daneben schließt
  document.querySelectorAll('details.amp-navmore[open]').forEach(d => { if (!d.contains(e.target) || e.target.closest('a')) d.open = false; });
});
{ let rz = 0; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => {
    if (view.dataset.amppc && view.querySelector('.pcard') && !dlg.open && view.dataset.amppc !== (ampPcMode() ? '1' : '0') && pv.data) drawPrinters();
  }, 250); }); }
window.addEventListener('hashchange', () => document.querySelectorAll('details.amp-navmore[open]').forEach(d => { d.open = false; }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('details.amp-navmore[open]').forEach(d => { d.open = false; }); });
/** Spulen (viewSpools von /filament, Haken in build_web.py): „+ Spule“ neben die Überschrift, Filter ins Suchfeld,
 *  Etiketten und Scannen in die Filterleiste, Überschrift „Alle Spulen · n Spulen · x kg“ über der Liste. */
window.ampSpoolsTidy = () => {
  const h1 = view.querySelector(':scope > h1'), add = $('#add');
  if (h1 && add) {
    const row = document.createElement('div'); row.className = 'ph-row amp-ph amp-sph';
    h1.before(row); row.append(h1);
    const a = document.createElement('div'); a.className = 'ph-acts';
    add.innerHTML = `${I_PLUS_S}<span>${esc(t('amp_spool_add_s'))}</span>`;
    a.append(add); row.append(a);
  }
  const q = $('#q'), fb = $('#fbtn');
  if (q && fb) { const w = document.createElement('div'); w.className = 'amp-sq'; q.before(w); w.append(q, fb); }
  const fp = $('#fpanel');
  if (fp) ['#labels', '#scan2'].forEach(id => { const b = $(id); if (b) fp.append(b); });
  ampSpoolsFein();
  const first = view.querySelector(':scope > .lgrid, :scope > .grid');
  if (first && !view.querySelector(':scope > .group-h')) {
    const act = st.spools.filter(s => !s.archived), sum = act.reduce((a, s) => a + s.left, 0);
    const hd = document.createElement('div'); hd.className = 'amp-sph2';
    hd.innerHTML = `<h2>${esc(t('amp_sp_all_h'))}</h2><span>${esc(t('amp_sp_sum', { n: nf.format(act.length), kg: kg(sum) }))}</span>`;
    first.before(hd);
  }
};
/** Feinschliff Spulen (24.11.2026, Leinwand L4u7b8…): Reiter neben die Überschrift, Kennzahlen als EINE Zeile, „Bald leer“ nicht
 *  dreifach — der Kasten klappt erst über den Knopf „3 fast leer“ auf; Filter auch am PC hinter „Filter“ (Sortierung + Ansicht bleiben
 *  neben der Suche, Etiketten am PC oben neben „+ Spule“); Markennamen in der Liste einheitlich (ANYCUBIC → Anycubic, nur Anzeige). */
let ampLowOpen = false;
function ampSpoolsFein() {
  const row = view.querySelector(':scope > .amp-sph'), tabs = view.querySelector(':scope > .subtabs');
  if (row && tabs) { tabs.classList.add('amp-sptabs'); row.querySelector(':scope > h1').after(tabs); }
  const pc = ampPcMode();
  const lab = $('#labels'), acts = row && row.querySelector(':scope > .ph-acts');
  if (pc && lab && acts) { lab.classList.add('amp-splab'); acts.prepend(lab); }
  // Sortierung + Kacheln/Liste neben die Suche (am PC), der Rest bleibt im Filter
  const sbar = $('#q') && $('#q').closest('.bar'), fsort = $('#fsort'), lay = view.querySelector('#fpanel .seg.lay');
  if (pc && sbar) { if (fsort) sbar.append(fsort); if (lay) sbar.append(lay); sbar.classList.add('amp-spbar'); }
  // Kennzahlen: „Fast leer“ wird zum Knopf, der den Kasten „Bald leer“ zeigt
  const k = view.querySelector(':scope > .skpis'), warn = k && k.querySelector(':scope > .warn'), low = view.querySelector(':scope > section.lowbox');
  if (k && warn && low) {
    const n = (warn.querySelector('b') || {}).textContent || '';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'amp-lowbtn'; b.setAttribute('aria-expanded', String(ampLowOpen)); b.setAttribute('aria-controls', 'amplow');
    b.innerHTML = `<span>${esc(t('amp_sp_low_btn', { n }))}</span>${I_CHEV}`;
    warn.replaceWith(b);
    low.id = 'amplow'; low.hidden = !ampLowOpen;
    b.onclick = () => { ampLowOpen = !ampLowOpen; low.hidden = !ampLowOpen; b.setAttribute('aria-expanded', String(ampLowOpen)); };
  }
  // Liste: „Anycubic PETG“ + Farbe statt „ANYCUBIC“ + „PETG“ (Zeilen im aufgeklappten Filament-Stapel zeigen #Nr, siehe ampStackRow)
  view.querySelectorAll('.lgrid .lrow[data-id]:not(.nest)').forEach(r => {
    const sp = st.spools.find(x => String(x.id) === r.dataset.id), tb = r.querySelector('.lr-t b'), sm = r.querySelector('.lr-t small');
    if (!sp || !sp.brand || !tb) return;
    tb.textContent = ampSpName(sp);
    if (sm) sm.textContent = sp.color_name || '';
  });
  // Kacheln genauso: „Geeetech PLA“ / „Green · #4“ (wie die Stapel-Karte daneben)
  view.querySelectorAll('.grid .spool[data-id]').forEach(c => {
    const sp = st.spools.find(x => String(x.id) === c.dataset.id), tb = c.querySelector('.t > b'), sm = c.querySelector('.t > .s');
    if (!sp || !sp.brand || !tb) return;
    tb.textContent = ampSpName(sp);
    if (sm) sm.textContent = [sp.color_name, spoolNo(sp)].filter(Boolean).join(' · ');
  });
  // Hersteller-Überschrift „Geeetech“ statt „GEEETECH“
  if (st.group === 'brand') view.querySelectorAll(':scope > .group-h > b').forEach(b => { b.textContent = ampBrand(b.textContent); });
}
/** Filament-Stapel (Community #58, 24.11.2026, Sebastian S.): alle aktiven Spulen desselben Filaments (twinKey per build_web: Hersteller,
 *  Material, Farbe) als EINE aufklappbare Zeile bzw. Karte — Name + Farbe, „3 Spulen“, Summe und Füllbalken aller Spulen; eingelegte
 *  („im Drucker …“) und fast leere stehen schon zugeklappt als Hinweis dran. Aufgeklappt jede Spule mit #Nr, Zustand/Ort und Gewicht.
 *  Ersetzt twinItem aus /filament („2× unbenutzt · je 1 kg“, nur gleiche unbenutzte Spulen). */
function twinItem(it, cards) {
  const ss = it.twin, s = ss[0], n = ss.length, open = st.open.has(it.key);
  const left = ss.reduce((a, x) => a + x.left, 0), tot = ss.reduce((a, x) => a + (x.total || 0), 0), pct = tot ? Math.max(0, Math.min(100, left / tot * 100)) : 0;
  const name = s.brand ? ampSpName(s) : title(s), cn = s.brand ? (s.color_name || '') : sub(s);
  const lows = ss.filter(isLow), crit = ss.some(isCrit);
  const tags = `<span class="tag amp-stn">${esc(t('n_spools', { n }))}</span>`
    + ss.flatMap(x => x.slots).map(sl => `<span class="tag on">${esc(slotTxt(sl))}</span>`).join('')
    + (lows.length ? `<span class="tag ${crit ? 'crit' : 'warn'}">${esc((lows.length > 1 ? lows.length + '× ' : '') + t(crit ? 'low_crit' : 'low'))}</span>` : '');
  const col = ringColor(s.colors && s.colors.length > 1 ? s.colors[0] : s.color);
  const head = cards
    ? `<button class="spool twin amp-stack${open ? ' open' : ''}" data-twin="${esc(it.key)}" aria-expanded="${open}">${ampSpool({ ...s, pct: Math.round(pct) })}<span class="t"><b>${esc(name)}</b><span class="s">${esc(cn)}</span>
        <span class="x"><span class="tag num left">${kg(left)}</span>${tags}${I_CHEV}</span></span></button>`
    : `<button class="lrow twin amp-stack${open ? ' open' : ''}" data-twin="${esc(it.key)}" aria-expanded="${open}"><span class="lr-sw">${spoolIco(s)}</span>
        <span class="lr-t"><b>${esc(name)}</b><small>${esc(cn)}</small></span>
        <span class="lr-m">${tags}${I_CHEV}</span>
        <span class="lr-bar" title="${Math.round(pct)} %"><i style="width:${pct.toFixed(1)}%;background:${esc(col)}"></i></span><span class="lr-g">${kg(left)}</span></button>`;
  return head + (open ? ss.map(x => cards ? spoolCard(x) : ampStackRow(x)).join('') : '');
}
/** Eine Spule im aufgeklappten Stapel: #Nr groß (Name steht im Stapel), darunter zuletzt benutzt bzw. „unbenutzt“ + Lagerort. */
function ampStackRow(s) {
  const when = s.last_used_at ? ago(s.last_used_at) : s.used ? '' : t('unused_s');
  const info = [when, s.slots.length ? '' : s.location].filter(Boolean).join(' · ');
  return `<button class="lrow nest${!s.archived && isLow(s) ? ' low' + (isCrit(s) ? ' crit' : '') : ''}" data-id="${s.id}">
    <span class="lr-sw">${spoolIco(s)}</span>
    <span class="lr-t"><b>${esc(spoolNo(s))}</b><small>${esc(info)}</small></span>
    <span class="lr-m">${spoolTags(s)}</span>
    <span class="lr-bar" title="${s.pct} %"><i style="width:${s.pct}%;background:${esc(ringColor(s.colors && s.colors.length > 1 ? s.colors[0] : s.color))}"></i></span>
    <span class="lr-g">${g(s.left)}</span></button>`;
}
/** Verlauf-Zeile (Feinschliff 24.11.2026, Leinwand L4u7b8…): Titel = was gedruckt wurde (sonst die Spule), darunter Spule · Art ·
 *  Drucker; Farbpunkt der Spule statt %-Ring. Ersetzt histRow aus /filament nur in der App (build_web.py). */
function ampHistRow(h) {
  const sp = st.spools.find(x => x.id === h.spool_id);
  const hex = /^#?[0-9a-f]{6}$/i.test((sp && sp.color_hex) || h.color_hex || '') ? '#' + String((sp && sp.color_hex) || h.color_hex).replace('#', '') : '#888888';
  const b0 = sp ? ampSpName(sp) : '', cn = sp && sp.color_name && !b0.toLowerCase().includes(sp.color_name.toLowerCase()) ? sp.color_name : '';
  const spn = (sp ? [b0, cn].filter(Boolean).join(' ') : [ampBrand(h.brand), h.material].filter(Boolean).join(' ')) || h.name || '#' + h.spool_id;
  const note = histNote(h), neg = h.grams < 0, head = (h.title || '').trim();
  const time = new Date(h.created_at.replace(' ', 'T') + 'Z').toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit', ...HC });
  const kind = head && h.kind === 'print' ? '' : `<span class="tag k-${esc(h.kind)}">${esc(t('kind_' + h.kind))}</span>`;
  return `<div class="hrow amp-hrow"><span class="amp-hdot" style="background:${esc(hex)}" aria-hidden="true"></span><span class="ht"><a href="#s${h.spool_id}"><b>${esc(head || spn)}</b></a>
      <span class="hs">${head ? `<span class="amp-hsp">${esc(spn)}</span>` : ''}${kind}${note && note !== head ? `<span class="hn">${esc(note)}</span>` : ''}${h.printer ? `<span class="hp">${I_PRINTER_S}${esc(h.printer)}</span>` : ''}</span></span>
    <span class="hg"><b class="${neg ? 'pos' : ''}">${+h.grams === 0 ? '–' : (neg ? '+' : '−') + gUse(h.grams)}</b><small>${time}${h.cost ? ' · ' + cur.format(h.cost) : ''}</small></span></div>`;
}
/** PC: unter den Druckern „Bald leer“ und „Zuletzt gedruckt“ (Entwurf 1, rechts war viel leerer Platz). Aufträge höchstens jede Minute neu. */
const ampRecent = { at: 0, jobs: null, busy: false };
function ampPrxHtml() {
  const low = (st.spools || []).filter(s => !s.archived && isLow(s)).sort((a, b) => a.left - b.left).slice(0, 4), jobs = ampRecent.jobs || [];
  if (!low.length && !jobs.length) return '';
  const lowH = low.length ? `<section class="amp-prxc"><div class="amp-prxh"><h2>${esc(t('low_h'))}</h2><a href="#spools">${esc(t('amp_sp_all_h'))}</a></div>`
    + low.map(s => `<a class="amp-prxr" href="#s${s.id}"><span class="lr-sw">${spoolIco(s)}</span><span class="amp-prxt"><b>${esc(ampSpName(s))}</b><small>${esc([s.color_name, s.slots.length ? s.slots.map(slotTxt).join(', ') : s.location || ''].filter(Boolean).join(' · '))}</small></span><b class="${isCrit(s) ? 'amp-bad' : 'amp-warn'}">${g(s.left)}</b></a>`).join('') + '</section>' : '';
  const jobH = jobs.length ? `<section class="amp-prxc"><div class="amp-prxh"><h2>${esc(t('amp_pr_recent_h'))}</h2><a href="#jobs">${esc(t('pr_tab_jobs'))}</a></div>`
    + jobs.slice(0, 4).map(j => `<div class="amp-prxr"><span class="amp-prxi${j.status === 3 ? ' fail' : ''}" aria-hidden="true">${j.status === 3 ? '×' : I_CHECK}</span><span class="amp-prxt"><b>${esc(j.title)}</b><small>${esc([j.printer || t('prov_' + j.provider), j.grams ? gUse(j.grams) : ''].filter(Boolean).join(' · '))}</small></span><small class="amp-prxw">${dtime(j.end || j.start)}</small></div>`).join('') + '</section>' : '';
  return lowH + jobH;
}
/** PC: Karten links untereinander (.amp-prl), rechts .amp-prx = „Bald leer“ + „Zuletzt gedruckt“ (.amp-prxl). Aufträge höchstens jede
 *  Minute neu — auch am Handy, für „Zuletzt …“ in der Karte (24.11.2026). */
function ampPrExtras() {
  if (!ampRecent.busy && Date.now() - ampRecent.at > 60000) {
    ampRecent.busy = true; ampRecent.at = Date.now();
    get('jobs').then(d => {
      ampRecent.jobs = ((d && d.jobs) || []).filter(j => j.status !== 1).slice(0, 8);
      const l = view.querySelector('.amp-prxl'); if (l) l.innerHTML = ampPrxHtml();
      ampPrLastFill();
    }).catch(() => {}).finally(() => { ampRecent.busy = false; });
  }
  if (!ampPcMode()) return;
  const cards = [...view.querySelectorAll(':scope > .pcard')]; if (!cards.length) return;
  const wrap = document.createElement('div'); wrap.className = 'amp-prl';
  cards[0].before(wrap); cards.forEach(c => wrap.append(c));
  const box = document.createElement('div'); box.className = 'amp-prx';
  const lx = document.createElement('div'); lx.className = 'amp-prxl'; lx.innerHTML = ampPrxHtml();
  box.append(lx); wrap.after(box);
}

// ── Fach ohne Material (Meldung #33, 24.11.2026): Der Snapmaker U1 meldet bei Spulen ohne RFID-Chip „NONE“, solange am Display kein Typ
// eingestellt ist. Mit zugeordneter Spule nimmt backend.js slotMat deren Material; ohne Spule ist der Kopf trotzdem wählbar und das Material
// wählt man hier (Feld slot_mat → sliceForm → printerJson). Aufruf aus renderSlots (build_web.py).
window.ampSlotMat = function (p, mats) {
  const old = document.getElementById('pslotmatw'); if (old) old.remove();
  const box = document.getElementById('pslots');
  if (!box || !p || p.slot_mode === 'material' || !(p.slots || []).some(s => s.need_mat && !s.locked)) { if (box) box._ampSm = null; return; }
  box.insertAdjacentHTML('afterend', `<label class="fld amp-slotmat" id="pslotmatw" hidden><span>${esc(t('amp_slot_mat'))}</span>
    <select class="in" name="slot_mat" id="pslotmat" style="max-width:260px">${(mats || []).map(m => `<option>${esc(m)}</option>`).join('')}</select>
    <span class="hint">${esc(t('amp_slot_mat_hint'))}</span></label>`);
  const w = document.getElementById('pslotmatw'), sel = document.getElementById('pslotmat');
  // Kein Fach mit Material vorgewählt (alle Köpfe „NONE“) → ersten wählbaren Kopf nehmen
  if (!box.querySelector('input[name=slot]:checked')) { const f = box.querySelector('input[name=slot]:not([disabled])'); if (f) f.checked = true; }
  box._ampSm = () => {
    const c = box.querySelector('input[name=slot]:checked'), s = c && p.slots.find(x => String(x.index) === c.value);
    const on = !!(s && s.need_mat); w.hidden = !on; sel.disabled = !on;   // gesperrt = nicht im Formular
  };
  if (!box._ampSmOn) { box._ampSmOn = true; box.addEventListener('change', () => { if (box._ampSm) box._ampSm(); }); }
  box._ampSm();
};


// ── Dateien am Drucker (24.11.2026, Community #57 Sebastian S.): G-Code, der schon auf dem Klipper-Drucker liegt, ansehen und starten.
// backend print_pfiles / print_pfile_start; Menüpunkt im ⋯ der Druckerkarte (ampPrMenu). Reicht die Spule nicht → Hinweis + „Trotzdem drucken“.
const ampPfTitle = n => String(n || '').replace(/\.(gcode|gco|g)$/i, '').replace(/_/g, ' ');
const ampPfDate = sec => sec ? new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ') : '';
async function ampPfDlg(pid) {
  const pr = ((pv.data && pv.data.connections) || []).flatMap(c => c.printers || []).find(x => String(x.id) === String(pid)) || {};
  dlg.innerHTML = `<form method="dialog" class="amp-pf"><div class="dlg-h"><b>${esc(t('amp_dpf_h'))}${pr.name ? `<small class="amp-pf-sub">${esc(pr.name)}</small>` : ''}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><div id="amppfl">${spin(t('amp_dpf_load'))}</div></div></form>`;
  dlg.querySelector('[data-x]').onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
  const box = document.getElementById('amppfl');
  let r;
  try { r = await api('print_pfiles', { printer: pid }); }
  catch (er) { box.innerHTML = `<p class="hint bad">${esc(er.message === 'offline' ? t('amp_dpf_offline') : t('amp_dpf_err'))}</p>`; return; }
  if (!r.files.length) { box.innerHTML = `<p class="hint">${esc(t('amp_dpf_empty'))}</p>`; return; }
  box.innerHTML = (r.busy ? `<p class="amp-pf-busy">${esc(t('amp_dpf_busy'))}</p>` : '') + `<ul class="amp-pf-l">${r.files.map((f, i) => `<li class="amp-pf-r" data-i="${i}">
      <span class="amp-pf-img">${f.img ? `<img src="${esc(f.img)}" alt="" loading="lazy">` : I_PRINT_S}</span>
      <span class="amp-pf-t"><b>${esc(ampPfTitle(f.name))}</b><small>${[f.time ? hm(f.time) : '', f.g ? nf.format(f.g) + ' g' : '', f.colors > 1 ? t('amp_dpf_colors', { n: f.colors }) : '', f.modified ? ago(ampPfDate(f.modified)) : ''].filter(Boolean).map(esc).join(' · ')}</small></span>
      <button type="button" class="btn sm pri" data-pfgo="${i}"${r.busy ? ' disabled' : ''}>${esc(t('amp_dpf_start'))}</button>
      <div class="amp-pf-msg" hidden></div></li>`).join('')}</ul>` + (r.total > r.files.length ? `<p class="hint">${esc(t('amp_dpf_more', { n: r.files.length }))}</p>` : '');
  box.onclick = async e => {
    const b = e.target.closest('[data-pfgo]'); if (!b) return;
    const f = r.files[+b.dataset.pfgo], row = b.closest('.amp-pf-r'), msg = row.querySelector('.amp-pf-msg');
    box.querySelectorAll('[data-pfgo]').forEach(x => { x.disabled = true; });
    msg.hidden = false; msg.innerHTML = spin(t('amp_dpf_starting'));
    try {
      const x = await api('print_pfile_start', { printer: pid, path: f.path, force: b.dataset.force === '1' });
      if (x.short && x.short.length) {
        msg.innerHTML = `<ul class="amp-pf-short">${x.short.map(s => `<li class="warn-t">${esc(t('pf_short', { slot: tf('pc_slot_n', s.slot), need: nf.format(s.need), left: nf.format(s.left), spool: s.spool }))}</li>`).join('')}</ul>`;
        box.querySelectorAll('[data-pfgo]').forEach(y => { y.disabled = false; });
        b.dataset.force = '1'; b.textContent = t('amp_dpf_anyway');
        return;
      }
      dlg.close(); toast(t('amp_dpf_started')); pv.data = null;
      if (location.hash === '#printers' || location.hash === '') viewPrinters(); else location.hash = 'printers';
    } catch (er) {
      const m = er.message || '';
      msg.innerHTML = `<span class="bad">${esc(m === 'printer_busy' ? t('amp_dpf_busy') : m === 'offline' ? t('amp_dpf_offline') : t('amp_dpf_start_err', { e: m }))}</span>`;
      box.querySelectorAll('[data-pfgo]').forEach(y => { y.disabled = !!r.busy; });
    }
  };
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-amppf]'); if (!b) return;
  const d = b.closest('details'); if (d) d.open = false;
  ampPfDlg(b.dataset.amppf);
});
// Zweite Farbe beim manuellen Anlegen einer Spule (Community #56): Feld im Formular (build_web.py, Spulen-Dialog), Häkchen schaltet die Farbe frei
window.ampColor2 = s => {
  const c2 = s && !s.fm_filament_id && s.colors && s.colors.length > 1 ? s.colors[1] : '';
  return `<label class="fld amp-c2"><span>${esc(t('amp_color2'))}</span><span class="amp-c2w"><input type="checkbox" name="color2_on" value="1"${c2 ? ' checked' : ''} aria-label="${esc(t('amp_color2'))}"
    onchange="this.nextElementSibling.disabled=!this.checked"><input class="in" name="color2" type="color" value="${esc(c2 || '#ffffff')}" style="padding:4px"${c2 ? '' : ' disabled'}></span></label>`;
};


// ═══ Platte bearbeiten – Modell-Editor (19.11.2026, User: „das ist perfekt bauen wir das als abo option gleich einbauen“) ═══════════
// Entwürfe: claude.ai/artifact/4sJWDcta4FEHSSRCZC5sQy (Desktop + 4 Handy-Bildschirme). Teile auf der Platte bewegen, drehen, kippen,
// skalieren, spiegeln, kopieren, auf eine Fläche legen und je Teil ein Fach wählen; „Slicen & drucken“ baut im Gerät eine 3MF mit
// genau dieser Anordnung (je Teil ein eigenes Objekt, Lage fest eingerechnet) und übergibt sie der Druckansicht. Der Slicer lässt die
// Anordnung einer 3MF stehen (print_slice_lib.php: ohne „Automatisch anordnen“ kein --arrange), Bettmaße aus amp_lib_beds.
// Gespeicherte Platten tragen die Lage je Kopie (parts[].inst) — „Drucken“ einer solchen Platte druckt dieselbe Anordnung.
// Abo-Weiche „editor“ (Agent plan.js, Admin „Abo“; ohne Einstellung nur im Abo, in der Beta frei). Läuft in App und Agent (app.js).
const ED_TRI_MAX = 2500000;   // alle Teile zusammen (Handy-Speicher: Schweißen braucht ~70 Byte je Dreieck)
const ED_GAP = 6;             // Abstand beim Anordnen (mm)
const ED_COLORS = ['#ff6a14', '#2f80ed', '#27ae60', '#9b51e0', '#eb5757', '#f2c94c'];
const ED_BED0 = [220, 220, 250];
const ED = { cur: null, hand: null, g: null };
window.AMP_ED = ED;   // nur zum Nachsehen (Tests, Fehlersuche)
const edI = (d, s = 20) => `<svg class="amp-edic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const EI = {
  back: '<path d="M15 18l-6-6 6-6"/>', undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>', redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>', rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  rotl: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>', scale: '<path d="M4 14v6h6"/><path d="M20 10V4h-6"/><path d="M4 20l7-7M20 4l-7 7"/>',
  flat: '<path d="M3 20h18"/><path d="M6 16l6-10 6 10z"/>', mirror: '<path d="M12 3v18"/><path d="M8 7l-5 5 5 5z"/><path d="M16 7l5 5-5 5z"/>',
  color: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  del: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', arrange: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  center: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>', check: '<path d="M5 12l5 5 9-10"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>', printer: '<path d="M5 3h14v18H5z"/><path d="M5 8h14"/><path d="M9 14h6"/>',
};
const edErr = (code, name) => Object.assign(new Error(code), { part: name || '' });
const edNum = x => { const s = (Math.round(x * 10000) / 10000).toString(); return s === '-0' ? '0' : s; };
const edF1 = x => (Math.round(x * 10) / 10).toLocaleString(FM.lang, { maximumFractionDigits: 1 });
const edF0 = x => Math.round(x).toLocaleString(FM.lang);
const edTouch = () => !!(window.matchMedia && matchMedia('(hover: none) and (pointer: coarse)').matches);
const edWide = () => window.innerWidth >= 1001;

// ── Netz: STL lesen, Ecken verschweißen (gleiche Bits = gleiche Ecke), um die Mitte legen ───────────────────────────────────────
async function edReadStl(file, budget) {
  const buf = await file.arrayBuffer(), dv = new DataView(buf);
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  let tri;
  if (n > 0 && 84 + n * 50 === buf.byteLength) {
    if (n > budget) throw edErr('too_big', file.name);
    tri = new Float32Array(n * 9);
    for (let i = 0, o = 96; i < n; i++, o += 50) for (let k = 0; k < 9; k++) tri[i * 9 + k] = dv.getFloat32(o + k * 4, true);
  } else {
    const txt = new TextDecoder().decode(buf), re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g, a = [];
    let m;
    while ((m = re.exec(txt))) { a.push(+m[1], +m[2], +m[3]); if (a.length > budget * 9) throw edErr('too_big', file.name); }
    const k = a.length - a.length % 9;
    if (k < 9) throw edErr('bad_file', file.name);
    tri = new Float32Array(a.slice(0, k));
  }
  for (let i = 0; i < tri.length; i++) if (!Number.isFinite(tri[i])) throw edErr('bad_file', file.name);
  return edWeld(tri);
}
function edWeld(tri) {
  const nt = tri.length / 9, nvMax = nt * 3, bits = new Uint32Array(tri.buffer, tri.byteOffset, tri.length);
  let size = 1024; while (size < nvMax * 2) size <<= 1;
  const tab = new Int32Array(size).fill(-1), mask = size - 1, pos = new Float32Array(nvMax * 3), pb = new Uint32Array(pos.buffer), idx = new Uint32Array(nvMax);
  let nv = 0;
  for (let i = 0; i < nvMax; i++) {
    const a = bits[i * 3], b = bits[i * 3 + 1], c = bits[i * 3 + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    for (;;) {
      const j = tab[h];
      if (j < 0) { tab[h] = nv; pb[nv * 3] = a; pb[nv * 3 + 1] = b; pb[nv * 3 + 2] = c; idx[i] = nv++; break; }
      if (pb[j * 3] === a && pb[j * 3 + 1] === b && pb[j * 3 + 2] === c) { idx[i] = j; break; }
      h = (h + 1) & mask;
    }
  }
  const p = pos.slice(0, nv * 3), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < lo[k]) lo[k] = p[i + k]; if (p[i + k] > hi[k]) hi[k] = p[i + k]; }
  const c = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) p[i + k] -= c[k];
  return { pos: p, idx, nv, nt, dims: [0, 1, 2].map(k => hi[k] - lo[k]) };
}

// ── Lage: L = 3×3 (zeilenweise) aus Drehung/Kippen/Größe/Spiegeln, x/y = Mitte des Umrisses auf dem Bett, Unterseite auf z = 0 ──
const ED_I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const edMul = (A, B) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
const edDet = L => L[0] * (L[4] * L[8] - L[5] * L[7]) - L[1] * (L[3] * L[8] - L[5] * L[6]) + L[2] * (L[3] * L[7] - L[4] * L[6]);
function edRot(axis, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), r = v => Math.abs(v) < 1e-12 ? 0 : v;
  const M = axis === 'z' ? [c, -s, 0, s, c, 0, 0, 0, 1] : axis === 'x' ? [1, 0, 0, 0, c, -s, 0, s, c] : [c, 0, s, 0, 1, 0, -s, 0, c];
  return M.map(r);
}
/** Umriss von L·Netz (ohne Verschiebung) — bei vielen Ecken nur jede k-te für die Vorschau beim Ziehen nicht nötig: L ändert sich dort nicht */
function edBox(geo, L) {
  const p = geo.pos, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const v0 = L[0] * x + L[1] * y + L[2] * z, v1 = L[3] * x + L[4] * y + L[5] * z, v2 = L[6] * x + L[7] * y + L[8] * z;
    if (v0 < lo[0]) lo[0] = v0; if (v0 > hi[0]) hi[0] = v0; if (v1 < lo[1]) lo[1] = v1; if (v1 > hi[1]) hi[1] = v1; if (v2 < lo[2]) lo[2] = v2; if (v2 > hi[2]) hi[2] = v2;
  }
  return { lo, hi, d: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}
function edFix(p, it) { it.bb = edBox(p.geo, it.L); }
/** Welt-Umriss einer Kopie [x0, y0, x1, y1, h] */
const edWorld = it => [it.x - it.bb.d[0] / 2, it.y - it.bb.d[1] / 2, it.x + it.bb.d[0] / 2, it.y + it.bb.d[1] / 2, it.bb.d[2]];

// ── Zustand ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// cur: { name, plateId, parts: [{ key, id, name, file, geo, slot, color, inst: [{ L, x, y, s, skip, bb }] }], pool, sel: {p, i}, tool,
//        printers, pr (gewählter Drucker), bed [w, d, h], bedKnown, undo [], redo [], unit 'mm'|'%', lock }
const edBed = cur => cur.bed || ED_BED0;
function edSnap(cur) { return JSON.stringify({ gone: cur.gone || [], map3: cur.map3 || {}, parts: cur.parts.map(p => ({ key: p.key, slot: p.slot, sup: p.sup || '', ext3: p.ext3 || 1, inst: p.inst.map(i => ({ L: i.L, x: i.x, y: i.y, s: i.s, skip: !!i.skip, rz: i.rz || 0, bi: i.bi })) })), sel: cur.sel }); }
function edPush(cur) { cur.undo.push(edSnap(cur)); if (cur.undo.length > 60) cur.undo.shift(); cur.redo = []; }
function edRestore(cur, snap) {
  const d = JSON.parse(snap);
  cur.gone = d.gone || []; cur.map3 = d.map3 || {};
  cur.parts = d.parts.map(q => { const p = cur.pool[q.key]; p.slot = q.slot; p.sup = q.sup || ''; p.ext3 = q.ext3 || 1; p.inst = q.inst.map(i => ({ ...i })); p.inst.forEach(i => edFix(p, i)); return p; });
  cur.sel = d.sel && cur.parts[d.sel.p] && cur.parts[d.sel.p].inst[d.sel.i] ? d.sel : cur.parts.length ? { p: 0, i: 0 } : null;
}
const edSelInst = cur => cur.sel && cur.parts[cur.sel.p] ? cur.parts[cur.sel.p].inst[cur.sel.i] || null : null;
const edSelPart = cur => cur.sel ? cur.parts[cur.sel.p] || null : null;

/** Alles anordnen: Reihen nach Tiefe (tiefste zuerst), Abstand ED_GAP, die ganze Anordnung in die Bettmitte */
function edArrange(cur) {
  const [W, D] = edBed(cur), items = [];
  cur.parts.forEach(p => p.inst.forEach(it => items.push(it)));
  items.sort((a, b) => b.bb.d[1] - a.bb.d[1] || b.bb.d[0] - a.bb.d[0]);
  const rows = []; let row = null;
  for (const it of items) {
    const w = it.bb.d[0], d = it.bb.d[1];
    if (!row || (row.w + (row.items.length ? ED_GAP : 0) + w > W && row.items.length)) { row = { items: [], w: 0, d: 0 }; rows.push(row); }
    row.items.push(it); row.w += (row.items.length > 1 ? ED_GAP : 0) + w; row.d = Math.max(row.d, d);
  }
  const totD = rows.reduce((a, r) => a + r.d, 0) + ED_GAP * Math.max(0, rows.length - 1);
  let y = D / 2 + totD / 2;
  for (const r of rows) {
    let x = W / 2 - r.w / 2;
    for (const it of r.items) { it.x = x + it.bb.d[0] / 2; it.y = y - r.d / 2; x += it.bb.d[0] + ED_GAP; }
    y -= r.d + ED_GAP;
  }
}
/** Neue Kopie neben dem Vorbild: rechts, links, hinten, vorn — erste Stelle ohne Überschneidung auf dem Bett */
function edFreeSpot(cur, it) {
  const [W, D] = edBed(cur), w = it.bb.d[0], d = it.bb.d[1];
  const others = []; cur.parts.forEach(p => p.inst.forEach(o => { if (o !== it) others.push(edWorld(o)); }));
  const free = (x, y) => x - w / 2 >= 0 && x + w / 2 <= W && y - d / 2 >= 0 && y + d / 2 <= D
    && others.every(b => x + w / 2 + ED_GAP / 2 <= b[0] || x - w / 2 - ED_GAP / 2 >= b[2] || y + d / 2 + ED_GAP / 2 <= b[1] || y - d / 2 - ED_GAP / 2 >= b[3]);
  for (let ring = 1; ring < 8; ring++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x = it.x + dx * ring * (w + ED_GAP), y = it.y + dy * ring * (d + ED_GAP);
    if (free(x, y)) return [x, y];
  }
  return [it.x + w + ED_GAP, it.y];
}
/** Prüfen: über den Rand (mm je Kopie), zu hoch, Überschneidungen */
function edCheck(cur) {
  const [W, D, H] = edBed(cur), bad = [], tall = [], all = [];
  cur.parts.forEach((p, pi) => p.inst.forEach((it, ii) => {
    if (it.skip) { it.over = 0; it.tall = 0; return; }
    const b = edWorld(it);
    it.over = Math.max(0, -b[0], -b[1], b[2] - W, b[3] - D); it.tall = Math.max(0, b[4] - H);
    if (it.over > 0.3) bad.push({ p, it, mm: it.over }); if (it.tall > 0.3) tall.push({ p, it, mm: it.tall });
    all.push({ b, pi, ii });
  }));
  let overlap = false;
  for (let i = 0; i < all.length && !overlap; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i].b, b = all[j].b;
    if (a[0] < b[2] - 0.5 && a[2] > b[0] + 0.5 && a[1] < b[3] - 0.5 && a[3] > b[1] + 0.5) { overlap = true; break; }
  }
  cur.chk = { bad, tall, overlap, ok: !bad.length && !tall.length && all.length > 0 };
  return cur.chk;
}

// ── Drucker, Fächer, Farben ───────────────────────────────────────────────────────────────────────────────────────────────────
const edSlotsOf = pr => pr && pr.slot_mode === 'slots' ? (pr.slots || []) : [];
const edSlotOk = s => s && s.material && !s.locked;
const edMultiOf = pr => !!(pr && pr.multi && edSlotsOf(pr).filter(edSlotOk).length > 1);
const edInk = hex => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return ''; const n = parseInt(m[1], 16), l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; return l > 0.62 ? '#17201e' : '#ffffff'; };
function edDefSlot(pr) {
  const sl = edSlotsOf(pr).filter(edSlotOk);
  const pla = sl.find(s => /PLA/i.test(s.material));
  return (pla || sl[0] || { index: '' }).index;
}
/** Fach eines Teils: mehrfarbig je Teil, sonst eins für alle (cur.slot1) */
function edSlotOf(cur, p) {
  const pr = cur.pr, sl = edSlotsOf(pr);
  if (!sl.length) return null;
  const v = edMultiOf(pr) ? p.slot : cur.slot1;
  const s = sl.find(x => String(x.index) === String(v));
  return edSlotOk(s) ? s : sl.find(x => String(x.index) === String(edDefSlot(pr))) || null;
}
function edColorOf(cur, p) {
  if (cur.mode === '3mf') return ed3Col(cur, p.kind === '3mf' ? (p.geo.exts || [1])[0] : p.ext3 || 1);
  const s = edSlotOf(cur, p);
  if (s && s.color) return s.color;
  return ED_COLORS[cur.parts.indexOf(p) % ED_COLORS.length] || ED_COLORS[0];
}

// ── 3D-Ansicht (three.js r147 wie die Bibliothek, offline aus vendor/) ───────────────────────────────────────────────────────────
let edThreeP = null;
function edThree() {
  if (window.THREE && THREE.OrbitControls) return Promise.resolve();
  const add = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('three')); document.head.appendChild(s); });
  return edThreeP || (edThreeP = add('vendor/three.min.js').then(() => add('vendor/OrbitControls.js')).catch(e => { edThreeP = null; throw e; }));
}
function edDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
function edGfxInit(cur, host) {
  const T = window.THREE, g = { host, meshes: [], raf: 0 };
  try { g.r = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false }); } catch (e) { return null; }
  g.r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(g.r.domElement);
  g.r.domElement.className = 'amp-edcv';
  g.scene = new T.Scene();
  g.cam = new T.PerspectiveCamera(38, 1, 1, 20000); g.cam.up.set(0, 0, 1);
  g.ctl = new T.OrbitControls(g.cam, g.r.domElement);
  g.ctl.enableDamping = false; g.ctl.screenSpacePanning = true; g.ctl.maxPolarAngle = Math.PI * 0.495;
  g.ctl.addEventListener('change', () => edDraw());
  g.scene.add(new T.HemisphereLight(0xffffff, 0x8a9290, 0.85));
  const dl = new T.DirectionalLight(0xffffff, 0.55); dl.position.set(-0.6, -1, 1.6); g.scene.add(dl);
  const dl2 = new T.DirectionalLight(0xffffff, 0.22); dl2.position.set(1, 0.8, 0.6); g.scene.add(dl2);
  g.bed = new T.Group(); g.scene.add(g.bed);
  g.parts = new T.Group(); g.scene.add(g.parts);
  g.giz = new T.Group(); g.scene.add(g.giz);
  g.ray = new T.Raycaster();
  g.ro = new ResizeObserver(() => edSize()); g.ro.observe(host);
  ED.g = g;
  edBedDraw(cur);
  edSize();
  edView(cur, '3d');
  return g;
}
function edGfxDrop() {
  const g = ED.g; if (!g) return;
  cancelAnimationFrame(g.raf);
  try { g.ro.disconnect(); } catch (e) {}
  try { g.ctl.dispose(); } catch (e) {}
  g.scene.traverse(o => { if (o.geometry && !o.userData.shared) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
  Object.values((ED.cur && ED.cur.pool) || {}).forEach(p => { if (p.bg) { p.bg.dispose(); p.bg = null; } });
  try { g.r.dispose(); g.r.forceContextLoss(); } catch (e) {}
  if (g.r.domElement.parentNode) g.r.domElement.parentNode.removeChild(g.r.domElement);
  ED.g = null;
}
function edSize() {
  const g = ED.g; if (!g) return;
  const w = g.host.clientWidth || 300, h = g.host.clientHeight || 300;
  g.r.setSize(w, h, false); g.cam.aspect = w / h; g.cam.updateProjectionMatrix(); edDraw();
}
function edDraw() { const g = ED.g; if (!g) return; cancelAnimationFrame(g.raf); g.raf = requestAnimationFrame(() => { if (!ED.g) return; g.r.render(g.scene, g.cam); edLabel(); }); }
function edBedDraw(cur) {
  const T = window.THREE, g = ED.g; if (!g) return;
  const [W, D] = edBed(cur), dark = edDark(), bad = !!(cur.chk && cur.chk.bad.length), key = `${W}x${D}:${bad}:${dark}`;
  if (g.bedKey === key && g.bed.children.length) return;
  g.bedKey = key;
  while (g.bed.children.length) { const o = g.bed.children.pop(); if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }
  const pl = new T.Mesh(new T.PlaneGeometry(W, D), new T.MeshBasicMaterial({ color: dark ? 0x2a3532 : 0xdde2df }));
  pl.position.set(W / 2, D / 2, -0.05); g.bed.add(pl);
  const pts = [];
  for (let x = 10; x < W; x += 10) pts.push(x, 0, 0, x, D, 0);
  for (let y = 10; y < D; y += 10) pts.push(0, y, 0, W, y, 0);
  const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
  g.bed.add(new T.LineSegments(lg, new T.LineBasicMaterial({ color: dark ? 0x3a4743 : 0xc6cdca })));
  const bd = new T.BufferGeometry(); bd.setAttribute('position', new T.Float32BufferAttribute([0, 0, 0.02, W, 0, 0.02, W, D, 0.02, 0, D, 0.02, 0, 0, 0.02], 3));
  g.bed.add(new T.Line(bd, new T.LineBasicMaterial({ color: bad ? 0xc62f3a : dark ? 0x66716e : 0x9aa6a2 })));
  edDraw();
}
/** Netze aufbauen: je Teil eine BufferGeometry (geteilt), je Kopie ein Mesh mit fester Matrix */
function edMeshes(cur) {
  const T = window.THREE, g = ED.g; if (!g) return;
  while (g.parts.children.length) { const o = g.parts.children.pop(); if (o.material) [].concat(o.material).forEach(x => x.dispose()); }
  g.meshes = [];
  cur.parts.forEach((p, pi) => {
    if (!p.bg) {
      p.bg = new T.BufferGeometry();
      p.bg.setAttribute('position', new T.BufferAttribute(p.geo.pos, 3));
      p.bg.setIndex(new T.BufferAttribute(p.geo.idx, 1));
      p.bg.computeBoundingSphere();
    }
    const grp = p.kind === '3mf' && p.geo.groups && p.geo.groups.length > 1;
    if (grp && !p.bg.groups.length) p.geo.groups.forEach((gr, gi) => p.bg.addGroup(gr.s * 3, gr.n * 3, gi));
    const mat = (c, it) => new T.MeshPhongMaterial({ color: new T.Color(c), flatShading: true, shininess: 18, specular: 0x1a1a1a, side: T.DoubleSide, transparent: !!it.skip, opacity: it.skip ? 0.28 : 1 });
    p.inst.forEach((it, ii) => {
      const m = new T.Mesh(p.bg, grp ? p.geo.groups.map(gr => mat(ed3Col(cur, gr.c + 1), it)) : mat(edColorOf(cur, p), it));
      m.userData = { pi, ii, shared: true }; m.matrixAutoUpdate = false;
      g.parts.add(m); g.meshes.push(m);
    });
  });
  edPose(cur);
}
/** Matrizen + Hervorhebung + Werkzeug-Griffe nachziehen */
function edPose(cur) {
  const T = window.THREE, g = ED.g; if (!g) return;
  edCheck(cur);
  const sel = cur.sel;
  for (const m of g.meshes) {
    const p = cur.parts[m.userData.pi], it = p && p.inst[m.userData.ii]; if (!it) continue;
    const L = it.L, tx = it.x - (it.bb.lo[0] + it.bb.hi[0]) / 2, ty = it.y - (it.bb.lo[1] + it.bb.hi[1]) / 2, tz = -it.bb.lo[2];
    m.matrix.set(L[0], L[1], L[2], tx, L[3], L[4], L[5], ty, L[6], L[7], L[8], tz, 0, 0, 0, 1);
    m.matrixWorldNeedsUpdate = true;
    const on = sel && sel.p === m.userData.pi && sel.i === m.userData.ii, bad = it.over > 0.3 || it.tall > 0.3;
    [].concat(m.material).forEach(x => { x.emissive = new T.Color(bad ? 0xc62f3a : on ? 0x0f766e : 0x000000); x.emissiveIntensity = bad ? 0.5 : on ? 0.4 : 0; });
  }
  edGizmo(cur);
  edBedDraw(cur);
  edDraw();   // sofort neu zeichnen (beim Ziehen bewegt sich das Teil live mit; vorher erst beim Loslassen, User 19.11.2026)
}
function edGizmo(cur) {
  const T = window.THREE, g = ED.g; if (!g) return;
  while (g.giz.children.length) { const o = g.giz.children.pop(); o.traverse(x => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); }); }
  g.handles = [];
  const it = edSelInst(cur); if (!it) return;
  const b = edWorld(it), bad = it.over > 0.3 || it.tall > 0.3;
  const box = new T.Box3(new T.Vector3(b[0], b[1], 0), new T.Vector3(b[2], b[3], b[4]));
  g.giz.add(new T.Box3Helper(box, new T.Color(bad ? 0xc62f3a : 0x0f766e)));
  const r = Math.max(8, Math.hypot(it.bb.d[0], it.bb.d[1]) / 2), [BW, BD] = edBed(cur);
  const fp = new T.Mesh(new T.PlaneGeometry(b[2] - b[0] + 4, b[3] - b[1] + 4), new T.MeshBasicMaterial({ color: bad ? 0xc62f3a : 0x0f766e, transparent: true, opacity: 0.28, depthWrite: false }));
  fp.position.set(it.x, it.y, 0.06); g.giz.add(fp);
  if (cur.tool === 'move') {
    const len = Math.max(Math.hypot(BW, BD) * 0.09, Math.min(70, r * 1.1)), o = new T.Vector3(it.x, it.y, b[4] + 0.5), hl = len * 0.3, hw = len * 0.2;
    const ax = new T.ArrowHelper(new T.Vector3(1, 0, 0), o, len, 0xc2410c, hl, hw), ay = new T.ArrowHelper(new T.Vector3(0, 1, 0), o, len, 0x1d5fbf, hl, hw);
    [ax, ay].forEach((a, k) => { a.traverse(x => { if (x.material) { x.material.depthTest = false; x.material.transparent = true; } x.renderOrder = 4; }); g.giz.add(a);
      const sh = new T.Mesh(new T.CylinderGeometry(len * 0.035, len * 0.035, len - hl, 8), new T.MeshBasicMaterial({ color: k ? 0x1d5fbf : 0xc2410c, depthTest: false, transparent: true }));
      sh.position.copy(o).add(k ? new T.Vector3(0, (len - hl) / 2, 0) : new T.Vector3((len - hl) / 2, 0, 0)); if (!k) sh.rotation.z = Math.PI / 2; sh.renderOrder = 4; g.giz.add(sh);
      // unsichtbarer dicker Griff zum Anfassen (Linien trifft der Strahl schlecht)
      const cyl = new T.Mesh(new T.CylinderGeometry(len * 0.14, len * 0.14, len, 8), new T.MeshBasicMaterial({ visible: false }));
      cyl.position.copy(o).add(k ? new T.Vector3(0, len / 2, 0) : new T.Vector3(len / 2, 0, 0));
      if (!k) cyl.rotation.z = Math.PI / 2;
      cyl.userData.axis = k ? 'y' : 'x'; g.giz.add(cyl); g.handles.push(cyl); });
  }
  if (cur.tool === 'rotate') {
    const rr = r * 1.25 + 4, w = Math.max(1.6, rr * 0.05);
    const ring = new T.Mesh(new T.RingGeometry(rr - w / 2, rr + w / 2, 96), new T.MeshBasicMaterial({ color: 0xc2410c, side: T.DoubleSide, depthTest: false, transparent: true }));
    ring.position.set(it.x, it.y, 0.3); ring.renderOrder = 2; g.giz.add(ring);
    const hit = new T.Mesh(new T.RingGeometry(rr - w * 3, rr + w * 3, 64), new T.MeshBasicMaterial({ visible: false, side: T.DoubleSide }));
    hit.position.copy(ring.position); hit.userData.ring = true; g.giz.add(hit); g.handles.push(hit);
    const a = (it.rz || 0) * Math.PI / 180 - Math.PI / 2;
    const dot = new T.Mesh(new T.SphereGeometry(w * 2.2, 16, 12), new T.MeshBasicMaterial({ color: 0xc2410c, depthTest: false }));
    dot.position.set(it.x + Math.cos(a) * rr, it.y + Math.sin(a) * rr, 0.5); dot.renderOrder = 3; g.giz.add(dot);
  }
}
/** Maßangabe über dem gewählten Teil (HTML, folgt der Kamera) */
function edLabel() {
  const g = ED.g, cur = ED.cur, el = document.getElementById('edlbl'); if (!g || !cur || !el) return;
  const it = edSelInst(cur);
  if (!it || !edWide()) { el.hidden = true; return; }
  const T = window.THREE, b = edWorld(it), v = new T.Vector3(b[2], (b[1] + b[3]) / 2, b[4]).project(g.cam);
  if (v.z > 1) { el.hidden = true; return; }
  const w = g.host.clientWidth, h = g.host.clientHeight;
  el.style.left = Math.round((v.x + 1) / 2 * w + 10) + 'px'; el.style.top = Math.round((1 - v.y) / 2 * h - 30) + 'px';
  el.textContent = `${edF0(it.bb.d[0])} × ${edF0(it.bb.d[1])} × ${edF0(it.bb.d[2])} mm`;
  el.hidden = false;
}
function edView(cur, k) {
  const g = ED.g; if (!g) return;
  const [W, D] = edBed(cur), cx = W / 2, cy = D / 2, r = Math.hypot(W, D) / 2 * 1.04;
  const vf = g.cam.fov * Math.PI / 360, hf = Math.atan(Math.tan(vf) * g.cam.aspect), dist = r / Math.sin(Math.min(vf, hf));
  const dir = k === 'top' ? [0, -0.0001, 1] : k === 'front' ? [0, -1, 0.32] : [0.5, -0.82, 0.78], l = Math.hypot(...dir), tz = k === 'front' ? 10 : 0;
  g.ctl.target.set(cx, cy, tz);
  g.cam.position.set(cx + dir[0] / l * dist, cy + dir[1] / l * dist, tz + dir[2] / l * dist);
  g.cam.updateProjectionMatrix(); g.ctl.update(); cur.vk = k; edDraw();
}

// ── Zeiger: Teil wählen, ziehen (frei oder entlang eines Pfeils), am Ring drehen, Fläche antippen ────────────────────────────────
function edNdc(g, e) { const r = g.r.domElement.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
function edBedHit(g, e, z = 0) {
  g.ray.setFromCamera(edNdc(g, e), g.cam);
  const pt = new THREE.Vector3();
  return g.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), pt) ? pt : null;
}
function edPointer(cur, host) {
  const g = ED.g; let drag = null;
  host.addEventListener('pointerdown', e => {
    if (!ED.g || (e.pointerType === 'mouse' && e.button !== 0) || drag) return;
    g.scene.updateMatrixWorld();
    g.ray.setFromCamera(edNdc(g, e), g.cam);
    const it0 = edSelInst(cur);
    // Griffe zuerst (Pfeile, Ring), dann Teile
    if (it0 && g.handles && g.handles.length) {
      const h = g.ray.intersectObjects(g.handles, false)[0];
      if (h && h.object.userData.axis) { const p0 = edBedHit(g, e, 0); if (p0) drag = { k: 'axis', axis: h.object.userData.axis, p0, x0: it0.x, y0: it0.y, it: it0 }; }
      else if (h && h.object.userData.ring) { const p0 = edBedHit(g, e, 0.3); if (p0) drag = { k: 'ring', a0: Math.atan2(p0.y - it0.y, p0.x - it0.x), L0: it0.L.slice(), rz0: it0.rz || 0, it: it0, snap: null }; }
    }
    if (!drag) {
      const hit = g.ray.intersectObjects(g.meshes, false)[0];
      if (hit) {
        const { pi, ii } = hit.object.userData;
        const changed = !cur.sel || cur.sel.p !== pi || cur.sel.i !== ii;
        cur.sel = { p: pi, i: ii };
        const it = cur.parts[pi].inst[ii];
        if (cur.tool === 'flat' && hit.face) { edLayFlat(cur, cur.parts[pi], it, hit.face.normal); return; }
        if (cur.tool === 'move' || cur.tool === 'rotate' || cur.tool === 'scale' || cur.tool === 'color') {
          const p0 = edBedHit(g, e, 0);
          if (p0 && cur.tool === 'move') drag = { k: 'free', p0, x0: it.x, y0: it.y, it };
        }
        if (changed) { edPose(cur); edPanel(cur); }
      }
    }
    if (drag) {
      g.ctl.enabled = false; drag.id = e.pointerId; drag.moved = false;
      try { host.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault(); e.stopPropagation();
    }
  }, true);
  host.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id || !ED.g) return;
    const it = drag.it;
    if (drag.k === 'free' || drag.k === 'axis') {
      const p = edBedHit(g, e, 0); if (!p) return;
      if (!drag.moved) { edPush(cur); drag.moved = true; }
      const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      it.x = drag.x0 + (drag.k === 'axis' && drag.axis === 'y' ? 0 : dx); it.y = drag.y0 + (drag.k === 'axis' && drag.axis === 'x' ? 0 : dy);
    } else if (drag.k === 'ring') {
      const p = edBedHit(g, e, 0.3); if (!p) return;
      let deg = (Math.atan2(p.y - it.y, p.x - it.x) - drag.a0) * 180 / Math.PI;
      deg = Math.round(deg / 15) * 15;
      if (deg === drag.snap) return;
      if (!drag.moved) { edPush(cur); drag.moved = true; }
      drag.snap = deg;
      it.L = edMul(edRot('z', deg), drag.L0); it.rz = (((drag.rz0 + deg) % 360) + 360) % 360;
      edFix(cur.parts[cur.sel.p], it);
    }
    edPose(cur); edPanelLive(cur);
  });
  const up = e => {
    if (!drag || e.pointerId !== drag.id) return;
    try { host.releasePointerCapture(e.pointerId); } catch (x) {}
    const moved = drag.moved; drag = null;
    if (ED.g) ED.g.ctl.enabled = true;
    if (moved) { edPose(cur); edPanel(cur); }
  };
  host.addEventListener('pointerup', up); host.addEventListener('pointercancel', up);
}
/** Fläche nach unten: Weltnormale der angetippten Fläche auf (0, 0, −1) drehen */
function edLayFlat(cur, p, it, nLocal) {
  const L = it.L, T = window.THREE;
  // Normale ins Welt-System: (L⁻¹)ᵀ·n
  const m = new T.Matrix3().set(L[0], L[1], L[2], L[3], L[4], L[5], L[6], L[7], L[8]);
  const nm = m.clone().invert().transpose(), n = nLocal.clone().applyMatrix3(nm).normalize();
  const q = new T.Quaternion().setFromUnitVectors(n, new T.Vector3(0, 0, -1)), R4 = new T.Matrix4().makeRotationFromQuaternion(q), e = R4.elements;
  const R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]].map(v => Math.abs(v) < 1e-9 ? 0 : v);
  edPush(cur);
  it.L = edMul(R, L); edFix(p, it);
  edPose(cur); edPanel(cur);
  toast(t('amp_ed_flat_done'));
}
/** Beste Fläche: größte ebene Fläche, auf der das Teil stehen kann (alle Ecken auf einer Seite) */
function edAutoFlat(cur) {
  const p = edSelPart(cur), it = edSelInst(cur); if (!p || !it) return;
  const P = p.geo.pos, I = p.geo.idx, L = it.L, groups = new Map();
  const wv = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) { const x = P[i], y = P[i + 1], z = P[i + 2]; wv[i] = L[0] * x + L[1] * y + L[2] * z; wv[i + 1] = L[3] * x + L[4] * y + L[5] * z; wv[i + 2] = L[6] * x + L[7] * y + L[8] * z; }
  const flip = edDet(L) < 0 ? -1 : 1;
  for (let f = 0; f < I.length; f += 3) {
    const a = I[f] * 3, b = I[f + 1] * 3, c = I[f + 2] * 3;
    const ux = wv[b] - wv[a], uy = wv[b + 1] - wv[a + 1], uz = wv[b + 2] - wv[a + 2], vx = wv[c] - wv[a], vy = wv[c + 1] - wv[a + 1], vz = wv[c + 2] - wv[a + 2];
    let nx = (uy * vz - uz * vy) * flip, ny = (uz * vx - ux * vz) * flip, nz = (ux * vy - uy * vx) * flip;
    const len = Math.hypot(nx, ny, nz); if (len < 1e-9) continue;
    nx /= len; ny /= len; nz /= len;
    const key = `${Math.round(nx * 40)},${Math.round(ny * 40)},${Math.round(nz * 40)}`;
    const gr = groups.get(key) || { a: 0, n: [0, 0, 0], off: -Infinity };
    gr.a += len / 2; gr.n[0] += nx * len; gr.n[1] += ny * len; gr.n[2] += nz * len;
    gr.off = Math.max(gr.off, nx * wv[a] + ny * wv[a + 1] + nz * wv[a + 2]);
    groups.set(key, gr);
  }
  const cand = [...groups.values()].sort((x, y) => y.a - x.a).slice(0, 16);
  let best = null;
  for (const gr of cand) {
    const l = Math.hypot(...gr.n); if (!l) continue;
    const n = gr.n.map(v => v / l);
    let mx = -Infinity;
    for (let i = 0; i < wv.length; i += 3) { const d = n[0] * wv[i] + n[1] * wv[i + 1] + n[2] * wv[i + 2]; if (d > mx) mx = d; }
    if (Math.abs(mx - gr.off) < Math.max(0.15, it.bb.d.reduce((a, b) => Math.max(a, b), 0) * 0.004)) { best = n; break; }
  }
  if (!best) { toast(t('amp_ed_flat_none')); return; }
  // Normale liegt schon im Welt-System → als „lokale“ mit L = I behandeln
  const T = window.THREE, q = new T.Quaternion().setFromUnitVectors(new T.Vector3(...best), new T.Vector3(0, 0, -1)), e = new T.Matrix4().makeRotationFromQuaternion(q).elements;
  const R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]].map(v => Math.abs(v) < 1e-9 ? 0 : v);
  edPush(cur); it.L = edMul(R, L); edFix(p, it); edPose(cur); edPanel(cur);
  toast(t('amp_ed_flat_done'));
}

// ── Bauen der Druckdatei (3MF wie Orca/Bambu: je Kopie ein eigenes Objekt, Lage eingerechnet) ───────────────────────────────────
const ED_CRC = (() => { const tb = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; } return tb; })();
function edCrc(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = ED_CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function edDeflate(u8) {
  if (typeof CompressionStream !== 'function') return null;
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
}
async function edZip(files) {
  const enc = new TextEncoder(), loc = [], cen = []; let off = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data, name = enc.encode(f.name), crc = edCrc(raw);
    const z = raw.length > 256 ? await edDeflate(raw) : null, data = z && z.length < raw.length ? z : raw, method = data === raw ? 0 : 8;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, method, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, name.length, true);
    loc.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, method, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, raw.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = cen.reduce((a, x) => a + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...loc, ...cen, new Uint8Array(e.buffer)], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
}
const edXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const edUuid = n => ('00000000' + n.toString(16)).slice(-8) + '-a3f1-4d2e-9c7b-' + ('000000000000' + n.toString(16)).slice(-12);
/**
 * 3MF aus der Anordnung: { blob, exts: [{ ext, slot, color, type }], map: {ext: slot}, slot1, n }.
 * Ein Fach → alles Extruder 1 (die Druckansicht wählt das Fach vor); mehrere (mehrfarbiger Drucker) → Extruder je Fach, edMap ordnet zu.
 */
async function edBuild3mf(cur, prog) {
  const pr = cur.pr, [W, D, H] = edBed(cur), multi = edMultiOf(pr);
  const items = []; cur.parts.forEach(p => p.inst.forEach((it, k) => { if (!it.skip) items.push({ p, it, k }); }));
  if (!items.length) throw edErr('empty');
  const slotKey = p => { const s = edSlotOf(cur, p); return s ? String(s.index) : ''; };
  const keys = multi ? [...new Set(items.map(x => slotKey(x.p)))] : [slotKey(items[0].p)];
  const exts = keys.map((k, i) => { const s = edSlotsOf(pr).find(x => String(x.index) === k); return { ext: i + 1, slot: k, color: (s && s.color) || '#FFFFFF', type: (s && s.material) || 'PLA' }; });
  const extOf = p => multi ? keys.indexOf(slotKey(p)) + 1 : 1;
  const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';
  const files = [], res = [], build = [], cfgObj = [], cfgInst = [], asm = [], rels = [];
  for (let n = 0; n < items.length; n++) {
    const { p, it } = items[n], L = it.L, P = p.geo.pos, I = p.geo.idx, flip = edDet(L) < 0;
    if (prog) prog(n + 1, items.length);
    const cx = (it.bb.lo[0] + it.bb.hi[0]) / 2, cy = (it.bb.lo[1] + it.bb.hi[1]) / 2, z0 = it.bb.lo[2];
    const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ' + NS + '>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n  <object id="'
      + (2 * n + 1) + '" p:UUID="' + edUuid(2 * n + 1) + '" type="model">\n   <mesh>\n    <vertices>\n'];
    let chunk = [];
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      chunk.push('<vertex x="' + edNum(L[0] * x + L[1] * y + L[2] * z - cx) + '" y="' + edNum(L[3] * x + L[4] * y + L[5] * z - cy) + '" z="' + edNum(L[6] * x + L[7] * y + L[8] * z - z0) + '"/>');
      if (chunk.length >= 20000) { out.push(chunk.join('\n') + '\n'); chunk = []; }
    }
    out.push(chunk.join('\n') + '\n    </vertices>\n    <triangles>\n'); chunk = [];
    for (let f = 0; f < I.length; f += 3) {
      chunk.push(flip ? '<triangle v1="' + I[f] + '" v2="' + I[f + 2] + '" v3="' + I[f + 1] + '"/>' : '<triangle v1="' + I[f] + '" v2="' + I[f + 1] + '" v3="' + I[f + 2] + '"/>');
      if (chunk.length >= 20000) { out.push(chunk.join('\n') + '\n'); chunk = []; }
    }
    out.push(chunk.join('\n') + '\n    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build/>\n</model>\n');
    const path = '3D/Objects/object_' + (n + 1) + '.model', oid = 2 * n + 2, ext = extOf(p);
    files.push({ name: path, data: new Uint8Array(await new Blob(out).arrayBuffer()) });
    const nm = p.inst.length > 1 ? `${p.name} (${items[n].k + 1})` : p.name;
    res.push('  <object id="' + oid + '" p:UUID="' + edUuid(oid) + '" type="model"><components><component p:path="/' + path + '" objectid="' + (2 * n + 1) + '" p:UUID="' + edUuid(10000 + n) + '" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>');
    const tr = '1 0 0 0 1 0 0 0 1 ' + edNum(it.x) + ' ' + edNum(it.y) + ' 0';
    build.push('<item objectid="' + oid + '" p:UUID="' + edUuid(20000 + n) + '" transform="' + tr + '" printable="1"/>');
    rels.push('<Relationship Target="/' + path + '" Id="rel-' + (n + 2) + '" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>');
    // Stützen je Teil (Objekt-Einstellung wie in Orca/Bambu: gilt nur für dieses Objekt, die Druckansicht schaltet sie global)
    const sup = p.sup === 'auto' || p.sup === 'bed' ? '<metadata key="enable_support" value="1"/>' + (p.sup === 'bed' ? '<metadata key="support_on_build_plate_only" value="1"/>' : '') : '';
    cfgObj.push('  <object id="' + oid + '"><metadata key="name" value="' + edXml(nm) + '"/><metadata key="extruder" value="' + ext + '"/>' + sup + '<part id="' + (2 * n + 1)
      + '" subtype="normal_part"><metadata key="name" value="' + edXml(nm) + '"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/><metadata key="extruder" value="' + ext
      + '"/><mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/></part></object>');
    cfgInst.push('<model_instance><metadata key="object_id" value="' + oid + '"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="' + (500 + n) + '"/></model_instance>');
    asm.push('<assemble_item object_id="' + oid + '" instance_id="0" transform="' + tr + '" offset="0 0 0"/>');
    await new Promise(r => setTimeout(r, 0));   // Oberfläche atmen lassen
  }
  const main = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ' + NS + '>\n <metadata name="Application">BambuStudio-02.06.00.51</metadata>\n'
    + ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n <metadata name="Title">' + edXml(cur.name || 'AllMyPrinters') + '</metadata>\n <metadata name="Designer">AllMyPrinters Editor</metadata>\n'
    + ' <resources>\n' + res.join('\n') + '\n </resources>\n <build p:UUID="' + edUuid(999) + '">' + build.join('') + '</build>\n</model>\n';
  const cfg = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + cfgObj.join('\n') + '\n  <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/>'
    + cfgInst.join('') + '</plate>\n  <assemble>' + asm.join('') + '</assemble>\n</config>\n';
  // Projekteinstellungen wie die Generatoren (ohne diese Schlüssel stürzt Orca ab), dazu das Bett des Druckers: dann rückt Orca nichts
  const nf = exts.length, flush = [];
  for (let r = 0; r < nf; r++) for (let q = 0; q < nf; q++) flush.push(r === q ? '0' : '280');
  const ps = { printer_settings_id: 'AllMyPrinters Editor', print_settings_id: 'AllMyPrinters Editor', nozzle_diameter: ['0.4'], printable_height: edNum(H),
    printable_area: ['0x0', `${edNum(W)}x0`, `${edNum(W)}x${edNum(D)}`, `0x${edNum(D)}`],
    filament_settings_id: exts.map(() => 'AllMyPrinters PLA'), flush_volumes_matrix: flush, wipe_tower_x: ['15'], wipe_tower_y: ['15'],
    filament_colour: exts.map(x => x.color), filament_type: exts.map(x => x.type) };
  const all = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: main },
    { name: '3D/_rels/3dmodel.model.rels', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>' },
    { name: 'Metadata/model_settings.config', data: cfg },
    ...files,
    { name: 'Metadata/project_settings.config', data: JSON.stringify(ps, null, 4) },
  ];
  const blob = await edZip(all);
  const map = {}; exts.forEach(x => { if (x.slot !== '') map[x.ext] = +x.slot; });
  return { blob, exts, map: multi && nf > 1 ? map : null, slot1: exts[0] && exts[0].slot !== '' ? +exts[0].slot : null, n: items.length };
}

// ── Öffnen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Editor öffnen: parts [{ id?, name, file, n, slot, inst? }], plate (Bibliothekseintrag) oder null, printer (Schlüssel) oder null */
async function ampEdOpen(parts, plate, printer) {
  if (!(await ampFeat('editor'))) { ampPlanDeny('editor'); return false; }
  ED.hand = { parts, plate: plate || null, printer: printer || (plate && plate.edp) || null };
  if (dlg.open) dlg.close();
  if (location.hash === '#edit') viewEdit(); else location.hash = 'edit';
  return true;
}
/** Bibliothek → Editor: Dateien holen (mit NAS-Fehlern wie „Drucken“) */
async function ampEdFromLib(list, plate, o = {}) {
  if (!(await ampFeat('editor'))) { ampPlanDeny('editor'); return false; }
  try {
    const items = await ampPlateFetch(list, o.prog);
    return ampEdOpen(items, plate, o.printer);
  } catch (e) { (o.err || toast)(ampPlateErr(e)); return false; }
}
async function edBuildCur(h) {
  const pool = {}, parts = [];
  let budget = ED_TRI_MAX, src3 = null, plate3 = 0;
  const is3 = s => /\.3mf$/i.test(String((s.file && s.file.name) || s.name || '')) || s.ext === '3mf';
  const msg = (i, n) => { const m = document.getElementById('edload'); if (m) m.textContent = t('amp_plate_loading', { i, n }); };
  // 3MF zuerst (eine je Platte): sie ist die Grundlage, STL-Teile kommen als neue Objekte dazu
  const list = h.parts.slice().sort((a, b) => is3(b) - is3(a));
  if (list.filter(is3).length > 1) throw edErr('two_3mf', list.filter(is3)[1].name);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    msg(i + 1, list.length); await new Promise(r => setTimeout(r, 0));
    if (is3(s)) {
      src3 = await edRead3mf(s.file, budget);
      src3.libId = s.id || null; src3.name = s.name || String(s.file.name || '').replace(/\.3mf$/i, '');
      plate3 = Math.max(0, Math.min(src3.plates.length - 1, (+s.plate3 || +h.plate3 || 1) - 1));
      if (!src3.plates[plate3].items.length) { const k = src3.plates.findIndex(pl => pl.items.length); if (k >= 0) plate3 = k; }
      await ed3Parts(src3, plate3, pool, parts, n => { budget -= n; if (budget < 0) throw edErr('too_big', s.name); });
      continue;
    }
    const geo = await edReadStl(s.file, budget);
    budget -= geo.nt;
    if (budget < 0) throw edErr('too_big', s.name);
    const key = 'k' + Object.keys(pool).length, p = { key, kind: 'stl', id: s.id || null, name: s.name || String(s.file.name || '').replace(/\.stl$/i, ''), file: s.file, geo, slot: s.slot != null ? String(s.slot) : '', sup: ['auto', 'bed'].includes(s.sup) ? s.sup : '', ext3: 1, inst: [] };
    const n = Math.max(1, Math.min(100, +s.n || 1)), saved = Array.isArray(s.inst) ? s.inst : null;
    for (let k = 0; k < n; k++) {
      const q = saved && saved[k];
      const it = q && Array.isArray(q.L) && q.L.length === 9 ? { L: q.L.map(Number), x: +q.x || 0, y: +q.y || 0, s: +q.s || 1, skip: !!q.skip, rz: 0 } : { L: ED_I3.slice(), x: 0, y: 0, s: 1, skip: false, rz: 0, fresh: true };
      edFix(p, it); p.inst.push(it);
    }
    pool[key] = p; parts.push(p);
  }
  if (src3 && parts.some(p => p.kind === 'stl') && src3.kind !== 'bambu') throw edErr('mix_prusa', src3.name);
  const name = src3 ? src3.name : h.plate ? h.plate.name : parts.length > 1 ? t('amp_plate_n_models', { n: parts.length }) : parts.length ? parts[0].name : t('amp_ed_new');
  return { name, plateId: h.plate ? h.plate.id : null, mode: src3 ? '3mf' : 'stl', src3, plate3, gone: [], map3: {},
    parts, pool, sel: parts.length ? { p: 0, i: 0 } : null, tool: 'move', undo: [], redo: [], unit: 'mm', lock: true, want: h.printer, slot1: '' };
}
/** Teile einer 3MF-Platte: je Druckobjekt ein Teil, je <item> eine Kopie; Lage zuerst im Projekt-System (it.g), Bett folgt in ed3Place */
async function ed3Parts(src3, pi, pool, parts, count) {
  const pl = src3.plates[pi], byObj = new Map();
  for (const bi of pl.items) { const it = src3.items[bi]; if (!byObj.has(it.oid)) byObj.set(it.oid, []); byObj.get(it.oid).push(it); }
  for (const [oid, its] of byObj) {
    const geo = await src3.geoOf(oid); if (!geo) continue;
    count(geo.nt);
    const key = 'k' + Object.keys(pool).length, o = src3.objs[oid] || {};
    const p = { key, kind: '3mf', oid, id: src3.libId, name: o.name || t('amp_ed_obj_n', { n: parts.length + 1 }), geo, slot: '', sup: '', inst: [] };
    for (const it of its) {
      const m = it.mx, u = src3.unit, L = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
      const c = geo.c0, Lc = [L[0] * c[0] + L[1] * c[1] + L[2] * c[2], L[3] * c[0] + L[4] * c[1] + L[5] * c[2], L[6] * c[0] + L[7] * c[1] + L[8] * c[2]];
      const q = { L, x: 0, y: 0, s: Math.cbrt(Math.abs(edDet(L))) || 1, skip: false, rz: 0, bi: it.i };
      edFix(p, q);
      q.g = [(q.bb.lo[0] + q.bb.hi[0]) / 2 + Lc[0] + m[9] * u, (q.bb.lo[1] + q.bb.hi[1]) / 2 + Lc[1] + m[10] * u];   // Mitte im Projekt-System (mm)
      p.inst.push(q);
    }
    pool[key] = p; parts.push(p);
  }
}
/** Projekt-System → Bett des gewählten Druckers: Plattenursprung abziehen, Bettmitten angleichen (wie Orca beim Slicen ohne Anordnen) */
function ed3Place(cur) {
  const s3 = cur.src3; if (!s3) return;
  const pl = s3.plates[cur.plate3], [W, D] = edBed(cur), sb = s3.bed || [W, D];
  cur.sh3 = [(W - sb[0]) / 2, (D - sb[1]) / 2];
  cur.parts.forEach(p => p.inst.forEach(q => { if (q.g) { q.x = q.g[0] - pl.origin[0] + cur.sh3[0]; q.y = q.g[1] - pl.origin[1] + cur.sh3[1]; delete q.g; } }));
}
async function edPrinters(cur) {
  let ps_ = [], beds = [];
  try { ps_ = (await api('print_printers')).printers || []; } catch (e) {}
  try { beds = (await api('amp_lib_beds')).printers || []; } catch (e) {}
  cur.printers = ps_.map(p => ({ ...p, bed: ((beds.find(b => b.key === p.key) || {}).bed) || null }));
  try { const c = await api('amp_slicer_caps', {}); cur.slcOld = c && c.own && (c.missing || []).includes('bed') ? c.version || '?' : null; } catch (e) { cur.slcOld = null; }
  let k = cur.want; try { if (!k) k = localStorage.getItem('amp_ed_pr'); } catch (e) {}
  cur.pr = cur.printers.find(p => p.key === k) || cur.printers.find(p => p.bed) || cur.printers[0] || null;
  edSetBed(cur);
}
function edSetBed(cur) {
  const b = cur.pr && Array.isArray(cur.pr.bed) && cur.pr.bed[0] > 0 ? cur.pr.bed : null;
  cur.bed = b ? [+b[0], +b[1], +b[2] || 250] : ED_BED0.slice(); cur.bedKnown = !!b;
  if (!cur.slot1 || !edSlotsOf(cur.pr).some(s => String(s.index) === String(cur.slot1) && edSlotOk(s))) cur.slot1 = String(edDefSlot(cur.pr));
  if (edMultiOf(cur.pr)) cur.parts.forEach(p => { if (!edSlotsOf(cur.pr).some(s => String(s.index) === String(p.slot) && edSlotOk(s))) p.slot = String(edDefSlot(cur.pr)); });
}

async function viewEdit() {
  view.innerHTML = `<div class="amp-ed amp-edload"><p class="hint" id="edload">${esc(t('amp_plate_loading', { i: 1, n: 1 }))}</p></div>`;
  if (ED.hand) {
    const h = ED.hand; ED.hand = null;
    try {
      const cur = await edBuildCur(h);
      await edPrinters(cur);
      if (cur.mode === '3mf') {
        ed3Place(cur); ed3AutoMap(cur);
        cur.parts.forEach(p => p.inst.forEach(i => { if (i.fresh) { delete i.fresh; [i.x, i.y] = edFreeSpot(cur, Object.assign(i, { x: edBed(cur)[0] / 2, y: edBed(cur)[1] / 2 })); } }));
      } else if (cur.parts.some(p => p.inst.some(i => i.fresh))) edArrange(cur);
      cur.parts.forEach(p => p.inst.forEach(i => { delete i.fresh; }));
      ED.cur = cur;
    } catch (e) {
      const msg = e.message === 'too_big' ? t('amp_ed_too_big', { name: e.part, n: ED_TRI_MAX / 1e6 }) : ['two_3mf', 'mix_prusa', 'gcode3mf'].includes(e.message) ? t('amp_ed_' + e.message, { name: e.part || '?' }) : t('amp_ed_bad_file', { name: e.part || '?' });
      view.innerHTML = `<div class="amp-ed"><div class="empty"><b>${esc(msg)}</b><br><br><a class="btn" href="#library">${esc(t('tab_library'))}</a></div></div>`;
      return;
    }
  }
  const cur = ED.cur;
  if (!cur) {
    view.innerHTML = `<div class="amp-ed"><div class="empty"><b>${esc(t('amp_ed_empty_h'))}</b><p class="hint">${esc(t('amp_ed_empty_p'))}</p><a class="btn pri" href="#library">${esc(t('tab_library'))}</a></div></div>`;
    return;
  }
  try { await edThree(); } catch (e) { view.innerHTML = `<div class="amp-ed"><div class="empty"><b>${esc(t('amp_ed_no_webgl'))}</b></div></div>`; return; }
  if (location.hash !== '#edit') return;
  edRender(cur);
}
// Verlassen der Ansicht: WebGL freigeben (der Zustand bleibt in ED.cur — zurück aus der Druckansicht steht alles noch so da)
window.addEventListener('hashchange', () => { if (location.hash !== '#edit' && ED.g) edGfxDrop(); });

// ── Oberfläche ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ED_TOOLS = [['move', 'move', 'amp_ed_t_move'], ['rotate', 'rotate', 'amp_ed_t_rotate'], ['scale', 'scale', 'amp_ed_t_scale'], ['flat', 'flat', 'amp_ed_t_flat'], ['color', 'color', 'amp_ed_t_color']];
function edRender(cur) {
  edGfxDrop();
  const back = cur.plateId ? `#library/${cur.plateId}` : '#library';
  view.innerHTML = `<div class="amp-ed" id="amped" data-tool="${cur.tool}">
    <div class="amp-edhd">
      <a class="amp-edback" href="${back}" aria-label="${esc(t('tab_library'))}">${edI(EI.back)}<span>${esc(t('tab_library'))}</span></a>
      <div class="amp-edtt"><small>${esc(t('amp_ed_title'))}</small><b id="edname">${esc(cur.name)}</b></div>
      <label class="amp-edpr">${edI(EI.printer)}<select id="edpr" aria-label="${esc(t('amp_ed_printer'))}">${(cur.printers || []).map(p => `<option value="${esc(p.key)}"${cur.pr && p.key === cur.pr.key ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}${(cur.printers || []).length ? '' : `<option>${esc(t('amp_no_printers'))}</option>`}</select><small id="edbed"></small></label>
      ${cur.mode === '3mf' && cur.src3.plates.length > 1 ? `<label class="amp-edpr amp-edpl"><span>${esc(t('amp_ed_plate_pick'))}</span><select id="edpl" aria-label="${esc(t('amp_ed_plate_pick'))}">${cur.src3.plates.map((pl, i) => `<option value="${i}"${i === cur.plate3 ? ' selected' : ''}${pl.items.length ? '' : ' disabled'}>${esc(t('psd_pl_n', { n: i + 1 }) + (pl.name ? ' · ' + pl.name : ''))}</option>`).join('')}</select></label>` : ''}
      <span class="grow"></span>
      <button type="button" class="amp-edib" id="edundo" aria-label="${esc(t('amp_ed_undo'))}" title="${esc(t('amp_ed_undo'))}">${edI(EI.undo)}</button>
      <button type="button" class="amp-edib" id="edredo" aria-label="${esc(t('amp_ed_redo'))}" title="${esc(t('amp_ed_redo'))}">${edI(EI.redo)}</button>
      <button type="button" class="btn amp-edsave" id="edsave">${esc(t(cur.mode === '3mf' ? 'amp_ed_save3' : cur.plateId ? 'amp_plate_update' : 'amp_plate_save'))}</button>
      <button type="button" class="btn pri amp-edgo" id="edgo">${esc(t('amp_ed_print'))}</button>
    </div>
    <div class="amp-edst" id="edst"></div>
    <div class="amp-edbody">
      <aside class="amp-edparts" aria-label="${esc(t('amp_ed_parts_h'))}"><h2>${esc(t('amp_ed_parts_h'))}</h2><div id="edlist"></div><div id="edslotsL"></div>
        <div class="amp-edg2"><button type="button" class="btn amp-edadd" id="edadd">${edI(EI.plus)}<span>${esc(t('amp_plate_from_lib'))}</span></button>
          <button type="button" class="btn amp-edadd" id="eddev">${edI('<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v5h16v-5"/>')}<span>${esc(t('amp_ed_from_dev'))}</span></button></div>
        <button type="button" class="btn amp-edarr" id="edarr">${edI(EI.arrange)}<span>${esc(t('amp_ed_arrange'))}</span></button>
        <div id="edfits"></div></aside>
      <section class="amp-edview" aria-label="${esc(t('amp_ed_view'))}">
        <div class="amp-edstage"><div class="amp-edcanvas" id="edcv"></div>
        <div class="amp-edov">
          <select id="edpick" class="amp-ednar" aria-label="${esc(t('amp_ed_pick'))}"></select><span class="grow"></span>
          <button type="button" class="amp-edib amp-ednar" data-act="copy" aria-label="${esc(t('amp_ed_copy'))}">${edI(EI.copy)}</button>
          <button type="button" class="amp-edib amp-ednar" data-act="del" aria-label="${esc(t('amp_ed_del'))}">${edI(EI.del)}</button></div>
        <span class="amp-edlbl" id="edlbl" hidden></span>
        <div class="amp-edfoot"><span class="amp-edhint" id="edhint"></span><span class="grow"></span>
          <span class="amp-edviews" role="group">${['top', 'front', '3d'].map(k => `<button type="button" data-v="${k}" aria-pressed="${(cur.vk || '3d') === k}">${esc(t('amp_ed_v_' + k))}</button>`).join('')}</span></div></div>
        <div class="amp-edtools" id="edtools">${ED_TOOLS.map(([k, ic, lbl]) => `<button type="button" data-tool="${k}"${k === 'color' ? ' class="amp-ednar"' : ''} aria-pressed="${cur.tool === k}">${edI(EI[ic])}<span class="w">${esc(t(lbl))}</span><span class="n">${esc(t(lbl + '_s'))}</span></button>`).join('')}
          <button type="button" class="amp-edwonly" data-act="mirror" aria-label="${esc(t('amp_ed_t_mirror'))}" title="${esc(t('amp_ed_t_mirror'))}">${edI(EI.mirror)}<span class="w">${esc(t('amp_ed_t_mirror'))}</span></button>
          <span class="amp-edsep amp-edwonly"></span>
          <button type="button" class="amp-edwonly" data-act="copy" aria-label="${esc(t('amp_ed_copy'))}" title="${esc(t('amp_ed_copy'))}">${edI(EI.copy)}</button>
          <button type="button" class="amp-edwonly" data-act="del" aria-label="${esc(t('amp_ed_del'))}" title="${esc(t('amp_ed_del'))}">${edI(EI.del)}</button></div>
      </section>
      <aside class="amp-edprops" id="edprops" aria-label="${esc(t('amp_ed_props'))}"></aside>
    </div>
    <div class="amp-edact"><button type="button" class="btn" id="edsave2">${esc(t('save'))}</button><button type="button" class="btn pri" id="edgo2">${esc(t('amp_ed_print'))}</button></div>
  </div>`;
  const host = $('#edcv');
  if (!edGfxInit(cur, host)) { host.innerHTML = `<p class="hint">${esc(t('amp_ed_no_webgl'))}</p>`; return; }
  edMeshes(cur);
  edPointer(cur, host);
  edBind(cur);
  edPanel(cur);
}
function edBind(cur) {
  const root = $('#amped');
  root.querySelectorAll('#edtools [data-tool]').forEach(b => b.onclick = () => edTool(cur, b.dataset.tool));
  root.querySelectorAll('[data-act]').forEach(b => b.onclick = () => edAct(cur, b.dataset.act));
  root.querySelectorAll('.amp-edviews [data-v]').forEach(b => b.onclick = () => { edView(cur, b.dataset.v); root.querySelectorAll('.amp-edviews [data-v]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  $('#edundo').onclick = () => { if (!cur.undo.length) return; cur.redo.push(edSnap(cur)); edRestore(cur, cur.undo.pop()); edMeshes(cur); edPanel(cur); };
  $('#edredo').onclick = () => { if (!cur.redo.length) return; cur.undo.push(edSnap(cur)); edRestore(cur, cur.redo.pop()); edMeshes(cur); edPanel(cur); };
  $('#edarr').onclick = () => { edPush(cur); edArrange(cur); edPose(cur); edPanel(cur); };
  $('#edadd').onclick = () => edPick(cur);
  $('#eddev').onclick = () => edFromDevice(cur);
  if ($('#edpl')) $('#edpl').onchange = e => ed3Plate(cur, +e.target.value);
  $('#edsave').onclick = $('#edsave2').onclick = () => edSaveDlg(cur);
  $('#edgo').onclick = $('#edgo2').onclick = e => edPrint(cur, e.currentTarget);
  $('#edpr').onchange = e => {
    const old = edBed(cur), np = (cur.printers || []).find(p => p.key === e.target.value); if (!np) return;
    edPush(cur); cur.pr = np; edSetBed(cur);
    try { localStorage.setItem('amp_ed_pr', np.key); } catch (x) {}
    const nb = edBed(cur), dx = (nb[0] - old[0]) / 2, dy = (nb[1] - old[1]) / 2;   // Anordnung bleibt in der Bettmitte
    cur.parts.forEach(p => p.inst.forEach(i => { i.x += dx; i.y += dy; }));
    if (cur.sh3) { cur.sh3 = [cur.sh3[0] + dx, cur.sh3[1] + dy]; ed3AutoMap(cur); }
    edMeshes(cur); edView(cur, cur.vk || '3d'); edPanel(cur);
  };
  $('#edpick').onchange = e => { const [p, i] = e.target.value.split(':').map(Number); cur.sel = { p, i }; edPose(cur); edPanel(cur); };
}
function edTool(cur, k) {
  cur.tool = k; $('#amped').dataset.tool = k;
  $('#amped').querySelectorAll('#edtools [data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === k));
  edPose(cur); edPanel(cur);
}
function edAct(cur, k) {
  const p = edSelPart(cur), it = edSelInst(cur);
  if (!p || !it) return;
  if (k === 'copy') {
    if (cur.parts.reduce((a, x) => a + x.inst.length, 0) >= 200) { toast(t('psd_err_too_many_objs')); return; }
    edPush(cur);
    const c = { L: it.L.slice(), x: it.x, y: it.y, s: it.s, skip: false, rz: it.rz || 0 }; edFix(p, c);
    [c.x, c.y] = edFreeSpot(cur, c);
    p.inst.splice(cur.sel.i + 1, 0, c); cur.sel = { p: cur.sel.p, i: cur.sel.i + 1 };
    edMeshes(cur); edPanel(cur);
  } else if (k === 'del') {
    edPush(cur);
    const gone = p.inst.splice(cur.sel.i, 1)[0];
    if (gone && gone.bi != null) cur.gone = (cur.gone || []).concat(gone.bi);
    if (!p.inst.length) cur.parts.splice(cur.sel.p, 1);
    cur.sel = cur.parts.length ? { p: Math.min(cur.sel.p, cur.parts.length - 1), i: 0 } : null;
    edMeshes(cur); edPanel(cur);
  } else if (k === 'mirror') {
    edPush(cur); it.L = edMul([-1, 0, 0, 0, 1, 0, 0, 0, 1], it.L); edFix(p, it); edPose(cur); edPanel(cur);
  } else if (k === 'skip') {
    edPush(cur); it.skip = !it.skip; edMeshes(cur); edPanel(cur);
  }
}
/** Liste links, Auswahl am Handy, Status, Hinweise, rechte Spalte */
function edPanel(cur) {
  if (!$('#amped')) return;
  const chk = edCheck(cur), pr = cur.pr;
  // Liste der Teile (Desktop) + Auswahl (Handy)
  const rows = [];
  cur.parts.forEach((p, pi) => p.inst.forEach((it, ii) => {
    const on = cur.sel && cur.sel.p === pi && cur.sel.i === ii, s = edSlotOf(cur, p), b = it.bb.d;
    const nm = p.inst.length > 1 ? `${p.name} (${ii + 1})` : p.name;
    rows.push(`<div class="amp-edrow${on ? ' on' : ''}${it.skip ? ' off' : ''}${it.over > 0.3 || it.tall > 0.3 ? ' bad' : ''}">
      <button type="button" class="amp-edrowb" data-sel="${pi}:${ii}" aria-pressed="${on}"><span class="sw" style="background:${esc(edColorOf(cur, p))}"></span>
        <span class="t"><b>${esc(nm)}</b><small>${esc([`${edF0(b[0])} × ${edF0(b[1])} × ${edF0(b[2])} mm`, cur.mode === '3mf' ? ed3Info(cur, p) : s ? tf('pc_slot_n', s.label) : ''].filter(Boolean).join(' · '))}</small></span></button>
      <button type="button" class="amp-edib" data-skip="${pi}:${ii}" aria-label="${esc(t(it.skip ? 'amp_ed_skip_off' : 'amp_ed_skip_on', { n: nm }))}" title="${esc(t(it.skip ? 'amp_ed_skip_off' : 'amp_ed_skip_on', { n: nm }))}">${edI(it.skip ? EI.eyeoff : EI.eye)}</button></div>`);
  }));
  $('#edlist').innerHTML = rows.join('');
  $('#edlist').querySelectorAll('[data-sel]').forEach(b => b.onclick = () => { const [p, i] = b.dataset.sel.split(':').map(Number); cur.sel = { p, i }; edPose(cur); edPanel(cur); });
  $('#edlist').querySelectorAll('[data-skip]').forEach(b => b.onclick = () => { const [p, i] = b.dataset.skip.split(':').map(Number); cur.sel = { p, i }; edAct(cur, 'skip'); });
  $('#edpick').innerHTML = cur.parts.map((p, pi) => p.inst.map((it, ii) => `<option value="${pi}:${ii}"${cur.sel && cur.sel.p === pi && cur.sel.i === ii ? ' selected' : ''}>${esc((p.inst.length > 1 ? `${p.name} (${ii + 1})` : p.name) + (edSlotOf(cur, p) ? ' · ' + tf('pc_slot_n', edSlotOf(cur, p).label) : ''))}</option>`).join('')).join('');
  // Passt auch auf
  const all = []; cur.parts.forEach(p => p.inst.forEach(i => { if (!i.skip) all.push(edWorld(i)); }));
  const ext = all.length ? [Math.max(...all.map(b => b[2])) - Math.min(...all.map(b => b[0])), Math.max(...all.map(b => b[3])) - Math.min(...all.map(b => b[1])), Math.max(...all.map(b => b[4]))] : [0, 0, 0];
  const others = (cur.printers || []).filter(p => p.bed && (!pr || p.key !== pr.key));
  $('#edfits').innerHTML = others.length ? `<h2>${esc(t('amp_ed_fits_h'))}</h2><ul class="amp-edfits">${others.map(p => { const ok = ext[0] <= p.bed[0] && ext[1] <= p.bed[1] && ext[2] <= (p.bed[2] || 999);
    return `<li class="${ok ? 'ok' : 'no'}">${edI(ok ? EI.check : EI.x, 18)}<span>${esc(p.name)}</span><small>${ok ? `${edF0(p.bed[0])} mm` : esc(t('amp_ed_too_small'))}</small></li>`; }).join('')}</ul>` : '';
  // Bett + Status
  const [W, D] = edBed(cur);
  $('#edbed').textContent = cur.bedKnown ? `${edF0(W)} × ${edF0(D)} mm` : t('amp_ed_bed_unknown', { w: edF0(W), d: edF0(D) });
  const st = [];
  if (chk.bad.length) st.push(`<span class="amp-edchip bad">${edI(EI.warn, 16)}${esc(t('amp_ed_fit_bad'))}</span>`);
  else if (chk.tall.length) st.push(`<span class="amp-edchip bad">${edI(EI.warn, 16)}${esc(t('amp_ed_too_tall', { name: chk.tall[0].p.name, mm: edF0(chk.tall[0].mm) }))}</span>`);
  else if (chk.ok) st.push(`<span class="amp-edchip ok">${edI(EI.check, 16)}${esc(t('amp_ed_fit_ok'))}</span>`);
  if (!cur.bedKnown && cur.slcOld) st.push(`<span class="amp-edchip warn amp-edslc">${edI(EI.warn, 16)}<span>${esc(t('amp_ed_bed_old', { v: cur.slcOld }))}<code>docker pull ghcr.io/nolimitek/allmyprinters-slicer:latest</code></span></span>`);
  if (chk.overlap) st.push(`<span class="amp-edchip warn">${edI(EI.warn, 16)}${esc(t('amp_ed_overlap'))}</span>`);
  const nPr = cur.parts.reduce((a, p) => a + p.inst.filter(i => !i.skip).length, 0);
  st.push(`<span class="amp-edchip">${esc(nPr === 1 ? t('amp_ed_n_part') : t('amp_ed_n_parts', { n: nPr }))}</span>`);
  $('#edst').innerHTML = st.join('');
  const blocked = !chk.ok || !pr;
  ['#edgo', '#edgo2'].forEach(s => { const b = $(s); b.disabled = blocked; b.title = !pr ? t('amp_no_printers') : chk.bad.length ? t('amp_ed_fit_bad') : ''; });
  const canSave = cur.parts.length && (cur.mode === '3mf' || cur.parts.every(p => p.id));
  ['#edsave', '#edsave2'].forEach(s => { const b = $(s); b.disabled = !canSave; b.title = canSave ? '' : t('amp_plate_lib_only'); });
  $('#edundo').disabled = !cur.undo.length; $('#edredo').disabled = !cur.redo.length;
  const touch = edTouch();
  $('#edhint').textContent = cur.tool === 'rotate' ? t('amp_ed_hint_rot') : cur.tool === 'flat' ? t('amp_ed_hint_flat') : t(touch ? 'amp_ed_hint_touch' : 'amp_ed_hint_desk');
  const sp = edSelPart(cur);
  $('#edslotsL').innerHTML = sp ? `<section class="amp-edsec">${edColorHtml(cur, sp, false)}</section>` : '';
  $('#edprops').innerHTML = edProps(cur);
  edPropsBind(cur);
  edDraw();
}
/** Während des Ziehens nur Zahlen und Status nachführen (kein Neuzeichnen der Felder → Fokus bleibt) */
function edPanelLive(cur) {
  const it = edSelInst(cur); if (!it) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
  set('edpx', edF1(it.x)); set('edpy', edF1(it.y)); set('edrz', edF0(it.rz || 0));
  const chk = cur.chk;
  const chip = $('#edst .amp-edchip'); if (chip) { chip.className = 'amp-edchip ' + (chk.bad.length || chk.tall.length ? 'bad' : 'ok'); }
}
const edNumIn = v => { const x = parseFloat(String(v).replace(',', '.')); return Number.isFinite(x) ? x : null; };
function edSec(k, inner) { return `<section class="amp-edsec" data-sec="${k}">${inner}</section>`; }
function edProps(cur) {
  const p = edSelPart(cur), it = edSelInst(cur), pr = cur.pr;
  if (!p || !it) return `<p class="hint">${esc(t('amp_ed_empty_p'))}</p>`;
  const nm = p.inst.length > 1 ? `${p.name} (${cur.sel.i + 1})` : p.name, b = it.bb.d, over = it.over > 0.3 ? it.over : 0, tall = it.tall > 0.3 ? it.tall : 0;
  const head = `<div class="amp-edph"><span class="sw" style="background:${esc(edColorOf(cur, p))}"></span><div class="t"><b>${esc(nm)}</b><small>${esc(t('amp_ed_from', { f: p.file && p.file.name ? p.file.name : p.name }))}</small></div>
    <button type="button" class="amp-edib" data-pact="copy" aria-label="${esc(t('amp_ed_copy'))}" title="${esc(t('amp_ed_copy'))}">${edI(EI.copy)}</button>
    <button type="button" class="amp-edib" data-pact="del" aria-label="${esc(t('amp_ed_del'))}" title="${esc(t('amp_ed_del'))}">${edI(EI.del)}</button></div>`;
  const move = edSec('move', `<h3>${esc(t('amp_ed_pos_h'))}</h3><p class="amp-edsub">${esc(t('amp_ed_move_sub'))}</p>
    <div class="amp-edg2"><label class="amp-edin"><span class="ax x">X</span><input id="edpx" inputmode="decimal" value="${edF1(it.x)}"><span class="u">mm</span></label>
      <label class="amp-edin"><span class="ax y">Y</span><input id="edpy" inputmode="decimal" value="${edF1(it.y)}"><span class="u">mm</span></label></div>
    <div class="amp-edrowx"><span class="amp-edsub">${edI(EI.lock, 16)}${esc(t('amp_ed_on_bed'))}</span><button type="button" class="btn sm" data-pact="center">${edI(EI.center, 18)}${esc(t('amp_ed_center'))}</button></div>
    <div class="amp-edg2 amp-ednar"><button type="button" class="btn sm" data-pact="arrange">${edI(EI.arrange, 18)}${esc(t('amp_ed_arrange'))}</button>
      <button type="button" class="btn sm" data-pact="add">${edI(EI.plus, 18)}${esc(t('amp_plate_from_lib'))}</button></div>
    <button type="button" class="btn sm amp-ednar" data-pact="dev">${esc(t('amp_ed_from_dev'))}</button>`);
  const rot = edSec('rotate', `<h3>${esc(t('amp_ed_rot_h'))}</h3><p class="amp-edsub">${esc(t('amp_ed_rot_sub'))}</p>
    <div class="amp-edrowx"><button type="button" class="btn sm" data-pact="rl" aria-label="${esc(t('amp_ed_rot_l'))}">${edI(EI.rotl, 18)}90°</button>
      <button type="button" class="btn sm" data-pact="rr" aria-label="${esc(t('amp_ed_rot_r'))}">${edI(EI.rotate, 18)}90°</button>
      <label class="amp-edin grow"><input id="edrz" inputmode="decimal" value="${edF0(it.rz || 0)}" aria-label="${esc(t('amp_ed_rot_deg'))}"><span class="u">°</span></label></div>
    <span class="amp-edsub b">${esc(t('amp_ed_tilt'))}</span>
    <div class="amp-edg2"><button type="button" class="btn sm" data-pact="tx">${esc(t('amp_ed_tilt_x'))}</button><button type="button" class="btn sm" data-pact="ty">${esc(t('amp_ed_tilt_y'))}</button></div>
    <div class="amp-edg2"><button type="button" class="btn sm amp-edwonly" data-pact="toflat">${edI(EI.flat, 18)}${esc(t('amp_ed_flat_btn'))}</button><button type="button" class="btn sm" data-pact="mirror">${edI(EI.mirror, 18)}${esc(t('amp_ed_t_mirror'))}</button></div>`);
  const pct = Math.round(it.s * 100);
  const size = edSec('scale', `<div class="amp-edrowx"><h3>${esc(t('amp_ed_size_h'))}</h3><span class="grow"></span>
      <span class="amp-edseg" role="group"><button type="button" data-unit="mm" aria-pressed="${cur.unit === 'mm'}">mm</button><button type="button" data-unit="%" aria-pressed="${cur.unit === '%'}">%</button></span></div>
    <p class="amp-edsub">${esc(t('amp_ed_pct', { p: pct }))}${pct !== 100 ? ` · <button type="button" class="lnk" data-pact="s100">${esc(t('amp_ed_reset100'))}</button>` : ''}</p>
    ${cur.unit === '%' ? `<label class="amp-edin"><input id="edsp" inputmode="decimal" value="${pct}" aria-label="${esc(t('amp_ed_size_h'))}"><span class="u">%</span></label>`
    : `<div class="amp-edsz">${[['w', 0], ['d', 1], ['h', 2]].map(([k, i]) => `<label class="amp-edsl"><span>${esc(t('amp_ed_' + k))}</span><input id="eds${k}" inputmode="decimal" value="${edF1(b[i])}"></label>`).join('')}
      <button type="button" class="amp-edib amp-edlock" data-pact="lock" aria-pressed="${cur.lock}" aria-label="${esc(t('amp_ed_lock'))}" title="${esc(t('amp_ed_lock'))}">${edI(cur.lock ? EI.lock : EI.unlock)}</button></div>`}
    ${over || tall ? `<div class="amp-edwarn">${edI(EI.warn, 18)}<span>${esc(over ? t('amp_ed_over_long', { name: nm, mm: edF0(over) }) : t('amp_ed_too_tall', { name: nm, mm: edF0(tall) }))}</span>
      <div class="amp-edg2"><button type="button" class="btn sm" data-pact="center">${esc(t('amp_ed_center'))}</button><button type="button" class="btn sm" data-pact="fit">${esc(t('amp_ed_fit_make'))}</button></div></div>` : ''}`);
  const flat = edSec('flat', `<h3>${esc(t('amp_ed_flat_btn'))}</h3><p class="amp-edsub">${esc(t('amp_ed_flat_p'))}</p>
    <button type="button" class="btn sm" data-pact="autoflat">${edI(EI.flat, 18)}${esc(t('amp_ed_flat_auto'))}</button>`);
  return head + move + rot + size + flat + (p.kind === '3mf' ? '' : edSec('flat', edSupHtml(p))) + `<section class="amp-edsec amp-ednar" data-sec="color">${edColorHtml(cur, p, true)}</section>`;
}
/** Stützen je Teil (am Handy unter „Fläche“) */
function edSupHtml(p) {
  const sv = p.sup || '';
  return `<h3>${esc(t('amp_ed_sup_h'))}</h3><span class="amp-edseg amp-edseg3" role="group">${[['', 'amp_ed_sup_off'], ['auto', 'amp_ed_sup_auto'], ['bed', 'amp_ed_sup_bed']].map(([v, k]) =>
    `<button type="button" data-sup="${v}" aria-pressed="${sv === v}">${esc(t(k))}</button>`).join('')}</span>`;
}
/** Fach je Teil: am Desktop links unter der Teileliste (User 19.11.: „Filamentfarben nicht sichtbar ohne Scrollen“), am Handy unter „Farbe“ */
function edColorHtml(cur, p, all) {
  if (cur.mode === '3mf') return ed3ColorHtml(cur, p);
  const pr = cur.pr, sl = edSlotsOf(pr), multi = edMultiOf(pr);
  const slotBtn = (s, on) => `<button type="button" class="amp-edslot${on ? ' on' : ''}" data-slot="${esc(String(s.index))}" aria-pressed="${on}"${edSlotOk(s) ? '' : ' disabled'}>
      <span class="sw${s.material ? '' : ' empty'}" style="${s.color ? `background:${esc(s.color)};color:${edInk(s.color)}` : ''}">${esc(s.label)}</span><b>${esc(s.material || t('slot_empty'))}</b></button>`;
  const curSlot = edSlotOf(cur, p);
  return `<h3>${esc(t(multi ? 'amp_ed_slot_h' : 'amp_ed_slot_h1'))}</h3><p class="amp-edsub">${esc(!sl.length ? t('amp_ed_slot_mat') : multi ? t('amp_ed_color_sub') : t('amp_ed_slot_single'))}</p>
    ${sl.length ? `<div class="amp-edslots">${sl.map(s => slotBtn(s, curSlot && String(curSlot.index) === String(s.index))).join('')}</div>` : ''}
    ${all && sl.length && multi && cur.parts.length > 1 ? `<div class="amp-edall">${cur.parts.map((q, qi) => { const qs = edSlotOf(cur, q); return `<label class="amp-edallr"><span class="sw" style="background:${esc(edColorOf(cur, q))}"></span><span class="t">${esc(q.name)}${q.inst.length > 1 ? ` ×${q.inst.length}` : ''}</span>
      <select data-pslot="${qi}" aria-label="${esc(t('amp_ed_slot_for', { n: q.name }))}">${sl.map(s => `<option value="${esc(String(s.index))}"${qs && String(qs.index) === String(s.index) ? ' selected' : ''}${edSlotOk(s) ? '' : ' disabled'}>${esc(tf('pc_slot_n', s.label) + ' · ' + (s.material || t('slot_empty')))}</option>`).join('')}</select></label>`; }).join('')}</div>` : ''}`;
}
function edPropsBind(cur) {
  const box = $('#edprops'), p = edSelPart(cur), it = edSelInst(cur); if (!p || !it) return;
  const commit = fn => { edPush(cur); fn(); edFix(p, it); edPose(cur); edPanel(cur); };
  const onIn = (id, fn) => { const el = box.querySelector('#' + id); if (!el) return; el.onchange = () => { const v = edNumIn(el.value); if (v === null) { edPanel(cur); return; } fn(v); };
    el.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } }; };
  onIn('edpx', v => { edPush(cur); it.x = v; edPose(cur); edPanel(cur); });
  onIn('edpy', v => { edPush(cur); it.y = v; edPose(cur); edPanel(cur); });
  onIn('edrz', v => commit(() => { const d = v - (it.rz || 0); it.L = edMul(edRot('z', d), it.L); it.rz = ((v % 360) + 360) % 360; }));
  onIn('edsp', v => { if (v <= 0) { edPanel(cur); return; } commit(() => { const f = v / 100 / it.s; it.L = it.L.map(x => x * f); it.s = v / 100; }); });
  [['w', 0], ['d', 1], ['h', 2]].forEach(([k, i]) => onIn('eds' + k, v => {
    if (v <= 0 || !it.bb.d[i]) { edPanel(cur); return; }
    commit(() => { const f = v / it.bb.d[i];
      if (cur.lock) { it.L = it.L.map(x => x * f); it.s *= f; }
      else { const S = [1, 1, 1]; S[i] = f; it.L = edMul([S[0], 0, 0, 0, S[1], 0, 0, 0, S[2]], it.L); } });
  }));
  box.querySelectorAll('[data-unit]').forEach(b => b.onclick = () => { cur.unit = b.dataset.unit; edPanel(cur); });
  box.querySelectorAll('[data-sup]').forEach(b => b.onclick = () => { edPush(cur); p.sup = b.dataset.sup; edPanel(cur); });
  [box, $('#edslotsL')].filter(Boolean).forEach(el => {
    el.querySelectorAll('[data-map3]').forEach(s => s.onchange = () => { edPush(cur); cur.map3[s.dataset.map3] = s.value; edMeshes(cur); edPanel(cur); });
    el.querySelectorAll('[data-ext3]').forEach(b => b.onclick = () => { edPush(cur); p.ext3 = +b.dataset.ext3; edMeshes(cur); edPanel(cur); });
    el.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => { edPush(cur); if (edMultiOf(cur.pr)) p.slot = b.dataset.slot; else cur.slot1 = b.dataset.slot; edMeshes(cur); edPanel(cur); });
    el.querySelectorAll('[data-pslot]').forEach(s => s.onchange = () => { edPush(cur); cur.parts[+s.dataset.pslot].slot = s.value; edMeshes(cur); edPanel(cur); });
  });
  box.querySelectorAll('[data-pact]').forEach(b => b.onclick = () => {
    const k = b.dataset.pact, [W, D, H] = edBed(cur);
    if (k === 'copy' || k === 'del' || k === 'mirror') return edAct(cur, k);
    if (k === 'arrange') { edPush(cur); edArrange(cur); edPose(cur); edPanel(cur); return; }
    if (k === 'add') { edPick(cur); return; }
    if (k === 'dev') { edFromDevice(cur); return; }
    if (k === 'center') { edPush(cur); it.x = W / 2; it.y = D / 2; edPose(cur); edPanel(cur); return; }
    if (k === 'lock') { cur.lock = !cur.lock; edPanel(cur); return; }
    if (k === 'toflat') { edTool(cur, 'flat'); return; }
    if (k === 'autoflat') { edAutoFlat(cur); return; }
    if (k === 's100') return commit(() => { const f = 1 / it.s; it.L = it.L.map(x => x * f); it.s = 1; });
    if (k === 'rl' || k === 'rr') return commit(() => { const d = k === 'rl' ? 90 : -90; it.L = edMul(edRot('z', d), it.L); it.rz = (((it.rz || 0) + d) % 360 + 360) % 360; });
    if (k === 'tx') return commit(() => { it.L = edMul(edRot('x', 90), it.L); });
    if (k === 'ty') return commit(() => { it.L = edMul(edRot('y', 90), it.L); });
    if (k === 'fit') return commit(() => {
      const m = 2, f = Math.min(1, (W - m * 2) / it.bb.d[0], (D - m * 2) / it.bb.d[1], (H - 1) / it.bb.d[2]);
      if (f < 1) { it.L = it.L.map(x => x * f); it.s *= f; }
      edFix(p, it);
      it.x = Math.min(Math.max(it.x, it.bb.d[0] / 2 + m), W - it.bb.d[0] / 2 - m); it.y = Math.min(Math.max(it.y, it.bb.d[1] / 2 + m), D - it.bb.d[1] / 2 - m);
    });
  });
}

// ── Teile dazu, speichern, drucken ────────────────────────────────────────────────────────────────────────────────────────────
async function edAddFromLib(cur) {
  const L = cur.parts.filter(p => p.id).map(p => ({ lib: p.id, file: p.file, copies: p.inst.length, slot: p.slot })), n0 = L.length;
  ampPlatePick(L, { redraw: async () => {
    const add = L.slice(n0);
    try {
      let budget = ED_TRI_MAX - cur.parts.reduce((a, p) => a + p.geo.nt, 0);
      edPush(cur);
      for (const x of add) {
        const geo = await edReadStl(x.file, budget); budget -= geo.nt;
        const key = 'k' + Object.keys(cur.pool).length, nm = x.file.name.replace(/\.stl$/i, '');
        const p = { key, id: x.lib, name: nm, file: x.file, geo, slot: String(edDefSlot(cur.pr)), inst: [{ L: ED_I3.slice(), x: 0, y: 0, s: 1, skip: false, rz: 0 }] };
        edFix(p, p.inst[0]); [p.inst[0].x, p.inst[0].y] = cur.parts.length ? edFreeSpot(cur, Object.assign(p.inst[0], { x: edBed(cur)[0] / 2, y: edBed(cur)[1] / 2 })) : [edBed(cur)[0] / 2, edBed(cur)[1] / 2];
        cur.pool[key] = p; cur.parts.push(p); cur.sel = { p: cur.parts.length - 1, i: 0 };
      }
    } catch (e) { toast(e.message === 'too_big' ? t('amp_ed_too_big', { name: e.part, n: ED_TRI_MAX / 1e6 }) : t('amp_ed_bad_file', { name: e.part || '?' })); }
    edMeshes(cur); edPanel(cur);
  } });
}
/** Bild der Platte: die 3D-Ansicht schräg von oben, quadratisch 480 px */
function edThumb(cur) {
  const g = ED.g; if (!g) return null;
  try {
    const vk = cur.vk || '3d', sel = cur.sel, tool = cur.tool;
    cur.sel = null; edPose(cur); g.giz.visible = false;
    const w = g.host.clientWidth, h = g.host.clientHeight;
    g.r.setSize(480, 480, false); g.cam.aspect = 1; g.cam.updateProjectionMatrix(); edView(cur, '3d');
    g.r.render(g.scene, g.cam);
    const url = g.r.domElement.toDataURL('image/png');
    cur.sel = sel; cur.tool = tool; g.giz.visible = true;
    g.r.setSize(w, h, false); g.cam.aspect = w / h; g.cam.updateProjectionMatrix(); edView(cur, vk); edPose(cur);
    return url;
  } catch (e) { return null; }
}
async function edSaveDlg(cur) {
  if (cur.mode === '3mf') return ed3SaveDlg(cur);
  if (!cur.parts.every(p => p.id)) { toast(t('amp_plate_lib_only')); return; }
  if (!(await ampFeat('editor'))) { ampPlanDeny('editor'); return; }
  let d; try { d = await api('lib_list'); } catch (e) { fail(e); return; }
  const files = d.files || [], curF = cur.plateId ? files.find(x => x.id === cur.plateId) : null;
  const fo = [...new Set(cur.parts.map(p => (files.find(x => x.id === p.id) || {}).folder || ''))];
  dlg.innerHTML = `<form method="dialog" class="amp-plsave"><div class="dlg-h"><b>${esc(t(cur.plateId ? 'amp_plate_update' : 'amp_plate_save'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p class="hint">${esc(t('amp_ed_save_hint'))}</p>
      <label class="fld"><span>${esc(t('lib_name'))}</span><input class="in" id="edsnm" maxlength="120" value="${esc(curF ? curF.name : cur.name)}" autocomplete="off"></label>
      <label class="fld"><span>${esc(t('lib_folder'))}</span><input class="in" id="edsfo" list="edsfl" maxlength="160" value="${esc(curF ? curF.folder || '' : fo.length === 1 ? fo[0] : '')}" placeholder="${esc(t('amp_lib_folder_ph'))}" autocomplete="off"></label>
      <datalist id="edsfl">${lbPaths(files).map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <p class="hint">${esc(t('amp_plate_parts', { n: cur.parts.length }))} · ${esc(cur.parts.map(p => `${p.inst.length}× ${p.name}`).join(', '))}</p></div>
    <div class="dlg-f"><button type="button" class="btn" data-x>${esc(t('cancel'))}</button><button type="submit" class="btn pri" id="edsok">${esc(t('save'))}</button></div></form>`;
  const thumb = edThumb(cur);
  if (!dlg.open) dlg.showModal();
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const fm = dlg.querySelector('form'), ok = dlg.querySelector('#edsok');
  fm.onsubmit = async e => {
    e.preventDefault(); ok.disabled = true;
    try {
      const parts = cur.parts.map(p => ({ id: p.id, n: p.inst.length, slot: edMultiOf(cur.pr) ? p.slot : cur.slot1 || '', sup: p.sup || '',
        inst: p.inst.map(i => ({ L: i.L.map(v => Math.round(v * 1e6) / 1e6), x: Math.round(i.x * 100) / 100, y: Math.round(i.y * 100) / 100, s: Math.round(i.s * 1e4) / 1e4, skip: !!i.skip })) }));
      const r = await api('amp_lib_plate_save', { id: cur.plateId || null, name: dlg.querySelector('#edsnm').value.trim(), folder: dlg.querySelector('#edsfo').value.trim(), parts, thumb, edp: cur.pr ? cur.pr.key : null });
      if (r.error) throw new Error(r.error);
      cur.plateId = r.file.id; cur.name = r.file.name;
      dlg.close(); toast(t('amp_plate_saved', { name: r.file.name }));
      const nm = $('#edname'); if (nm) nm.textContent = cur.name;
      ['#edsave'].forEach(s => { const b = $(s); if (b) b.textContent = t('amp_plate_update'); });
      const bk = view.querySelector('.amp-edback'); if (bk) bk.href = `#library/${cur.plateId}`;
    } catch (er) { ok.disabled = false; fail(er); }
  };
}
/** „Slicen & drucken“: 3MF bauen, an die Druckansicht (build_web-Patch: edSlot / edMap / libIds) */
async function edPrint(cur, btn) {
  if (!(await ampFeat('editor'))) { ampPlanDeny('editor'); return; }
  const chk = edCheck(cur); if (!chk.ok || !cur.pr) { edPanel(cur); return; }
  const b0 = btn.textContent;
  [$('#edgo'), $('#edgo2')].forEach(b => { if (b) b.disabled = true; });
  try {
    btn.textContent = t('amp_ed_building');
    if (cur.mode === '3mf') { await ed3Print(cur, btn); return; }
    const r = await edBuild3mf(cur, (i, n) => { btn.textContent = t('amp_ed_building_n', { i, n }); });
    const nm = (cur.name || 'AllMyPrinters').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'AllMyPrinters';
    const ids = [...new Set(cur.parts.filter(p => p.id && p.inst.some(i => !i.skip)).map(p => p.id))];
    lb.hand = { printer: cur.pr.key, id: cur.plateId || ids[0] || null, name: cur.name, plate: 1, ed: true, plateId: cur.plateId || null, libIds: ids,
      edSlot: r.map ? null : r.slot1, edMap: r.map, file: new File([r.blob], `${nm}.3mf`, { type: 'application/octet-stream', lastModified: Date.now() }) };
    location.hash = 'print';
  } catch (e) {
    btn.textContent = b0; [$('#edgo'), $('#edgo2')].forEach(b => { if (b) b.disabled = false; });
    fail(e);
  }
}
/** Gespeicherte Platte mit Anordnung drucken, ohne den Editor zu zeigen (Bibliothek „Drucken“, „Weiter drucken“) */
async function ampEdPrintPlate(f, items, printer) {
  const cur = await edBuildCur({ parts: items, plate: f, printer: printer || f.edp || null });
  await edPrinters(cur);
  if (cur.parts.some(p => p.inst.some(i => i.fresh))) edArrange(cur);
  const chk = edCheck(cur);
  if (!chk.ok) { ED.cur = cur; location.hash = 'edit'; toast(t('amp_ed_fit_bad')); return; }   // passt nicht (anderer Drucker?) → im Editor zeigen
  const r = await edBuild3mf(cur);
  const ids = [...new Set(cur.parts.filter(p => p.id).map(p => p.id))];
  lb.hand = { printer: cur.pr ? cur.pr.key : printer, id: f.id, name: f.name, plate: 1, ed: true, plateId: f.id, libIds: ids, edSlot: r.map ? null : r.slot1, edMap: r.map,
    file: new File([r.blob], `${f.name.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'plate'}.3mf`, { type: 'application/octet-stream', lastModified: Date.now() }) };
  if (dlg.open) dlg.close();
  location.hash = 'print';
}
/** Druckansicht: Hinweis über der Datei („mit dem Editor angeordnet“, zurück zum Editor) */
function ampEdHandTxt(h) {
  return `${esc(t('amp_ed_hand', { name: h.name || '' }))} <a href="#edit">${esc(t('amp_ed_hand_back'))}</a>`;
}

// ═══ 3MF im Editor (19.11.2026, User: „können wir das für 3mf erweitern? sonst macht es kaum Sinn“) ═══════════════════════════
// Die 3MF wird an Ort und Stelle geändert, nicht neu gebaut: nur Lage/Drehung/Größe der Druckobjekte (transform der <item> im
// <build>), Kopien = weitere <item> + model_instance auf der Platte, Entfernen/Nicht drucken = printable="0". Bemalung, Teile,
// Modifier, Objekt-Einstellungen und Projekteinstellungen bleiben unverändert. STL dazulegen geht bei Bambu/Orca-Projekten
// (model_settings.config): eigene Objektdatei + Hülle + Plattenzuordnung. Unveränderte ZIP-Einträge werden roh kopiert.
const edAttrs = s => { const o = {}, re = /([\w:.-]+)\s*=\s*"([^"]*)"/g; let m; while ((m = re.exec(s))) o[m[1]] = m[2]; return o; };
const edMParse = t => { const v = t ? String(t).trim().split(/\s+/).map(Number) : []; return v.length === 12 && v.every(Number.isFinite) ? v : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]; };
/** Erst a, dann b (Zeilenvektor-Form der 3MF wie ps_m_mul) */
const edMMul = (a, b) => { const r = []; for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0); return r; };
/** ZIP lesen (mit CRC, für das rohe Weiterkopieren) */
async function edZipOpen(blob) {
  const size = blob.size, tl = Math.min(size, 65557 + 76), tail = new DataView(await blob.slice(size - tl).arrayBuffer());
  let eocd = -1;
  for (let i = tl - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw edErr('bad_file');
  let cnt = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  if ((cdOff === 0xFFFFFFFF || cnt === 0xFFFF) && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = Number(tail.getBigUint64(eocd - 12, true)), z = new DataView(await blob.slice(z64, z64 + 56).arrayBuffer());
    cnt = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
  }
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), td = new TextDecoder(), list = [];
  for (let i = 0, p = 0; i < cnt && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true), crc = cd.getUint32(p + 16, true), nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), off = cd.getUint32(p + 42, true);
    const name = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {
      const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
      if (id === 1) { let q = x + 4; if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(q, true)); q += 8; } if (csize === 0xFFFFFFFF) { csize = Number(cd.getBigUint64(q, true)); q += 8; } if (off === 0xFFFFFFFF) off = Number(cd.getBigUint64(q, true)); }
      x += 4 + len;
    }
    list.push({ name, key: name.replace(/^\//, '').toLowerCase(), method, crc, csize, usize, off });
    p += 46 + nl + xl + cl;
  }
  const find = n => { const k = String(n).replace(/^\//, '').toLowerCase(); return list.find(e => e.key === k) || null; };
  const rawOf = async e => { const lh = new DataView(await blob.slice(e.off, e.off + 30).arrayBuffer()); const st = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true); return blob.slice(st, st + e.csize); };
  const read = async n => {
    const e = find(n); if (!e) return null;
    const d = await rawOf(e);
    if (e.method === 0) return new Uint8Array(await d.arrayBuffer());
    if (e.method !== 8) throw edErr('bad_file');
    return new Uint8Array(await new Response(d.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  };
  const text = async n => { const b = await read(n); return b ? new TextDecoder().decode(b) : null; };
  return { list, find, rawOf, read, text };
}
/** ZIP schreiben: { name, data } (neu, wird gepackt) oder { name, e } (roh aus der Quelle übernommen) */
async function edZipMix(src, files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    let data, crc, method, usize;
    if (f.e) { data = await src.rawOf(f.e); crc = f.e.crc; method = f.e.method; usize = f.e.usize; }
    else {
      const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      crc = edCrc(raw); usize = raw.length;
      const z = raw.length > 256 ? await edDeflate(raw) : null;
      data = z && z.length < raw.length ? z : raw; method = data === raw ? 0 : 8;
    }
    const csize = data.size !== undefined ? data.size : data.length;
    if (off + csize > 0xF0000000) throw edErr('too_big');
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, method, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true);
    h.setUint32(18, csize, true); h.setUint32(22, usize, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, method, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
    c.setUint32(20, csize, true); c.setUint32(24, usize, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + csize;
  }
  const cs = cen.reduce((a, x) => a + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
}
/** Bemalung: häufigster Zustand im Baum (wie amp-mesh paintState); 0 = unbemalt */
function edPaint(s) {
  const n = s.length; if (!n) return 0;
  if (n === 1) { const c = parseInt(s, 16); return (c & 3) === 0 && (c >> 2) < 3 ? c >> 2 : 0; }
  let pos = n - 1; const cnt = {};
  const node = d => { if (pos < 0 || d > 12) return; const c = parseInt(s[pos--], 16), sp = c & 3;
    if (sp === 0) { let st = c >> 2; if (st === 3) st = pos >= 0 ? parseInt(s[pos--], 16) + 3 : 3; cnt[st] = (cnt[st] || 0) + 1; return; }
    for (let i = 0; i <= sp; i++) node(d + 1); };
  node(0);
  let best = 0, bn = -1; for (const k in cnt) if (cnt[k] > bn) { bn = cnt[k]; best = +k; }
  return best;
}
function edScanModel(txt, entry, limit) {
  const out = { objects: {}, maxId: 0 }, reO = /<object\b([^>]*?)(\/?)>/g;
  let m, tris = 0;
  while ((m = reO.exec(txt))) {
    const a = edAttrs(m[1]), id = a.id; if (id === undefined) continue;
    out.maxId = Math.max(out.maxId, +id || 0);
    const o = out.objects[id] = { type: a.type || 'model', mesh: null, components: [] };
    if (m[2] === '/') continue;
    const end = txt.indexOf('</object>', reO.lastIndex); if (end < 0) break;
    const seg = txt.slice(reO.lastIndex, end);
    if (seg.includes('<mesh')) {
      const v = [], t = [], pc = []; let painted = false, q;
      const reV = /<vertex\b([^>]*)>/g; while ((q = reV.exec(seg))) { const va = edAttrs(q[1]); v.push(+va.x || 0, +va.y || 0, +va.z || 0); }
      const reT = /<triangle\b([^>]*)>/g;
      while ((q = reT.exec(seg))) { const ta = edAttrs(q[1]); t.push(+ta.v1 || 0, +ta.v2 || 0, +ta.v3 || 0); const ps = ta.paint_color || ta['slic3rpe:mmu_segmentation'] || ''; const st = ps ? edPaint(ps) : 0; if (st) painted = true; pc.push(Math.min(255, st)); if (++tris > limit) throw edErr('too_big'); }
      o.mesh = { v: Float64Array.from(v), t: Uint32Array.from(t), p: painted ? Uint8Array.from(pc) : null };
    }
    const reC = /<component\b([^>]*?)\/?>/g; let c;
    while ((c = reC.exec(seg))) { const ca = edAttrs(c[1]), pk = Object.keys(ca).find(k => /(^|:)path$/.test(k)); o.components.push([pk ? ca[pk] : entry, ca.objectid, edMParse(ca.transform)]); }
    reO.lastIndex = end + 9;
  }
  return out;
}
/** Druckobjekte im <build> (Reihenfolge = Index, Instanz = wievielter Eintrag desselben Objekts) */
function edBuildItems(txt) {
  const b0 = txt.indexOf('<build'), b1 = b0 >= 0 ? txt.indexOf('</build>', b0) : -1, items = [], ic = {};
  if (b0 < 0) return { items, b0: -1, b1: -1 };
  const re = /<item\b([^>]*?)(\/?)>/g; re.lastIndex = b0;
  let m;
  while ((m = re.exec(txt)) && m.index < b1) {
    const a = edAttrs(m[1]), oid = a.objectid; ic[oid] = oid in ic ? ic[oid] + 1 : 0;
    items.push({ i: items.length, oid, inst: ic[oid], mx: edMParse(a.transform), printable: a.printable !== '0', at: m.index, len: m[0].length, tag: m[0], attrs: a });
  }
  return { items, b0, b1 };
}
/** 3MF für den Editor lesen: Platten mit ihren Druckobjekten, Netz je Objekt im Objekt-System (Teile, ohne Modifier), Farben */
async function edRead3mf(file, budget) {
  const z = await edZipOpen(file);
  let main = '3D/3dmodel.model';
  const rels = await z.text('_rels/.rels'), rm = rels && /Target="\/?([^"]+\.model)"/i.exec(rels); if (rm) main = rm[1];
  const mainTxt = (await z.text(main)) || '';
  if (!mainTxt.includes('<model')) throw edErr('bad_file', file.name);
  if (z.find('Metadata/plate_1.gcode')) throw edErr('gcode3mf', file.name);
  const um = /<model\b[^>]*\bunit="([a-z]+)"/i.exec(mainTxt.slice(0, 4096));
  const unit = um ? ({ micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[um[1].toLowerCase()] || 1) : 1;
  const objs = {}, plates = [];
  const ms = await z.text('Metadata/model_settings.config');
  if (ms) {
    const doc = new DOMParser().parseFromString(ms, 'application/xml'), root = doc.documentElement;
    const md = el => { const o = {}; for (const x of el.children) if (x.tagName === 'metadata') o[x.getAttribute('key')] = x.getAttribute('value'); return o; };
    const kids = (el, tag) => [...el.children].filter(x => x.tagName === tag);
    if (root && root.tagName !== 'parsererror') {
      for (const o of kids(root, 'object')) {
        const om = md(o), parts = {};
        for (const pt of kids(o, 'part')) { const pm = md(pt); parts[pt.getAttribute('id')] = { sub: pt.getAttribute('subtype') || 'normal_part', ext: +(pm.extruder || 0) }; }
        objs[o.getAttribute('id')] = { ext: Math.max(1, +(om.extruder || 1)), parts, name: om.name || '' };
      }
      for (const pl of kids(root, 'plate')) {
        const pm = md(pl), ins = {}; let maxIdent = 0;
        for (const mi of kids(pl, 'model_instance')) { const im = md(mi); if ((im.object_id || '') !== '') ins[im.object_id + '/' + (+(im.instance_id || 0))] = true; maxIdent = Math.max(maxIdent, +(im.identify_id || 0)); }
        plates.push({ name: String(pm.plater_name || '').slice(0, 60), ins, maxIdent });
      }
    }
  }
  let area = null, pal = [], types = [];
  const psT = await z.text('Metadata/project_settings.config');
  if (psT) { try { const cfg = JSON.parse(psT); area = cfg.printable_area || null; pal = [].concat(cfg.filament_colour || []); types = [].concat(cfg.filament_type || []); } catch (e) {} }
  else {
    const pe = await z.text('Metadata/Slic3r_PE.config');
    if (pe) { const bm = /^; bed_shape = (.+)$/m.exec(pe); if (bm) area = bm[1].trim().split(','); const cm = /^; (?:extruder_colour|filament_colour) = (.+)$/m.exec(pe); if (cm) pal = cm[1].trim().split(';'); const tm = /^; filament_type = (.+)$/m.exec(pe); if (tm) types = tm[1].trim().split(';'); }
  }
  let bed = null, bmin = [0, 0]; const bx = [];
  for (const p of [].concat(area || [])) { const am = /^\s*(-?[\d.]+)x(-?[\d.]+)\s*$/.exec(String(p)); if (am) bx.push([+am[1], +am[2]]); }
  if (bx.length >= 3) { const xs = bx.map(b => b[0]), ys = bx.map(b => b[1]); bmin = [Math.min(...xs), Math.min(...ys)]; const w = Math.max(...xs) - bmin[0], d = Math.max(...ys) - bmin[1]; if (w >= 20 && d >= 20 && w <= 2000 && d <= 2000) bed = [w, d]; }
  pal = (pal.length ? pal : ['#ff6a14']).map(c => typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toLowerCase() : '#ff6a14');
  const cache = {}; let maxMain = 0;
  const scan = async e => { e = String(e).replace(/^\//, ''); if (!cache[e]) { const t = e === main.replace(/^\//, '') ? mainTxt : await z.text(e); cache[e] = t ? edScanModel(t, '/' + e, budget) : { objects: {}, maxId: 0 }; } return cache[e]; };
  maxMain = (await scan(main)).maxId;
  const bi = edBuildItems(mainTxt);
  if (!plates.length) plates.push({ name: '', ins: null, maxIdent: 0 });
  const cols = (n => { const v = Math.sqrt(n), r = Math.round(v); return Math.max(1, v > r ? r + 1 : r); })(plates.length);
  plates.forEach((pl, pi) => { pl.origin = bed && pl.ins ? [bmin[0] + (pi % cols) * bed[0] * 1.2, bmin[1] - Math.floor(pi / cols) * bed[1] * 1.2] : bmin.slice();
    pl.items = bi.items.filter(it => it.printable && (!pl.ins || pl.ins[it.oid + '/' + it.inst])).map(it => it.i); });
  /** Netz eines Druckobjekts im Objekt-System: Teile (normal_part), Farbe je Dreieck = Bemalung vor Extruder des Teils */
  async function geoOf(oid) {
    const pos = [], idx = [], col = [], obj = objs[oid] || null;
    const walk = async (entry, id, mx, depth, ext) => {
      const o = (await scan(entry)).objects[id]; if (!o || depth > 8 || o.type === 'support') return;
      if (o.mesh) {
        const v = o.mesh.v, base = pos.length / 3, nv = v.length / 3;
        for (let i = 0; i < nv; i++) { const x = v[i * 3], y = v[i * 3 + 1], w = v[i * 3 + 2]; pos.push((x * mx[0] + y * mx[3] + w * mx[6] + mx[9]) * unit, (x * mx[1] + y * mx[4] + w * mx[7] + mx[10]) * unit, (x * mx[2] + y * mx[5] + w * mx[8] + mx[11]) * unit); }
        const t = o.mesh.t;
        for (let i = 0; i < t.length / 3; i++) { const a = t[i * 3], b = t[i * 3 + 1], c = t[i * 3 + 2]; if (a >= nv || b >= nv || c >= nv) continue;
          idx.push(base + a, base + b, base + c); col.push(o.mesh.p && o.mesh.p[i] > 0 ? o.mesh.p[i] - 1 : ext - 1); }
      }
      for (const [cp, cid, cm] of o.components) {
        let e = ext;
        if (depth === 0 && obj) { const part = obj.parts[cid]; if (part && part.sub !== 'normal_part') continue; if (part && part.ext > 0) e = part.ext; }
        await walk(cp, cid, edMMul(cm, mx), depth + 1, e);
      }
    };
    await walk(main, oid, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 0, obj ? obj.ext : 1);
    if (!idx.length) return null;
    // um die Mitte legen (wie edWeld), Dreiecke nach Farbe sortiert → Gruppen für die Ansicht
    const p = Float32Array.from(pos), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < lo[k]) lo[k] = p[i + k]; if (p[i + k] > hi[k]) hi[k] = p[i + k]; }
    const c0 = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) p[i + k] -= c0[k];
    const nt = idx.length / 3, order = [...Array(nt).keys()].sort((a, b) => col[a] - col[b]), I = new Uint32Array(idx.length), groups = [];
    order.forEach((f, k) => { I[k * 3] = idx[f * 3]; I[k * 3 + 1] = idx[f * 3 + 1]; I[k * 3 + 2] = idx[f * 3 + 2]; const c = Math.max(0, Math.min(pal.length - 1, col[f]));
      const g = groups[groups.length - 1]; if (g && g.c === c) g.n++; else groups.push({ c, s: k, n: 1 }); });
    return { pos: p, idx: I, nv: p.length / 3, nt, dims: [0, 1, 2].map(k => hi[k] - lo[k]), c0, groups, exts: [...new Set(groups.map(g => g.c + 1))] };
  }
  return { z, file, main, mainTxt, unit, objs, plates, pal, types, bed, bmin, items: bi.items, ms, maxMain, kind: ms ? 'bambu' : 'plain', geoOf, scan };
}
/** Projektfarben → Fächer vorbelegen: gleiche Farbe (nah) + gleiches Material, sonst gleiches Material, sonst erstes freies Fach */
function ed3AutoMap(cur) {
  const s3 = cur.src3; if (!s3) return;
  const sl = edSlotsOf(cur.pr).filter(edSlotOk), rgb = h => { const m = /^#?([0-9a-f]{6})/i.exec(String(h || '')); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16, (n >> 8) & 255, n & 255]; };
  const dist = (a, b) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  for (const e of ed3Exts(cur)) {
    if (cur.map3[e] != null && sl.some(s => String(s.index) === String(cur.map3[e]))) continue;
    const col = s3.pal[e - 1], ty = String(s3.types[e - 1] || 'PLA').toUpperCase();
    const same = sl.filter(s => String(s.material || '').toUpperCase().startsWith(ty.slice(0, 3)));
    const pick = (same.length ? same : sl).slice().sort((a, b) => dist(a.color, col) - dist(b.color, col))[0];
    if (pick) cur.map3[e] = String(pick.index);
  }
}
/** Benutzte Projekt-Filamente der Platte (1-basiert) */
function ed3Exts(cur) {
  const set = new Set();
  cur.parts.forEach(p => { if (p.kind === '3mf') (p.geo.exts || []).forEach(e => set.add(e)); else if (cur.mode === '3mf') set.add(p.ext3 || 1); });
  return [...set].sort((a, b) => a - b);
}
function ed3Col(cur, e) {
  const s3 = cur.src3, sl = edSlotsOf(cur.pr);
  if (edMultiOf(cur.pr) && cur.map3[e] != null) { const s = sl.find(x => String(x.index) === String(cur.map3[e])); if (s && s.color) return s.color; }
  return (s3 && s3.pal[e - 1]) || ED_COLORS[0];
}
/** 3MF an Ort und Stelle ändern → Blob. Lage je Kopie neu, Kopien als weitere <item>, Entferntes/Nicht drucken = printable="0", STL als neue Objekte */
async function ed3Build(cur, prog) {
  const s3 = cur.src3, z = s3.z, pl = s3.plates[cur.plate3], u = s3.unit || 1;
  let main = s3.mainTxt;
  const num = edNum, rnd = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
  const tfOf = (p, q) => {   // Lage → transform „m00 m01 m02 m10 … tx ty tz“ (Zeilenvektor-Form, Datei-Einheit)
    const L = q.L, c = p.kind === '3mf' ? p.geo.c0 : [0, 0, 0];
    const Lc = [L[0] * c[0] + L[1] * c[1] + L[2] * c[2], L[3] * c[0] + L[4] * c[1] + L[5] * c[2], L[6] * c[0] + L[7] * c[1] + L[8] * c[2]];
    const Te = [q.x - (q.bb.lo[0] + q.bb.hi[0]) / 2, q.y - (q.bb.lo[1] + q.bb.hi[1]) / 2, -q.bb.lo[2]];
    const tx = Te[0] - Lc[0] + pl.origin[0] - cur.sh3[0], ty = Te[1] - Lc[1] + pl.origin[1] - cur.sh3[1], tz = Te[2] - Lc[2];
    const k = p.kind === '3mf' ? 1 / u : 1;
    return [L[0], L[3], L[6], L[1], L[4], L[7], L[2], L[5], L[8]].map(num).join(' ') + ' ' + [tx * k, ty * k, tz * k].map(num).join(' ');
  };
  const setAttr = (tag, k, v) => { const re = new RegExp('\\s' + k.replace(/[.:]/g, '\\$&') + '="[^"]*"'); return re.test(tag) ? tag.replace(re, ` ${k}="${v}"`) : tag.replace(/\s*(\/?)>$/, ` ${k}="${v}"$1>`); };
  // 1) bestehende <item>: neue Lage bzw. printable="0"
  const edits = new Map();
  cur.parts.forEach(p => { if (p.kind === '3mf') p.inst.forEach(q => { if (q.bi != null) edits.set(q.bi, { tf: tfOf(p, q), off: !!q.skip }); }); });
  (cur.gone || []).forEach(bi => edits.set(bi, { off: true }));
  const items = edBuildItems(main).items;
  let out = '', last = 0;
  for (const it of items) {
    const e = edits.get(it.i); if (!e) continue;
    let tag = it.tag;
    if (e.tf) tag = setAttr(tag, 'transform', e.tf);
    tag = setAttr(tag, 'printable', e.off ? '0' : '1');
    out += main.slice(last, it.at) + tag; last = it.at + it.len;
  }
  main = out + main.slice(last);
  // 2) neue <item>: Kopien von 3MF-Objekten + STL-Teile (neue Objekte)
  const hasUuid = /p:UUID=/.test(items.map(i => i.tag).join('')), newItems = [], newInst = [], newAsm = [], newObjCfg = [], newFiles = [], newRels = [];
  const icount = {}; items.forEach(it => { icount[it.oid] = (icount[it.oid] || 0) + 1; });
  // Neue Objekte mit großen, eindeutigen Nummern: Orca führt Objekt-Nummern aus allen Modelldateien in EINER Liste (Nummer 1 in einer
  // neuen Datei traf sonst ein Teil der vorhandenen 3MF → „leere erste Schicht“, 19.11.2026)
  let ident = Math.max(1000, ...s3.plates.map(x => x.maxIdent || 0)) + 1, oidNext = Math.max(s3.maxMain + 1, 800001), subNext = 900001, fileN = 1;
  const addItem = (oid, tf, off) => {
    const inst = icount[oid] = (icount[oid] || 0); icount[oid]++;
    newItems.push(`<item objectid="${oid}"${hasUuid ? ` p:UUID="${rnd()}"` : ''} transform="${tf}" printable="${off ? 0 : 1}"/>`);
    newInst.push(`<model_instance><metadata key="object_id" value="${oid}"/><metadata key="instance_id" value="${inst}"/><metadata key="identify_id" value="${ident++}"/></model_instance>`);
    newAsm.push(`<assemble_item object_id="${oid}" instance_id="${inst}" transform="${tf}" offset="0 0 0"/>`);
  };
  cur.parts.forEach(p => { if (p.kind === '3mf') p.inst.forEach(q => { if (q.bi == null) addItem(p.oid, tfOf(p, q), q.skip); }); });
  const stls = cur.parts.filter(p => p.kind === 'stl');
  for (let n = 0; n < stls.length; n++) {
    const p = stls[n]; if (prog) prog(n + 1, stls.length);
    while (z.find(`3D/Objects/amp_${fileN}.model`)) fileN++;
    const path = `3D/Objects/amp_${fileN++}.model`, P = p.geo.pos, I = p.geo.idx, vs = [], ts = [], sid = subNext++;
    for (let i = 0; i < P.length; i += 3) vs.push(`<vertex x="${num(P[i])}" y="${num(P[i + 1])}" z="${num(P[i + 2])}"/>`);
    for (let f = 0; f < I.length; f += 3) ts.push(`<triangle v1="${I[f]}" v2="${I[f + 1]}" v3="${I[f + 2]}"/>`);
    newFiles.push({ name: path, data: '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n <resources>\n  <object id="' + sid + '" type="model">\n   <mesh>\n    <vertices>\n'
      + vs.join('\n') + '\n    </vertices>\n    <triangles>\n' + ts.join('\n') + '\n    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build/>\n</model>\n' });
    newRels.push(`<Relationship Target="/${path}" Id="rel-amp-${fileN}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`);
    const oid = oidNext++, ext = p.ext3 || 1, sup = p.sup === 'auto' || p.sup === 'bed' ? '<metadata key="enable_support" value="1"/>' + (p.sup === 'bed' ? '<metadata key="support_on_build_plate_only" value="1"/>' : '') : '';
    main = main.replace(/<\/resources>/, `  <object id="${oid}"${hasUuid ? ` p:UUID="${rnd()}"` : ''} type="model"><components><component p:path="/${path}" objectid="${sid}"${hasUuid ? ` p:UUID="${rnd()}"` : ''} transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>\n </resources>`);
    newObjCfg.push(`  <object id="${oid}"><metadata key="name" value="${edXml(p.name)}"/><metadata key="extruder" value="${ext}"/>${sup}<part id="${sid}" subtype="normal_part"><metadata key="name" value="${edXml(p.name)}"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/><metadata key="extruder" value="${ext}"/></part></object>`);
    p.inst.forEach(q => addItem(oid, tfOf(p, q), q.skip));
    await new Promise(r => setTimeout(r, 0));
  }
  if (newItems.length) main = main.replace(/<\/build>/, newItems.join('') + '</build>');
  // 3) model_settings: Platte bekommt die neuen Instanzen, neue Objekte ihre Einstellungen
  let ms = s3.ms;
  if (ms && (newInst.length || newObjCfg.length)) {
    if (newObjCfg.length) ms = ms.replace(/(<plate>|<plate\b)/, newObjCfg.join('\n') + '\n  $1');
    let k = -1;
    ms = ms.replace(/<\/plate>/g, m => (++k === cur.plate3 ? newInst.join('') + m : m));
    if (newAsm.length) ms = /<\/assemble>/.test(ms) ? ms.replace(/<\/assemble>/, newAsm.join('') + '</assemble>') : ms.replace(/<\/config>/, `  <assemble>${newAsm.join('')}</assemble>\n</config>`);
  }
  // 4) Beziehungen der Objektdateien
  const relName = (s3.main.replace(/^\//, '').replace(/[^/]+$/, '') + '_rels/' + s3.main.replace(/^.*\//, '') + '.rels');
  let rels = newRels.length ? await z.text(relName) : null;
  if (newRels.length) rels = rels ? rels.replace(/<\/Relationships>/, newRels.join('') + '</Relationships>') : '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + newRels.join('') + '</Relationships>';
  // 5) ZIP: Geändertes neu, alles andere roh
  const mk = s3.main.replace(/^\//, '').toLowerCase(), msk = 'metadata/model_settings.config', rk = relName.toLowerCase();
  const files = z.list.map(e => e.key === mk ? { name: e.name, data: main } : e.key === msk && ms !== s3.ms ? { name: e.name, data: ms } : e.key === rk && rels ? { name: e.name, data: rels } : { name: e.name, e });
  if (rels && !z.find(relName)) files.push({ name: relName, data: rels });
  files.push(...newFiles);
  return edZipMix(z, files);
}
/** Zeilen-Text eines Teils im 3MF-Modus: Fächer bzw. Projektfarben */
function ed3Info(cur, p) {
  const ex = p.kind === '3mf' ? p.geo.exts || [1] : [p.ext3 || 1], sl = edSlotsOf(cur.pr);
  if (!edMultiOf(cur.pr)) return ex.length > 1 ? t('amp_ed_n_cols', { n: ex.length }) : '';
  return [...new Set(ex.map(e => { const s = sl.find(x => String(x.index) === String(cur.map3[e])); return s ? tf('pc_slot_n', s.label) : t('amp_ed_fil_n', { n: e }); }))].join(', ');
}
/** Farbe im 3MF-Modus: Projektfarben → Fächer (alle benutzten Filamente der Platte); STL-Teil: „Farbe wie Filament n“ */
function ed3ColorHtml(cur, p) {
  const s3 = cur.src3, sl = edSlotsOf(cur.pr), multi = edMultiOf(cur.pr), exts = ed3Exts(cur);
  const sw = c => `<span class="sw" style="background:${esc(c)}"></span>`;
  let h = '';
  if (p && p.kind === 'stl') h += `<h3>${esc(t('amp_ed_like_fil'))}</h3><div class="amp-edslots">${s3.pal.map((c, i) => `<button type="button" class="amp-edslot${(p.ext3 || 1) === i + 1 ? ' on' : ''}" data-ext3="${i + 1}" aria-pressed="${(p.ext3 || 1) === i + 1}"><span class="sw" style="background:${esc(c)};color:${edInk(c)}">${i + 1}</span><b>${esc(s3.types[i] || 'PLA')}</b></button>`).join('')}</div>`;
  if (!sl.length) return h + `<p class="amp-edsub">${esc(t('amp_ed_slot_mat'))}</p>`;
  if (!multi) {
    const cs = sl.find(x => String(x.index) === String(cur.slot1));
    return h + `<h3>${esc(t('amp_ed_slot_h1'))}</h3><p class="amp-edsub">${esc(t('amp_ed_slot_single'))}</p><div class="amp-edslots">${sl.map(x => `<button type="button" class="amp-edslot${cs && String(cs.index) === String(x.index) ? ' on' : ''}" data-slot="${esc(String(x.index))}"${edSlotOk(x) ? '' : ' disabled'}><span class="sw${x.material ? '' : ' empty'}" style="${x.color ? `background:${esc(x.color)};color:${edInk(x.color)}` : ''}">${esc(x.label)}</span><b>${esc(x.material || t('slot_empty'))}</b></button>`).join('')}</div>`;
  }
  return h + `<h3>${esc(t('amp_ed_fil_h'))}</h3><p class="amp-edsub">${esc(t('amp_ed_fil_sub'))}</p><div class="amp-edall">${exts.map(e => `<label class="amp-edallr">${sw(s3.pal[e - 1] || '#888')}<span class="t">${esc(t('amp_ed_fil_n', { n: e }))} · ${esc(s3.types[e - 1] || 'PLA')}</span>
    <select data-map3="${e}" aria-label="${esc(t('amp_ed_fil_n', { n: e }))}">${sl.map(x => `<option value="${esc(String(x.index))}"${String(cur.map3[e]) === String(x.index) ? ' selected' : ''}${edSlotOk(x) ? '' : ' disabled'}>${esc(tf('pc_slot_n', x.label) + ' · ' + (x.material || t('slot_empty')))}</option>`).join('')}</select></label>`).join('')}</div>`;
}
/** Andere Platte der 3MF bearbeiten (Änderungen an der aktuellen gehen verloren) */
async function ed3Plate(cur, k) {
  if (cur.undo.length && !confirm(t('amp_ed_plate_switch'))) { edPanel(cur); return; }
  const pool = {}, parts = [];
  await ed3Parts(cur.src3, k, pool, parts, () => {});
  cur.parts.filter(p => p.kind === 'stl').forEach(p => { p.key = 'k' + Object.keys(pool).length; pool[p.key] = p; parts.push(p); });
  Object.values(cur.pool).forEach(p => { if (p.bg) { p.bg.dispose(); p.bg = null; } });
  Object.assign(cur, { pool, parts, plate3: k, gone: [], undo: [], redo: [], sel: parts.length ? { p: 0, i: 0 } : null });
  ed3Place(cur); ed3AutoMap(cur);
  edMeshes(cur); edView(cur, cur.vk || '3d'); edPanel(cur);
}
/** Teile hinzufügen: Dateien (vom Gerät oder aus der Bibliothek) → STL als Teil, 3MF als Grundlage (eine je Platte) */
async function edAddItems(cur, items) {
  const is3 = x => x.ext === '3mf' || /\.3mf$/i.test(x.file.name);
  if (items.some(is3)) {
    if (cur.mode === '3mf' || items.filter(is3).length > 1) { toast(t('amp_ed_two_3mf', { name: (items.find(is3) || {}).name || '' })); items = items.filter(x => !is3(x)); }
    else {   // bisherige STL-Teile kommen mit ihrer Lage in die 3MF
      ED.hand = { parts: [...items, ...cur.parts.map(p => ({ id: p.id, name: p.name, file: p.file, n: p.inst.length, slot: p.slot, sup: p.sup, inst: p.inst.map(q => ({ L: q.L, x: q.x, y: q.y, s: q.s, skip: q.skip })) }))],
                  plate: null, printer: cur.pr ? cur.pr.key : null };
      viewEdit(); return;
    }
  }
  if (!items.length) return;
  if (cur.mode === '3mf' && cur.src3.kind !== 'bambu') { toast(t('amp_ed_mix_prusa', { name: cur.src3.name })); return; }
  let budget = ED_TRI_MAX - cur.parts.reduce((a, p) => a + p.geo.nt, 0);
  edPush(cur);
  try {
    for (const x of items) {
      const geo = await edReadStl(x.file, budget); budget -= geo.nt;
      const key = 'k' + Object.keys(cur.pool).length;
      const p = { key, kind: 'stl', id: x.id || null, name: x.name || x.file.name.replace(/\.stl$/i, ''), file: x.file, geo, slot: String(edDefSlot(cur.pr)), sup: '', ext3: 1, inst: [{ L: ED_I3.slice(), x: 0, y: 0, s: 1, skip: false, rz: 0 }] };
      edFix(p, p.inst[0]);
      [p.inst[0].x, p.inst[0].y] = edFreeSpot(cur, Object.assign(p.inst[0], { x: edBed(cur)[0] / 2, y: edBed(cur)[1] / 2 }));
      cur.pool[key] = p; cur.parts.push(p); cur.sel = { p: cur.parts.length - 1, i: 0 };
    }
  } catch (e) { toast(e.message === 'too_big' ? t('amp_ed_too_big', { name: e.part, n: ED_TRI_MAX / 1e6 }) : t('amp_ed_bad_file', { name: e.part || '?' })); }
  if (cur.mode === '3mf') ed3AutoMap(cur);
  if (!cur.name || cur.name === t('amp_ed_new')) cur.name = cur.parts.length > 1 ? t('amp_plate_n_models', { n: cur.parts.length }) : (cur.parts[0] || {}).name || cur.name;
  edMeshes(cur); edPanel(cur);
  const nm = $('#edname'); if (nm) nm.textContent = cur.name;
}
/** Aus der Bibliothek: STL und 3MF (ohne G-Code, Gemerktes, Platten), Mehrfachauswahl mit Suche */
async function edPick(cur) {
  let d; try { d = await api('lib_list'); } catch (e) { fail(e); return; }
  const ok = f => (f.ext === 'stl' || f.ext === '3mf') && !f.want && !f.gone && !f.plate && !(f.gcode && f.gcode.printer);
  const files = (d.files || []).filter(ok).sort((a, b) => lbCmp(a.name, b.name)), have = new Set(cur.parts.map(p => p.id).filter(Boolean)), sel = new Set();
  const pic = f => { const th = (f.plates || []).find(x => x.thumb); return th ? `<img src="api.php?a=lib_thumb&amp;id=${f.id}&amp;n=${th.n}&amp;v=${f.v || 1}" alt="" loading="lazy">` : I_BOX; };
  dlg.innerHTML = `<form method="dialog" class="amp-plpick"><div class="dlg-h"><b>${esc(t('amp_plate_pick_h'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b">${files.length ? `<input class="in" type="search" id="edpq" placeholder="${esc(t('lib_search'))}" aria-label="${esc(t('lib_search'))}" autocomplete="off">
      <div class="amp-plpl">${files.map(f => `<button type="button" class="amp-plpi" data-id="${f.id}" aria-pressed="false" data-q="${esc([f.name, f.folder, (f.tags || []).join(' ')].join(' ').toLowerCase())}">
        <span class="amp-chk" aria-hidden="true"></span><span class="pic">${pic(f)}</span>
        <span class="t"><b>${esc(f.name)}</b><small>${esc([f.ext.toUpperCase(), f.folder, fsize(f.size), have.has(f.id) ? t('amp_plate_on') : ''].filter(Boolean).join(' · '))}</small></span></button>`).join('')}</div>`
      : `<p class="hint">${esc(t('amp_plate_pick_none'))}</p>`}</div>
    <div class="dlg-f"><button type="button" class="btn" data-x>${esc(t('cancel'))}</button><button type="button" class="btn pri" id="edpgo" disabled>${esc(t('amp_plate_pick_add', { n: 0 }))}</button></div></form>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const go = dlg.querySelector('#edpgo'), upd = () => { go.disabled = !sel.size; go.textContent = t('amp_plate_pick_add', { n: sel.size }); };
  dlg.querySelectorAll('.amp-plpi').forEach(b => b.onclick = () => { const id = +b.dataset.id; if (sel.has(id)) sel.delete(id); else sel.add(id);
    b.setAttribute('aria-pressed', sel.has(id)); b.classList.toggle('amp-on', sel.has(id)); b.querySelector('.amp-chk').innerHTML = sel.has(id) ? I_CHECK : ''; upd(); });
  const q = dlg.querySelector('#edpq'); if (q) q.oninput = () => { const v = q.value.trim().toLowerCase(); dlg.querySelectorAll('.amp-plpi').forEach(b => { b.hidden = !!v && !b.dataset.q.includes(v); }); };
  go.onclick = async () => {
    const pick = files.filter(f => sel.has(f.id)); go.disabled = true;
    try {
      const items = await ampPlateFetch(pick.map(f => ({ id: f.id, name: f.name, n: 1, slot: '', ext: f.ext })), (i, n) => { go.textContent = t('amp_plate_loading', { i, n }); });
      dlg.close(); await edAddItems(cur, items);
    } catch (e) { upd(); toast(ampPlateErr(e)); }
  };
}
/** Vom Gerät: STL oder 3MF wählen */
function edFromDevice(cur) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.stl,.3mf';
  inp.onchange = () => { const fs = [...(inp.files || [])].filter(f => /\.(stl|3mf)$/i.test(f.name)); if (fs.length) edAddItems(cur, fs.map(f => ({ file: f, name: f.name.replace(/\.(stl|3mf)$/i, ''), ext: /\.3mf$/i.test(f.name) ? '3mf' : 'stl' }))); };
  inp.click();
}
/** Leeren Editor öffnen („Neue Platte“) */
function ampEdNew(printer) { return ampEdOpen([], null, printer || null); }
/** Druckansicht: Knopf „Platte bearbeiten“ neben „Fertigen G-Code ohne Server senden“ — gewählte STL/3MF mitnehmen, sonst leer */
function ampEdNoteHook() {
  const b = document.getElementById('ampedopen'); if (!b) return;
  b.onclick = () => {
    const pr = (view.querySelector('input[name="printer"]:checked') || {}).value || null;
    const L = ps && ps.stls && ps.stls.length ? ps.stls : null, f = $('#pfile') && $('#pfile').files[0];
    if (L) return ampEdOpen(L.map(x => ({ id: x.lib || null, name: x.file.name.replace(/\.stl$/i, ''), file: x.file, n: x.copies || 1, slot: x.slot || '' })), null, pr);
    if (f && /\.3mf$/i.test(f.name)) return ampEdOpen([{ id: ps.lib && ps.lib.id && sameFile(f, ps.lib.file) ? ps.lib.id : null, name: f.name.replace(/\.3mf$/i, ''), file: f, ext: '3mf', plate3: ps.wantPlate || 1 }], null, pr);
    if (f && /\.stl$/i.test(f.name)) return ampEdOpen([{ name: f.name.replace(/\.stl$/i, ''), file: f, n: 1 }], null, pr);
    return ampEdNew(pr);
  };
}
/** 3MF: „Slicen & drucken“ — geänderte 3MF (diese Platte) an die Druckansicht; Fächer aus der Zuordnung im Editor */
async function ed3Print(cur, btn) {
  const blob = await ed3Build(cur, (i, n) => { btn.textContent = t('amp_ed_building_n', { i, n }); });
  const multi = edMultiOf(cur.pr), exts = ed3Exts(cur), map = {};
  if (multi) exts.forEach(e => { if (cur.map3[e] != null) map[e] = +cur.map3[e]; });
  const ids = [...new Set([cur.src3.libId, ...cur.parts.filter(p => p.kind === 'stl' && p.id).map(p => p.id)].filter(Boolean))];
  const nm = (cur.name || 'plate').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'plate';
  lb.hand = { printer: cur.pr.key, id: cur.src3.libId || ids[0] || null, name: cur.name, plate: cur.plate3 + 1, ed: true, plateId: null, libIds: ids,
    edSlot: multi ? null : (cur.slot1 !== '' ? +cur.slot1 : null), edMap: multi && Object.keys(map).length ? map : null,
    file: new File([blob], `${nm}.3mf`, { type: 'application/octet-stream', lastModified: Date.now() }) };
  location.hash = 'print';
}
/** 3MF: als neue Datei in der Bibliothek speichern (Original bleibt) */
async function ed3SaveDlg(cur) {
  if (!(await ampFeat('editor'))) { ampPlanDeny('editor'); return; }
  let d; try { d = await api('lib_list'); } catch (e) { fail(e); return; }
  const files = d.files || [], orig = files.find(x => x.id === cur.src3.libId);
  dlg.innerHTML = `<form method="dialog" class="amp-plsave"><div class="dlg-h"><b>${esc(t('amp_ed_save3'))}</b><button type="button" class="x-btn" data-x aria-label="${esc(t('close'))}">×</button></div>
    <div class="dlg-b"><p class="hint">${esc(t('amp_ed_save3_hint'))}</p>
      <label class="fld"><span>${esc(t('lib_name'))}</span><input class="in" id="edsnm" maxlength="120" value="${esc(`${cur.src3.name} (${t('amp_ed_edited')})`)}" autocomplete="off"></label>
      <label class="fld"><span>${esc(t('lib_folder'))}</span><input class="in" id="edsfo" list="edsfl" maxlength="160" value="${esc(orig ? orig.folder || '' : '')}" placeholder="${esc(t('amp_lib_folder_ph'))}" autocomplete="off"></label>
      <datalist id="edsfl">${lbPaths(files).map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>
    <div class="dlg-f"><button type="button" class="btn" data-x>${esc(t('cancel'))}</button><button type="submit" class="btn pri" id="edsok">${esc(t('save'))}</button></div></form>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => dlg.close());
  const fm = dlg.querySelector('form'), ok = dlg.querySelector('#edsok');
  fm.onsubmit = async e => {
    e.preventDefault(); ok.disabled = true; ok.textContent = t('amp_ed_building');
    let token = '';
    try {
      const nm = (dlg.querySelector('#edsnm').value.trim() || cur.src3.name).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 110);
      const blob = await ed3Build(cur), file = new File([blob], nm + '.3mf', { type: 'application/octet-stream', lastModified: Date.now() });
      token = await ampStash(file);
      const r = await api('lib_upload', { token, name: file.name, size: file.size, folder: dlg.querySelector('#edsfo').value.trim(), thumb: null });
      if (!r || !r.ok) throw new Error((r && r.error) || 'lib_upload');
      dlg.close(); toast(t('amp_ed_saved3', { name: nm }));
    } catch (er) { ok.disabled = false; ok.textContent = t('save'); fail(er); }
    finally { if (token) AMP.native('fileDrop', { token }).catch(() => {}); }
  };
}

})();
