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
