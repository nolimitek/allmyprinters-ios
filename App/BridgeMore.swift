import Foundation
import Darwin
import zlib

/// Weitere Brücken-Funktionen (Etappe 2): Rundruf (UDP), Uploads in Stücken (Elegoo), Bambu-Projektdatei (.gcode.3mf),
/// Werkzeugnummern im G-Code umschreiben. Gleiche Felder und Antworten wie Bridge.kt auf Android.
extension Bridge {

    /// UDP: Rundruf senden (Elegoo „M99999“ an 3000, Flashforge Multicast 225.0.0.9:19000 + :48899) und/oder lauschen (Bambu SSDP 2021).
    /// Auf dem echten iPhone braucht Senden an Rundruf-/Multicast-Adressen Apples Berechtigung com.apple.developer.networking.multicast.
    func udp(_ a: [String: Any]) throws -> [String: Any] {
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { throw BErr("SocketException", "socket") }
        defer { Darwin.close(fd) }
        var yes: Int32 = 1
        let ilen = socklen_t(MemoryLayout<Int32>.size)
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, ilen)
        setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &yes, ilen)
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, ilen)
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(clamping: i(a, "listen", 0)).bigEndian)
        addr.sin_addr.s_addr = INADDR_ANY
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        if bound != 0 { throw BErr("BindException", "bind \(errno)") }
        var tv = timeval(tv_sec: 0, tv_usec: 300_000)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var targets: [[String: Any]] = []
        if let one = a["send"] as? [String: Any] { targets.append(one) }
        if let more = a["sends"] as? [[String: Any]] { targets += more }
        for sd in targets {
            let data: Data = (sd["b64"] as? String).flatMap { Data(base64Encoded: $0, options: .ignoreUnknownCharacters) } ?? Data(s(sd, "data").utf8)
            var to = sockaddr_in()
            to.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            to.sin_family = sa_family_t(AF_INET)
            to.sin_port = in_port_t(UInt16(clamping: i(sd, "port", 0)).bigEndian)
            guard inet_pton(AF_INET, s(sd, "host", "255.255.255.255"), &to.sin_addr) == 1 else { continue }
            _ = data.withUnsafeBytes { p in withUnsafePointer(to: &to) { tp in tp.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                sendto(fd, p.baseAddress, data.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } }
        }
        var out: [[String: Any]] = []
        let end = Date().addingTimeInterval(Double(min(max(i(a, "ms", 3000), 200), 15000)) / 1000)
        var buf = [UInt8](repeating: 0, count: 16384)
        while Date() < end && out.count < 200 {
            var from = sockaddr_in()
            var flen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let cap = buf.count
            let n = buf.withUnsafeMutableBytes { bp in withUnsafeMutablePointer(to: &from) { fp in fp.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, bp.baseAddress, cap, 0, $0, &flen) } } }
            if n <= 0 { continue }   // Zeitüberschreitung (300 ms) → weiter bis zum Ende
            var host = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            inet_ntop(AF_INET, &from.sin_addr, &host, socklen_t(INET_ADDRSTRLEN))
            let d = Data(buf[0..<n])
            out.append(["from": String(cString: host), "data": String(decoding: d, as: UTF8.self), "b64": d.base64EncodedString()])
        }
        return ["packets": out]
    }

    /// Datei in Stücken als multipart hochladen (Elegoo SDCP: /uploadFile/upload mit Offset, Uuid, MD5); „{offset}“ in Feldern wird ersetzt
    func chunkUpload(_ id: String, _ a: [String: Any]) throws -> [String: Any] {
        let f = try file(a)
        let chunk = min(max(i(a, "chunk", 1 << 20), 4096), 8 << 20)
        let total = Int(store.size(f))
        let h = try FileHandle(forReadingFrom: f); defer { try? h.close() }
        var off = 0, lastTxt = ""
        let fields = a["fields"] as? [String: Any] ?? [:]
        let fname = s(a, "filename", store.name(s(a, "token")) ?? f.lastPathComponent)
        repeat {
            let n = min(chunk, total - off)
            try h.seek(toOffset: UInt64(off))
            let b = h.readData(ofLength: n)
            let boundary = "----amp" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            var body = Data()
            for (k, v) in fields { body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\("\(v)".replacingOccurrences(of: "{offset}", with: String(off)))\r\n".utf8)) }
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(s(a, "field", "File"))\"; filename=\"\(fname)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
            body.append(b); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            var rq = try Net.request(a, method: "POST", timeoutMs: 60000)
            rq.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            rq.httpBody = body
            let job = Net.Job(); job.max = 1 << 16
            try Net.shared.run(rq, job: job)
            let st = job.resp?.statusCode ?? 0
            lastTxt = String(decoding: job.data, as: UTF8.self)
            if st >= 400 || st == 0 { return ["status": st, "text": lastTxt] }
            off += n
            event("upload", ["id": id, "sent": off, "total": total])
        } while off < total
        return ["status": 200, "text": lastTxt]
    }

    /// Datei in Stücken per PUT mit Content-Range (Elegoo CC2 /upload). Nach einem Fehler nicht wiederholen (doppeltes Stück zerstört die Datei).
    func putChunks(_ id: String, _ a: [String: Any]) throws -> [String: Any] {
        let f = try file(a)
        let chunk = min(max(i(a, "chunk", 1 << 20), 4096), 1 << 20)
        let total = Int(store.size(f))
        let h = try FileHandle(forReadingFrom: f); defer { try? h.close() }
        var off = 0, last = ""
        while off < total {
            let n = min(chunk, total - off)
            try h.seek(toOffset: UInt64(off))
            let b = h.readData(ofLength: n)
            var rq = try Net.request(a, method: "PUT", timeoutMs: 60000)
            rq.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            rq.setValue("bytes \(off)-\(off + n - 1)/\(total)", forHTTPHeaderField: "Content-Range")
            rq.httpBody = b
            let job = Net.Job(); job.max = 1 << 16
            try Net.shared.run(rq, job: job)
            let st = job.resp?.statusCode ?? 0
            last = String(decoding: job.data, as: UTF8.self)
            if st >= 400 || st == 0 { return ["status": st, "text": last, "sent": off] }
            let ec = ((try? JSONSerialization.jsonObject(with: job.data)) as? [String: Any])?["error_code"] as? Int ?? -1
            if ec != 0 { return ["status": st, "ec": ec, "text": last, "sent": off] }
            off += n
            event("upload", ["id": id, "sent": off, "total": total])
        }
        return ["status": 200, "ec": 0, "text": last, "sent": off]
    }

    /// Fertigen G-Code als Bambu-/Flashforge-Projekt (.gcode.3mf) verpacken: Metadata/plate_1.gcode + MD5 + 3MF-Hülle;
    /// extra = weitere Dateien (z. B. Metadata/slice_info.config), Wert mit „b64:“ = Binärdaten (Vorschaubild)
    func make3mf(_ a: [String: Any]) throws -> [String: Any] {
        let src = try file(a)
        let name = s(a, "name", "print.gcode.3mf")
        let (token, out) = store.fresh(name)
        let md5hex = try md5(src).uppercased()
        let z = try ZipWriter(out)
        z.add("[Content_Types].xml", Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="gcode" ContentType="text/x.gcode"/></Types>
        """.utf8))
        z.add("_rels/.rels", Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>
        """.utf8))
        z.add("3D/3dmodel.model", Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">AllMyPrinters</metadata><resources/><build/></model>
        """.utf8))
        try z.addFile("Metadata/plate_1.gcode", src)
        z.add("Metadata/plate_1.gcode.md5", Data(md5hex.utf8))
        for (k, v) in (a["extra"] as? [String: Any]) ?? [:] {
            let sv = "\(v)"
            if sv.hasPrefix("b64:"), let d = Data(base64Encoded: String(sv.dropFirst(4)), options: .ignoreUnknownCharacters) { z.add(k, d) } else { z.add(k, Data(sv.utf8)) }
        }
        try z.finish()
        return ["token": token, "name": name, "size": store.size(out)]
    }

    /// G-Code: Werkzeugwechsel „T<n>“ am Zeilenanfang nach map {"n": m} umschreiben (Flashforge AD5X/Creator 5 mit .gcode)
    func remapTools(_ a: [String: Any]) throws -> [String: Any] {
        let src = try file(a)
        var map: [Int: Int] = [:]
        for (k, v) in (a["map"] as? [String: Any]) ?? [:] { if let kk = Int(k), let vv = (v as? NSNumber)?.intValue ?? Int("\(v)") { map[kk] = vv } }
        let name = store.name(s(a, "token")) ?? "print.gcode"
        let (token, out) = store.fresh(name)
        let rh = try FileHandle(forReadingFrom: src); defer { try? rh.close() }
        let wh = try FileHandle(forWritingTo: out); defer { try? wh.close() }
        var rest = Data(), changed = 0
        func line(_ l: Data) -> Data {
            guard l.first == UInt8(ascii: "T") else { return l }
            var j = l.startIndex + 1, num = 0, digits = 0
            while j < l.endIndex, l[j] >= 48, l[j] <= 57 { num = num * 10 + Int(l[j] - 48); j += 1; digits += 1 }
            guard digits > 0, j == l.endIndex || [32, 9, 59, 13].contains(l[j]), let to = map[num] else { return l }
            changed += 1
            return Data("T\(to)".utf8) + l[j...]
        }
        while true {
            let chunk = rh.readData(ofLength: 1 << 20)
            if chunk.isEmpty { break }
            rest.append(chunk)
            var outBuf = Data()
            var start = rest.startIndex
            while let nl = rest[start...].firstIndex(of: 10) { outBuf.append(line(rest[start..<nl])); outBuf.append(10); start = nl + 1 }
            rest = Data(rest[start...])
            wh.write(outBuf)
        }
        if !rest.isEmpty { wh.write(line(rest)); wh.write(Data([10])) }
        return ["token": token, "size": store.size(out), "changed": changed]
    }
}

/// ZIP schreiben (Verfahren „gespeichert“, ohne Kompression — liest jeder ZIP-Leser, auch die Drucker-Firmware)
final class ZipWriter {
    private let h: FileHandle
    private var central = Data()
    private var count = 0
    private var off: UInt32 = 0

    init(_ url: URL) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        h = try FileHandle(forWritingTo: url)
        try h.truncate(atOffset: 0)
    }

    private static func le16(_ v: Int) -> Data { Data([UInt8(v & 0xff), UInt8((v >> 8) & 0xff)]) }
    private static func le32(_ v: UInt32) -> Data { Data([UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]) }

    private func header(_ name: String, crc: UInt32, size: UInt32) {
        let n = Data(name.utf8)
        // Lokaler Kopf: Signatur, Version, Bit 11 (UTF-8), Verfahren 0, Zeit, Datum, CRC, Größen, Namenslänge, Extra-Länge, Name
        var l = Data()
        for part in [Self.le32(0x04034b50), Self.le16(20), Self.le16(0x800), Self.le16(0), Self.le16(0), Self.le16(0x21)] { l.append(part) }
        for part in [Self.le32(crc), Self.le32(size), Self.le32(size), Self.le16(n.count), Self.le16(0), n] { l.append(part) }
        // Eintrag im Inhaltsverzeichnis
        var c = Data()
        for part in [Self.le32(0x02014b50), Self.le16(20), Self.le16(20), Self.le16(0x800), Self.le16(0), Self.le16(0), Self.le16(0x21)] { c.append(part) }
        for part in [Self.le32(crc), Self.le32(size), Self.le32(size), Self.le16(n.count), Self.le16(0), Self.le16(0)] { c.append(part) }
        for part in [Self.le16(0), Self.le16(0), Self.le32(0), Self.le32(off), n] { c.append(part) }
        h.write(l); central.append(c); count += 1
        off += UInt32(l.count)
    }

    func add(_ name: String, _ d: Data) {
        let crc = d.withUnsafeBytes { p in UInt32(crc32(0, p.bindMemory(to: Bytef.self).baseAddress, uInt(d.count))) }
        header(name, crc: crc, size: UInt32(d.count))
        h.write(d); off += UInt32(d.count)
    }

    func addFile(_ name: String, _ src: URL) throws {
        let r = try FileHandle(forReadingFrom: src); defer { try? r.close() }
        var crc: uLong = crc32(0, nil, 0), size: UInt64 = 0
        while true {
            let c = r.readData(ofLength: 1 << 20); if c.isEmpty { break }
            crc = c.withUnsafeBytes { p in crc32(crc, p.bindMemory(to: Bytef.self).baseAddress, uInt(c.count)) }
            size += UInt64(c.count)
        }
        guard size < 0xffff_ff00 else { throw BErr("IOException", "too_big") }
        header(name, crc: UInt32(crc), size: UInt32(size))
        try r.seek(toOffset: 0)
        while true { let c = r.readData(ofLength: 1 << 20); if c.isEmpty { break }; h.write(c) }
        off += UInt32(size)
    }

    func finish() throws {
        let cdOff = off
        h.write(central)
        var e = Data()
        for part in [Self.le32(0x06054b50), Self.le16(0), Self.le16(0), Self.le16(count), Self.le16(count), Self.le32(UInt32(central.count)), Self.le32(cdOff), Self.le16(0)] { e.append(part) }
        h.write(e)
        try h.close()
    }
}
