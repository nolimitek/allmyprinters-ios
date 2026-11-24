import UIKit
#if canImport(CoreNFC)
import CoreNFC
#endif

/// NFC-Spulenetiketten (24.11.2026, wie Nfc.kt auf Android): Kennung (UID, Hex groß ohne Trenner) und OpenSpool-Inhalt lesen
/// → Ereignis „nfc“ {uid, type, techs, openspool}; Tag mit OpenSpool beschreiben → Ereignis „nfc_write“ {ok, uid, type, error, size}.
/// Unterschied zu Android: Das iPhone liest nur in einer Sitzung, die die App ausdrücklich startet (Systemfenster „Halte dein iPhone
/// an …“). Gestartet wird sie von „Tag verknüpfen“ (Brücke nfc_scan, die Oberfläche ruft es über WebViewController.shim auf) und von
/// „Tag beschreiben“ (nfc_write). MIFARE Classic (Bambu, Creality CFS, QIDI) erkennt das iPhone nicht — nur NTAG/Ultralight,
/// ISO 15693, FeliCa, ISO 7816. Nie sperren, fremde Daten nur nach Rückfrage (force) überschreiben — wie Android.
final class Nfc: NSObject {
    static let shared = Nfc()
    weak var bridge: Bridge?

    #if canImport(CoreNFC)
    private var session: NFCTagReaderSession?
    #endif
    private var writeJson: String?
    private var writeForce = false
    private var finished = false

    static var available: Bool {
        #if canImport(CoreNFC)
        return NFCTagReaderSession.readingAvailable
        #else
        return false
        #endif
    }

    func state() -> [String: Any] { ["available": Self.available, "enabled": Self.available, "session": true] }

    /// Nächsten Tag lesen (Systemfenster)
    func scan(_ b: Bridge) -> [String: Any] {
        guard Self.available else { return ["ok": false, "error": "unavailable"] }
        bridge = b
        start(json: nil, force: false)
        return ["ok": true]
    }

    /// Nächsten Tag beschreiben (json = OpenSpool, kompakt; NTAG215 ~490 Byte Nutzlast)
    func arm(_ b: Bridge, json: String, force: Bool) -> [String: Any] {
        if json.count > 480 || !json.contains("openspool") { return ["ok": false, "error": "bad"] }
        guard Self.available else { return ["ok": false, "error": "unavailable"] }
        bridge = b
        start(json: json, force: force)
        return ["ok": true]
    }

    func disarm() -> [String: Any] {
        #if canImport(CoreNFC)
        DispatchQueue.main.async { self.writeJson = nil; self.finished = true; self.session?.invalidate(); self.session = nil }
        #endif
        return ["ok": true]
    }

    // Texte im Systemfenster (Sprache der App, push_lang)
    private static let T: [String: [String]] = [
        "de": ["Halte dein iPhone an das NFC-Etikett der Spule.", "Halte dein iPhone an das Etikett, um es zu beschreiben.", "Erledigt", "Das ging nicht."],
        "en": ["Hold your iPhone near the spool’s NFC tag.", "Hold your iPhone near the tag to write it.", "Done", "That didn’t work."],
        "fr": ["Approche ton iPhone de l’étiquette NFC de la bobine.", "Approche ton iPhone de l’étiquette pour l’écrire.", "Terminé", "Ça n’a pas marché."],
        "es": ["Acerca tu iPhone a la etiqueta NFC de la bobina.", "Acerca tu iPhone a la etiqueta para escribirla.", "Listo", "No ha funcionado."],
        "it": ["Avvicina l’iPhone al tag NFC della bobina.", "Avvicina l’iPhone al tag per scriverlo.", "Fatto", "Non ha funzionato."],
        "nl": ["Houd je iPhone bij de NFC-tag van de spoel.", "Houd je iPhone bij de tag om hem te beschrijven.", "Klaar", "Dat lukte niet."],
    ]
    private static func t(_ i: Int) -> String {
        let l = UserDefaults.standard.string(forKey: "push_lang") ?? String((Locale.preferredLanguages.first ?? "en").prefix(2))
        return (T[l] ?? T["en"]!)[i]
    }

    private func emit(_ name: String, _ d: [String: Any]) { DispatchQueue.main.async { self.bridge?.event(name, d) } }

    #if canImport(CoreNFC)
    private func start(json: String?, force: Bool) {
        DispatchQueue.main.async {
            self.finished = true
            self.session?.invalidate()
            self.writeJson = json; self.writeForce = force; self.finished = false
            guard let s = NFCTagReaderSession(pollingOption: [.iso14443, .iso15693], delegate: self, queue: nil) else {
                if json != nil { self.emit("nfc_write", ["ok": false, "error": "unsupported"]) }
                return
            }
            s.alertMessage = Self.t(json == nil ? 0 : 1)
            self.session = s
            s.begin()
        }
    }
    #else
    private func start(json: String?, force: Bool) {}
    #endif
}

