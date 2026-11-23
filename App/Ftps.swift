import Foundation
import Security
import Darwin

/// Bambu-Upload: implizites FTPS (990). Bambu (vsftpd mit require_ssl_reuse) verlangt, dass der Datenkanal die TLS-Sitzung des
/// Steuerkanals wiederverwendet. Network.framework lässt das nicht steuern → Secure Transport (von Apple als veraltet markiert,
/// aber vorhanden): gleiche SSLSetPeerID auf beiden Kanälen = Sitzung wird fortgesetzt. TLS 1.2, Druckerzertifikat angenommen.
/// Ablauf wie BambuIO.ftpsUpload (Android): erst PROT P, scheitert das (nicht 530/553) → noch einmal mit PROT C (A1).
enum Ftps {
    static func upload(host: String, code: String, file: URL, remote: String, port: Int, progress: @escaping (Int64, Int64) -> Void) throws -> String {
        do { return try once(host, code, file, remote, port, secureData: true, progress) }
        catch {
            let m = "\(error)"
            if m.contains("553") || m.contains("530") { throw error }   // kein Medium bzw. falsche Anmeldung — Rückfall hilft nicht
            return try once(host, code, file, remote, port, secureData: false, progress)
        }
    }

    private static func once(_ host: String, _ code: String, _ file: URL, _ remote: String, _ port: Int, secureData: Bool, _ progress: (Int64, Int64) -> Void) throws -> String {
        let peer = "\(host):\(port)"
        let ctrl = try TlsSock(host: host, port: port, timeoutMs: 8000)
        defer { ctrl.close() }
        try ctrl.startTLS(peerID: peer)
        ctrl.timeout = 30
        func reply() throws -> String {
            var line = try ctrl.readLine()
            let c3 = String(line.prefix(3))
            if line.count > 3 && Array(line)[3] == "-" { while true { let l = try ctrl.readLine(); if l.hasPrefix(c3 + " ") { line = l; break } } }
            return line
        }
        @discardableResult
        func cmd(_ c: String, _ ok: [String] = []) throws -> String {
            try ctrl.write(Data((c + "\r\n").utf8))
            let r = try reply()
            if !ok.isEmpty && !ok.contains(where: { r.hasPrefix($0) }) { throw BErr("IllegalStateException", "FTP \(c.split(separator: " ").first ?? ""): \(r)") }
            return r
        }
        let hi = try reply(); if !hi.hasPrefix("220") { throw BErr("IllegalStateException", "FTP: \(hi)") }
        try cmd("USER bblp", ["331", "230"])
        try cmd("PASS \(code)", ["230"])
        try cmd("PBSZ 0", ["200"]); try cmd(secureData ? "PROT P" : "PROT C", ["200"]); try cmd("TYPE I", ["200"])
        let pasv = try cmd("PASV", ["227"])
        guard let re = try? NSRegularExpression(pattern: "(\\d+),(\\d+),(\\d+),(\\d+),(\\d+),(\\d+)"),
              let m = re.firstMatch(in: pasv, range: NSRange(pasv.startIndex..., in: pasv)) else { throw BErr("IllegalStateException", "PASV: \(pasv)") }
        let g = { (i: Int) in Int(Range(m.range(at: i), in: pasv).map { String(pasv[$0]) } ?? "0") ?? 0 }
        let dport = g(5) * 256 + g(6)   // die Adresse in der Antwort ist oft 0.0.0.0 → Steuer-Host nehmen
        let data = try TlsSock(host: host, port: dport, timeoutMs: 8000)
        defer { data.close() }
        let st = try cmd("STOR \(remote)", ["150", "125"])
        // Handshake im Datenkanal erst nach 150 (Eigenheit laut open-bamboo-networking), mit derselben Sitzungskennung
        if secureData { try data.startTLS(peerID: peer) }
        data.timeout = 60
        let total = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 0
        let fh = try FileHandle(forReadingFrom: file); defer { try? fh.close() }
        var sent: Int64 = 0
        while true {
            let c = fh.readData(ofLength: 65536); if c.isEmpty { break }
            try data.write(c); sent += Int64(c.count); progress(sent, total)
        }
        data.close()
        ctrl.timeout = 90   // H2D braucht für „226“ über 30 s
        let done = try reply()
        if !done.hasPrefix("226") && !done.hasPrefix("250") { throw BErr("IllegalStateException", "FTP STOR: \(done) (\(st.prefix(40)))") }
        _ = try? cmd("QUIT")
        return remote
    }
}

/// TCP-Socket (BSD) mit optionalem TLS über Secure Transport — blockierend, mit Zeitlimit
final class TlsSock {
    let fd: Int32
    private var ctx: SSLContext?
    private let fdBox: UnsafeMutablePointer<Int32>
    private var rbuf = Data()
    private var closed = false
    var timeout: Int = 30 { didSet { setTimeout() } }

