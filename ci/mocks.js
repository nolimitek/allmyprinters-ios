/* Drucker-Nachbauten für den Simulator-Lauf (aus dem Test der Android-App): Bambu (MQTT/TLS, FTPS mit Sitzungs-Wiederverwendung,
 * Kamera 6000), Elegoo CC2 (MQTT) und CC1 (SDCP), Creality K2 (WebSocket), Anycubic LAN (Handshake + MQTT/TLS), MJPEG-Kamera. */
'use strict';
const fs = require('fs'), os = require('os'), http = require('http'), path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ampmock-'));
const jpg = fs.readFileSync(process.argv[2] || '/tmp/amp-cam.jpg');
const CAM = { frames: [jpg] };
function mjpeg(res) {
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ampframe', 'Cache-Control': 'no-cache' });
  const t = setInterval(() => { res.write(`--ampframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`); res.write(jpg); res.write('\r\n'); }, 150);
  res.on('close', () => clearInterval(t));
}
const M = './mocks/';
const BB = require(M + 'mock_bambu.js').bambu({ tmp: TMP, serial: '01P00A123456789', code: '12345678', mqttPort: 18883, ftpsPort: 19990, camPort: 16000, ctlPort: 18890, frames: () => CAM.frames });
const CC = require(M + 'mock_cc2.js').cc2({ sn: 'F01CC2TEST0001', code: '4711', mqttPort: 11883, httpPort: 11880, camPort: 18086, mjpeg, step: 20, tick: 700 });
const SD = require(M + 'mock_sdcp.js').sdcp({ wsPort: 13030, videoPort: 13031, mjpeg, stepMs: 1000 });
const CR = require(M + 'mock_creality.js').creality({ kind: 'k2', httpPort: 18095, wsPort: 19999, mjpeg });
const AC = require(M + 'mock_anycubic.js').anycubic({ httpPort: 18911, mqttPort: 19883, tmp: TMP, modelId: 20025, cn: 'ACS1TEST0001' });
// Kamera: /stream (MJPEG), /snap (Einzelbild)
http.createServer((req, res) => {
  if (req.url.startsWith('/snap')) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length }); return res.end(jpg); }
  mjpeg(res);
}).listen(8765, '127.0.0.1');
// WebSocket-Echo (Agent-Modus: Ersatz für ws:// auf der https-Seite), ohne Zusatzpakete
const crypto = require('crypto');
http.createServer().on('upgrade', (req, sock) => {
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15, masked = buf[1] & 128; let len = buf[1] & 127, o = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
      if (buf.length < o + (masked ? 4 : 0) + len) return;
      const mk = masked ? buf.slice(o, o + 4) : null; o += masked ? 4 : 0;
      const p = Buffer.from(buf.slice(o, o + len)); if (mk) for (let i = 0; i < p.length; i++) p[i] ^= mk[i % 4];
      buf = buf.slice(o + len);
      if (op === 8) { sock.end(Buffer.from([0x88, 0])); return; }
      const h = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : Buffer.from([0x80 | op, 126, p.length >> 8, p.length & 255]);
      sock.write(Buffer.concat([h, p]));
    }
  });
  sock.on('error', () => {});
}).listen(8766, '127.0.0.1');
console.log('Nachbauten bereit');
