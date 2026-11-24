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

// ── WebDAV-Nachbau wie ein NAS (24.11.2026): /dav/ mit Basic, /ddav/ nur Digest (Benutzer amp / geheim); PUT, GET, HEAD, DELETE, PROPFIND Depth 1
const DAV = {}, DREALM = 'amp-nas', DNONCE = crypto.randomBytes(8).toString('hex');
const md5 = x => crypto.createHash('md5').update(x).digest('hex');
function davAuth(req, digest) {
  const h = req.headers.authorization || '';
  if (!digest) return h === 'Basic ' + Buffer.from('amp:geheim').toString('base64');
  const m = /^Digest (.*)$/i.exec(h); if (!m) return false;
  const p = {}; for (const x of m[1].matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[x[1]] = x[2] !== undefined ? x[2] : x[3];
  const ha1 = md5(`amp:${DREALM}:geheim`), ha2 = md5(`${req.method}:${p.uri}`);
  const want = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  DAV.__uris = (DAV.__uris || []).concat([[req.method, p.uri, req.url]]).slice(-20);
  return p.username === 'amp' && p.nonce === DNONCE && p.response === want && p.uri === req.url;   // wie Apache/nginx: uri = Anfragezeile
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), digest = u.pathname.startsWith('/ddav'), body = [];
  req.on('data', c => body.push(c));
  req.on('end', () => {
    if (u.pathname === '/__dav') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ files: Object.keys(DAV).filter(k => k[0] === '/'), uris: DAV.__uris || [] })); }
    if (!davAuth(req, digest)) { res.writeHead(401, { 'WWW-Authenticate': digest ? `Digest realm="${DREALM}", nonce="${DNONCE}", qop="auth", algorithm=MD5` : 'Basic realm="amp-nas"' }); return res.end(); }
    const p = decodeURIComponent(u.pathname);
    if (req.method === 'PUT') { DAV[p] = Buffer.concat(body); res.writeHead(201); return res.end(); }
    if (req.method === 'GET' || req.method === 'HEAD') { if (!DAV[p]) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Length': DAV[p].length, 'Content-Type': 'application/octet-stream' }); return res.end(req.method === 'GET' ? DAV[p] : undefined); }
    if (req.method === 'DELETE') { const had = !!DAV[p]; delete DAV[p]; res.writeHead(had ? 204 : 404); return res.end(); }
    if (req.method === 'PROPFIND') {
      const dir = p.replace(/\/*$/, '/'), kids = Object.keys(DAV).filter(k => k[0] === '/' && k.startsWith(dir) && !k.slice(dir.length).includes('/'));
      const r = (href, coll, size) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${coll ? '<d:collection/>' : ''}</d:resourcetype>${coll ? '' : `<d:getcontentlength>${size}</d:getcontentlength>`}<d:getlastmodified>Mon, 24 Nov 2026 08:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      const xml = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${r(encodeURI(dir), true, 0)}${kids.map(k => r(encodeURI(k), false, DAV[k].length)).join('')}</d:multistatus>`;
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' }); return res.end(xml);
    }
    res.writeHead(405); res.end();
  });
}).listen(18990, '127.0.0.1');

// ── Kamera mit H.264 als FLV (Kobra X, 24.11.2026): Testbild aus ci/fixtures/cam.flv, im Takt gesendet, danach von vorn ──
const FLV = fs.readFileSync(path.join(__dirname, 'fixtures', 'cam.flv'));
http.createServer((req, res) => {
  if (!req.url.startsWith('/flv')) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'video/x-flv' });
  let o = 0; const step = Math.ceil(FLV.length / 80);   // 8 s Video in 80 Stücken à 100 ms
  const t = setInterval(() => { if (o >= FLV.length) { clearInterval(t); res.end(); return; } res.write(FLV.subarray(o, o + step)); o += step; }, 100);
  res.on('close', () => clearInterval(t));
}).listen(18088, '127.0.0.1');

// ── news.json (24.11.2026): erster Abruf 2 Einträge, ab dem zweiten ein neuer dazu ──
let newsN = 0;
http.createServer((req, res) => {
  newsN++;
  const at = d => new Date(Date.now() - d * 864e5).toISOString().replace(/\.\d+Z$/, '+00:00');
  const items = [{ id: 1, at: at(30), t: { de: 'Alt', en: 'Old' }, b: { de: 'alt', en: 'old' } }, { id: 2, at: at(1), t: { de: 'Zwei', en: 'Two' }, b: { de: 'zwei', en: 'two' } }];
  if (newsN > 1) items.push({ id: 3, at: at(0), t: { de: 'Neu: Version 0.20.0', en: 'New: version 0.20.0' }, b: { de: 'Objekt für Objekt drucken', en: 'Print object by object' } });
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ v: 1, items }));
}).listen(8767, '127.0.0.1');
console.log('Nachbauten bereit');
