/* Shared UI pieces used by every renderer page: themed tooltips and dialogs that
   replace the browser's native title bubbles and confirm()/alert() boxes. */
// the static text of the page in the interface language (src/i18n/i18n.js)
if (window.I18N) { I18N.translateDom(document.body); document.documentElement.lang = I18N.lang(); }

(() => {
  'use strict';
  const escT = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- tooltip ----------------
     Any element with a title gets the themed bubble instead: on hover the title moves to
     data-tip (so the native one never shows) and the bubble appears after a short delay. */
  const tip = document.createElement('div');
  tip.className = 'ui-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  let tipFor = null, tipTimer = 0, tipWarm = 0;
  function adopt(el) {
    const t = el.getAttribute('title');
    if (t == null) return;
    el.removeAttribute('title');
    if (t) {
      el.dataset.tip = t;
      // keep an accessible name for icon-only buttons that relied on the title
      if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t.split('\n')[0]);
    } else delete el.dataset.tip;
  }
  function place() {
    if (!tipFor || !tipFor.isConnected) return hideTip();
    const r = tipFor.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = innerWidth, vh = innerHeight;
    let top = r.bottom + 7, below = true;
    if (top + h > vh - 6) { top = r.top - h - 7; below = false; }
    if (top < 6) { top = Math.min(vh - h - 6, r.bottom + 7); below = true; }
    const left = Math.max(6, Math.min(vw - w - 6, r.left + r.width / 2 - w / 2));
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    tip.classList.toggle('above', !below);
  }
  function showTip(el) {
    const text = el.dataset.tip;
    if (!text) return;
    if (!tip.isConnected) document.body.appendChild(tip);
    tipFor = el;
    const [head, ...rest] = text.split('\n');
    tip.innerHTML = rest.length ? `<b>${escT(head)}</b>${rest.map(l => `<span>${escT(l)}</span>`).join('')}` : escT(head);
    tip.hidden = false; tip.classList.remove('in');
    place();
    requestAnimationFrame(() => tip.classList.add('in'));
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (!tip.hidden) tipWarm = Date.now();
    tipFor = null; tip.hidden = true; tip.classList.remove('in');
  }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[title],[data-tip]');
    if (el && el.hasAttribute('title')) adopt(el);
    if (el === tipFor) return;
    hideTip();
    if (!el || !el.dataset.tip) return;
    // moving from one tip to the next shows the next one at once
    tipTimer = setTimeout(() => showTip(el), Date.now() - tipWarm < 400 ? 40 : 450);
  }, true);
  document.addEventListener('mouseout', e => { if (tipFor && !(e.relatedTarget && tipFor.contains(e.relatedTarget))) hideTip(); }, true);
  // a bubble for something that is not an element of this page (a plugin frame's element): rect in window coordinates
  window.uiTipAt = (rect, text) => {
    hideTip();
    if (!text) return;
    showTip({ isConnected: true, dataset: { tip: String(text).slice(0, 1000) }, getBoundingClientRect: () => rect, contains: () => false });
  };
  window.uiHideTip = hideTip;
  for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) window.addEventListener(ev, hideTip, true);
  window.addEventListener('scroll', hideTip, true);
  // a title written while the bubble is showing (e.g. a toggled button) updates it
  new MutationObserver(list => {
    for (const m of list) if (m.target === tipFor && m.target.hasAttribute('title')) { adopt(tipFor); showTip(tipFor); }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['title'] });

  /* ---------------- dialogs ---------------- */
  let open = null;
  const waiting = []; // dialogs asked for while a kept one (an agent's question) is showing
  function dialog(opts) {
    // a kept dialog is never cancelled by another one: the newcomer waits its turn
    if (open && open.keep) return new Promise(r => waiting.push(() => r(show(opts))));
    if (open) open.finish(false);
    return show(opts);
  }
  function show({ title, message = '', detail = '', ok = __('Tamam'), cancel = __('Vazgeç'), danger = false, icon, alert = false, input = null, placeholder = '', maxLength = 200, choices = null, radio = false, code = '', check = '', keep = false, focusCancel = false }) {
    hideTip();
    return new Promise(resolve => {
      const prev = document.activeElement;
      const bg = document.createElement('div');
      bg.className = 'ui-dlg-bg';
      const ic = icon || (danger ? 'fa-triangle-exclamation' : alert ? 'fa-circle-info' : 'fa-circle-question');
      bg.innerHTML = `<div class="ui-dlg${danger ? ' danger' : ''}" role="${alert ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="uiDlgT" aria-describedby="uiDlgM">
        <div class="ui-dlg-h"><i class="fa-solid ${ic}"></i><b id="uiDlgT">${escT(title || 'VoxStorm')}</b></div>
        <div class="ui-dlg-m" id="uiDlgM">${escT(message).replace(/\n/g, '<br>')}${detail ? `<p>${escT(detail).replace(/\n/g, '<br>')}</p>` : ''}${code ? `<pre class="ui-dlg-code">${escT(code)}</pre>` : ''}${check ? `<label class="ui-dlg-c ui-dlg-chk"><input type="checkbox" data-chk><span><b>${escT(check)}</b></span></label>` : ''}${choices ? `<div class="ui-dlg-ch" role="group" aria-label="${escT(title || message)}">${choices.map((c, i) => `<label class="ui-dlg-c"><input type="${radio ? 'radio' : 'checkbox'}" name="uiDlgCh" data-ci="${i}"${c.checked ? ' checked' : ''}><span><b>${escT(c.label)}</b>${c.hint ? `<small>${escT(c.hint)}</small>` : ''}</span></label>`).join('')}</div>` : ''}${input != null ? `<input class="ui-dlg-in" type="text" spellcheck="false" maxlength="${+maxLength || 200}" value="${escT(input)}" placeholder="${escT(placeholder)}" aria-label="${escT(title || message)}">` : ''}</div>
        <div class="ui-dlg-f">${alert ? '' : `<button class="btn" data-r="0">${escT(cancel)}</button>`}<button class="btn primary${danger ? ' danger' : ''}" data-r="1">${escT(ok)}</button></div>
      </div>`;
      const inp = bg.querySelector('.ui-dlg-in');
      const finish = r => {
        if (open !== state) return;
        open = null;
        window.removeEventListener('keydown', onKey, true);
        bg.classList.remove('in');
        setTimeout(() => bg.remove(), 120);
        if (prev && prev.isConnected && prev.focus) try { prev.focus(); } catch (_) {}
        const picked = () => [...bg.querySelectorAll('[data-ci]')].filter(c => c.checked).map(c => choices[+c.dataset.ci].value);
        // choices and a text box together (an agent's question with "something else"): { values, text }
        resolve(choices && inp ? (r ? { values: picked(), text: inp.value } : null)
          : choices ? (r ? picked() : null)
          : inp ? (r ? inp.value : null)
          : check ? { ok: !!r, checked: !!(bg.querySelector('[data-chk]') || {}).checked } : r);
        const next = waiting.shift();
        if (next) setTimeout(next, 140);
      };
      const state = { finish, keep };
      const onKey = e => {
        e.stopImmediatePropagation();
        if (e.key === 'Escape') { e.preventDefault(); finish(alert); }
        else if (e.key === 'Tab') {
          const bs = [...bg.querySelectorAll('input,button')], i = bs.indexOf(document.activeElement);
          e.preventDefault(); bs[(i + (e.shiftKey ? bs.length - 1 : 1)) % bs.length].focus();
        }
        else if (e.key === 'Enter' && document.activeElement && document.activeElement.dataset.r == null) { e.preventDefault(); finish(true); }
      };
      bg.addEventListener('mousedown', e => { if (e.target === bg) { e.preventDefault(); bg.querySelector('.ui-dlg').classList.add('shake'); setTimeout(() => bg.querySelector('.ui-dlg').classList.remove('shake'), 300); } });
      bg.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (b) { e.stopPropagation(); finish(b.dataset.r === '1'); } });
      window.addEventListener('keydown', onKey, true);
      open = state;
      document.body.appendChild(bg);
      requestAnimationFrame(() => bg.classList.add('in'));
      // a text box starts focused with its text selected; destructive questions start on the safe button
      // with choices the first one starts focused, the text box ("or write your own") comes after
      if (choices && choices.length) (bg.querySelector('[data-ci]:checked') || bg.querySelector('[data-ci]')).focus();
      else if (inp) { inp.focus(); inp.select(); }
      else (bg.querySelector((danger || focusCancel) && !alert ? '[data-r="0"]' : '[data-r="1"]')).focus();
    });
  }
  window.uiConfirm = opts => dialog(typeof opts === 'string' ? { message: opts } : opts);
  // resolves to the typed text, or null when cancelled
  window.uiPrompt = opts => dialog(Object.assign({ input: '' }, opts));
  // resolves to the values of the ticked choices ([] when none), or null when cancelled
  window.uiChoose = opts => dialog(Object.assign({ choices: [] }, opts));
  // a question from outside the page (an agent wants a connection): queued, never cancelled by other
  // dialogs; with `check` it resolves to { ok, checked }
  window.uiAsk = opts => dialog(Object.assign({}, opts, { keep: true }));
  window.uiAlert = opts => dialog(Object.assign({ alert: true }, typeof opts === 'string' ? { message: opts } : opts));
})();

