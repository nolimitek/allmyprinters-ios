import Foundation
import CommonCrypto
import CryptoKit

/// Dauerverbindungen zu Druckern, die ihren Stand selbst schicken — Umsetzung von Live.kt (Android):
///  - Bambu Lab (LAN/Entwicklermodus): MQTT 3.1.1 über TLS 8883, Benutzer „bblp“, Passwort = Access Code
///  - Elegoo SDCP (Centauri Carbon): WebSocket ws://IP:3030/websocket
///  - Anycubic LAN-Modus: Handshake http://IP:18910 (AES-Zugang), dann MQTT über TLS (9883)
///  - Creality OS: WebSocket ws://IP:9999 (Subprotokoll „wsslicer“), Herzschlag → „ok“
///  - Elegoo Centauri Carbon 2: MQTT ohne TLS 1883, Anmeldung über elegoo/<sn>/api_register
/// Die Oberfläche fragt den zusammengeführten Stand ab (live_state) und schickt Befehle (live_send). Fragt 90 s niemand, geht die Verbindung zu.
final class LiveConn {
    let key: String, kind: String
    let lock = NSLock()       // Stand und Felder
    let wlock = NSLock()      // Schreiben auf die Verbindung
    var host = "", serial = "", code = "", mainboard = "", err = "", cid = "", did = ""
    var port = 0, mqttPort = 0, seq = 20000
    var connected = false, registered = false, running = false
    var lastMsg: Double = 0, lastUse = Live.now(), lastSend: Double = 0, lastPong: Double = 0
    var sock: Sock?
    var state = NSMutableDictionary()
    init(key: String, kind: String) { self.key = key; self.kind = kind }
    func with<T>(_ f: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try f() }
}

enum Live {
    static let IDLE: Double = 90_000
    private static let lock = NSLock()
    private static var conns: [String: LiveConn] = [:]

    static func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    static func open(_ kind: String, _ key: String, _ a: [String: Any]) -> [String: Any] {
        lock.lock()
        let c = conns[key] ?? { let n = LiveConn(key: key, kind: kind); conns[key] = n; return n }()
        lock.unlock()
        let host = a["host"] as? String ?? "", serial = a["serial"] as? String ?? "", code = a["code"] as? String ?? ""
        var start = false
        c.with {
            c.lastUse = now()
            let defPort = ["bambu": 8883, "cc2": 1883, "crws": 9999, "acl": 18910][kind] ?? 3030
            c.port = (a["port"] as? NSNumber)?.intValue ?? defPort
            if kind == "acl" { c.mqttPort = (a["mqttPort"] as? NSNumber)?.intValue ?? 0; c.did = a["did"] as? String ?? "" }
            if host != c.host || code != c.code || (!serial.isEmpty && serial != c.serial) {
                c.host = host; c.code = code; if !serial.isEmpty { c.serial = serial }
                c.sock?.close()
            }
            if !c.running { c.running = true; start = true }
        }
        if start { Thread.detachNewThread { run(c) } }
        return status(c)
    }

    static func state(_ key: String) -> [String: Any] {
        lock.lock(); let c = conns[key]; lock.unlock()
        guard let c else { return ["connected": false, "err": "none"] }
        var st = status(c)
        c.with {
            c.lastUse = now()
            if let d = try? JSONSerialization.data(withJSONObject: c.state), let o = try? JSONSerialization.jsonObject(with: d) { st["state"] = o }
        }
        return st
    }

    private static func status(_ c: LiveConn) -> [String: Any] {
        c.with { ["connected": c.connected, "err": c.err, "serial": c.serial, "registered": c.registered, "mainboard": c.mainboard,
                  "age": c.lastMsg > 0 ? Int(now() - c.lastMsg) : -1] }
    }

    static func close(_ key: String) {
        lock.lock(); let c = conns.removeValue(forKey: key); lock.unlock()
        c?.with { c?.lastUse = 0 }
        c?.sock?.close()
    }

