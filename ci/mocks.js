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
console.log('Nachbauten bereit');
