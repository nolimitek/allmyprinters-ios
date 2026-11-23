import Foundation
import CryptoKit
import Security

// Gemeinsam für App und Notification Service Extension (23.11.2026): Schlüsselablage im geteilten Schlüsselbund, Entschlüsseln,
// Texte. Weg: Agent → allmyprinters.com/api/push.php → Apple (APNs, Token „apns:<hex>“) → Extension entschlüsselt k + c
// (AES-256-GCM, iv 12 Byte vorn, wie Push.kt) und setzt Titel/Text in der Sprache der App. Texte aus Notif.kt übernommen
// (tools: scratchpad-Generator) — bei Änderungen dort hier mitziehen.

/// Geteilter Schlüsselbund (keychain-access-groups $(AppIdentifierPrefix)com.allmyprinters.shared in App + Extension).
enum PushStore {
    struct Cfg: Codable { var kid: String; var key: String; var lang: String }
    private static let service = "com.allmyprinters.push"
    /// Info.plist AMPKeychainGroup = $(AppIdentifierPrefix)com.allmyprinters.shared; ohne Signatur (Simulator) ohne Team-Präfix → ohne Gruppe
    private static var group: String? {
        let g = Bundle.main.object(forInfoDictionaryKey: "AMPKeychainGroup") as? String ?? ""
        return g.contains(".com.") ? g : nil
    }
    private static func base(_ withGroup: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "cfg"]
        if withGroup, let g = group { q[kSecAttrAccessGroup as String] = g }
        return q
    }
    static func load() -> Cfg? {
        for wg in [true, false] {
            var q = base(wg); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let c = try? JSONDecoder().decode(Cfg.self, from: d) { return c }
        }
        return nil
    }
    @discardableResult static func save(_ c: Cfg) -> Bool {
        guard let d = try? JSONEncoder().encode(c) else { return false }
        clear()
        for wg in [true, false] {
            var q = base(wg); q[kSecValueData as String] = d
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock   // die Extension läuft auch bei gesperrtem Gerät (nach dem ersten Entsperren)
            if SecItemAdd(q as CFDictionary, nil) == errSecSuccess { return true }
        }
        return false
    }
    static func clear() { for wg in [true, false] { SecItemDelete(base(wg) as CFDictionary) } }
}

enum PushText {
    static func b64(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
    /// Nachricht vom Agenten öffnen; falscher Schlüssel / fremde Nachricht → nil
    static func open(key: String, c: String) -> [String: Any]? {
        guard let k = Data(base64Encoded: key), k.count == 32, let raw = b64(c), raw.count > 28,
              let box = try? AES.GCM.SealedBox(combined: raw), let pt = try? AES.GCM.open(box, using: SymmetricKey(data: k)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: pt)) as? [String: Any]
    }

    private static func str(_ m: [String: Any], _ k: String) -> String {
        if let s = m[k] as? String { return s }
        if let n = m[k] as? NSNumber { return n.stringValue }
        return ""
    }
    private static func int(_ m: [String: Any], _ k: String, _ d: Int = 0) -> Int { (m[k] as? NSNumber)?.intValue ?? Int(str(m, k)) ?? d }
    private static func has(_ m: [String: Any], _ k: String) -> Bool { if let v = m[k] { return !(v is NSNull) } else { return false } }