    /// Befehl schicken: Bambu → device/<sn>/request, Anycubic → …/<typ>, CC2 → {id, method, params}, SDCP/Creality → Textrahmen
    static func send(_ key: String, _ payload: String) throws -> [String: Any] {
        lock.lock(); let c = conns[key]; lock.unlock()
        guard let c else { throw BErr("IllegalStateException", "not_connected") }
        let (s, kind, serial, mainboard, cid, registered) = c.with { () -> (Sock?, String, String, String, String, Bool) in
            c.lastUse = now(); return (c.connected ? c.sock : nil, c.kind, c.serial, c.mainboard, c.cid, c.registered)
        }
        guard let s else { throw BErr("IllegalStateException", "not_connected") }
        if kind == "acl" {
            if serial.isEmpty { throw BErr("IllegalStateException", "not_connected") }
            guard let j = obj(payload) else { throw BErr("JSONException", "payload") }
            let type = j["type"] as? String ?? "", action = j["action"] as? String ?? ""
            let msgid = UUID().uuidString.lowercased()
            j["timestamp"] = Int64(now()); j["msgid"] = msgid; if j["data"] == nil { j["data"] = NSNull() }
            let via = type == "print" && action == "start" ? "slicer" : "web"   // Druckstart nur über den Slicer-Zweig (kobra-connect)
            try write(c, s, publish("anycubic/anycubicCloud/v1/\(via)/printer/\(mainboard)/\(serial)/\(type)", json(j)))
            return ["ok": true, "msgid": msgid]
        }
        if kind == "cc2" {
            if !registered { throw BErr("IllegalStateException", "not_registered") }
            guard let j = obj(payload) else { throw BErr("JSONException", "payload") }
            let id: Int = c.with { let v = c.seq; c.seq += 1; return v }
            j["id"] = id; if j["params"] == nil { j["params"] = NSMutableDictionary() }
            c.wlock.lock(); defer { c.wlock.unlock() }
            // Mindestens 2 s Abstand: dichte Anfragen lösen am CC2 eine Sperre aus (pycentauri)
            let wait = c.with { c.lastSend + 2000 - now() }
            if wait > 0 { Thread.sleep(forTimeInterval: wait / 1000) }
            try s.write(publish("elegoo/\(serial)/\(cid)/api_request", json(j)))
            c.with { c.lastSend = now() }
            return ["ok": true, "id": id]
        }
        if kind == "bambu" {
            if serial.isEmpty { throw BErr("IllegalStateException", "no_serial") }
            try write(c, s, publish("device/\(serial)/request", Data(payload.utf8)))
        } else { try write(c, s, wsFrame(Data(payload.utf8))) }
        return ["ok": true]
    }

    private static func write(_ c: LiveConn, _ s: Sock, _ d: Data) throws { c.wlock.lock(); defer { c.wlock.unlock() }; try s.write(d) }

    private static func run(_ c: LiveConn) {
        while c.with({ now() - c.lastUse < IDLE }) {
            do {
                switch c.kind {
                case "bambu": try runBambu(c)
                case "cc2": try runCc2(c)
                case "crws": try runCrws(c)
                case "acl": try runAcl(c)
                default: try runSdcp(c)
                }
            } catch {
                let msg = (error as? BErr)?.description ?? "\(error)"
                c.with { c.err = String(msg.prefix(120)) }
            }
            let s: Sock? = c.with { c.connected = false; c.registered = false; return c.sock }
            s?.close()
            let tooMany = c.with { c.err == "too_many_clients" }
            if c.with({ now() - c.lastUse < IDLE }) { Thread.sleep(forTimeInterval: tooMany ? 15 : 3) }
        }
        c.with { c.running = false }
        lock.lock(); if conns[c.key] === c { conns.removeValue(forKey: c.key) }; lock.unlock()
    }

    // ── MQTT 3.1.1 ──
    static func str(_ s: String) -> Data { let b = Data(s.utf8); return Data([UInt8((b.count >> 8) & 0xff), UInt8(b.count & 0xff)]) + b }
    static func packet(_ type: UInt8, _ body: Data) -> Data {
        var out = Data([type]); var n = body.count
        repeat { var d = UInt8(n % 128); n /= 128; if n > 0 { d |= 0x80 }; out.append(d) } while n > 0
        return out + body
    }
    static func publish(_ topic: String, _ payload: Data) -> Data { packet(0x30, str(topic) + payload) }
    static func connectPacket(_ cid: String, _ user: String, _ pass: String) -> Data {
        packet(0x10, Data([0, 4]) + Data("MQTT".utf8) + Data([4, 0xC2, 0, 60]) + str(cid) + str(user) + str(pass))
    }
    static func readPacket(_ s: Sock) throws -> (UInt8, Data) {
        let t = try s.byte()
        var len = 0, mul = 1
        while true { let d = Int(try s.byte()); len += (d & 0x7f) * mul; if d & 0x80 == 0 { break }; mul *= 128; if mul > 128 * 128 * 128 { throw BErr("IllegalStateException", "bad length") } }
        var body = Data()
        if len > 0 { body = try s.read(len) }
        return (t, body)
    }
    /// PUBLISH zerlegen → (Thema, Nutzdaten, QoS, Paketnummer)
    static func parsePublish(_ t: UInt8, _ b: Data) -> (String, Data, Int, Data)? {
        guard b.count >= 2 else { return nil }
        let base = b.startIndex
        let tl = Int(b[base]) << 8 | Int(b[base + 1])
        guard b.count >= 2 + tl else { return nil }
        let topic = String(decoding: b[(base + 2)..<(base + 2 + tl)], as: UTF8.self)
        let qos = Int((t >> 1) & 3)
        let off = 2 + tl + (qos > 0 ? 2 : 0)
        guard b.count >= off else { return nil }
        let pid = qos > 0 ? b[(base + 2 + tl)..<(base + 4 + tl)] : Data()
        return (topic, Data(b[(base + off)...]), qos, Data(pid))
    }
    static func connack(_ s: Sock, badLogin: String) throws {
        let (t0, b0) = try readPacket(s)
        guard t0 >> 4 == 2, b0.count >= 2 else { throw BErr("IllegalStateException", "no connack") }
        let rc = Int(b0[b0.startIndex + 1])
        if rc != 0 { throw BErr("IllegalStateException", rc == 4 || rc == 5 ? badLogin : "connack \(rc)") }
    }

