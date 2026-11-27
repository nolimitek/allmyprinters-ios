/* AllMyPrinters — 3D-Netz für die Bibliothek (10.11.2026, User: „in einem dreidimensionalen bewegen wie auf der Slicer-Platte“).
 * Auf 3DSEARCH baut der Server das Netz (library_lib.php: lib_read_stl, lib_read_3mf, lib_pack, lib_cluster); die App macht
 * dasselbe auf dem Handy und schreibt dasselbe Format LBM1 (gz), das libview.js (three.js) zeigt:
 *   'LBM1', uint32 Länge, JSON {min, k, nv, nt, groups [{c, n}], bed, virt, dec}, Ecken uint16×3 (auf 4 Byte aufgefüllt),
 *   Dreiecke uint32×3 in Gruppenreihenfolge (Gruppe = Farbe).
 * 3MF: ZIP selbst gelesen (DecompressionStream „deflate-raw“), Platten/Teile/Extruder aus Metadata/model_settings.config,
 * Bett und Farben aus project_settings.config bzw. Slic3r_PE.config, Bemalung (paint_color) als Mehrheitsfarbe je Dreieck.
 * Aufruf: const r = await AMPMesh.build(blob, 'stl'|'3mf') → { plates: [{ n, name, objs, tris, src_tris, dec, dims, bed, virt, gz }] } */
