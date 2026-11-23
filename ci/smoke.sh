#!/bin/sh
# App im iPhone-Simulator starten, je Ansicht ein Bildschirmfoto + Diagnose (diag-*.json, amp.log) → ci-out/
set -u
OUT=ci-out; mkdir -p "$OUT"
APP=build/Build/Products/Debug-iphonesimulator/AllMyPrinters.app
BID=com.allmyprinters.app
[ -d "$APP" ] || { echo "kein App-Paket unter $APP"; exit 1; }
U=$(python3 ci/pick_sim.py 2>"$OUT/simulator.txt") || { cat "$OUT/simulator.txt"; exit 1; }
cat "$OUT/simulator.txt"
xcrun simctl boot "$U" 2>/dev/null || true
xcrun simctl bootstatus "$U" -b >/dev/null
xcrun simctl ui "$U" appearance light 2>/dev/null || true
xcrun simctl install "$U" "$APP"
# Test-Kamera (MJPEG) auf 127.0.0.1:8765 — der Simulator teilt das Netz des Mac
ICN=$(ls /System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/*.icns 2>/dev/null | head -1)
if [ -n "$ICN" ] && sips -s format jpeg -Z 160 "$ICN" --out /tmp/amp-cam.jpg >/dev/null 2>&1; then
  python3 ci/mjpeg.py /tmp/amp-cam.jpg & echo "Test-Kamera läuft ($(wc -c < /tmp/amp-cam.jpg) Bytes je Bild)"
else echo "keine Test-Kamera (sips)"; fi
shot() {   # $1 Ansicht (leer = Start), $2 Dateiname
  xcrun simctl terminate "$U" "$BID" 2>/dev/null || true
  xcrun simctl launch "$U" "$BID" -ampHash "$1" -ampDiag 1 >/dev/null || echo "Start fehlgeschlagen: $1"
  sleep 20
  xcrun simctl io "$U" screenshot "$OUT/$2.png" >/dev/null 2>&1 || echo "kein Bild: $2"
}
shot "" 01-start
shot printers 02-drucker
shot spools 03-spulen
shot library 04-bibliothek
shot settings 05-einstellungen
xcrun simctl ui "$U" appearance dark 2>/dev/null || true
shot printers 06-drucker-dunkel
D=$(xcrun simctl get_app_container "$U" "$BID" data 2>/dev/null)
[ -n "$D" ] && cp "$D"/Documents/*.json "$D"/Documents/*.log "$OUT/" 2>/dev/null
xcrun simctl spawn "$U" log show --last 20m --style compact --predicate 'subsystem == "com.allmyprinters.app" OR process == "AllMyPrinters"' > "$OUT/system.log" 2>/dev/null || true
ls -la "$OUT"