    init(host: String, port: Int, timeoutMs: Int) throws {
        var hints = addrinfo(); hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &res) == 0, let ai = res else { throw BErr("UnknownHostException", host) }
        defer { freeaddrinfo(ai) }
        let s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard s >= 0 else { throw BErr("SocketException", "socket") }
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        // Verbinden mit Zeitlimit: nicht blockierend + poll
        let fl = fcntl(s, F_GETFL, 0)
        _ = fcntl(s, F_SETFL, fl | O_NONBLOCK)
        let rc = connect(s, ai.pointee.ai_addr, ai.pointee.ai_addrlen)
        if rc != 0 && errno != EINPROGRESS { Darwin.close(s); throw BErr("ConnectException", "connect \(errno)") }
        if rc != 0 {
            var p = pollfd(fd: s, events: Int16(POLLOUT), revents: 0)
            let n = poll(&p, 1, Int32(timeoutMs))
            var err: Int32 = 0; var len = socklen_t(MemoryLayout<Int32>.size)
            getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &len)
            if n <= 0 { Darwin.close(s); throw BErr("SocketTimeoutException", "connect timeout") }
            if err != 0 { Darwin.close(s); throw BErr("ConnectException", err == ECONNREFUSED ? "refused" : "connect \(err)") }
        }
        _ = fcntl(s, F_SETFL, fl)
        fd = s
        fdBox = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
        fdBox.pointee = s
        setTimeout()
    }

    deinit { close(); fdBox.deallocate() }

    private func setTimeout() {
        var tv = timeval(tv_sec: timeout, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    /// TLS-Handshake (Client). peerID: gleiche Kennung = Secure Transport setzt die zwischengespeicherte Sitzung fort.
    func startTLS(peerID: String) throws {
        guard let c = SSLCreateContext(kCFAllocatorDefault, .clientSide, .streamType) else { throw BErr("SSLException", "context") }
        SSLSetIOFuncs(c, tlsRead, tlsWrite)
        SSLSetConnection(c, UnsafeRawPointer(fdBox))
        SSLSetProtocolVersionMin(c, .tlsProtocol12)
        SSLSetProtocolVersionMax(c, .tlsProtocol12)
        SSLSetSessionOption(c, .breakOnServerAuth, true)   // eigene Prüfung: Druckerzertifikate sind selbst ausgestellt → annehmen
        let pid = Array(peerID.utf8)
        SSLSetPeerID(c, pid, pid.count)
        var st: OSStatus
        repeat { st = SSLHandshake(c) } while st == errSSLWouldBlock || st == errSSLPeerAuthCompleted
        guard st == noErr else { throw BErr("SSLException", "handshake \(st)") }
        ctx = c
    }

    func write(_ d: Data) throws {
        if let c = ctx {
            var off = 0
            while off < d.count {
                var n = 0
                let st = d.withUnsafeBytes { p in SSLWrite(c, p.baseAddress! + off, d.count - off, &n) }
                off += n
                if st != noErr && st != errSSLWouldBlock { throw BErr("IOException", "ssl write \(st)") }
                if st == errSSLWouldBlock && n == 0 { throw BErr("SocketTimeoutException", "write timeout") }
            }
        } else {
            var off = 0
            while off < d.count {
                let n = d.withUnsafeBytes { p in Darwin.write(fd, p.baseAddress! + off, d.count - off) }
                if n <= 0 { throw BErr("IOException", "write \(errno)") }
                off += n
            }
        }
    }

    private func fill() throws {
        var buf = [UInt8](repeating: 0, count: 16384)
        let cap = buf.count
        var n = 0
        if let c = ctx {
            let st = buf.withUnsafeMutableBytes { p in SSLRead(c, p.baseAddress!, cap, &n) }
            if n == 0 {
                if st == errSSLClosedGraceful || st == errSSLClosedNoNotify { throw BErr("IOException", "closed") }
                if st == errSSLWouldBlock { throw BErr("SocketTimeoutException", "Read timed out") }
                if st != noErr { throw BErr("IOException", "ssl read \(st)") }
            }
        } else {
            n = buf.withUnsafeMutableBytes { p in Darwin.read(fd, p.baseAddress!, cap) }
            if n == 0 { throw BErr("IOException", "closed") }
            if n < 0 { throw BErr(errno == EAGAIN ? "SocketTimeoutException" : "IOException", errno == EAGAIN ? "Read timed out" : "read \(errno)") }
        }
        rbuf.append(contentsOf: buf[0..<n])
    }

    func readLine() throws -> String {
        while true {
            if let i = rbuf.firstIndex(of: 10) {
                let line = rbuf[rbuf.startIndex..<i]
                rbuf = Data(rbuf[(i + 1)...])
                return String(decoding: line, as: UTF8.self).trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
            }
            try fill()
        }
    }

    func close() {
        if closed { return }
        closed = true
        if let c = ctx { SSLClose(c) }
        Darwin.close(fd)
    }
}

/// Secure-Transport-Rückrufe: Verbindung = Zeiger auf den Socket (blockierend, mit SO_RCVTIMEO/SO_SNDTIMEO)
private func tlsRead(_ conn: SSLConnectionRef, _ data: UnsafeMutableRawPointer, _ len: UnsafeMutablePointer<Int>) -> OSStatus {
    let fd = conn.assumingMemoryBound(to: Int32.self).pointee
    let want = len.pointee
    var got = 0
    while got < want {
        let n = Darwin.read(fd, data + got, want - got)
        if n > 0 { got += n; continue }
        len.pointee = got
        if n == 0 { return errSSLClosedGraceful }
        return errno == EAGAIN || errno == EWOULDBLOCK ? errSSLWouldBlock : errSecIO
    }
    len.pointee = got
    return noErr
}

private func tlsWrite(_ conn: SSLConnectionRef, _ data: UnsafeRawPointer, _ len: UnsafeMutablePointer<Int>) -> OSStatus {
    let fd = conn.assumingMemoryBound(to: Int32.self).pointee
    let want = len.pointee
    var put = 0
    while put < want {
        let n = Darwin.write(fd, data + put, want - put)
        if n > 0 { put += n; continue }
        len.pointee = put
        return errno == EAGAIN || errno == EWOULDBLOCK ? errSSLWouldBlock : errSecIO
    }
    len.pointee = put
    return noErr
}
