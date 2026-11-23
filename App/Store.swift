import Foundation
import WebKit
import UniformTypeIdentifiers

/// Dateien der App: eigene Daten (JSON, atomar, in der iCloud-Sicherung), Zwischenspeicher mit Kennungen (wie Androids
/// files/names in Bridge.kt) und die Bibliothek (Modelle, Vorschaubilder, 3D-Netze — nicht in der Sicherung, können groß sein).
final class Store {
    let fm = FileManager.default
    let dataDir: URL, cacheDir: URL, libDir: URL, libThumbs: URL, libMeshes: URL
    private let lock = NSLock()
    private var files: [String: URL] = [:]
    private var names: [String: String] = [:]

    init() {
        let sup = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        dataDir = sup.appendingPathComponent("amp", isDirectory: true)
        libDir = sup.appendingPathComponent("library", isDirectory: true)
        libThumbs = sup.appendingPathComponent("library-thumbs", isDirectory: true)
        libMeshes = sup.appendingPathComponent("library-mesh", isDirectory: true)
        cacheDir = caches.appendingPathComponent("files", isDirectory: true)
        for d in [dataDir, libDir, libThumbs, libMeshes, cacheDir] { try? fm.createDirectory(at: d, withIntermediateDirectories: true) }
        for var d in [libDir, libThumbs, libMeshes] {
            var v = URLResourceValues(); v.isExcludedFromBackup = true; try? d.setResourceValues(v)
        }
        // Zwischenspeicher älter als ein Tag weg (wie copyIn auf Android)
        let old = Date().addingTimeInterval(-86_400)
        for f in (try? fm.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let m = try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, m < old { try? fm.removeItem(at: f) }
        }
    }

    func newToken() -> String { UUID().uuidString.lowercased() }
    func put(_ token: String, _ url: URL, _ name: String) { lock.lock(); files[token] = url; names[token] = name; lock.unlock() }
    func file(_ token: String) -> URL? { lock.lock(); defer { lock.unlock() }; return files[token] }
    func name(_ token: String) -> String? { lock.lock(); defer { lock.unlock() }; return names[token] }
    func drop(_ token: String) {
        lock.lock(); let u = files.removeValue(forKey: token); names.removeValue(forKey: token); lock.unlock()
        if let u, u.path.hasPrefix(cacheDir.path) { try? fm.removeItem(at: u) }
    }
    /// Neue leere Datei im Zwischenspeicher → (Kennung, Ort)
    func fresh(_ name: String, prefix: String = "") -> (String, URL) {
        let t = prefix + newToken()
        let u = cacheDir.appendingPathComponent(t)
        fm.createFile(atPath: u.path, contents: nil)
        put(t, u, name)
        return (t, u)
    }
    func size(_ u: URL) -> Int64 { ((try? fm.attributesOfItem(atPath: u.path))?[.size] as? NSNumber)?.int64Value ?? 0 }

    static func digits(_ s: String) -> String { String(s.filter { $0.isNumber }.prefix(12)) }
    func libThumb(_ id: String, _ n: String) -> URL? {
        let u = libThumbs.appendingPathComponent("\(Self.digits(id))-\(Self.digits(n).isEmpty ? "1" : Self.digits(n)).png")
        return fm.fileExists(atPath: u.path) ? u : nil
    }
    func libMesh(_ id: String, _ n: String) -> URL? {
        let u = libMeshes.appendingPathComponent("\(Self.digits(id))-\(Self.digits(n).isEmpty ? "1" : Self.digits(n)).bin.gz")
        return fm.fileExists(atPath: u.path) ? u : nil
    }

    // ── Eigene Daten: eine JSON-Datei je Schlüssel, atomar, mit .bak ──
    static func safeKey(_ k: String) -> String { let s = k.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }; return s.isEmpty ? "data" : s }
    func load(_ key: String) -> String? { try? String(contentsOf: dataDir.appendingPathComponent(Self.safeKey(key) + ".json"), encoding: .utf8) }
    func save(_ key: String, _ text: String) throws {
        lock.lock(); defer { lock.unlock() }
        let k = Self.safeKey(key), f = dataDir.appendingPathComponent(k + ".json"), bak = dataDir.appendingPathComponent(k + ".json.bak")
        if fm.fileExists(atPath: f.path) { try? fm.removeItem(at: bak); try? fm.copyItem(at: f, to: bak) }
        try Data(text.utf8).write(to: f, options: .atomic)
    }
}