    // ── JSON-Hilfen (veränderbare Container wie JSONObject) ──
    static func obj(_ s: String) -> NSMutableDictionary? { obj(Data(s.utf8)) }
    static func obj(_ d: Data) -> NSMutableDictionary? { try? JSONSerialization.jsonObject(with: d, options: [.mutableContainers]) as? NSMutableDictionary }
    static func json(_ o: Any) -> Data { (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8) }
    static func sub(_ d: NSMutableDictionary, _ k: String) -> NSMutableDictionary {
        if let x = d[k] as? NSMutableDictionary { return x }
        let n = NSMutableDictionary(); d[k] = n; return n
    }

    /// Bericht einarbeiten: Objekte rekursiv, Listen ersetzen (P1/A1 schicken nur Änderungen)
    static func merge(_ dst: NSMutableDictionary, _ src: NSDictionary) {
        for (k, v) in src {
            if let vs = v as? NSDictionary, let ds = dst[k] as? NSMutableDictionary { merge(ds, vs) } else { dst[k] = v }
        }
    }
    /// Bambu: AMS-Einheiten (ams) und Fächer (tray) je „id“ einarbeiten; geleertes Fach kommt als bloßes {"id":n} → alte Felder löschen
    static func mergeBambu(_ dst: NSMutableDictionary, _ src: NSDictionary) {
        for (kAny, v) in src {
            let k = "\(kAny)"
            let d = dst[k]
            if let vs = v as? NSDictionary, let ds = d as? NSMutableDictionary { mergeBambu(ds, vs) }
            else if let va = v as? NSArray, let da = d as? NSMutableArray, k == "ams" || k == "tray", idList(va), idList(da) {
                for e in va {
                    guard let e = e as? NSDictionary else { continue }
                    let id = "\(e["id"] ?? "")"
                    let hit = da.first { ("\(($0 as? NSDictionary)?["id"] ?? "-")") == id } as? NSMutableDictionary
                    if let hit, k == "tray", e.count == 1 { for x in hit.allKeys where "\(x)" != "id" { hit.removeObject(forKey: x) } }
                    else if let hit { mergeBambu(hit, e) }
                    else { da.add(e) }
                }
            } else { dst[k] = v }
        }
    }
    private static func idList(_ a: NSArray) -> Bool { a.allSatisfy { ($0 as? NSDictionary)?["id"] != nil } }

    // ── Bambu ──
    private static func runBambu(_ c: LiveConn) throws {
        let (host, port) = c.with { (c.host, c.port) }
        let s = try Sock(host: host, port: port, tls: true)
        c.with { c.sock = s; if c.serial.isEmpty, let cn = s.peerCN?.trimmingCharacters(in: .whitespaces), (8...40).contains(cn.count) { c.serial = cn } }
        let cid = "amp-" + UUID().uuidString.lowercased().prefix(8)
        try s.write(connectPacket(String(cid), "bblp", c.with { c.code }))
        try connack(s, badLogin: "access_code")
        let serial0 = c.with { c.serial }
        try s.write(packet(0x82, Data([0, 1]) + str(serial0.isEmpty ? "device/+/report" : "device/\(serial0)/report") + Data([0])))
        c.with { c.connected = true; c.err = "" }
        var asked = !serial0.isEmpty
        if asked { pushall(c) }
        let gen = UUID()
        pinger(c, s, gen) { last in if now() - last > 30000 { try write(c, s, Data([0xC0, 0])); return now() }; return last }
        let re = try NSRegularExpression(pattern: "^device/([^/]+)/report$")
        while true {
            let (t, b) = try readPacket(s)
            guard t >> 4 == 3, let (tp, payload, _, _) = parsePublish(t, b), let msg = obj(payload) else { continue }
            c.with {
                if c.serial.isEmpty, let m = re.firstMatch(in: tp, range: NSRange(tp.startIndex..., in: tp)), let r = Range(m.range(at: 1), in: tp) { c.serial = String(tp[r]) }
                mergeBambu(c.state, msg)
                // Antwort auf project_file merken, bevor der nächste Bericht „command“ überschreibt
                if let pr = msg["print"] as? NSDictionary, pr["command"] as? String == "project_file", pr["result"] != nil {
                    c.state["bb_ack"] = ["seq": "\(pr["sequence_id"] ?? "")", "result": "\(pr["result"] ?? "")", "reason": String("\(pr["reason"] ?? "")".prefix(200)),
                                         "err": pr["err_code"] ?? NSNull(), "at": Int64(now())] as NSDictionary
                }
                c.lastMsg = now()
            }
            if !asked && !c.with({ c.serial.isEmpty }) { asked = true; pushall(c) }
        }
    }

