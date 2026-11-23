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
