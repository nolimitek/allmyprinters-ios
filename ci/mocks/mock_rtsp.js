/* (Kopie aus allmyprinters-app/test/mock_rtsp.js, o.h264 = fertige Datei) RTSPS-Kamera-Nachbau wie Bambu X1/H2/P2S (rtsps://bblp:<Code>@IP:322/streaming/live/1): TLS mit selbst signiertem Zertifikat,
 * Digest-Anmeldung, SDP mit sprop-parameter-sets, SETUP nur TCP-interleaved, danach H.264 (ffmpeg-Testbild 640×360, 10 Bilder/s)
 * als RTP nach RFC 6184 — kleine NAL-Einheiten einzeln, große als FU-A. Einblick: stats(). */
'use strict';
const tls = require('tls'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');

function rtsp(o) {   // o: { port, code, tmp }
  const dir = fs.mkdtempSync(path.join(o.tmp, 'rtsp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=rtsp-test', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem'], { stdio: 'ignore' });
  // iOS-Simulator-Lauf: fertiges Testbild aus ci/fixtures (kein ffmpeg auf dem Runner nötig), sonst wie im Android-Test erzeugen
  let h264 = o.h264;
  if (!h264) { h264 = path.join(dir, 'cam.h264'); execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '6', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
    '-g', '10', '-x264-params', 'slices=1:aud=0', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', h264]); }
  // Annex B → NAL-Einheiten → Bilder (jede VCL-NAL schließt ein Bild ab)
  const raw = fs.readFileSync(h264), nals = [];
  let i = 0, start = -1;
  while (i + 3 < raw.length) {
    const sc = raw[i] === 0 && raw[i + 1] === 0 && (raw[i + 2] === 1 || (raw[i + 2] === 0 && raw[i + 3] === 1));
    if (sc) { if (start >= 0) nals.push(raw.slice(start, i)); i += raw[i + 2] === 1 ? 3 : 4; start = i; } else i++;
  }
  if (start >= 0) nals.push(raw.slice(start));
  const frames = []; let cur = [];
  for (const n of nals) { cur.push(n); const t = n[0] & 0x1f; if (t === 1 || t === 5) { frames.push(cur); cur = []; } }
  const sps = nals.find(n => (n[0] & 0x1f) === 7), pps = nals.find(n => (n[0] & 0x1f) === 8);
  const ST = { conns: 0, authOk: 0, authFail: 0, playing: 0, packets: 0, teardown: 0 };
  const realm = 'LIVE555 Streaming Media', nonce = crypto.randomBytes(8).toString('hex');
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const srv = tls.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, sock => {
    ST.conns++;
    let buf = '', timer = null, seq = 0, ts = 0, fi = 0;
    const ssrc = crypto.randomBytes(4);
    const reply = (cseq, code, text, hdr, body) => {
      let h = `RTSP/1.0 ${code} ${text}\r\nCSeq: ${cseq}\r\n`;
      for (const [k, v] of Object.entries(hdr || {})) h += `${k}: ${v}\r\n`;
      if (body) h += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
      sock.write(h + '\r\n' + (body || ''));
    };
    const rtpPkt = (payload, marker) => {
      const h = Buffer.alloc(12); h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | 96; h.writeUInt16BE(seq++ & 0xffff, 2); h.writeUInt32BE(ts >>> 0, 4); ssrc.copy(h, 8);
      const p = Buffer.concat([h, payload]), il = Buffer.from([0x24, 0, p.length >> 8, p.length & 255]);
      ST.packets++; sock.write(Buffer.concat([il, p]));
    };
    const sendFrame = () => {
      const f = frames[fi++ % frames.length];
      f.forEach((n, k) => {
        const last = k === f.length - 1;
        if (n.length <= 1400) return rtpPkt(n, last);
        const ind = (n[0] & 0xe0) | 28, typ = n[0] & 0x1f;
        for (let off = 1; off < n.length; off += 1400) {
          const end = Math.min(n.length, off + 1400), s = off === 1, e = end === n.length;
          rtpPkt(Buffer.concat([Buffer.from([ind, (s ? 0x80 : 0) | (e ? 0x40 : 0) | typ]), n.slice(off, end)]), last && e);
        }
      });
      ts += 9000;
    };
    sock.on('data', d => {
      buf += d.toString('latin1');
      let k;
      while ((k = buf.indexOf('\r\n\r\n')) >= 0) {
        const req = buf.slice(0, k); buf = buf.slice(k + 4);
        const [line, ...hs] = req.split('\r\n'), [method, url] = line.split(' ');
        const H = {}; hs.forEach(x => { const j = x.indexOf(':'); if (j > 0) H[x.slice(0, j).trim().toLowerCase()] = x.slice(j + 1).trim(); });
        const cseq = H.cseq || '0';
        // Digest prüfen (wie live555 bei Bambu): ohne/mit falscher Antwort → 401
        const a = H.authorization || '', g = n => (new RegExp(n + '="([^"]*)"').exec(a) || [])[1];
        const okAuth = /^Digest /.test(a) && g('username') === 'bblp' && g('response') === md5(`${md5(`bblp:${realm}:${o.code}`)}:${nonce}:${md5(`${method}:${g('uri')}`)}`);
        if (method !== 'OPTIONS' && !okAuth) { ST.authFail++; reply(cseq, 401, 'Unauthorized', { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}"` }); continue; }
        if (method === 'DESCRIBE') {
          ST.authOk++;
          const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Bambu', 't=0 0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000',
            `a=fmtp:96 packetization-mode=1;profile-level-id=42c01e;sprop-parameter-sets=${sps.toString('base64')},${pps.toString('base64')}`, 'a=control:track1', ''].join('\r\n');
          reply(cseq, 200, 'OK', { 'Content-Base': url.replace(/\/?$/, '/'), 'Content-Type': 'application/sdp' }, sdp);
        } else if (method === 'SETUP') {
          if (!/interleaved/.test(H.transport || '')) { reply(cseq, 461, 'Unsupported Transport'); continue; }
          reply(cseq, 200, 'OK', { Session: '6A1B2C3D;timeout=60', Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
        } else if (method === 'PLAY') {
          reply(cseq, 200, 'OK', { Session: '6A1B2C3D', Range: 'npt=0.000-' });
          ST.playing++; clearInterval(timer); timer = setInterval(sendFrame, 100);
        } else if (method === 'TEARDOWN') { ST.teardown++; reply(cseq, 200, 'OK', {}); clearInterval(timer); sock.end(); }
        else reply(cseq, 200, 'OK', { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN' });
      }
    });
    sock.on('error', () => {}); sock.on('close', () => clearInterval(timer));
  });
  srv.listen(o.port, '127.0.0.1');
  return { stats: () => ({ ...ST, frames: frames.length }) };
}
module.exports = { rtsp };
