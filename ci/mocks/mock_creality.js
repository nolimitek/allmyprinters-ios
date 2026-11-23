/* Creality-OS-Nachbau (Stock ohne Root), Verhalten laut Recherche (ha_creality_ws-Mitschnitte K1C 1.3.5.22, k2-websocket-re K2 Plus):
 *  - WebSocket ws://IP:9999 (Subprotokoll wsslicer): erst voller Stand, dann nur geänderte Felder; Herzschlag {"ModeCode":"heart_beat"} → „ok“
 *  - get: ReqPrinterPara (voller Stand), boxsInfo (CFS), reqGcodeFile (retGcodeFileInfo2, groß → in Teilen gesendet), getToken
 *  - set: opGcodeFile "printprt:<pfad>", colorMatch + multiColorPrint (CFS), pause 1/0, stop 1 (K2: danach state 0 + leerer Name)
 *  - HTTP: GET /info, POST /upload/<name> (multipart „file“) → „OK“; WebRTC-Aushandeln POST :8000/call/webrtc_local (base64-JSON)
 *    wird an eine Gegenstelle im Test weitergereicht (/__peer/offer, /__peer/answer); K1C alt: MJPEG :8080
 * Einblick: POST /__cr auf dem HTTP-Port. */
'use strict';
const http = require('http'), crypto = require('crypto');

