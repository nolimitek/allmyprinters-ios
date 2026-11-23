import Foundation

/// Agent-Modus (wie Android, 11.11.2026): gekoppelt zeigt die App allmyprinters.com/web — die Oberfläche des AllMyPrinters-Agenten
/// durch den Tunnel (zu Hause direkt per ws://, unterwegs über den Weiterleiter). Die App bucht dann nicht selbst.
/// Dateien in Application Support/amp: agent_migrate.json (Umzug beim Koppeln), agent_snapshot.json (laufende Kopie des Agent-Stands,
/// nur zur Rettung), agent_restore.json (Stand, den die App nach dem Trennen übernimmt).
enum Agent {
    static let host = "allmyprinters.com"
    static var url: String? {
        get { UserDefaults.standard.string(forKey: "agent_url") }
        set { if let v = newValue { UserDefaults.standard.set(v, forKey: "agent_url") } else { UserDefaults.standard.removeObject(forKey: "agent_url") } }
    }
    static func okLink(_ s: String) -> Bool {
        guard let u = URLComponents(string: s) else { return false }
        return u.scheme == "https" && u.host == host && u.path.hasPrefix("/web")
    }
}

extension Bridge {
    private var migFile: URL { store.dataDir.appendingPathComponent("agent_migrate.json") }
    private var snapFile: URL { store.dataDir.appendingPathComponent("agent_snapshot.json") }
    private var restoreFile: URL { store.dataDir.appendingPathComponent("agent_restore.json") }
    private func writeJSON(_ f: URL, _ o: [String: Any]) throws { try JSONSerialization.data(withJSONObject: o).write(to: f, options: .atomic) }
    private func readJSON(_ f: URL) -> [String: Any]? { (try? Data(contentsOf: f)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }

    /// Koppeln: Daten der App merken (die Agent-Seite fragt nach dem Koppeln nach dem Umzug), dann den Link aus dem QR-Code öffnen
    func agentCouple(_ a: [String: Any]) throws -> [String: Any] {
        let url = try req(a, "url")
        guard Agent.okLink(url) else { throw BErr("IllegalArgumentException", "bad_link") }
        if let ex = a["export"] as? String { try writeJSON(migFile, ["text": ex, "spools": i(a, "spools"), "printers": i(a, "printers")]) }
        DispatchQueue.main.async { self.vc?.openAgent(url) }
        return ["ok": true]
    }

    func agentMigrate(_ a: [String: Any]) throws -> [String: Any] {
        switch s(a, "op") {
        case "peek":
            guard let j = readJSON(migFile) else { return ["pending": false] }
            return ["pending": true, "spools": j["spools"] ?? 0, "printers": j["printers"] ?? 0]
        case "take": return ["text": readJSON(migFile)?["text"] as? String ?? ""]
        case "done": try? store.fm.removeItem(at: migFile); return [String: Any]()
        default: throw BErr("IllegalArgumentException", "op")
        }
    }

    func agentSnapshot(_ a: [String: Any]) throws -> [String: Any] {
        let at = { () -> Int64 in Int64(((try? self.store.fm.attributesOfItem(atPath: self.snapFile.path))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000 }
        if s(a, "op") == "info" { return ["at": store.fm.fileExists(atPath: snapFile.path) ? at() : 0] }
        let text = try req(a, "text")
        guard text.contains("\"AllMyPrinters\"") else { throw BErr("IllegalArgumentException", "bad_file") }
        try Data(text.utf8).write(to: snapFile, options: .atomic)
        return ["at": at()]
    }

    /// Trennen: aktuellen Stand vom Agenten (text) oder die letzte Kopie übernehmen, dann die eigene Oberfläche laden. cancel = ohne Datenwechsel.
    func agentLeave(_ a: [String: Any]) throws -> [String: Any] {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if a["cancel"] as? Bool == true { try? store.fm.removeItem(at: migFile) }
        else if let t = a["text"] as? String { try writeJSON(restoreFile, ["text": t, "at": now, "kind": "live"]) }
        else if let t = try? String(contentsOf: snapFile, encoding: .utf8) {
            let at = Int64((((try? store.fm.attributesOfItem(atPath: snapFile.path))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000)
            try writeJSON(restoreFile, ["text": t, "at": at, "kind": "copy"])
        }
        DispatchQueue.main.async { self.vc?.openLocal() }
        return ["ok": true]
    }

    /// Eigene Oberfläche nach dem Trennen: zu übernehmenden Stand holen (get) und nach erfolgreichem Import löschen (done)
    func agentRestore(_ a: [String: Any]) -> [String: Any] {
        if s(a, "op", "get") == "done" { try? store.fm.removeItem(at: restoreFile); return [String: Any]() }
        return readJSON(restoreFile) ?? [String: Any]()
    }
}

/// WebSocket für die Agent-Seite (https): WKWebView verbietet von dort ws:// ins Heimnetz (Mixed Content). Die Seite bekommt einen
/// Ersatz (WebViewController.shim → window.WebSocket für ws://), der hier über einen eigenen Socket läuft — nur zu Adressen im eigenen Netz.
final class NativeWS {
    private static let lock = NSLock()
    private static var conns: [String: NativeWS] = [:]
    let sid: String
    weak var bridge: Bridge?
    private var sock: Sock?
    private let wlock = NSLock()
    private var closed = false

    init(sid: String, bridge: Bridge) { self.sid = sid; self.bridge = bridge }

    static func open(_ b: Bridge, sid: String, url: String, protocols: [String]) {
        let w = NativeWS(sid: sid, bridge: b)
        lock.lock(); conns[sid] = w; lock.unlock()
        Thread.detachNewThread { w.run(url, protocols) }
    }
    static func get(_ sid: String) -> NativeWS? { lock.lock(); defer { lock.unlock() }; return conns[sid] }

    private func emit(_ t: String, _ d: Any) { bridge?.vc?.js("window.__ampWs && __ampWs(\(Bridge.json(sid)), \(Bridge.json(t)), \(Bridge.json(d)))") }

    private func run(_ url: String, _ protocols: [String]) {
        var code = 1006, reason = ""
        do {
            guard let u = URLComponents(string: url), u.scheme == "ws", let host = u.host else { throw BErr("IllegalArgumentException", "bad_url") }
            guard Cam.privateURL("http://" + host) else { throw BErr("SecurityException", "not_private") }
            let port = u.port ?? 80
            let s = try Sock(host: host, port: port, tls: false, connectTimeoutMs: 6000)
            sock = s
            s.readTimeout = 3600
            var path = u.percentEncodedPath.isEmpty ? "/" : u.percentEncodedPath
            if let q = u.percentEncodedQuery { path += "?" + q }
            let key = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
            var rq = "GET \(path) HTTP/1.1\r\nHost: \(host):\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n"
            if !protocols.isEmpty { rq += "Sec-WebSocket-Protocol: \(protocols.joined(separator: ", "))\r\n" }
            try s.write(Data((rq + "\r\n").utf8))
            var head = Data()
            while !head.suffix(4).elementsEqual([13, 10, 13, 10]) { head.append(try s.byte()); if head.count > 8192 { throw BErr("IOException", "bad upgrade") } }
            guard String(decoding: head, as: UTF8.self).hasPrefix("HTTP/1.1 101") else { throw BErr("IOException", "no upgrade") }
            emit("open", NSNull())
            var msg = Data(), msgOp: UInt8 = 1
            while true {
                let (op, fin, p) = try Live.wsRead(s, max: 64 << 20)
                switch op {
                case 8:
                    if p.count >= 2 { code = Int(p[p.startIndex]) << 8 | Int(p[p.startIndex + 1]); reason = String(decoding: p.dropFirst(2), as: UTF8.self) } else { code = 1005 }
                    try? send(Live.wsFrame(p, 8))
                    throw BErr("IOException", "closed")
                case 9: try send(Live.wsFrame(p, 10)); continue
                case 10: continue
                case 0: msg.append(p)
                default: msg = p; msgOp = op
                }
                if !fin { continue }
                if msgOp == 1 { emit("text", String(decoding: msg, as: UTF8.self)) } else { emit("bin", msg.base64EncodedString()) }
                msg = Data()
            }
        } catch {
            if code == 1006 { Log.write("ws \(sid): \(error)") }
        }
        sock?.close()
        NativeWS.lock.lock(); NativeWS.conns.removeValue(forKey: sid); NativeWS.lock.unlock()
        emit("close", ["code": code, "reason": reason, "clean": code != 1006])
    }

    private func send(_ frame: Data) throws {
        guard let s = sock else { throw BErr("IllegalStateException", "not_open") }
        wlock.lock(); defer { wlock.unlock() }
        try s.write(frame)
    }
    func sendText(_ t: String) throws { try send(Live.wsFrame(Data(t.utf8), 1)) }
    func sendBin(_ d: Data) throws { try send(Live.wsFrame(d, 2)) }
    func close(_ code: Int) {
        if closed { return }
        closed = true
        try? send(Live.wsFrame(Data([UInt8((code >> 8) & 0xff), UInt8(code & 0xff)]), 8))
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { self.sock?.close() }
    }
}
