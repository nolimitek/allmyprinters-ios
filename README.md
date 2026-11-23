# AllMyPrinters für iOS

iPhone-/iPad-App von [AllMyPrinters](https://allmyprinters.com): dieselbe Oberfläche wie die Android-App (`www/`) in einer
WKWebView, dazu ein kleiner Swift-Teil für das, was eine Webseite nicht darf (Drucker im Heimnetz per HTTP, Dateien, Speichern).

- `App/` – Swift: `Bridge.swift` (Schnittstelle `AMPNative.call` → `AMP_cb`/`AMP_ev`, wie Bridge.kt auf Android), `Store.swift`
  (Daten, Zwischenspeicher, Bibliothek, `amp://app/…`), `Net.swift` (HTTP, Digest, TCP), `Zip.swift` (3MF lesen)
- `www/` – gebaute Oberfläche (wird aus dem App-Projekt übernommen, hier nicht von Hand ändern)
- `project.yml` – XcodeGen; `.github/workflows/ios.yml` baut für den Simulator, startet die App, macht Bildschirmfotos und
  legt die Ergebnisse im Zweig `ci` ab

Stand: in Arbeit (Simulator). Noch nicht dabei: Live-Verbindungen (MQTT/WebSocket), Kamera, Bambu-FTPS, NFC, Push.
