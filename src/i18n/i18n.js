/* VoxStorm — interface languages. Used by the main process (require) and by every window (<script>).
   The Turkish text in the code is the key: __('Kaydet') shows "Save" in English. A language file
   (src/i18n/en.js…) maps those Turkish strings to its own; a missing one falls back to Turkish.
     __('Merhaba {name}', { name })                       placeholders in braces
     __('{n} terminal açık', { n })  ->  en: { one: '{n} terminal is open', other: '{n} terminals are open' }
   Adding a language: copy en.js, translate the values, add a line to LANGS. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.I18N = api; root.__ = api.t; if (root.api && root.api.lang) api.setLang(root.api.lang); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // code, name in its own language, BCP 47 locale (dates and numbers), name in Turkish (the reply-language line)
  const LANGS = [
    ['tr', 'Türkçe', 'tr-TR'],
    ['en', 'English', 'en-US'],
    ['de', 'Deutsch', 'de-DE'],
    ['es', 'Español', 'es-ES'],
    ['fr', 'Français', 'fr-FR'],
  ];
  const dicts = Object.create(null);
  let lang = 'tr', dict = null;
  const has = code => LANGS.some(l => l[0] === code);

  function register(code, d) { dicts[code] = d || {}; if (code === lang) dict = dicts[code]; }
  function setLang(code) { lang = has(code) ? code : 'tr'; dict = lang === 'tr' ? null : (dicts[lang] || null); return lang; }
  // 'auto' (or nothing) -> the first supported system language, English when none is
  function resolve(pref, systemLangs) {
    if (pref && pref !== 'auto' && has(pref)) return pref;
    for (const s of systemLangs || []) { const c = String(s || '').toLowerCase().split(/[-_]/)[0]; if (has(c)) return c; }
    return 'en';
  }
  const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(v, k) && v[k] != null ? String(v[k]) : m)) : String(s));
  function t(src, vars) {
    let s = dict && Object.prototype.hasOwnProperty.call(dict, src) ? dict[src] : src;
    if (s && typeof s === 'object') s = (vars && Number(vars.n) === 1 ? s.one : s.other) || s.other || s.one || src;
    return fill(s == null || s === '' ? src : s, vars);
  }
  const locale = () => (LANGS.find(l => l[0] === lang) || LANGS[0])[2];

  /* static HTML (index.html, welcome.html): text and the title / placeholder / aria-label / data-tip / alt
     attributes are looked up as they are written, with runs of white space made into one space */
  const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'alt'];
  const key = s => String(s).replace(/\s+/g, ' ').trim();
  function translateDom(node) {
    if (!dict || !node) return;
    const look = s => { const k = key(s); return k && Object.prototype.hasOwnProperty.call(dict, k) ? t(k) : null; };
    const walk = el => {
      for (const n of [...el.childNodes]) {
        if (n.nodeType === 3) {
          const v = look(n.nodeValue);
          if (v != null) { const m = /^(\s*)[\s\S]*?(\s*)$/.exec(n.nodeValue); n.nodeValue = m[1] + v + m[2]; }
        } else if (n.nodeType === 1 && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') {
          for (const a of ATTRS) if (n.hasAttribute(a)) { const v = look(n.getAttribute(a)); if (v != null) n.setAttribute(a, v); }
          walk(n);
        }
      }
    };
    walk(node);
  }

  return { LANGS, register, setLang, resolve, t, locale, lang: () => lang, translateDom, key };
});