/* ---------------- platform ----------------
   The same pages run on Windows, macOS and Linux. Paths use the platform's separator, app shortcuts use
   Cmd on macOS (Ctrl stays with the terminal: Ctrl+C stops, Ctrl+R searches), and the labels that
   say "Ctrl+…", "Geri Dönüşüm Kutusu", "tepsi" are rewritten for macOS as they appear. */
(() => {
  'use strict';
  const platform = (window.api && window.api.platform) || 'win32';
  const IS_MAC = platform === 'darwin', IS_WIN = platform === 'win32';
  window.PLATFORM = platform; window.IS_MAC = IS_MAC; window.IS_WIN = IS_WIN;
  window.SEP = IS_WIN ? '\\' : '/';
  // the app's own "Ctrl" modifier: Cmd on macOS
  window.modKey = e => (IS_MAC ? e.metaKey : e.ctrlKey);
  // "Ctrl+Shift+P" -> "⌘⇧P"; Ctrl+Tab stays on Control (Cmd+Tab belongs to macOS)
  const macKeys = s => String(s)
    .replace(/\bCtrl\+(Shift\+)?Tab\b/g, (_m, sh) => '⌃' + (sh ? '⇧' : '') + 'Tab')
    .replace(/\bCtrl\+/g, '⌘').replace(/\bShift\+/g, '⇧').replace(/\bAlt\+/g, '⌥');
  window.keysLabel = s => (IS_MAC ? macKeys(s) : s);
  // CodeMirror key maps: the same commands on Cmd- (Ctrl-Space stays, Cmd+Space is Spotlight)
  window.cmKeys = map => {
    if (!IS_MAC) return map;
    const out = { ...map };
    for (const k of Object.keys(map)) if (/^Ctrl-/.test(k) && k !== 'Ctrl-Space') out[k.replace(/^Ctrl-/, 'Cmd-')] = map[k];
    return out;
  };
  if (IS_WIN) return;

  document.documentElement.classList.add(IS_MAC ? 'is-mac' : 'is-linux');
  /* the Windows names in each interface language (the text on screen is already translated), as
     [pattern, Linux, macOS]; longer phrases come before the words they contain. Linux: shortcuts stay
     on Ctrl, only the Windows names change; macOS also has no tray (the menu bar). null: leave as is. */
  const PLATFORM_WORDS = {
    tr: [
      [/Geri Dönüşüm Kutusu’na/g, 'Çöp kutusuna', 'Çöp Sepeti’ne'], [/Geri Dönüşüm Kutusu/g, 'Çöp kutusu', 'Çöp Sepeti'],
      [/Dosya Gezgini’nde/g, 'Dosya yöneticisinde', 'Finder’da'], [/Gezgin'de aç/g, 'Dosya yöneticisinde aç', "Finder'da aç"],
      [/sistem tepsisindeki simgeye sağ tıkla → Çık\./g, null, 'menü çubuğundaki simgeye tıkla → Çık ya da ⌘Q.'],
      [/Doğrudan sistem tepsisine başlar/g, null, 'Pencere açmadan menü çubuğunda başlar'],
      [/Kapat düğmesi tepsiye küçültsün/g, null, 'Kapat düğmesi menü çubuğuna gizlesin'], [/Tepsiye küçült/g, null, 'Menü çubuğuna gizle'],
      [/Windows açılınca başlat/g, 'Oturum açılınca başlat', 'Oturum açılınca başlat'], [/Windows ile başlat/g, 'Oturum açılınca başlat', 'Oturum açılınca başlat'],
      [/Windows bildirimi/g, 'Sistem bildirimi', 'macOS bildirimi'], [/Windows sesi/g, 'Sistem sesi', 'Sistem sesi'],
    ],
    en: [
      [/the Recycle Bin/g, 'the Trash', 'the Trash'], [/Recycle Bin/g, 'Trash', 'Trash'],
      [/File Explorer/g, 'the file manager', 'Finder'],
      [/system tray/g, null, 'menu bar'], [/System tray/g, null, 'Menu bar'], [/\btray\b/g, null, 'menu bar'], [/\bTray\b/g, null, 'Menu bar'],
      [/when Windows starts/g, 'at login', 'at login'], [/with Windows/g, 'at login', 'at login'],
      [/Windows notification/g, 'System notification', 'macOS notification'], [/Windows sound/g, 'System sound', 'System sound'],
    ],
    de: [
      [/Datei-Explorer/g, 'Dateimanager', 'Finder'],
      [/im Infobereich/g, null, 'in der Menüleiste'], [/in den Infobereich/g, null, 'in die Menüleiste'],
      [/Taskleisten-Infobereich/g, null, 'Menüleiste'], [/Infobereich/g, null, 'Menüleiste'],
      [/mit Windows/g, 'bei der Anmeldung', 'bei der Anmeldung'], [/Mit Windows/g, 'Bei der Anmeldung', 'Bei der Anmeldung'], [/Windows-Start/g, 'Anmeldung', 'Anmeldung'],
      [/Windows-Benachrichtigung/g, 'Systembenachrichtigung', 'macOS-Benachrichtigung'], [/Windows-Sound/g, 'Systemton', 'Systemton'], [/Windows-Ton/g, 'Systemton', 'Systemton'],
    ],
    es: [
      [/Papelera de reciclaje/g, 'Papelera', 'Papelera'],
      [/el Explorador de archivos/g, 'el gestor de archivos', 'Finder'], [/Explorador de archivos/g, 'gestor de archivos', 'Finder'],
      [/bandeja del sistema/g, null, 'barra de menús'], [/Bandeja del sistema/g, null, 'Barra de menús'], [/\bbandeja\b/g, null, 'barra de menús'], [/\bBandeja\b/g, null, 'Barra de menús'],
      [/con Windows/g, 'al iniciar sesión', 'al iniciar sesión'],
      [/notificación de Windows/g, 'notificación del sistema', 'notificación de macOS'], [/sonido de Windows/g, 'sonido del sistema', 'sonido del sistema'],
    ],
    fr: [
      [/l’Explorateur de fichiers/g, 'le gestionnaire de fichiers', 'le Finder'], [/l'Explorateur de fichiers/g, 'le gestionnaire de fichiers', 'le Finder'],
      [/Explorateur de fichiers/g, 'gestionnaire de fichiers', 'Finder'],
      [/la zone de notification/g, null, 'la barre des menus'], [/zone de notification/g, null, 'barre des menus'],
      [/avec Windows/g, 'à l’ouverture de session', 'à l’ouverture de session'],
      [/notification Windows/g, 'notification système', 'notification macOS'], [/son Windows/g, 'son système', 'son système'],
    ],
  };
  const lang = window.I18N ? I18N.lang() : 'tr';
  const WORDS = (PLATFORM_WORDS[lang] || PLATFORM_WORDS.tr)
    .map(([re, linux, mac]) => [re, IS_MAC ? mac : linux]).filter(([, to]) => to != null);
  const fix = s => { let o = IS_MAC ? macKeys(s) : s; for (const [re, to] of WORDS) o = o.replace(re, to); return o; };
  const KBD = IS_MAC ? { Ctrl: '⌘', Shift: '⇧', Alt: '⌥' } : {};
  // a quick test before rewriting: the shortcut words (macOS) or any of this language's patterns
  const NEEDS = new RegExp([...(IS_MAC ? ['Ctrl', 'Shift\\+', 'Alt\\+'] : []), ...WORDS.map(([re]) => re.source)].join('|') || '(?!)');
  // terminals, editors and rendered Markdown show the user's own text: never rewrite those
  const SKIP = '.xterm,.CodeMirror,.md,.wm-b,.db-grid,[data-raw]';
  function fixNode(n) {
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (!p || !NEEDS.test(n.data) || p.closest(SKIP)) return;
      if (p.tagName === 'KBD' && KBD[n.data.trim()]) { n.data = KBD[n.data.trim()]; return; }
      const v = fix(n.data); if (v !== n.data) n.data = v;
      return;
    }
    if (n.nodeType !== 1 || n.closest(SKIP)) return;
    for (const a of ['title', 'data-tip', 'aria-label', 'placeholder']) {
      const v = n.getAttribute(a); if (v && NEEDS.test(v)) { const w = fix(v); if (w !== v) n.setAttribute(a, w); }
    }
    for (let c = n.firstChild; c; c = c.nextSibling) fixNode(c);
  }
  const start = () => {
    fixNode(document.body);
    new MutationObserver(list => {
      for (const m of list) {
        if (m.type === 'attributes') { fixNode(m.target); continue; }
        if (m.type === 'characterData') { fixNode(m.target); continue; }
        m.addedNodes.forEach(fixNode);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'data-tip', 'aria-label', 'placeholder'] });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
