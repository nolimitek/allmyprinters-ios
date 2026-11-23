import Foundation
import os

/// Protokoll: os_log (Konsole/Simulator) + Datei Documents/amp.log (für den Simulator-Lauf in GitHub Actions).
enum Log {
    private static let logger = Logger(subsystem: "com.allmyprinters.app", category: "amp")
    private static let lock = NSLock()
    static let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

    static func write(_ s: String) {
        logger.notice("\(s, privacy: .public)")
        let line = ISO8601DateFormatter().string(from: Date()) + " " + s + "\n"
        lock.lock(); defer { lock.unlock() }
        let f = docs.appendingPathComponent("amp.log")
        if let h = try? FileHandle(forWritingTo: f) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
        else { try? Data(line.utf8).write(to: f) }
    }
}
