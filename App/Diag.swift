import Foundation
import WebKit

/// Simulator-Lauf (ci/smoke.sh startet mit -ampDiag 1): nach dem Laden Grundfunktionen prüfen und als
/// Documents/diag-<ansicht>.json ablegen — der Lauf in GitHub Actions kopiert die Datei in den Zweig „ci“.
enum Diag {
    static func run(_ vc: WebViewController) {
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
            // MJPEG wie in der Oberfläche (<img src=/cam/live?u=…>): fetch() kennt multipart/x-mixed-replace nicht
            await t('cam_live', async () => { const im = new Image(); im.src = '/cam/live?u=' + encodeURIComponent('http://127.0.0.1:8765/stream'); document.body.appendChild(im);
              await new Promise(r => setTimeout(r, 2500)); const w = [im.naturalWidth, im.naturalHeight, im.complete]; im.src = ''; im.remove(); return w; });
            await t('cam_snap', async () => { await AMP.native('cam', { key: 'diagsnap', urls: ['http://127.0.0.1:8765/snap'] }); await new Promise(r => setTimeout(r, 2000));
              const st = await AMP.native('cam_status', { key: 'diagsnap' }); await AMP.native('cam_stop', { key: 'diagsnap' }); return st; });
            await t('cam_bad', async () => { await AMP.native('cam', { key: 'diagbad', urls: ['http://8.8.8.8/x'] }); await new Promise(r => setTimeout(r, 1200)); return (await AMP.native('cam_status', { key: 'diagbad' })).err; });
            await t('cam_stop', async () => { await AMP.native('cam_stop', { key: 'diagcam' }); await AMP.native('cam_stop', { key: 'diagbad' }); return true; });
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
