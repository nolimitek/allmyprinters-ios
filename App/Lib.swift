import UIKit
import UniformTypeIdentifiers

/// Bibliothek außerhalb des App-Speichers (24.11.2026, wie Bridge.kt auf Android):
///  • eigener Ordner aus der Dateien-App (iCloud Drive, „Auf meinem iPhone“, Nextcloud, NAS-Freigabe …) — lib_dir_pick/lib_dir_ok/
///    lib_dir_list, lib_put/lib_get/lib_del mit loc bzw. doc. Der Ordner bleibt über ein Lesezeichen mit Sicherheitsbereich erreichbar
///    (UserDefaults „libdirs“); die Oberfläche kennt ihn nur als amp-dir://<kennung>, eine Datei darin als
///    amp-dir://<kennung>/document/<Name, %-kodiert> — backend.js libKeyOf nimmt den Teil nach /document/ (gleich bei lib_put und Liste).
///  • NAS über WebDAV — dav (PUT/GET/DELETE/HEAD, Basic, bei Digest-Aufforderung noch einmal) und dav_list (PROPFIND Depth 1).
enum LibDir {
    static let prefix = "amp-dir://"
    private static let ud = UserDefaults.standard
    static func bookmarks() -> [String: Data] { ud.dictionary(forKey: "libdirs") as? [String: Data] ?? [:] }
    static func save(_ id: String, _ d: Data) { var b = bookmarks(); b[id] = d; ud.set(b, forKey: "libdirs") }
    static func idOf(_ uri: String) -> String? {
        guard uri.hasPrefix(prefix) else { return nil }
        let id = uri.dropFirst(prefix.count).split(separator: "/").first.map(String.init) ?? ""
        return id.isEmpty ? nil : id
    }
    /// Ordner auflösen und für die Dauer von fn freigeben (Sicherheitsbereich)
    static func with<T>(_ uri: String, _ fn: (URL) throws -> T) throws -> T {
        guard let id = idOf(uri), let bm = bookmarks()[id] else { throw BErr("IllegalStateException", "no_access") }
        var stale = false
        let u = try URL(resolvingBookmarkData: bm, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        let ok = u.startAccessingSecurityScopedResource()
        defer { if ok { u.stopAccessingSecurityScopedResource() } }
        if stale, let nd = try? u.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) { save(id, nd) }
        return try fn(u)
    }
    private static let nameChars = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~ ()"))
    static func doc(_ uri: String, _ name: String) -> String {
        prefix + (idOf(uri) ?? "") + "/document/" + (name.addingPercentEncoding(withAllowedCharacters: nameChars) ?? name)
    }
    /// Datei-Kennung → (Ordner, Dateiname)
    static func parse(_ doc: String) -> (String, String)? {
        guard let id = idOf(doc), let r = doc.range(of: "/document/") else { return nil }
        let name = String(doc[r.upperBound...]).removingPercentEncoding ?? ""
        guard !name.isEmpty, !name.contains("/"), name != ".", name != ".." else { return nil }
        return (prefix + id, name)
    }
    /// iCloud-Platzhalter „.Name.stl.icloud“ → „Name.stl“
    static func realName(_ n: String) -> String? {
        guard n.hasPrefix("."), n.hasSuffix(".icloud"), n.count > 8 else { return nil }
        return String(n.dropFirst().dropLast(7))
    }

    static func coordRead(_ u: URL, _ fn: (URL) throws -> Void) throws {
        var ce: NSError?, fe: Error?
        NSFileCoordinator().coordinate(readingItemAt: u, options: [], error: &ce) { r in do { try fn(r) } catch { fe = error } }
        if let e = ce ?? fe { throw e }
    }
    static func coordWrite(_ u: URL, _ opt: NSFileCoordinator.WritingOptions, _ fn: (URL) throws -> Void) throws {
        var ce: NSError?, fe: Error?
        NSFileCoordinator().coordinate(writingItemAt: u, options: opt, error: &ce) { w in do { try fn(w) } catch { fe = error } }
        if let e = ce ?? fe { throw e }
    }
    static func gone(_ e: Error) -> Bool {
        let n = e as NSError
        return n.domain == NSCocoaErrorDomain && [NSFileReadNoSuchFileError, NSFileNoSuchFileError].contains(n.code)
    }
}