function creality(o) {   // o: { kind:'k2'|'k1c'|'neo', httpPort, wsPort, rtcPort?, camPort?, mjpeg, step, tick, noList }
  const k2 = o.kind === 'k2';
  // neo (#98 Denny): Ender-3 Max Neo am Nebula Pad — Ablage unter /usr/data, Modell in keiner Liste, Start nur mit genau diesem Pfad;
  // noList: Firmware beantwortet reqGcodeFile nicht
  const neo = o.kind === 'neo';
  const DIR = k2 ? '/mnt/UDISK/printer_data/gcodes' : '/usr/data/printer_data/gcodes';
  const M = { files: {}, start: null, colorMatch: null, socks: new Set(), hbOk: 0, wsConns: 0, timer: null, offers: [], waiting: [], rtc: [], cmds: [] };
  const S = {
    model: k2 ? 'F008' : neo ? 'Ender-3 Max Neo' : 'K1C', hostname: k2 ? 'K2Plus-3D48' : neo ? 'Nebula-5A11' : 'K1C-7A21',
    modelVersion: k2 ? 'printer hw ver:;printer sw ver:;DWIN hw ver:CR4CU220812S11;DWIN sw ver:1.1.3.13;' : 'printer hw ver:;printer sw ver:;DWIN hw ver:CR4CU220812S11;DWIN sw ver:1.3.3.46;',
    state: 0, deviceState: 0, nozzleTemp: '25.120000', targetNozzleTemp: 0, bedTemp0: '24.500000', targetBedTemp0: 0, boxTemp: 26,
    printFileName: '', printProgress: 0, dProgress: 0, printJobTime: 0, printLeftTime: 0, layer: 0, TotalLayer: 0, usedMaterialLength: 0, printId: '',
    cfsConnect: k2 ? 1 : 0, webrtcSupport: k2 ? 1 : 0, video: 1, features: k2 ? ['videoInfo.videoEncryption'] : [], err: { errcode: 0, key: 0, value: '' },
    totalJob: 12, totalUsageTime: 360000, lightSw: 1, modelFanPct: 0, caseFanPct: 0, auxiliaryFanPct: 0, curFeedratePct: 100,
  };
  const boxs = { name: 'MF003', same_material: [], materialBoxs: [
    { id: 0, type: 1, state: 1, materials: [{ id: 0, vendor: '', type: '', name: '', color: '#0000000', state: 0, selected: 0, percent: -1 }] },
    { id: 1, type: 0, state: 1, temp: 31.0, humidity: 34.0, materials: [
      { id: 0, vendor: 'Creality', type: 'PLA', name: 'Hyper PLA', rfid: '01001', color: '#0ff0000', state: 2, selected: 0, percent: 80 },
      { id: 1, vendor: 'Creality', type: 'PETG', name: 'CR-PETG', rfid: '06001', color: '#0fa7c0c', state: 2, selected: 0, percent: 63 },
      { id: 2, vendor: '', type: '', name: '', rfid: '', color: '#0000000', state: 0, selected: 0, percent: -1 },
      { id: 3, vendor: 'Generic', type: 'PLA', name: 'PLA', rfid: '', color: '#0ffffff', state: 1, selected: 0, percent: 100 }] }] };

  // ── WebSocket ──
  const frame = (t, op = 1, fin = true) => { const p = Buffer.from(t); const h = p.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, p.length]) : p.length < 65536 ? Buffer.from([(fin ? 0x80 : 0) | op, 126, p.length >> 8, p.length & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = (fin ? 0x80 : 0) | op; b[1] = 127; b.writeBigUInt64BE(BigInt(p.length), 2); return b; })(); return Buffer.concat([h, p]); };
  const send = (sock, obj) => {
    const t = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (t.length <= 8192) return sock.write(frame(t));
    // große Antworten in Teilen (Text, dann Fortsetzungen) — wie die Dateiliste am echten Drucker
    const parts = []; for (let i = 0; i < t.length; i += 8192) parts.push(t.slice(i, i + 8192));
    parts.forEach((pt, i) => sock.write(frame(pt, i ? 0 : 1, i === parts.length - 1)));
  };
  const push = delta => { Object.assign(S, delta); M.socks.forEach(s => { try { send(s, delta); } catch (e) {} }); };
  const fileList = () => {
    const l = Object.entries(M.files).map(([n, f]) => ({ name: n, path: DIR + '/' + n, size: f.size, timeCost: 600, filamentWeight: '7.00', material: 'PLA', materialColors: '#FFFFFF', create_time: f.at }));
    for (let i = 0; i < 300; i++) l.push({ name: `alt_${i}.gcode`, path: `${DIR}/alt_${i}.gcode`, size: 100000 + i, timeCost: 3600, filamentWeight: '12.5', material: 'PLA', materialColors: '#000000', create_time: 1 });
    return l;
  };
  function start(path, mode) {
    const name = path.split('/').pop();
    if (S.state === 1 || S.state === 5) { push({ err: { errcode: 500, key: 109, value: 'busy' } }); return; }
    (M.starts = M.starts || []).push(path);
    if (!M.files[name] || path !== DIR + '/' + name && (neo || path !== '/usr/data/printer_data/gcodes/' + name)) { push({ err: { errcode: 500, key: 2, value: 'file not found: ' + path } }); return; }
    M.start = { path, mode };
    push({ state: 9, deviceState: 1, printFileName: DIR + '/' + name, printProgress: 0, printId: 'local_' + Date.now(), TotalLayer: 40, layer: 0, usedMaterialLength: 0, printJobTime: 0, printLeftTime: 600, err: { errcode: 0, key: 0, value: '' } });
    if (mode === 'multi' && M.colorMatch) { const m0 = M.colorMatch.list[0]; const b = boxs.materialBoxs.find(x => x.id === m0.boxId); if (b) b.materials.forEach(m => { m.selected = m.id === m0.materialId ? 1 : 0; }); }
    clearInterval(M.timer);
    setTimeout(() => push({ state: 1, targetNozzleTemp: 220, nozzleTemp: '220.000000' }), 600);
    M.timer = setInterval(() => {
      if (S.state !== 1) return;
      const pr = Math.min(100, S.printProgress + (o.step || 20));
      push({ printProgress: pr, dProgress: pr, layer: Math.round(pr * 0.4), usedMaterialLength: S.usedMaterialLength + 460, printJobTime: S.printJobTime + 30, printLeftTime: Math.round((100 - pr) * 6) });
      if (pr >= 100) { clearInterval(M.timer); push({ state: 2, deviceState: 0 }); boxs.materialBoxs.forEach(b => b.materials.forEach(m => { m.selected = 0; })); setTimeout(() => push({ state: 0 }), 1500); }
    }, o.tick || 800);
  }
  function onMsg(sock, t) {
    if (t === 'ok') { M.hbOk++; return; }
    let m; try { m = JSON.parse(t); } catch (e) { return; }
    const p = m.params || {};
    M.cmds.push(m);
    if (m.method === 'get') {
      if (p.ReqPrinterPara) send(sock, S);
      if (p.boxsInfo && k2) send(sock, { boxsInfo: boxs });
      if (p.reqGcodeFile && !o.noList) send(sock, { retGcodeFileInfo2: fileList() });
      if (p.getToken) send(sock, { videoToken: 'tok-' + o.wsPort });
      return;
    }
    if (m.method !== 'set') return;
    // Licht lightSw, Lüfter über gcodeCmd M106 P0/P1/P2 (ha_creality_ws)
    if ('lightSw' in p) push({ lightSw: +p.lightSw ? 1 : 0 });
    // Geschwindigkeit setFeedratePct → curFeedratePct (ha_creality_ws)
    if ('setFeedratePct' in p) push({ curFeedratePct: +p.setFeedratePct });
    if (p.gcodeCmd) { (M.gcodes || (M.gcodes = [])).push(p.gcodeCmd); const g = /^M106 P([012]) S(\d+)$/.exec(p.gcodeCmd); if (g) push({ [['modelFanPct', 'caseFanPct', 'auxiliaryFanPct'][+g[1]]]: Math.round(Math.min(255, +g[2]) / 2.55) }); }
    if (p.opGcodeFile && /^printprt:/.test(p.opGcodeFile)) start(p.opGcodeFile.slice(9), 'single');
    if (p.colorMatch) M.colorMatch = p.colorMatch;
    if (p.multiColorPrint) start(p.multiColorPrint.gcode, 'multi');
    if (p.pause === 1 && S.state === 1) push({ state: 5 });
    if (p.pause === 0 && S.state === 5) push({ state: 1 });
    if (p.stop === 1 && (S.state === 1 || S.state === 5)) {
      clearInterval(M.timer);
      // K2: Abbruch erscheint als state 0 mit zurückgesetztem Fortschritt und leerem Namen; K1C: state 4
      if (k2) push({ state: 0, deviceState: 0, printProgress: 0, printFileName: '' }); else { push({ state: 4, deviceState: 0 }); setTimeout(() => push({ state: 0 }), 1500); }
    }
  }
  const ws = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  ws.on('upgrade', (req, sock) => {
    const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const proto = /wsslicer/.test(req.headers['sec-websocket-protocol'] || '') ? 'Sec-WebSocket-Protocol: wsslicer\r\n' : '';
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n${proto}\r\n`);
    M.socks.add(sock); M.wsConns++; sock.on('close', () => M.socks.delete(sock)); sock.on('error', () => {});
    send(sock, S);   // voller Stand gleich nach dem Verbinden
    const hb = setInterval(() => { try { send(sock, { ModeCode: 'heart_beat', msg: new Date().toISOString() }); } catch (e) {} }, o.hbMs || 3000);
    sock.on('close', () => clearInterval(hb));
    let buf = Buffer.alloc(0), msg = [];
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = buf[1] & 128, mask = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
        if (buf.length < off + len) return;
        const p = Buffer.from(buf.slice(off, off + len)); if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
        const op = buf[0] & 15, fin = buf[0] & 128; buf = buf.slice(off + len);
        if (op === 8) return sock.end();
        if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8A, p.length]), p])); continue; }
        if (op === 1 || op === 0) { msg.push(p); if (fin) { const t = Buffer.concat(msg).toString(); msg = []; onMsg(sock, t); } }
      }
    });
  });

  // ── HTTP: /info, /upload, Einblick ──
  const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), b = [];
    req.on('data', c => b.push(c)); req.on('end', () => {
      const body = Buffer.concat(b);
      if (u.pathname === '/info') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ model: S.model, mac: 'aa:bb:cc:dd:ee:' + (k2 ? '01' : neo ? (o.wsPort % 100).toString(16).padStart(2, '0') : '02'), version: '1.1.3.13' })); }
      // POST /upload (Name nur im Formular) wie der SimplyPrint Client (16.11.2026); o.plainUpload: Drucker kennt NUR diese Form (/upload/<name> → 404)
      if (((u.pathname.startsWith('/upload/') && !o.plainUpload) || u.pathname === '/upload') && req.method === 'POST') {
        const bd = '--' + (/boundary=(.+)$/.exec(req.headers['content-type'] || '') || [])[1];
        const hs = body.indexOf('\r\n\r\n'), head = body.slice(0, hs).toString(), end = body.lastIndexOf(bd) - 2;
        const field = (/name="([^"]+)"/.exec(head) || [])[1], fname = u.pathname === '/upload' ? ((/filename="([^"]+)"/.exec(head) || [])[1] || 'upload.gcode') : decodeURIComponent(u.pathname.slice(8));
        M.uploadPaths = (M.uploadPaths || []).concat(u.pathname === '/upload' ? '/upload' : '/upload/<name>');
        if (field !== 'file' || /name="path"/.test(body.toString('latin1'))) { res.writeHead(400); return res.end('error'); }
        M.files[fname] = { size: end - hs - 4, at: Math.floor(Date.now() / 1000) };
        res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('{"code":0,"message":"OK"}');
      }
      if (u.pathname === '/__cr') {
        try { const a = JSON.parse(body.toString() || '{}'); if ('plainUpload' in a) o.plainUpload = !!a.plainUpload; } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ feed: S.curFeedratePct, uploadPaths: M.uploadPaths || [], files: M.files, start: M.start, colorMatch: M.colorMatch, state: S.state, hbOk: M.hbOk, wsConns: M.wsConns, rtc: M.rtc, last: M.cmds.slice(-3), starts: M.starts || [], gcodes: M.gcodes || [], lightSw: S.lightSw, fans: [S.modelFanPct, S.caseFanPct, S.auxiliaryFanPct] }));
      }
      res.writeHead(404); res.end();
    });
  });

  // ── WebRTC-Aushandeln wie :8000/call/webrtc_local, Gegenstelle = Browserseite im Test ──
  const rtc = o.rtcPort && http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), b = [];
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    req.on('data', c => b.push(c)); req.on('end', () => {
      const body = Buffer.concat(b).toString();
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (u.pathname === '/call/webrtc_local' && req.method === 'POST') {
        let offer; try { offer = JSON.parse(Buffer.from(body.trim(), 'base64').toString()); } catch (e) { res.writeHead(200); return res.end('{}'); }   // rohes SDP → „{}“
        if (offer.type !== 'offer' || !offer.sdp) { res.writeHead(200); return res.end('{}'); }
        const id = crypto.randomUUID();
        M.rtc.push({ token: offer.token || null, at: Date.now() });
        const done = sdp => { clearTimeout(t); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(Buffer.from(JSON.stringify({ type: 'answer', sdp })).toString('base64')); };
        const t = setTimeout(() => { M.offers = M.offers.filter(x => x.id !== id); res.writeHead(504); res.end(); }, 15000);
        M.offers.push({ id, sdp: offer.sdp, done });
        const w = M.waiting.shift(); if (w) w();
        return;
      }
      if (u.pathname === '/__peer/offer') {   // Gegenstelle holt das nächste Angebot (lange Abfrage)
        const give = () => { const x = M.offers.find(y => !y.taken); if (!x) return false; x.taken = true; res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: x.id, sdp: x.sdp })); return true; };
        if (give()) return;
        const t = setTimeout(() => { res.writeHead(204, cors); res.end(); }, 8000);
        M.waiting.push(() => { clearTimeout(t); give(); });
        return;
      }
      if (u.pathname === '/__peer/answer' && req.method === 'POST') {
        const a = JSON.parse(body || '{}'), x = M.offers.find(y => y.id === a.id);
        if (x) { M.offers = M.offers.filter(y => y !== x); x.done(a.sdp); }
        res.writeHead(200, cors); return res.end('{}');
      }
      res.writeHead(404, cors); res.end();
    });
  });
  const cam = o.camPort && http.createServer((req, res) => o.mjpeg(res));
  ws.listen(o.wsPort, '127.0.0.1'); web.listen(o.httpPort, '127.0.0.1');
  if (rtc) rtc.listen(o.rtcPort, '127.0.0.1');
  if (cam) cam.listen(o.camPort, '127.0.0.1');
  return { S, M, boxs };
}
module.exports = { creality };
