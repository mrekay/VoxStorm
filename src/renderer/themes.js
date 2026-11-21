/* VoxStorm — custom themes: made in the theme editor, or by Claude / Codex (agentlink save_theme).
   A theme is ten base colours (+ light / dark and an optional background picture); every other colour
   of the app (hover, lines, soft tints, terminal selection…) is worked out from them here, in plain hex,
   because the terminal needs real colours, not CSS color-mix(). The theme is shown as
   :root[data-skin="custom"] from a <style> element; a picture adds data-bgimg and makes the surfaces
   see-through. Loaded by the main window and the welcome window. */
(() => {
  'use strict';
  const FIELDS = [
    ['bg', 'Arka plan', 'Pencerenin en dış zemini'],
    ['surface', 'Yüzey', 'Paneller, menüler, kartlar'],
    ['fg', 'Yazı', 'Ana yazı rengi'],
    ['muted', 'Soluk yazı', 'Açıklamalar, ikincil bilgiler'],
    ['accent', 'Vurgu', 'Seçili öğeler, düğmeler, bağlantılar'],
    ['warn', 'Uyarı', 'Karar bekleyen, dikkat'],
    ['ok', 'Başarılı', 'Biten işler, ekleme'],
    ['danger', 'Tehlike', 'Hata, silme'],
    ['termBg', 'Terminal zemini', 'Terminal ve konsol arka planı'],
    ['termFg', 'Terminal yazısı', '“Temaya uyumlu” terminal renklerinde yazı rengi'],
  ];
  const BASE = { // starting point of a new theme: the default dark one
    dark: true,
    colors: { bg: '#0b0a12', surface: '#15131f', fg: '#e7e4f3', muted: '#8e89a8', accent: '#a78bfa', warn: '#f2b155', ok: '#6fd39a', danger: '#f27b8c', termBg: '#0a0911', termFg: '#ddd8ef' },
  };

  /* ---------------- colour maths ---------------- */
  const HEX = /^#([0-9a-f]{6})$/i;
  const okHex = v => HEX.test(String(v || ''));
  function norm(v) {
    v = String(v || '').trim();
    const m = /^#?([0-9a-f]{3})$/i.exec(v);
    if (m) v = '#' + m[1].split('').map(c => c + c).join('');
    if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
    return okHex(v) ? v.toLowerCase() : null;
  }
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const hex = a => '#' + a.map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const rgba = (h, a) => `rgba(${rgb(h).join(',')},${Math.round(a * 1000) / 1000})`;
  const lum = h => { const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

  function clean(th) {
    const t = th && typeof th === 'object' ? th : {};
    const c = Object.assign({}, BASE.colors);
    for (const [k] of FIELDS) { const v = norm(t.colors && t.colors[k]); if (v) c[k] = v; }
    const dark = typeof t.dark === 'boolean' ? t.dark : lum(c.bg) < 0.3;
    const im = t.image && t.image.url ? { url: String(t.image.url), file: String(t.image.file || ''), show: Math.max(5, Math.min(90, +t.image.show || 35)), blur: Math.max(0, Math.min(30, +t.image.blur || 0)) } : null;
    return { id: String(t.id || ''), name: String(t.name || 'Tema').slice(0, 40), dark, colors: c, image: im, by: t.by ? String(t.by).slice(0, 20) : undefined };
  }

  // every CSS variable the app uses, from the ten base colours
  function vars(th) {
    const { colors: c, dark, image } = clean(th);
    const violet = mix(c.accent, c.danger, 0.5);
    const v = {
      '--bg': c.bg, '--surface': c.surface, '--surface-2': mix(c.surface, c.bg, 0.5), '--hover': mix(c.surface, c.fg, 0.08), '--line': mix(c.surface, c.fg, 0.14),
      '--fg': c.fg, '--muted': c.muted, '--accent': c.accent, '--accent-soft': mix(c.surface, c.accent, 0.2), '--on-accent': lum(c.accent) > 0.45 ? mix(c.accent, '#000000', 0.82) : '#ffffff', '--run': c.accent,
      '--warn': c.warn, '--warn-soft': mix(c.surface, c.warn, 0.16), '--ok': c.ok, '--ok-soft': mix(c.surface, c.ok, 0.16), '--danger': c.danger, '--violet': violet, '--violet-soft': mix(c.surface, violet, 0.18),
      '--term-bg': c.termBg, '--term-fg': c.termFg, '--term-dim': mix(c.termBg, c.termFg, 0.55), '--term-cursor': c.accent, '--term-sel': mix(c.termBg, c.accent, 0.35),
      '--shadow': dark ? '0 20px 60px -20px rgba(0,0,0,.85)' : '0 18px 50px -20px rgba(16,30,33,.45)',
      '--syn-kw': c.accent, '--syn-prop': mix(c.accent, c.fg, 0.45),
      '--bg-solid': c.bg,
    };
    if (image) { // the picture shows through the surfaces
      const s = image.show / 100;
      Object.assign(v, {
        '--bg': rgba(c.bg, 1 - s), '--surface': rgba(c.surface, 1 - s * 0.7), '--surface-2': rgba(mix(c.surface, c.bg, 0.5), 1 - s * 0.75),
        '--term-bg': rgba(c.termBg, 1 - s * 0.8), '--bg-img': `url("${image.url.replace(/["\\]/g, '')}")`, '--bg-blur': image.blur + 'px',
      });
    }
    return { v, dark, image };
  }
  function css(th) {
    const { v, dark } = vars(th);
    return `:root[data-skin="custom"]{color-scheme:${dark ? 'dark' : 'light'};${Object.entries(v).map(([k, x]) => `${k}:${x}`).join(';')}}`;
  }

  // show a theme (or none: back to the built-in ones)
  function show(th) {
    const root = document.documentElement;
    let el = document.getElementById('voxCustomTheme');
    if (!th) { if (el) el.remove(); delete root.dataset.bgimg; return; }
    if (!el) { el = document.createElement('style'); el.id = 'voxCustomTheme'; document.head.appendChild(el); }
    el.textContent = css(th);
    root.dataset.skin = 'custom';
    if (clean(th).image) root.dataset.bgimg = ''; else delete root.dataset.bgimg;
  }
  const list = () => (typeof CFG !== 'undefined' && CFG && CFG.settings.customThemes) || [];
  const byId = id => list().find(t => t.id === id) || null;

  /* ---------------- editor ---------------- */
  let ed = null; // { th, orig, el, skinBefore }
  function swatches(th) { const c = clean(th).colors; return [c.bg, c.accent, c.warn]; }

  function openEditor(id, preset) {
    if (ed) closeEditor(false);
    const orig = id ? byId(id) : null;
    const th = clean(preset || orig || Object.assign({ name: 'Yeni tema' }, JSON.parse(JSON.stringify(BASE))));
    if (orig) th.id = orig.id;
    const el = document.createElement('div');
    el.className = 'ui-dlg-bg in theme-ed-bg';
    el.innerHTML = `<div class="ui-dlg theme-ed" role="dialog" aria-modal="true" aria-label="Tema düzenleyici">
      <div class="ui-dlg-h"><i class="fa-solid fa-palette"></i><b>${orig ? 'Temayı düzenle' : 'Yeni tema'}</b></div>
      <div class="te-body">
        <label class="te-name"><span>Ad</span><input type="text" data-te="name" maxlength="40" spellcheck="false"></label>
        <div class="seg te-mode"><button data-te-dark="1">Koyu</button><button data-te-dark="0">Açık</button></div>
        <div class="te-grid">${FIELDS.map(([k, l, h]) => `<label class="te-c" title="${h}"><input type="color" data-tc="${k}"><span><b>${l}</b><small data-tx="${k}"></small></span></label>`).join('')}</div>
        <h4>Arka plan resmi</h4>
        <div class="te-img">
          <div class="te-thumb" data-te="thumb"></div>
          <div class="te-img-r">
            <div class="te-img-b"><button class="btn" data-te="pick"><i class="fa-regular fa-image"></i> Resim seç…</button><button class="btn" data-te="noimg"><i class="fa-solid fa-xmark"></i> Kaldır</button></div>
            <label class="te-sl"><span>Görünürlük</span><input type="range" min="5" max="90" data-te="show"><b data-te="showv"></b></label>
            <label class="te-sl"><span>Bulanıklık</span><input type="range" min="0" max="30" data-te="blur"><b data-te="blurv"></b></label>
          </div>
        </div>
        <p class="set-note">Değişiklikler hemen önizlenir. Vazgeçersen önceki tema geri gelir.</p>
      </div>
      <div class="ui-dlg-f">
        ${orig ? '<button class="btn te-del" data-te="del"><i class="fa-solid fa-trash-can"></i> Sil</button>' : ''}
        <button class="btn" data-te="claude"><i class="fa-solid fa-robot"></i> Claude ile tasarla</button>
        <span style="flex:1"></span>
        <button class="btn" data-te="cancel">Vazgeç</button><button class="btn primary" data-te="save">Kaydet ve uygula</button>
      </div></div>`;
    document.body.appendChild(el);
    ed = { th, orig, el, skinBefore: CFG.settings.skin };
    fill();
    preview();
    el.addEventListener('input', onInput);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeEditor(false); } });
    el.querySelector('[data-te=name]').focus();
  }
  function fill() {
    const { el, th } = ed;
    el.querySelector('[data-te=name]').value = th.name;
    el.querySelectorAll('[data-te-dark]').forEach(b => b.classList.toggle('on', (b.dataset.teDark === '1') === th.dark));
    for (const [k] of FIELDS) { el.querySelector(`[data-tc="${k}"]`).value = th.colors[k]; el.querySelector(`[data-tx="${k}"]`).textContent = th.colors[k]; }
    const im = th.image;
    el.querySelector('[data-te=thumb]').style.backgroundImage = im ? `url("${im.url}")` : '';
    el.querySelector('[data-te=thumb]').classList.toggle('empty', !im);
    for (const k of ['show', 'blur']) {
      const r = el.querySelector(`[data-te=${k}]`); r.disabled = !im; r.value = im ? im[k] : (k === 'show' ? 35 : 0);
      el.querySelector(`[data-te=${k}v]`).textContent = im ? (k === 'show' ? '%' + im.show : im.blur + ' px') : '–';
    }
    el.querySelector('[data-te=noimg]').disabled = !im;
  }
  // terminals take real colours: give them the new ones (and see-through when there is a picture)
  function repaintTerms() {
    if (typeof termTheme !== 'function' || typeof S === 'undefined') return;
    const th = termTheme(), clear = 'bgimg' in document.documentElement.dataset;
    S.tabs.forEach(t => { if (t.term) { try { if (clear) t.term.options.allowTransparency = true; } catch (_) {} t.term.options.theme = th; } });
  }
  const preview = () => { show(ed.th); repaintTerms(); };
  function onInput(e) {
    const t = e.target, th = ed.th;
    if (t.dataset.tc) { th.colors[t.dataset.tc] = t.value; ed.el.querySelector(`[data-tx="${t.dataset.tc}"]`).textContent = t.value; }
    else if (t.dataset.te === 'name') { th.name = t.value; return; }
    else if (t.dataset.te === 'show' || t.dataset.te === 'blur') { if (th.image) th.image[t.dataset.te] = +t.value; fill(); }
    preview();
  }
  async function onClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    const th = ed.th;
    if (b.dataset.teDark) { th.dark = b.dataset.teDark === '1'; fill(); preview(); return; }
    const a = b.dataset.te;
    if (a === 'pick') {
      const r = await api.invoke('theme:pickImage');
      if (!r) return;
      if (r.error) { uiAlert({ title: 'Resim eklenemedi', message: r.error }); return; }
      th.image = { url: r.url, file: r.file, show: th.image ? th.image.show : 35, blur: th.image ? th.image.blur : 0 };
      fill(); preview();
    } else if (a === 'noimg') { th.image = null; fill(); preview(); }
    else if (a === 'cancel') closeEditor(false);
    else if (a === 'save') { await save(th); closeEditor(true); }
    else if (a === 'del') {
      if (!(await uiConfirm({ title: 'Tema silinsin mi?', message: `“${th.name}” silinecek.`, ok: 'Sil', danger: true }))) return;
      const cur = byId(th.id);
      if (cur && cur.image && cur.image.file) api.invoke('theme:removeImage', cur.image.file).catch(() => {});
      const back = CFG.settings.skin === 'custom:' + th.id ? 'mono' : CFG.settings.skin;
      await setCfg({ settings: { customThemes: list().filter(x => x.id !== th.id), skin: back } });
      ed.skinBefore = back;
      closeEditor(false);
    } else if (a === 'claude') {
      closeEditor(false);
      designWithClaude();
    }
  }
  function closeEditor(saved) {
    if (!ed) return;
    ed.el.remove();
    const before = ed.skinBefore;
    ed = null;
    if (!saved) applySkin(before);
    if (typeof renderSettings === 'function') renderSettings();
    if (typeof renderSkinMenu === 'function') renderSkinMenu();
  }
  // add or replace a theme and switch to it
  async function save(th, opts = {}) {
    const t = clean(th);
    if (!t.id) t.id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const old = byId(t.id);
    if (old && old.image && old.image.file && (!t.image || t.image.file !== old.image.file)) api.invoke('theme:removeImage', old.image.file).catch(() => {});
    const next = list().filter(x => x.id !== t.id).concat(t);
    await setCfg({ settings: { customThemes: next, skin: 'custom:' + t.id } });
    applySkin('custom:' + t.id);
    if (!opts.quiet && typeof renderSettings === 'function') { renderSettings(); renderSkinMenu(); }
    return t;
  }

  /* ---------------- Claude designs it ---------------- */
  async function designWithClaude() {
    const desc = await uiPrompt({ title: 'Claude ile tema tasarla', icon: 'fa-palette', message: 'Nasıl bir tema istiyorsun?', placeholder: 'Ör: gün batımı, sıcak turuncu vurgulu koyu tema; ya da “şu resme göre”', maxLength: 600, ok: 'Claude’a gönder' });
    if (!desc || !desc.trim()) return;
    const pid = (typeof projectHere === 'function' && projectHere()) || (S.projects[0] && S.projects[0].id);
    if (!pid) { uiAlert({ title: 'Proje yok', message: 'Claude oturumu bir projede açılır. Önce bir proje ekle.' }); return; }
    if (S.mode !== 'claude') setMode('claude');
    const t = await openTerminal({ kind: 'claude', projectId: pid, title: 'Tema tasarımı' });
    if (!t) return;
    t.pendingPrompt = `VoxStorm için yeni bir arayüz teması tasarla: ${desc.trim()}\n\nÖnce VoxStorm'un get_theme aracıyla şu anki temaya ve renk alanlarına bak. Sonra save_theme ile kaydet: ad, koyu/açık ve on rengin hepsi (#rrggbb). Yazı ile zemin arasında okunur bir kontrast olsun (WCAG AA). Bir resim kullanmak istersem image_path ile yerel bir resim yolu ver. Kaydedince tema hemen uygulanır; bana kısaca hangi renkleri neden seçtiğini anlat.`;
    setTimeout(() => sendPendingPrompt(t), 12000);
  }

  /* ---------------- for agents (agentapi.js) ---------------- */
  function current() {
    const k = (CFG && CFG.settings.skin) || 'mono';
    const own = k.startsWith('custom:') ? byId(k.slice(7)) : null;
    const cs = getComputedStyle(document.documentElement), g = n => cs.getPropertyValue(n).trim();
    const now = own ? clean(own) : { name: k, dark: g('color-scheme') !== 'light', colors: { bg: g('--bg'), surface: g('--surface'), fg: g('--fg'), muted: g('--muted'), accent: g('--accent'), warn: g('--warn'), ok: g('--ok'), danger: g('--danger'), termBg: g('--term-bg'), termFg: g('--term-fg') } };
    return {
      current: { skin: k, name: own ? own.name : k, dark: now.dark, colors: now.colors, image: own && own.image ? { show: own.image.show, blur: own.image.blur } : null },
      fields: FIELDS.map(([k2, l, h]) => ({ key: k2, label: l, use: h })),
      custom: list().map(x => ({ id: x.id, name: x.name })),
    };
  }

  window.Themes = { repaintTerms, FIELDS, clean, css, show, byId, list, swatches, openEditor, save, designWithClaude, current, norm };
})();