/// Ordner wählen (Dateien-App) → Lesezeichen merken, Antwort {uri, name} wie Android (Abbrechen = null)
final class FolderPicker: NSObject, UIDocumentPickerDelegate {
    static let shared = FolderPicker()
    private var pending: [ObjectIdentifier: (Bridge, String)] = [:]

    func pick(_ b: Bridge, _ id: String) {
        let p = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        p.delegate = self
        p.allowsMultipleSelection = false
        let key = ObjectIdentifier(p)
        pending[key] = (b, id)
        guard let vc = b.vc else { pending.removeValue(forKey: key); b.reply(id, false, ["error": "no_picker"]); return }
        vc.presentSafe(p) { [weak self] in self?.pending.removeValue(forKey: key); b.reply(id, false, ["error": "no_picker"]) }
    }

    func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let pe = pending.removeValue(forKey: ObjectIdentifier(c)) else { return }
        let (b, id) = pe
        guard let u = urls.first else { b.reply(id, true, nil); return }
        let ok = u.startAccessingSecurityScopedResource()
        defer { if ok { u.stopAccessingSecurityScopedResource() } }
        do {
            let bm = try u.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            let fid = UUID().uuidString.lowercased()
            LibDir.save(fid, bm)
            b.reply(id, true, ["uri": LibDir.prefix + fid, "name": u.lastPathComponent])
        } catch { b.reply(id, false, ["error": errName(error), "msg": String(String(describing: error).prefix(200))]) }
    }

    func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) {
        guard let pe = pending.removeValue(forKey: ObjectIdentifier(c)) else { return }
        pe.0.reply(pe.1, true, nil)
    }
}

extension Bridge {
    // ── Eigener Ordner ──
    func libDirOk(_ a: [String: Any]) -> [String: Any] {
        let ok = (try? LibDir.with(s(a, "uri")) { u -> Bool in
            var dir: ObjCBool = false
            return store.fm.fileExists(atPath: u.path, isDirectory: &dir) && dir.boolValue && store.fm.isWritableFile(atPath: u.path)
        }) ?? false
        return ["ok": ok]
    }

