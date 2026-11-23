import Foundation
import Darwin

/// Live-Bild direkt aus dem Heimnetz — Umsetzung von Cam.kt (Android). Je Drucker ein Faden, der die Kamera liest:
/// MJPEG-Strom (mjpg-streamer/crowsnest, Rinkhals), Einzelbilder im Takt, oder Bambu P1/A1 (eigener JPEG-Strom über TLS 6000).
/// Gehalten wird nur das neueste JPEG; die Oberfläche holt es über amp://app/cam/frame?k=<drucker>.
/// 8 s keine Bildanfrage → Faden endet, Verbindung zur Kamera geht zu.
final class CamFeed {
    let key: String
    let cond = NSCondition()
    var urls: [String] = []
    var frame: Data?
    var seq = 0, served = 0, frames = 0
    var lastReq = Live.now()
    var src: String?
    var err = ""
    var fps = 0.0
    var running = false
    private var fpsT: Double = 0, fpsN = 0
    init(_ key: String) { self.key = key }

    func put(_ b: Data) {
        cond.lock()
        frame = b; seq += 1; frames += 1; fpsN += 1
        let t = Live.now()
        if fpsT == 0 { fpsT = t }
        if t - fpsT >= 2000 { fps = Double(fpsN) * 1000 / (t - fpsT); fpsT = t; fpsN = 0 }
        cond.broadcast()
        cond.unlock()
    }
    var watched: Bool { cond.lock(); defer { cond.unlock() }; return Live.now() - lastReq < Cam.IDLE }
    func set(src s: String?, err e: String) { cond.lock(); src = s; err = e; cond.unlock() }
}

enum Cam {
    static let IDLE: Double = 8000
    static let MAX_FRAME = 4 << 20
    private static let lock = NSLock()
    private static var feeds: [String: CamFeed] = [:]

    private static func feed(_ key: String, create: Bool) -> CamFeed? {
        lock.lock(); defer { lock.unlock() }
        if let f = feeds[key] { return f }
        guard create else { return nil }
        let f = CamFeed(key); feeds[key] = f; return f
    }

    /// Kamera starten bzw. wach halten; urls = Kandidaten in Reihenfolge (Strom vor Schnappschuss)
    static func start(_ key: String, _ urls: [String]) -> [String: Any] {
        let f = feed(key, create: true)!
        var go = false
        f.cond.lock()
        f.lastReq = Live.now()
        if !urls.isEmpty && urls != f.urls { f.urls = urls; if let s = f.src, !urls.contains(s) { f.src = nil } }
        if !f.running { f.running = true; f.err = ""; go = true }
        f.cond.unlock()
        if go { Thread.detachNewThread { work(f) } }
        return status(f)
    }

    static func stop(_ key: String) { if let f = feed(key, create: false) { f.cond.lock(); f.lastReq = 0; f.cond.unlock() } }

    static func state(_ key: String) -> [String: Any] {
        guard let f = feed(key, create: false) else { return ["err": "none", "frames": 0] }
        return status(f)
    }

    private static func status(_ f: CamFeed) -> [String: Any] {
        f.cond.lock(); defer { f.cond.unlock() }
        return ["src": f.src as Any? ?? NSNull(), "err": f.err, "frames": f.frames, "fps": (f.fps * 10).rounded() / 10, "on": f.running]
    }

    /// Wartet bis zu waitMs auf ein Bild, das neuer ist als das zuletzt ausgelieferte (für /cam/frame)
    static func frame(_ key: String, waitMs: Double = 2500) -> Data? {
        guard let f = feed(key, create: false) else { return nil }
        f.cond.lock(); defer { f.cond.unlock() }
        f.lastReq = Live.now()
        let until = Date().addingTimeInterval(waitMs / 1000)
        while f.seq <= f.served && f.running { if !f.cond.wait(until: until) { break } }
        if f.seq > f.served { f.served = f.seq }
        return f.frame
    }

    private static func work(_ f: CamFeed) {
        while f.watched {
            f.cond.lock()
            var order: [String] = []
            for u in [f.src].compactMap({ $0 }) + f.urls where !order.contains(u) { order.append(u) }
            f.cond.unlock()
            var ok = false
            var tried: [String] = []
            for u in order {
                if !f.watched { break }
                let short = String((u.components(separatedBy: "://").last ?? u).prefix(60))
                if !privateURL(u) { tried.append("\(short): not in home network"); continue }
                let before = f.frames
                do { try read(f, u) } catch {
                    tried.append("\(short): \(String("\((error as? BErr)?.description ?? "\(error)")".prefix(60)))")
                    f.cond.lock(); if f.src == u { f.src = nil }; f.cond.unlock()
                }
                if f.frames > before { ok = true; break }
            }
            if !ok && f.watched {
                f.cond.lock(); f.err = order.isEmpty || tried.isEmpty ? "none" : tried.joined(separator: "; "); let e = f.err; f.cond.unlock()
                Log.write("cam \(f.key): \(e)")
                Thread.sleep(forTimeInterval: 3)
            }
        }
        f.cond.lock(); f.running = false; f.cond.broadcast(); f.cond.unlock()
        lock.lock(); if feeds[f.key] === f, !f.watched { feeds.removeValue(forKey: f.key) }; lock.unlock()
    }

