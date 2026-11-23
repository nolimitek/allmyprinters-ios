# AllMyPrinters für iOS

iPhone-/iPad-App von [AllMyPrinters](https://allmyprinters.com): dieselbe Oberfläche wie die Android-App (`www/`) in einer
WKWebView, dazu ein kleiner Swift-Teil für das, was eine Webseite nicht darf (Drucker im Heimnetz per HTTP, Dateien, Speichern).

- `App/` – Swift: `Bridge.swift` (Schnittstelle `AMPNative.call` → `AMP_cb`/`AMP_ev`, wie Bridge.kt auf Android), `Store.swift`
  (Daten, Zwischenspeicher, Bibliothek, `amp://app/…`), `Net.swift` (HTTP, Digest, TCP), `Zip.swift` (3MF lesen)
- `www/` – gebaute Oberfläche (wird aus dem App-Projekt übernommen, hier nicht von Hand ändern)
- `project.yml` – XcodeGen; `.github/workflows/ios.yml` baut für den Simulator, startet die App, macht Bildschirmfotos und
  legt die Ergebnisse im Zweig `ci` ab; dazu ein Release-Bau fürs Gerät ohne Signatur
- `.github/workflows/testflight.yml` + `ci/asc.py` – TestFlight ohne Mac: `git push origin main:testflight`. Signatur über einen
  App-Store-Connect-API-Schlüssel (Secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, Rolle Admin): Bundle-ID,
  Verteilungszertifikat (im Actions-Cache weiterverwendet) und Profil entstehen über die API; Ergebnis im Zweig `ci-tf`
- `Support/` – App-Symbol (`AppIcon.svg` → 1024er PNG, aus dem Android-Symbol), Datenschutz-Manifest

Stand: in Arbeit (Simulator). Noch nicht dabei: Live-Verbindungen (MQTT/WebSocket), Kamera, Bambu-FTPS, NFC, Push.
