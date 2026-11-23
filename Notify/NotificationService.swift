import UserNotifications

/// Druck-Meldung vom Agenten entschlüsseln (23.11.2026). Apple liefert eine sichtbare Meldung mit mutable-content und dem
/// Geheimtext (k = Schlüsselkennung, c = AES-256-GCM); hier entsteht Titel + Text in der Sprache der App. Klappt das nicht
/// (Schlüssel fehlt, fremde Nachricht), bleibt Apples Ersatztext aus Localizable.strings (AMP_PUSH_T / AMP_PUSH_B).
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        guard let b = request.content.mutableCopy() as? UNMutableNotificationContent else { contentHandler(request.content); return }
        best = b
        let u = request.content.userInfo
        if let k = u["k"] as? String, let c = u["c"] as? String, let cfg = PushStore.load(), cfg.kid == k,
           let m = PushText.open(key: cfg.key, c: c), let r = PushText.render(m, lang: cfg.lang) {
            b.title = r.title
            b.body = r.body
            b.threadIdentifier = r.thread
            b.userInfo = ["go": r.go]
        }
        contentHandler(b)
    }

    override func serviceExtensionTimeWillExpire() {
        if let h = handler, let b = best { h(b) }
    }
}