    /// HTTP-GET über einen eigenen Socket (ohne URLSession: die zerlegt multipart/x-mixed-replace in lauter Einzelantworten)
    /// → Socket steht hinter den Kopfzeilen; Status und Kopfzeilen (klein geschrieben)
    static func rawGet(_ url: URL, timeoutMs: Int = 4000) throws -> (Sock, Int, [String: String]) {
        guard let host = url.host else { throw BErr("IllegalArgumentException", "bad_url") }
        let port = url.port ?? 80
        let s = try Sock(host: host, port: port, tls: false, connectTimeoutMs: timeoutMs)
        s.readTimeout = 15
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var path = c?.percentEncodedPath ?? "/"; if path.isEmpty { path = "/" }
        if let q = c?.percentEncodedQuery { path += "?" + q }
        do {
            try s.write(Data("GET \(path) HTTP/1.0\r\nHost: \(host):\(port)\r\nUser-Agent: AllMyPrinters\r\nAccept: */*\r\nConnection: close\r\n\r\n".utf8))
            var head = Data()
            while !head.suffix(4).elementsEqual([13, 10, 13, 10]) { head.append(try s.byte()); if head.count > 16384 { throw BErr("IOException", "bad header") } }
            let lines = String(decoding: head, as: UTF8.self).components(separatedBy: "\r\n")
            let status = Int(lines.first?.split(separator: " ").dropFirst().first.map(String.init) ?? "") ?? 0
            var h: [String: String] = [:]
            for l in lines.dropFirst() { if let i = l.firstIndex(of: ":") { h[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
            return (s, status, h)
        } catch { s.close(); throw error }
    }

    /// Eine Quelle lesen, solange jemand zusieht. Wirft, wenn sie kein Bild (mehr) liefert.
    private static func read(_ f: CamFeed, _ u: String) throws {
        if u.hasPrefix("bambu6000://") { try bambu6000(f, u); return }
        guard let url = URL(string: u) else { throw BErr("IllegalArgumentException", "bad_url") }
        if url.scheme?.lowercased() == "http" {
            let (s, st, h) = try rawGet(url)
            defer { s.close() }
            guard (200...299).contains(st) else { throw BErr("IOException", "HTTP \(st)") }
            let ct = (h["content-type"] ?? "").lowercased()
            if ct.hasPrefix("multipart/") {
                f.set(src: u, err: "")
                var buf = Data()
                while f.watched {
                    buf.append(try s.readSome(65536))
                    cut(&buf) { f.put($0) }
                    if buf.count > MAX_FRAME { buf.removeAll() }
                }
                throw BErr("IOException", "stream ended")
            }
            var img = Data()
            while img.count < MAX_FRAME, let d = try? s.readSome(65536) { img.append(d) }
            guard isJpeg(img) else { throw BErr("IOException", "no jpeg (\(ct))") }
            f.set(src: u, err: "")
            f.put(img)
            try poll(f, url)
            return
        }
        var rq = URLRequest(url: url); rq.timeoutInterval = 8; rq.setValue("AllMyPrinters", forHTTPHeaderField: "User-Agent")
        // MJPEG: JPEGs zwischen FFD8 und FFD9 herausschneiden; Einzelbild: erstes Bild, dann im Takt neu holen
        // https: URLSession liefert jeden Teil eines multipart-Stroms als eigene Antwort → Teil = Bild
        let job = Net.Job()
        var multipart = false, responses = 0
        var single = Data()
        job.onResp = { r in
            guard (200...299).contains(r.statusCode) else { return false }
            responses += 1
            if responses > 1 { multipart = true; if isJpeg(single) { f.put(single); f.set(src: u, err: "") }; single = Data() }
            return f.watched || responses == 1
        }
        job.onChunk = { d in
            if single.count < MAX_FRAME { single.append(d) }
            return !multipart || f.watched
        }
        do { try Net.shared.run(rq, job: job) } catch {
            if multipart { throw BErr("IOException", "stream ended") }
            throw error
        }
        let code = job.resp?.statusCode ?? 0
        if multipart { throw BErr("IOException", "stream ended") }
        if !(200...299).contains(code) { throw BErr("IOException", "HTTP \(code)") }
        guard isJpeg(single) else { throw BErr("IOException", "no jpeg (\(job.resp?.value(forHTTPHeaderField: "Content-Type") ?? ""))") }
        f.set(src: u, err: "")
        f.put(single)
        try poll(f, url)
    }

    /// Kameras ohne Strom: Einzelbild im Takt neu holen
    private static func poll(_ f: CamFeed, _ url: URL) throws {
        while f.watched {
            let t0 = Live.now()
            let j2 = Net.Job(); j2.max = MAX_FRAME
            var r2 = URLRequest(url: url); r2.timeoutInterval = 6
            try Net.shared.run(r2, job: j2)
            guard isJpeg(j2.data) else { throw BErr("IOException", "no jpeg") }
            f.put(j2.data)
            let wait = 150 - (Live.now() - t0)
            if wait > 0 { Thread.sleep(forTimeInterval: wait / 1000) }
        }
    }

    /// Ganze JPEGs (FFD8 … FFD9) aus dem Puffer schneiden, Rest vorne behalten
    private static func cut(_ buf: inout Data, _ put: (Data) -> Void) {
        while true {
            guard let s = find(buf, 0xD8, from: buf.startIndex) else {
                if let last = buf.last { buf = Data([last]) }   // FF kann über die Grenze reichen
                return
            }
            guard let e = find(buf, 0xD9, from: s + 2) else { if s > buf.startIndex { buf = Data(buf[s...]) }; return }
            put(Data(buf[s...(e + 1)]))
            buf = Data(buf[(e + 2)...])
        }
    }
    /// Index des FF vor dem Marker
    private static func find(_ d: Data, _ marker: UInt8, from: Data.Index) -> Data.Index? {
        var i = max(from, d.startIndex)
        while i + 1 < d.endIndex { if d[i] == 0xFF && d[i + 1] == marker { return i }; i += 1 }
        return nil
    }
    static func isJpeg(_ b: Data) -> Bool { b.count > 4 && b[b.startIndex] == 0xFF && b[b.startIndex + 1] == 0xD8 }

    /// Bambu P1/A1: TLS auf 6000, 80-Byte-Anmeldung („bblp“ + Access Code), dann je Bild 16-Byte-Kopf (Länge) + JPEG
    private static func bambu6000(_ f: CamFeed, _ u: String) throws {
        let c = URLComponents(string: u)
        let host = c?.host ?? "", port = c?.port ?? 6000
        let code = c?.queryItems?.first(where: { $0.name == "code" })?.value ?? ""
        let s = try Sock(host: host, port: port, tls: true, connectTimeoutMs: 6000)
        defer { s.close() }
        s.readTimeout = 15
        var auth = Data(count: 80)
        func le32(_ v: UInt32, at o: Int) { for k in 0..<4 { auth[o + k] = UInt8((v >> (8 * UInt32(k))) & 0xff) } }
        le32(0x40, at: 0); le32(0x3000, at: 4)
        for (k, b) in Array("bblp".utf8).enumerated() { auth[16 + k] = b }
        for (k, b) in Array(code.utf8).prefix(32).enumerated() { auth[48 + k] = b }
        try s.write(auth)
        f.set(src: u, err: "")
        while f.watched {
            let hdr = try s.read(16)
            let len = Int(hdr[hdr.startIndex]) | Int(hdr[hdr.startIndex + 1]) << 8 | Int(hdr[hdr.startIndex + 2]) << 16 | Int(hdr[hdr.startIndex + 3]) << 24
            if len <= 0 || len > 4_000_000 { throw BErr("IOException", "bad frame \(len)") }
            let img = try s.read(len)
            if isJpeg(img) { f.put(img) }
        }
        throw BErr("IOException", "stream ended")
    }

    /// Nur Kameras im eigenen Netz: alle Adressen des Namens müssen privat sein (auch 100.64/10 = Tailscale, fc00::/7)
    static func privateURL(_ u: String) -> Bool {
        guard let host = URLComponents(string: u)?.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), !host.isEmpty else { return false }
        var hints = addrinfo(); hints.ai_socktype = SOCK_STREAM
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &res) == 0, let first = res else { return false }
        defer { freeaddrinfo(first) }
        var any = false
        var p: UnsafeMutablePointer<addrinfo>? = first
        while let cur = p {
            any = true
            guard let sa = cur.pointee.ai_addr else { return false }
            if sa.pointee.sa_family == UInt8(AF_INET) {
                let a = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
                let b0 = a >> 24, b1 = (a >> 16) & 0xff
                let ok = b0 == 10 || b0 == 127 || (b0 == 172 && (16...31).contains(b1)) || (b0 == 192 && b1 == 168) || (b0 == 169 && b1 == 254) || (b0 == 100 && (b1 & 0xC0) == 64)
                if !ok { return false }
            } else if sa.pointee.sa_family == UInt8(AF_INET6) {
                let bytes = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { p6 in withUnsafeBytes(of: p6.pointee.sin6_addr) { Array($0) } }
                let loop = bytes.prefix(15).allSatisfy { $0 == 0 } && bytes[15] == 1
                let ok = loop || (bytes[0] & 0xFE) == 0xFC || (bytes[0] == 0xFE && (bytes[1] & 0xC0) == 0x80)
                if !ok { return false }
            } else { return false }
            p = cur.pointee.ai_next
        }
        return any
    }
}