(function () {
  'use strict';
  const TRI_MAX = 300000;        // Dreiecke je Platte in der Ansicht, darüber vereinfacht (Handy-Grafik; Website 400 000)
  const TRI_LIMIT = 6000000;     // ganze Datei, darüber keine 3D-Ansicht (Speicher im Handy)
  const XML_LIMIT = 400 * 1048576;
  const COLOR = '#ff6a14';       // STL ohne Farbangabe (wie LIB_COLOR)

  // ── Netz sammeln: 9 Floats je Dreieck + Farbnummer ──
  function newMesh() {
    return {
      pos: new Float32Array(9 * 8192), col: new Uint8Array(8192), n: 0,
      grow() {
        const p = new Float32Array(this.pos.length * 2); p.set(this.pos); this.pos = p;
        const c = new Uint8Array(this.col.length * 2); c.set(this.col); this.col = c;
      },
      add9(x0, y0, z0, x1, y1, z1, x2, y2, z2, col) {
        if (this.n >= TRI_LIMIT) throw new Error('too_complex');
        if (this.n === this.col.length) this.grow();
        const o = this.n * 9, P = this.pos;
        P[o] = x0; P[o + 1] = y0; P[o + 2] = z0; P[o + 3] = x1; P[o + 4] = y1; P[o + 5] = z1; P[o + 6] = x2; P[o + 7] = y2; P[o + 8] = z2;
        this.col[this.n++] = col;
      },
    };
  }

  async function readStl(blob) {
    const buf = await blob.arrayBuffer(), dv = new DataView(buf), m = newMesh();
    const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
    if (n > 0 && 84 + n * 50 === buf.byteLength) {
      if (n > TRI_LIMIT) throw new Error('too_complex');
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12, f = j => dv.getFloat32(o + j * 4, true);
        m.add9(f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8), 0);
      }
    } else {
      const txt = new TextDecoder().decode(buf), re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g, v = [];
      let mm;
      while ((mm = re.exec(txt))) { v.push(+mm[1], +mm[2], +mm[3]); if (v.length === 9) { m.add9(...v, 0); v.length = 0; } }
    }
    return m;
  }

  // ── ZIP (3MF) ──
  async function zipOpen(blob) {
    const size = blob.size, tl = Math.min(size, 65557 + 76);
    const tail = new DataView(await blob.slice(size - tl).arrayBuffer());
    let eocd = -1;
    for (let i = tl - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip');
    let cnt = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
    if ((cdOff === 0xFFFFFFFF || cnt === 0xFFFF) && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {   // ZIP64
      const z64 = Number(tail.getBigUint64(eocd - 12, true));
      const z = new DataView(await blob.slice(z64, z64 + 56).arrayBuffer());
      cnt = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
    }
    const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), td = new TextDecoder(), entries = new Map();
    for (let i = 0, p = 0; i < cnt && p + 46 <= cd.byteLength; i++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const method = cd.getUint16(p + 10, true), nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
      let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), off = cd.getUint32(p + 42, true);
      const name = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
      for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {
        const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (csize === 0xFFFFFFFF) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (off === 0xFFFFFFFF) off = Number(cd.getBigUint64(q, true));
        }
        x += 4 + len;
      }
      entries.set(name.replace(/^\//, ''), { method, csize, usize, off });
      p += 46 + nl + xl + cl;
    }
    const find = name => { const k = String(name).replace(/^\//, ''); if (entries.has(k)) return entries.get(k); for (const [n, e] of entries) if (n.toLowerCase() === k.toLowerCase()) return e; return null; };
    async function read(name) {
      const e = find(name); if (!e) return null;
      const lh = new DataView(await blob.slice(e.off, e.off + 30).arrayBuffer());
      const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true), data = blob.slice(start, start + e.csize);
      if (e.method === 0) return new Uint8Array(await data.arrayBuffer());
      if (e.method !== 8) throw new Error('zip_method');
      return new Uint8Array(await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    }
    const text = async name => { const b = await read(name); return b ? new TextDecoder().decode(b) : null; };
    return { entries, text };
  }

  // ── 3MF lesen (wie lib_read_3mf + ps_3mf_scan + lib_3mf_entry_meshes) ──
  const attrs = s => { const o = {}, re = /([\w:.-]+)\s*=\s*"([^"]*)"/g; let m; while ((m = re.exec(s))) o[m[1]] = m[2]; return o; };
  const mParse = t => { const v = t ? String(t).trim().split(/\s+/).map(Number) : []; return v.length === 12 && v.every(Number.isFinite) ? v : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]; };
  /** Erst a, dann b anwenden (ps_m_mul). */
  const mMul = (a, b) => { const r = []; for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0); return r; };
  /** Bemalung (Bambu paint_color / Prusa mmu_segmentation): häufigster Zustand im Baum (lib_paint_state). 0 = unbemalt. */
  function paintState(s) {
    const n = s.length;
    if (!n) return 0;
    if (n === 1) { const c = parseInt(s, 16); return (c & 3) === 0 && (c >> 2) < 3 ? c >> 2 : 0; }
    let pos = n - 1; const cnt = {};
    const node = depth => {
      if (pos < 0 || depth > 12) return;
      const c = parseInt(s[pos--], 16), split = c & 3;
      if (split === 0) { let st = c >> 2; if (st === 3) st = pos >= 0 ? parseInt(s[pos--], 16) + 3 : 3; cnt[st] = (cnt[st] || 0) + 1; return; }
      for (let i = 0; i <= split; i++) node(depth + 1);
    };
    node(0);
    let best = 0, bn = -1;
    for (const k in cnt) if (cnt[k] > bn) { bn = cnt[k]; best = +k; }
    return best;
  }
  function parseMesh(seg) {
    const v = [], t = [], p = [];
    let painted = false, m;
    const reV = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g;
    while ((m = reV.exec(seg))) v.push(+m[1], +m[2], +m[3]);
    if (!v.length && seg.includes('<vertex')) {   // andere Reihenfolge der Attribute
      const re = /<vertex\b([^>]*)>/g;
      while ((m = re.exec(seg))) { const a = attrs(m[1]); v.push(+a.x || 0, +a.y || 0, +a.z || 0); }
    }
    const reT = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"([^>]*)>/g;
    while ((m = reT.exec(seg))) {
      t.push(+m[1], +m[2], +m[3]);
      const pc = /(?:paint_color|mmu_segmentation)="([^"]*)"/.exec(m[4]);
      const st = pc && pc[1] ? paintState(pc[1]) : 0;
      if (st) painted = true;
      p.push(Math.min(255, st));
      if (t.length / 3 > TRI_LIMIT) throw new Error('too_complex');
    }
    if (!t.length && seg.includes('<triangle')) {
      const re = /<triangle\b([^>]*)>/g;
      while ((m = re.exec(seg))) {
        const a = attrs(m[1]); t.push(+a.v1 || 0, +a.v2 || 0, +a.v3 || 0);
        const pc = a.paint_color || a['slic3rpe:mmu_segmentation'] || '', st = pc ? paintState(pc) : 0;
        if (st) painted = true; p.push(Math.min(255, st));
      }
    }
    return { v: Float64Array.from(v), t: Uint32Array.from(t), p: painted ? Uint8Array.from(p) : null };
  }
  /** Objekte (Netz, Komponenten) und Druckobjekte einer Modelldatei. */
  function scanModel(txt, entry) {
    const out = { objects: {}, build: [] }, icount = {};
    const reO = /<object\b([^>]*?)(\/?)>/g;
    let m;
    while ((m = reO.exec(txt))) {
      const a = attrs(m[1]), id = a.id;
      if (id === undefined) continue;
      const o = out.objects[id] = { type: a.type || 'model', mesh: null, components: [] };
      if (m[2] === '/') continue;
      const end = txt.indexOf('</object>', reO.lastIndex);
      if (end < 0) break;
      const seg = txt.slice(reO.lastIndex, end);
      if (seg.includes('<mesh')) o.mesh = parseMesh(seg);
      const reC = /<component\b([^>]*?)\/?>/g; let c;
      while ((c = reC.exec(seg))) {
        const ca = attrs(c[1]), pk = Object.keys(ca).find(k => /(^|:)path$/.test(k));
        o.components.push([pk ? ca[pk] : entry, ca.objectid, mParse(ca.transform)]);
      }
      reO.lastIndex = end + 9;
    }
    const b0 = txt.indexOf('<build');
    if (b0 >= 0) {
      const b1 = txt.indexOf('</build>', b0), seg = txt.slice(b0, b1 > b0 ? b1 : txt.length), reI = /<item\b([^>]*?)\/?>/g;
      let it;
      while ((it = reI.exec(seg))) {
        const ia = attrs(it[1]), oid = ia.objectid;
        icount[oid] = oid in icount ? icount[oid] + 1 : 0;   // Instanz = wievielter Eintrag dieses Objekts (wie instance_id)
        if (ia.printable === '0') continue;
        out.build.push([oid, mParse(ia.transform), icount[oid]]);
      }
    }
    return out;
  }
  /** Netz transformiert anhängen (lib_mesh_add). Farbe: bemalter Zustand vor Extruder des Teils. */
  function meshAdd(m, mesh, mx, ext, npal) {
    const v = mesh.v, nv = v.length / 3, tv = new Float32Array(v.length);
    for (let i = 0; i < nv; i++) {
      const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
      tv[i * 3] = x * mx[0] + y * mx[3] + z * mx[6] + mx[9]; tv[i * 3 + 1] = x * mx[1] + y * mx[4] + z * mx[7] + mx[10]; tv[i * 3 + 2] = x * mx[2] + y * mx[5] + z * mx[8] + mx[11];
    }
    const t = mesh.t, nt = t.length / 3, base = Math.max(0, Math.min(npal - 1, ext - 1));
    for (let i = 0; i < nt; i++) {
      const a = t[i * 3], b = t[i * 3 + 1], c = t[i * 3 + 2];
      if (a >= nv || b >= nv || c >= nv) continue;
      let col = base;
      if (mesh.p && mesh.p[i] > 0) col = Math.max(0, Math.min(npal - 1, mesh.p[i] - 1));
      m.add9(tv[a * 3], tv[a * 3 + 1], tv[a * 3 + 2], tv[b * 3], tv[b * 3 + 1], tv[b * 3 + 2], tv[c * 3], tv[c * 3 + 1], tv[c * 3 + 2], Math.min(15, col));
    }
  }
  /** Werkzeugwechsel nach Höhe je Platte aus custom_gcode_per_layer.xml: { plattennummer: [{ z, ext }, …] } (aufsteigend). */
  function layerChanges(xml) {
    const out = {};
    if (!xml || xml.length > 1048576) return out;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    for (const pl of doc.getElementsByTagName('plate')) {
      const info = pl.getElementsByTagName('plate_info')[0], mode = pl.getElementsByTagName('mode')[0];
      if (mode && mode.getAttribute('value') !== 'MultiAsSingle') continue;
      const ch = [...pl.getElementsByTagName('layer')].map(l => ({ type: +l.getAttribute('type'), z: +l.getAttribute('top_z'), ext: +l.getAttribute('extruder') }))
        .filter(c => c.type === 2 && c.ext >= 1 && Number.isFinite(c.z)).sort((a, b) => a.z - b.z);
      if (ch.length) out[+((info && info.getAttribute('id')) || 1)] = ch;
    }
    return out;
  }
  /** Dreiecke [a, b) eines Objekts nach Höhe einfärben: Orca legt das Objekt aufs Bett (z ab Unterkante), die Schicht mit
   *  Oberkante top_z druckt schon das neue Filament und schneidet in ihrer Mitte → Mittelpunkt über top_z − halbe Schichthöhe
   *  (Projekt-layer_height, sonst 0,2 mm). „Kitten“-Kugel 26.11.2026: Sockel bis 0,64 mm schwarz, Wechsel bei 0,72 mm, Schicht 0,08 —
   *  mit fest 0,1 mm wurde der schwarze Hintergrund (0,63–0,65 mm) weiß. Nur einfarbige Objekte (sonst verwirft Orca die Wechsel). */
  function layerColor(m, a, b, ch, npal, lh) {
    if (b <= a) return;
    const off = lh > 0 && lh < 1 ? lh / 2 : 0.1;
    const P = m.pos, c0 = m.col[a];
    let zmin = Infinity;
    for (let t = a; t < b; t++) {
      if (m.col[t] !== c0) return;
      const o = t * 9; zmin = Math.min(zmin, P[o + 2], P[o + 5], P[o + 8]);
    }
    for (let t = a; t < b; t++) {
      const o = t * 9, zc = (P[o + 2] + P[o + 5] + P[o + 8]) / 3 - zmin;
      let col = c0;
      for (const c of ch) { if (zc > c.z - off) col = Math.min(15, Math.max(0, Math.min(npal - 1, c.ext - 1))); else break; }
      m.col[t] = col;
    }
  }
  /** Vorschaubild einer Platte selbst zeichnen (27.11.2026): 3MF mit Farbwechsel nach Höhe — Bambu Studio legt plate_N.png aus der
   *  Vorbereiten-Ansicht ab, dort fehlen die Wechsel (Kitten-Kugel: ganz schwarz). Kleiner Software-Zeichner mit Tiefenpuffer → PNG,
   *  ohne Canvas/WebGL (läuft auch im Agenten unter Node). Flache Teile (HueForge) fast von oben, sonst schräg wie Bambu. */
  async function thumbPng(m, pal) {
    const n = m.n, P = m.pos;
    if (!n) return null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n * 9; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const flat = (z1 - z0) < 0.2 * Math.max(x1 - x0, y1 - y0);
    const az = flat ? 0 : -Math.PI / 6, el = flat ? 1.15 : 0.6;            // Blick: Drehung um Z, Höhe über dem Bett
    const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
    const S = 2, W = 480, H = 480, SW = W * S, SH = H * S;   // Bambu legt 512 px ab; Kachel bis ~3-fache Pixeldichte
    const Q = new Float32Array(n * 9);                                       // Bild-x, Bild-y (oben), Tiefe (fern = groß)
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < n * 3; i++) {
      const x = P[i * 3] - mx, y = P[i * 3 + 1] - my, z = P[i * 3 + 2] - mz;
      const xr = x * ca - y * sa, yr = x * sa + y * ca;
      const u = xr, v = yr * se + z * ce, d = yr * ce - z * se;
      Q[i * 3] = u; Q[i * 3 + 1] = v; Q[i * 3 + 2] = d;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const sc = 0.88 * Math.min(SW / Math.max(1e-6, u1 - u0), SH / Math.max(1e-6, v1 - v0));
    const ox = SW / 2 - (u0 + u1) / 2 * sc, oy = SH / 2 + (v0 + v1) / 2 * sc;
    const rgb = (pal || []).map(c => { const h = /^#([0-9a-f]{6})/i.exec(String(c || '')); const v = parseInt(h ? h[1] : 'ff6a14', 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; });
    const zb = new Float32Array(SW * SH).fill(Infinity), px = new Uint8Array(SW * SH * 4);
    const L = [-0.35, 0.55, -0.76], ll = Math.hypot(L[0], L[1], L[2]);
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const ax = ox + Q[o] * sc, ay = oy - Q[o + 1] * sc, bx = ox + Q[o + 3] * sc, by = oy - Q[o + 4] * sc, cx = ox + Q[o + 6] * sc, cy = oy - Q[o + 7] * sc;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-9) continue;
      // Licht von oben links vorn, beidseitig (Wicklung der Dreiecke nicht vertrauen)
      const ux = Q[o + 3] - Q[o], uy = Q[o + 4] - Q[o + 1], uz = Q[o + 5] - Q[o + 2], vx = Q[o + 6] - Q[o], vy = Q[o + 7] - Q[o + 1], vz = Q[o + 8] - Q[o + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz) || 1;
      const sh = 0.4 + 0.6 * Math.abs((nx * L[0] + ny * L[1] + nz * L[2]) / (nl * ll));
      const c = rgb[m.col[t]] || rgb[0] || [255, 106, 20];
      const r = Math.min(255, (26 + c[0] * 0.9) * sh), g = Math.min(255, (26 + c[1] * 0.9) * sh), b = Math.min(255, (26 + c[2] * 0.9) * sh);
      const minx = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxx = Math.min(SW - 1, Math.ceil(Math.max(ax, bx, cx)));
      const miny = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxy = Math.min(SH - 1, Math.ceil(Math.max(ay, by, cy)));
      const da = Q[o + 2], db = Q[o + 5], dc = Q[o + 8], ia = 1 / area;
      for (let yy = miny; yy <= maxy; yy++) {
        const py = yy + 0.5;
        for (let xx = minx; xx <= maxx; xx++) {
          const pxx = xx + 0.5;
          const w0 = ((bx - pxx) * (cy - py) - (by - py) * (cx - pxx)) * ia, w1 = ((cx - pxx) * (ay - py) - (cy - py) * (ax - pxx)) * ia, w2 = 1 - w0 - w1;
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
          const d = w0 * da + w1 * db + w2 * dc, k = yy * SW + xx;
          if (d >= zb[k]) continue;
          zb[k] = d; const q = k * 4; px[q] = r; px[q + 1] = g; px[q + 2] = b; px[q + 3] = 255;
        }
      }
    }
    // 2 × 2 zusammenfassen (Kantenglättung), Hintergrund durchsichtig
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const q = ((y * S + j) * SW + x * S + i) * 4, al = px[q + 3]; r += px[q] * al; g += px[q + 1] * al; b += px[q + 2] * al; a += al; }
      const q = (y * W + x) * 4;
      if (a) { out[q] = Math.round(r / a); out[q + 1] = Math.round(g / a); out[q + 2] = Math.round(b / a); out[q + 3] = Math.round(a / (S * S)); }
    }
    return pngData(out, W, H);
  }
  const CRC_T = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  /** RGBA → data:image/png;base64 (zlib über CompressionStream('deflate'), gibt es im Browser und in Node ≥ 18) */
  async function pngData(rgba, w, h) {
    const raw = new Uint8Array((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
    const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const chunk = (type, data) => {
      const b = new Uint8Array(12 + data.length), dv = new DataView(b.buffer);
      dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i); b.set(data, 8);
      let c = 0xFFFFFFFF; for (let i = 4; i < 8 + data.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
      dv.setUint32(8 + data.length, (c ^ 0xFFFFFFFF) >>> 0); return b;
    };
    const ih = new Uint8Array(13), dv = new DataView(ih.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ih[8] = 8; ih[9] = 6;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
    let bin = ''; for (const p of parts) for (let i = 0; i < p.length; i += 0x8000) bin += String.fromCharCode.apply(null, p.subarray(i, i + 0x8000));
    return 'data:image/png;base64,' + btoa(bin);
  }
  /** Spalten des Plattenrasters wie Bambu Studio (lib_plate_cols). */
  const plateCols = n => { const v = Math.sqrt(n), r = Math.round(v); return Math.max(1, v > r ? r + 1 : r); };

  async function read3mf(z) {
    let xml = 0;
    for (const [k, e] of z.entries) if (k.toLowerCase().endsWith('.model')) xml += e.usize;
    if (xml > XML_LIMIT) throw new Error('too_complex');
    let main = '3D/3dmodel.model';
    const rels = await z.text('_rels/.rels'), rm = rels && /Target="\/?([^"]+\.model)"/i.exec(rels);
    if (rm) main = rm[1];
    const mainTxt = (await z.text(main)) || '';
    const um = /<model\b[^>]*\bunit="([a-z]+)"/i.exec(mainTxt.slice(0, 4096));
    const unit = um ? ({ micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[um[1].toLowerCase()] || 1) : 1;
    // Objekte (Extruder, Teile) und Platten
    const objs = {}, plates = [];
    const ms = await z.text('Metadata/model_settings.config');
    if (ms) {
      const doc = new DOMParser().parseFromString(ms, 'application/xml');
      const md = el => { const o = {}; for (const x of el.children) if (x.tagName === 'metadata') o[x.getAttribute('key')] = x.getAttribute('value'); return o; };
      const kids = (el, tag) => [...el.children].filter(x => x.tagName === tag);
      const root = doc.documentElement;
      if (root && root.tagName !== 'parsererror') {
        for (const o of kids(root, 'object')) {
          const om = md(o), parts = {};
          for (const pt of kids(o, 'part')) { const pm = md(pt); parts[pt.getAttribute('id')] = { sub: pt.getAttribute('subtype') || 'normal_part', ext: +(pm.extruder || 0) }; }
          objs[o.getAttribute('id')] = { ext: Math.max(1, +(om.extruder || 1)), parts, name: om.name || '' };
        }
        for (const pl of kids(root, 'plate')) {
          const pm = md(pl), ins = {};
          for (const mi of kids(pl, 'model_instance')) { const im = md(mi); if ((im.object_id || '') !== '') ins[im.object_id + '/' + (+(im.instance_id || 0))] = true; }
          plates.push({ name: String(pm.plater_name || '').slice(0, 60), ins });
        }
      }
    }
    // Bett und Farben
    let area = null, pal = [], lh = 0;
    const ps = await z.text('Metadata/project_settings.config');
    if (ps) { try { const cfg = JSON.parse(ps); area = cfg.printable_area || null; pal = [].concat(cfg.filament_colour || []); lh = +cfg.layer_height || 0; } catch (e) { /* kein JSON */ } }
    else {
      const pe = await z.text('Metadata/Slic3r_PE.config');
      if (pe) {
        const bm = /^; bed_shape = (.+)$/m.exec(pe); if (bm) area = bm[1].trim().split(',');
        const cm = /^; (?:extruder_colour|filament_colour) = (.+)$/m.exec(pe); if (cm) pal = cm[1].trim().split(';');
      }
    }
    let bed = null, bmin = [0, 0];
    const bx = [];
    for (const pt of [].concat(area || [])) { const am = /^\s*(-?[\d.]+)x(-?[\d.]+)\s*$/.exec(String(pt)); if (am) bx.push([+am[1], +am[2]]); }
    if (bx.length >= 3) {
      const xs = bx.map(b => b[0]), ys = bx.map(b => b[1]);
      bmin = [Math.min(...xs), Math.min(...ys)];
      const w = Math.max(...xs) - bmin[0], d = Math.max(...ys) - bmin[1];
      if (w >= 20 && d >= 20 && w <= 2000 && d <= 2000) bed = [Math.round(w * 10) / 10, Math.round(d * 10) / 10];
    }
    pal = (pal.length ? pal : [COLOR]).map(c => typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toLowerCase() : COLOR);
    // Farbwechsel nach Höhe (26.11.2026, HueForge-Bilder aus Bambu Studio: alles Filament 1, ab 1,3 mm Filament 2) — sonst zeigte die
    // Vorschau alles in der ersten Farbe. Wie der Slicer (ps_3mf_layer_toolchanges): je Platte <layer top_z type="2" extruder="N"/>,
    // nur Modus MultiAsSingle (sonst verwirft Orca die Wechsel)
    const ltc = layerChanges(await z.text('Metadata/custom_gcode_per_layer.xml'));

    const cache = {};
    const scan = async e => {
      e = String(e).replace(/^\//, '');
      if (!cache[e]) { const t = e === main ? mainTxt : await z.text(e); cache[e] = t ? scanModel(t, '/' + e) : { objects: {}, build: [] }; }
      return cache[e];
    };
    const build = (await scan(main)).build;
    if (!plates.length) plates.push({ name: '', ins: null });
    const cols = plateCols(plates.length), out = [];
    for (let pi = 0; pi < plates.length; pi++) {
      const pl = plates[pi], m = newMesh(), spans = [];
      let nobj = 0;
      for (const [oid, bm, inst] of build) {
        if (pl.ins && !pl.ins[oid + '/' + inst]) continue;
        nobj++;
        const t0 = m.n;
        const obj = objs[oid] || null;
        // Tiefensuche über Komponenten; Farbe = Extruder des Teils (1. Ebene) bzw. des Objekts; Modifier/Negativ-Teile/Stützen weg
        const walk = async (entry, id, mx, depth, ext) => {
          const o = (await scan(entry)).objects[id];
          if (!o || depth > 8 || o.type === 'support') return;
          if (o.mesh) meshAdd(m, o.mesh, mx, ext, pal.length);
          for (const [cpath, cid, cm] of o.components) {
            let e = ext;
            if (depth === 0 && obj) {
              const part = obj.parts[cid];
              if (part && part.sub !== 'normal_part') continue;
              if (part && part.ext > 0) e = part.ext;
            }
            await walk(cpath, cid, mMul(cm, mx), depth + 1, e);
          }
        };
        await walk(main, oid, bm, 0, obj ? obj.ext : 1);
        spans.push([t0, m.n]);
      }
      if (unit !== 1 && m.n) for (let i = 0; i < m.n * 9; i++) m.pos[i] *= unit;
      const ch = ltc[pl.ins ? pi + 1 : 1];
      if (ch) for (const [a, b] of spans) layerColor(m, a, b, ch, pal.length, lh);
      // Bambu-Raster: Platte i liegt bei (Spalte × Breite × 1,2, −Zeile × Tiefe × 1,2) — nur mit Platten aus model_settings
      let origin = bmin.slice();
      if (bed && pl.ins) origin = [bmin[0] + (pi % cols) * bed[0] * 1.2, bmin[1] - Math.floor(pi / cols) * bed[1] * 1.2];
      out.push({ name: pl.name, objs: nobj, mesh: m, origin, ...(ch && m.n ? { lc: true } : {}) });
    }
    return { bed, plates: out, pal };
  }

  // ── Packen (lib_pack + lib_cluster) ──
  function cluster(m, mn, cell) {
    const inv = 1 / cell, map = new Map(), verts = [], groups = new Map(), P = m.pos;
    let nv = 0, nt = 0;
    const ids = [0, 0, 0];
    for (let t = 0; t < m.n; t++) {
      const o = t * 9;
      for (let j = 0; j < 3; j++) {
        let qx = Math.floor((P[o + j * 3] - mn[0]) * inv + 0.5), qy = Math.floor((P[o + j * 3 + 1] - mn[1]) * inv + 0.5), qz = Math.floor((P[o + j * 3 + 2] - mn[2]) * inv + 0.5);
        if (qx > 65535) qx = 65535; if (qy > 65535) qy = 65535; if (qz > 65535) qz = 65535;
        if (qx < 0) qx = 0; if (qy < 0) qy = 0; if (qz < 0) qz = 0;
        const key = qx + qy * 65536 + qz * 4294967296;
        let id = map.get(key);
        if (id === undefined) { id = nv++; map.set(key, id); verts.push(qx, qy, qz); }
        ids[j] = id;
      }
      if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
      const g = m.col[t];
      let a = groups.get(g); if (!a) groups.set(g, a = []);
      a.push(ids[0], ids[1], ids[2]);
      nt++;
    }
    return { verts, groups, nv, nt };
  }
  async function pack(m, pal, bed, origin) {
    const P = m.pos, n = m.n, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], big = n > TRI_MAX;
    let area = 0;
    for (let i = 0; i < n * 9; i += 3) {
      for (let a = 0; a < 3; a++) { const v = P[i + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
    }
    if (big) for (let o = 0; o < n * 9; o += 9) {
      const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2], vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    if (!Number.isFinite(mn[0]) || !Number.isFinite(mx[0])) throw new Error('empty');
    const dims = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    // Lage auf dem Bett: Platten-Ursprung abziehen; liegt die Mitte nicht auf dem Bett → mittig setzen; ohne Bett ein Raster drumherum
    let virt = false;
    const sh = [-origin[0], -origin[1], -mn[2]];
    const cx = (mn[0] + mx[0]) / 2 + sh[0], cy = (mn[1] + mx[1]) / 2 + sh[1];
    if (!bed || cx < -0.25 * bed[0] || cx > 1.25 * bed[0] || cy < -0.25 * bed[1] || cy > 1.25 * bed[1]) {
      if (!bed) { const s = Math.max(100, Math.ceil((Math.max(dims[0], dims[1]) * 1.3 + 20) / 10) * 10); bed = [s, s]; virt = true; }
      sh[0] = bed[0] / 2 - (mn[0] + mx[0]) / 2; sh[1] = bed[1] / 2 - (mn[1] + mx[1]) / 2;
    }
    const lo = [mn[0] + sh[0], mn[1] + sh[1], 0];
    const ext = Math.max(dims[0], dims[1], dims[2], 1e-6);
    let cell = ext / 65535, dec = false, r;
    if (big && area > 0) { cell = Math.max(cell, Math.sqrt(area / (TRI_MAX * 0.85))); dec = true; }
    for (let pass = 0; pass < 5; pass++) {
      r = cluster(m, mn, cell);
      if (r.nt <= TRI_MAX || cell >= ext / 64) break;
      cell = Math.min(ext / 64, cell * Math.sqrt(r.nt / TRI_MAX) * 1.15);
      dec = true;
    }
    const keys = [...r.groups.keys()].sort((a, b) => a - b), gl = [];
    const idx = new Uint32Array(r.nt * 3);
    let o = 0;
    for (const c of keys) { const a = r.groups.get(c); gl.push({ c: pal[c] || COLOR, n: a.length / 3 }); idx.set(a, o); o += a.length; }
    let head = JSON.stringify({ min: lo.map(v => Math.round(v * 1e4) / 1e4), k: 1 / cell, nv: r.nv, nt: r.nt, groups: gl, bed, virt, dec });
    const enc = new TextEncoder();
    while ((enc.encode(head).length + 8) % 4) head += ' ';
    const hb = enc.encode(head), vb = new Uint8Array(new Uint16Array(r.verts).buffer), vpad = (4 - vb.length % 4) % 4;
    const bin = new Uint8Array(8 + hb.length + vb.length + vpad + idx.byteLength), dv = new DataView(bin.buffer);
    bin.set([76, 66, 77, 49], 0);   // LBM1
    dv.setUint32(4, hb.length, true);
    bin.set(hb, 8); bin.set(vb, 8 + hb.length); bin.set(new Uint8Array(idx.buffer), 8 + hb.length + vb.length + vpad);
    const gz = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    // cols (18.11.2026): Farben der Platte, nur bei mehreren — „Mehrfarbig“ in der Bibliothek (nicht im LBM1-Kopf, Website unverändert)
    return { gz, info: { tris: r.nt, src_tris: n, dec, dims: dims.map(v => Math.round(v * 10) / 10), bed, virt, ...(gl.length > 1 ? { cols: gl.map(g => g.c).slice(0, 8) } : {}) } };
  }

  window.AMPMesh = {
    async build(blob, ext) {
      let src;
      if (ext === 'stl') src = { bed: null, plates: [{ name: '', objs: 1, mesh: await readStl(blob), origin: [0, 0] }], pal: [COLOR] };
      else if (ext === '3mf') src = await read3mf(await zipOpen(blob));
      else throw new Error('type');
      const plates = [];
      for (let i = 0; i < src.plates.length; i++) {
        const p = src.plates[i], n = i + 1;
        if (!p.mesh.n) { plates.push({ n, name: p.name, objs: p.objs, tris: 0, empty: true }); continue; }
        // Farbwechsel nach Höhe: eigenes farbiges Vorschaubild (thumb, data-URL) statt des einfarbigen aus Bambu Studio (27.11.2026)
        const thumb = p.lc ? await thumbPng(p.mesh, src.pal).catch(() => null) : null;
        const r = await pack(p.mesh, src.pal, src.bed, p.origin);
        plates.push({ n, name: p.name, objs: p.objs, ...r.info, ...(p.lc ? { lc: true } : {}), gz: r.gz, ...(thumb ? { thumb } : {}) });
        src.plates[i].mesh = null;   // Speicher frei, bevor die nächste Platte gepackt wird
      }
      if (!plates.some(p => !p.empty)) throw new Error('empty');
      return { plates, bed: src.bed };
    },
    /** Fertig geslicte 3MF (.gcode.3mf aus Bambu Studio/OrcaSlicer, 24.11.2026)? Nur das Inhaltsverzeichnis lesen → schnell. */
    async isSliced(blob) { const z = await zipOpen(blob); return [...z.entries.keys()].some(k => /^Metadata\/plate_\d+\.gcode$/i.test(k)); },
    /** Text des G-Codes der ersten Platte (Metadata/plate_N.gcode) oder null, wenn keiner drin ist (dann ist es ein Modell-3MF). */
    async gcodeOf(blob) {
      const z = await zipOpen(blob);
      const ks = [...z.entries.keys()].filter(k => /^Metadata\/plate_\d+\.gcode$/i.test(k)).sort((x, y) => parseInt(x.replace(/\D+/g, ''), 10) - parseInt(y.replace(/\D+/g, ''), 10));
      if (!ks.length) return null;
      return z.entries.get(ks[0]).usize > 300 * 1048576 ? '' : ((await z.text(ks[0])) || '');
    },
    /** Bemalt? (24.11.2026, Vorschlag „Objekt für Objekt“ in amp-views ampSeqCheck): true, sobald ein Dreieck einer .model-Datei eine
     *  Farbe trägt (Bambu paint_color, Prusa mmu_segmentation, Zustand ≠ 0); null = zu groß zum Prüfen. Liest nur Text, baut kein Netz. */
    async painted(blob) {
      const z = await zipOpen(blob);
      const models = [...z.entries].filter(([k]) => k.toLowerCase().endsWith('.model'));
      if (models.reduce((a, [, e]) => a + e.usize, 0) > 150 * 1048576) return null;
      for (const [k] of models) {
        const t = await z.text(k); if (!t) continue;
        const re = /\b(?:paint_color|mmu_segmentation|slic3rpe:mmu_segmentation)="([0-9A-Fa-f]+)"/g;
        let m; while ((m = re.exec(t))) if (paintState(m[1])) return true;
      }
      return false;
    },
  };
})();
