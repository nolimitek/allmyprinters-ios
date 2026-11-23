import Foundation
import Network
import CryptoKit

/// HTTP zu Druckern/Slicer, blockierend aus dem Brücken-Warteschlangen-Faden (wie HttpURLConnection auf Android).
/// Ein URLSession-Delegat für alle Aufträge: Fortschritt beim Senden/Empfangen, Empfang wahlweise in eine Datei.
final class Net: NSObject, URLSessionDataDelegate {
    static let shared = Net()

    final class Job {
        var data = Data()
        var max = Int.max
        var out: FileHandle?
        var got: Int64 = 0
        var expected: Int64 = -1
        var resp: HTTPURLResponse?
        var err: Error?
        var onSend: ((Int64, Int64) -> Void)?
        var onRecv: ((Int64, Int64) -> Void)?
        // Datenstrom (Kamera): onResp darf ablehnen, onChunk bekommt jedes Stück (false = abbrechen), onDone statt Warten
        var onResp: ((HTTPURLResponse) -> Bool)?
        var onChunk: ((Data) -> Bool)?
        var onDone: ((Error?) -> Void)?
        let done = DispatchSemaphore(value: 0)
    }

    private var session: URLSession!
    private let lock = NSLock()
    private var jobs: [Int: Job] = [:]

    override init() {
        super.init()
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForResource = 3600
        c.httpMaximumConnectionsPerHost = 8
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }

    /// Auftrag starten und warten (nie vom Hauptfaden aus aufrufen)
    @discardableResult
    func run(_ req: URLRequest, uploadFile: URL? = nil, job: Job = Job()) throws -> Job {
        let t: URLSessionTask
        if let f = uploadFile { t = session.uploadTask(with: req, fromFile: f) } else { t = session.dataTask(with: req) }
        lock.lock(); jobs[t.taskIdentifier] = job; lock.unlock()
        t.resume()
        job.done.wait()
        if let e = job.err { throw e }
        return job
    }

    /// Ohne Warten starten (Kamera-Durchleitung); die Rückrufe in job melden Kopf, Daten und Ende
    @discardableResult
    func stream(_ req: URLRequest, job: Job) -> URLSessionDataTask {
        let t = session.dataTask(with: req)
        lock.lock(); jobs[t.taskIdentifier] = job; lock.unlock()
        t.resume()
        return t
    }