    /// Wie Notif.event/warn auf Android → (Titel, Text, Ziel beim Antippen, Gruppe)
    static func render(_ m: [String: Any], lang: String) -> (title: String, body: String, go: String, thread: String)? {
        let t = TX[lang] ?? TX["en"]!
        func tx(_ k: String) -> String { t[k] ?? TX["en"]![k] ?? "" }
        let e = str(m, "e"), p = str(m, "p").isEmpty ? "AllMyPrinters" : str(m, "p"), f = str(m, "f"), pid = int(m, "pid")
        if e == "test" { return (tx("test_t"), tx("test_b").replacingOccurrences(of: "{p}", with: p), "printers", "test") }
        if e == "low" {
            var bits: [String] = []
            if !str(m, "n").isEmpty { bits.append(str(m, "n")) }
            if !str(m, "sl").isEmpty { bits.append(tx("slot").replacingOccurrences(of: "{s}", with: str(m, "sl"))) }
            if has(m, "g") { bits.append("~\(int(m, "g")) g") } else if has(m, "pct") { bits.append("\(int(m, "pct")) %") }
            let sid = int(m, "sid")
            return (tx(int(m, "lv", 1) >= 2 ? "ev_low2" : "ev_low").replacingOccurrences(of: "{p}", with: p), bits.joined(separator: " · "), sid > 0 ? "s\(sid)" : "printers", "low\(pid)")
        }
        if e == "humid" {
            return (tx("ev_humid").replacingOccurrences(of: "{p}", with: p),
                    tx("humid_b").replacingOccurrences(of: "{b}", with: str(m, "b").isEmpty ? "Box" : str(m, "b")).replacingOccurrences(of: "{h}", with: String(int(m, "h"))), "printers", "humid\(pid)")
        }
        if e == "offline" {
            let days = str(m, "k") == "days"
            var body = days ? tx("off_days").replacingOccurrences(of: "{d}", with: String(int(m, "d", 7))) : tx("off_print")
            if !days && !f.isEmpty { body = f + "\n" + body }
            return (tx("ev_offline").replacingOccurrences(of: "{p}", with: p), body, "printers", "off\(pid)")
        }
        if e == "fail" {
            let hint = int(m, "pa") == 1 ? tx("fail_paused") : tx("fail_hint")
            return (tx("ev_fail").replacingOccurrences(of: "{p}", with: p), f.isEmpty ? hint : f + "\n" + hint, "printers", "fail\(pid)")
        }
        if e == "maint" {
            var k = str(m, "k"); if !["hours", "grams", "prints", "days"].contains(k) { k = "days" }
            let num = { (x: String) in lang == "en" ? x : x.replacingOccurrences(of: ".", with: ",") }
            let why = tx("mt_" + k).replacingOccurrences(of: "{u}", with: num(str(m, "u"))).replacingOccurrences(of: "{v}", with: num(str(m, "v")))
            let n = str(m, "n")
            return (tx("ev_maint").replacingOccurrences(of: "{p}", with: p), n.isEmpty ? why : n + "\n" + why, "maint", "maint\(pid)")
        }
        guard ["done", "cancel", "error", "pause", "start"].contains(e) else { return nil }
        var bits: [String] = []
        if !f.isEmpty { bits.append(f) }
        let s = int(m, "s")
        if e == "done" && s > 0 { bits.append(s >= 3600 ? "\(s / 3600) h \((s % 3600) / 60) min" : "\(max(1, s / 60)) min") }
        if e == "done", has(m, "g"), let g = (m["g"] as? NSNumber)?.doubleValue, g > 0 { bits.append(String(format: "%.0f g", g)) }
        if e == "pause" && has(m, "pr") { bits.append("\(int(m, "pr")) %") }
        var body = bits.joined(separator: " · ")
        let msg = str(m, "m")
        if e == "error" && !msg.isEmpty { body = body.isEmpty ? msg : body + "\n" + msg }
        if e == "pause" { body = body.isEmpty ? tx("pause_hint") : body + "\n" + tx("pause_hint") }
        return (tx("ev_" + e).replacingOccurrences(of: "{p}", with: p), body, "printers", "job\(pid)")
    }