    /// Dateien im Ordner (keine Unterordner, keine versteckten) — Kennung, Name, Größe, Änderungszeit (ms) wie Android
    func libDirList(_ a: [String: Any]) throws -> [String: Any] {
        let loc = try req(a, "loc")
        return try LibDir.with(loc) { dir in
            var out: [[String: Any]] = []
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
            try LibDir.coordRead(dir) { d in
                for f in try store.fm.contentsOfDirectory(at: d, includingPropertiesForKeys: keys, options: []) where out.count < 5000 {
                    let v = try? f.resourceValues(forKeys: Set(keys))
                    if v?.isDirectory == true { continue }
                    var name = f.lastPathComponent, size = v?.fileSize ?? 0
                    if let real = LibDir.realName(name) {   // iCloud: noch nicht geladen → laden anstoßen, Größe aus den Metadaten
                        name = real
                        let ru = d.appendingPathComponent(real)
                        try? store.fm.startDownloadingUbiquitousItem(at: ru)
                        size = (try? ru.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                    } else if name.hasPrefix(".") { continue }
                    let mt = (v?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
                    out.append(["doc": LibDir.doc(loc, name), "id": name, "name": name, "size": size, "mtime": Int64(mt)])
                }
            }
            return ["files": out]
        }
    }

    /// Datei unter ihrem Namen in den Ordner legen (gibt es ihn schon, „ (1)“ anhängen wie Android)
    func libPutDir(_ src: URL, _ loc: String, _ a: [String: Any]) throws -> [String: Any] {
        let clean = s(a, "name", "model").replacingOccurrences(of: "[\\\\/:*?\"<>|]", with: "_", options: .regularExpression)
        let name = String(clean.prefix(150))
        return try LibDir.with(loc) { dir in
            let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
            var final = name, n = 1
            let taken = { (x: String) in self.store.fm.fileExists(atPath: dir.appendingPathComponent(x).path) || self.store.fm.fileExists(atPath: dir.appendingPathComponent("." + x + ".icloud").path) }
            while taken(final) && n < 1000 { final = ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)"; n += 1 }
            let dst = dir.appendingPathComponent(final)
            try LibDir.coordWrite(dst, .forReplacing) { w in try self.store.fm.copyItem(at: src, to: w) }
            return ["ok": true, "size": store.size(src), "doc": LibDir.doc(loc, final)]
        }
    }

    /// Datei aus dem Ordner als Kopie im Zwischenspeicher (iCloud lädt sie dabei herunter)
    func libGetDir(_ doc: String, _ a: [String: Any]) throws -> [String: Any] {
        guard let pr = LibDir.parse(doc) else { throw BErr("IllegalStateException", "file_gone") }
        let (dirUri, name) = pr
        let (token, out) = store.fresh(s(a, "name", "model"), prefix: "lib")
        try? store.fm.removeItem(at: out)
        do {
            try LibDir.with(dirUri) { dir in try LibDir.coordRead(dir.appendingPathComponent(name)) { r in try self.store.fm.copyItem(at: r, to: out) } }
        } catch {
            store.drop(token)
            if LibDir.gone(error) { throw BErr("IllegalStateException", "file_gone") }
            throw error
        }
        return ["token": token, "size": store.size(out), "name": s(a, "name", "model")]
    }

    func libDelDir(_ doc: String) {
        guard let pr = LibDir.parse(doc) else { return }
        let (dirUri, name) = pr
        try? LibDir.with(dirUri) { dir in try LibDir.coordWrite(dir.appendingPathComponent(name), .forDeleting) { w in try self.store.fm.removeItem(at: w) } }
    }

    /// Nur Simulator-Lauf (-ampDiag 1): Ordner im App-Speicher als „eigener Ordner“ (ohne Dateiwähler) → uri
    func libDirTest() throws -> [String: Any] {
        guard UserDefaults.standard.bool(forKey: "ampDiag") else { throw BErr("IllegalArgumentException", "unknown method lib_dir_test") }
        let d = Log.docs.appendingPathComponent("diag-ordner", isDirectory: true)
        try? store.fm.removeItem(at: d)
        try store.fm.createDirectory(at: d, withIntermediateDirectories: true)
        let fid = "diag-" + UUID().uuidString.lowercased().prefix(8)
        LibDir.save(String(fid), try d.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil))
        return ["uri": LibDir.prefix + fid, "name": d.lastPathComponent]
    }

    // ── WebDAV ──
    private static let propfindBody = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"

    /// Digest-Aufforderung aus WWW-Authenticate (URLSession fasst mehrere Kopfzeilen mit Komma zusammen: „Basic …, Digest …“)
    private func digestOf(_ h: Any?) -> String? {
        guard let s = h as? String, let r = s.range(of: "Digest ", options: .caseInsensitive) else { return nil }
        return String(s[r.lowerBound...])
    }
    private func basic(_ a: [String: Any]) -> String? {
        let user = s(a, "user")
        return user.isEmpty ? nil : "Basic " + Data("\(user):\(s(a, "pass"))".utf8).base64EncodedString()
    }

    func dav(_ a: [String: Any]) throws -> [String: Any] {
        guard let url = URL(string: try req(a, "url")), url.scheme != nil else { throw BErr("IllegalArgumentException", "bad_url") }
        let method = s(a, "method", "GET"), user = s(a, "user"), pass = s(a, "pass")
        // schon als Digest bekannt + große Datei: erst die Aufforderung holen, damit die Datei nicht zweimal geht
        if s(a, "scheme") == "digest" && method == "PUT" {
            let h = try davOnce(a, url, basic(a), head: true)
            if let ch = digestOf(h["auth"]) { return try davOnce(a, url, Net.digest(ch, method: "PUT", url: url, user: user, pass: pass)) }
        }
        var r = try davOnce(a, url, basic(a))
        if r["status"] as? Int == 401, let ch = digestOf(r["auth"]) {
            r = try davOnce(a, url, Net.digest(ch, method: method, url: url, user: user, pass: pass))
            r["scheme"] = "digest"
        }
        return r
    }

    private func davOnce(_ a: [String: Any], _ url: URL, _ auth: String?, head: Bool = false) throws -> [String: Any] {
        let m = head ? "HEAD" : s(a, "method", "GET")
        var rq = URLRequest(url: url)
        rq.httpMethod = m
        rq.timeoutInterval = Double(max(5000, i(a, "timeout", 120000))) / 1000   // Leerlauf, nicht Gesamtzeit (wie readTimeout)
        if let auth { rq.setValue(auth, forHTTPHeaderField: "Authorization") }
        let job = Net.Job()
        job.max = 4096
        job.noRedirect = true
        var upload: URL? = nil, textTok: String? = nil, getTok: String? = nil
        if m == "PUT" {
            rq.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            if let t = a["token"] as? String, !t.isEmpty {
                guard let f = store.file(t) else { throw BErr("IllegalStateException", "file_gone") }
                upload = f
            } else {
                let (tt, f) = store.fresh("dav.txt", prefix: "davt")
                try Data(s(a, "text").utf8).write(to: f)
                upload = f; textTok = tt
            }
        }
        defer { if let t = textTok { store.drop(t) } }
        if m == "GET" {
            let (t, f) = store.fresh(s(a, "name", "model"), prefix: "dav")
            getTok = t
            job.out = try FileHandle(forWritingTo: f)
        }
        do { try Net.shared.run(rq, uploadFile: upload, job: job) }
        catch { try? job.out?.close(); if let t = getTok { store.drop(t) }; throw error }
        try? job.out?.close()
        let st = job.resp?.statusCode ?? 0
        var r: [String: Any] = ["status": st, "auth": job.resp?.value(forHTTPHeaderField: "WWW-Authenticate") ?? ""]
        if let t = getTok {
            if (200..<300).contains(st), let f = store.file(t) { r["token"] = t; r["size"] = store.size(f) } else { store.drop(t) }
        }
        return r
    }

    /// PROPFIND Depth 1 → {status, auth, text} (207 multistatus; backend.js davParse liest die Liste)
    func davList(_ a: [String: Any]) throws -> [String: Any] {
        var us = try req(a, "url"); if !us.hasSuffix("/") { us += "/" }
        guard let url = URL(string: us), url.scheme != nil else { throw BErr("IllegalArgumentException", "bad_url") }
        var r = try propfind(url, basic(a))
        if r["status"] as? Int == 401, let ch = digestOf(r["auth"]) {
            r = try propfind(url, Net.digest(ch, method: "PROPFIND", url: url, user: s(a, "user"), pass: s(a, "pass")))
            r["scheme"] = "digest"
        }
        return r
    }

    private func propfind(_ url: URL, _ auth: String?) throws -> [String: Any] {
        var rq = URLRequest(url: url)
        rq.httpMethod = "PROPFIND"
        rq.timeoutInterval = 20
        rq.setValue("1", forHTTPHeaderField: "Depth")
        rq.setValue("application/xml; charset=utf-8", forHTTPHeaderField: "Content-Type")
        if let auth { rq.setValue(auth, forHTTPHeaderField: "Authorization") }
        rq.httpBody = Data(Self.propfindBody.utf8)
        let job = Net.Job()
        job.max = 8 << 20
        job.noRedirect = true
        try Net.shared.run(rq, job: job)
        return ["status": job.resp?.statusCode ?? 0, "auth": job.resp?.value(forHTTPHeaderField: "WWW-Authenticate") ?? "",
                "text": String(decoding: job.data, as: UTF8.self)]
    }
}
