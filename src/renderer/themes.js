/* VoxStorm — custom themes: made in the theme editor, or by Claude / Codex (agentlink save_theme).
   A theme is ten base colours (+ light / dark and an optional background picture); every other colour
   of the app (hover, lines, soft tints, terminal selection…) is worked out from them here, in plain hex,
   because the terminal needs real colours, not CSS color-mix(). The theme is shown as
   :root[data-skin="custom"] from a <style> element; a picture adds data-bgimg and makes the surfaces
   see-through. Loaded by the main window and the welcome window. */
(() => {
  'use strict';
  const FIELDS = [
    ['bg', __('Arka plan'), __('Pencerenin en dış zemini')],
    ['surface', __('Yüzey'), __('Paneller, menüler, kartlar')],
    ['fg', __('Yazı'), __('Ana yazı rengi')],
    ['muted', __('Soluk yazı'), __('Açıklamalar, ikincil bilgiler')],
    ['accent', __('Vurgu'), __('Seçili öğeler, düğmeler, bağlantılar')],
    ['warn', __('Uyarı'), __('Karar bekleyen, dikkat')],
    ['ok', __('Başarılı'), __('Biten işler, ekleme')],
    ['danger', __('Tehlike'), __('Hata, silme')],
    ['termBg', __('Terminal zemini'), __('Terminal ve konsol arka planı')],
    ['termFg', __('Terminal yazısı'), __('“Temaya uyumlu” terminal renklerinde yazı rengi')],
  ];
  // picture slots: the whole window ("image") or one kind of panel. Panel pictures sit under that panel only,
  // whose own surfaces turn see-through, so each panel can have its own picture.
  const PANELS = [
    ['side', __('Yan paneller'), '.dock-side'],
    ['term', __('Terminal'), '.term-slot'],
    ['editor', __('Kod editörü'), '.code'],
  ];
  // what opens on top of the window: dialogs, settings, menus, toasts… They get their own opacity (default
  // 100: solid), so a background picture does not show through them.
  const POPUPS = '.ui-dlg,.settings,.skin-menu,.new-menu,.popover,.db-ctx,.db-dlg,.sec-drop,.has-sub>.sub,.toast,.ui-tip,.git-panel,.gp-drop,.start-panel,.plug-drawer,.dock-peek,.im-drop';
  const SLOTS = [['image', __('Tüm pencere')]].concat(PANELS.map(([k, l]) => [k, l]));
  // the 16 terminal colours; used when terminal colours follow the theme
  const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
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
    const pic = x => x && x.url ? { url: String(x.url), file: String(x.file || ''), show: Math.max(5, Math.min(90, +x.show || 35)), blur: Math.max(0, Math.min(30, +x.blur || 0)) } : null;
    const panels = {};
    for (const [k] of PANELS) { const p = pic(t.panels && t.panels[k]); if (p) panels[k] = p; }
    let ansi = null;
    if (t.ansi && typeof t.ansi === 'object') for (const k of ANSI) { const v = norm(t.ansi[k]); if (v) (ansi = ansi || {})[k] = v; }
    const popup = Math.max(50, Math.min(100, Math.round(+t.popup || 100)));
    return { id: String(t.id || ''), name: String(t.name || __('Tema')).slice(0, 40), dark, colors: c, image: pic(t.image), popup, panels: Object.keys(panels).length ? panels : undefined, ansi: ansi || undefined, by: t.by ? String(t.by).slice(0, 20) : undefined };
  }
  const files = t => { const x = clean(t); return [x.image, ...Object.values(x.panels || {})].filter(p => p && p.file).map(p => p.file); };
  const cssUrl = u => `url("${String(u).replace(/["\\]/g, '')}")`;

  // every CSS variable the app uses, from the ten base colours
  function vars(th) {
    const { colors: c, dark, image, panels } = clean(th);
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
        '--term-bg': rgba(c.termBg, 1 - s * 0.8), '--bg-img': cssUrl(image.url), '--bg-blur': image.blur + 'px',
      });
    }
    // a terminal picture: the terminal itself has to be see-through (xterm reads --term-bg from the root)
    if (panels && panels.term && !image) v['--term-bg'] = rgba(c.termBg, 1 - panels.term.show / 100 * 0.8);
    return { v, dark, image, panels };
  }
  // one panel's picture: under the panel's content, with that panel's surfaces made see-through
  function panelCss(sel, p, c) {
    const s = p.show / 100, r = ':root[data-skin="custom"] ' + sel;
    const own = `--bg:${rgba(c.bg, 1 - s)};--surface:${rgba(c.surface, 1 - s * 0.7)};--surface-2:${rgba(mix(c.surface, c.bg, 0.5), 1 - s * 0.75)};--term-bg:${rgba(c.termBg, 1 - s * 0.8)}`;
    return `${r}{${own};position:relative;isolation:isolate}`
      + `${r}::before{content:"";position:absolute;inset:0;z-index:-1;clip-path:inset(0);background:${cssUrl(p.url)} center/cover no-repeat;filter:blur(${p.blur}px);pointer-events:none}`;
  }
  // dialogs, settings and menus: their own opacity, whatever is behind them
  function popupCss(x) {
    const c = x.colors, a = x.popup / 100;
    if (a >= 1 && !x.image && !x.panels) return ''; // nothing see-through: the plain colours already are solid
    const col = h => a >= 1 ? h : rgba(h, a);
    return `:root[data-skin="custom"] :is(${POPUPS}){--bg:${col(c.bg)};--surface:${col(c.surface)};--surface-2:${col(mix(c.surface, c.bg, 0.5))}${a < 1 ? ';backdrop-filter:blur(14px)' : ''}}`;
  }
  function css(th) {
    const { v, dark, panels } = vars(th), x = clean(th), c = x.colors;
    return `:root[data-skin="custom"]{color-scheme:${dark ? 'dark' : 'light'};${Object.entries(v).map(([k, y]) => `${k}:${y}`).join(';')}}`
      + PANELS.filter(([k]) => panels && panels[k]).map(([k, , sel]) => panelCss(sel, panels[k], c)).join('')
      + popupCss(x);
  }

  // show a theme (or none: back to the built-in ones)
  function show(th) {
    const root = document.documentElement;
    let el = document.getElementById('voxCustomTheme');
    if (!th) { if (el) el.remove(); delete root.dataset.bgimg; delete root.dataset.termclear; return; }
    if (!el) { el = document.createElement('style'); el.id = 'voxCustomTheme'; document.head.appendChild(el); }
    el.textContent = css(th);
    root.dataset.skin = 'custom';
    const x = clean(th);
    if (x.image) root.dataset.bgimg = ''; else delete root.dataset.bgimg;
    // terminals are see-through when a picture is behind them (the window's or the terminal's own)
    if (x.image || (x.panels && x.panels.term)) root.dataset.termclear = ''; else delete root.dataset.termclear;
  }
  const active = () => { const k = (typeof CFG !== 'undefined' && CFG && CFG.settings.skin) || ''; const t = k.startsWith('custom:') && byId(k.slice(7)); return t ? clean(t) : null; };
  const list = () => (typeof CFG !== 'undefined' && CFG && CFG.settings.customThemes) || [];
  const byId = id => list().find(t => t.id === id) || null;

  /* ---------------- editor ---------------- */
  let ed = null; // { th, orig, el, skinBefore }
  function swatches(th) { const c = clean(th).colors; return [c.bg, c.accent, c.warn]; }

  function openEditor(id, preset) {
    if (ed) closeEditor(false);
    const orig = id ? byId(id) : null;
    const th = clean(preset || orig || Object.assign({ name: __('Yeni tema') }, JSON.parse(JSON.stringify(BASE))));
    if (orig) th.id = orig.id;
    const el = document.createElement('div');
    el.className = 'ui-dlg-bg in theme-ed-bg';
    const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    el.innerHTML = `<div class="ui-dlg theme-ed" role="dialog" aria-modal="true" aria-label="${attr(__('Tema düzenleyici'))}">
      <div class="ui-dlg-h"><i class="fa-solid fa-palette"></i><b>${orig ? __('Temayı düzenle') : __('Yeni tema')}</b></div>
      <div class="te-body">
        <label class="te-name"><span>${__('Ad')}</span><input type="text" data-te="name" maxlength="40" spellcheck="false"></label>
        <div class="seg te-mode"><button data-te-dark="1">${__('Koyu')}</button><button data-te-dark="0">${__('Açık')}</button></div>
        <div class="te-grid">${FIELDS.map(([k, l, h]) => `<label class="te-c" title="${attr(h)}"><input type="color" data-tc="${k}"><span><b>${l}</b><small data-tx="${k}"></small></span></label>`).join('')}</div>
        <h4>${__('Arka plan resmi')}</h4>
        <div class="seg te-slots">${SLOTS.map(([k, l]) => `<button data-te-slot="${k}">${l}<i class="te-dot" data-te-dot="${k}"></i></button>`).join('')}</div>
        <div class="te-img">
          <div class="te-thumb" data-te="thumb"></div>
          <div class="te-img-r">
            <div class="te-img-b"><button class="btn" data-te="pick"><i class="fa-regular fa-image"></i> ${__('Resim seç…')}</button><button class="btn" data-te="noimg"><i class="fa-solid fa-xmark"></i> ${__('Kaldır')}</button></div>
            <label class="te-sl"><span>${__('Görünürlük')}</span><input type="range" min="5" max="90" data-te="show"><b data-te="showv"></b></label>
            <label class="te-sl"><span>${__('Bulanıklık')}</span><input type="range" min="0" max="30" data-te="blur"><b data-te="blurv"></b></label>
          </div>
        </div>
        <h4>${__('Açılan pencereler')}</h4>
        <label class="te-sl"><span>${__('Opaklık')}</span><input type="range" min="50" max="100" data-te="popup"><b data-te="popupv"></b></label>
        <p class="set-note">${__('Ayarlar, diyaloglar, menüler ve bildirimler. %100: arkalarından hiçbir şey görünmez.')}</p>
        <p class="set-note">${__('Değişiklikler hemen önizlenir. Vazgeçersen önceki tema geri gelir.')}</p>
      </div>
      <div class="ui-dlg-f">
        ${orig ? `<button class="btn te-del" data-te="del"><i class="fa-solid fa-trash-can"></i> ${__('Sil')}</button>` : ''}
        <button class="btn" data-te="export" title="${attr(__('Temayı resimleriyle birlikte bir .voxtheme dosyasına kaydeder; başkası Tema menüsünden içe aktarabilir.'))}"><i class="fa-solid fa-share-nodes"></i> ${__('Paylaş')}</button>
        <button class="btn" data-te="claude"><i class="fa-solid fa-robot"></i> ${__('Claude ile tasarla')}</button>
        <span style="flex:1"></span>
        <button class="btn" data-te="cancel">${__('Vazgeç')}</button><button class="btn primary" data-te="save">${__('Kaydet ve uygula')}</button>
      </div></div>`;
    document.body.appendChild(el);
    ed = { th, orig, el, skinBefore: CFG.settings.skin, slot: 'image' };
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
    el.querySelectorAll('[data-te-slot]').forEach(b => b.classList.toggle('on', b.dataset.teSlot === ed.slot));
    el.querySelectorAll('[data-te-dot]').forEach(d => { d.hidden = !getPic(th, d.dataset.teDot); });
    const im = getPic(th, ed.slot);
    el.querySelector('[data-te=thumb]').style.backgroundImage = im ? cssUrl(im.url) : '';
    el.querySelector('[data-te=thumb]').classList.toggle('empty', !im);
    for (const k of ['show', 'blur']) {
      const r = el.querySelector(`[data-te=${k}]`); r.disabled = !im; r.value = im ? im[k] : (k === 'show' ? 35 : 0);
      el.querySelector(`[data-te=${k}v]`).textContent = im ? (k === 'show' ? '%' + im.show : im.blur + ' px') : '–';
    }
    el.querySelector('[data-te=noimg]').disabled = !im;
    el.querySelector('[data-te=popup]').value = th.popup;
    el.querySelector('[data-te=popupv]').textContent = '%' + th.popup;
  }
  // a picture slot: "image" (whole window) or a panel key
  const getPic = (th, slot) => slot === 'image' ? th.image : (th.panels && th.panels[slot]) || null;
  function setPic(th, slot, p) {
    if (slot === 'image') { th.image = p; return; }
    th.panels = Object.assign({}, th.panels);
    if (p) th.panels[slot] = p; else delete th.panels[slot];
  }
  // terminals take real colours: give them the new ones (and see-through when there is a picture)
  function repaintTerms() {
    if (typeof termTheme !== 'function' || typeof S === 'undefined') return;
    const th = termTheme(), clear = 'termclear' in document.documentElement.dataset;
    S.tabs.forEach(t => { if (t.term) { try { if (clear) t.term.options.allowTransparency = true; } catch (_) {} t.term.options.theme = th; } });
  }
  const preview = () => { show(ed.th); repaintTerms(); };
  function onInput(e) {
    const t = e.target, th = ed.th;
    if (t.dataset.tc) { th.colors[t.dataset.tc] = t.value; ed.el.querySelector(`[data-tx="${t.dataset.tc}"]`).textContent = t.value; }
    else if (t.dataset.te === 'name') { th.name = t.value; return; }
    else if (t.dataset.te === 'popup') { th.popup = +t.value; ed.el.querySelector('[data-te=popupv]').textContent = '%' + th.popup; }
    else if (t.dataset.te === 'show' || t.dataset.te === 'blur') { const p = getPic(th, ed.slot); if (p) p[t.dataset.te] = +t.value; fill(); }
    preview();
  }
  async function onClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    const th = ed.th;
    if (b.dataset.teDark) { th.dark = b.dataset.teDark === '1'; fill(); preview(); return; }
    if (b.dataset.teSlot) { ed.slot = b.dataset.teSlot; fill(); return; }
    const a = b.dataset.te;
    if (a === 'pick') {
      const r = await api.invoke('theme:pickImage');
      if (!r) return;
      if (r.error) { uiAlert({ title: __('Resim eklenemedi'), message: r.error }); return; }
      const was = getPic(th, ed.slot);
      setPic(th, ed.slot, { url: r.url, file: r.file, show: was ? was.show : 35, blur: was ? was.blur : 0 });
      fill(); preview();
    } else if (a === 'noimg') { setPic(th, ed.slot, null); fill(); preview(); }
    else if (a === 'export') exportTheme(th);
    else if (a === 'cancel') closeEditor(false);
    else if (a === 'save') { await save(th); closeEditor(true); }
    else if (a === 'del') {
      if (!(await uiConfirm({ title: __('Tema silinsin mi?'), message: __('“{name}” silinecek.', { name: th.name }), ok: __('Sil'), danger: true }))) return;
      const cur = byId(th.id);
      if (cur) files(cur).forEach(f => api.invoke('theme:removeImage', f).catch(() => {}));
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
    if (old) { const keep = files(t); files(old).filter(f => !keep.includes(f)).forEach(f => api.invoke('theme:removeImage', f).catch(() => {})); }
    const next = list().filter(x => x.id !== t.id).concat(t);
    const set = { customThemes: next, skin: 'custom:' + t.id };
    if (opts.termColors === 'theme' || opts.termColors === 'windows') set.termColors = opts.termColors;
    await setCfg({ settings: set });
    applySkin('custom:' + t.id);
    if (!opts.quiet && typeof renderSettings === 'function') { renderSettings(); renderSkinMenu(); }
    return t;
  }

  /* ---------------- share: a .voxtheme file carries the colours and the pictures ---------------- */
  async function exportTheme(th) {
    const t = clean(th);
    const r = await api.invoke('theme:export', { name: t.name, dark: t.dark, colors: t.colors, popup: t.popup, ansi: t.ansi, image: t.image, panels: t.panels });
    if (r && r.error) uiAlert({ title: __('Tema paylaşılamadı'), message: r.error });
    else if (r && r.path && typeof toast === 'function') toast(__('Tema kaydedildi'), __('“{name}” → {path}', { name: t.name, path: r.path }));
  }
  async function importTheme() {
    const r = await api.invoke('theme:import');
    if (!r) return;
    if (r.error) { uiAlert({ title: __('Tema içe aktarılamadı'), message: r.error }); return; }
    const t = await save(Object.assign({}, r.theme, { id: '' }));
    if (typeof toast === 'function') toast(__('Tema içe aktarıldı'), __('“{name}” uygulandı.', { name: t.name }));
  }

  /* ---------------- Claude designs it ---------------- */
  async function designWithClaude() {
    const desc = await uiPrompt({ title: __('Claude ile tema tasarla'), icon: 'fa-palette', message: __('Nasıl bir tema istiyorsun?'), placeholder: __('Ör: gün batımı, sıcak turuncu vurgulu koyu tema; ya da “şu resme göre”'), maxLength: 600, ok: __('Claude’a gönder') });
    if (!desc || !desc.trim()) return;
    const pid = (typeof projectHere === 'function' && projectHere()) || (S.projects[0] && S.projects[0].id);
    if (!pid) { uiAlert({ title: __('Proje yok'), message: __('Claude oturumu bir projede açılır. Önce bir proje ekle.') }); return; }
    if (S.mode !== 'claude') setMode('claude');
    const t = await openTerminal({ kind: 'claude', projectId: pid, title: __('Tema tasarımı') });
    if (!t) return;
    t.pendingPrompt = __('VoxStorm için yeni bir arayüz teması tasarla: {desc}\n\nÖnce VoxStorm\'un get_theme aracıyla şu anki temaya ve renk alanlarına bak. Sonra save_theme ile kaydet: ad, koyu/açık ve on rengin hepsi (#rrggbb). Yazı ile zemin arasında okunur bir kontrast olsun (WCAG AA). Bir resim kullanmak istersem image_path ile tüm pencereye, panel_images ile yalnızca yan panellere, terminale ya da kod editörüne yerel bir resim koyabilirsin. Terminal yazısının da temaya uyması için term_colors: "theme" ver (istersen ansi ile 16 terminal rengini de seç). Kaydedince tema hemen uygulanır; bana kısaca hangi renkleri neden seçtiğini anlat.', { desc: desc.trim() });
    setTimeout(() => sendPendingPrompt(t), 12000);
  }

  /* ---------------- for agents (agentapi.js) ---------------- */
  function current() {
    const k = (CFG && CFG.settings.skin) || 'mono';
    const own = k.startsWith('custom:') ? byId(k.slice(7)) : null;
    const cs = getComputedStyle(document.documentElement), g = n => cs.getPropertyValue(n).trim();
    const now = own ? clean(own) : { name: k, dark: g('color-scheme') !== 'light', colors: { bg: g('--bg'), surface: g('--surface'), fg: g('--fg'), muted: g('--muted'), accent: g('--accent'), warn: g('--warn'), ok: g('--ok'), danger: g('--danger'), termBg: g('--term-bg'), termFg: g('--term-fg') } };
    return {
      current: {
        skin: k, name: own ? own.name : k, dark: now.dark, colors: now.colors,
        image: own && own.image ? { show: own.image.show, blur: own.image.blur } : null,
        popup_opacity: own ? clean(own).popup : 100,
        panel_images: own && own.panels ? Object.fromEntries(Object.entries(clean(own).panels || {}).map(([p, x]) => [p, { show: x.show, blur: x.blur }])) : null,
        term_colors: (CFG && CFG.settings.termColors) || 'windows', ansi: own ? clean(own).ansi || null : null,
      },
      fields: FIELDS.map(([k2, l, h]) => ({ key: k2, label: l, use: h })),
      panels: PANELS.map(([p, l]) => ({ key: p, label: l })),
      ansi_keys: ANSI,
      notes: __('term_colors "windows" iken Claude Code terminalde Windows Terminal renkleriyle görünür ve termFg / ansi kullanılmaz; "theme" iken terminal yazısı termFg, 16 renk ansi’den gelir. Terminal zemini (termBg) ikisinde de uygulanır.'),
      custom: list().map(x => ({ id: x.id, name: x.name })),
    };
  }

  window.Themes = { repaintTerms, FIELDS, PANELS, ANSI, clean, css, show, byId, list, active, swatches, openEditor, save, designWithClaude, current, norm, exportTheme, importTheme };
})();
