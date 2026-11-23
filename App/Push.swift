import UIKit
import UserNotifications

/// Benachrichtigungen (23.11.2026) — dieselbe Schnittstelle wie Bridge.kt notify():
///   news {op: state {lang} → {on, perm, go} | set {on} → {on, perm} | seen {id} | settings}
///   push {op: state → {perm, gms, on, token, key, kid, changed} | enable → {token, key, kid} | disable | registered {token}}
/// Druck-Meldungen kommen nur mit Agent: das Token „apns:<hex>“ und der Schlüssel gehen durch den Tunnel an den Agenten, der
/// verschlüsselt jede Meldung; allmyprinters.com/api/push.php reicht sie an Apple weiter (ohne Firebase). Die Notification
/// Service Extension (Notify/) entschlüsselt mit dem Schlüssel aus dem geteilten Schlüsselbund (Shared/PushText.swift).
/// Neuigkeiten (news.json) zeigt die Oberfläche selbst; einen Hintergrundabruf wie den Android-Job gibt es auf dem iPhone nicht.
final class Push: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Push()
    weak var vc: WebViewController?
    private let ud = UserDefaults.standard
    private let lock = NSLock()
    private var waiter: DispatchSemaphore?
    private var got: String?
    private var gotErr: String?
    private var pendingGo: String?
    private var uiAsked = false   // Oberfläche hat einmal nachgefragt (news state) → Antippen geht direkt als Ereignis hin

    private var token: String? { ud.string(forKey: "push_token") }

    /// Beim Start: Meldungen hierher, und war Push an, das Token bei Apple auffrischen (kann sich ändern → state.changed → Agent)
    func launched() {
        UNUserNotificationCenter.current().delegate = self
        if token != nil { DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() } }
    }

    // ── Apple-Token ──
    func didRegister(_ data: Data) {
        let t = "apns:" + data.map { String(format: "%02x", $0) }.joined()
        lock.lock(); defer { lock.unlock() }
        if token != nil || waiter != nil { ud.set(t, forKey: "push_token") }
        got = t; waiter?.signal()
    }
    func didFail(_ e: Error) {
        Log.write("push: Registrierung fehlgeschlagen \(e)")
        lock.lock(); defer { lock.unlock() }
        gotErr = "net"; waiter?.signal()
    }

    // ── Erlaubnis ──
    private func status() -> UNAuthorizationStatus {
        let sem = DispatchSemaphore(value: 0); var st = UNAuthorizationStatus.notDetermined
        UNUserNotificationCenter.current().getNotificationSettings { s in st = s.authorizationStatus; sem.signal() }
        _ = sem.wait(timeout: .now() + 5)
        return st
    }
    private func perm() -> Bool { [.authorized, .provisional, .ephemeral].contains(status()) }
    private func ask() -> Bool {
        let sem = DispatchSemaphore(value: 0); var ok = false
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { g, _ in ok = g; sem.signal() }
        _ = sem.wait(timeout: .now() + 120)   // wartet auf die Antwort im Systemdialog
        return ok
    }
    private func lang() -> String {
        if let l = ud.string(forKey: "push_lang"), l.count == 2 { return l }
        let sys = String((Locale.preferredLanguages.first ?? "en").prefix(2))
        return ["de", "en", "fr", "es", "it", "nl"].contains(sys) ? sys : "en"
    }
    private func rnd(_ n: Int) -> Data { Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }

    // ── Brücke ──
    func push(_ b: Bridge, _ a: [String: Any]) throws -> [String: Any] {
        switch b.s(a, "op") {
        case "state":
            let c = PushStore.load(), t = token
            let on = c != nil && t != nil
            return ["perm": perm(), "gms": true, "on": on, "token": t ?? "", "key": c?.key ?? "", "kid": c?.kid ?? "",
                    "changed": on && t != ud.string(forKey: "push_reg")]
        case "enable":
            if !perm() && !ask() { throw BErr("denied") }
            let sem = DispatchSemaphore(value: 0)
            lock.lock(); waiter = sem; got = nil; gotErr = nil; lock.unlock()
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            _ = sem.wait(timeout: .now() + 30)
            lock.lock(); let t = got, err = gotErr; waiter = nil; lock.unlock()
            guard let t else { throw BErr(err ?? "net") }
            var c = PushStore.load() ?? PushStore.Cfg(kid: rnd(9).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""),
                                                      key: rnd(32).base64EncodedString(), lang: lang())
            c.lang = lang()
            guard PushStore.save(c) else { throw BErr("not_ready") }
            ud.set(t, forKey: "push_token")
            return ["token": t, "key": c.key, "kid": c.kid]
        case "disable":
            DispatchQueue.main.async { UIApplication.shared.unregisterForRemoteNotifications() }
            PushStore.clear()
            ud.removeObject(forKey: "push_token"); ud.removeObject(forKey: "push_reg")
            return [:]
        case "registered":
            ud.set(b.s(a, "token"), forKey: "push_reg")
            return [:]
        default: throw BErr("bad_op")
        }
    }

    func news(_ b: Bridge, _ a: [String: Any]) throws -> [String: Any] {
        switch b.s(a, "op") {
        case "state":
            let l = b.s(a, "lang")
            if l.count == 2, l != ud.string(forKey: "push_lang") {
                ud.set(l, forKey: "push_lang")
                if var c = PushStore.load(), c.lang != l { c.lang = l; PushStore.save(c) }   // Sprache der Druck-Meldungen folgt der App
            }
            lock.lock(); let go = pendingGo; pendingGo = nil; uiAsked = true; lock.unlock()
            return ["on": ud.object(forKey: "news_on") as? Bool ?? true, "perm": perm(), "go": go ?? NSNull()]
        case "set":
            let on = a["on"] as? Bool ?? false
            ud.set(on, forKey: "news_on")
            if on && status() == .notDetermined { _ = ask() }
            return ["on": on, "perm": perm()]
        case "seen":
            let n = b.i(a, "id")
            if n > ud.integer(forKey: "news_last") { ud.set(n, forKey: "news_last") }
            return [:]
        case "settings":
            DispatchQueue.main.async { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
            return [:]
        default: throw BErr("bad_op")
        }
    }

    // ── Meldungen ──
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])   // auch bei offener App zeigen
    }
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        defer { done() }
        guard let go = r.notification.request.content.userInfo["go"] as? String, go.range(of: "^(news|printers|maint|s[0-9]+)$", options: .regularExpression) != nil else { return }
        // Kaltstart: die Oberfläche fragt beim Laden nach (news state → go); läuft sie schon, gleich hinspringen
        lock.lock(); let ready = uiAsked; if !ready { pendingGo = go }; lock.unlock()
        if ready { DispatchQueue.main.async { self.vc?.js("window.AMP_ev && AMP_ev('go', {v: '\(go)'})") } }
    }
}
