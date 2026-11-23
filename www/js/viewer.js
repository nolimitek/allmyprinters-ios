/* 3DSEARCH Werkstatt — 3D-Vorschau des geslicten G-Codes (WebGL, instanzierte Quader je Strecke).
 * Übernommen aus print_send.php der Hauptseite (Stand 01.10.2026, dort bleibt sie bis zur Abgabe der Druckerseiten);
 * Datenformat: ps_preview_pack() in print_slice_lib.php ("PSV2"). Aufruf: FMViewer(root, S).load(url). */
window.FMViewer = function (root, S) {
  'use strict';
  var canvas = root.querySelector('canvas'), layerEl = root.querySelector('input[type=range]'), layerTxtEl = root.querySelector('[data-layer-txt]');
  var fmt = function (s) { var a = [].slice.call(arguments, 1), i = 0; return String(s).replace(/%(\d\$)?(0?\d)?[sd]/g, function (m, pos, pad) {
    var v = pos ? a[parseInt(pos) - 1] : a[i++]; v = String(v); if (pad && pad[0] === '0') while (v.length < +pad[1]) v = '0' + v; return v; }); };
  // ── Vorschau: WebGL, je Strecke ein instanzierter Quader (Oberseite + zwei Seiten) ──
  // Canvas 2D war bei großen Modellen unbenutzbar (Wespenfalle: 830.000 Strecken, Sekunden je Bild).
  // Gezeichnet wird nur bei Bewegung; der Schichtregler zeichnet nur die ersten N Instanzen.
  // 0–6 Linienarten, 7–15 Fachfarben eines Mehrfarbdrucks (Farbtabelle aus der Datei)
  var BASE = [[1, .55, 0], [1, .82, .25], [.75, .22, .17], [.61, .35, .96], [.13, .77, .37], [.08, .72, .65], [.61, .64, .69]], NCOL = 16, COLORS = BASE.concat(Array.apply(null, Array(NCOL - BASE.length)).map(function () { return [.5, .5, .5]; }));
  var cv = canvas, view = null, yaw = -0.6, pitch = 0.95, zoom = 1, maxL = 1, raf = 0;
  var gl = null, gl2 = false, ext = null, prog = null, lprog = null, sbuf = null, cbuf = null, bedBuf = null, bedCount = 0, boxBuf = null, boxIdx = null;
  var CORE = {1: true, 2: true}, CORE_LAYERS = 3;   // Innenwand + Füllung sieht man nur an der Schnittkante
  var LOD_MAX = 150000, lbuf = null, moving = false, moveT = 0, fillBuf = null, fillCount = 0, rimCount = 0, tintRGB = null, hasPal = false;   // beim Drehen/Zoomen nur jede k-te Schicht (dicker)
  try { gl = cv.getContext('webgl2', {antialias: true}); gl2 = !!gl; if (!gl) { gl = cv.getContext('webgl', {antialias: true}); ext = gl && gl.getExtension('ANGLE_instanced_arrays'); if (!ext) gl = null; } } catch (e) { gl = null; }

  function shader(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
  function program(vs, fs) { var p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; }
  if (gl) {
    prog = program(
      'attribute vec3 corner; attribute vec2 fn; attribute vec4 seg; attribute vec3 zh;' +
      'uniform mat4 mvp; uniform vec3 light; uniform vec3 colors[16]; uniform float width; uniform vec2 viewXY; varying vec3 vCol;' +
      'void main(){ vec2 d = seg.zw - seg.xy; float len = length(d); vec2 dir = len > 0.0001 ? d / len : vec2(1.0, 0.0); vec2 perp = vec2(-dir.y, dir.x);' +
      ' vec2 a = seg.xy - dir * width * 0.5; vec2 b = seg.zw + dir * width * 0.5;' +
      ' float sgn = dot(perp, viewXY) >= 0.0 ? 1.0 : -1.0; float v = fn.x != 0.0 ? corner.y * sgn : corner.y;' +
      ' vec3 pos = vec3(mix(a, b, corner.x) + perp * v * width, zh.x + corner.z * zh.y);' +
      ' vec3 n = normalize(vec3(perp * fn.x * sgn, fn.y)); int ci = int(zh.z + 0.5); vec3 c = colors[0];' +
      ' for (int i = 1; i < 16; i++) { if (i == ci) c = colors[i]; }' +
      ' vCol = c * (0.42 + 0.58 * max(dot(n, light), 0.0)); gl_Position = mvp * vec4(pos, 1.0); }',
      'precision mediump float; varying vec3 vCol; void main(){ gl_FragColor = vec4(vCol, 1.0); }');
    lprog = program('attribute vec3 pos; uniform mat4 mvp; void main(){ gl_Position = mvp * vec4(pos, 1.0); }',
      'precision mediump float; uniform vec4 col; void main(){ gl_FragColor = col; }');
    // Quader in lokalen Koordinaten: u (0/1 entlang), v (±0,5 quer), w (0 oben, −1 unten); Flächennormale (quer, hoch).
    // Nur Oberseite + EINE Seitenfläche: der Shader klappt sie auf die zur Kamera gewandte Seite (spart ein Drittel)
    var box = [], idx = [];
    [[[0, -.5, 0], [1, -.5, 0], [1, .5, 0], [0, .5, 0], 0, 1], [[0, .5, 0], [1, .5, 0], [1, .5, -1], [0, .5, -1], 1, 0]]
      .forEach(function (f, fi) { for (var i = 0; i < 4; i++) box.push(f[i][0], f[i][1], f[i][2], f[4], f[5]); idx.push(fi * 4, fi * 4 + 1, fi * 4 + 2, fi * 4, fi * 4 + 2, fi * 4 + 3); });
    boxBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, boxBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(box), gl.STATIC_DRAW);
    boxIdx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  }
  function divisor(loc, d) { if (gl2) gl.vertexAttribDivisor(loc, d); else ext.vertexAttribDivisorANGLE(loc, d); }

  /** Binärformat aus ps_preview_pack() lesen → Instanzdaten (x0, y0, x1, y1, z, h, kat) je Strecke, getrennt in
   *  Hülle (immer gezeichnet) und Kern (Innenwand/Füllung, nur die obersten CORE_LAYERS Schichten am Regler) */
  function parse(buf) {
    var dv = new DataView(buf), o = 4;
    var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'PSV2' && magic !== 'PSV3') throw new Error('format');
    var f = function () { var v = dv.getFloat32(o, true); o += 4; return v; }, u = function () { var v = dv.getUint32(o, true); o += 4; return v; };
    var ox = f(), oy = f(), height = f(), nb = u(), bed = [];
    for (var i = 0; i < nb; i++) bed.push([f(), f()]);
    // PSV3: Fachfarben. Sehr dunkle Spulen leicht aufhellen, sonst verschwinden sie im Schatten
    var pal = [];
    if (magic === 'PSV3') { var nc = dv.getUint8(o); o += 1; for (i = 0; i < nc; i++, o += 3) pal.push([0, 1, 2].map(function (j) { return 0.1 + 0.9 * dv.getUint8(o + j) / 255; })); }
    hasPal = pal.length > 0;
    COLORS = BASE.concat(pal.slice(0, NCOL - BASE.length));
    while (COLORS.length < NCOL) COLORS.push([.5, .5, .5]);
    var nl = u(), ns = u(), inst = new Float32Array(ns * 7), core = new Float32Array(ns * 7), ends = new Uint32Array(nl), cends = new Uint32Array(nl), zs = new Float32Array(nl), k = 0, kc = 0, prevZ = 0;
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (var l = 0; l < nl; l++) {
      var z = f(), np = u(), h = Math.max(0.08, Math.min(0.4, l ? z - prevZ : z));
      prevZ = z; zs[l] = z;
      for (var p = 0; p < np; p++) {
        var cb = dv.getUint8(o), cat = cb & 7, fi = cb >> 3, col = fi && fi <= NCOL - BASE.length ? BASE.length - 1 + fi : cat; o += 1;
        var n = u(), x = dv.getInt16(o, true), y = dv.getInt16(o + 2, true); o += 4;
        for (var q = 1; q < n; q++) {
          var nx = x + dv.getInt16(o, true), ny = y + dv.getInt16(o + 2, true); o += 4;
          var isCore = CORE[cat], arr = isCore ? core : inst, b = (isCore ? kc++ : k++) * 7, ax = x / 10 + ox, ay = y / 10 + oy, bx = nx / 10 + ox, by = ny / 10 + oy;
          arr[b] = ax; arr[b + 1] = ay; arr[b + 2] = bx; arr[b + 3] = by; arr[b + 4] = z; arr[b + 5] = h; arr[b + 6] = col;
          if (ax < x0) x0 = ax; if (ax > x1) x1 = ax; if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
          x = nx; y = ny;
        }
      }
      ends[l] = k; cends[l] = kc;
    }
    if (x0 > x1) { x0 = y0 = 0; x1 = y1 = 100; }
    // Grobe Stufe fürs Drehen: jede k-te Schicht der Hülle, Schichthöhe auf den Abstand gestreckt (wirkt geschlossen)
    var step = Math.max(1, Math.ceil(k / LOD_MAX)), lod = inst, lends = ends;
    if (step > 1) {
      lod = new Float32Array(Math.ceil(k / step * 1.5) * 7 + 70); lends = new Uint32Array(nl);
      var m = 0;
      for (l = 0; l < nl; l++) {
        if (l % step === step - 1 || l === nl - 1) {
          var from = l ? ends[l - 1] : 0, hh = Math.min(2, zs[l] - (l >= step ? zs[l - step] : 0)) || 0.2;
          if (m + (ends[l] - from) * 7 > lod.length) { var bigger = new Float32Array(lod.length * 2); bigger.set(lod); lod = bigger; }
          for (var t = from; t < ends[l]; t++) { lod.set(inst.subarray(t * 7, t * 7 + 7), m); lod[m + 5] = hh; m += 7; }
        }
        lends[l] = m / 7;
      }
      lod = lod.subarray(0, m);
    }
    var top = nl ? zs[nl - 1] : 0;
    // Ausschnitt zum Start: das ganze Druckbett, Modell an seiner echten Stelle (18.11.2026, User: „Dimension besser einschätzen“) —
    // vorher nur das Modell, bei kleinen Teilen lag das Bett ganz außerhalb des Bildes. Hineinzoomen wie bisher mit +/− und Mausrad.
    var bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    bed.forEach(function (p) { bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); by0 = Math.min(by0, p[1]); by1 = Math.max(by1, p[1]); });
    var hasBed = bed.length >= 3 && bx1 > bx0 && by1 > by0;
    return {bed: bed, lod: lod, lends: lends, inst: inst.subarray(0, k * 7), core: core.subarray(0, kc * 7), ends: ends, cends: cends, zs: zs,
      cx: hasBed ? (bx0 + bx1) / 2 : (x0 + x1) / 2, cy: hasBed ? (by0 + by1) / 2 : (y0 + y1) / 2, cz: top / 2,
      ext: Math.max(20, (x1 - x0) / 2, (y1 - y0) / 2, top * 0.6, hasBed ? Math.hypot(bx1 - bx0, by1 - by0) / 2 : 0)};   // Diagonale: das Bett steht schräg im Bild
  }

  function loadPreview(url) {
    view = null; draw();
    if (!gl) { layerTxtEl.textContent = S.psd_nogl; return; }
    fetch(url, {credentials: 'same-origin', headers: window.FM && FM.tok ? {Authorization: 'Bearer ' + FM.tok} : {}}).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      view = parse(buf);
      sbuf = sbuf || gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, sbuf); gl.bufferData(gl.ARRAY_BUFFER, view.inst, gl.STATIC_DRAW);
      cbuf = cbuf || gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cbuf); gl.bufferData(gl.ARRAY_BUFFER, view.core, gl.STATIC_DRAW);
      lbuf = lbuf || gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, lbuf); gl.bufferData(gl.ARRAY_BUFFER, view.lod, gl.STATIC_DRAW);
      view.inst = view.core = view.lod = null;   // liegt jetzt auf der Grafikkarte
      // Druckbett: Fläche (getönt), Umriss, 25-mm-Raster. Vorher nur dünne Linien mit 45 % — auf hellem Grund kaum zu sehen,
      // die Größe des Modells auf dem Bett ließ sich nicht einschätzen (User 18.11.2026).
      var v = [], bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9, fv = [];
      view.bed.forEach(function (p, i) { var q = view.bed[(i + 1) % view.bed.length]; v.push(p[0], p[1], 0, q[0], q[1], 0);
        bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); by0 = Math.min(by0, p[1]); by1 = Math.max(by1, p[1]); });
      rimCount = v.length / 3;
      // Fläche als Fächer aus dem (konvexen) Bettumriss, knapp unter z = 0, damit die erste Schicht darüber liegt
      for (var t = 1; t + 1 < view.bed.length; t++) [view.bed[0], view.bed[t], view.bed[t + 1]].forEach(function (p) { fv.push(p[0], p[1], -0.05); });
      fillBuf = fillBuf || gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, fillBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fv), gl.STATIC_DRAW); fillCount = fv.length / 3;
      for (var g = Math.ceil(bx0 / 25) * 25; g < bx1; g += 25) v.push(g, by0, 0, g, by1, 0);
      for (g = Math.ceil(by0 / 25) * 25; g < by1; g += 25) v.push(bx0, g, 0, bx1, g, 0);
      bedBuf = bedBuf || gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bedBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW); bedCount = v.length / 3;
      maxL = view.ends.length; zoom = 1;
      layerEl.max = maxL; layerEl.value = maxL; layerTxt(); draw();
    }).catch(function (e) { layerTxtEl.textContent = fmt(S.psd_err_generic, e.message); });
  }
  function layerTxt() { var n = +layerEl.value; layerTxtEl.textContent = fmt(S.psd_layer, n, maxL) + (view && view.zs[n - 1] != null ? ' · ' + view.zs[n - 1].toFixed(2) + ' mm' : ''); }
  layerEl.addEventListener('input', function () { layerTxt(); draw(); });

  function draw() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; render(); }); }
  // Hell oder dunkel: am Hintergrund der Vorschau (Leinwand selbst ist durchsichtig) — Bettfarbe danach
  function bedDark() {
    for (var el = cv.parentElement; el; el = el.parentElement) {
      var m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(el).backgroundColor || '');
      if (m && (m[4] === undefined || +m[4] > 0.5)) return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 110;
    }
    return false;
  }
  function render() {
    if (!gl) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    gl.viewport(0, 0, cv.width, cv.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!view) return;
    // Orthografische Kamera: Drehung um z (yaw), Neigung (pitch); Zeilen der MVP-Matrix, unten spaltenweise abgelegt.
    // Welt-Y geht gespiegelt ein (Spalte y negiert, Mitte −cy): die Achsen bildeten sonst ein linkshändiges System und
    // die Vorschau zeigte alles spiegelverkehrt — Schriftzug „Hietzi“ des Anhänger-Generators (09.10.2026). So steht
    // die Kamera vorne (−Y) und sieht das Bett wie am Drucker.
    var s = Math.min(w, h) / (view.ext * 2.4) * zoom, kx = 2 * s / w, ky = 2 * s / h, kz = 1 / (view.ext * 6);
    var cY = Math.cos(yaw), sY = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cx = view.cx, cy = -view.cy, cz = view.cz;
    var r0 = [kx * cY, kx * sY, 0, -kx * (cY * cx - sY * cy)];
    var r1 = [-ky * cp * sY, ky * cp * cY, ky * sp, ky * (cp * (sY * cx + cY * cy) - sp * cz) - 0.12];
    var r2 = [-kz * sp * sY, kz * sp * cY, -kz * cp, kz * (sp * (sY * cx + cY * cy) + cp * cz)];
    var mvp = new Float32Array([r0[0], r1[0], r2[0], 0, r0[1], r1[1], r2[1], 0, r0[2], r1[2], r2[2], 0, r0[3], r1[3], r2[3], 1]);
    // Licht kommt von links oben aus Richtung Betrachter (in Weltkoordinaten umgerechnet)
    var X = [cY, sY, 0], Y = [-cp * sY, cp * cY, sp], Z = [sp * sY, -sp * cY, cp], lt = [0, 0, 0];
    for (var i = 0; i < 3; i++) lt[i] = -0.35 * X[i] + 0.55 * Y[i] + 0.75 * Z[i];
    var ll = Math.hypot(lt[0], lt[1], lt[2]); lt = lt.map(function (c) { return c / ll; });
    gl.enable(gl.DEPTH_TEST);
    // Bett
    gl.useProgram(lprog);
    var lp = gl.getAttribLocation(lprog, 'pos');
    var cu = gl.getUniformLocation(lprog, 'col'), dk = bedDark(), bc = dk ? [1, 1, 1] : [0.1, 0.22, 0.26];
    gl.uniformMatrix4fv(gl.getUniformLocation(lprog, 'mvp'), false, mvp);
    // Deckkraft getrennt mischen: die Leinwand ist durchsichtig und vormultipliert — mit blendFunc allein wurden halbdurchsichtige
    // Linien/Flächen heller statt dunkler und fast unsichtbar (Grund für das blasse Bett bis 18.11.2026)
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);   // Fläche und Linien verdecken nichts
    if (fillCount) {
      gl.bindBuffer(gl.ARRAY_BUFFER, fillBuf); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0); divisor(lp, 0);
      gl.uniform4f(cu, bc[0], bc[1], bc[2], dk ? 0.07 : 0.09); gl.drawArrays(gl.TRIANGLES, 0, fillCount);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bedBuf); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0); divisor(lp, 0);
    gl.uniform4f(cu, bc[0], bc[1], bc[2], dk ? 0.18 : 0.22); gl.drawArrays(gl.LINES, rimCount, bedCount - rimCount);   // Raster
    gl.uniform4f(cu, bc[0], bc[1], bc[2], dk ? 0.6 : 0.7); gl.drawArrays(gl.LINES, 0, rimCount);                        // Umriss
    gl.depthMask(true);
    gl.disableVertexAttribArray(lp); gl.disable(gl.BLEND);
    // Strecken
    var L1 = (+layerEl.value || 1) - 1, n = view.ends[L1], c0 = L1 >= CORE_LAYERS ? view.cends[L1 - CORE_LAYERS] : 0, c1 = view.cends[L1];
    gl.useProgram(prog);
    var aC = gl.getAttribLocation(prog, 'corner'), aF = gl.getAttribLocation(prog, 'fn'), aS = gl.getAttribLocation(prog, 'seg'), aZ = gl.getAttribLocation(prog, 'zh');
    gl.bindBuffer(gl.ARRAY_BUFFER, boxBuf);
    gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 3, gl.FLOAT, false, 20, 0); divisor(aC, 0);
    gl.enableVertexAttribArray(aF); gl.vertexAttribPointer(aF, 2, gl.FLOAT, false, 20, 12); divisor(aF, 0);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'mvp'), false, mvp);
    gl.uniform3fv(gl.getUniformLocation(prog, 'light'), lt);
    gl.uniform3fv(gl.getUniformLocation(prog, 'colors'), new Float32Array([].concat.apply([], colorsNow())));
    gl.uniform1f(gl.getUniformLocation(prog, 'width'), 0.45);
    gl.uniform2f(gl.getUniformLocation(prog, 'viewXY'), sY, -cY);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIdx);
    // Instanzbereich [from, to) eines Puffers zeichnen; WebGL kennt kein baseInstance → Zeiger versetzen
    function range(buf, from, to) {
      if (to <= from) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aS); gl.vertexAttribPointer(aS, 4, gl.FLOAT, false, 28, from * 28); divisor(aS, 1);
      gl.enableVertexAttribArray(aZ); gl.vertexAttribPointer(aZ, 3, gl.FLOAT, false, 28, from * 28 + 16); divisor(aZ, 1);
      if (gl2) gl.drawElementsInstanced(gl.TRIANGLES, 12, gl.UNSIGNED_SHORT, 0, to - from); else ext.drawElementsInstancedANGLE(gl.TRIANGLES, 12, gl.UNSIGNED_SHORT, 0, to - from);
    }
    if (moving) { range(lbuf, 0, view.lends[L1]); }
    else { range(sbuf, 0, n); range(cbuf, c0, c1); }
    divisor(aS, 0); divisor(aZ, 0);
    [aC, aF, aS, aZ].forEach(function (a) { gl.disableVertexAttribArray(a); });
  }
  // Drehen (Maus/Finger), Zoomen (Rad, Knöpfe)
  var drag = null;
  function settle() { clearTimeout(moveT); moveT = setTimeout(function () { moving = false; draw(); }, 180); }
  cv.addEventListener('pointerdown', function (e) { drag = [e.clientX, e.clientY, yaw, pitch]; moving = true; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', function (e) {
    if (!drag) return;
    yaw = drag[2] - (e.clientX - drag[0]) * 0.01;   // vordere Seite folgt dem Finger (seit der Spiegel-Korrektur)
    pitch = Math.max(0.05, Math.min(1.55, drag[3] + (e.clientY - drag[1]) * 0.01));
    draw();
  });
  cv.addEventListener('pointerup', function () { drag = null; settle(); });
  cv.addEventListener('pointercancel', function () { drag = null; settle(); });
  cv.addEventListener('wheel', function (e) { e.preventDefault(); moving = true; settle(); zoom = Math.max(0.3, Math.min(20, zoom * (e.deltaY < 0 ? 1.12 : 0.89))); draw(); }, {passive: false});
  root.querySelectorAll('[data-z]').forEach(function (b) { b.addEventListener('click', function () { zoom = Math.max(0.3, Math.min(20, zoom * +b.dataset.z)); draw(); }); });
  window.addEventListener('resize', draw);
  // Filamentfarbe (18.11.2026, AllMyPrinters): einfarbiger Druck in der Farbe des gewählten Fachs statt nach Linienart. Die Arten bleiben
  // leicht unterscheidbar (innen/Füllung dunkler, Stützen ausgegraut, Rand heller). Mehrfarbige Vorschauen (Farbtabelle im PSV3) bleiben.
  function colorsNow() {
    if (!tintRGB || hasPal) return COLORS;
    var c = tintRGB, mix = function (a, b, k) { return [0, 1, 2].map(function (i) { return a[i] * (1 - k) + b[i] * k; }); };
    var t = [c, mix(c, [0, 0, 0], 0.15), mix(c, [0, 0, 0], 0.3), c, mix(c, [.6, .62, .65], 0.6), mix(c, [1, 1, 1], 0.35), [.61, .64, .69]];
    return t.concat(COLORS.slice(t.length));
  }
  function tint(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    // ganz dunkle Farben (Schwarz) etwas aufhellen, ganz helle (Weiß) etwas abdunkeln, sonst sieht man keine Schichten mehr
    tintRGB = m ? [1, 2, 3].map(function (i) { return Math.min(0.86, Math.max(0.12, parseInt(m[i], 16) / 255)); }) : null;   // Weiß leicht grau: Schatten bleiben sichtbar
    draw();
  }
  return { load: loadPreview, tint: tint };
};
