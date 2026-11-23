/* 3DSEARCH Werkstatt — 3D-Vorschau der Bibliothek (25.10.2026). three.js r147 aus /js/gen/vendor (wie die Generatoren),
 * erst beim ersten Öffnen geladen. Datenformat LBM1 aus lib_pack() in library_lib.php: Ecken uint16 auf einem Raster
 * (Welt = min + q / k), Dreiecke uint32 nach Farbe gruppiert, Bett in mm. Z zeigt nach oben wie im Slicer.
 * Aufruf: const v = FMLibView(el, {bed: 'Bett'}); await v.load(url); v.view('top'); v.destroy(); */
(function () {
  'use strict';
  let three = null;
  function loadThree() {
    if (window.THREE && THREE.OrbitControls) return Promise.resolve();
    const add = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('three')); document.head.appendChild(s); });
    return three || (three = add('vendor/three.min.js').then(() => add('vendor/OrbitControls.js')).catch(e => { three = null; throw e; }));
  }
  // gz entpackt der Browser selbst (DecompressionStream); ältere Browser bekommen ?raw=1 vom Server entpackt
  async function fetchMesh(url) {
    const gz = typeof DecompressionStream === 'function';
    const r = await fetch(url + (gz ? '' : '&raw=1'), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('http_' + r.status);
    const buf = gz ? await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : await r.arrayBuffer();
    const dv = new DataView(buf);
    if (buf.byteLength < 8 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'LBM1') throw new Error('format');
    const hl = dv.getUint32(4, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
    let o = 8 + hl;
    const q = new Uint16Array(buf, o, head.nv * 3);
    o += head.nv * 6; o += (4 - o % 4) % 4;
    const idx = new Uint32Array(buf, o, head.nt * 3);
    return { head, q, idx };
  }

  window.FMLibView = function (root, opt) {
    opt = opt || {};
    let renderer = null, scene, camera, controls, model = null, bedGrp = null, ro = null, raf = 0, box = null, bedSize = null;
    const css = n => getComputedStyle(root).getPropertyValue(n).trim();
    function draw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (renderer) renderer.render(scene, camera); }); }
    function size() {
      if (!renderer) return;
      const w = root.clientWidth || 300, h = root.clientHeight || 300;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); draw();
    }
    function init() {
      const T = window.THREE;
      try { renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }); } catch (e) { throw new Error('webgl'); }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.className = 'lbcv';
      root.appendChild(renderer.domElement);
      scene = new T.Scene();
      camera = new T.PerspectiveCamera(35, 1, 0.5, 20000);
      camera.up.set(0, 0, 1);
      scene.add(new T.HemisphereLight(0xffffff, 0x555a66, 0.75));
      const sun = new T.DirectionalLight(0xffffff, 0.75); sun.position.set(-0.6, -1, 1.2);   // Licht wandert mit der Kamera
      camera.add(sun); scene.add(camera);
      controls = new T.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false; controls.screenSpacePanning = true; controls.zoomSpeed = 1.2;
      controls.addEventListener('change', draw);
      ro = new ResizeObserver(size); ro.observe(root);
    }
    // Druckbett: Fläche mit 10-mm-Raster und Rand; ohne bekanntes Bett (STL/OBJ) nur ein blasses Raster
    function makeBed(bed, virt) {
      const T = window.THREE, g = new T.Group(), [w, d] = bed;
      const lineCol = new T.Color(css('--line-2') || '#9aa4b2'), fill = new T.Color(css('--panel-2') || '#e8ecf2');
      if (!virt) {
        const pl = new T.Mesh(new T.PlaneGeometry(w, d), new T.MeshBasicMaterial({ color: fill, transparent: true, opacity: 0.9, depthWrite: false }));
        pl.position.set(w / 2, d / 2, -0.05); g.add(pl);
      }
      const pts = [];
      for (let x = 0; x <= w + 0.01; x += 10) pts.push(x, 0, 0, x, d, 0);
      for (let y = 0; y <= d + 0.01; y += 10) pts.push(0, y, 0, w, y, 0);
      const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      g.add(new T.LineSegments(geo, new T.LineBasicMaterial({ color: lineCol, transparent: true, opacity: virt ? 0.35 : 0.55 })));
      if (!virt) {
        const b = new T.BufferGeometry(); b.setAttribute('position', new T.Float32BufferAttribute([0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, 0], 3));
        g.add(new T.Line(b, new T.LineBasicMaterial({ color: new T.Color(css('--accent') || '#ff7a1a') })));
      }
      return g;
    }
    function dispose(o) {
      if (!o) return;
      o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) [].concat(c.material).forEach(m => m.dispose()); });
      scene.remove(o);
    }
    function view(kind) {
      if (!box || !camera) return;
      const T = window.THREE, c = box.getCenter(new T.Vector3()), s = box.getSize(new T.Vector3());
      const r = Math.max(s.x, s.y, s.z, 10) * 0.5 * Math.sqrt(3);
      const dist = r / Math.sin(camera.fov * Math.PI / 360) * 1.05;
      const dir = kind === 'top' ? new T.Vector3(0, -0.001, 1) : kind === 'front' ? new T.Vector3(0, -1, 0.15) : new T.Vector3(-0.55, -1, 0.75);
      camera.position.copy(c).add(dir.normalize().multiplyScalar(dist));
      camera.near = Math.max(0.1, dist / 200); camera.far = dist * 20 + Math.max(bedSize ? bedSize[0] + bedSize[1] : 0, 500) * 4; camera.updateProjectionMatrix();
      controls.target.copy(c); controls.update(); draw();
    }
    async function load(url) {
      await loadThree();
      if (!renderer) init();
      const { head, q, idx } = await fetchMesh(url);
      const T = window.THREE;
      dispose(model); dispose(bedGrp); model = null;
      const pos = new Float32Array(q.length), k = 1 / head.k, mn = head.min;
      for (let i = 0; i < q.length; i += 3) { pos[i] = mn[0] + q[i] * k; pos[i + 1] = mn[1] + q[i + 1] * k; pos[i + 2] = mn[2] + q[i + 2] * k; }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setIndex(new T.BufferAttribute(idx, 1));
      const mats = [];
      let start = 0;
      head.groups.forEach((g, i) => {
        geo.addGroup(start, g.n * 3, i); start += g.n * 3;
        mats.push(new T.MeshPhongMaterial({ color: new T.Color(g.c), flatShading: true, shininess: 18, specular: 0x1a1a1a, side: T.DoubleSide }));
      });
      geo.computeBoundingBox();
      model = new T.Mesh(geo, mats);
      scene.add(model);
      bedSize = head.bed;
      if (head.bed) { bedGrp = makeBed(head.bed, head.virt); scene.add(bedGrp); }
      box = geo.boundingBox.clone();
      size(); view('iso');
      return head;
    }
    function destroy() {
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (!renderer) return;
      dispose(model); dispose(bedGrp); controls.dispose(); renderer.dispose();
      try { renderer.forceContextLoss(); } catch (e) { /* alter Browser */ }   // Browser erlauben nur ~16 WebGL-Kontexte
      renderer.domElement.remove(); renderer = null;
    }
    return { load, view, destroy };
  };
})();
