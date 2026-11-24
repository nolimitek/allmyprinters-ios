import Foundation
import CryptoKit

/// RTSP(S) → FLV für den Livestream-Spieler (flv.js), wie Rtsp.kt auf Android (24.11.2026). Bambu X1/H2/P2S senden ihr Kamerabild als
/// H.264 über rtsps://bblp:<Access Code>@IP:322/streaming/live/1 (am Drucker „LAN Only Liveview“ einschalten). RTP läuft verschachtelt
/// über dieselbe TCP-Verbindung (interleaved), H.264-Nutzlast nach RFC 6184 (einzeln, STAP-A, FU-A). Nur Bild, kein Ton.
/// /cam/live (Store.swift camPipe) ruft next() in einer Schleife und reicht die FLV-Bytes an die Seite.
final class Rtsp {
    private struct Resp { let code: Int; let headers: [String: String]; let body: Data }

    private let user: String, pass: String, base: String
    private var aggregate: String
    let sock: Sock
    private var cseq = 0
    private var session: String?
    private var auth: ((String, String) -> String)?
    private var keepAlive: TimeInterval = 25
    private var lastKeep = Date()
    private var videoCh = 0
    // H.264
    private var sps: Data?, pps: Data?, sentSps: Data?
    private var headerSent = false
    private var ts0: Int64 = -1, curTs: Int64 = -1
    private var lastSeq = -1
    private var au: [Data] = []
    private var fu: Data?
    private var closed = false

    /// Aushandeln (DESCRIBE/SETUP/PLAY) sofort — Fehler kommen als Ausnahme, bevor die Seite ein Byte sieht
    init(_ url: String) throws {
        guard let c = URLComponents(string: url), let host = c.host, let sc = c.scheme?.lowercased(), sc == "rtsp" || sc == "rtsps" else { throw BErr("IllegalArgumentException", "bad_url") }
        user = c.user ?? ""; pass = c.password ?? ""
        let tls = sc == "rtsps", port = c.port ?? (tls ? 322 : 554)
        base = sc + "://" + host + ":\(port)" + (c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath) + (c.percentEncodedQuery.map { "?" + $0 } ?? "")
        aggregate = base
        sock = try Sock(host: host, port: port, tls: tls, connectTimeoutMs: 5000)
        sock.readTimeout = 10
        do { try handshake() } catch { sock.close(); throw error }
        sock.readTimeout = 15
        lastKeep = Date()
    }

