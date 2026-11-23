#!/usr/bin/env python3
"""App Store Connect für den TestFlight-Lauf — ohne Mac und ohne Zusatzpakete (nur Python + openssl).

  python3 ci/asc.py prepare <ausgabe-ordner>

Braucht ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (die .p8-Datei), SIGN_STATE (Ordner, der zwischen Läufen im
Actions-Cache liegt) und SIGN_PASS (Passwort für die .p12 darin). Ablauf:
  1. Bundle-ID registrieren, falls nötig (Team-ID = seedId)
  2. prüfen, ob die App in App Store Connect angelegt ist (die API kann keine Apps anlegen)
  3. Verteilungszertifikat: aus dem Cache weiterverwenden, solange es gültig ist, sonst neu (Schlüssel entsteht hier)
  4. Bereitstellungsprofil „AMP CI AppStore“ neu erzeugen
  5. dist.p12, profile.mobileprovision, ExportOptions.plist und sign.env in den Ausgabe-Ordner
"""
import base64, datetime, json, os, plistlib, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request

API = 'https://api.appstoreconnect.apple.com/v1'
BUNDLE = os.environ.get('BUNDLE_ID', 'com.allmyprinters.app')
PROFILE = 'AMP CI AppStore'
# Notification Service Extension (Druck-Meldungen entschlüsseln, 23.11.2026): eigene Bundle-ID + eigenes Profil
NSE, NSE_PROFILE = BUNDLE + '.notify', 'AMP CI Notify'
OPENSSL = '/usr/bin/openssl' if os.path.exists('/usr/bin/openssl') else 'openssl'  # macOS: LibreSSL → .p12, die der Schlüsselbund lesen kann


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def der_to_raw(sig):
    """ECDSA-Signatur aus openssl (DER, SEQUENCE{r,s}) → JWT-Form r‖s mit je 32 Byte"""
    assert sig[0] == 0x30
    i = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7f)
    out = b''
    for _ in range(2):
        assert sig[i] == 0x02
        n = sig[i + 1]
        v = sig[i + 2:i + 2 + n].lstrip(b'\x00')
        out += v.rjust(32, b'\x00')
        i += 2 + n
    return out


def token():
    kid, iss, path = os.environ['ASC_KEY_ID'], os.environ['ASC_ISSUER_ID'], os.environ['ASC_KEY_PATH']
    now = int(time.time())
    msg = b64u(json.dumps({'alg': 'ES256', 'kid': kid, 'typ': 'JWT'}).encode()) + '.' + \
        b64u(json.dumps({'iss': iss, 'iat': now, 'exp': now + 1100, 'aud': 'appstoreconnect-v1'}).encode())
    sig = subprocess.run([OPENSSL, 'dgst', '-sha256', '-sign', path], input=msg.encode(), capture_output=True, check=True).stdout
    return msg + '.' + b64u(der_to_raw(sig))


_tok = None


def call(method, path, body=None, ok=(200, 201, 204)):
    global _tok
    _tok = _tok or token()
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + _tok, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            j = json.loads(raw)
        except Exception:
            j = {'raw': raw.decode(errors='replace')[:500]}
        if e.code in ok:
            return e.code, j
        return e.code, j


def errtext(j):
    return '; '.join(f"{x.get('code')}: {x.get('detail') or x.get('title')}" for x in j.get('errors', [])) or json.dumps(j)[:400]


def die(msg, code=1):
    print('FEHLER: ' + msg, flush=True)
    sys.exit(code)


def bundle_id(ident=BUNDLE, name='AllMyPrinters'):
    st, j = call('GET', f'/bundleIds?filter[identifier]={ident}&limit=200')
    if st == 401:
        die('Schlüssel abgelehnt (401) — ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 prüfen. ' + errtext(j))
    if st != 200:
        die(f'bundleIds {st}: ' + errtext(j))
    for b in j.get('data', []):
        if b['attributes'].get('identifier') == ident:
            print(f'Bundle-ID vorhanden: {ident}')
            return b['id'], b['attributes'].get('seedId')
    st, j = call('POST', '/bundleIds', {'data': {'type': 'bundleIds', 'attributes': {'identifier': ident, 'name': name, 'platform': 'IOS'}}})
    if st != 201:
        die(f'Bundle-ID anlegen {st}: ' + errtext(j))
    print(f'Bundle-ID registriert: {ident}')
    return j['data']['id'], j['data']['attributes'].get('seedId')


