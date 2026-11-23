/* Elegoo-Centauri-Carbon-Nachbau (SDCP V3): WebSocket /websocket, Status-Pushes, Cmd 0/1/128/129/130/131/324/386,
 * Upload /uploadFile/upload in Stücken (S-File-MD5, Offset, Uuid, TotalSize), MJPEG-Kamera /video. Ohne Anmeldung (wie CC1). */
'use strict';
const http = require('http'), crypto = require('crypto');

function sdcp(o) {
  const MB = '000000000001d354';
  const S = { status: { CurrentStatus: [0], TempOfNozzle: 26, TempOfHotbed: 25, TempOfBox: 24, CurrentFanSpeed: { ModelFan: 0, ModeFan: 0, AuxiliaryFan: 0, BoxFan: 30 }, LightStatus: { SecondLight: 1, RgbLight: [0, 0, 0] }, PrintInfo: { Status: 0, CurrentLayer: 0, TotalLayer: 0, CurrentTicks: 0, TotalTicks: 0, Filename: '', TaskId: '', Progress: 0, PrintSpeedPct: 100 } },
              files: {}, parts: {}, socks: new Set(), last: null, upCount: 0, timer: null };
  const canvas = { Ack: 0, active_canvas_id: 0, active_tray_id: 1, auto_refill: 1, canvas_list: [{ canvas_id: 0, connected: 1, tray_list: [
    { tray_id: 0, brand: 'ELEGOO', filament_type: 'PLA', filament_color: '#2850DF', status: 1 }, { tray_id: 1, brand: 'ELEGOO', filament_type: 'PETG', filament_color: '#FF8800', status: 1 },
    { tray_id: 2, filament_type: '— — —', filament_color: '', status: 0 }, { tray_id: 3, brand: 'ELEGOO', filament_type: 'PLA', filament_color: '#FFFFFF', status: 1 }] }] };
  const frame = (txt) => { const p = Buffer.from(txt); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : null; return Buffer.concat([h, p]); };
  const send = (sock, obj) => { try { sock.write(frame(typeof obj === 'string' ? obj : JSON.stringify(obj))); } catch (e) {} };
  const all = obj => S.socks.forEach(s => send(s, obj));
  const status = () => ({ Status: S.status, MainboardID: MB, TimeStamp: Math.floor(Date.now() / 1000), Topic: 'sdcp/status/' + MB });
  const resp = (req, data) => ({ Id: req.Id, Data: { Cmd: req.Data.Cmd, Data: data, RequestID: req.Data.RequestID, MainboardID: MB, TimeStamp: 1 }, Topic: 'sdcp/response/' + MB });
  function handle(sock, req) {
    const cmd = req.Data && req.Data.Cmd, d = (req.Data && req.Data.Data) || {};
    S.last = req;
    if (cmd === 0) { send(sock, resp(req, { Ack: 0 })); send(sock, status()); return; }
    if (cmd === 1) { send(sock, resp(req, { Ack: 0 })); send(sock, { Attributes: { Name: 'Centauri Carbon', MachineName: 'Centauri Carbon', FirmwareVersion: 'V1.1.29', MainboardID: MB }, Topic: 'sdcp/attributes/' + MB }); return; }
    if (cmd === 324) { send(sock, resp(req, canvas)); return; }
    if (cmd === 386) { S.camOn = !!d.Enable; send(sock, resp(req, { Ack: 0, VideoUrl: '127.0.0.1:' + o.videoPort + '/video' })); return; }
    if (cmd === 128) {
      const fn = String(d.Filename || '').replace(/^\/local\//, '');
      if (!S.files[fn]) { send(sock, resp(req, { Ack: 2 })); return; }
      S.startData = d;
      Object.assign(S.status.PrintInfo, { Status: 13, Filename: fn, TaskId: crypto.randomUUID(), Progress: 0, CurrentLayer: 0, TotalLayer: 40, CurrentTicks: 0, TotalTicks: 600 });
      S.status.CurrentStatus = [1]; S.status.TempOfNozzle = 220;
      send(sock, resp(req, { Ack: 0 })); all(status());
      clearInterval(S.timer);
      S.timer = setInterval(() => {
        const pi = S.status.PrintInfo; if (pi.Status === 6) return;
        pi.Progress = Math.min(100, pi.Progress + 25); pi.CurrentTicks = pi.Progress * 6; pi.CurrentLayer = pi.Progress * 0.4;
        pi.Status = 20;   // Firmware bleibt auf Zwischenständen stehen — gedruckt wird laut CurrentStatus
        if (pi.Progress >= 100) { pi.Status = 9; S.status.CurrentStatus = [0]; clearInterval(S.timer); }
        all(status());
      }, o.stepMs || 1000);
      return;
    }
    // Cmd 403 (elegoo-homeassistant CMD_CONTROL_DEVICE): TargetFanSpeed in Prozent, LightStatus.SecondLight 0/1
    if (cmd === 403) { (S.ctlLog || (S.ctlLog = [])).push(JSON.stringify(d)); if (d.PrintSpeedPct !== undefined) S.status.PrintInfo.PrintSpeedPct = +d.PrintSpeedPct; if (d.TargetFanSpeed) Object.assign(S.status.CurrentFanSpeed, d.TargetFanSpeed); if (d.LightStatus) Object.assign(S.status.LightStatus, d.LightStatus); send(sock, resp(req, { Ack: 0 })); all(status()); return; }
    if (cmd === 129) { S.status.PrintInfo.Status = 6; send(sock, resp(req, { Ack: 0 })); all(status()); return; }
    if (cmd === 131) { S.status.PrintInfo.Status = 13; send(sock, resp(req, { Ack: 0 })); all(status()); return; }
    if (cmd === 130) { clearInterval(S.timer); S.status.PrintInfo.Status = 8; S.status.CurrentStatus = [0]; send(sock, resp(req, { Ack: 0 })); all(status()); return; }
    send(sock, resp(req, { Ack: 0 }));
  }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), b = [];
    req.on('data', c => b.push(c)); req.on('end', () => {
      const body = Buffer.concat(b);
      if (u.pathname === '/uploadFile/upload' && req.method === 'POST') {
        const bd = '--' + /boundary=(.+)$/.exec(req.headers['content-type'] || '')[1];
        const f = {}; let file = null, fname = '';
        let i = body.indexOf(bd);
        while (i >= 0) {
          const hs = body.indexOf('\r\n\r\n', i); if (hs < 0) break;
          const head = body.slice(i, hs).toString(), next = body.indexOf(bd, hs);
          const val = body.slice(hs + 4, next - 2);
          const nm = /name="([^"]+)"/.exec(head); const fnm = /filename="([^"]+)"/.exec(head);
          if (nm) { if (fnm) { file = val; fname = fnm[1]; } else f[nm[1]] = val.toString(); }
          i = next; if (body.slice(next, next + bd.length + 2).toString().endsWith('--')) break;
        }
        S.upCount++;
        const pr = S.parts[f.Uuid] || (S.parts[f.Uuid] = { chunks: [], name: fname, total: +f.TotalSize, md5: f['S-File-MD5'] });
        pr.chunks.push({ off: +f.Offset, data: file });
        const got = pr.chunks.reduce((a, c) => a + c.data.length, 0);
        if (got >= pr.total) {
          const all_ = Buffer.concat(pr.chunks.sort((a, c) => a.off - c.off).map(c => c.data));
          if (crypto.createHash('md5').update(all_).digest('hex') !== pr.md5) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: '111111', messages: [{ field: 'common_field', message: -3 }], success: false })); }
          S.files[pr.name] = all_;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: '000000', messages: null, data: null, success: true }));
      }
      if (u.pathname === '/__sd') { const a = JSON.parse(body.toString() || '{}'); res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ files: Object.fromEntries(Object.entries(S.files).map(([k, v]) => [k, v.length])), state: S.status.PrintInfo.Status, start: S.startData || null, chunks: S.upCount, last: S.last, camOn: !!S.camOn, ctlLog: S.ctlLog || [], fans: S.status.CurrentFanSpeed, light: S.status.LightStatus.SecondLight })); }
      res.writeHead(404); res.end();
    });
  });
  srv.on('upgrade', (req, sock) => {
    if (!req.url.startsWith('/websocket')) return sock.destroy();
    const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    S.socks.add(sock); sock.on('close', () => S.socks.delete(sock)); sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = buf[1] & 128; const mask = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
        if (buf.length < off + len) return;
        const p = Buffer.from(buf.slice(off, off + len)); if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
        const op = buf[0] & 15; buf = buf.slice(off + len);
        if (op === 8) return sock.end();
        if (op === 1) { const t = p.toString(); if (t === 'ping') { send(sock, 'pong'); continue; } try { handle(sock, JSON.parse(t)); } catch (e) {} }
      }
    });
  });
  srv.listen(o.wsPort, '127.0.0.1');
  http.createServer((req, res) => { if (req.url.startsWith('/video')) return o.mjpeg(res); res.writeHead(404); res.end(); }).listen(o.videoPort, '127.0.0.1');
  return { state: () => ({ Status: S.status, Attributes: { MachineName: 'Centauri Carbon', FirmwareVersion: 'V1.1.29' }, Response_324: { Cmd: 324, Data: canvas } }),
           request: (msg, captured) => handle({ write: b => { if (captured) captured(b); } }, msg), S, MB };
}
module.exports = { sdcp };
