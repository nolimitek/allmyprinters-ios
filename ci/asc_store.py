#!/usr/bin/env python3
"""App-Store-Eintrag über die App-Store-Connect-API — ohne Mac, ohne Zusatzpakete (25.11.2026).

  python3 ci/asc_store.py inspect <ausgabe>   nur lesen → <ausgabe>/inspect.json
  python3 ci/asc_store.py apply   <ausgabe>   store/meta.json + store/screens/<locale>/<iphone|ipad>/*.jpg eintragen, danach inspect

Braucht ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (wie ci/asc.py). Reicht NIE zur Prüfung ein und veröffentlicht nichts:
Version bleibt „Zur Einreichung vorbereiten“, Veröffentlichung nach Freigabe = manuell (releaseType MANUAL).
Was die API nicht kann (im Browser): App-Datenschutz (Datenerfassung), DSA-Händlerstatus, Einreichen.
"""
import hashlib, json, os, sys, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asc  # noqa: E402  token()

APP_ID = os.environ.get('APP_ID', '6838309171')
BASE = 'https://api.appstoreconnect.apple.com'
EDITABLE = {'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'}
DISPLAY = {'iphone': 'APP_IPHONE_67', 'ipad': 'APP_IPAD_PRO_3GEN_129'}
_tok = [None, 0]
errors = []


def req(method, path, body=None, raw=None, url=None, headers=None):
    if not _tok[0] or time.time() - _tok[1] > 900:
        _tok[0], _tok[1] = asc.token(), time.time()
    u = url or (BASE + (path if path.startswith('/v') else '/v1' + path))
    h = headers if headers is not None else {'Authorization': 'Bearer ' + _tok[0], 'Content-Type': 'application/json'}
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(u, method=method, data=data, headers=h)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(r, timeout=120) as res:
                b = res.read()
                return res.status, (json.loads(b) if b and res.headers.get('Content-Type', '').startswith('application/json') else {})
        except urllib.error.HTTPError as e:
            b = e.read()
            try:
                j = json.loads(b)
            except Exception:
                j = {'raw': b.decode(errors='replace')[:600]}
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(5 * (attempt + 1)); continue
            return e.code, j
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(5); continue
            return 0, {'raw': str(e)}


def etext(j):
    return '; '.join(f"{x.get('code')}: {x.get('detail') or x.get('title')}" + (f" [{x.get('source', {}).get('pointer', '')}]" if x.get('source') else '')
                     for x in j.get('errors', [])) or json.dumps(j)[:500]


def ok(label, st, j, want=(200, 201, 204)):
    if st in want:
        print(f'OK   {label}', flush=True); return True
    print(f'FEHL {label}: HTTP {st} {etext(j)}', flush=True); errors.append(f'{label}: {st} {etext(j)}'); return False


def get_all(path):
    out, url = [], None
    st, j = req('GET', path)
    while True:
        if st != 200:
            return None, (st, j)
        out += j.get('data', [])
        nxt = (j.get('links') or {}).get('next')
        if not nxt:
            return out, None
        st, j = req('GET', None, url=nxt)


def rel(t, i):
    return {'data': {'type': t, 'id': i}}


