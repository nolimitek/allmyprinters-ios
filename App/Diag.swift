import Foundation
import WebKit

/// Simulator-Lauf (ci/smoke.sh startet mit -ampDiag 1): nach dem Laden Grundfunktionen prüfen und als
/// Documents/diag-<ansicht>.json ablegen — der Lauf in GitHub Actions kopiert die Datei in den Zweig „ci“.
enum Diag {
    /// Agent-Seite (ci/smoke.sh mit -ampAgentURL): Service Worker, Krypto, Speicher und der WebSocket-Ersatz für ws:// (Echo auf 8766)
    static func agent(_ vc: WebViewController) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            let js = """
            const out = { href: location.href, sw: 'serviceWorker' in navigator, ctrl: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
              subtle: !!(window.crypto && crypto.subtle), idb: !!window.indexedDB, rs: !!window.ReadableStream, nat: !!window.AMPNative,
              wsShim: String(window.WebSocket).slice(0, 40), text: (document.body ? document.body.innerText : '').slice(0, 400) };
            const echo = (binary) => new Promise(res => {
              const w = new WebSocket('ws://127.0.0.1:8766/echo'); w.binaryType = 'arraybuffer'; const t = setTimeout(() => res('timeout'), 6000);
              w.onopen = () => w.send(binary ? new Uint8Array([1, 2, 3, 250]).buffer : 'hallo agent');
              w.onmessage = ev => { clearTimeout(t); res(binary ? Array.from(new Uint8Array(ev.data)) : ev.data); w.close(); };
              w.onerror = () => {}; w.onclose = ev => { clearTimeout(t); res('close ' + ev.code); };
            });
            try { out.ws_text = await echo(false); out.ws_bin = await echo(true); } catch (e) { out.ws_err = String(e && e.message); }
            try { const r = await new Promise(res => { const w = new WebSocket('ws://8.8.8.8:9/x'); w.onclose = ev => res(ev.code); setTimeout(() => res('timeout'), 8000); }); out.ws_public = r; } catch (e) { out.ws_public = 'ERR ' + e.message; }
            return JSON.stringify(out);
            """
            vc.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                let s: String
                switch r { case .success(let v): s = (v as? String) ?? String(describing: v); case .failure(let e): s = "{\"jsError\": \(Bridge.json(String(describing: e)))}" }
                try? Data(s.utf8).write(to: Log.docs.appendingPathComponent("diag-agent.json"))
                Log.write("diag agent " + String(s.prefix(1500)))
            }
        }
    }

    /// Druck-Meldungen (23.11.2026): Prüfwerte vom Agenten-Verfahren (Node aes-256-gcm, iv vorn, base64url) entschlüsseln,
    /// Texte wie auf Android, falscher Schlüssel → nichts, geteilter Schlüsselbund speichern/lesen → diag-push.json
    static func pushTest() {
        let k = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw="
        let c1 = "AQIDBAUGBwgJCgsMKwAf0Bwkb9HSy7ZsNz3x6FiCpaNIYIueQffseaA5HA6WJJvb3CZZp61GosGL6i5KD17FYTUAHI6sMybKkaAtvTCASTlUGg2Xie9p5s6C0MEjsGKSHERj9hVT2xY"
        let c2 = "AQIDBAUGBwgJCgsMKwAf0BwkZ9HLjLhiZW_p8Cr4meMWI9uvB_n0O-V_TV3BKoOMyTBZheoI6OqH9z5WQXqpECRzTd_pcnfEieJ5qj6SJCkRFBXGmftprkSvSqdIxeqFbXHLIuk0N4jcuvbQq_zM6Q"
        var o: [String: Any] = [:]
        if let m = PushText.open(key: k, c: c1), let r = PushText.render(m, lang: "de") { o["c1"] = [r.title, r.body, r.go] } else { o["c1"] = "nil" }
        if let m = PushText.open(key: k, c: c2), let r = PushText.render(m, lang: "en") { o["c2"] = [r.title, r.body, r.go] } else { o["c2"] = "nil" }
        o["wrongkey"] = PushText.open(key: Data(count: 32).base64EncodedString(), c: c1) == nil
        let had = PushStore.load()
        let ok = PushStore.save(.init(kid: "diagkid", key: k, lang: "nl")), back = PushStore.load()
        o["keychain"] = [ok, back?.kid ?? "", back?.lang ?? ""]
        if let h = had { PushStore.save(h) } else { PushStore.clear() }
        o["after"] = PushStore.load()?.kid ?? ""
        if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: Log.docs.appendingPathComponent("diag-push.json")) }
        Log.write("diag push \(o)")
    }

    static func run(_ vc: WebViewController) {
        let full = (UserDefaults.standard.string(forKey: "ampHash") ?? "").isEmpty
        if full { DispatchQueue.global().async { pushTest() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            let js = """
            const out = { href: location.href, origin: location.origin, title: document.title, secure: window.isSecureContext,
              ds: typeof DecompressionStream, amp: typeof window.AMP, hash: location.hash,
              ls: (() => { try { localStorage.setItem('amp_diag_t', '1'); return localStorage.getItem('amp_diag_t') === '1'; } catch (e) { return String(e); } })(),
              view: ((document.getElementById('view') || document.body || {}).innerText || '').slice(0, 500) };
            const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'ERR ' + (e && e.message) + ' ' + JSON.stringify((e && e.data) || null); } };
            await t('info', () => AMP.native('info'));
            await t('net', () => AMP.native('net'));
            await t('saveload', async () => { await AMP.native('save', { key: 'diagtest', text: 'ok' }); return (await AMP.native('load', { key: 'diagtest' })).text; });
            await t('http', async () => { const r = await AMP.native('http', { url: 'https://allmyprinters.com/slicer/?a=version', timeout: 15000 }); return [r.status, String(r.text).slice(0, 160)]; });
            await t('http_s3d', async () => { const r = await AMP.native('http', { url: 'https://3dsearch.net/api/v1/models/trending?per_page=1&safe=1', timeout: 15000 }); return [r.status, String(r.text).slice(0, 120)]; });
            await t('fetch_cors', async () => { const r = await fetch('https://allmyprinters.com/slicer/?a=version'); return [r.status, (await r.text()).slice(0, 80)]; });
            await t('tcp', () => AMP.native('tcpcheck', { host: 'allmyprinters.com', port: 443, timeout: 3000 }));
            await t('file', async () => { const s = await AMP.native('stash', { b64: btoa('hallo'), name: 'x.txt' }); const r = await AMP.native('fileRead', { token: s.token });
              const m = await AMP.native('md5', { token: s.token }); await AMP.native('fileDrop', { token: s.token }); return [s.size, r.text, m.md5]; });
            await t('lib', async () => (await AMP.api('lib_list')).files.length);
            await t('push_state', () => AMP.native('push', { op: 'state' }));
            await t('news_state', () => AMP.native('news', { op: 'state', lang: 'de' }));
            await t('make3mf', async () => { const g = await AMP.native('stash', { b64: btoa('G28\\nT0\\nG1 X1\\nT1 ; wechsel\\n'), name: 'd.gcode' });
              const z = await AMP.native('make3mf', { token: g.token, name: 'd.gcode.3mf', extra: { 'Metadata/slice_info.config': '<config/>' } });
              const h = await AMP.native('fileRead', { token: z.token, length: 4 });
              const r = await AMP.native('remap_tools', { token: g.token, map: { '0': 2, '1': 3 } }); const rt = await AMP.native('fileRead', { token: r.token });
              for (const k of [g, z, r]) await AMP.native('fileDrop', { token: k.token });
              return [z.size, h.text, r.changed, rt.text]; });
            await t('udp', async () => (await AMP.native('udp', { ms: 400, send: { host: '127.0.0.1', port: 9, data: 'x' } })).packets.length);
            await t('live', async () => { await AMP.native('live_open', { kind: 'sdcp', key: 'diag', host: '127.0.0.1', port: 9 });
              await new Promise(r => setTimeout(r, 2500)); const s = await AMP.native('live_state', { key: 'diag' }); await AMP.native('live_close', { key: 'diag' });
              return [s.connected, s.err]; });
            await t('cam_start', async () => { await AMP.native('cam', { key: 'diagcam', urls: ['http://127.0.0.1:8765/stream'] }); await new Promise(r => setTimeout(r, 3000)); return AMP.native('cam_status', { key: 'diagcam' }); });
            await t('cam_frame', async () => { const fr = await fetch('/cam/frame?k=diagcam&n=1', { cache: 'no-store' }); return [fr.status, fr.headers.get('content-type'), (await fr.arrayBuffer()).byteLength]; });
            // /cam/live = rohe Durchleitung (in der Oberfläche nur für H.264/FLV; MJPEG zeigt sie als Einzelbilder über /cam/frame)
            await t('cam_live', async () => { const r = await fetch('/cam/live?u=' + encodeURIComponent('http://127.0.0.1:8765/snap')); return [r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength]; });
            await t('cam_snap', async () => { await AMP.native('cam', { key: 'diagsnap', urls: ['http://127.0.0.1:8765/snap'] }); await new Promise(r => setTimeout(r, 2000));
              const st = await AMP.native('cam_status', { key: 'diagsnap' }); await AMP.native('cam_stop', { key: 'diagsnap' }); return st; });
            await t('cam_bad', async () => { await AMP.native('cam', { key: 'diagbad', urls: ['http://8.8.8.8/x'] }); await new Promise(r => setTimeout(r, 1200)); return (await AMP.native('cam_status', { key: 'diagbad' })).err; });
            await t('cam_stop', async () => { await AMP.native('cam_stop', { key: 'diagcam' }); await AMP.native('cam_stop', { key: 'diagbad' }); return true; });
            if (\(full ? "true" : "false")) {   // nur beim ersten Start (ci/smoke.sh wartet dort länger): gegen die Drucker-Nachbauten (ci/mocks.js)
              await t('live_all', async () => {
                const L = [['bambu', { host: '127.0.0.1', port: 18883, serial: '01P00A123456789', code: '12345678' }], ['cc2', { host: '127.0.0.1', port: 11883, serial: 'F01CC2TEST0001', code: '4711' }],
                           ['sdcp', { host: '127.0.0.1', port: 13030 }], ['crws', { host: '127.0.0.1', port: 19999 }], ['acl', { host: '127.0.0.1', port: 18911, did: 'amp-diag' }]];
                for (const [k, o] of L) await AMP.native('live_open', { kind: k, key: 'd_' + k, ...o });
                await new Promise(r => setTimeout(r, 8000));
                const res = {};
                for (const [k] of L) { const s = await AMP.native('live_state', { key: 'd_' + k }); res[k] = [s.connected, s.err, s.registered, s.serial, Object.keys(s.state || {}).slice(0, 8)]; await AMP.native('live_close', { key: 'd_' + k }); }
                return res; });
              await t('ftps', async () => { const g = await AMP.native('stash', { b64: btoa('G28\\n'.repeat(5000)), name: 'f.gcode' });
                const r = await AMP.native('ftps', { token: g.token, host: '127.0.0.1', port: 19990, code: '12345678', remote: 'diag.gcode.3mf' });
                const ctl = await AMP.native('http', { url: 'http://127.0.0.1:18890/__bb' }); await AMP.native('fileDrop', { token: g.token });
                const j = JSON.parse(ctl.text); return [r.ok, r.remote, j.reuseOk, j.reuseFails, j.uploads]; });
              await t('cam_bambu', async () => { await AMP.native('cam', { key: 'dbb', urls: ['bambu6000://127.0.0.1:16000?code=12345678'] }); await new Promise(r => setTimeout(r, 3000));
                const s = await AMP.native('cam_status', { key: 'dbb' }); await AMP.native('cam_stop', { key: 'dbb' }); return s; });
              // ── 24.11.2026: NAS (WebDAV), eigener Ordner, Neuigkeiten im Hintergrund, H.264-Kamera (FLV über ManagedMediaSource) ──
              await t('dav', async () => {
                const c = { user: 'amp', pass: 'geheim' }, B = 'http://127.0.0.1:18990/dav/', D = 'http://127.0.0.1:18990/ddav/', o = {};
                const s1 = await AMP.native('stash', { b64: btoa('solid w\\nendsolid w\\n'), name: 'w.stl' });
                o.put = (await AMP.native('dav', { method: 'PUT', url: B + '7-w%C3%BCrfel%20gro%C3%9F.stl', token: s1.token, ...c })).status;
                o.putText = (await AMP.native('dav', { method: 'PUT', url: B + 'note.txt', text: 'hallo', ...c })).status;
                const ls = await AMP.native('dav_list', { url: B.slice(0, -1), ...c });
                o.list = [ls.status, (String(ls.text).match(/<d:response>/g) || []).length, ls.scheme || ''];
                const g = await AMP.native('dav', { method: 'GET', url: B + '7-w%C3%BCrfel%20gro%C3%9F.stl', name: 'würfel.stl', ...c });
                o.get = [g.status, g.size, g.token ? (await AMP.native('fileRead', { token: g.token })).text : null];
                if (g.token) await AMP.native('fileDrop', { token: g.token });
                o.del = (await AMP.native('dav', { method: 'DELETE', url: B + 'note.txt', ...c })).status;
                o.missing = (await AMP.native('dav', { method: 'GET', url: B + 'fehlt.stl', ...c })).status;
                o.wrongPass = (await AMP.native('dav', { method: 'GET', url: B + 'x', user: 'amp', pass: 'falsch' })).status;
                const d1 = await AMP.native('dav', { method: 'PUT', url: D + 'd%C3%A4%20x.txt', text: 'digest', ...c });
                o.digest = [d1.status, d1.scheme || ''];
                o.digestPut = (await AMP.native('dav', { method: 'PUT', url: D + 'd2.stl', token: s1.token, scheme: 'digest', ...c })).status;
                const dl = await AMP.native('dav_list', { url: D, ...c });
                o.digestList = [dl.status, dl.scheme || '', (String(dl.text).match(/<d:response>/g) || []).length];
                await AMP.native('fileDrop', { token: s1.token });
                o.server = JSON.parse((await AMP.native('http', { url: 'http://127.0.0.1:18990/__dav' })).text);
                return o; });
              // Bibliothek auf dem NAS über die Oberfläche (backend.js): verbinden, hochladen, einlesen — die Bibliotheks-Ansicht danach zeigt sie
              await t('lib_dav', async () => {
                const r = await AMP.api('amp_lib_dav', { url: 'http://127.0.0.1:18990/dav/bib', user: 'amp', pass: 'geheim' });
                const s = await AMP.native('stash', { b64: btoa('solid n\\nendsolid n\\n'), name: 'nas.stl' });
                const up = await AMP.api('lib_upload', { token: s.token, name: 'NAS-Würfel.stl', size: s.size }).catch(e => ({ err: e.message }));
                await AMP.native('dav', { method: 'PUT', url: 'http://127.0.0.1:18990/dav/bib/vom-PC.gcode', text: 'G28\\n', user: 'amp', pass: 'geheim' });
                const sc = await AMP.api('lib_scan', { force: true }).catch(e => ({ err: e.message }));
                const loc = await AMP.api('amp_lib_loc');
                const list = (await AMP.api('lib_list')).files.map(f => [f.name, f.loc]);
                return { dav: r, up: up && (up.error || up.err || 'ok'), scan: sc, loc: loc.loc, list }; });
              await t('lib_dir', async () => {
                const d = await AMP.native('lib_dir_test');
                const s = await AMP.native('stash', { b64: btoa('solid d\\nendsolid d\\n'), name: 'd.stl' });
                const p1 = await AMP.native('lib_put', { token: s.token, key: 'x', name: 'Ordner Würfel.stl', loc: d.uri });
                const p2 = await AMP.native('lib_put', { token: s.token, key: 'x', name: 'Ordner Würfel.stl', loc: d.uri });
                const ls = await AMP.native('lib_dir_list', { loc: d.uri });
                const g = await AMP.native('lib_get', { key: '', doc: p2.doc, name: 'x.stl' });
                const rd = await AMP.native('fileRead', { token: g.token }); await AMP.native('fileDrop', { token: g.token });
                await AMP.native('lib_del', { doc: p1.doc, id: '' });
                const ls2 = await AMP.native('lib_dir_list', { loc: d.uri });
                const ok = await AMP.native('lib_dir_ok', { uri: d.uri });
                let gone = null; try { await AMP.native('lib_get', { key: '', doc: p1.doc, name: 'y' }); } catch (e) { gone = e.message + ' ' + JSON.stringify(e.data || null); }
                await AMP.native('fileDrop', { token: s.token });
                return { uri: d.uri, p1: p1.doc, p2: p2.doc, list: ls.files.map(f => [f.name, f.size]), get: rd.text, after: ls2.files.map(f => f.name), ok: ok.ok, gone }; });
              await t('news', () => AMP.native('news_test', {}));
              await t('nfc', () => AMP.native('nfc_state'));
              await t('mse', () => ({ ms: typeof window.MediaSource, mms: typeof window.ManagedMediaSource, poly: !!window.__ampMms,
                h264: window.MediaSource && MediaSource.isTypeSupported ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"') : null,
                flvjs: typeof window.flvjs, flvOk: window.flvjs ? flvjs.isSupported() : null }));
              // Bambu X1/H2: RTSPS → FLV in /cam/live (App/Rtsp.swift), zuerst roh (FLV-Kopf + Bytes), dann mit flv.js im <video>
              await t('rtsp_raw', async () => { const ac = new AbortController(); setTimeout(() => ac.abort(), 6000);
                const r = await fetch('/cam/live?u=' + encodeURIComponent('rtsps://bblp:12345678@127.0.0.1:18322/streaming/live/1'), { signal: ac.signal });
                const rd = r.body.getReader(); let n = 0, head = ''; const t0 = Date.now();
                const keep = [];
                try { while (Date.now() - t0 < 4000) { const { value, done } = await rd.read(); if (done) break; if (!head) head = String.fromCharCode(...value.slice(0, 3)); n += value.length; if (n < 120000) keep.push(value); } } catch (e) {}
                { const all = new Uint8Array(keep.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of keep) { all.set(x, o); o += x.length; }
                  let b = ''; for (let i = 0; i < all.length; i += 0x8000) b += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000)); window.__ampRtspB64 = btoa(b); }
                try { ac.abort(); } catch (e) {}
                const st = JSON.parse((await AMP.native('http', { url: 'http://127.0.0.1:18323/' })).text);
                return { status: r.status, type: r.headers.get('content-type'), head, bytes: n, mock: st, b64: window.__ampRtspB64 }; });
              await t('flv_play', () => new Promise(res => {
                if (!window.flvjs || !flvjs.isSupported()) { res('flvjs not supported'); return; }
                const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true;
                v.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:99999;background:#000';
                document.body.appendChild(v);
                const p = flvjs.createPlayer({ type: 'flv', isLive: true, url: '/cam/live?u=' + encodeURIComponent('http://127.0.0.1:18088/flv') }, { enableStashBuffer: false });
                const errs = []; p.on(flvjs.Events.ERROR, (a, b, c) => errs.push([a, b, c && c.msg]));
                p.attachMediaElement(v); p.load(); const pl = v.play(); if (pl) pl.catch(e => errs.push('play ' + e.message));
                setTimeout(() => { const o = { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, rs: v.readyState, drp: v.disableRemotePlayback, errs };
                  try { p.destroy(); } catch (e) {} v.remove(); res(o); }, 9000);
              }));
              await t('rtsp_play', () => new Promise(res => {
                if (!window.flvjs || !flvjs.isSupported()) { res('flvjs not supported'); return; }
                const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true;
                v.style.cssText = 'position:fixed;left:0;top:200px;width:320px;height:180px;z-index:99999;background:#000';
                document.body.appendChild(v);
                const p = flvjs.createPlayer({ type: 'flv', isLive: true, url: '/cam/live?u=' + encodeURIComponent('rtsps://bblp:12345678@127.0.0.1:18322/streaming/live/1') }, { enableStashBuffer: false });
                const errs = []; p.on(flvjs.Events.ERROR, (a, b, c) => errs.push([a, b, c && c.msg]));
                p.attachMediaElement(v); p.load(); const pl = v.play(); if (pl) pl.catch(e => errs.push('play ' + e.message));
                const ev = []; ['waiting', 'stalled', 'playing', 'pause', 'seeking', 'seeked', 'ended'].forEach(k => v.addEventListener(k, () => ev.push(k + '@' + v.currentTime.toFixed(2))));
                const prog = []; const pt = setInterval(() => { const b = v.buffered; prog.push([+v.currentTime.toFixed(2), b.length ? +b.start(0).toFixed(2) : null, b.length ? +b.end(b.length - 1).toFixed(2) : null, v.paused]); }, 1500);
                setTimeout(() => { clearInterval(pt); const o = { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, rs: v.readyState, errs, ev: ev.slice(0, 20), prog };
                  try { p.destroy(); } catch (e) {} v.remove(); res(o); }, 9000);
              }));
            }
            out.errs = (window.__ampErr || []).slice(0, 40);
            return JSON.stringify(out);
            """
            vc.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                let s: String
                switch r {
                case .success(let v): s = (v as? String) ?? String(describing: v)
                case .failure(let e): s = "{\"jsError\": \(Bridge.json(String(describing: e)))}"
                }
                let name = UserDefaults.standard.string(forKey: "ampHash").flatMap { $0.isEmpty ? nil : $0 } ?? "start"
                try? Data(s.utf8).write(to: Log.docs.appendingPathComponent("diag-\(name).json"))
                Log.write("diag \(name) " + String(s.prefix(1500)))
            }
        }
    }
}
