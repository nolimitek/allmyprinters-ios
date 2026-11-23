import UIKit
import WebKit

/// Eine WKWebView mit der Oberfläche unter amp://app/www/index.html (wie Android https://appassets…/www/index.html).
/// Die Seite liegt immer im sicheren Bereich (Statusleiste, Home-Leiste); die Farbe drumherum folgt der Kopfzeile (bars).
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {
    static let start = "amp://app/www/index.html"
    var web: WKWebView!
    let bridge = Bridge()
    private var darkBar = false

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.07, alpha: 1) : UIColor(white: 0.97, alpha: 1) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(AppScheme(store: bridge.store), forURLScheme: "amp")
        let uc = WKUserContentController()
        let h = WeakHandler(bridge)
        uc.add(h, name: "amp")
        uc.add(h, name: "amplog")
        uc.addUserScript(WKUserScript(source: Self.shim(dark: traitCollection.userInterfaceStyle == .dark), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = uc
        cfg.allowsInlineMediaPlayback = true
        cfg.websiteDataStore = .default()
        // App-gebundene Domains (Info.plist WKAppBoundDomains: app, allmyprinters.com): nötig für den Service Worker der Agent-Seite;
        // ohne diese Einstellung behandelt WebKit jede Seite als „nicht gebunden“ und sperrt Skripte und Brücke überall
        cfg.limitsNavigationsToAppBoundDomains = true
        web = WKWebView(frame: .zero, configuration: cfg)
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        web.uiDelegate = self
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: g.topAnchor), web.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            web.leadingAnchor.constraint(equalTo: g.leadingAnchor), web.trailingAnchor.constraint(equalTo: g.trailingAnchor),
        ])
        bridge.web = web
        bridge.vc = self
        var url = Self.start
        // Simulator-Lauf (ci/smoke.sh): -ampHash printers öffnet gleich diese Ansicht, -ampAgentURL die Agent-Seite
        if let hsh = UserDefaults.standard.string(forKey: "ampHash"), !hsh.isEmpty { url += "#" + hsh }
        if let au = UserDefaults.standard.string(forKey: "ampAgentURL"), Agent.okLink(au) { url = au }
        else if let au = Agent.url, Agent.okLink(au) { url = au }   // gekoppelt: gleich die Oberfläche des Agenten
        web.load(URLRequest(url: URL(string: url)!))
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.js("window.AMP_ev && AMP_ev('resume', {})") }
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.js("window.AMP_ev && AMP_ev('pause', {})") }
    }

    /// JS-Seite der Brücke: dieselbe Schnittstelle wie Androids addJavascriptInterface („AMPNative“), Fehler/Konsole ins Protokoll.
    static func shim(dark: Bool) -> String {
        """
        (function(){
          if (window.AMPNative) return;
          window.__ampNight = \(dark ? "true" : "false");
          window.__ampErr = [];
          var post = function(m){ try { window.webkit.messageHandlers.amplog.postMessage(String(m).slice(0, 2000)); } catch (e) {} };
          window.AMPNative = {
            call: function(id, m, a){ window.webkit.messageHandlers.amp.postMessage({ id: String(id), m: String(m), a: a == null ? '{}' : String(a) }); },
            night: function(){ return !!window.__ampNight; },
            platform: 'ios'
          };
          window.addEventListener('error', function(e){ var s = 'error ' + e.message + ' @' + (e.filename || '') + ':' + (e.lineno || 0); window.__ampErr.push(s); post(s); });
          window.addEventListener('unhandledrejection', function(e){ var r = e.reason; var s = 'rejection ' + (r && (r.stack || r.message) || r); window.__ampErr.push(s); post(s); });
          // Agent-Seite (https): ws:// ins Heimnetz verbietet WKWebView (Mixed Content) → über die App (Agent.swift NativeWS)
          if (location.protocol === 'https:' && location.hostname === 'allmyprinters.com') {
            var Orig = window.WebSocket, socks = {}, wseq = 0;
            var b64e = function(u8){ var s = ''; for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
            var b64d = function(s){ var r = atob(s || ''), o = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o; };
            var nat = function(m, a){ window.webkit.messageHandlers.amp.postMessage({ id: 'ws_' + m, m: m, a: JSON.stringify(a) }); };
            var NWS = function(url, protocols){
              var me = this; me.url = url; me.readyState = 0; me.binaryType = 'blob'; me.protocol = ''; me.extensions = ''; me.bufferedAmount = 0;
              me.onopen = me.onmessage = me.onclose = me.onerror = null; me._l = {}; me._id = 'w' + (++wseq); socks[me._id] = me;
              nat('ws_open', { sid: me._id, url: url, protocols: protocols ? [].concat(protocols) : [] });
            };
            NWS.CONNECTING = 0; NWS.OPEN = 1; NWS.CLOSING = 2; NWS.CLOSED = 3;
            NWS.prototype.addEventListener = function(t, f){ (this._l[t] = this._l[t] || []).push(f); };
            NWS.prototype.removeEventListener = function(t, f){ this._l[t] = (this._l[t] || []).filter(function(x){ return x !== f; }); };
            NWS.prototype._fire = function(t, ev){ var h = this['on' + t]; try { if (h) h.call(this, ev); } catch (e) { console.error(e); } (this._l[t] || []).slice().forEach(function(f){ try { f.call(this, ev); } catch (e) { console.error(e); } }, this); };
            NWS.prototype.send = function(d){
              if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
              if (typeof d === 'string') return nat('ws_send', { sid: this._id, text: d });
              var u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
              if (!u8) throw new TypeError('unsupported data');
              nat('ws_send', { sid: this._id, b64: b64e(u8) });
            };
            NWS.prototype.close = function(code){ if (this.readyState >= 2) return; this.readyState = 2; nat('ws_close', { sid: this._id, code: code || 1000 }); };
            window.__ampWs = function(id, t, d){
              var w = socks[id]; if (!w) return;
              if (t === 'open') { w.readyState = 1; w._fire('open', new Event('open')); }
              else if (t === 'text') w._fire('message', new MessageEvent('message', { data: d }));
              else if (t === 'bin') { var u8 = b64d(d); w._fire('message', new MessageEvent('message', { data: w.binaryType === 'arraybuffer' ? u8.buffer : new Blob([u8]) })); }
              else if (t === 'close') { w.readyState = 3; delete socks[id]; if (!d.clean) w._fire('error', new Event('error')); w._fire('close', new CloseEvent('close', { code: d.code, reason: d.reason || '', wasClean: !!d.clean })); }
            };
            var W = function(url, protocols){ return String(url).slice(0, 5).toLowerCase() === 'ws://' ? new NWS(String(url), protocols) : (protocols ? new Orig(url, protocols) : new Orig(url)); };
            W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3; W.prototype = Orig.prototype;
            window.WebSocket = W;
          }
          ['warn', 'error'].forEach(function(k){ var o = console[k]; console[k] = function(){ try { post(k + ' ' + Array.prototype.map.call(arguments, function(x){ return x && x.stack ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x)); }).join(' ')); } catch (e) {} return o.apply(console, arguments); }; });
        })();
        """
    }

    // ── Agent-Modus (Agent.swift): koppeln öffnet allmyprinters.com/web…, trennen die eigene Oberfläche ──
    func openAgent(_ url: String) {
        Agent.url = url.components(separatedBy: "#").first
        if let u = URL(string: url) { web.load(URLRequest(url: u)) }
    }
    func openLocal() {
        Agent.url = nil
        web.load(URLRequest(url: URL(string: Self.start)!))
    }

    func js(_ s: String) {
        if Thread.isMainThread { web?.evaluateJavaScript(s, completionHandler: nil) }
        else { DispatchQueue.main.async { self.web?.evaluateJavaScript(s, completionHandler: nil) } }
    }

    // ── Kopfzeilenfarbe / Statusleiste (backend.js native('bars', {color, dark})) ──
    func setBars(_ hex: String, dark: Bool) {
        if let c = UIColor(hex: hex) { view.backgroundColor = c }
        darkBar = dark
        setNeedsStatusBarAppearanceUpdate()
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { darkBar ? .lightContent : .darkContent }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        guard previous?.userInterfaceStyle != traitCollection.userInterfaceStyle else { return }
        let d = traitCollection.userInterfaceStyle == .dark ? "true" : "false"
        js("window.__ampNight = \(d); window.AMP_ev && AMP_ev('night', {dark: \(d)})")
    }

    // ── Drucken (Etiketten, native('print')) ──
    func printView(_ title: String) {
        let p = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil); info.jobName = title; info.outputType = .general
        p.printInfo = info
        p.printFormatter = web.viewPrintFormatter()
        p.present(animated: true)
    }

    // ── Navigation: eigene Seite bleibt in der App, alles Fremde öffnet Safari ──
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = a.request.url, let sch = u.scheme?.lowercased() else { decisionHandler(.cancel); return }
        if ["amp", "about", "blob", "data"].contains(sch) { decisionHandler(.allow); return }
        if a.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if u.host == "allmyprinters.com" && u.path.hasPrefix("/web") { decisionHandler(.allow); return }   // Agent-Modus (später)
        UIApplication.shared.open(u)
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url, u.scheme != "amp" { UIApplication.shared.open(u) }
        return nil
    }

    func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
        Log.write("geladen \(w.url?.absoluteString ?? "")")
        if UserDefaults.standard.string(forKey: "ampDiag") == "1" { if w.url?.host == Agent.host { Diag.agent(self) } else { Diag.run(self) } }
    }

    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { Log.write("Laden fehlgeschlagen: \(e)") }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { Log.write("Laden fehlgeschlagen (vorläufig): \(e)") }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { Log.write("WebContent beendet → neu laden"); w.reload() }

    // ── alert/confirm/prompt: ohne diese Methoden zeigt WKWebView nichts an und confirm() liefert immer false ──
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presentSafe(a, orElse: completionHandler)
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: Self.tr("Abbrechen", "Cancel"), style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presentSafe(a) { completionHandler(false) }
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: p, preferredStyle: .alert)
        a.addTextField { $0.text = d }
        a.addAction(UIAlertAction(title: Self.tr("Abbrechen", "Cancel"), style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        presentSafe(a) { completionHandler(nil) }
    }

    /// Kamera für den QR-Scanner (getUserMedia) nur für die eigene Oberfläche
    @available(iOS 15.0, *)
    func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // eigene Oberfläche und die Agent-Seite (QR-Code des Agenten scannen)
        decisionHandler((origin.protocol == "amp" || (origin.protocol == "https" && origin.host == Agent.host)) && type == .camera ? .prompt : .deny)
    }

    func presentSafe(_ vc: UIViewController, orElse: @escaping () -> Void) {
        var top: UIViewController = self
        while let p = top.presentedViewController { top = p }
        if top.isBeingDismissed || top.isBeingPresented { orElse(); return }
        top.present(vc, animated: true)
    }

    static func tr(_ de: String, _ en: String) -> String { (Locale.preferredLanguages.first ?? "en").hasPrefix("de") ? de : en }
}

/// WKUserContentController hält seine Empfänger fest → Umweg, damit die Brücke freigegeben werden kann
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ uc: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(uc, didReceive: m) }
}

extension UIColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}
