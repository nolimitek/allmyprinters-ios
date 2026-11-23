/* Anycubic-LAN-Modus-Nachbau (Werksfirmware, z. B. Kobra S1), Verhalten laut Recherche (kobra-connect, anycubic_ha_local,
 * grunna/Kobra X, OrcaCubic, Rinkhals-MQTT-Doku):
 *  - GET  :18910/info → {cn, ctrlInfoUrl, ctrlType lan|cloud, modelId, modelName, token(32) …}
 *  - POST ctrlInfoUrl?ts&nonce&sign&did, sign = md5(md5(token[0:16]) + ts + nonce) → {code:200, data:{info: AES-128-CBC(token[16:32], IV data.token), token: IV}}
 *    entschlüsselt: {broker mqtts://IP:9883, username, password, deviceId, modelId, devicecrt, devicepk …}
 *  - MQTT/TLS: senden an anycubic/anycubicCloud/v1/{web|slicer}/printer/{modelId}/{deviceId}/{type},
 *    Berichte auf …/printer/public/{modelId}/{deviceId}/{type}/report, Empfangsbestätigung …/response
 *  - Upload POST info.urls.fileUploadurl (/gcode_upload?s=<kurzlebig>), multipart Feld filename + Datei „gcode“, X-File-Length
 *  - print/start nur über den slicer-Zweig; ACE (multiColorBox getInfo/setDry), video startCapture
 *  - Kobra X: Kamera nicht unter :18088/flv, sondern info.urls.rtspUrl = http://IP:18088/live/<token> (__ac {rtsp: token}, Kamera-Art kx)
 * Einblick: GET/POST /__ac. */
'use strict';
const tls = require('tls'), http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