    private static func pushall(_ c: LiveConn) {
        let (a, b) = c.with { () -> (Int, Int) in let x = c.seq; c.seq += 2; return (x, x + 1) }
        _ = try? send(c.key, "{\"pushing\":{\"sequence_id\":\"\(a)\",\"command\":\"pushall\",\"version\":1,\"push_target\":1}}")
        _ = try? send(c.key, "{\"info\":{\"sequence_id\":\"\(b)\",\"command\":\"get_version\"}}")
    }

    /// Hintergrundfaden je Verbindung: tick(letzterZeitpunkt) → neuer Zeitpunkt; endet, wenn die Verbindung weg ist oder 90 s niemand fragt
    private static func pinger(_ c: LiveConn, _ s: Sock, _ gen: UUID, every: Double = 1, tick: @escaping (Double) throws -> Double) {
        Thread.detachNewThread {
            var last = now()
            while c.with({ c.connected && c.sock === s }) && !s.isClosed {
                Thread.sleep(forTimeInterval: every)
                do { last = try tick(last) } catch { s.close(); break }
                if c.with({ now() - c.lastUse > IDLE }) { s.close(); break }
            }
        }
    }

    // ── Elegoo Centauri Carbon 2: MQTT ohne TLS ──
    private static func runCc2(_ c: LiveConn) throws {
        let (host, port) = c.with { (c.host, c.port) }
        let s = try Sock(host: host, port: port, tls: false)
        c.with { c.sock = s; if !c.cid.hasPrefix("1_PC_") { c.cid = "1_PC_\(Int.random(in: 1000...9999))" } }
        let (cid, code) = c.with { (c.cid, c.code) }
        try s.write(connectPacket(cid, "elegoo", code.isEmpty ? "123456" : code))
        try connack(s, badLogin: "access_code")
        c.with { c.connected = true; c.err = ""; c.registered = false }
        var pid = 1
        let pidLock = NSLock()
        func subscribe(_ topic: String) throws { pidLock.lock(); let id = pid; pid += 1; pidLock.unlock(); try write(c, s, packet(0x82, Data([UInt8((id >> 8) & 0xff), UInt8(id & 0xff)]) + str(topic) + Data([0]))) }
        func pub(_ topic: String, _ msg: String) throws { try write(c, s, publish(topic, Data(msg.utf8))) }
        let rid = cid + "_req"
        var regAt: Double = 0, regTries = 0
        let regLock = NSLock()
        func register() throws {
            regLock.lock(); regAt = now(); regTries += 1; let first = regTries == 1; regLock.unlock()
            let sn = c.with { c.serial }
            if first { try subscribe("elegoo/\(sn)/\(cid)/api_response"); try subscribe("elegoo/\(sn)/api_status"); try subscribe("elegoo/\(sn)/\(rid)/register_response") }
            try pub("elegoo/\(sn)/api_register", String(decoding: json(["client_id": cid, "request_id": rid]), as: UTF8.self))
        }
        if c.with({ c.serial.isEmpty }) { try subscribe("elegoo/+/api_status") } else { try register() }
        func initial() { Thread.detachNewThread { for m in [1001, 1002, 2005] { _ = try? send(c.key, "{\"method\":\(m)}") } } }
        var lastPing: Double = 0, lastMq = now()
        c.with { c.lastPong = now() }
        pinger(c, s, UUID()) { last in
            let t = now()
            let (reg, pong, sn) = c.with { (c.registered, c.lastPong, c.serial) }
            // App-PING alle 10 s (sonst vergisst der Drucker die Anmeldung), 65 s ohne PONG → neu verbinden
            if reg && t - lastPing > 10000 { lastPing = t; try pub("elegoo/\(sn)/\(cid)/api_request", "{\"type\":\"PING\"}") }
            if reg && t - pong > 65000 { c.with { c.err = "no_pong" }; throw BErr("IOException", "no_pong") }
            if t - lastMq > 30000 { lastMq = t; try write(c, s, Data([0xC0, 0])) }
            regLock.lock(); let ra = regAt, rt = regTries; regLock.unlock()
            if !reg && !sn.isEmpty && t - ra > 4000 { if rt >= 5 { c.with { c.err = "register" }; throw BErr("IOException", "register") }; try register() }
            return last
        }
        var statusId = -1, gaps = 0
        let snRe = try NSRegularExpression(pattern: "^elegoo/([^/]+)/api_status$")
        while true {
            let (t, b) = try readPacket(s)
            guard t >> 4 == 3, let (tp, payload, qos, pkid) = parsePublish(t, b) else { continue }
            if qos > 0 { try write(c, s, Data([0x40, 2]) + pkid) }   // PUBACK
            guard let msg = obj(payload) else { continue }
            c.with { c.lastMsg = now() }
            if tp.hasSuffix("/register_response") {
                let e = msg["error"] as? String ?? ""
                if e == "ok" || e.lowercased() == "already registered" {
                    let was = c.with { () -> Bool in let w = c.registered; if !w { c.registered = true; c.err = ""; c.lastPong = now() }; return w }
                    if !was { initial() }
                } else {
                    let er = e.lowercased().contains("many") ? "too_many_clients" : String("register_\(e)".prefix(60))
                    c.with { c.err = er }; throw BErr("IllegalStateException", er)
                }
            } else if tp.hasSuffix("/api_status") {
                if c.with({ c.serial.isEmpty }), let m = snRe.firstMatch(in: tp, range: NSRange(tp.startIndex..., in: tp)), let r = Range(m.range(at: 1), in: tp) {
                    c.with { c.serial = String(tp[r]) }; try register()
                }
                guard let r = msg["result"] as? NSMutableDictionary else { continue }
                let method = (msg["method"] as? NSNumber)?.intValue ?? 0
                if method == 6000 {
                    var refetch = false
                    c.with {
                        guard let st = c.state["status"] as? NSMutableDictionary else { return }   // Deltas vor dem ersten Vollstatus verwerfen
                        if let ex = r["exception"] { st["exception"] = ex; r.removeObject(forKey: "exception") }
                        merge(st, r)
                        let id = (msg["id"] as? NSNumber)?.intValue ?? -1
                        if statusId >= 0 && id != 0 && id != statusId + 1 { gaps += 1; if gaps >= 5 { gaps = 0; refetch = true } }
                        statusId = id
                    }
                    if refetch { Thread.detachNewThread { _ = try? send(c.key, "{\"method\":1002}") } }
                } else if method == 6008 { c.with { merge(sub(c.state, "attributes"), r) } }
            } else if tp.hasSuffix("/api_response") {
                if msg["type"] as? String == "PONG" { c.with { c.lastPong = now() }; continue }
                let m = (msg["method"] as? NSNumber)?.intValue ?? 0
                let r = msg["result"] as? NSMutableDictionary ?? NSMutableDictionary()
                let ok = ((r["error_code"] as? NSNumber)?.intValue ?? 0) == 0
                c.with {
                    if m == 1002 && ok { c.state["status"] = r }
                    if m == 1001 && ok { c.state["attributes"] = r }
                    if m == 2005, let cv = r["canvas_info"] { c.state["canvas"] = cv }
                    c.state["r_\(m)"] = msg
                }
            }
        }
    }