/// Dateien für die WebView unter amp://app/ — wie MainActivity.shouldInterceptRequest auf Android:
/// /www/… aus dem App-Paket, /file?t= (Kennung, z. B. G-Code für die Vorschau), /www/api.php?a=lib_thumb|lib_mesh (Bibliothek).
final class AppScheme: NSObject, WKURLSchemeHandler {
    let store: Store
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()
    private let q = DispatchQueue(label: "amp.scheme", qos: .userInitiated, attributes: .concurrent)
    private let root = Bundle.main.resourceURL!

    init(store: Store) { self.store = store }

    func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { task.didFailWithError(URLError(.badURL)); return }
        let comp = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let qv = { (k: String) in comp?.queryItems?.first(where: { $0.name == k })?.value ?? "" }
        let path = url.path
        var file: URL? = nil, mime = "application/octet-stream", cache = "no-cache"
        if path == "/file" { file = store.file(qv("t")); cache = "no-store" }
        else if path == "/www/api.php" && qv("a") == "lib_thumb" { file = store.libThumb(qv("id"), qv("n")); mime = "image/png"; cache = "max-age=31536000" }
        else if path == "/www/api.php" && qv("a") == "lib_mesh" { file = store.libMesh(qv("id"), qv("n")); cache = "max-age=31536000" }
        else {
            var p = path.hasPrefix("/") ? String(path.dropFirst()) : path
            if p.isEmpty || p.hasSuffix("/") { p += "index.html" }
            if !p.contains("..") { let u = root.appendingPathComponent(p); if FileManager.default.fileExists(atPath: u.path) { file = u; mime = Self.mime(p) } }
        }
        guard let f = file else { respond(task, status: 404, mime: "text/plain", cache: "no-store", length: 0); finish(task); return }
        let id = ObjectIdentifier(task)
        q.async {
            guard let h = try? FileHandle(forReadingFrom: f) else { self.respond(task, status: 404, mime: "text/plain", cache: "no-store", length: 0); self.finish(task); return }
            defer { try? h.close() }
            let len = self.store.size(f)
            if !self.respond(task, status: 200, mime: mime, cache: cache, length: len) { return }
            while true {
                let chunk = h.readData(ofLength: 1 << 20)
                if chunk.isEmpty { break }
                if !self.alive(id) { return }
                DispatchQueue.main.sync { if self.alive(id) { task.didReceive(chunk) } }
            }
            self.finish(task)
        }
    }

    func webView(_ w: WKWebView, stop task: WKURLSchemeTask) { lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock() }

    private func alive(_ id: ObjectIdentifier) -> Bool { lock.lock(); defer { lock.unlock() }; return !stopped.contains(id) }

    @discardableResult
    private func respond(_ task: WKURLSchemeTask, status: Int, mime: String, cache: String, length: Int64) -> Bool {
        let id = ObjectIdentifier(task)
        var ok = false
        let run = {
            guard self.alive(id), let url = task.request.url else { return }
            let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                    headerFields: ["Content-Type": mime, "Cache-Control": cache, "Content-Length": String(length), "Access-Control-Allow-Origin": "amp://app"])!
            task.didReceive(r); ok = true
        }
        if Thread.isMainThread { run() } else { DispatchQueue.main.sync(execute: run) }
        return ok
    }

    private func finish(_ task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        let run = {
            if self.alive(id) { task.didFinish() }
            self.lock.lock(); self.stopped.remove(id); self.lock.unlock()
        }
        if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
    }

    static func mime(_ p: String) -> String {
        switch (p as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain; charset=utf-8"
        default: return UTType(filenameExtension: (p as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
