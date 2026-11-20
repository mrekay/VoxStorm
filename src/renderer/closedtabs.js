/* VoxStorm: recently closed tabs (AI mode and the IDE's Claude panel).
   Every closed Claude session or shell is remembered (config.closedTabs, newest first, kept across
   restarts) and can be opened again: Ctrl+Alt+T for the last one, or the clock button next to "+"
   in the tab bar for the list. A Claude session comes back with its conversation (--resume).
   Uses globals from app.js: S, CFG, setCfg, proj, esc, toast, openTerminal, tabBySession, SHORTCUTS. */
(() => {
  'use strict';
  const MAX = 25;
  const stored = () => (Array.isArray(CFG && CFG.closedTabs) ? CFG.closedTabs : []);
  const save = l => setCfg({ closedTabs: l.slice(0, MAX) });
  // a Claude session that is open again (here, from the side panel, or outside VoxStorm) is not
  // offered: opening it twice would run two Claude processes on one conversation
  const isOpen = e => e.kind === 'claude' && !!e.sessionId && (!!tabBySession(e.sessionId) || (typeof isExtLive === 'function' && isExtLive(e.sessionId)));
  const list = () => stored().filter(e => !isOpen(e));
  // drop the open ones for good (called on user actions, not on every render)
  function prune() { const l = stored(), keep = l.filter(e => !isOpen(e)); if (keep.length !== l.length) save(keep); }

  function remember(t) {
    if (!t || (t.kind !== 'claude' && t.kind !== 'shell')) return;
    if (t.kind === 'claude' && !t.sessionId) return;
    if (t.kind === 'claude' && !t.prompted) return; // nothing was said in it: nothing to come back to
    const e = { kind: t.kind, agent: t.agent || null, shell: t.shell || null, projectId: t.projectId, sessionId: t.kind === 'claude' ? t.sessionId : null, title: t.title, group: t.group || null, at: Date.now() };
    const l = stored().filter(x => !(e.sessionId && x.sessionId === e.sessionId));
    l.unshift(e);
    save(l);
  }
  async function reopen(i = 0) {
    prune();
    const e = list()[i]; // index into what the user sees (open sessions left out)
    if (!e) { toast('Kapatılan sekme yok'); return; }
    const rest = stored().filter(x => x !== e);
    save(rest);
    if (!proj(e.projectId)) { toast('Proje artık listede yok', e.title); return; }
    if (S.mode !== 'claude' && S.mode !== 'ide') setMode('claude');
    const group = e.group && S.groups && S.groups.some(g => g.id === e.group) ? e.group : null;
    if (e.kind === 'claude') {
      await openTerminal({ kind: 'claude', agent: e.agent || 'claude', projectId: e.projectId, resume: e.sessionId, title: e.title, group });
    } else await openTerminal({ kind: 'shell', shell: e.shell, projectId: e.projectId, group });
  }
  const ago = ms => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'az önce';
    if (s < 3600) return Math.floor(s / 60) + ' dk önce';
    if (s < 86400) return Math.floor(s / 3600) + ' sa önce';
    return Math.floor(s / 86400) + ' gün önce';
  };

  /* the list under the clock button */
  let menu = null;
  function openMenu(btn) {
    prune();
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'new-menu ct-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
      document.getElementById('win').appendChild(menu);
      menu.addEventListener('click', e => {
        const b = e.target.closest('[data-ct]'); if (!b) return;
        closeMenu();
        if (b.dataset.ct === 'clear') { save([]); if (window.renderAll) renderAll(); toast('Liste temizlendi'); }
        else reopen(+b.dataset.ct);
      });
      document.addEventListener('mousedown', e => { if (menu && !menu.hidden && !e.target.closest('.ct-menu,[data-closedmenu]')) closeMenu(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && menu && !menu.hidden) closeMenu(); });
    }
    const l = list();
    menu.innerHTML = `<div class="h">Son kapatılanlar</div>` + (l.length ? l.map((e, i) => {
      const p = proj(e.projectId);
      const icon = e.kind !== 'claude' ? 'fa-solid fa-terminal' : e.agent === 'codex' ? 'fa-brands fa-openai' : 'fa-solid fa-robot';
      return `<button data-ct="${i}" role="menuitem" title="${e.kind === 'claude' ? 'Konuşmasıyla birlikte devam ettir' : 'Yeni terminal aç'}"><i class="${icon}"></i><span class="ct-t"><b>${esc(e.title)}</b><small>${esc(p ? p.name : 'silinmiş proje')} · ${ago(e.at)}</small></span>${i === 0 ? '<kbd>Ctrl+Alt+T</kbd>' : ''}</button>`;
    }).join('') + '<div class="sep"></div><button data-ct="clear" role="menuitem"><i class="fa-solid fa-broom"></i><span class="ct-t">Listeyi temizle</span></button>'
      : '<div class="ct-empty">Bu oturumda kapatılan sekme yok.</div>');
    menu.hidden = false;
    const w = document.getElementById('win').getBoundingClientRect(), r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.right - w.left - menu.offsetWidth, w.width - menu.offsetWidth - 8)) + 'px';
    menu.style.top = (r.bottom - w.top + 4) + 'px';
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() { if (menu) menu.hidden = true; document.querySelectorAll('[data-closedmenu]').forEach(b => b.setAttribute('aria-expanded', 'false')); }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-closedmenu]'); if (!b) return;
    e.stopPropagation();
    if (menu && !menu.hidden) closeMenu(); else openMenu(b);
  }, true);

  // the split button app.js puts next to "+" in the tab bar: left part reopens the last one,
  // the caret lists them all to pick one
  function buttonHtml(wide) {
    const l = list(); if (!l.length) return '';
    const p = proj(l[0].projectId);
    return `<span class="ct-split${wide ? ' wide' : ''}"><button class="ct-main" data-ctlast="1" title="Son kapatılanı yeniden aç: ${esc(l[0].title)}${p ? ' · ' + esc(p.name) : ''} (Ctrl+Alt+T)" aria-label="Son kapatılanı yeniden aç"><i class="fa-solid fa-clock-rotate-left"></i>${wide ? ' Kapatılanı geri aç' : ''}</button><button class="ct-car" data-closedmenu="1" title="Kapatılanlardan birini seç (${l.length})" aria-label="Kapatılan sekmeler listesi" aria-haspopup="true" aria-expanded="false"><i class="fa-solid fa-chevron-down"></i></button></span>`;
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-ctlast]')) return;
    e.stopPropagation(); closeMenu(); reopen(0);
  }, true);

  window.closedTabs = { remember, reopen, buttonHtml, list };
  try {
    SHORTCUTS.push({ group: 'Terminaller', keys: 'Ctrl+Alt+T', label: 'Son kapatılan sekmeyi yeniden aç (Claude oturumu konuşmasıyla döner)', when: () => S.mode === 'claude' || S.mode === 'ide', run: () => reopen(0) });
  } catch (_) {}
})();