    static let TX: [String: [String: String]] = [
        "de": ["ch_done": "Druck fertig", "ch_cancel": "Druck abgebrochen", "ch_error": "Fehler am Drucker", "ch_pause": "Druck pausiert", "ch_start": "Druck gestartet", "ch_news": "Neuigkeiten", "ev_done": "{p}: Druck fertig", "ev_cancel": "{p}: Druck abgebrochen", "ev_error": "{p}: Fehler", "ev_pause": "{p}: Druck pausiert", "ev_start": "{p}: Druck gestartet", "pause_hint": "Filament leer oder Pause? Am Drucker nachsehen.", "ch_fail": "Fehldruck-Verdacht", "ev_fail": "{p}: möglicher Fehldruck", "fail_hint": "Die Kamera sieht etwas wie Spaghetti. Bitte nachsehen.", "fail_paused": "Die Kamera sieht etwas wie Spaghetti – Druck pausiert. Bitte nachsehen.", "test_t": "AllMyPrinters: Test", "test_b": "Benachrichtigungen von {p} kommen an.", "ch_maint": "Wartung fällig", "ev_maint": "{p}: Wartung fällig", "mt_hours": "{u} von {v} Druckstunden", "mt_grams": "{u} von {v} kg Filament", "mt_prints": "{u} von {v} Drucken", "mt_days": "{u} von {v} Tagen", "ch_low": "Spule bald leer", "ch_humid": "Filamentbox zu feucht", "ch_offline": "Drucker nicht erreichbar", "ev_low": "{p}: Spule bald leer", "ev_low2": "{p}: Spule fast leer", "slot": "Fach {s}", "ev_humid": "{p}: Box zu feucht", "humid_b": "{b}: {h} % Luftfeuchte seit über einer Stunde. Filament trocknen empfohlen.", "ev_offline": "{p}: nicht erreichbar", "off_print": "Seit 5 Minuten keine Verbindung, obwohl ein Druck lief. Strom, WLAN oder Absturz? Am Drucker nachsehen.", "off_days": "Seit {d} Tagen keine Verbindung. Ist er nur ausgeschaltet, kannst du das ignorieren, sonst die Adresse in der App prüfen."],
        "en": ["ch_done": "Print finished", "ch_cancel": "Print cancelled", "ch_error": "Printer error", "ch_pause": "Print paused", "ch_start": "Print started", "ch_news": "News", "ev_done": "{p}: print finished", "ev_cancel": "{p}: print cancelled", "ev_error": "{p}: error", "ev_pause": "{p}: print paused", "ev_start": "{p}: print started", "pause_hint": "Out of filament or a pause? Check the printer.", "ch_fail": "Possible print failure", "ev_fail": "{p}: possible print failure", "fail_hint": "The camera sees something like spaghetti. Please check.", "fail_paused": "The camera sees something like spaghetti – print paused. Please check.", "test_t": "AllMyPrinters: test", "test_b": "Notifications from {p} are arriving.", "ch_maint": "Maintenance due", "ev_maint": "{p}: maintenance due", "mt_hours": "{u} of {v} print hours", "mt_grams": "{u} of {v} kg of filament", "mt_prints": "{u} of {v} prints", "mt_days": "{u} of {v} days", "ch_low": "Spool running low", "ch_humid": "Filament box too humid", "ch_offline": "Printer unreachable", "ev_low": "{p}: spool running low", "ev_low2": "{p}: spool almost empty", "slot": "slot {s}", "ev_humid": "{p}: box too humid", "humid_b": "{b}: {h} % humidity for over an hour. Drying the filament is recommended.", "ev_offline": "{p}: not reachable", "off_print": "No connection for 5 minutes while a print was running. Power, Wi-Fi or a crash? Check the printer.", "off_days": "No connection for {d} days. If it is just switched off, ignore this; otherwise check its address in the app."],
        "fr": ["ch_done": "Impression terminée", "ch_cancel": "Impression annulée", "ch_error": "Erreur de l’imprimante", "ch_pause": "Impression en pause", "ch_start": "Impression démarrée", "ch_news": "Nouveautés", "ev_done": "{p} : impression terminée", "ev_cancel": "{p} : impression annulée", "ev_error": "{p} : erreur", "ev_pause": "{p} : impression en pause", "ev_start": "{p} : impression démarrée", "pause_hint": "Plus de filament ou pause ? Vérifiez l’imprimante.", "ch_fail": "Échec d’impression possible", "ev_fail": "{p} : échec d’impression possible", "fail_hint": "La caméra voit quelque chose qui ressemble à des spaghettis. Vérifiez l’imprimante.", "fail_paused": "La caméra voit quelque chose qui ressemble à des spaghettis – impression en pause. Vérifiez l’imprimante.", "test_t": "AllMyPrinters : test", "test_b": "Les notifications de {p} arrivent bien.", "ch_maint": "Entretien à faire", "ev_maint": "{p} : entretien à faire", "mt_hours": "{u} sur {v} heures d’impression", "mt_grams": "{u} sur {v} kg de filament", "mt_prints": "{u} sur {v} impressions", "mt_days": "{u} sur {v} jours", "ch_low": "Bobine bientôt vide", "ch_humid": "Boîte à filament trop humide", "ch_offline": "Imprimante injoignable", "ev_low": "{p} : bobine bientôt vide", "ev_low2": "{p} : bobine presque vide", "slot": "emplacement {s}", "ev_humid": "{p} : boîte trop humide", "humid_b": "{b} : {h} % d’humidité depuis plus d’une heure. Il est conseillé de sécher le filament.", "ev_offline": "{p} : injoignable", "off_print": "Aucune connexion depuis 5 minutes pendant une impression. Courant, Wi-Fi ou plantage ? Vérifiez l’imprimante.", "off_days": "Aucune connexion depuis {d} jours. Si elle est simplement éteinte, ignorez ce message ; sinon vérifiez son adresse dans l’app."],
        "es": ["ch_done": "Impresión terminada", "ch_cancel": "Impresión cancelada", "ch_error": "Error de la impresora", "ch_pause": "Impresión en pausa", "ch_start": "Impresión iniciada", "ch_news": "Novedades", "ev_done": "{p}: impresión terminada", "ev_cancel": "{p}: impresión cancelada", "ev_error": "{p}: error", "ev_pause": "{p}: impresión en pausa", "ev_start": "{p}: impresión iniciada", "pause_hint": "¿Sin filamento o una pausa? Revisa la impresora.", "ch_fail": "Posible fallo de impresión", "ev_fail": "{p}: posible fallo de impresión", "fail_hint": "La cámara ve algo parecido a espaguetis. Revisa la impresora.", "fail_paused": "La cámara ve algo parecido a espaguetis: impresión en pausa. Revisa la impresora.", "test_t": "AllMyPrinters: prueba", "test_b": "Las notificaciones de {p} llegan bien.", "ch_maint": "Mantenimiento pendiente", "ev_maint": "{p}: mantenimiento pendiente", "mt_hours": "{u} de {v} horas de impresión", "mt_grams": "{u} de {v} kg de filamento", "mt_prints": "{u} de {v} impresiones", "mt_days": "{u} de {v} días", "ch_low": "Bobina a punto de acabarse", "ch_humid": "Caja de filamento demasiado húmeda", "ch_offline": "Impresora sin conexión", "ev_low": "{p}: bobina a punto de acabarse", "ev_low2": "{p}: bobina casi vacía", "slot": "ranura {s}", "ev_humid": "{p}: caja demasiado húmeda", "humid_b": "{b}: {h} % de humedad desde hace más de una hora. Se recomienda secar el filamento.", "ev_offline": "{p}: sin conexión", "off_print": "Sin conexión desde hace 5 minutos mientras imprimía. ¿Corriente, Wi-Fi o un fallo? Revisa la impresora.", "off_days": "Sin conexión desde hace {d} días. Si solo está apagada, ignora este aviso; si no, revisa su dirección en la app."],
        "it": ["ch_done": "Stampa completata", "ch_cancel": "Stampa annullata", "ch_error": "Errore della stampante", "ch_pause": "Stampa in pausa", "ch_start": "Stampa avviata", "ch_news": "Novità", "ev_done": "{p}: stampa completata", "ev_cancel": "{p}: stampa annullata", "ev_error": "{p}: errore", "ev_pause": "{p}: stampa in pausa", "ev_start": "{p}: stampa avviata", "pause_hint": "Filamento finito o pausa? Controlla la stampante.", "ch_fail": "Possibile stampa fallita", "ev_fail": "{p}: possibile stampa fallita", "fail_hint": "La telecamera vede qualcosa di simile a spaghetti. Controlla la stampante.", "fail_paused": "La telecamera vede qualcosa di simile a spaghetti – stampa in pausa. Controlla la stampante.", "test_t": "AllMyPrinters: prova", "test_b": "Le notifiche di {p} arrivano.", "ch_maint": "Manutenzione da fare", "ev_maint": "{p}: manutenzione da fare", "mt_hours": "{u} di {v} ore di stampa", "mt_grams": "{u} di {v} kg di filamento", "mt_prints": "{u} di {v} stampe", "mt_days": "{u} di {v} giorni", "ch_low": "Bobina quasi finita", "ch_humid": "Box filamento troppo umido", "ch_offline": "Stampante non raggiungibile", "ev_low": "{p}: bobina quasi finita", "ev_low2": "{p}: bobina praticamente vuota", "slot": "slot {s}", "ev_humid": "{p}: box troppo umido", "humid_b": "{b}: {h} % di umidità da oltre un’ora. Si consiglia di essiccare il filamento.", "ev_offline": "{p}: non raggiungibile", "off_print": "Nessuna connessione da 5 minuti durante una stampa. Corrente, Wi-Fi o un blocco? Controlla la stampante.", "off_days": "Nessuna connessione da {d} giorni. Se è solo spenta, ignora questo messaggio; altrimenti controlla il suo indirizzo nell’app."],
        "nl": ["ch_done": "Print klaar", "ch_cancel": "Print afgebroken", "ch_error": "Printerfout", "ch_pause": "Print gepauzeerd", "ch_start": "Print gestart", "ch_news": "Nieuws", "ev_done": "{p}: print klaar", "ev_cancel": "{p}: print afgebroken", "ev_error": "{p}: fout", "ev_pause": "{p}: print gepauzeerd", "ev_start": "{p}: print gestart", "pause_hint": "Filament op of een pauze? Kijk bij de printer.", "ch_fail": "Mogelijk mislukte print", "ev_fail": "{p}: mogelijk mislukte print", "fail_hint": "De camera ziet iets wat op spaghetti lijkt. Kijk bij de printer.", "fail_paused": "De camera ziet iets wat op spaghetti lijkt – print gepauzeerd. Kijk bij de printer.", "test_t": "AllMyPrinters: test", "test_b": "Meldingen van {p} komen aan.", "ch_maint": "Onderhoud nodig", "ev_maint": "{p}: onderhoud nodig", "mt_hours": "{u} van {v} printuren", "mt_grams": "{u} van {v} kg filament", "mt_prints": "{u} van {v} prints", "mt_days": "{u} van {v} dagen", "ch_low": "Spoel bijna op", "ch_humid": "Filamentbox te vochtig", "ch_offline": "Printer niet bereikbaar", "ev_low": "{p}: spoel bijna op", "ev_low2": "{p}: spoel zo goed als leeg", "slot": "slot {s}", "ev_humid": "{p}: box te vochtig", "humid_b": "{b}: {h} % luchtvochtigheid, al meer dan een uur. Filament drogen is aan te raden.", "ev_offline": "{p}: niet bereikbaar", "off_print": "Al 5 minuten geen verbinding terwijl er een print liep. Stroom, wifi of een crash? Kijk bij de printer.", "off_days": "Al {d} dagen geen verbinding. Staat hij gewoon uit, negeer dit dan; controleer anders zijn adres in de app."],
    ]
}
