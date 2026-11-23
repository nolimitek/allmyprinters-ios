import Foundation
import Network
import Security

/// TCP/TLS-Verbindung mit blockierendem Lesen (wie Socket + DataInputStream auf Android), für die Live-Protokolle.
/// TLS: höchstens 1.2 (Bambu P2S antwortet nicht auf TLS-1.3-ClientHello), selbst ausgestellte Druckerzertifikate werden
/// angenommen — Verbindungen nur im eigenen Netz. Der CN des Druckerzertifikats wird gemerkt (Bambu: CN = Seriennummer).
final class Sock {
    private let conn: NWConnection
    private let cond = NSCondition()
    private var buf = Data()
    private var closed = false
    private var failure: String?
    private let q = DispatchQueue(label: "amp.sock")
    private(set) var peerCN: String?
    var readTimeout: TimeInterval = 45

    init(host: String, port: Int, tls: Bool, connectTimeoutMs: Int = 8000) throws {
        guard let p = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { throw BErr("IllegalArgumentException", "port") }
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = max(1, connectTimeoutMs / 1000)
        tcp.noDelay = true
        let params: NWParameters
        if tls {
            let t = NWProtocolTLS.Options()
            let so = t.securityProtocolOptions
            sec_protocol_options_set_max_tls_protocol_version(so, .TLSv12)
            sec_protocol_options_set_min_tls_protocol_version(so, .TLSv12)
            var cn: String?
            let cnLock = NSLock()
            sec_protocol_options_set_verify_block(so, { _, trust, done in
                let st = sec_trust_copy_ref(trust).takeRetainedValue()
                if let chain = SecTrustCopyCertificateChain(st) as? [SecCertificate], let leaf = chain.first {
                    var name: CFString?
                    if SecCertificateCopyCommonName(leaf, &name) == errSecSuccess, let n = name as String? { cnLock.lock(); cn = n; cnLock.unlock() }
                }
                done(true)
            }, DispatchQueue.global(qos: .userInitiated))
            params = NWParameters(tls: t, tcp: tcp)
            conn = NWConnection(host: NWEndpoint.Host(host), port: p, using: params)
            try start(timeoutMs: connectTimeoutMs)
            cnLock.lock(); peerCN = cn; cnLock.unlock()
        } else {
            params = NWParameters(tls: nil, tcp: tcp)
            conn = NWConnection(host: NWEndpoint.Host(host), port: p, using: params)
            try start(timeoutMs: connectTimeoutMs)
        }
        receive()
    }

    private func start(timeoutMs: Int) throws {
        let sem = DispatchSemaphore(value: 0)
        var err: String?
        var ready = false
        let l = NSLock()
        conn.stateUpdateHandler = { [weak self] st in
            switch st {
            case .ready: l.lock(); ready = true; l.unlock(); sem.signal()
            case .failed(let e): l.lock(); err = Self.describe(e); l.unlock(); sem.signal(); self?.markClosed(Self.describe(e))
            case .waiting(let e): l.lock(); err = Self.describe(e); l.unlock(); sem.signal()
            case .cancelled: self?.markClosed("closed"); sem.signal()
            default: break
            }
        }
        conn.start(queue: q)
        if sem.wait(timeout: .now() + .milliseconds(timeoutMs + 500)) == .timedOut { conn.cancel(); throw BErr("SocketTimeoutException", "timeout") }
        l.lock(); let ok = ready, e = err; l.unlock()
        if !ok { conn.cancel(); throw BErr(e?.contains("refused") == true ? "ConnectException" : "IOException", e ?? "connect") }
    }

    static func describe(_ e: NWError) -> String {
        switch e {
        case .posix(let c): return c == .ECONNREFUSED ? "refused" : c == .ETIMEDOUT ? "timeout" : "\(c)"
        case .tls(let s): return "tls \(s)"
        case .dns(let d): return "dns \(d)"
        default: return "\(e)"
        }
    }

    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            self.cond.lock()
            if let data, !data.isEmpty { self.buf.append(data) }
            if complete || error != nil { self.closed = true; if self.failure == nil { self.failure = error.map { Self.describe($0) } ?? "closed" } }
            self.cond.broadcast()
            self.cond.unlock()
            if !(complete || error != nil) { self.receive() }
        }
    }

    private func markClosed(_ why: String) { cond.lock(); closed = true; if failure == nil { failure = why }; cond.broadcast(); cond.unlock() }

    /// Genau n Bytes lesen (wartet höchstens readTimeout ohne neue Daten)
    func read(_ n: Int) throws -> Data {
        cond.lock(); defer { cond.unlock() }
        while buf.count < n {
            if closed { throw BErr("IOException", failure ?? "closed") }
            let before = buf.count
            if !cond.wait(until: Date().addingTimeInterval(readTimeout)) && buf.count == before { throw BErr("SocketTimeoutException", "Read timed out") }
        }
        let d = buf.prefix(n)
        buf.removeFirst(n)
        return Data(d)
    }
    /// Was gerade da ist (mindestens 1 Byte, höchstens max) — für Datenströme (Kamera)
    func readSome(_ max: Int) throws -> Data {
        cond.lock(); defer { cond.unlock() }
        while buf.isEmpty {
            if closed { throw BErr("IOException", failure ?? "closed") }
            if !cond.wait(until: Date().addingTimeInterval(readTimeout)) && buf.isEmpty { throw BErr("SocketTimeoutException", "Read timed out") }
        }
        let n = min(max, buf.count)
        let d = Data(buf.prefix(n))
        buf.removeFirst(n)
        return d
    }
    func byte() throws -> UInt8 { try read(1).first! }
    func u16() throws -> Int { let d = try read(2); return Int(d[d.startIndex]) << 8 | Int(d[d.startIndex + 1]) }

    func write(_ d: Data) throws {
        let sem = DispatchSemaphore(value: 0)
        var err: NWError?
        conn.send(content: d, completion: .contentProcessed { e in err = e; sem.signal() })
        if sem.wait(timeout: .now() + 30) == .timedOut { throw BErr("SocketTimeoutException", "write timeout") }
        if let err { throw BErr("IOException", Self.describe(err)) }
    }

    func close() { markClosed("closed"); conn.cancel() }
    var isClosed: Bool { cond.lock(); defer { cond.unlock() }; return closed }
}
