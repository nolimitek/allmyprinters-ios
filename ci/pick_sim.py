# Neuestes verfügbares iPhone im Simulator → UDID (stdout), Name/Laufzeit (stderr)
import json, subprocess, sys
d = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))
best = None
for rt, devs in d['devices'].items():
    if '.iOS-' not in rt:
        continue
    ver = tuple(int(p) for p in rt.split('.iOS-')[-1].split('-') if p.isdigit())
    for x in devs:
        if x['name'].startswith('iPhone') and x.get('isAvailable', True):
            key = (ver, 'Pro' not in x['name'] and 'Plus' not in x['name'], x['name'])
            if best is None or key > best[0]:
                best = (key, x['udid'], x['name'], rt)
if not best:
    sys.exit('kein iPhone-Simulator')
print(best[1])
print(best[2], best[3], file=sys.stderr)