def push_capability(bid):
    """Push Notifications an der App-ID einschalten (sonst fehlt aps-environment im Profil)"""
    st, j = call('GET', f'/bundleIds/{bid}/bundleIdCapabilities')
    if st == 200 and any(c['attributes'].get('capabilityType') == 'PUSH_NOTIFICATIONS' for c in j.get('data', [])):
        print('Push-Berechtigung: an')
        return
    st, j = call('POST', '/bundleIdCapabilities', {'data': {'type': 'bundleIdCapabilities', 'attributes': {'capabilityType': 'PUSH_NOTIFICATIONS'},
                                                           'relationships': {'bundleId': {'data': {'type': 'bundleIds', 'id': bid}}}}})
    if st not in (200, 201):
        die(f'Push-Berechtigung einschalten {st}: ' + errtext(j))
    print('Push-Berechtigung eingeschaltet')


def app_record():
    st, j = call('GET', f'/apps?filter[bundleId]={BUNDLE}')
    if st != 200:
        die(f'apps {st}: ' + errtext(j))
    for a in j.get('data', []):
        if a['attributes'].get('bundleId') == BUNDLE:
            print(f"App in App Store Connect: {a['attributes'].get('name')} (id {a['id']})")
            return a['id']
    return None


def certificate(state, pw, work):
    """→ (Zertifikat-ID, Pfad zur .p12). Cache: state/dist.p12 + state/cert.json"""
    cj, p12 = os.path.join(state, 'cert.json'), os.path.join(state, 'dist.p12')
    if os.path.exists(cj) and os.path.exists(p12):
        cid = json.load(open(cj)).get('id')
        st, j = call('GET', f'/certificates/{cid}')
        if st == 200:
            exp = j['data']['attributes'].get('expirationDate') or ''
            try:
                left = datetime.datetime.fromisoformat(exp.replace('Z', '+00:00')) - datetime.datetime.now(datetime.timezone.utc)
            except ValueError:
                left = datetime.timedelta(days=0)
            if left > datetime.timedelta(days=3):
                print(f'Zertifikat aus dem Cache weiterverwendet (noch {left.days} Tage)')
                return cid, p12
        print(f'Zertifikat im Cache nicht mehr gültig ({st}) → neu')
    key, csr = os.path.join(work, 'key.pem'), os.path.join(work, 'req.csr')
    subprocess.run([OPENSSL, 'genrsa', '-out', key, '2048'], check=True, capture_output=True)
    subprocess.run([OPENSSL, 'req', '-new', '-key', key, '-out', csr, '-subj', '/CN=AllMyPrinters CI/C=AT'], check=True, capture_output=True)
    body = {'data': {'type': 'certificates', 'attributes': {'certificateType': 'DISTRIBUTION', 'csrContent': open(csr).read()}}}
    st, j = call('POST', '/certificates', body)
    if st == 409:
        # Obergrenze erreicht: ohne Mac stammen alle Verteilungszertifikate aus diesem Ablauf → das älteste zurückziehen
        print('Zertifikats-Obergrenze: ' + errtext(j))
        s2, l = call('GET', '/certificates?filter[certificateType]=DISTRIBUTION&limit=200')
        old = sorted(l.get('data', []), key=lambda c: c['attributes'].get('expirationDate') or '')
        if s2 != 200 or not old:
            die('Zertifikat anlegen 409 und keine Liste: ' + errtext(l))
        c = old[0]
        print(f"ziehe ältestes Verteilungszertifikat zurück: {c['attributes'].get('name')} bis {c['attributes'].get('expirationDate')}")
        call('DELETE', f"/certificates/{c['id']}")
        st, j = call('POST', '/certificates', body)
    if st != 201:
        die(f'Zertifikat anlegen {st}: ' + errtext(j))
    cid = j['data']['id']
    der = base64.b64decode(j['data']['attributes']['certificateContent'])
    cer = os.path.join(work, 'dist.cer')
    open(cer, 'wb').write(der)
    pem = os.path.join(work, 'dist.pem')
    subprocess.run([OPENSSL, 'x509', '-inform', 'DER', '-in', cer, '-out', pem], check=True, capture_output=True)
    os.makedirs(state, exist_ok=True)
    subprocess.run([OPENSSL, 'pkcs12', '-export', '-inkey', key, '-in', pem, '-out', p12, '-name', 'AllMyPrinters Distribution',
                    '-passout', 'env:SIGN_PASS'], check=True, capture_output=True, env={**os.environ, 'SIGN_PASS': pw})
    json.dump({'id': cid, 'created': j['data']['attributes'].get('expirationDate')}, open(cj, 'w'))
    print(f"Zertifikat neu: {j['data']['attributes'].get('name')} bis {j['data']['attributes'].get('expirationDate')}")
    return cid, p12


