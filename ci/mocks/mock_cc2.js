/* Elegoo-Centauri-Carbon-2-Nachbau (Verhalten laut elegoo-link-SDK, HA-Integration und pycentauri, Firmware 02.01):
 *  - MQTT 3.1.1 ohne TLS: Benutzer „elegoo“, Passwort = Zugangscode (ohne Code: 123456 oder leer), sonst CONNACK 5
 *  - Anmeldung: elegoo/<sn>/api_register {client_id, request_id} → elegoo/<sn>/<request_id>/register_response {error:"ok"}
 *  - Befehle nur von angemeldeten Clients: elegoo/<sn>/<cid>/api_request {id, method, params} → …/api_response
 *  - Status: 1002 voll, danach Deltas {id, method:6000, result} auf elegoo/<sn>/api_status; PING → PONG
 *  - Upload: PUT /upload, Content-Range, X-File-Name/-MD5/-Token; jedes Stück auf neuer TCP-Verbindung → ab dem 4. Stück 429
 *  - Kamera: MJPEG auf jedem Pfad; Suche: UDP {"id":0,"method":7000} → {id:0, result:{host_name, machine_model, sn, token_status, lan_status}}
 * Einblick/Steuerung: POST /__cc auf dem HTTP-Port. */
'use strict';
const net = require('net'), http = require('http'), crypto = require('crypto'), dgram = require('dgram');

