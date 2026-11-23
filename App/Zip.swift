import Foundation
import Compression

/// Kleiner ZIP-Leser (3MF = ZIP): Inhaltsverzeichnis lesen, einzelne Einträge entpacken (gespeichert oder Deflate).
/// Compression.framework: COMPRESSION_ZLIB ist rohes Deflate (RFC 1951) — genau das Verfahren 8 in ZIP-Dateien.
struct ZipEntry { let name: String; let method: UInt16; let csize: Int; let usize: Int; let offset: Int }

enum Zip {
    static func entries(_ url: URL) throws -> [ZipEntry] {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        let size = Int(try h.seekToEnd())
        let tl = min(size, 65557)
        try h.seek(toOffset: UInt64(size - tl))
        let tail = h.readData(ofLength: tl)
        var eo = -1
        if tail.count >= 22 { for i in stride(from: tail.count - 22, through: 0, by: -1) where u32(tail, i) == 0x06054b50 { eo = i; break } }
        guard eo >= 0 else { throw BErr("ZipException", "zip_bad") }
        var n = Int(u16(tail, eo + 10)), cdSize = Int(u32(tail, eo + 12)), cdOff = Int(u32(tail, eo + 16))
        if (n == 0xffff || cdOff == 0xffffffff) && eo >= 20 && u32(tail, eo - 20) == 0x07064b50 {   // ZIP64
            let o = Int(u64(tail, eo - 12))
            try h.seek(toOffset: UInt64(o))
            let z = h.readData(ofLength: 56)
            if z.count >= 56 && u32(z, 0) == 0x06064b50 { n = Int(u64(z, 32)); cdSize = Int(u64(z, 40)); cdOff = Int(u64(z, 48)) }
        }
        guard cdOff >= 0, cdOff + cdSize <= size else { throw BErr("ZipException", "zip_bad") }
        try h.seek(toOffset: UInt64(cdOff))
        let cd = h.readData(ofLength: cdSize)
        var out: [ZipEntry] = [], p = 0
        for _ in 0..<n {
            guard p + 46 <= cd.count, u32(cd, p) == 0x02014b50 else { break }
            let meth = u16(cd, p + 10), nl = Int(u16(cd, p + 28)), xl = Int(u16(cd, p + 30)), cl = Int(u16(cd, p + 32))
            var cs = Int(u32(cd, p + 20)), us = Int(u32(cd, p + 24)), lo = Int(u32(cd, p + 42))
            let nameData = cd.subdata(in: (cd.startIndex + p + 46)..<(cd.startIndex + min(cd.count, p + 46 + nl)))
            var q = p + 46 + nl
            let xe = min(q + xl, cd.count)
            while q + 4 <= xe {   // ZIP64-Zusatzfeld
                let id = u16(cd, q), l = Int(u16(cd, q + 2))
                if id == 1 {
                    var r = q + 4
                    if us == 0xffffffff && r + 8 <= xe { us = Int(u64(cd, r)); r += 8 }
                    if cs == 0xffffffff && r + 8 <= xe { cs = Int(u64(cd, r)); r += 8 }
                    if lo == 0xffffffff && r + 8 <= xe { lo = Int(u64(cd, r)) }
                }
                q += 4 + l
            }
            let name = String(data: nameData, encoding: .utf8) ?? String(decoding: nameData, as: UTF8.self)
            out.append(ZipEntry(name: name.replacingOccurrences(of: "\\", with: "/"), method: meth, csize: cs, usize: us, offset: lo))
            p += 46 + nl + xl + cl
        }
        return out
    }

    /// Eintrag entpacken (für Bilder und Einstellungen — ganz im Speicher, höchstens 64 MB)
    static func read(_ url: URL, _ e: ZipEntry) throws -> Data {
        guard e.usize <= 64 << 20 else { throw BErr("ZipException", "too_big") }
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        try h.seek(toOffset: UInt64(e.offset))
        let lh = h.readData(ofLength: 30)
        guard lh.count == 30, u32(lh, 0) == 0x04034b50 else { throw BErr("ZipException", "zip_bad") }
        try h.seek(toOffset: UInt64(e.offset + 30 + Int(u16(lh, 26)) + Int(u16(lh, 28))))
        let comp = h.readData(ofLength: e.csize)
        if e.method == 0 { return comp }
        guard e.method == 8 else { throw BErr("ZipException", "zip_method") }
        if e.usize == 0 { return Data() }
        var out = Data(count: e.usize)
        let n = out.withUnsafeMutableBytes { dst in
            comp.withUnsafeBytes { src in
                compression_decode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, e.usize, src.bindMemory(to: UInt8.self).baseAddress!, comp.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard n == e.usize else { throw BErr("ZipException", "zip_inflate") }
        return out
    }

    static func u16(_ d: Data, _ i: Int) -> UInt16 { let b = d.startIndex + i; return UInt16(d[b]) | UInt16(d[b + 1]) << 8 }
    static func u32(_ d: Data, _ i: Int) -> UInt32 { let b = d.startIndex + i; return UInt32(d[b]) | UInt32(d[b + 1]) << 8 | UInt32(d[b + 2]) << 16 | UInt32(d[b + 3]) << 24 }
    static func u64(_ d: Data, _ i: Int) -> UInt64 { UInt64(u32(d, i)) | UInt64(u32(d, i + 4)) << 32 }
}