def profile(bid, cid, out, name=PROFILE, fname='profile.mobileprovision'):
    st, j = call('GET', '/profiles?limit=200')
    for p in (j.get('data', []) if st == 200 else []):
        if p['attributes'].get('name') == name:
            call('DELETE', f"/profiles/{p['id']}")
    body = {'data': {'type': 'profiles', 'attributes': {'name': name, 'profileType': 'IOS_APP_STORE'},
                     'relationships': {'bundleId': {'data': {'type': 'bundleIds', 'id': bid}},
                                       'certificates': {'data': [{'type': 'certificates', 'id': cid}]}}}}
    st, j = call('POST', '/profiles', body)
    if st != 201:
        die(f'Profil anlegen {st}: ' + errtext(j))
    a = j['data']['attributes']
    open(os.path.join(out, fname), 'wb').write(base64.b64decode(a['profileContent']))
    print(f"Profil: {a['name']} {a.get('uuid')} bis {a.get('expirationDate')}")
    return a['uuid']


def prepare(out):
    os.makedirs(out, exist_ok=True)
    state, pw = os.environ['SIGN_STATE'], os.environ['SIGN_PASS']
    bid, team = bundle_id()
    if not team:
        die('keine Team-ID (seedId) an der Bundle-ID')
    print(f'Team-ID: {team}')
    push_capability(bid)
    nid, _ = bundle_id(NSE, 'AllMyPrinters Notify')
    app = app_record()
    if not app:
        die(f'Die App ist in App Store Connect noch nicht angelegt: „Meine Apps“ → + → Neue App, Bundle-ID {BUNDLE}', 3)
    work = tempfile.mkdtemp()
    cid, p12 = certificate(state, pw, work)
    shutil.copy(p12, os.path.join(out, 'dist.p12'))
    uuid = profile(bid, cid, out)
    uuid_nse = profile(nid, cid, out, NSE_PROFILE, 'profile-nse.mobileprovision')
    plistlib.dump({'method': 'app-store-connect', 'destination': 'export', 'teamID': team, 'signingStyle': 'manual',
                   'signingCertificate': 'Apple Distribution', 'provisioningProfiles': {BUNDLE: PROFILE, NSE: NSE_PROFILE},
                   'uploadSymbols': True, 'manageAppVersionAndBuildNumber': False},
                  open(os.path.join(out, 'ExportOptions.plist'), 'wb'))
    with open(os.path.join(out, 'sign.env'), 'w') as f:
        f.write(f'TEAM_ID={team}\nPROFILE_UUID={uuid}\nPROFILE_NAME="{PROFILE}"\nPROFILE_UUID_NSE={uuid_nse}\nPROFILE_NAME_NSE="{NSE_PROFILE}"\nAPP_ID={app}\n')
    shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'prepare':
        prepare(sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == 'selftest':
        # JWT-Signatur gegen openssl prüfen (ohne Apple): Schlüssel erzeugen, signieren, r‖s zurück nach DER, verifizieren
        d = tempfile.mkdtemp()
        k = os.path.join(d, 'k.p8')
        subprocess.run(f'{OPENSSL} ecparam -name prime256v1 -genkey -noout | {OPENSSL} pkcs8 -topk8 -nocrypt -out {k}', shell=True, check=True)
        os.environ.update(ASC_KEY_ID='TEST', ASC_ISSUER_ID='iss', ASC_KEY_PATH=k)
        t = token()
        h, p, s = t.split('.')
        raw = base64.urlsafe_b64decode(s + '==')
        assert len(raw) == 64

        def i2der(x):
            x = x.lstrip(b'\x00') or b'\x00'
            if x[0] & 0x80:
                x = b'\x00' + x
            return b'\x02' + bytes([len(x)]) + x
        body = i2der(raw[:32]) + i2der(raw[32:])
        der = b'\x30' + bytes([len(body)]) + body
        open(os.path.join(d, 's'), 'wb').write(der)
        subprocess.run(f'{OPENSSL} pkey -in {k} -pubout -out {d}/pub.pem', shell=True, check=True)
        r = subprocess.run([OPENSSL, 'dgst', '-sha256', '-verify', f'{d}/pub.pem', '-signature', f'{d}/s'], input=f'{h}.{p}'.encode(), capture_output=True)
        print('selftest', r.stdout.decode().strip())
        sys.exit(r.returncode)
    else:
        print(__doc__)
        sys.exit(2)