function anycubic(o) {   // o: { httpPort, mqttPort, tmp, modelId, cn, step, tick }
  const dir = fs.mkdtempSync(path.join(o.tmp, 'ac-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=anycubic', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem'], { stdio: 'ignore' });
  const rnd = n => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; for (let i = 0; i < n; i++) s += a[crypto.randomInt(a.length)]; return s; };
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const MID = String(o.modelId || 20025), DEV = 'dev' + rnd(13).toLowerCase(), USER = 'user_' + rnd(6), PASS = rnd(16);
  const M = { token: rnd(32), lan: true, dids: [], signFails: 0, sess: null, sessAt: 0, files: {}, start: null, startTopic: null, cmds: [], clients: new Set(), timer: null };
  const P = { taskid: '-1', filename: '', progress: 0, curr_layer: 0, total_layers: 0, remain_time: 0, print_time: 0, state: 'free', pause: 0 };
  M.lights = [{ type: 2, status: 1, brightness: 100 }]; M.fan = { fan_speed_pct: 0, aux_fan_speed_pct: 0, box_fan_level: 40 }; M.updates = []; M.speed = 2; M.spdTask = null;
  M.last = { taskid: '99', filename: 'alter_druck.gcode', progress: 100, curr_layer: 120, total_layers: 120, remain_time: 0, print_time: 5400, state: 'finished', pause: 0 };
  const T = { curr_nozzle_temp: 25, target_nozzle_temp: 0, curr_hotbed_temp: 24, target_hotbed_temp: 0, curr_chamber_temp: 23 };
  const box = { id: 0, status: 1, model_id: 40002, auto_feed: 1, loaded_slot: -1, temp: 26, humidity: 32, drying_status: { status: 0, target_temp: 0, duration: 0, remain_time: 0 },
    // status 5 = Spule drin, 4 = leer (Material/Farbe der letzten Spule bleiben stehen) — Dennys Rohdaten 29.09.2026; vorher hatten 1 und 3 hier
    // fälschlich 4 und galten trotzdem als belegt (SimplyPrint-Beobachtung 17.11.2026 deckte das auf)
    slots: [{ index: 0, type: 'PLA', color: [255, 0, 0], status: 5, sku: 'HPLA-RED', consumables_percent: 80 }, { index: 1, type: 'PETG', color: [0, 0, 0], status: 5, sku: '', consumables_percent: 0 },
            { index: 2, type: '', color: [0, 0, 0], status: 0 }, { index: 3, type: 'PLA', color: [255, 255, 255], status: 5, sku: '', consumables_percent: 0 }] };

  // ── MQTT-Broker über TLS ──
  const str = s => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
  const pkt = (type, body) => { const len = []; let n = body.length; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0); return Buffer.concat([Buffer.from([type, ...len]), body]); };
  const PUB = `anycubic/anycubicCloud/v1/printer/public/${MID}/${DEV}`;
  // env: Umschlag einer Befehlsantwort (state/code/msg) — so antwortet der Drucker auf print/start (anycubic_ha_local coordinator.py, Rinkhals kobra.py)
  const report = (type, action, data, env) => {
    const b = pkt(0x30, Buffer.concat([str(`${PUB}/${type}/report`), Buffer.from(JSON.stringify({ type, action, timestamp: Date.now(), msgid: crypto.randomUUID(), ...(env || {}), data }))]));
    M.clients.forEach(c => { if (c.subs.some(f => f.endsWith('/#') ? `${PUB}/${type}/report`.startsWith(f.slice(0, -1)) : f === `${PUB}/${type}/report`)) try { c.sock.write(b); } catch (e) {} });
  };
  const infoData = () => {
    M.sess = rnd(20); M.sessAt = Date.now();
    const idle = ['free', 'finished', 'stoped'].includes(P.state);
    // wie am echten Drucker: Leerlauf → last_project (alter Auftrag mit 100 %), Druck → project; in der Vorbereitung noch ohne progress
    const proj = { ...P }; if (['preheating', 'auto_leveling'].includes(P.state)) delete proj.progress;
    return { state: idle ? 'free' : 'busy', temp: { ...T }, print_speed_mode: M.speed, ...(idle ? { last_project: { ...M.last } } : { project: proj }), version: '2.7.1.4',
             urls: { fileUploadurl: `http://127.0.0.1:${o.httpPort}/gcode_upload?s=${M.sess}`, rtspUrl: M.rtsp ? `http://127.0.0.1:18088/live/${M.rtsp}` : '' }, features: { gcode_3mf_support: 1 } };
  };
  function startPrint(d) {
    const f = M.files[d.filename];
    if (!f || f.md5 !== d.md5) { report('print', 'start', null, { state: 'failed', code: 10115, msg: !f ? 'file not found' : 'md5' }); return; }
    if (!['free', 'finished', 'stoped'].includes(P.state)) { report('print', 'start', null, { state: 'failed', code: 10101, msg: 'busy' }); return; }
    if (M.refuse) { report('print', 'start', null, { state: 'failed', code: M.refuse, msg: 'refused' }); return; }
    // Kobra X FW 2.0.x (#90/#91, Denny): antwortet 10301 „设备忙,情况未知“ — streng: ohne filepath „/“ immer; spät: trotzdem Druck
    // nach 2,5 s (Tom legte den Auftrag an); nie: kein Druck (__ac {kx: 'strict'|'late'|'never'})
    if (M.kx) {
      const r10301 = () => report('print', 'start', null, { state: 'failed', code: 10301, msg: '设备忙,情况未知' });
      M.kxLast = d;
      if (M.kx === 'never' || (M.kx === 'strict' && d.filepath !== '/')) { r10301(); return; }
      if (M.kx === 'late') { r10301(); setTimeout(() => begin(d), 2500); return; }
    }
    if (!M.noStartReply) report('print', 'start', null, { state: 'printing', code: 200, msg: 'done' });
    begin(d);
  }
  function begin(d) {
    M.start = d;
    const mp = (d.ams_settings || {}).ams_box_mapping || [];
    box.loaded_slot = mp[0] ? mp[0].ams_index % 4 : 0;
    Object.assign(P, { taskid: String(Date.now()), filename: M.nameAs ? M.nameAs + d.filename : d.filename, progress: 0, curr_layer: 0, total_layers: 40, remain_time: 12, print_time: 0, state: M.fw2 ? 'nozzle_heating' : 'preheating', pause: 0 });
    M.prep = M.fw2 ? 4 : 2;   // zwei Takte Aufheizen/Nivellieren
    Object.assign(T, { target_nozzle_temp: 220, target_hotbed_temp: 60 });
    report('info', 'report', infoData());
    clearInterval(M.timer);
    M.timer = setInterval(() => {
      if (['preheating', 'auto_leveling', 'nozzle_heating', 'hotbed_heating'].includes(P.state)) { P.state = --M.prep > 0 ? (M.fw2 ? 'hotbed_heating' : 'auto_leveling') : 'printing'; report('info', 'report', infoData()); return; }
      if (P.state !== 'printing') return;
      P.progress = Math.min(100, P.progress + (o.step || 20)); P.curr_layer = Math.round(P.progress * 0.4); P.print_time += 60; P.remain_time = Math.round((100 - P.progress) / 8); T.curr_nozzle_temp = 220;
      if (P.progress >= 100) { P.state = 'finished'; box.loaded_slot = -1; clearInterval(M.timer); M.last = { ...P }; }
      // print-Bericht ungeschachtelt (progress, curr_layer, total_layers, remain_time, print_time, filename)
      report('print', 'workReport', { progress: P.progress, curr_layer: P.curr_layer, total_layers: P.total_layers, remain_time: P.remain_time, print_time: P.print_time, filename: P.filename });
      if (P.state === 'finished') report('info', 'report', infoData());
      report('tempature', 'report', { ...T });
    }, o.tick || 800);
  }
  function onMessage(topic, msg) {
    const m = /^anycubic\/anycubicCloud\/v1\/(web|slicer)\/printer\/(\d+)\/([^/]+)\/([^/]+)$/.exec(topic);
    if (!m || m[2] !== MID || m[3] !== DEV) return;
    const via = m[1], type = m[4], d = msg.data || {};
    M.cmds.push({ via, type, action: msg.action });
    M.clients.forEach(c => { try { c.sock.write(pkt(0x30, Buffer.concat([str(`${PUB}/${type}/response`), Buffer.from(JSON.stringify({ msgid: msg.msgid, code: 200 }))]))); } catch (e) {} });
    if (type === 'info' && msg.action === 'query') return report('info', 'query', infoData());
    // Licht (light query → lights-Liste, control → nacktes Licht) und Lüfter (fan query; print/update nur im Druck) — anycubic_ha_local
    if (type === 'light' && msg.action === 'query') return report('light', 'query', { lights: M.lights.map(x => ({ ...x })) });
    if (type === 'light' && msg.action === 'control') { const l = M.lights.find(x => x.type === +d.type); if (!l) return report('light', 'control', null, { code: 10001, state: 'failed', msg: 'no light' }); l.status = +d.status ? 1 : 0; l.brightness = +d.brightness || 0; return report('light', 'control', { ...l }, { code: 200, state: 'done' }); }
    if (type === 'fan' && msg.action === 'query') return report('fan', 'query', { ...M.fan, taskid: P.taskid });
    // Geschwindigkeit (print/update settings.print_speed_mode 1–3, kobra-connect mqtt-commands.md): nur im Druck, Antwort als print-Bericht
    if (type === 'print' && msg.action === 'update' && 'print_speed_mode' in (d.settings || {})) {
      M.updates.push(d.settings); M.spdTask = d.taskid;
      if (['printing', 'paused'].includes(P.state)) { M.speed = +d.settings.print_speed_mode; report('print', 'update', { taskid: P.taskid, settings: { print_speed_mode: M.speed } }); }
      return;
    }
    if (type === 'print' && msg.action === 'update') { M.updates.push(d.settings || {}); if (['printing', 'paused'].includes(P.state)) { Object.assign(M.fan, d.settings || {}); report('fan', 'report', { ...M.fan, taskid: P.taskid }); } return; }
    if (type === 'multiColorBox' && msg.action === 'getInfo') {
      // echter Kobra S1 antwortet nach dem Verbinden erst ~5 s später (09.11.2026) → M.boxDelay
      if (M.boxDelay && !msg._late) { const d = M.boxDelay; return setTimeout(() => onMessage(topic, { ...msg, _late: 1 }), d); }
      // unvollständig wie am Gerät: erst die Box ohne Fächer 2–3, dann den Rest
      report('multiColorBox', 'getInfo', { multi_color_box: [{ ...box, slots: box.slots.slice(0, 2) }] });
      return setTimeout(() => report('multiColorBox', 'getInfo', { multi_color_box: [{ id: box.id, slots: box.slots.slice(2) }] }), 150);
    }
    if (type === 'multiColorBox' && msg.action === 'setDry') {
      const ds = ((d.multi_color_box || [])[0] || {}).drying_status || {};
      box.drying_status = { status: +ds.status || 0, target_temp: +ds.target_temp || 0, duration: +ds.duration || 0, remain_time: +ds.duration || 0 };
      return report('multiColorBox', 'setDry', { multi_color_box: [{ id: box.id, drying_status: box.drying_status }] });   // nur die Trocknung
    }
    if (type === 'print' && msg.action === 'start') { M.startTopic = via; if (via === 'slicer') startPrint(d); return; }
    // Lebenslauf (pause/stop) kommt nur über info, der print-Kanal bestätigt nur die taskid
    if (type === 'print' && msg.action === 'pause' && P.state === 'printing') { P.state = 'paused'; P.pause = 1; report('print', 'pause', { taskid: P.taskid }); return report('info', 'report', infoData()); }
    if (type === 'print' && msg.action === 'resume' && P.state === 'paused') { P.state = 'printing'; P.pause = 0; report('print', 'resume', { taskid: P.taskid }); return report('info', 'report', infoData()); }
    if (type === 'print' && msg.action === 'stop' && ['printing', 'paused', 'preheating', 'auto_leveling'].includes(P.state)) { clearInterval(M.timer); P.state = 'stoped'; P.pause = 0; box.loaded_slot = -1; M.last = { ...P }; report('print', 'stop', { taskid: P.taskid }); return report('info', 'report', infoData()); }
    if (type === 'video' && msg.action === 'startCapture') return report('video', 'startCapture', { state: 'initSuccess' });
    if (type === 'video' && msg.action === 'stopCapture') return report('video', 'stopCapture', { state: 'stopSuccess' });
  }
  const broker = tls.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, sock => {
    const cl = { sock, subs: [], ok: false }; let buf = Buffer.alloc(0);
    sock.on('error', () => {}); sock.on('close', () => M.clients.delete(cl));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = 0, mul = 1, i = 1, b; do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
        if (buf.length < i + len) return;
        const t = buf[0], body = buf.slice(i, i + len); buf = buf.slice(i + len);
        const type = t >> 4;
        if (type === 1) {
          let p = 0; const rd = () => { const n = body.readUInt16BE(p); const s = body.slice(p + 2, p + 2 + n).toString(); p += 2 + n; return s; };
          rd(); p += 1; const flags = body[p]; p += 3; rd(); if (flags & 0x04) { rd(); rd(); }
          const u = flags & 0x80 ? rd() : '', pw = flags & 0x40 ? rd() : '';
          if (u !== USER || pw !== PASS) { sock.write(Buffer.from([0x20, 2, 0, 5])); sock.end(); return; }
          cl.ok = true; M.clients.add(cl); sock.write(Buffer.from([0x20, 2, 0, 0])); continue;
        }
        if (!cl.ok) { sock.destroy(); return; }
        if (type === 8) { const id = body.readUInt16BE(0); let p = 2; const q = []; while (p < body.length) { const n = body.readUInt16BE(p); cl.subs.push(body.slice(p + 2, p + 2 + n).toString()); p += 3 + n; q.push(0); } sock.write(pkt(0x90, Buffer.from([id >> 8, id & 255, ...q]))); continue; }
        if (type === 12) { sock.write(Buffer.from([0xD0, 0])); continue; }
        if (type === 3) {
          const n = body.readUInt16BE(0), topic = body.slice(2, 2 + n).toString(); let off = 2 + n; if ((t >> 1) & 3) off += 2;
          let msg; try { msg = JSON.parse(body.slice(off).toString()); } catch (e) { continue; }
          onMessage(topic, msg);
        }
      }
    });
  });

  // ── HTTP: /info, /ctrl, /gcode_upload, Einblick ──
  const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), b = [];
    req.on('data', c => b.push(c)); req.on('end', () => {
      const body = Buffer.concat(b);
      const json = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/__ac') {
        if (req.method === 'POST') { const a = JSON.parse(body.toString() || '{}'); if (a.lan !== undefined) M.lan = a.lan; if (a.boxDelay !== undefined) M.boxDelay = a.boxDelay; if (a.rtsp !== undefined) M.rtsp = a.rtsp; if (a.fw2 !== undefined) M.fw2 = !!a.fw2; if (a.refuse !== undefined) M.refuse = a.refuse; if (a.nameAs !== undefined) M.nameAs = a.nameAs; if (a.kx !== undefined) M.kx = a.kx; if (a.sessFail !== undefined) M.sessFail = +a.sessFail;
          // Fach-Status setzen (z. B. {slotStatus: {1: 4}} = Spule entnommen) und wie der Drucker den ACE-Stand melden
          if (a.slotStatus) { for (const [i, st] of Object.entries(a.slotStatus)) { const sl = box.slots.find(x => x.index === +i); if (sl) sl.status = +st; } report('multiColorBox', 'getInfo', { multi_color_box: [{ ...box }] }); } }
        return json(200, { state: P.state, files: Object.fromEntries(Object.entries(M.files).map(([k, v]) => [k, v.size])), start: M.start, kxLast: M.kxLast || null, startTopic: M.startTopic, cmds: M.cmds.slice(-8),
                           dids: M.dids, signFails: M.signFails, lights: M.lights, fan: M.fan, updates: M.updates, speed: M.speed, spdTask: M.spdTask, taskid: P.taskid, box: { loaded: box.loaded_slot, dry: box.drying_status } });
      }
      if (u.pathname === '/info' && req.method === 'GET') {
        return json(200, { cn: o.cn, ctrlInfoUrl: `http://127.0.0.1:${o.httpPort}/ctrl`, ctrlType: M.lan ? 'lan' : 'cloud', deviceName: 'Kobra S1', deviceType: 'fdm', env: 'prod',
                           ip: '127.0.0.1', modelId: MID, modelName: 'Anycubic Kobra S1', token: M.lan ? M.token : '', usn: 'uuid:fdm:AABBCCDDEEFF', zone: 'eu' });
      }
      if (u.pathname === '/ctrl' && req.method === 'POST') {
        const ts = u.searchParams.get('ts') || '', nonce = u.searchParams.get('nonce') || '', sign = u.searchParams.get('sign') || '';
        if (!M.lan) return json(200, { code: 403, message: 'not in lan mode' });
        if (sign !== md5(md5(M.token.slice(0, 16)) + ts + nonce) || Math.abs(Date.now() - +ts) > 120000) { M.signFails++; return json(200, { code: 401, message: 'sign error' }); }
        M.dids.push(u.searchParams.get('did'));
        const iv = rnd(16), ci = crypto.createCipheriv('aes-128-cbc', Buffer.from(M.token.slice(16, 32)), Buffer.from(iv));
        // wie am echten Kobra S1 (08.11.2026): KEIN modelId in den Zugangsdaten — der steht nur in /info
        const plain = JSON.stringify({ broker: `mqtts://127.0.0.1:${o.mqttPort}`, deviceId: DEV, deviceType: 'fdm', devicecrt: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----',
                                       devicepk: '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----', ip: '127.0.0.1', username: USER, password: PASS });
        return json(200, { code: 200, message: 'success', data: { info: Buffer.concat([ci.update(plain), ci.final()]).toString('base64'), token: iv } });
      }
      if (u.pathname === '/gcode_upload' && req.method === 'POST') {
        // Test „Sitzung ersetzt“ zuerst (18.11.2026): war die Adresse in einem langsamen Lauf schon über 60 s alt, traf die Falle sonst
        // erst den Wiederholungsversuch → zweimal 403, Test scheiterte je nach Tempo
        if (M.sessFail > 0) { M.sessFail--; M.sess = rnd(20); return json(403, { code: 403, message: 'session' }); }   // Test: Sitzung inzwischen ersetzt
        if (u.searchParams.get('s') !== M.sess || Date.now() - M.sessAt > 60000) return json(403, { code: 403, message: 'session' });
        const bd = '--' + (/boundary=(.+)$/.exec(req.headers['content-type'] || '') || [])[1];
        const parts = {}; let i = body.indexOf(bd);
        while (i >= 0) {
          const hs = body.indexOf('\r\n\r\n', i); if (hs < 0) break;
          const head = body.slice(i, hs).toString(), next = body.indexOf(bd, hs);
          const nm = (/name="([^"]+)"/.exec(head) || [])[1]; if (nm) parts[nm] = body.slice(hs + 4, next - 2);
          i = next; if (body.slice(next, next + bd.length + 2).toString().endsWith('--')) break;
        }
        const name = parts.filename && parts.filename.toString();
        if (!name || !parts.gcode || +req.headers['x-file-length'] !== parts.gcode.length) return json(400, { code: 400, message: 'bad upload' });
        M.files[name] = { size: parts.gcode.length, md5: crypto.createHash('md5').update(parts.gcode).digest('hex') };
        return json(200, { code: 200, message: 'success' });
      }
      res.writeHead(404); res.end();
    });
  });
  broker.listen(o.mqttPort, '127.0.0.1'); web.listen(o.httpPort, '127.0.0.1');
  return { M, P, box, MID, DEV };
}
module.exports = { anycubic };
