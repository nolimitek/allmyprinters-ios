# Neuestes verfügbares iPhone im Simulator → UDID (stdout), Name/Laufzeit (stderr).
# Bevorzugt ein Modell MIT Dynamic Island (iPhone 15 und neuer, nicht „e“/SE) — sonst sieht man randlos oben nicht (24.11.2026:
# vorher gewann „iPhone SE (3rd generation)“, weil der Name als Text größer als „iPhone 17“ ist).
import json, re, subprocess, sys
d = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))
best = None
for rt, devs in d['devices'].items():
    if '.iOS-' not in rt:
        continue
    ver = tuple(int(p) for p in rt.split('.iOS-')[-1].split('-') if p.isdigit())
    for x in devs:
        if x['name'].startswith('iPhone') and x.get('isAvailable', True):
            m = re.match(r'iPhone (\d+)(e)?\b', x['name'])
            num = int(m.group(1)) if m else 0
            island = bool(m) and num >= 15 and not m.group(2)
            key = (ver, island, num, 'Pro' not in x['name'] and 'Plus' not in x['name'], x['name'])
            if best is None or key > best[0]:
                best = (key, x['udid'], x['name'], rt)
if not best:
    sys.exit('kein iPhone-Simulator')
print(best[1])
print(best[2], best[3], file=sys.stderr)
