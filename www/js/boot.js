/* AllMyPrinters — Start: Sprache wählen, Texte zusammenstellen, window.FM wie filament/index.php setzen. Läuft vor app.js. */
(() => {
  const LANGS = ['de', 'en', 'fr', 'es', 'it', 'nl'];
  let lang = null;
  try { lang = localStorage.getItem('amp_lang'); } catch (e) {}
  if (!LANGS.includes(lang)) lang = LANGS.find(l => (navigator.languages || [navigator.language]).some(x => String(x).slice(0, 2).toLowerCase() === l)) || 'en';
  const base = Object.assign({}, window.AMP_I18N.en, window.AMP_I18N[lang]);
  // Texte, die „3DSEARCH“ als Absender nennen, sprechen in der App von ihr selbst
  for (const k in base) if (typeof base[k] === 'string' && base[k].includes('3DSEARCH')) base[k] = base[k].replace(/3DSEARCH/g, 'AllMyPrinters');
  const S = Object.assign(base, window.AMP_I18N_X.en, window.AMP_I18N_X[lang]);
  // Eigene iOS-App (25.11.2026): Texte ohne „Android/Google“ (amp-i18n.js AMP_I18N_IOS); AMPNative setzt der iOS-Shim vor dem Laden
  let ios = false; try { ios = !!(window.AMPNative && AMPNative.platform === 'ios'); } catch (e) {}
  if (ios && window.AMP_I18N_IOS) Object.assign(S, window.AMP_I18N_IOS.en, window.AMP_I18N_IOS[lang]);
  let cur = 'EUR';
  try { cur = localStorage.getItem('amp_cur') || (lang === 'en' && /US/.test(navigator.language) ? 'USD' : 'EUR'); } catch (e) {}
  window.FM = { S, lang, low: 100, can_print: true, lib: true, community: false, cur, aff: { brands: {}, def: '' }, fbk: '', rfi: null, jsqr: 'vendor/jsqr.min.js', embed: false, app: true, LANGS };
  document.documentElement.lang = lang;
  // Hell/dunkel (Schlüssel 3ds_theme wie /filament): 'system' (Vorgabe seit 10.11.2026, Tester: „sollte dem Handy folgen“), 'light', 'dark'.
  // System = Nachtmodus des Handys: AMPNative.night() synchron (sonst prefers-color-scheme); Umschalten im Betrieb meldet MainActivity
  // als Ereignis „night“ (amp-views.js). Wer früher Hell/Dunkel gewählt hat, behält seine Wahl.
  const sysDark = () => {
    try { if (window.AMPNative && AMPNative.night) return !!AMPNative.night(); } catch (e) {}
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  };
  const T = window.AMP_THEME = {
    mode: 'system', sysDark,
    apply() { document.documentElement.setAttribute('data-theme', T.mode === 'system' ? (sysDark() ? 'dark' : 'light') : T.mode); },
    set(m) { T.mode = m; try { localStorage.setItem('3ds_theme', m); } catch (e) {} T.apply(); },
  };
  try { const v = localStorage.getItem('3ds_theme'); if (['system', 'light', 'dark'].includes(v)) T.mode = v; } catch (e) {}
  T.apply();
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (T.mode === 'system') T.apply(); }); } catch (e) {}
  // Navigation beschriften (index.html trägt nur Schlüssel)
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-t]').forEach(el => { el.textContent = S[el.dataset.t] || el.dataset.t; });
    document.querySelectorAll('[data-tl]').forEach(el => { el.setAttribute('aria-label', S[el.dataset.tl] || ''); el.title = S[el.dataset.tl] || ''; });
    document.querySelectorAll('a[data-amp-site]').forEach(a => { a.href = 'https://allmyprinters.com/' + lang + '/' + a.dataset.ampSite + '/'; });   // Community (15.11.2026)
    document.title = S.app_title;
  });
})();