#if canImport(CoreNFC)
extension Nfc: NFCTagReaderSessionDelegate {
    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        DispatchQueue.main.async {
            guard self.session === session else { return }
            self.session = nil
            // Fenster weggewischt / Zeit abgelaufen, bevor ein Tag kam: Schreiben meldet „io“ (Oberfläche bietet „Nochmal“)
            if !self.finished, self.writeJson != nil { self.finished = true; self.writeJson = nil; self.emit("nfc_write", ["ok": false, "error": "io", "detail": "cancel"]) }
        }
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard let tag = tags.first else { return }
        if tags.count > 1 { session.alertMessage = Self.t(3); session.restartPolling(); return }
        session.connect(to: tag) { err in
            if let err { session.invalidate(errorMessage: Self.t(3)); Log.write("nfc connect \(err)"); return }
            let (uid, type, techs, ndef) = Self.info(tag)
            if let json = self.writeJson {
                self.write(session, ndef, uid: uid, type: type, json: json, force: self.writeForce)
                return
            }
            // Lesen: OpenSpool = erster NDEF-Record mit MIME application/json und „openspool“
            guard let ndef else { self.done(session, ["uid": uid, "type": type, "techs": techs]); return }
            ndef.readNDEF { msg, _ in
                var o: [String: Any] = ["uid": uid, "type": type, "techs": techs]
                for r in msg?.records ?? [] where r.typeNameFormat == .media && String(decoding: r.type, as: UTF8.self).lowercased() == "application/json" {
                    let s = String(decoding: r.payload, as: UTF8.self)
                    if s.count < 4000 && s.lowercased().contains("openspool") { o["openspool"] = s; break }
                }
                self.done(session, o)
            }
        }
    }

    private func done(_ session: NFCTagReaderSession, _ o: [String: Any]) {
        DispatchQueue.main.async { self.finished = true }
        session.alertMessage = Self.t(2)
        session.invalidate()
        emit("nfc", o)
    }

    /// UID (Hex groß), Tag-Art wie Android (ntag, nfcv, isodep, nfcf, mifare), Techniken, NDEF-Zugang
    private static func info(_ tag: NFCTag) -> (String, String, [String], NFCNDEFTag?) {
        let hex = { (d: Data) in d.map { String(format: "%02X", $0) }.joined() }
        switch tag {
        case .miFare(let m):
            let ty = m.mifareFamily == .ultralight ? "ntag" : m.mifareFamily == .desfire ? "isodep" : "mifare"
            return (hex(m.identifier), ty, ["NfcA", m.mifareFamily == .ultralight ? "MifareUltralight" : "IsoDep"], m)
        case .iso15693(let v): return (hex(v.identifier), "nfcv", ["NfcV"], v)
        case .iso7816(let i): return (hex(i.identifier), "isodep", ["IsoDep"], i)
        case .feliCa(let f): return (hex(f.currentIDm), "nfcf", ["NfcF"], f)
        @unknown default: return ("", "?", [], nil)
        }
    }

    private func isOpenSpool(_ r: NFCNDEFPayload) -> Bool {
        r.typeNameFormat == .media && String(decoding: r.type, as: UTF8.self).lowercased() == "application/json" &&
            String(decoding: r.payload, as: UTF8.self).lowercased().contains("openspool")
    }

    /// OpenSpool als einzige NDEF-Nachricht schreiben. Fehler wie Android: readonly, too_small, foreign, unsupported, io
    private func write(_ session: NFCTagReaderSession, _ ndef: NFCNDEFTag?, uid: String, type: String, json: String, force: Bool) {
        let fin = { (o: [String: Any]) in
            var r = o; r["uid"] = uid; r["type"] = type
            DispatchQueue.main.async { self.finished = true; self.writeJson = nil }
            if r["ok"] as? Bool == true { session.alertMessage = Self.t(2); session.invalidate() }
            else if r["error"] as? String == "foreign" { session.invalidate() }   // erst die Rückfrage in der App
            else { session.invalidate(errorMessage: Self.t(3)) }
            self.emit("nfc_write", r)
        }
        guard let ndef else { fin(["ok": false, "error": "unsupported"]); return }
        let payload = NFCNDEFPayload(format: .media, type: Data("application/json".utf8), identifier: Data(), payload: Data(json.utf8))
        let msg = NFCNDEFMessage(records: [payload])
        ndef.queryNDEFStatus { st, cap, err in
            if let err { fin(["ok": false, "error": "io", "detail": String(String(describing: err).prefix(120))]); return }
            switch st {
            case .notSupported:
                // nicht als NDEF eingerichtet: Rohdaten (z. B. Anycubic ACE) nur nach Rückfrage — einrichten kann das iPhone ihn nicht
                self.rawData(ndef) { raw in fin(raw && !force ? ["ok": false, "error": "foreign"] : ["ok": false, "error": "unsupported"]) }
            case .readOnly: fin(["ok": false, "error": "readonly"])
            case .readWrite:
                if msg.length > cap { fin(["ok": false, "error": "too_small", "max": cap, "need": msg.length]); return }
                let go = { ndef.writeNDEF(msg) { e in fin(e == nil ? ["ok": true, "size": msg.length] : ["ok": false, "error": "io", "detail": String(String(describing: e!).prefix(120))]) } }
                if force { go(); return }
                // Anderer Inhalt als OpenSpool → erst fragen; leerer Tag (Lesefehler „leere Nachricht“) → schreiben
                ndef.readNDEF { cur, e in
                    if let e = e as NSError?, e.code != NFCReaderError.ndefReaderSessionErrorZeroLengthMessage.rawValue { fin(["ok": false, "error": "foreign"]); return }
                    if (cur?.records ?? []).contains(where: { $0.typeNameFormat != .empty && !self.isOpenSpool($0) }) { fin(["ok": false, "error": "foreign"]); return }
                    go()
                }
            @unknown default: fin(["ok": false, "error": "unsupported"])
            }
        }
    }

    /// Stehen ab Page 4 Daten (NTAG ohne NDEF)? Nur bei MIFARE Ultralight/NTAG prüfbar, sonst nein
    private func rawData(_ ndef: NFCNDEFTag, _ cb: @escaping (Bool) -> Void) {
        guard let m = ndef as? NFCMiFareTag, m.mifareFamily == .ultralight else { cb(false); return }
        m.sendMiFareCommand(commandPacket: Data([0x30, 0x04])) { d, e in cb(e == nil && d.contains { $0 != 0 }) }
    }
}
#endif