    private func handshake() throws {
        var r = try request("DESCRIBE", base, ["Accept": "application/sdp"])
        if r.code == 401 {
            guard let h = r.headers["www-authenticate"] else { throw BErr("IllegalStateException", "auth") }
            auth = authFor(h)
            r = try request("DESCRIBE", base, ["Accept": "application/sdp"])
        }
        if r.code == 401 { throw BErr("IllegalStateException", "login") }
        if r.code != 200 { throw BErr("IllegalStateException", "describe \(r.code)") }
        aggregate = r.headers["content-base"] ?? r.headers["content-location"] ?? base
        let cbase = aggregate.hasSuffix("/") ? aggregate : aggregate + "/"
        // Erste m=video-Spur: Steueradresse, H.264-Parametersätze (sprop-parameter-sets)
        var inVideo = false, found = false
        var control: String?
        for raw in String(decoding: r.body, as: UTF8.self).split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("m=") { if found { break }; inVideo = line.hasPrefix("m=video"); if inVideo { found = true }; continue }
            if !inVideo { continue }
            if line.hasPrefix("a=control:") { control = String(line.dropFirst(10)).trimmingCharacters(in: .whitespaces) }
            if line.hasPrefix("a=rtpmap:") && line.range(of: "H264", options: .caseInsensitive) == nil { throw BErr("IllegalStateException", "codec") }
            if line.hasPrefix("a=fmtp:"), let rg = line.range(of: "sprop-parameter-sets=") {
                let v = line[rg.upperBound...].prefix { $0 != ";" && $0 != " " }
                for p in v.split(separator: ",") {
                    guard let n = Data(base64Encoded: String(p), options: .ignoreUnknownCharacters), let f = n.first else { continue }
                    if f & 0x1F == 7 { sps = n } else if f & 0x1F == 8 { pps = n }
                }
            }
        }
        if !found { throw BErr("IllegalStateException", "no video") }
        let track: String
        if let c = control, c != "*" { track = c.lowercased().hasPrefix("rtsp") ? c : cbase + c } else { track = aggregate }
        r = try request("SETUP", track, ["Transport": "RTP/AVP/TCP;unicast;interleaved=0-1"])
        if r.code != 200 { throw BErr("IllegalStateException", "setup \(r.code)") }
        guard let sh = r.headers["session"] else { throw BErr("IllegalStateException", "session") }
        session = sh.components(separatedBy: ";").first?.trimmingCharacters(in: .whitespaces)
        if let m = sh.range(of: "timeout=") { let n = Double(sh[m.upperBound...].prefix { $0.isNumber }) ?? 60; keepAlive = min(60, max(5, n / 2)) }
        if let t = r.headers["transport"], let m = t.range(of: "interleaved=") { videoCh = Int(t[m.upperBound...].prefix { $0.isNumber }) ?? 0 }
        r = try request("PLAY", aggregate, ["Range": "npt=0.000-"])
        if r.code != 200 { throw BErr("IllegalStateException", "play \(r.code)") }
    }

    private static func md5(_ s: String) -> String { Insecure.MD5.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func field(_ h: String, _ k: String) -> String {
        guard let r = h.range(of: k + "=\"") else { return "" }
        return String(h[r.upperBound...].prefix { $0 != "\"" })
    }
    private func authFor(_ h: String) -> (String, String) -> String {
        if h.lowercased().hasPrefix("basic") {
            let v = "Basic " + Data("\(user):\(pass)".utf8).base64EncodedString()
            return { _, _ in v }
        }
        let realm = field(h, "realm"), nonce = field(h, "nonce"), u = user
        let ha1 = Self.md5("\(user):\(realm):\(pass)")
        return { m, uri in "Digest username=\"\(u)\", realm=\"\(realm)\", nonce=\"\(nonce)\", uri=\"\(uri)\", response=\"\(Self.md5("\(ha1):\(nonce):" + Self.md5("\(m):\(uri)")))\"" }
    }

    private func send(_ method: String, _ u: String, _ extra: [String: String] = [:]) throws {
        cseq += 1
        var s = "\(method) \(u) RTSP/1.0\r\nCSeq: \(cseq)\r\nUser-Agent: AllMyPrinters\r\n"
        if let a = auth { s += "Authorization: " + a(method, u) + "\r\n" }
        if let se = session { s += "Session: \(se)\r\n" }
        for (k, v) in extra { s += "\(k): \(v)\r\n" }
        s += "\r\n"
        try sock.write(Data(s.utf8))
    }

    private func request(_ method: String, _ u: String, _ extra: [String: String]) throws -> Resp {
        try send(method, u, extra)
        while true {
            let b = try sock.byte()
            if b == 0x24 { _ = try sock.byte(); _ = try sock.read(try sock.u16()); continue }   // RTP vor der Antwort
            return try readResponse(b)
        }
    }

    private func readLine(_ first: UInt8? = nil) throws -> String {
        var d = Data(); if let f = first { d.append(f) }
        while true {
            let c = try sock.byte()
            if c == 0x0A { break }
            if c != 0x0D { d.append(c) }
            if d.count > 8192 { throw BErr("IllegalStateException", "line too long") }
        }
        return String(decoding: d, as: UTF8.self)
    }

    private func readResponse(_ first: UInt8) throws -> Resp {
        let status = try readLine(first)
        guard status.hasPrefix("RTSP/") else { throw BErr("IllegalStateException", "bad response") }
        let parts = status.split(separator: " ")
        guard parts.count > 1, let code = Int(parts[1]) else { throw BErr("IllegalStateException", "bad status") }
        var h: [String: String] = [:]
        while true {
            let l = try readLine(); if l.isEmpty { break }
            guard let i = l.firstIndex(of: ":") else { continue }
            let k = l[..<i].trimmingCharacters(in: .whitespaces).lowercased(), v = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
            if k == "www-authenticate", h[k]?.lowercased().hasPrefix("digest") == true { continue }   // Digest vor Basic
            h[k] = v
        }
        let n = min(1 << 20, max(0, Int(h["content-length"] ?? "") ?? 0))
        let body = n > 0 ? try sock.read(n) : Data()
        return Resp(code: code, headers: h, body: body)
    }

    /// Nächste FLV-Bytes (mindestens ein Stück); wirft bei Ende/Fehler
    func next() throws -> Data {
        var o = Data()
        while o.isEmpty {
            if closed { throw BErr("IOException", "closed") }
            if Date().timeIntervalSince(lastKeep) > keepAlive { lastKeep = Date(); try send("OPTIONS", aggregate) }   // Sitzung am Leben halten
            let c = try sock.byte()
            if c != 0x24 { _ = try readResponse(c); continue }   // Antwort auf OPTIONS
            let ch = Int(try sock.byte()), n = try sock.u16()
            let p = try sock.read(n)
            if ch == videoCh { rtp([UInt8](p), &o) }
        }
        return o
    }

    func close() {
        if closed { return }
        closed = true
        try? send("TEARDOWN", aggregate)
        sock.close()
    }

    private func rtp(_ p: [UInt8], _ o: inout Data) {
        guard p.count >= 12, p[0] & 0xC0 == 0x80 else { return }
        var off = 12 + 4 * Int(p[0] & 0x0F)
        if p[0] & 0x10 != 0 { guard p.count >= off + 4 else { return }; off += 4 + 4 * (Int(p[off + 2]) << 8 | Int(p[off + 3])) }
        var end = p.count
        if p[0] & 0x20 != 0 { end -= Int(p[p.count - 1]) }
        guard off < end else { return }
        let marker = p[1] & 0x80 != 0
        let seq = Int(p[2]) << 8 | Int(p[3])
        if lastSeq >= 0 && seq != (lastSeq + 1) & 0xFFFF { fu = nil }   // Lücke: angefangenes Bruchstück verwerfen
        lastSeq = seq
        let b4 = Int64(p[4]) << 24, b5 = Int64(p[5]) << 16, b6 = Int64(p[6]) << 8
        let ts = b4 | b5 | b6 | Int64(p[7])
        if curTs >= 0 && ts != curTs && !au.isEmpty { flush(&o) }
        curTs = ts
        let t = p[off] & 0x1F
        if t >= 1 && t <= 23 { au.append(Data(p[off..<end])) }
        else if t == 24 {   // STAP-A: mehrere NAL-Einheiten mit je 2 Byte Länge
            var i = off + 1
            while i + 2 <= end {
                let n = Int(p[i]) << 8 | Int(p[i + 1]); i += 2
                if n == 0 || i + n > end { break }
                au.append(Data(p[i..<(i + n)])); i += n
            }
        } else if t == 28 {   // FU-A: eine NAL-Einheit in Stücken
            guard off + 2 <= end else { return }
            let h = p[off + 1]
            if h & 0x80 != 0 { fu = Data([UInt8((p[off] & 0xE0) | (h & 0x1F))]) }
            guard fu != nil else { return }
            fu!.append(contentsOf: p[(off + 2)..<end])
            if h & 0x40 != 0 { au.append(fu!); fu = nil }
        }
        if marker { flush(&o) }
    }

    private static func be32(_ n: Int) -> [UInt8] { [UInt8((n >> 24) & 0xFF), UInt8((n >> 16) & 0xFF), UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF)] }

    /// Ein Bild (Access Unit) als FLV-Videotag; vorher Kopf + AVC-Konfiguration, erst ab dem ersten Schlüsselbild
    private func flush(_ o: inout Data) {
        if au.isEmpty { return }
        let nals = au; au.removeAll()
        var key = false
        var body = Data()
        for n in nals {
            guard let f = n.first else { continue }
            switch f & 0x1F {
            case 7: sps = n; continue
            case 8: pps = n; continue
            case 9: continue   // Zugriffstrenner braucht FLV nicht
            case 5: key = true
            default: break
            }
            body.append(contentsOf: Self.be32(n.count)); body.append(n)
        }
        if body.isEmpty { return }
        if !headerSent {
            guard sps != nil, pps != nil, key else { return }
            o.append(contentsOf: [0x46, 0x4C, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0])
            headerSent = true; ts0 = curTs
        }
        if let s = sps, let q = pps, key, s != sentSps, s.count >= 4 {   // Konfiguration (neu) senden
            let sb = [UInt8](s)
            var cfg = Data([0x17, 0, 0, 0, 0, 1, sb[1], sb[2], sb[3], 0xFF, 0xE1])
            cfg.append(contentsOf: [UInt8((s.count >> 8) & 0xFF), UInt8(s.count & 0xFF)]); cfg.append(s)
            cfg.append(contentsOf: [1, UInt8((q.count >> 8) & 0xFF), UInt8(q.count & 0xFF)]); cfg.append(q)
            tag(&o, ms(), cfg)
            sentSps = s
        }
        let flag: UInt8 = key ? 0x17 : 0x27
        var v = Data([flag, 1, 0, 0, 0])
        v.append(body)
        tag(&o, ms(), v)
    }

    private func ms() -> Int { Int(((curTs - ts0) & 0xFFFFFFFF) / 90) }   // 90-kHz-Takt → ms

    private func tag(_ o: inout Data, _ t: Int, _ d: Data) {
        o.append(9)
        o.append(contentsOf: [UInt8((d.count >> 16) & 0xFF), UInt8((d.count >> 8) & 0xFF), UInt8(d.count & 0xFF)])
        o.append(contentsOf: [UInt8((t >> 16) & 0xFF), UInt8((t >> 8) & 0xFF), UInt8(t & 0xFF), UInt8((t >> 24) & 0xFF)])
        o.append(contentsOf: [0, 0, 0])
        o.append(d)
        o.append(contentsOf: Self.be32(11 + d.count))
    }
}