# ── lesen ──────────────────────────────────────────────────────────────────────────────────────────────
def inspect():
    R = {'zeit': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    st, j = req('GET', f'/apps/{APP_ID}')
    R['app'] = j.get('data', {}).get('attributes') if st == 200 else {'fehler': [st, etext(j)]}
    infos, e = get_all(f'/apps/{APP_ID}/appInfos')
    R['appInfos'] = []
    for i in infos or []:
        d = {'id': i['id'], 'attributes': i['attributes']}
        locs, _ = get_all(f"/appInfos/{i['id']}/appInfoLocalizations")
        d['localizations'] = [{'id': x['id'], **x['attributes']} for x in locs or []]
        st, a = req('GET', f"/appInfos/{i['id']}/ageRatingDeclaration")
        d['ageRating'] = {'id': a['data']['id'], **a['data']['attributes']} if st == 200 else [st, etext(a)]
        for c in ('primaryCategory', 'secondaryCategory'):
            st, a = req('GET', f"/appInfos/{i['id']}/relationships/{c}")
            d[c] = (a.get('data') or {}).get('id') if st == 200 else [st, etext(a)]
        R['appInfos'].append(d)
    vers, e = get_all(f'/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS')
    R['versions'] = []
    for v in vers or []:
        d = {'id': v['id'], 'attributes': v['attributes'], 'localizations': []}
        locs, _ = get_all(f"/appStoreVersions/{v['id']}/appStoreVersionLocalizations")
        for x in locs or []:
            sets, _ = get_all(f"/appStoreVersionLocalizations/{x['id']}/appScreenshotSets")
            ss = []
            for s in sets or []:
                shots, _ = get_all(f"/appScreenshotSets/{s['id']}/appScreenshots")
                ss.append({'type': s['attributes']['screenshotDisplayType'], 'n': len(shots or []),
                           'states': sorted({(y['attributes'].get('assetDeliveryState') or {}).get('state', '?') for y in shots or []})})
            a = dict(x['attributes']); a['description'] = (a.get('description') or '')[:80]
            d['localizations'].append({'id': x['id'], **a, 'screenshotSets': ss})
        st, a = req('GET', f"/appStoreVersions/{v['id']}/appStoreReviewDetail")
        d['reviewDetail'] = ({'id': a['data']['id'], **{k: (w[:80] if isinstance(w, str) else w) for k, w in a['data']['attributes'].items()}}
                             if st == 200 and a.get('data') else [st, etext(a) if st != 200 else 'keine'])
        st, a = req('GET', f"/appStoreVersions/{v['id']}/build")
        d['build'] = (a.get('data') or {}).get('attributes', {}).get('version') if st == 200 else None
        R['versions'].append(d)
    st, j = req('GET', f'/builds?filter[app]={APP_ID}&sort=-uploadedDate&limit=8&include=preReleaseVersion')
    pre = {x['id']: x['attributes'].get('version') for x in j.get('included', []) if x['type'] == 'preReleaseVersions'} if st == 200 else {}
    R['builds'] = [{'id': b['id'], 'build': b['attributes'].get('version'), 'state': b['attributes'].get('processingState'),
                    'uploaded': b['attributes'].get('uploadedDate'), 'expired': b['attributes'].get('expired'),
                    'encryption': b['attributes'].get('usesNonExemptEncryption'),
                    'version': pre.get(((b.get('relationships') or {}).get('preReleaseVersion') or {}).get('data', {}).get('id'))}
                   for b in j.get('data', [])] if st == 200 else [st, etext(j)]
    st, j = req('GET', f'/apps/{APP_ID}/appPriceSchedule')
    R['priceSchedule'] = [st, j.get('data', {}).get('id') if st == 200 else etext(j)]
    if st == 200:
        st2, m = req('GET', f"/appPriceSchedules/{j['data']['id']}/manualPrices?include=appPricePoint,territory&limit=5")
        R['priceSchedule'].append([x.get('attributes', {}).get('customerPrice') for x in m.get('included', []) if x['type'] == 'appPricePoints'] if st2 == 200 else etext(m))
    st, j = req('GET', f'/apps/{APP_ID}/appAvailabilityV2')
    R['availability'] = [st, j.get('data', {}).get('attributes') if st == 200 else etext(j)]
    if st == 200:
        ta, _ = get_all(f"/v2/appAvailabilities/{j['data']['id']}/territoryAvailabilities?limit=200")
        R['availability'].append({'territories': len(ta or []), 'available': sum(1 for x in ta or [] if x['attributes'].get('available'))})
    return R


# ── eintragen ──────────────────────────────────────────────────────────────────────────────────────────
def upsert_loc(kind, parent_type, parent_id, have, locale, attrs):
    """appInfoLocalizations / appStoreVersionLocalizations anlegen oder ändern"""
    attrs = {k: v for k, v in attrs.items() if v is not None}
    if locale in have:
        st, j = req('PATCH', f'/{kind}/{have[locale]}', {'data': {'type': kind, 'id': have[locale], 'attributes': attrs}})
        return ok(f'{kind} {locale} geändert', st, j)
    st, j = req('POST', f'/{kind}', {'data': {'type': kind, 'attributes': {'locale': locale, **attrs},
                                               'relationships': {parent_type: rel(parent_type + 's', parent_id)}}})
    if ok(f'{kind} {locale} angelegt', st, j):
        have[locale] = j['data']['id']; return True
    return False


def upload_shots(loc_id, locale, dev, files):
    t = DISPLAY[dev]
    sets, e = get_all(f'/appStoreVersionLocalizations/{loc_id}/appScreenshotSets')
    sid = next((s['id'] for s in sets or [] if s['attributes']['screenshotDisplayType'] == t), None)
    if not sid:
        st, j = req('POST', '/appScreenshotSets', {'data': {'type': 'appScreenshotSets', 'attributes': {'screenshotDisplayType': t},
                                                            'relationships': {'appStoreVersionLocalization': rel('appStoreVersionLocalizations', loc_id)}}})
        if not ok(f'Bildsatz {locale} {t}', st, j):
            return
        sid = j['data']['id']
    old, _ = get_all(f'/appScreenshotSets/{sid}/appScreenshots')
    for o in old or []:
        st, j = req('DELETE', f"/appScreenshots/{o['id']}")
        ok(f"altes Bild {locale} {dev} {o['attributes'].get('fileName')} gelöscht", st, j)
    ids = []
    for f in files:
        b = open(f, 'rb').read()
        st, j = req('POST', '/appScreenshots', {'data': {'type': 'appScreenshots', 'attributes': {'fileName': os.path.basename(f), 'fileSize': len(b)},
                                                         'relationships': {'appScreenshotSet': rel('appScreenshotSets', sid)}}})
        if not ok(f'Bild {locale} {dev} {os.path.basename(f)} reserviert', st, j):
            continue
        sh = j['data']; good = True
        for op in sh['attributes'].get('uploadOperations') or []:
            part = b[op['offset']:op['offset'] + op['length']]
            st2, j2 = req(op['method'], None, raw=part, url=op['url'], headers={h['name']: h['value'] for h in op.get('requestHeaders') or []})
            if st2 not in (200, 201, 204):
                good = False; ok(f'Bild {locale} {dev} Teil {op["offset"]}', st2, j2)
        if not good:
            continue
        st, j = req('PATCH', f"/appScreenshots/{sh['id']}", {'data': {'type': 'appScreenshots', 'id': sh['id'],
                                                                      'attributes': {'uploaded': True, 'sourceFileChecksum': hashlib.md5(b).hexdigest()}}})
        if ok(f'Bild {locale} {dev} {os.path.basename(f)} hochgeladen', st, j):
            ids.append(sh['id'])
    # Verarbeitung abwarten (Apple prüft Größe/Format)
    for _ in range(36):
        shots, _ = get_all(f'/appScreenshotSets/{sid}/appScreenshots')
        states = [(s['attributes'].get('fileName'), (s['attributes'].get('assetDeliveryState') or {})) for s in shots or []]
        if all(x[1].get('state') in ('COMPLETE', 'FAILED') for x in states):
            break
        time.sleep(5)
    for name, s in states:
        if s.get('state') != 'COMPLETE':
            errors.append(f'Bild {locale} {dev} {name}: {s}'); print(f'FEHL Bild {locale} {dev} {name}: {json.dumps(s)[:400]}', flush=True)
    print(f'     {locale} {dev}: {sum(1 for x in states if x[1].get("state") == "COMPLETE")}/{len(files)} fertig', flush=True)


def apply(meta, shots_dir):
    # 1 App: Inhaltsrechte nur, wenn in meta.json ausdrücklich gesetzt
    if meta.get('contentRights'):
        st, j = req('PATCH', f'/apps/{APP_ID}', {'data': {'type': 'apps', 'id': APP_ID, 'attributes': {'contentRightsDeclaration': meta['contentRights']}}})
        ok('Inhaltsrechte', st, j)
    # 2 App-Informationen (die noch änderbare)
    infos, e = get_all(f'/apps/{APP_ID}/appInfos')
    info = next((i for i in infos or [] if (i['attributes'].get('appStoreState') or i['attributes'].get('state')) not in ('READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_INFO')), (infos or [None])[0])
    if info:
        cat = {'primaryCategory': rel('appCategories', meta['category'][0])}
        if len(meta['category']) > 1:
            cat['secondaryCategory'] = rel('appCategories', meta['category'][1])
        st, j = req('PATCH', f"/appInfos/{info['id']}", {'data': {'type': 'appInfos', 'id': info['id'], 'relationships': cat}})
        ok('Kategorien ' + '/'.join(meta['category']), st, j)
        locs, _ = get_all(f"/appInfos/{info['id']}/appInfoLocalizations")
        have = {x['attributes']['locale']: x['id'] for x in locs or []}
        for L, m in meta['locales'].items():
            upsert_loc('appInfoLocalizations', 'appInfo', info['id'], have, L,
                       {'name': m.get('name', meta['name']), 'subtitle': m['subtitle'], 'privacyPolicyUrl': m['privacy']})
        # 3 Altersfreigabe: nur Felder, die Apple in der Erklärung führt
        st, a = req('GET', f"/appInfos/{info['id']}/ageRatingDeclaration")
        if st == 200:
            known = a['data']['attributes']
            attrs = {k: v for k, v in meta['age'].items() if k in known}
            skipped = sorted(set(meta['age']) - set(known)); missing = sorted(k for k, v in known.items() if v is None and k not in meta['age'])
            print(f'     Altersfreigabe: {len(attrs)} Felder, unbekannt {skipped}, offen {missing}', flush=True)
            aid = a['data']['id']
            patch = lambda at: req('PATCH', f'/ageRatingDeclarations/{aid}', {'data': {'type': 'ageRatingDeclarations', 'id': aid, 'attributes': at}})
            st, j = patch(attrs)
            if st != 200:
                # neue Fragen (2025/26) haben teils andere Typen → einzeln, bei Fehler die andere Form (False ↔ 'NONE')
                print(f'     Altersfreigabe gesamt: {st} {etext(j)} → einzeln', flush=True)
                for k, v in attrs.items():
                    s1, j1 = patch({k: v})
                    if s1 != 200:
                        alt = 'NONE' if v is False else False if v == 'NONE' else None
                        s2, j2 = patch({k: alt}) if alt is not None else (s1, j1)
                        ok(f'Altersfreigabe {k}={alt!r} (statt {v!r})', s2, j2) if alt is not None else ok(f'Altersfreigabe {k}', s1, j1)
                st, j = 200, {}
            ok('Altersfreigabe', st, j)
            st, a2 = req('GET', f"/apps/{APP_ID}/appInfos")
            print('     Altersstufe jetzt: ' + json.dumps([x['attributes'].get('appStoreAgeRating') for x in a2.get('data', [])]), flush=True)
        else:
            ok('Altersfreigabe lesen', st, a)
    else:
        errors.append('keine App-Informationen')
    # 4 Version
    vers, e = get_all(f'/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS')
    ver = next((v for v in vers or [] if (v['attributes'].get('appStoreState') or v['attributes'].get('appVersionState')) in EDITABLE), None)
    if not ver:
        st, j = req('POST', '/appStoreVersions', {'data': {'type': 'appStoreVersions', 'attributes': {'platform': 'IOS', 'versionString': meta['version']},
                                                           'relationships': {'app': rel('apps', APP_ID)}}})
        if not ok('Version ' + meta['version'] + ' angelegt', st, j):
            return
        ver = j['data']
    va = {'releaseType': 'MANUAL', 'copyright': meta['copyright']}
    if ver['attributes'].get('versionString') != meta['version']:
        va['versionString'] = meta['version']
    st, j = req('PATCH', f"/appStoreVersions/{ver['id']}", {'data': {'type': 'appStoreVersions', 'id': ver['id'], 'attributes': va}})
    ok(f"Version {meta['version']} (manuell veröffentlichen, {meta['copyright']})", st, j)
    # 5 Texte je Sprache
    locs, _ = get_all(f"/appStoreVersions/{ver['id']}/appStoreVersionLocalizations")
    have = {x['attributes']['locale']: x['id'] for x in locs or []}
    for L, m in meta['locales'].items():
        upsert_loc('appStoreVersionLocalizations', 'appStoreVersion', ver['id'], have, L,
                   {'description': m['description'], 'keywords': m['keywords'], 'promotionalText': m['promo'], 'supportUrl': m['support'], 'marketingUrl': m.get('marketing')})
    # 6 Bildschirmfotos
    for L in meta['locales']:
        if L not in have:
            continue
        for dev in ('iphone', 'ipad'):
            d = os.path.join(shots_dir, L, dev)
            files = sorted(os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(('.jpg', '.jpeg', '.png'))) if os.path.isdir(d) else []
            if files:
                upload_shots(have[L], L, dev, files)
    # 7 Hinweise für die Prüfung
    r = meta['review']
    attrs = {'contactFirstName': r['first'], 'contactLastName': r['last'], 'contactEmail': r['email'], 'demoAccountRequired': False, 'notes': r['notes']}
    if r.get('phone'):
        attrs['contactPhone'] = r['phone']
    st, a = req('GET', f"/appStoreVersions/{ver['id']}/appStoreReviewDetail")
    if st == 200 and a.get('data'):
        st, j = req('PATCH', f"/appStoreReviewDetails/{a['data']['id']}", {'data': {'type': 'appStoreReviewDetails', 'id': a['data']['id'], 'attributes': attrs}})
    else:
        st, j = req('POST', '/appStoreReviewDetails', {'data': {'type': 'appStoreReviewDetails', 'attributes': attrs,
                                                                'relationships': {'appStoreVersion': rel('appStoreVersions', ver['id'])}}})
    ok('Hinweise für die Prüfung', st, j)
    # 8 Preis: kostenlos (nur wenn noch kein Preisplan da ist)
    st, j = req('GET', f'/apps/{APP_ID}/appPriceSchedule')
    if st == 200:   # Apple liefert den Plan auch ohne Preise (id = App) — erst Preise zählen
        st, m = req('GET', f"/appPriceSchedules/{j['data']['id']}/manualPrices?limit=1")
        st = 200 if st == 200 and m.get('data') else 404
    if st != 200:
        pts, e = get_all(f'/apps/{APP_ID}/appPricePoints?filter[territory]=USA&limit=200')
        free = next((p['id'] for p in pts or [] if str(p['attributes'].get('customerPrice')) in ('0', '0.0', '0.00')), None)
        if free:
            st, j = req('POST', '/appPriceSchedules', {'data': {'type': 'appPriceSchedules', 'relationships': {
                'app': rel('apps', APP_ID), 'baseTerritory': rel('territories', 'USA'), 'manualPrices': {'data': [{'type': 'appPrices', 'id': '${p0}'}]}}},
                'included': [{'type': 'appPrices', 'id': '${p0}', 'attributes': {'startDate': None}, 'relationships': {'appPricePoint': rel('appPricePoints', free)}}]})
            ok('Preis kostenlos', st, j)
        else:
            errors.append('kein Preispunkt 0 gefunden'); print('FEHL kein Preispunkt 0', e, flush=True)
    else:
        print('     Preisplan schon da', flush=True)
    # 9 Verfügbarkeit: alle Länder (nur wenn noch keine eingestellt)
    st, j = req('GET', f'/apps/{APP_ID}/appAvailabilityV2')
    if st != 200:
        ter, e = get_all('/territories?limit=200')
        inc = [{'type': 'territoryAvailabilities', 'id': '${t' + t['id'] + '}', 'attributes': {'available': True},
                'relationships': {'territory': rel('territories', t['id'])}} for t in ter or []]
        st, j = req('POST', '/v2/appAvailabilities', {'data': {'type': 'appAvailabilities', 'attributes': {'availableInNewTerritories': True},
                                                              'relationships': {'app': rel('apps', APP_ID), 'territoryAvailabilities': {'data': [{'type': x['type'], 'id': x['id']} for x in inc]}}},
                                                     'included': inc})
        ok(f'Verfügbarkeit {len(inc)} Länder', st, j)
    else:
        print('     Verfügbarkeit schon eingestellt', flush=True)
    # 10 Build anhängen
    attach_build(meta, ver)


def attach_build(meta, ver=None):
    """Build an die Version hängen — wartet bis zu 20 Min., bis Apple ihn verarbeitet hat (VALID)"""
    if not meta.get('build'):
        return
    if ver is None:
        vers, e = get_all(f'/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS')
        ver = next((v for v in vers or [] if (v['attributes'].get('appStoreState') or v['attributes'].get('appVersionState')) in EDITABLE), None)
        if not ver:
            errors.append('keine änderbare Version'); print('FEHL keine änderbare Version', flush=True); return
    b = None
    for k in range(40):
        st, j = req('GET', f'/builds?filter[app]={APP_ID}&filter[preReleaseVersion.version]={meta["version"]}&sort=-uploadedDate&limit=5')
        cand = [x for x in j.get('data', []) if meta['build'] == 'latest' or x['attributes'].get('version') == str(meta['build'])] if st == 200 else []
        b = next((x for x in cand if x['attributes'].get('processingState') == 'VALID' and not x['attributes'].get('expired')), None)
        if b or (cand and cand[0]['attributes'].get('processingState') in ('FAILED', 'INVALID')):
            break
        print(f"     warte auf Build {meta['build']}: {[x['attributes'].get('processingState') for x in cand] or 'noch nicht da'}", flush=True)
        time.sleep(30)
    if True:
        if b:
            st, j = req('PATCH', f"/appStoreVersions/{ver['id']}/relationships/build", {'data': {'type': 'builds', 'id': b['id']}})
            ok(f"Build {b['attributes'].get('version')} an Version {meta['version']}", st, j)
        else:
            errors.append(f"kein gültiger Build {meta['build']} für {meta['version']}"); print(f"FEHL kein gültiger Build {meta['build']} für {meta['version']}", flush=True)


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ('inspect', 'apply', 'build'):
        sys.exit(__doc__)
    out = sys.argv[2]; os.makedirs(out, exist_ok=True)
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'store')
    if sys.argv[1] == 'apply':
        apply(json.load(open(os.path.join(here, 'meta.json'), encoding='utf-8')), os.path.join(here, 'screens'))
    elif sys.argv[1] == 'build':
        attach_build(json.load(open(os.path.join(here, 'meta.json'), encoding='utf-8')))
    R = inspect(); R['fehler'] = errors
    json.dump(R, open(os.path.join(out, 'inspect.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(R, ensure_ascii=False, indent=1)[:6000])
    print(f'\n{len(errors)} FEHLER' if errors else '\nALLES OK')
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