function cc2(o) {   // o: { sn, code, mqttPort, httpPort, camPort, udpPort, mjpeg(res) }
  const SN = o.sn, CODE = o.code || '';
  const C = { clients: new Map(), registered: new Set(), files: {}, start: null, lastReq: null, timer: null, statusId: 0, cmds: [] };
  const S = {
    machine_status: { status: 1, sub_status: 0, sub_status_reason_code: 0, exception_status: [], progress: 0 },
    print_status: { filename: '', uuid: '', current_layer: 0, total_layer: 0, print_duration: 0, total_duration: 0, remaining_time_sec: 0, state: 'standby' },
    extruder: { temperature: 26, target: 0, filament_detect_enable: 1, filament_detected: 1 },
    heater_bed: { temperature: 24, target: 0 }, ztemperature_sensor: { temperature: 25 },
    fans: { fan: { speed: 0, rpm: 0 }, aux_fan: { speed: 0, rpm: 0 }, box_fan: { speed: 64, rpm: 900 } }, led: { status: 1 }, gcode_move_inf: { speed: 0, speed_mode: 1 }, external_device: { camera: true, u_disk: false, type: '0303' },
  };
  const canvas = { active_canvas_id: 0, active_tray_id: -1, auto_refill: false, canvas_list: [{ canvas_id: 0, connected: 1, tray_list: [
    { tray_id: 0, brand: 'ELEGOO', filament_type: 'PLA', filament_name: 'PLA', filament_color: '#F32FF8', status: 1 },
    { tray_id: 1, brand: 'ELEGOO', filament_type: 'PETG', filament_name: 'PETG', filament_color: '#202020', status: 1 },
    { tray_id: 2, brand: '', filament_type: '', filament_name: '', filament_color: '#000000', status: 0 },
    { tray_id: 3, brand: 'ELEGOO', filament_type: 'PLA', filament_name: 'PLA Silk', filament_color: '#FFD700', status: 1 }] }] };
  const attrs = { hostname: 'Centauri Carbon 2', machine_model: 'Centauri Carbon 2', sn: SN, software_version: { ota_version: '02.01.01.07' } };
  const merge = (d, s) => { for (const [k, v] of Object.entries(s)) { if (v && typeof v === 'object' && !Array.isArray(v) && d[k] && typeof d[k] === 'object') merge(d[k], v); else d[k] = v; } };

  // ── MQTT-Broker ──
  const str = s => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
  const pkt = (type, body) => { const len = []; let n = body.length; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0); return Buffer.concat([Buffer.from([type, ...len]), body]); };
  const match = (f, t) => { const a = f.split('/'), b = t.split('/'); for (let i = 0; i < a.length; i++) { if (a[i] === '#') return true; if (a[i] !== '+' && a[i] !== b[i]) return false; } return a.length === b.length; };
  const publish = (topic, obj) => {
    const b = pkt(0x30, Buffer.concat([str(topic), Buffer.from(JSON.stringify(obj))]));
    for (const [sock, cl] of C.clients) if ([...cl.subs].some(f => match(f, topic))) try { sock.write(b); } catch (e) {}
  };
  const push = delta => { merge(S, delta); publish(`elegoo/${SN}/api_status`, { id: ++C.statusId, method: 6000, result: delta }); };
  const broker = net.createServer(sock => {
    let buf = Buffer.alloc(0); const cl = { cid: '', subs: new Set(), ok: false };
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = 0, mul = 1, i = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
        if (buf.length < i + len) return;
        const t = buf[0], body = buf.slice(i, i + len); buf = buf.slice(i + len);
        onPacket(sock, cl, t, body);
      }
    });
    sock.on('error', () => {}); sock.on('close', () => C.clients.delete(sock));
  });
  function onPacket(sock, cl, t, b) {
    const type = t >> 4;
    if (type === 1) {   // CONNECT: Protokollname, Level, Flags, Keepalive, Client-ID, (Will), Benutzer, Passwort
      let p = 0; const rd = () => { const n = b.readUInt16BE(p); const s = b.slice(p + 2, p + 2 + n).toString(); p += 2 + n; return s; };
      rd(); p += 1; const flags = b[p]; p += 3;
      cl.cid = rd();
      if (flags & 0x04) { rd(); rd(); }
      const user = flags & 0x80 ? rd() : '', pass = flags & 0x40 ? rd() : '';
      const okPass = CODE ? pass === CODE : (pass === '123456' || pass === '');
      if (user !== 'elegoo' || !okPass) { sock.write(Buffer.from([0x20, 2, 0, 5])); sock.end(); return; }
      cl.ok = true; C.clients.set(sock, cl); sock.write(Buffer.from([0x20, 2, 0, 0])); return;
    }
    if (!cl.ok) { sock.destroy(); return; }
    if (type === 8) {   // SUBSCRIBE → SUBACK (QoS 0)
      const id = b.readUInt16BE(0); let p = 2; const q = [];
      while (p < b.length) { const n = b.readUInt16BE(p); cl.subs.add(b.slice(p + 2, p + 2 + n).toString()); p += 3 + n; q.push(0); }
      sock.write(pkt(0x90, Buffer.from([id >> 8, id & 255, ...q]))); return;
    }
    if (type === 12) { sock.write(Buffer.from([0xD0, 0])); return; }
    if (type === 14) { sock.end(); return; }
    if (type === 3) {
      const n = b.readUInt16BE(0), topic = b.slice(2, 2 + n).toString(); let off = 2 + n;
      if ((t >> 1) & 3) { sock.write(Buffer.from([0x40, 2, b[off], b[off + 1]])); off += 2; }
      let msg; try { msg = JSON.parse(b.slice(off).toString()); } catch (e) { return; }
      onMessage(topic, msg);
    }
  }
  function onMessage(topic, msg) {
    if (topic === `elegoo/${SN}/api_register`) {
      const ok = C.registered.has(msg.client_id) || C.registered.size < (o.maxClients || 4);
      if (ok) C.registered.add(msg.client_id);
      publish(`elegoo/${SN}/${msg.request_id}/register_response`, { client_id: msg.client_id, error: ok ? 'ok' : 'too many clients' });
      return;
    }
    const m = new RegExp(`^elegoo/${SN}/([^/]+)/api_request$`).exec(topic); if (!m) return;
    const cid = m[1]; if (!C.registered.has(cid)) return;   // nicht angemeldet: Drucker schweigt
    const out = `elegoo/${SN}/${cid}/api_response`;
    if (msg.type === 'PING') { publish(out, { type: 'PONG' }); return; }
    C.lastReq = msg; C.cmds.push(msg.method);
    const reply = r => publish(out, { id: msg.id, method: msg.method, result: { error_code: 0, ...r } });
    const later = (ms, r) => setTimeout(() => reply(r), ms);   // Druckbefehle antworten erst nach dem mechanischen Ablauf
    switch (msg.method) {
      case 1001: return reply(attrs);
      case 1002: return reply(JSON.parse(JSON.stringify(S)));
      case 2005: return reply({ canvas_info: canvas });
      // Wie der SimplyPrint Client (beobachtet 16.11.2026): 1046 = Datei auf dem Drucker abfragen (vor dem Start), 2003 = Fachbelegung setzen
      case 1046: { const fn = String((msg.params || {}).filename || ''); C.fileAsk = fn; return reply(C.files[fn] && C.files[fn].done ? { error_code: 0, filename: fn } : { error_code: 1021 }); }
      case 2003: {
        const q = msg.params || {}; (C.trayset || (C.trayset = [])).push(q);
        const cv = canvas.canvas_list.find(x => +x.canvas_id === +q.canvas_id), t = cv && cv.tray_list.find(x => +x.tray_id === +q.tray_id);
        if (!t) return reply({ error_code: 1003 });
        Object.assign(t, { brand: q.brand, filament_type: q.filament_type, filament_name: q.filament_name, filament_color: q.filament_color, filament_code: q.filament_code, status: 1 });
        return reply({ error_code: 0 });
      }
      // 1029 Licht {power}, 1030 Lüfter {fan|aux_fan|box_fan: 0–255} (elegoo-homeassistant CC2_PROTOCOL.md)
      // 1031 Geschwindigkeit {mode: 0 leise … 3 Ludicrous} → gcode_move_inf.speed_mode (CC2_PROTOCOL.md)
      case 1031: (C.spd || (C.spd = [])).push(+(msg.params || {}).mode); push({ gcode_move_inf: { speed_mode: +(msg.params || {}).mode } }); return reply({ error_code: 0 });
      case 1029: push({ led: { status: +(msg.params || {}).power ? 1 : 0 } }); return reply({ error_code: 0 });
      case 1030: { const d = {}; for (const [k, v] of Object.entries(msg.params || {})) if (S.fans[k]) d[k] = { speed: +v }; push({ fans: d }); return reply({ error_code: 0 }); }
      case 1042: return reply({ url: `http://127.0.0.1:${o.camPort}/?action=stream` });
      case 1020: return start(msg.params || {}, reply);
      case 1021: push({ machine_status: { sub_status: 2502 }, print_status: { state: 'paused' } }); return later(800, {});
      case 1023: push({ machine_status: { sub_status: 2075 }, print_status: { state: 'printing' } }); return later(800, {});
      case 1022: clearInterval(C.timer); push({ machine_status: { status: 2, sub_status: 2504 }, print_status: { state: 'cancelled' } });
        setTimeout(() => push({ machine_status: { status: 1, sub_status: 0 } }), 1500); return later(800, {});
      default: return reply({ error_code: 1001 });
    }
  }
  function start(p, reply) {
    const fn = String(p.filename || '');
    if (S.print_status.state === 'printing' || S.print_status.state === 'paused') return reply({ error_code: 1009 });
    if (!C.files[fn] || !C.files[fn].done) return reply({ error_code: 1021 });
    (C.starts = C.starts || []).push(JSON.parse(JSON.stringify(p.config || {})));
    // kein gespeichertes Bett-Netz (neuer Drucker): 1026, bis einmal mit bedlevel_force gestartet wurde
    if (C.noMesh && !(p.config || {}).bedlevel_force) return reply({ error_code: 1026 });
    if ((p.config || {}).bedlevel_force) C.noMesh = false;
    C.start = p;
    push({ machine_status: { status: 2, sub_status: 1045, progress: 0 }, print_status: { filename: fn, uuid: crypto.randomUUID(), state: 'printing', current_layer: 0, total_layer: 40,
      print_duration: 0, remaining_time_sec: 600 }, extruder: { target: 220 } });
    canvas.active_tray_id = ((p.config || {}).slot_map || [])[0] ? p.config.slot_map[0].tray_id : 0;
    setTimeout(() => reply({}), o.startDelay || 1500);
    clearInterval(C.timer);
    C.timer = setInterval(() => {
      if (S.print_status.state !== 'printing') return;
      const pr = Math.min(100, S.machine_status.progress + (o.step || 10)), done = pr >= 100;
      push({ machine_status: { sub_status: done ? 2077 : 2075, progress: pr }, print_status: { state: done ? 'complete' : 'printing', current_layer: Math.round(pr * 0.4),
        print_duration: S.print_status.print_duration + 1, remaining_time_sec: Math.round((100 - pr) * 6) }, extruder: { temperature: done ? 40 : 220 } });
      if (done) { clearInterval(C.timer); canvas.active_tray_id = -1; setTimeout(() => push({ machine_status: { status: 1, sub_status: 0 } }), 1500); }
    }, o.tick || 1000);
  }

  // ── HTTP: Upload + Einblick ──
  const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), body = [];
    req.on('data', c => body.push(c)); req.on('end', () => {
      const b = Buffer.concat(body);
      const json = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/__cc') {
        const a = JSON.parse(b.toString() || '{}');
        if (a.step) o.step = a.step;
        if (a.noMesh !== undefined) C.noMesh = !!a.noMesh;
        if (a.clearStarts) C.starts = [];
        return json(200, { files: Object.fromEntries(Object.entries(C.files).map(([k, v]) => [k, { got: v.got, done: v.done, chunks: v.chunks, conns: v.socks.size, err: v.err || null }])),
          start: C.start, last: C.lastReq, cmds: C.cmds, fileAsk: C.fileAsk || null, starts: C.starts || [], trayset: C.trayset || [], canvas, fans: S.fans, led: S.led, spd: C.spd || [], speedMode: S.gcode_move_inf.speed_mode, state: S.print_status.state, status: S.machine_status, registered: [...C.registered] });
      }
      if (req.method === 'PUT' && u.pathname === '/upload') {
        if (req.headers['x-token'] !== (CODE || '123456')) return json(401, { error_code: 1000 });
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] || ''), name = req.headers['x-file-name'], md5 = String(req.headers['x-file-md5'] || '');
        if (!m || !name || !md5) return json(400, { error_code: 1003 });
        const s = +m[1], e = +m[2], tot = +m[3];
        if (s === 0 || !C.files[name] || C.files[name].md5 !== md5) C.files[name] = { md5, buf: Buffer.alloc(tot), got: 0, socks: new Set(), chunks: 0, done: false };
        const f = C.files[name];
        f.socks.add(req.socket); f.chunks++;
        if (f.chunks >= 4 && f.socks.size >= 4) { f.err = 429; return json(429, { error_code: 1009 }); }   // neue Verbindung je Stück (HA, Firmware 02.01)
        if (s !== f.got || e - s + 1 !== b.length) { f.err = 9000; return json(200, { error_code: 9000 }); }
        b.copy(f.buf, s); f.got = e + 1;
        if (f.got === tot) {
          if (crypto.createHash('md5').update(f.buf).digest('hex') !== md5.toLowerCase()) { f.err = 9004; return json(200, { error_code: 9004 }); }
          f.done = true;
        }
        return json(200, { error_code: 0, offset: f.got });
      }
      res.writeHead(404); res.end();
    });
  });
  web.keepAliveTimeout = 10000;

  // ── Kamera (jeder Pfad) + Suche ──
  const cam = http.createServer((req, res) => o.mjpeg(res));
  const udp = dgram.createSocket('udp4');
  udp.on('message', (m, r) => {
    let j; try { j = JSON.parse(m.toString()); } catch (e) { return; }
    if (j.method !== 7000) return;
    udp.send(JSON.stringify({ id: 0, result: { host_name: 'Centauri Carbon 2', machine_model: 'Centauri Carbon 2', sn: SN, token_status: CODE ? 1 : 0, lan_status: 1 } }), r.port, r.address);
  });
  udp.on('error', () => {});
  broker.listen(o.mqttPort, '127.0.0.1'); web.listen(o.httpPort, '127.0.0.1'); cam.listen(o.camPort, '127.0.0.1');
  if (o.udpPort) udp.bind(o.udpPort, '127.0.0.1');
  return { SN, S, C, canvas, discovery: () => JSON.stringify({ id: 0, result: { host_name: 'Centauri Carbon 2', machine_model: 'Centauri Carbon 2', sn: SN, token_status: CODE ? 1 : 0, lan_status: 1 } }) };
}
module.exports = { cc2 };