    private func job(_ t: URLSessionTask) -> Job? { lock.lock(); defer { lock.unlock() }; return jobs[t.taskIdentifier] }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let j = job(dataTask) {
            j.resp = response as? HTTPURLResponse; j.expected = response.expectedContentLength
            if let cb = j.onResp, let r = j.resp, !cb(r) { completionHandler(.cancel); return }
        }
        completionHandler(.allow)
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let j = job(dataTask) else { return }
        if let cb = j.onChunk { if !cb(data) { dataTask.cancel() }; return }
        j.got += Int64(data.count)
        if let fh = j.out { fh.write(data) }
        else if j.data.count < j.max { j.data.append(data.prefix(j.max - j.data.count)) }
        j.onRecv?(j.got, j.expected)
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didSendBodyData sent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        job(task)?.onSend?(totalBytesSent, totalBytesExpectedToSend)
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let j = jobs.removeValue(forKey: task.taskIdentifier); lock.unlock()
        guard let j else { return }
        if j.resp == nil { j.resp = task.response as? HTTPURLResponse }
        j.err = error
        j.onDone?(error)
        j.done.signal()
    }

    // ── Hilfen ──
    static func request(_ a: [String: Any], url: String? = nil, method: String? = nil, timeoutMs: Int = 8000) throws -> URLRequest {
        guard let u = URL(string: url ?? (a["url"] as? String ?? "")), u.scheme != nil else { throw BErr("IllegalArgumentException", "bad_url") }
        var r = URLRequest(url: u)
        r.httpMethod = method ?? (a["method"] as? String ?? "GET")
        r.timeoutInterval = Double(max(1000, timeoutMs)) / 1000
        if let h = a["headers"] as? [String: Any] { for (k, v) in h { r.setValue("\(v)", forHTTPHeaderField: k) } }
        return r
    }

    static func headers(_ r: HTTPURLResponse?) -> [String: String] {
        var o: [String: String] = [:]
        for (k, v) in r?.allHeaderFields ?? [:] { o[String(describing: k).lowercased()] = String(describing: v) }
        return o
    }

    /// HTTP-Digest (PrusaLink, WebDAV) wie Bridge.kt digest()
    static func digest(_ challenge: String, method: String, url: URL, user: String, pass: String) -> String {
        let body = challenge.range(of: "Digest ", options: .caseInsensitive).map { String(challenge[$0.upperBound...]) } ?? challenge
        var p: [String: String] = [:]
        let re = try! NSRegularExpression(pattern: "(\\w+)=(?:\"([^\"]*)\"|([^,\\s]*))")
        for m in re.matches(in: body, range: NSRange(body.startIndex..., in: body)) {
            let g = { (i: Int) -> String in m.range(at: i).location == NSNotFound ? "" : String(body[Range(m.range(at: i), in: body)!]) }
            p[g(1).lowercased()] = g(2).isEmpty ? g(3) : g(2)
        }
        let md5 = { (s: String) in Insecure.MD5.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
        let uri = (url.path.isEmpty ? "/" : url.path) + (url.query.map { "?" + $0 } ?? "")
        let realm = p["realm"] ?? "", nonce = p["nonce"] ?? ""
        let qop = p["qop"]?.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.first { $0 == "auth" }
        let ha1 = md5("\(user):\(realm):\(pass)"), ha2 = md5("\(method):\(uri)")
        let cn = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(16))
        let resp = qop != nil ? md5("\(ha1):\(nonce):00000001:\(cn):auth:\(ha2)") : md5("\(ha1):\(nonce):\(ha2)")
        var s = "Digest username=\"\(user)\", realm=\"\(realm)\", nonce=\"\(nonce)\", uri=\"\(uri)\", response=\"\(resp)\""
        if qop != nil { s += ", qop=auth, nc=00000001, cnonce=\"\(cn)\"" }
        if let o = p["opaque"] { s += ", opaque=\"\(o)\"" }
        if let al = p["algorithm"] { s += ", algorithm=\(al)" }
        return s
    }

    /// TCP-Verbindung möglich? (tcpcheck, scan)
    static func tcpOpen(_ host: String, _ port: Int, timeoutMs: Int) -> Bool {
        guard let pt = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return false }
        let c = NWConnection(host: NWEndpoint.Host(host), port: pt, using: .tcp)
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        let l = NSLock()
        c.stateUpdateHandler = { st in
            switch st {
            case .ready: l.lock(); ok = true; l.unlock(); sem.signal()
            case .failed, .cancelled: sem.signal()
            case .waiting: sem.signal()   // z. B. „Connection refused“ — nicht weiter warten
            default: break
            }
        }
        c.start(queue: DispatchQueue.global(qos: .userInitiated))
        _ = sem.wait(timeout: .now() + .milliseconds(max(100, timeoutMs)))
        c.stateUpdateHandler = nil
        c.cancel()
        l.lock(); defer { l.unlock() }
        return ok
    }
}

/// Fehler mit Namen wie auf Android (JS sieht e.message = error, e.data.msg = msg)
struct BErr: Error, CustomStringConvertible {
    let error: String, msg: String
    init(_ error: String, _ msg: String = "") { self.error = error; self.msg = msg }
    var description: String { msg.isEmpty ? error : msg }
}

func errName(_ e: Error) -> String {
    if let b = e as? BErr { return b.error }
    if let u = e as? URLError {
        switch u.code {
        case .timedOut: return "timeout"
        case .cannotFindHost, .dnsLookupFailed: return "dns"
        case .cannotConnectToHost: return "refused"
        case .notConnectedToInternet, .networkConnectionLost: return "unreachable"
        default: return "URLError\(u.code.rawValue)"
        }
    }
    return String(describing: type(of: e))
}
