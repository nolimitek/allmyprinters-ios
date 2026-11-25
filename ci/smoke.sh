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
# Drucker-Nachbauten + Test-Kamera (MJPEG) auf 127.0.0.1 — der Simulator teilt das Netz des Mac
ICN=$(ls /System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/*.icns 2>/dev/null | head -1)
sips -s format jpeg -Z 160 "$ICN" --out /tmp/amp-cam.jpg >/dev/null 2>&1 || echo "kein Testbild (sips)"
nohup node ci/mocks.js /tmp/amp-cam.jpg > "$OUT/mocks.log" 2>&1 &
for k in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 1 -o /dev/null http://127.0.0.1:8765/snap && break; sleep 1; done
echo "Test-Kamera: Bild $(wc -c < /tmp/amp-cam.jpg) B, /snap $(curl -s -m 3 http://127.0.0.1:8765/snap | wc -c) B, /stream $(curl -s -m 2 http://127.0.0.1:8765/stream | wc -c) B"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E "node|python" | awk '{print $1, $9}' | sort -u | head -20
shot() {   # $1 Ansicht (leer = Start, dort alle Prüfungen gegen die Nachbauten), $2 Dateiname
  xcrun simctl terminate "$U" "$BID" 2>/dev/null || true
  xcrun simctl launch "$U" "$BID" -ampHash "$1" -ampDiag 1 >/dev/null || echo "Start fehlgeschlagen: $1"
  if [ -z "$1" ]; then sleep 125; else sleep 20; fi
  xcrun simctl io "$U" screenshot "$OUT/$2.png" >/dev/null 2>&1 || echo "kein Bild: $2"
}
shot "" 01-start
shot printers 02-drucker
shot spools 03-spulen
shot library 04-bibliothek
shot models 04b-modelle
shot settings 05-einstellungen
xcrun simctl ui "$U" appearance dark 2>/dev/null || true
shot printers 06-drucker-dunkel
xcrun simctl ui "$U" appearance light 2>/dev/null || true
# Agent-Modus: Seite allmyprinters.com/web in der App (Service Worker, WebSocket-Ersatz)
xcrun simctl terminate "$U" "$BID" 2>/dev/null || true
xcrun simctl launch "$U" "$BID" -ampAgentURL "https://allmyprinters.com/web/" -ampDiag 1 >/dev/null || echo "Start Agent-Seite fehlgeschlagen"
sleep 30
xcrun simctl io "$U" screenshot "$OUT/07-agent.png" >/dev/null 2>&1 || echo "kein Bild: 07-agent"
# iPad (25.11.2026, App Store: die App ist auch fürs iPad freigeschaltet, Apple prüft dort ebenfalls) — Drucker, Modellsuche, Einstellungen quer und hoch
P=$(xcrun simctl list devices available -j | python3 -c "
import json,sys,re
d=json.load(sys.stdin); best=None
for rt,devs in d['devices'].items():
  if '.iOS-' not in rt: continue
  v=tuple(int(x) for x in rt.split('.iOS-')[-1].split('-') if x.isdigit())
  for x in devs:
    if x['name'].startswith('iPad'):
      k=(v,'13-inch' in x['name'] or '12.9' in x['name'],'Pro' in x['name'],x['name'])
      if best is None or k>best[0]: best=(k,x['udid'],x['name'])
print(best[1] if best else ''); sys.stderr.write((best[2] if best else 'kein iPad')+'\\n')" 2>>"$OUT/simulator.txt")
if [ -n "$P" ]; then
  tail -1 "$OUT/simulator.txt"
  xcrun simctl boot "$P" 2>/dev/null || true
  xcrun simctl bootstatus "$P" -b >/dev/null
  xcrun simctl install "$P" "$APP"
  for v in printers models settings; do
    xcrun simctl terminate "$P" "$BID" 2>/dev/null || true
    xcrun simctl launch "$P" "$BID" -ampHash "$v" >/dev/null || echo "iPad-Start fehlgeschlagen: $v"
    sleep 20
    xcrun simctl io "$P" screenshot "$OUT/08-ipad-$v.png" >/dev/null 2>&1 || echo "kein Bild: iPad $v"
  done
  xcrun simctl spawn "$P" log show --last 5m --style compact --predicate 'process == "AllMyPrinters"' 2>/dev/null | grep -i -E "terminat|crash|exception" | head -20 > "$OUT/ipad-fehler.txt" || true
  xcrun simctl shutdown "$P" 2>/dev/null || true
fi
D=$(xcrun simctl get_app_container "$U" "$BID" data 2>/dev/null)
[ -n "$D" ] && cp "$D"/Documents/*.json "$D"/Documents/*.log "$OUT/" 2>/dev/null
xcrun simctl spawn "$U" log show --last 20m --style compact --predicate 'subsystem == "com.allmyprinters.app" OR process == "AllMyPrinters"' > "$OUT/system.log" 2>/dev/null || true
ls -la "$OUT"
