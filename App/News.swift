import UIKit
import BackgroundTasks
import UserNotifications

/// Neuigkeiten als Mitteilung, auch wenn die App zu ist (24.11.2026, wie News.kt auf Android): etwa alle 12 Stunden — den genauen
/// Zeitpunkt entscheidet iOS (BGAppRefreshTask, abhängig davon, wie oft die App benutzt wird) — allmyprinters.com/news.json holen und
/// Neues melden. Gemeldet wird nur, was nach der Installation erschien und höchstens 14 Tage alt ist (höchstens 3 auf einmal);
/// in der App gelesen (Brücke news seen → news_last) = nicht mehr melden. Schalter: Einstellungen → Benachrichtigungen (news_on),
/// Sprache wie die App (push_lang, setzt die Oberfläche über news state). Antippen öffnet „Mehr → Neuigkeiten“ (go = news, Push.swift).
enum News {
    static let task = "com.allmyprinters.app.news"
    static let url = "https://allmyprinters.com/news.json"

    /// Beim Start (vor Ende von didFinishLaunching) anmelden
    static func register() {
        let ok = BGTaskScheduler.shared.register(forTaskWithIdentifier: task, using: nil) { t in
            schedule()   // nächsten Abruf gleich wieder anmelden
            let once = Once()
            t.expirationHandler = { once.run { t.setTaskCompleted(success: false) } }
            DispatchQueue.global(qos: .utility).async {
                let r = (try? check()) ?? []
                Log.write("news bg \(r)")
                once.run { t.setTaskCompleted(success: true) }
            }
        }
        if !ok { Log.write("news: Hintergrundabruf nicht angemeldet (Info.plist BGTaskSchedulerPermittedIdentifiers?)") }
    }

    /// Nächsten Abruf frühestens in 12 Stunden (beim Start und beim Wechsel in den Hintergrund)
    static func schedule() {
        let r = BGAppRefreshTaskRequest(identifier: task)
        r.earliestBeginDate = Date(timeIntervalSinceNow: 12 * 3600)
        do { try BGTaskScheduler.shared.submit(r) } catch { Log.write("news schedule: \(error)") }
    }

    /// Abrufen und Neues melden → Nummern der gemeldeten Neuigkeiten (erster Abruf nach der Installation: nichts nachmelden)
    @discardableResult
    static func check(from src: String = url) throws -> [Int] {
        let ud = UserDefaults.standard
        guard ud.object(forKey: "news_on") as? Bool ?? true else { return [] }
        guard let u = URL(string: src + "?t=\(Int(Date().timeIntervalSince1970 / 600))") else { return [] }
        var rq = URLRequest(url: u)
        rq.timeoutInterval = 20
        rq.cachePolicy = .reloadIgnoringLocalCacheData
        let job = Net.Job()
        job.max = 1 << 20
        try Net.shared.run(rq, job: job)
        guard job.resp?.statusCode == 200, let j = try JSONSerialization.jsonObject(with: job.data) as? [String: Any],
              let items = j["items"] as? [[String: Any]] else { return [] }
        let last = ud.object(forKey: "news_last") == nil ? -1 : ud.integer(forKey: "news_last")
        let lang = ud.string(forKey: "push_lang") ?? String((Locale.preferredLanguages.first ?? "en").prefix(2))
        let iso = ISO8601DateFormatter()
        var maxId = 0
        var fresh: [[String: Any]] = []
        for x in items {
            let id = (x["id"] as? NSNumber)?.intValue ?? 0
            if id <= 0 { continue }
            maxId = max(maxId, id)
            let at = iso.date(from: x["at"] as? String ?? "") ?? .distantPast
            if last >= 0 && id > last && Date().timeIntervalSince(at) < 14 * 86400 { fresh.append(x) }
        }
        if last < 0 { ud.set(maxId, forKey: "news_last"); return [] }
        fresh.sort { (($0["id"] as? NSNumber)?.intValue ?? 0) < (($1["id"] as? NSNumber)?.intValue ?? 0) }
        var sent: [Int] = []
        for x in fresh.suffix(3) {
            let id = (x["id"] as? NSNumber)?.intValue ?? 0
            let pick = { (k: String) -> String in let d = x[k] as? [String: Any]; return (d?[lang] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (d?["en"] as? String) ?? "" }
            let c = UNMutableNotificationContent()
            c.title = pick("t").isEmpty ? "AllMyPrinters" : pick("t")
            c.body = pick("b")
            c.sound = .default
            c.threadIdentifier = "news"
            c.userInfo = ["go": "news"]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "news-\(id)", content: c, trigger: nil))
            sent.append(id)
        }
        if maxId > last { ud.set(maxId, forKey: "news_last") }
        return sent
    }

    /// Nur Simulator-Lauf (-ampDiag 1): gegen den Nachbau (ci/mocks.js :8767), Stand vorher und nachher zurücksetzen
    static func diag(_ src: String) -> [String: Any] {
        let ud = UserDefaults.standard
        let had = ud.object(forKey: "news_last")
        ud.removeObject(forKey: "news_last")
        var o: [String: Any] = [:]
        do { o["first"] = try check(from: src); o["after_first"] = ud.integer(forKey: "news_last"); o["second"] = try check(from: src); o["after_second"] = ud.integer(forKey: "news_last") }
        catch { o["err"] = String(describing: error) }
        if let had { ud.set(had, forKey: "news_last") } else { ud.removeObject(forKey: "news_last") }
        let sem = DispatchSemaphore(value: 0)
        BGTaskScheduler.shared.getPendingTaskRequests { r in o["pending"] = r.map { $0.identifier }; sem.signal() }
        _ = sem.wait(timeout: .now() + 3)
        return o
    }
}

/// Genau einmal ausführen (Ende einer Hintergrundaufgabe: fertig oder abgelaufen)
final class Once {
    private let l = NSLock()
    private var done = false
    func run(_ f: () -> Void) { l.lock(); let first = !done; done = true; l.unlock(); if first { f() } }
}
