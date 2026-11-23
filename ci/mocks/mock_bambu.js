/* Bambu-Lab-Nachbau (P1S mit AMS) für Tests: MQTT 3.1.1 über TLS, implizites FTPS mit Pflicht zur TLS-Sitzungs-
 * Wiederverwendung (wie vsftpd „require_ssl_reuse“ auf dem Drucker), Kamera-JPEG-Strom über TLS (P1/A1, Port 6000).
 * Zertifikat selbst signiert (CN = Seriennummer). Steuerung/Einblick: HTTP-Port ctlPort (/__bb). */
'use strict';
const tls = require('tls'), net = require('net'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');

/** ClientHello lesen: Länge der angebotenen Sitzungs-ID, SessionTicket-Erweiterung (Länge, -1 = fehlt), SNI vorhanden. */
function helloInfo(d) {
  try {
    if (d[0] !== 0x16 || d[5] !== 1) return { raw: d.slice(0, 8).toString('hex') };
    let p = 43; const sid = d[p]; p += 1 + sid;
    p += 2 + d.readUInt16BE(p); p += 1 + d[p];
    const end = p + 2 + d.readUInt16BE(p); p += 2;
    let ticket = -1, sni = false;
    while (p + 4 <= end) { const t = d.readUInt16BE(p), l = d.readUInt16BE(p + 2); if (t === 35) ticket = l; if (t === 0) sni = true; p += 4 + l; }
    return { sid, ticket, sni };
  } catch (e) { return { err: e.message }; }
}

function bambu(o) {
  const dir = fs.mkdtempSync(path.join(o.tmp, 'bb-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=' + o.serial, '-keyout', dir + '/k.pem', '-out', dir + '/c.pem'], { stdio: 'ignore' });
  const cred = { key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem'), minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' };
  const ticketKeys = crypto.randomBytes(48);
  const B = { devmode: true, uploads: {}, reuseFails: 0, reuseOk: 0, lastCmd: null, clients: new Set(), camAuth: null, timer: null };
  const S = { print: { gcode_state: 'IDLE', mc_percent: 0, mc_remaining_time: 0, layer_num: 0, total_layer_num: 0, nozzle_temper: 25.1, bed_temper: 24.3, subtask_name: '', gcode_file: '',
    fun: '0', print_error: 0, spd_lvl: 2, cooling_fan_speed: '0', big_fan1_speed: '0', big_fan2_speed: '10', lights_report: [{ node: 'chamber_light', mode: 'on' }, { node: 'work_light', mode: 'flashing' }], ams: { tray_now: '255', ams: [{ id: '0', humidity: '4', humidity_raw: '27', temp: '24.5', tray: [
      { id: '0', tray_type: 'PLA', tray_color: 'FF0000FF', remain: 80, tray_info_idx: 'GFA00', tray_uuid: 'A1B2C3D4E5F60718293A4B5C6D7E8F90' }, { id: '1', tray_type: 'PETG', tray_color: '000000FF', remain: -1 },
      { id: '2' }, { id: '3', tray_type: 'PLA', tray_color: 'FFFFFFFF', remain: 55 }] }] }, vt_tray: { id: '254', tray_type: 'TPU', tray_color: '00FF00FF' } },
    info: { command: 'get_version', module: [{ name: 'ota', sw_ver: '01.08.05.00', product_name: 'Bambu Lab P1S' }] } };
  const fun = () => (B.devmode ? 0x0 : 0x20000000).toString(16).toUpperCase();
  const str = s => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
  const pkt = (type, body) => { const len = []; let n = body.length; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0); return Buffer.concat([Buffer.from([type, ...len]), body]); };
  const report = (sock, obj) => sock.write(pkt(0x30, Buffer.concat([str(`device/${o.serial}/report`), Buffer.from(JSON.stringify(obj))])));
  const broadcast = obj => B.clients.forEach(c => { try { report(c, obj); } catch (e) {} });
  function handle(sock, msg) {
    B.lastCmd = msg;
    (B.cmds || (B.cmds = [])).push(Object.keys(msg).map(k => k + ':' + ((msg[k] || {}).command || '')).join(','));
    if (msg.pushing && msg.pushing.command === 'pushall') return report(sock, { print: { ...S.print, fun: fun(), command: 'push_status', msg: 0 } });
    if (msg.info && msg.info.command === 'get_version') return report(sock, { info: S.info });
    const p = msg.print || {};
    // Lüfter (gcode_line M106 Pn S0–255 → 0–15) und Licht (system ledctrl) wie ha-bambulab
    if (p.command === 'gcode_line') { (B.ctlLog || (B.ctlLog = [])).push(String(p.param || '').trim()); const m = /^M106 P([123]) S(\d+)/.exec(String(p.param || '')); if (m) { const k = { 1: 'cooling_fan_speed', 2: 'big_fan1_speed', 3: 'big_fan2_speed' }[m[1]]; S.print[k] = String(Math.round(Math.min(255, +m[2]) / 255 * 15)); broadcast({ print: { [k]: S.print[k] } }); } return; }
    if (msg.system && msg.system.command === 'ledctrl') { (B.ctlLog || (B.ctlLog = [])).push('ledctrl ' + msg.system.led_node + ' ' + msg.system.led_mode); const l = S.print.lights_report.find(x => x.node === msg.system.led_node); if (l) l.mode = msg.system.led_mode; broadcast({ print: { lights_report: S.print.lights_report } }); return; }
    if (p.command === 'ams_filament_setting') {
      (B.filSet || (B.filSet = [])).push(p);
      const a = (S.print.ams.ams || []).find(x => +x.id === +p.ams_id), t = a && (a.tray || []).find(x => +x.id === +p.tray_id);
      if (t) { Object.assign(t, { tray_type: p.tray_type, tray_color: p.tray_color, tray_info_idx: p.tray_info_idx, nozzle_temp_min: String(p.nozzle_temp_min), nozzle_temp_max: String(p.nozzle_temp_max) }); broadcast({ print: { ams: S.print.ams } }); }
      return;
    }
    // Geschwindigkeit (ha-bambulab): print_speed param 1–4 → spd_lvl
    if (p.command === 'print_speed') { (B.ctlLog || (B.ctlLog = [])).push('print_speed ' + p.param); S.print.spd_lvl = +p.param; broadcast({ print: { spd_lvl: S.print.spd_lvl } }); return; }
    if (p.command === 'project_file') {
      B.lastStart = p;
      const name = String(p.url || '').replace(/^(ftp|file):\/\/(\/sdcard)?\/*/, '');
      // MD5 im Startbefehl = MD5 der ganzen hochgeladenen Datei in Großbuchstaben (SimplyPrint Client, beobachtet 16.11.2026)
      if (p.md5 !== undefined) B.md5 = { sent: p.md5, real: B.uploads[name] ? crypto.createHash('md5').update(B.uploads[name]).digest('hex').toUpperCase() : null };
      if (!B.devmode) { broadcast({ print: { command: 'project_file', result: 'fail', reason: 'MQTT Command verification failed', err_code: 84033543 } }); return; }
      if (!B.uploads[name]) { S.print.print_error = 0x0500C010; S.print.gcode_state = 'FAILED'; broadcast({ print: { gcode_state: 'FAILED', print_error: S.print.print_error } }); return; }
      Object.assign(S.print, { gcode_state: 'PREPARE', mc_percent: 0, subtask_name: p.subtask_name, gcode_file: name, total_layer_num: 50, layer_num: 0, mc_remaining_time: 12 });
      S.print.ams.tray_now = String((p.ams_mapping || [])[0] ?? 254);
      broadcast({ print: { gcode_state: 'PREPARE', subtask_name: p.subtask_name, ams: { tray_now: S.print.ams.tray_now } } });
      clearInterval(B.timer);
      B.timer = setInterval(() => {
        if (S.print.gcode_state === 'PAUSE') return;
        S.print.gcode_state = 'RUNNING'; S.print.mc_percent = Math.min(100, S.print.mc_percent + 20); S.print.layer_num = S.print.mc_percent / 2; S.print.nozzle_temper = 220;
        if (S.print.mc_percent >= 100) { S.print.gcode_state = 'FINISH'; S.print.ams.tray_now = '255'; clearInterval(B.timer); }
        broadcast({ print: { gcode_state: S.print.gcode_state, mc_percent: S.print.mc_percent, layer_num: S.print.layer_num, mc_remaining_time: Math.round((100 - S.print.mc_percent) / 8), nozzle_temper: S.print.nozzle_temper, ams: { tray_now: S.print.ams.tray_now } } });
      }, o.stepMs || 1000);
      return;
    }
    if (p.command === 'pause') { S.print.gcode_state = 'PAUSE'; broadcast({ print: { gcode_state: 'PAUSE' } }); }
    if (p.command === 'resume') { S.print.gcode_state = 'RUNNING'; broadcast({ print: { gcode_state: 'RUNNING' } }); }
    if (p.command === 'stop') { clearInterval(B.timer); S.print.gcode_state = 'FAILED'; broadcast({ print: { gcode_state: 'FAILED' } }); }
  }
  // MQTT
  tls.createServer(cred, sock => {
    let buf = Buffer.alloc(0), ok = false;
    sock.on('error', () => {}); sock.on('close', () => B.clients.delete(sock));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let i = 1, len = 0, mul = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
        if (buf.length < i + len) return;
        const t = buf[0], body = buf.slice(i, i + len); buf = buf.slice(i + len);
        const ty = t >> 4;
        if (ty === 1) {   // CONNECT
          let q = 2 + body.readUInt16BE(0) + 4; const rd = () => { const l = body.readUInt16BE(q); const v = body.slice(q + 2, q + 2 + l).toString(); q += 2 + l; return v; };
          rd(); const user = rd(), pass = rd();
          // Bambu-Cloud-Nachbau (19.11.2026): Konto „u_<uid>“ + Zugangsschlüssel statt „bblp“ + Zugangscode
          ok = (user === 'bblp' && pass === o.code) || (!!o.cloud && user === o.cloud.user && pass === o.cloud.token);
          if (o.cloud && user.startsWith('u_')) B.cloudLogins = (B.cloudLogins || 0) + 1;
          sock.write(Buffer.from([0x20, 2, 0, ok ? 0 : 5])); if (!ok) sock.end(); else B.clients.add(sock);
        } else if (ty === 8) { const id = body.readUInt16BE(0); sock.write(Buffer.from([0x90, 3, id >> 8, id & 255, 0])); }
        else if (ty === 12) sock.write(Buffer.from([0xD0, 0]));
        else if (ty === 3 && ok) { const tl = body.readUInt16BE(0); try { handle(sock, JSON.parse(body.slice(2 + tl).toString())); } catch (e) {} }
      }
    });
  }).listen(o.mqttPort, '127.0.0.1');
  // FTPS (implizit) mit Pflicht zur Sitzungs-Wiederverwendung im Datenkanal. Wie OpenSSL in vsftpd: Wiederaufnahme über
  // Sitzungs-ID (gemeinsamer Speicher für Steuer- und Datenkanal) UND über Tickets — Android (Conscrypt) schickt ohne Weiteres nur die ID.
  const sess = new Map();
  const withSess = srv => {
    srv.on('newSession', (id, data, cb) => { B.newSess = (B.newSess || 0) + 1; sess.set(id.toString('hex'), data); cb(); });
    srv.on('resumeSession', (id, cb) => { const d = sess.get(id.toString('hex')) || null; B.resumeAsk = (B.resumeAsk || 0) + 1; if (d) B.resumeHit = (B.resumeHit || 0) + 1; cb(null, d); });
    return srv;
  };
  withSess(tls.createServer({ ...cred, ticketKeys }, ctl => {
    ctl.on('error', () => {});
    const say = l => ctl.write(l + '\r\n');
    let user = '', authed = false, pasv = null, rest = '';
    say('220 (vsFTPd 3.0.5)');
    ctl.on('data', d => {
      rest += d.toString();
      let k; while ((k = rest.indexOf('\r\n')) >= 0) {
        const line = rest.slice(0, k); rest = rest.slice(k + 2);
        const [c, ...a] = line.split(' '), arg = a.join(' ');
        if (c === 'USER') { user = arg; say('331 Please specify the password.'); }
        else if (c === 'PASS') { authed = user === 'bblp' && arg === o.code; say(authed ? '230 Login successful.' : '530 Login incorrect.'); }
        else if (!authed) say('530 Please login with USER and PASS.');
        else if (c === 'PBSZ') say('200 PBSZ set to 0.'); else if (c === 'PROT') say('200 PROT now Private.'); else if (c === 'TYPE') say('200 Switching to Binary mode.');
        else if (c === 'PASV') {
          pasv = { conn: null, waiting: null };
          const srv = withSess(tls.createServer({ ...cred, ticketKeys }, ds => {
            ds.on('error', () => {});
            if (!ds.isSessionReused()) { B.reuseFails++; ds.destroy(); if (pasv) pasv.bad = true; say('522 SSL connection failed: session reuse required'); return; }
            B.reuseOk++;
            const parts = []; ds.on('data', x => parts.push(x)); ds.on('end', () => { if (pasv && pasv.name) { B.uploads[pasv.name] = Buffer.concat(parts); say('226 Transfer complete.'); } });
          }));
          // Davor ein Durchreicher, der das ClientHello des Datenkanals mitliest (Sitzungs-ID-Länge, Ticket) — nur zur Fehlersuche
          srv.listen(0, '127.0.0.1', () => {
            const real = srv.address().port;
            const px = net.createServer(c => {
              const up = net.connect(real, '127.0.0.1'); c.on('error', () => {}); up.on('error', () => {});
              c.once('data', d => { (B.hellos = B.hellos || []).push(helloInfo(d)); up.write(d); c.pipe(up); up.pipe(c); });
            });
            px.listen(0, '127.0.0.1', () => { const p = px.address().port; say(`227 Entering Passive Mode (0,0,0,0,${p >> 8},${p & 255}).`); setTimeout(() => { px.close(); srv.close(); }, 60000); });
          });
        } else if (c === 'STOR') { if (pasv) pasv.name = arg.replace(/^\/+/, ''); say('150 Ok to send data.'); }
        else if (c === 'QUIT') { say('221 Goodbye.'); ctl.end(); }
        else say('500 Unknown command.');
      }
    });
  })).listen(o.ftpsPort, '127.0.0.1');
  // Kamera (P1/A1): 80-Byte-Anmeldung, dann je Bild 16-Byte-Kopf + JPEG
  tls.createServer(cred, cs => {
    cs.on('error', () => {});
    let got = Buffer.alloc(0), t = null;
    cs.on('data', d => {
      got = Buffer.concat([got, d]);
      if (got.length >= 80 && !t) {
        const pass = got.slice(48, 80).toString().replace(/\0+$/, ''); B.camAuth = pass;
        if (pass !== o.code) return cs.destroy();
        let i = 0;
        t = setInterval(() => { const f = o.frames()[i++ % o.frames().length]; const h = Buffer.alloc(16); h.writeUInt32LE(f.length, 0); h.writeUInt32LE(1, 8); cs.write(Buffer.concat([h, f])); }, 150);
      }
    });
    cs.on('close', () => clearInterval(t));
  }).listen(o.camPort, '127.0.0.1');
  http.createServer((req, res) => {
    const b = []; req.on('data', c => b.push(c)); req.on('end', () => {
      const a = JSON.parse(Buffer.concat(b).toString() || '{}');
      if (a.devmode !== undefined) { B.devmode = !!a.devmode; broadcast({ print: { fun: fun() } }); }
      const up = {}; for (const [k, v] of Object.entries(B.uploads)) up[k] = v.length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: S.print.gcode_state, filSet: B.filSet || [], md5: B.md5 || null, trays: (S.print.ams.ams[0] || {}).tray, uploads: up, reuseOk: B.reuseOk, reuseFails: B.reuseFails, newSess: B.newSess || 0, hellos: B.hellos || [], resumeAsk: B.resumeAsk || 0, resumeHit: B.resumeHit || 0, lastCmd: B.lastCmd, lastStart: B.lastStart || null, spd: S.print.spd_lvl, ctlLog: B.ctlLog || [], fans: [S.print.cooling_fan_speed, S.print.big_fan1_speed, S.print.big_fan2_speed], light: (S.print.lights_report.find(x => x.node === 'chamber_light') || {}).mode, camAuth: B.camAuth,
                               zip: a.zip && B.uploads[a.zip] ? (() => { const f = path.join(dir, 'z.zip'); fs.writeFileSync(f, B.uploads[a.zip]); try { return execFileSync('unzip', ['-l', f]).toString(); } catch (e) { return 'kein zip'; } })() : null }));
    });
  }).listen(o.ctlPort, '127.0.0.1');
  // Für die Browser-Testumgebung (ohne Android-Teil): Zustand und Befehle direkt
  return { state: () => ({ print: { ...S.print, fun: fun() }, info: S.info }), request: msg => handle({ write() {} }, msg), uploads: B.uploads, B };
}
module.exports = { bambu };
