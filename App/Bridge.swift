import UIKit
import WebKit
import CryptoKit
import UniformTypeIdentifiers

/// Brücke zwischen Oberfläche und iPhone — dieselbe Schnittstelle wie Bridge.kt auf Android:
/// AMPNative.call(id, methode, json) → Antwort AMP_cb(id, ok, "json"), Fortschritt AMP_ev(name, daten).
/// Bewusst klein: die Logik (Spulen, Abbuchung, Drucker-Protokolle über HTTP) steckt in backend.js.
final class Bridge: NSObject, WKScriptMessageHandler, UIDocumentPickerDelegate {
    weak var web: WKWebView?
    weak var vc: WebViewController?
    let store = Store()
    private let q = DispatchQueue(label: "amp.bridge", qos: .userInitiated, attributes: .concurrent)
    private let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    private let iosVersion = UIDevice.current.systemVersion
    private let model: String = {
        var u = utsname(); uname(&u)
        return withUnsafeBytes(of: &u.machine) { raw in String(decoding: raw.prefix(while: { b in b != 0 }), as: UTF8.self) }
    }()

    // ── Eingang ──
    func userContentController(_ uc: WKUserContentController, didReceive msg: WKScriptMessage) {
        if msg.name == "amplog" { Log.write("js " + String(describing: msg.body)); return }
        guard let d = msg.body as? [String: Any], let id = d["id"] as? String, let m = d["m"] as? String else { return }
        let a = (d["a"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
        switch m {
        case "pick": present(id, kind: .file, a); return
        case "import": present(id, kind: .importText, a); return
        case "export": export(id, a); return
        case "lib_save_as": saveAs(id, a); return
        case "bars":
            vc?.setBars(a["color"] as? String ?? "#ffffff", dark: a["dark"] as? Bool ?? false)
            reply(id, true, [String: Any]()); return
        case "open":
            if let s = a["url"] as? String, let u = URL(string: s) { UIApplication.shared.open(u) }
            reply(id, true, [String: Any]()); return
        case "print":
            vc?.printView(String((a["title"] as? String ?? "AllMyPrinters").prefix(60)))
            reply(id, true, [String: Any]()); return
        default: break
        }
        q.async {
            do { self.reply(id, true, try self.run(id, m, a)) }
            catch {
                Log.write("native \(m): \(errName(error)) \(error)")
                self.reply(id, false, ["error": errName(error), "msg": String(String(describing: error).prefix(200))])
            }
        }
    }

    private func run(_ id: String, _ m: String, _ a: [String: Any]) throws -> [String: Any] {
        switch m {
        case "info": return ["version": version, "ios": iosVersion, "model": model, "platform": "ios"]
        case "load": return ["text": store.load(s(a, "key", "data")) as Any? ?? NSNull()]
        case "save": let text = try req(a, "text"); try store.save(s(a, "key", "data"), text); return ["ok": true]
        case "net": return net()
        case "http": return try http(a)
        case "upload": return try upload(id, a)
        case "putFile": return try putFile(id, a)
        case "stash": return try stash(a)
        case "download": return try download(id, a)
        case "fileDrop": store.drop(s(a, "token")); return [String: Any]()
        case "fileTake": return ["file": NSNull()]
        case "fileRead": return try fileRead(a)
        case "file_chunk": return try fileChunk(a)
        case "md5": let f = try file(a); let h = try md5(f); return ["md5": h]
        case "tcpcheck": let host = try req(a, "host"); return ["open": Net.tcpOpen(host, i(a, "port"), timeoutMs: i(a, "timeout", 1500))]
        case "scan": return scan(a)
        case "lib_put": return try libPut(a)
        case "lib_get": return try libGet(a)
        case "lib_del": return libDel(a)
        case "lib_thumb_put": return try libThumbPut(a)
        case "lib_thumb_get":
            if let u = store.libThumb(s(a, "id"), s(a, "n", "1")), let d = try? Data(contentsOf: u) { return ["b64": d.base64EncodedString()] }
            return [String: Any]()
        case "lib_mesh_put":
            let id0 = try req(a, "id"), b64 = try req(a, "b64")
            let id = Store.digits(id0), n = Store.digits(s(a, "n", "1"))
            guard let md = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { throw BErr("IllegalArgumentException", "b64") }
            try md.write(to: store.libMeshes.appendingPathComponent("\(id)-\(n.isEmpty ? "1" : n).bin.gz"))
            return ["ok": true]
        case "lib_3mf_thumbs": return try lib3mfThumbs(a)
        case "lib_space":
            let v = try? store.dataDir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            return ["free": v?.volumeAvailableCapacityForImportantUsage ?? 0]
        case "lib_dir_ok": return ["ok": false]
        case "nfc_state": return ["available": false, "enabled": false]
        case "agent_state": return ["coupled": false, "url": ""]
        case "agent_restore": return [String: Any]()            // nichts zu übernehmen (Agent-Modus kommt später)
        case "agent_migrate": return ["pending": false]
        case "agent_snapshot": return ["at": 0]
        case "cam":
            let k = try req(a, "key"), urls = (a["urls"] as? [Any])?.map { "\($0)" } ?? []
            return Cam.start(k, urls)
        case "cam_stop": let k = try req(a, "key"); Cam.stop(k); return [String: Any]()
        case "cam_status": let k = try req(a, "key"); return Cam.state(k)
        case "live_open": let k = try req(a, "key"), kind = try req(a, "kind"); return Live.open(kind, k, a)
        case "live_state": let k = try req(a, "key"); return Live.state(k)
        case "live_send": let k = try req(a, "key"), pl = try req(a, "payload"); return try Live.send(k, pl)
        case "live_close": let k = try req(a, "key"); Live.close(k); return [String: Any]()
        case "udp": return try udp(a)
        case "chunkUpload": return try chunkUpload(id, a)
        case "putChunks": return try putChunks(id, a)
        case "make3mf": return try make3mf(a)
        case "remap_tools": return try remapTools(a)
        default: throw BErr("IllegalArgumentException", "unknown method \(m)")   // kommt in den nächsten Etappen (Live, Kamera, Bambu …)
        }
    }

    // ── Ausgang ──
    func reply(_ id: String, _ ok: Bool, _ r: [String: Any]?) {
        let json = r.map { Self.json($0) } ?? "null"
        vc?.js("window.AMP_cb && AMP_cb(\(Self.json(id)), \(ok), \(Self.json(json)))")
    }
    func event(_ name: String, _ d: [String: Any]) { vc?.js("window.AMP_ev && AMP_ev(\(Self.json(name)), \(Self.json(d)))") }

    static func json(_ v: Any) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed, .withoutEscapingSlashes]),
              var s = String(data: d, encoding: .utf8) else { return "null" }
        s = s.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return s
    }

    // ── Hilfen für die Argumente ──
    func s(_ a: [String: Any], _ k: String, _ def: String = "") -> String {
        if let v = a[k] as? String { return v }
        if let v = a[k] as? NSNumber { return v.stringValue }
        return def
    }
    func req(_ a: [String: Any], _ k: String) throws -> String {
        guard let v = a[k] else { throw BErr("JSONException", "No value for \(k)") }
        if let v = v as? String { return v }
        if let v = v as? NSNumber { return v.stringValue }
        throw BErr("JSONException", "No value for \(k)")
    }
    func i(_ a: [String: Any], _ k: String, _ def: Int = 0) -> Int { (a[k] as? NSNumber)?.intValue ?? Int(s(a, k)) ?? def }
    func file(_ a: [String: Any]) throws -> URL {
        guard let u = store.file(s(a, "token")) else { throw BErr("IllegalStateException", "file_gone") }
        return u
    }
    func throttle(_ ms: Double) -> (Bool) -> Bool {
        var last = Date.distantPast
        return { force in let now = Date(); if force || now.timeIntervalSince(last) * 1000 > ms { last = now; return true }; return false }
    }

    // ── Heimnetz ──
    private func net() -> [String: Any] {
        var ip: String? = nil, prefix = 0
        var ifa: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifa) == 0, let first = ifa {
            var p: UnsafeMutablePointer<ifaddrs>? = first
            // en0 = WLAN am iPhone; im Simulator das Netz des Mac (ein beliebiges privates IPv4)
            var best: (String, Int, Int)? = nil
            while let cur = p {
                let f = cur.pointee
                if let addr = f.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET), (Int32(f.ifa_flags) & IFF_UP) != 0, (Int32(f.ifa_flags) & IFF_LOOPBACK) == 0 {
                    let name = String(cString: f.ifa_name)
                    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
                    var pl = 0
                    if let nm = f.ifa_netmask { nm.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { pl = UInt32(bigEndian: $0.pointee.sin_addr.s_addr).nonzeroBitCount } }
                    let rank = name == "en0" ? 0 : name.hasPrefix("en") ? 1 : 2
                    let s = String(cString: host)
                    if best == nil || rank < best!.2 { best = (s, pl, rank) }
                }
                p = f.ifa_next
            }
            freeifaddrs(first)
            if let b = best, b.2 < 2 { ip = b.0; prefix = b.1 }
        }
        return ["ip": ip as Any? ?? NSNull(), "prefix": prefix, "wifi": ip != nil]
    }

    /// Offene Ports im eigenen /24 (nur private Netze) — wie Bridge.kt scan()
    private func scan(_ a: [String: Any]) -> [String: Any] {
        var ip = s(a, "ip"); if ip.isEmpty { ip = (net()["ip"] as? String) ?? "" }
        let parts = ip.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168)
        else { return ["hosts": [Any](), "error": "not_private"] }
        let ports = (a["ports"] as? [NSNumber])?.map { $0.intValue } ?? [7125, 80]
        let to = i(a, "timeout", 400)
        let base = parts.prefix(3).map(String.init).joined(separator: ".")
        var found: [(Int, Int)] = []
        let l = NSLock(), g = DispatchGroup(), gate = DispatchSemaphore(value: 64)
        for h in 1...254 { for port in ports {
            gate.wait(); g.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                if Net.tcpOpen("\(base).\(h)", port, timeoutMs: to) { l.lock(); found.append((h, port)); l.unlock() }
                gate.signal(); g.leave()
            }
        } }
        _ = g.wait(timeout: .now() + 30)
        l.lock(); let f = found.sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }; l.unlock()
        return ["hosts": f.map { ["host": "\(base).\($0.0)", "port": $0.1] }]
    }

    // ── HTTP zu Druckern ──
    private func http(_ a: [String: Any]) throws -> [String: Any] {
        var r = try httpOnce(a, auth: nil)
        if let d = a["digest"] as? [String: Any], r["status"] as? Int == 401,
           let ch = (r["hdr"] as? [String: String])?["www-authenticate"], ch.lowercased().hasPrefix("digest"), let u = URL(string: s(a, "url")) {
            r = try httpOnce(a, auth: Net.digest(ch, method: s(a, "method", "GET"), url: u, user: s(d, "user"), pass: s(d, "pass")))
        }
        return r
    }

    private func httpOnce(_ a: [String: Any], auth: String?) throws -> [String: Any] {
        var rq = try Net.request(a, timeoutMs: i(a, "timeout", 8000))
        if let auth { rq.setValue(auth, forHTTPHeaderField: "Authorization") }
        if let b = a["b64"] as? String { rq.httpBody = Data(base64Encoded: b, options: .ignoreUnknownCharacters) }
        else if let b = a["body"] as? String { rq.httpBody = Data(b.utf8) }
        let job = Net.Job(); job.max = i(a, "max", 8 * 1024 * 1024)
        try Net.shared.run(rq, job: job)
        let resp = job.resp
        var out: [String: Any] = ["status": resp?.statusCode ?? 0, "type": resp?.value(forHTTPHeaderField: "Content-Type") ?? "", "hdr": Net.headers(resp)]
        if a["binary"] as? Bool == true { out["b64"] = job.data.base64EncodedString() }
        else { out["text"] = String(data: job.data, encoding: .utf8) ?? String(decoding: job.data, as: UTF8.self) }
        return out
    }

    /// Multipart-POST mit Fortschritt (Moonraker, OctoPrint, eigener Slicer …) — Felder fields/fieldList, Dateien token oder files[]
    private func upload(_ id: String, _ a: [String: Any]) throws -> [String: Any] {
        let boundary = "----amp" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let qt = { (v: String) in v.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "") }
        var head = ""
        if let fl = a["fieldList"] as? [[Any]] {
            for kv in fl where kv.count >= 2 { head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(qt("\(kv[0])"))\"\r\n\r\n\(kv[1])\r\n" }
        } else if let fields = a["fields"] as? [String: Any] {
            for (k, v) in fields { head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(qt(k))\"\r\n\r\n\(v)\r\n" }
        }
        let list = (a["files"] as? [[String: Any]]) ?? [a]
        let (bt, body) = store.fresh("upload-body", prefix: "body")
        defer { store.drop(bt) }
        let out = try FileHandle(forWritingTo: body)
        do {
            out.write(Data(head.utf8))
            for o in list {
                let f = try file(o)
                let fname = qt(s(o, "filename", store.name(s(o, "token")) ?? f.lastPathComponent))
                out.write(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(qt(s(o, "field", "file")))\"; filename=\"\(fname)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
                let src = try FileHandle(forReadingFrom: f)
                while true { let c = src.readData(ofLength: 1 << 20); if c.isEmpty { break }; out.write(c) }
                try? src.close()
                out.write(Data("\r\n".utf8))
            }
            out.write(Data("--\(boundary)--\r\n".utf8))
            try out.close()
        } catch { try? out.close(); throw error }
        var rq = try Net.request(a, method: "POST", timeoutMs: i(a, "timeout", 120000))
        rq.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let job = Net.Job(); job.max = 1 << 20
        let tick = throttle(250)
        job.onSend = { sent, total in if tick(false) { self.event("upload", ["id": id, "sent": sent, "total": total]) } }
        try Net.shared.run(rq, uploadFile: body, job: job)
        let total = store.size(body)
        event("upload", ["id": id, "sent": total, "total": total])
        return ["status": job.resp?.statusCode ?? 0, "text": String(decoding: job.data, as: UTF8.self)]
    }

    /// PUT einer Datei (PrusaLink, WebDAV), optional mit Digest-Anmeldung
    private func putFile(_ id: String, _ a: [String: Any]) throws -> [String: Any] {
        let f = try file(a)
        guard let url = URL(string: s(a, "url")) else { throw BErr("IllegalArgumentException", "bad_url") }
        var auth: String? = nil
        if let d = a["digest"] as? [String: Any] {
            let probe = try httpOnce(["url": s(d, "probe", url.absoluteString), "timeout": 8000], auth: nil)
            if let ch = (probe["hdr"] as? [String: String])?["www-authenticate"], ch.lowercased().hasPrefix("digest") {
                auth = Net.digest(ch, method: "PUT", url: url, user: s(d, "user"), pass: s(d, "pass"))
            }
        }
        var rq = try Net.request(a, method: "PUT", timeoutMs: i(a, "timeout", 300000))
        if let auth { rq.setValue(auth, forHTTPHeaderField: "Authorization") }
        let job = Net.Job(); job.max = 1 << 20
        let tick = throttle(250), total = store.size(f)
        job.onSend = { sent, _ in if tick(false) { self.event("upload", ["id": id, "sent": sent, "total": total]) } }
        try Net.shared.run(rq, uploadFile: f, job: job)
        event("upload", ["id": id, "sent": total, "total": total])
        return ["status": job.resp?.statusCode ?? 0, "text": String(decoding: job.data, as: UTF8.self)]
    }

    /// Datei aus der Oberfläche stückweise ablegen (JS-File, z. B. gewähltes Modell) → Kennung
    private func stash(_ a: [String: Any]) throws -> [String: Any] {
        var token = s(a, "token")
        var f = token.isEmpty ? nil : store.file(token)
        if f == nil { let (t, u) = store.fresh(s(a, "name", "model"), prefix: "stash-"); token = t; f = u }
        guard let f, let d = Data(base64Encoded: s(a, "b64"), options: .ignoreUnknownCharacters) else { throw BErr("IllegalStateException", "stash") }
        let h = try FileHandle(forWritingTo: f); h.seekToEndOfFile(); h.write(d); try h.close()
        return ["token": token, "size": store.size(f)]
    }

    /// Datei aus dem Netz (fertiger G-Code vom Slicer) in den Zwischenspeicher → Kennung, mit Fortschritt
    private func download(_ id: String, _ a: [String: Any]) throws -> [String: Any] {
        let rq = try Net.request(a, method: "GET", timeoutMs: 60000)
        let (token, f) = store.fresh(s(a, "name", "print.gcode"))
        let job = Net.Job()
        job.out = try FileHandle(forWritingTo: f)
        let tick = throttle(300)
        job.onRecv = { got, total in if tick(false) { self.event("download", ["id": id, "got": got, "total": total]) } }
        do { try Net.shared.run(rq, job: job) } catch { try? job.out?.close(); store.drop(token); throw error }
        try? job.out?.close()
        let st = job.resp?.statusCode ?? 0
        if st != 200 { store.drop(token); return ["status": st] }
        var name = s(a, "name", "print.gcode")
        if let cd = job.resp?.value(forHTTPHeaderField: "Content-Disposition"),
           let m = try? NSRegularExpression(pattern: "filename=\"?([^\";]+)").firstMatch(in: cd, range: NSRange(cd.startIndex..., in: cd)),
           let r = Range(m.range(at: 1), in: cd) { name = String(cd[r]) }
        store.put(token, f, name)
        return ["status": 200, "token": token, "name": name, "size": store.size(f)]
    }

    private func fileRead(_ a: [String: Any]) throws -> [String: Any] {
        let f = try file(a), size = Int(store.size(f))
        let len = min(max(i(a, "length", 65536), 1), 4 << 20)
        let start = a["tail"] as? Bool == true ? max(0, size - len) : max(0, i(a, "offset", 0))
        let n = max(0, min(len, size - start))
        let h = try FileHandle(forReadingFrom: f); defer { try? h.close() }
        try h.seek(toOffset: UInt64(start))
        let d = h.readData(ofLength: n)
        return ["text": String(data: d, encoding: .utf8) ?? String(decoding: d, as: UTF8.self), "size": size]
    }

    private func fileChunk(_ a: [String: Any]) throws -> [String: Any] {
        let f = try file(a), size = Int(store.size(f))
        let start = max(0, i(a, "offset", 0))
        let n = min(min(max(i(a, "length", 786432), 1), 4 << 20), max(0, size - start))
        var d = Data()
        if n > 0 { let h = try FileHandle(forReadingFrom: f); defer { try? h.close() }; try h.seek(toOffset: UInt64(start)); d = h.readData(ofLength: n) }
        return ["b64": d.base64EncodedString(), "size": size]
    }

    func md5(_ f: URL) throws -> String {
        var m = Insecure.MD5()
        let h = try FileHandle(forReadingFrom: f); defer { try? h.close() }
        while true { let c = h.readData(ofLength: 1 << 20); if c.isEmpty { break }; m.update(data: c) }
        return m.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // ── Bibliothek: Modelle im App-Speicher (Application Support/library), Vorschaubilder + 3D-Netze daneben ──
    private func libPut(_ a: [String: Any]) throws -> [String: Any] {
        let src = try file(a)
        guard s(a, "loc", "app") == "app" else { throw BErr("UnsupportedOperationException", "lib_dir") }   // eigener Ordner: später
        let k0 = try req(a, "key")
        let key = String(k0.replacingOccurrences(of: "[^\\w.\\- ()]", with: "_", options: .regularExpression).prefix(180))
        let dst = store.libDir.appendingPathComponent(key)
        try? store.fm.removeItem(at: dst)
        try store.fm.copyItem(at: src, to: dst)
        return ["ok": true, "size": store.size(dst), "key": key]
    }

    private func libGet(_ a: [String: Any]) throws -> [String: Any] {
        let k0 = try req(a, "key")
        let f = store.libDir.appendingPathComponent(k0)
        guard !s(a, "key").contains(".."), store.fm.fileExists(atPath: f.path) else { throw BErr("IllegalStateException", "file_gone") }
        let (token, out) = store.fresh(s(a, "name", "model"), prefix: "lib")
        try? store.fm.removeItem(at: out)
        try store.fm.copyItem(at: f, to: out)
        return ["token": token, "size": store.size(out), "name": s(a, "name", "model")]
    }

    private func libDel(_ a: [String: Any]) -> [String: Any] {
        let key = s(a, "key")
        if !key.isEmpty && !key.contains("..") { try? store.fm.removeItem(at: store.libDir.appendingPathComponent(key)) }
        let id = Store.digits(s(a, "id"))
        if !id.isEmpty { for d in [store.libThumbs, store.libMeshes] {
            for f in (try? store.fm.contentsOfDirectory(at: d, includingPropertiesForKeys: nil)) ?? [] where f.lastPathComponent.hasPrefix(id + "-") { try? store.fm.removeItem(at: f) }
        } }
        return ["ok": true]
    }

    private func libThumbPut(_ a: [String: Any]) throws -> [String: Any] {
        let id0 = try req(a, "id")
        let id = Store.digits(id0), n0 = Store.digits(s(a, "n", "1")), n = n0.isEmpty ? "1" : n0
        var b = try req(a, "b64"); if let r = b.range(of: "base64,") { b = String(b[r.upperBound...]) }
        guard let d = Data(base64Encoded: b, options: .ignoreUnknownCharacters) else { throw BErr("IllegalArgumentException", "b64") }
        try d.write(to: store.libThumbs.appendingPathComponent("\(id)-\(n).png"))
        return ["ok": true]
    }

    /// 3MF: Plattenbilder (Metadata/plate_<n>.png) bzw. Metadata/thumbnail.png als Vorschau
    private func lib3mfThumbs(_ a: [String: Any]) throws -> [String: Any] {
        let src = try file(a), id0 = try req(a, "id")
        let id = Store.digits(id0)
        let es = try Zip.entries(src)
        var plates: [Int] = []
        let re = try NSRegularExpression(pattern: "^Metadata/plate_(\\d+)\\.png$", options: .caseInsensitive)
        for e in es {
            guard let m = re.firstMatch(in: e.name, range: NSRange(e.name.startIndex..., in: e.name)), let r = Range(m.range(at: 1), in: e.name),
                  let n = Int(e.name[r]), (1...99).contains(n) else { continue }
            try Zip.read(src, e).write(to: store.libThumbs.appendingPathComponent("\(id)-\(n).png"))
            plates.append(n)
        }
        if plates.isEmpty, let t = es.first(where: { $0.name == "Metadata/thumbnail.png" || $0.name == "Metadata/Thumbnail.png" }) {
            try Zip.read(src, t).write(to: store.libThumbs.appendingPathComponent("\(id)-1.png")); plates.append(1)
        }
        return ["plates": plates]
    }

    // ── Dateien wählen / speichern (UIDocumentPicker) ──
    private enum PickKind { case file, importText, export }
    private var pending: [ObjectIdentifier: (String, PickKind, URL?)] = [:]

    private func present(_ id: String, kind: PickKind, _ a: [String: Any]) {
        let p = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        p.allowsMultipleSelection = false
        show(p, id: id, kind: kind, tmp: nil)
    }

    private func export(_ id: String, _ a: [String: Any]) {
        let name = s(a, "name", "allmyprinters-backup.json").replacingOccurrences(of: "/", with: "_")
        let dir = store.cacheDir.appendingPathComponent("exp-" + store.newToken(), isDirectory: true)
        try? store.fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent(name)
        do { try Data(s(a, "text").utf8).write(to: f) } catch { reply(id, false, ["error": errName(error)]); return }
        show(UIDocumentPickerViewController(forExporting: [f], asCopy: true), id: id, kind: .export, tmp: dir)
    }

    private func saveAs(_ id: String, _ a: [String: Any]) {
        guard let src = store.file(s(a, "token")) else { reply(id, false, ["error": "IllegalStateException", "msg": "file_gone"]); return }
        let dir = store.cacheDir.appendingPathComponent("exp-" + store.newToken(), isDirectory: true)
        try? store.fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent(s(a, "name", "model").replacingOccurrences(of: "/", with: "_"))
        do { try store.fm.copyItem(at: src, to: f) } catch { reply(id, false, ["error": errName(error)]); return }
        show(UIDocumentPickerViewController(forExporting: [f], asCopy: true), id: id, kind: .export, tmp: dir)
    }

    private func show(_ p: UIDocumentPickerViewController, id: String, kind: PickKind, tmp: URL?) {
        p.delegate = self
        pending[ObjectIdentifier(p)] = (id, kind, tmp)
        guard let vc else { pending.removeValue(forKey: ObjectIdentifier(p)); reply(id, false, ["error": "no_picker"]); return }
        vc.presentSafe(p) { [weak self] in self?.pending.removeValue(forKey: ObjectIdentifier(p)); self?.reply(id, false, ["error": "no_picker"]) }
    }

    func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let pe = pending.removeValue(forKey: ObjectIdentifier(c)) else { return }
        let (id, kind, tmp) = pe
        if let tmp { try? store.fm.removeItem(at: tmp) }
        guard let u = urls.first else { reply(id, true, nil); return }
        q.async {
            do {
                switch kind {
                case .export: self.reply(id, true, ["ok": true])
                case .importText:
                    let d = try Data(contentsOf: u)
                    self.reply(id, true, ["text": String(decoding: d.prefix(64 << 20), as: UTF8.self), "name": u.lastPathComponent])
                case .file:
                    let (t, f) = self.store.fresh(u.lastPathComponent)
                    try? self.store.fm.removeItem(at: f)
                    try self.store.fm.copyItem(at: u, to: f)
                    self.reply(id, true, ["token": t, "name": u.lastPathComponent, "size": self.store.size(f)])
                }
            } catch { self.reply(id, false, ["error": errName(error), "msg": String(String(describing: error).prefix(200))]) }
        }
    }

    func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) {
        guard let pe = pending.removeValue(forKey: ObjectIdentifier(c)) else { return }
        if let tmp = pe.2 { try? store.fm.removeItem(at: tmp) }
        reply(pe.0, true, nil)
    }
}