    // ── Anycubic LAN-Modus ──
    private static func md5hex(_ s: String) -> String { Insecure.MD5.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
    private static func httpText(_ url: String, post: Bool = false) throws -> String {
        guard let u = URL(string: url) else { throw BErr("IllegalArgumentException", "bad_url") }
        var r = URLRequest(url: u); r.timeoutInterval = 8; r.httpMethod = post ? "POST" : "GET"
        if post { r.httpBody = Data() }
        let j = try Net.shared.run(r)
        let code = j.resp?.statusCode ?? 0
        if code >= 400 || code == 0 { throw BErr("IllegalStateException", "http_\(code)") }
        return String(decoding: j.data, as: UTF8.self)
    }
    /// Adresse aus der Druckerantwort auf den Host umbiegen, unter dem wir ihn erreichen (Pfad + Port bleiben)
    private static func onHost(_ host: String, _ u: String, _ defPort: Int) -> String {
        guard let re = try? NSRegularExpression(pattern: "^https?://[^/:]+(?::(\\d+))?(/.*)?$"), let m = re.firstMatch(in: u, range: NSRange(u.startIndex..., in: u)) else { return "http://\(host):\(defPort)/ctrl" }
        let g = { (i: Int) in Range(m.range(at: i), in: u).map { String(u[$0]) } ?? "" }
        return "http://\(host):\(g(1).isEmpty ? String(defPort) : g(1))\(g(2))"
    }
    /// Handshake wie Anycubics Web-Oberfläche: GET :18910/info → token; POST ctrlInfoUrl mit sign = md5(md5(token[0:16]) + ts + nonce);
    /// data.info = AES-128-CBC (Schlüssel token[16:32], IV data.token) → MQTT-Zugang
    private static func aclHandshake(_ c: LiveConn) throws -> NSDictionary {
        let (host, port, did) = c.with { (c.host, c.port, c.did) }
        let infoTxt = try httpText("http://\(host):\(port)/info")
        guard let info = obj(infoTxt) else { throw BErr("IllegalStateException", "info") }
        c.with { c.state["lanInfo"] = info }
        if info["ctrlType"] as? String == "cloud" { throw BErr("IllegalStateException", "lan_off") }
        let token = info["token"] as? String ?? ""
        guard token.count >= 32 else { throw BErr("IllegalStateException", "no_token") }
        let ts = String(Int64(now()))
        let abc = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        let nonce = String((0..<6).map { _ in abc.randomElement()! })
        let sign = md5hex(md5hex(String(token.prefix(16))) + ts + nonce)
        let ctrl = onHost(host, info["ctrlInfoUrl"] as? String ?? "", port)
        let didQ = did.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let ctrlTxt = try httpText("\(ctrl)?ts=\(ts)&nonce=\(nonce)&sign=\(sign)&did=\(didQ)", post: true)
        guard let r = obj(ctrlTxt) else { throw BErr("IllegalStateException", "ctrl") }
        guard let d = r["data"] as? NSDictionary, let enc = d["info"] as? String, let iv0 = d["token"] as? String,
              let cipher = Data(base64Encoded: enc, options: .ignoreUnknownCharacters) else {
            throw BErr("IllegalStateException", "ctrl_\(r["code"] ?? "")_\(String("\(r["message"] ?? "")".prefix(40)))")
        }
        let key = Data(token.utf8)[16..<32]
        var iv = Data(iv0.utf8).prefix(16); if iv.count < 16 { iv.append(Data(count: 16 - iv.count)) }
        var out = Data(count: cipher.count + kCCBlockSizeAES128)
        var outLen = 0
        let st = out.withUnsafeMutableBytes { o in cipher.withUnsafeBytes { ci in key.withUnsafeBytes { k in iv.withUnsafeBytes { v in
            CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES128), CCOptions(kCCOptionPKCS7Padding), k.baseAddress, kCCKeySizeAES128, v.baseAddress,
                    ci.baseAddress, cipher.count, o.baseAddress, o.count, &outLen)
        } } } }
        guard st == CCCryptorStatus(kCCSuccess), let cred = obj(out.prefix(outLen)) else { throw BErr("IllegalStateException", "decrypt") }
        return cred
    }
    /// ACE-Berichte kommen teils unvollständig → je Box (id) und Fach (index) zusammenführen
    private static func mergeBoxes(_ c: LiveConn, _ data: NSDictionary) {
        guard let incoming = data["multi_color_box"] as? NSArray else { return }
        let cur = sub(c.state, "multiColorBox")
        let boxes: NSMutableArray = (cur["multi_color_box"] as? NSMutableArray) ?? { let a = NSMutableArray(); cur["multi_color_box"] = a; return a }()
        for case let nb as NSMutableDictionary in incoming {
            let nid = (nb["id"] as? NSNumber)?.intValue ?? -2
            guard let ob = boxes.first(where: { (($0 as? NSDictionary)?["id"] as? NSNumber)?.intValue ?? -1 == nid }) as? NSMutableDictionary else { boxes.add(nb); continue }
            let nslots = nb["slots"] as? NSArray; nb.removeObject(forKey: "slots")
            merge(ob, nb)
            if let nslots {
                let oslots: NSMutableArray = (ob["slots"] as? NSMutableArray) ?? { let a = NSMutableArray(); ob["slots"] = a; return a }()
                for case let ns as NSDictionary in nslots {
                    let ix = (ns["index"] as? NSNumber)?.intValue ?? -2
                    if let os = oslots.first(where: { (($0 as? NSDictionary)?["index"] as? NSNumber)?.intValue ?? -1 == ix }) as? NSMutableDictionary { merge(os, ns) } else { oslots.add(ns) }
                }
            }
        }
    }

    private static func runAcl(_ c: LiveConn) throws {
        let cred: NSDictionary
        do { cred = try aclHandshake(c) } catch {
            let m = (error as? BErr)?.msg ?? "\(error)"
            throw BErr("IllegalStateException", m == "lan_off" || m == "no_token" ? m : "Handshake: \(m)")
        }
        let li = c.with { c.state["lanInfo"] as? NSDictionary } ?? NSDictionary()
        let serial = (cred["deviceId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (cred["device_id"] as? String ?? "")
        let mb = [li["modelId"], cred["modelId"], cred["modeId"]].compactMap { $0 as? String }.first { !$0.isEmpty } ?? ""
        if serial.isEmpty || mb.isEmpty { throw BErr("IllegalStateException", "no_device (" + String(cred.allKeys.map { "\($0)" }.joined(separator: ",").prefix(120)) + ")") }
        c.with { c.serial = serial; c.mainboard = mb }
        var bport = c.with { c.mqttPort }
        if bport <= 0, let b = cred["broker"] as? String, let re = try? NSRegularExpression(pattern: ":(\\d+)"),
           let m = re.firstMatch(in: b, range: NSRange(b.startIndex..., in: b)), let r = Range(m.range(at: 1), in: b) { bport = Int(b[r]) ?? 0 }
        if bport <= 0 { bport = 9883 }
        // iOS: ohne Geräte-Zertifikat (wie die Home-Assistant-Projekte); Android versucht es erst mit (Anycubic Slicer Next)
        let s: Sock
        do { s = try Sock(host: c.with { c.host }, port: bport, tls: true) } catch { throw BErr("IllegalStateException", "TLS \(bport): \(String("\(error)".prefix(90)))") }
        c.with { c.sock = s }
        let cid = "amp-" + UUID().uuidString.lowercased().prefix(8)
        try s.write(connectPacket(String(cid), cred["username"] as? String ?? "", cred["password"] as? String ?? ""))
        try connack(s, badLogin: "login")
        let base = "anycubic/anycubicCloud/v1/printer/public/\(mb)/\(serial)/"
        try s.write(packet(0x82, Data([0, 1]) + str(base + "#") + Data([0])))
        c.with { c.connected = true; c.err = "" }
        func ask(_ type: String, _ action: String) { _ = try? send(c.key, "{\"type\":\"\(type)\",\"action\":\"\(action)\",\"data\":null}") }
        ask("info", "query"); ask("multiColorBox", "getInfo")
        var lastInfo = now(), lastBox = now()
        pinger(c, s, UUID()) { last in
            let t = now()
            var l = last
            if t - l > 30000 { l = t; try write(c, s, Data([0xC0, 0])) }
            if t - lastInfo > 15000 { lastInfo = t; ask("info", "query") }   // info kommt von selbst nur selten, ACE muss abgefragt werden
            if t - lastBox > 30000 { lastBox = t; ask("multiColorBox", "getInfo") }
            return l
        }
        while true {
            let (t, b) = try readPacket(s)
            guard t >> 4 == 3, let (tp, payload, _, _) = parsePublish(t, b) else { continue }
            if !tp.hasPrefix(base) || tp.hasSuffix("/response") { continue }   // response = nur Empfangsbestätigung
            let type = String(tp.dropFirst(base.count).split(separator: "/").first ?? "")
            guard let msg = obj(payload) else { continue }
            c.with {
                c.lastMsg = now()
                let at = Int64(c.lastMsg)
                c.state["\(type)_at"] = at; c.state["\(type)_action"] = msg["action"] as? String ?? ""
                // Antwort auf einen Befehl steht im Umschlag (state/code/msg) — je Typ UND Aktion
                if msg["code"] != nil || msg["state"] != nil || msg["msg"] != nil {
                    c.state["\(type)_res_\(msg["action"] as? String ?? "")"] = ["state": msg["state"] as? String ?? "", "code": msg["code"] ?? NSNull(),
                                                                                   "msg": String("\(msg["msg"] ?? "")".prefix(200)), "at": at] as NSDictionary
                }
                if let data = msg["data"] as? NSMutableDictionary {
                    if type == "multiColorBox" { mergeBoxes(c, data) }
                    else if type == "info" && data["state"] != nil { c.state["info"] = data }   // Gesamtstand → ersetzen
                    else { merge(sub(c.state, type), data) }
                }
            }
        }
    }

    // ── WebSocket (Creality, SDCP): Rahmen von Hand wie auf Android ──
    static func wsFrame(_ p: Data, _ op: UInt8 = 1) -> Data {
        var out = Data([0x80 | op])
        if p.count < 126 { out.append(0x80 | UInt8(p.count)) }
        else if p.count < 65536 { out.append(contentsOf: [UInt8(0x80 | 126), UInt8(p.count >> 8), UInt8(p.count & 0xff)] as [UInt8]) }
        else { out.append(UInt8(0x80 | 127)); for i in stride(from: 7, through: 0, by: -1) { out.append(UInt8((UInt64(p.count) >> (8 * UInt64(i))) & 0xff)) } }
        let mask = (0..<4).map { _ in UInt8.random(in: 0...255) }
        out.append(contentsOf: mask)
        var m = Data(count: p.count)
        for (i, b) in p.enumerated() { m[i] = b ^ mask[i % 4] }
        return out + m
    }
    private static func wsUpgrade(_ c: LiveConn, path: String, proto: String?) throws -> Sock {
        let (host, port) = c.with { (c.host, c.port) }
        let s = try Sock(host: host, port: port, tls: false)
        c.with { c.sock = s }
        let key = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
        var req = "GET \(path) HTTP/1.1\r\nHost: \(host):\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n"
        if let proto { req += "Sec-WebSocket-Protocol: \(proto)\r\n" }
        try s.write(Data((req + "\r\n").utf8))
        var head = Data()
        while !head.suffix(4).elementsEqual([13, 10, 13, 10]) { head.append(try s.byte()); if head.count > 8192 { throw BErr("IllegalStateException", "bad upgrade") } }
        let h = String(decoding: head, as: UTF8.self)
        if !h.hasPrefix("HTTP/1.1 101") { throw BErr("IllegalStateException", String((h.split(separator: "\r\n").first ?? "").prefix(60))) }
        c.with { c.connected = true; c.err = "" }
        return s
    }
    /// Ein Rahmen → (op, fin, Nutzdaten)
    private static func wsRead(_ s: Sock, max: Int) throws -> (UInt8, Bool, Data) {
        let b0 = try s.byte(), b1 = try s.byte()
        var len = Int(b1 & 0x7f)
        if len == 126 { len = try s.u16() } else if len == 127 { let d = try s.read(8); len = d.reduce(0) { $0 << 8 | Int($1) } }
        if len > max { throw BErr("IllegalStateException", "frame too big") }
        var p = Data()
        if len > 0 { p = try s.read(len) }
        if b1 & 0x80 != 0 { let mk = try s.read(4); for i in 0..<p.count { p[p.startIndex + i] ^= mk[mk.startIndex + i % 4] } }
        return (b0 & 0x0f, b0 & 0x80 != 0, p)
    }

    private static func runCrws(_ c: LiveConn) throws {
        let s = try wsUpgrade(c, path: "/", proto: "wsslicer")
        func text(_ t: String) throws { try write(c, s, wsFrame(Data(t.utf8))) }
        let ask = "{\"method\":\"get\",\"params\":{\"ReqPrinterPara\":1}}"
        try text(ask)
        // Creality Print fragt alle 5 s; ohne Daten > 10 s gilt die Verbindung als tot → alle 8 s den Stand anfordern
        pinger(c, s, UUID(), every: 8) { last in try text(ask); return last }
        var msgBuf = Data()
        while true {
            let (op, fin, p) = try wsRead(s, max: 32_000_000)
            switch op {
            case 8: throw BErr("IOException", "closed")
            case 9: try write(c, s, wsFrame(p, 10)); continue
            case 10: continue
            default: break
            }
            msgBuf.append(p)
            if !fin { if msgBuf.count > 32_000_000 { throw BErr("IOException", "message too big") }; continue }
            let txt = String(decoding: msgBuf, as: UTF8.self); msgBuf = Data()
            c.with { c.lastMsg = now() }
            if txt.trimmingCharacters(in: .whitespacesAndNewlines) == "ok" { continue }
            guard let msg = obj(txt) else { continue }
            if msg["ModeCode"] as? String == "heart_beat" { try text("ok"); continue }
            // nur geänderte Felder kommen → oberste Ebene ersetzen; Dateiliste nur als Pfade
            c.with { for (k, v) in msg { let ks = "\(k)"; c.state[ks] = ks == "retGcodeFileInfo2" ? crPaths(v) : v } }
        }
    }
    private static func crPaths(_ v: Any) -> Any {
        guard let a = v as? NSArray else { return NSNull() }
        return a.compactMap { e -> String? in guard let e = e as? NSDictionary else { return nil }; let p = (e["path"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (e["name"] as? String ?? ""); return p.isEmpty ? nil : p }
    }

    private static func runSdcp(_ c: LiveConn) throws {
        let s = try wsUpgrade(c, path: "/websocket", proto: nil)
        pinger(c, s, UUID(), every: 10) { last in try write(c, s, wsFrame(Data("ping".utf8))); return last }   // SDCP: Text „ping“ → „pong“
        while true {
            let (op, _, p) = try wsRead(s, max: 8_000_000)
            if op == 8 { throw BErr("IOException", "closed") }
            if op == 9 { try write(c, s, wsFrame(p, 10)); continue }
            guard op == 1 else { continue }
            let txt = String(decoding: p, as: UTF8.self)
            if txt == "pong" { continue }
            guard let msg = obj(txt) else { continue }
            let mb = ((msg["Data"] as? NSDictionary)?["MainboardID"] as? String) ?? (msg["MainboardID"] as? String) ?? ""
            let topic = msg["Topic"] as? String ?? ""
            c.with {
                if !mb.isEmpty && c.mainboard.isEmpty { c.mainboard = mb }
                if topic.hasPrefix("sdcp/status/") { merge(sub(c.state, "Status"), msg["Status"] as? NSDictionary ?? [:]) }
                else if topic.hasPrefix("sdcp/attributes/") { c.state["Attributes"] = msg["Attributes"] ?? NSMutableDictionary() }
                else if topic.hasPrefix("sdcp/response/") { let d = msg["Data"] as? NSDictionary ?? [:]; c.state["Response_\((d["Cmd"] as? NSNumber)?.intValue ?? 0)"] = d }
                else { c.state["Last"] = msg }
                c.lastMsg = now()
            }
        }
    }
}
