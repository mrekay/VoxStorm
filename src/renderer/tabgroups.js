'use strict';
/* Tab groups for the AI mode tab bar (#tabs), like Chrome / VS Code tab groups.
   Claude sessions and shells from one or more projects go into a named, coloured group.
   S.groups = [{ id, name, color, collapsed }], each tab carries tab.group (id or null).
   Groups are saved with the open tabs (config.tabGroups next to config.lastTabs) and come
   back with "Son oturumları geri yükle". Uses app.js globals (S, tabById, activate, closeTab…). */
/* global S, CFG, $, $$, esc, proj, tabById, activate, closeTab, openTerminal, saveOpenTabs, renderAll, renderTabs,
   renameSessionUi, closeIdeMenu, attnCls, STATUS_TEXT, SHORTCUTS, toast, uiPrompt */

S.groups = [];
S.tsel = new Set(); // tabs picked with Ctrl+click

const TG_COLORS = [
  ['grey', '#8a8f98', 'Gri'], ['blue', '#4c8bf5', 'Mavi'], ['red', '#e5534b', 'Kırmızı'],
  ['yellow', '#d4a017', 'Sarı'], ['green', '#3fa45b', 'Yeşil'], ['pink', '#e0559a', 'Pembe'],
  ['purple', '#9a6cf0', 'Mor'], ['cyan', '#1fa5b5', 'Camgöbeği'], ['orange', '#e8823a', 'Turuncu'],
];
const tgColor = c => (TG_COLORS.find(x => x[0] === c) || TG_COLORS[0])[1];
const groupById = id => id && S.groups.find(g => g.id === id);
const groupTabs = gid => S.tabs.filter(t => t.group === gid);

/* ---------- model ---------- */
// keep each group's tabs next to each other in S.tabs, at the place of its first tab
function tgNormalize() {
  const out = [], seen = new Set();
  for (const t of S.tabs) {
    if (!t.group || !groupById(t.group)) { out.push(t); continue; }
    if (seen.has(t.group)) continue;
    seen.add(t.group);
    out.push(...groupTabs(t.group));
  }
  S.tabs.splice(0, S.tabs.length, ...out);
}
// forget groups that lost all their tabs, and group ids that no longer exist
function tgPrune() {
  for (const t of S.tabs) if (t.group && !groupById(t.group)) t.group = null;
  S.groups = S.groups.filter(g => S.tabs.some(t => t.group === g.id));
  for (const id of [...S.tsel]) if (!tabById(id)) S.tsel.delete(id);
}
function tgChanged() { tgNormalize(); tgPrune(); saveOpenTabs(); renderAll(); }
function nextColor() {
  const used = new Set(S.groups.map(g => g.color));
  return (TG_COLORS.find(c => !used.has(c[0])) || TG_COLORS[S.groups.length % TG_COLORS.length])[0];
}
function makeGroup(name, color) {
  const g = { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || `Grup ${S.groups.length + 1}`, color: color || nextColor(), collapsed: false };
  S.groups.push(g);
  return g;
}
// restoreTabs (app.js): bring a saved group definition back, return its id
function restoreGroup(def) {
  if (!def || !def.id) return null;
  if (!groupById(def.id)) S.groups.push({ id: def.id, name: def.name || 'Grup', color: def.color || 'grey', collapsed: false });
  return def.id;
}
function addToGroup(ids, gid) {
  const g = groupById(gid); if (!g) return;
  // new members go to the end of the group
  const moving = ids.map(tabById).filter(Boolean);
  for (const t of moving) { S.tabs.splice(S.tabs.indexOf(t), 1); t.group = g.id; }
  const rest = groupTabs(g.id);
  const at = rest.length ? S.tabs.indexOf(rest[rest.length - 1]) + 1 : S.tabs.length;
  S.tabs.splice(at, 0, ...moving);
  g.collapsed = false;
  S.tsel.clear();
  tgChanged();
}
async function newGroupFrom(ids) {
  ids = ids.filter(id => tabById(id));
  if (!ids.length) return;
  const name = await uiPrompt({
    title: 'Yeni sekme grubu', icon: 'fa-layer-group', input: `Grup ${S.groups.length + 1}`, ok: 'Oluştur', maxLength: 40,
    detail: ids.length > 1 ? `${ids.length} sekme bu gruba alınacak.` : 'Başka sekmeleri sürükleyerek ya da sağ tıklayıp gruba ekleyebilirsin.',
  });
  const v = name == null ? '' : name.replace(/\s+/g, ' ').trim();
  if (!v) return;
  // the group takes the place of the first tab
  const first = S.tabs.find(t => ids.includes(t.id));
  const g = makeGroup(v);
  const moving = ids.map(tabById).filter(t => t !== first);
  for (const t of moving) S.tabs.splice(S.tabs.indexOf(t), 1);
  first.group = g.id;
  S.tabs.splice(S.tabs.indexOf(first) + 1, 0, ...moving);
  moving.forEach(t => { t.group = g.id; });
  S.tsel.clear();
  tgChanged();
}
function ungroupTabs(ids) {
  // a tab leaving a group goes right after it, so it doesn't jump across the bar
  for (const id of ids) {
    const t = tabById(id); if (!t || !t.group) continue;
    const mates = groupTabs(t.group);
    S.tabs.splice(S.tabs.indexOf(t), 1);
    t.group = null;
    const last = mates.filter(x => x !== t).pop();
    S.tabs.splice(last ? S.tabs.indexOf(last) + 1 : S.tabs.length, 0, t);
  }
  S.tsel.clear();
  tgChanged();
}
function ungroupAll(gid) { groupTabs(gid).forEach(t => { t.group = null; }); tgChanged(); }
async function closeGroup(gid) {
  // closeTab asks itself for sessions that are still working
  for (const t of groupTabs(gid)) await closeTab(t.id);
}
function toggleGroup(gid) {
  const g = groupById(gid); if (!g) return;
  if (!g.collapsed) {
    const act = tabById(S.active);
    if (act && act.group === g.id) {
      // collapsing hides the active tab: move to the nearest tab outside the group
      const i = S.tabs.indexOf(act);
      const out = S.tabs.filter(t => t.group !== g.id);
      const next = out.find(t => S.tabs.indexOf(t) > i) || out[out.length - 1];
      if (!next) { toast('Grup daraltılamadı', 'Gruptan başka açık sekme yok.'); return; }
      g.collapsed = true;
      activate(next.id);
      saveOpenTabs();
      return;
    }
  }
  g.collapsed = !g.collapsed;
  saveOpenTabs();
  renderTabs();
}
async function renameGroup(gid) {
  const g = groupById(gid); if (!g) return;
  const name = await uiPrompt({ title: 'Grubu yeniden adlandır', icon: 'fa-i-cursor', input: g.name, ok: 'Kaydet', maxLength: 40 });
  const v = name == null ? '' : name.replace(/\s+/g, ' ').trim();
  if (!v || v === g.name) return;
  g.name = v;
  saveOpenTabs(); renderTabs();
}
async function newSessionInGroup(gid, pid) {
  const g = groupById(gid); if (!g || !proj(pid)) return;
  g.collapsed = false;
  await openTerminal({ kind: 'claude', projectId: pid, group: gid });
  tgNormalize();
  saveOpenTabs(); renderAll();
}

/* ---------- rendering (called from renderTabs in app.js) ---------- */
function tgSummary(members) {
  const n = k => members.filter(t => t.status === k).length;
  return { running: n('running'), waiting: n('waiting'), total: members.length };
}
function chipHTML(g, members) {
  const s = tgSummary(members);
  const at = g.collapsed ? (members.some(t => t.attn === 'ask') ? 'ask' : members.some(t => t.attn) ? 'done' : null) : null;
  const projects = [...new Set(members.map(t => (proj(t.projectId) || {}).name).filter(Boolean))];
  const tip = `${g.name}\n${s.total} sekme${projects.length ? ' · ' + projects.join(', ') : ''}`
    + `${s.running ? `\n${s.running} çalışıyor` : ''}${s.waiting ? `\n${s.waiting} karar bekliyor` : ''}`
    + `\nTıkla: ${g.collapsed ? 'genişlet' : 'daralt'} · Sağ tık: seçenekler`;
  return `<button class="tg-chip${attnCls(at)}" data-tgroup="${g.id}" title="${esc(tip)}" aria-expanded="${!g.collapsed}">`
    + `<span class="tg-name">${esc(g.name)}</span>`
    + (s.waiting ? `<span class="tg-b wait" aria-label="${s.waiting} karar bekliyor"><i class="fa-solid fa-hand"></i>${s.waiting}</span>` : '')
    + (s.running ? `<span class="tg-b run" aria-label="${s.running} çalışıyor"><span class="dot running"></span>${s.running}</span>` : '')
    + (g.collapsed ? `<span class="tg-b n">${s.total}</span>` : '')
    + '</button>';
}
function decorateTab(html, t) {
  return html.replace('<div class="tab ', `<div draggable="true" data-dragtab="${t.id}" class="tab ${S.tsel.has(t.id) ? 'tsel ' : ''}${t.group ? 'in-group ' : ''}`);
}
function tabStripHTML(tabHTML) {
  tgPrune();
  // a tab that becomes active (Ctrl+Tab, sidebar, notification) opens its group
  const act = tabById(S.active), ag = act && groupById(act.group);
  if (ag && ag.collapsed) ag.collapsed = false;
  const seen = new Set();
  let out = '';
  for (const t of S.tabs) {
    const g = groupById(t.group);
    if (!g) { out += decorateTab(tabHTML(t), t); continue; }
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const members = groupTabs(g.id);
    out += `<div class="tgroup${g.collapsed ? ' collapsed' : ''}" role="group" aria-label="${esc(g.name)}" style="--g:${tgColor(g.color)}">`
      + chipHTML(g, members) + (g.collapsed ? '' : members.map(m => decorateTab(tabHTML(m), m)).join('')) + '</div>';
  }
  return out;
}

/* ---------- context menus (reuse the #ideMenu element and its close handling) ---------- */
const TGM = { ctx: null };
function tgMenuAt(e, html) {
  e.preventDefault();
  const m = $('#ideMenu');
  m.innerHTML = html;
  m.hidden = false;
  const w = $('#win').getBoundingClientRect();
  const left = Math.min(e.clientX - w.left, w.width - m.offsetWidth - 8), top = Math.min(e.clientY - w.top, w.height - m.offsetHeight - 8);
  m.style.left = Math.max(8, left) + 'px'; m.style.top = Math.max(44, top) + 'px';
  m.tabIndex = -1; m.focus();
}
const tgIt = (act, icon, label, extra = '', cls = '') => `<button data-tgm="${act}" ${extra} class="${cls}" role="menuitem"><span class="mi"><i class="mic ${icon}"></i>${esc(label)}</span></button>`;
const tgSep = '<div class="sep"></div>';
function tgSub(icon, label, items) {
  return `<div class="has-sub"><button class="sub-open" type="button"><span class="mi"><i class="mic ${icon}"></i>${esc(label)}</span><i class="fa-solid fa-chevron-right sub-ar"></i></button><div class="sub">${items}</div></div>`;
}
function openTabMenu(e, id) {
  tgPrune();
  if (!S.tsel.has(id)) S.tsel.clear();
  const ids = S.tsel.size ? S.tabs.filter(t => S.tsel.has(t.id)).map(t => t.id) : [id];
  TGM.ctx = { kind: 'tab', id, ids };
  const tabs = ids.map(tabById);
  const multi = ids.length > 1;
  const others = S.groups.filter(g => !tabs.every(t => t.group === g.id));
  let html = multi ? `<div class="lbl">${ids.length} sekme seçili</div>` : '';
  html += tgIt('newgroup', 'fa-solid fa-layer-group', multi ? 'Seçilenlerle yeni grup' : 'Yeni gruba ekle', '', 'accent');
  if (others.length) html += tgSub('fa-solid fa-folder-plus', 'Gruba ekle', others.map(g => `<button data-tgm="addto" data-g="${g.id}" role="menuitem"><span class="mi"><span class="tg-sw" style="--g:${tgColor(g.color)}"></span>${esc(g.name)}</span><code>${groupTabs(g.id).length}</code></button>`).join(''));
  if (tabs.some(t => t.group)) html += tgIt('ungroup', 'fa-solid fa-arrow-right-from-bracket', 'Gruptan çıkar');
  html += tgSep;
  if (!multi && tabs[0].kind !== 'agent') html += tgIt('rename', 'fa-solid fa-i-cursor', 'Yeniden adlandır');
  html += tgIt('close', 'fa-solid fa-xmark', multi ? 'Seçilenleri kapat' : 'Kapat', '', 'danger');
  if (!multi) html += plugMenuHtml('session', sessCtx(tabs[0]));
  if (!multi) html += `<div class="lbl tg-hint">Ctrl+tık ile birden fazla sekme seç</div>`;
  tgMenuAt(e, html);
}
// items plugins added to the session menu (plugins.js)
const plugMenuHtml = (menu, ctx) => (window.pluginHost && pluginHost.menuHtml ? pluginHost.menuHtml(menu, ctx) : '');
const sessCtx = t => ({ kind: t.kind === 'claude' ? 'claude' : t.kind, tabId: t.id, sessionId: t.sessionId || null, projectId: t.projectId || null, title: t.title, agent: t.agent || null });
// sidebar rows that are not an open tab: a session running outside VoxStorm, or a past one
function openSessMenu(e, el) {
  const d = el.dataset;
  TGM.ctx = { kind: 'sess', data: { watch: d.watch, resume: d.resume, pid: d.pid } };
  let html = d.watch ? tgIt('swatch', 'fa-solid fa-eye', 'İzle') + tgIt('stake', 'fa-solid fa-right-to-bracket', "VoxStorm'a taşı")
    : tgIt('sresume', 'fa-solid fa-play', 'Kaldığı yerden devam et', '', 'accent');
  html += tgSep + tgIt('rename', 'fa-solid fa-i-cursor', 'Yeniden adlandır');
  const ext = d.watch ? S.live.find(x => x.sessionId === d.watch) : null;
  const h = d.resume ? (S.history[d.pid] || []).find(x => x.id === d.resume) : null;
  html += plugMenuHtml('session', { kind: d.watch ? 'watch' : 'history', tabId: null, sessionId: d.watch || d.resume, projectId: d.pid || (ext && (projOfCwd(ext.cwd) || {}).id) || null, title: (ext || h || {}).title || '' });
  tgMenuAt(e, html);
}
function openGroupMenu(e, gid) {
  const g = groupById(gid); if (!g) return;
  TGM.ctx = { kind: 'group', gid };
  const mine = [...new Set(groupTabs(gid).map(t => t.projectId))];
  const ps = [...S.projects].sort((a, b) => (mine.includes(b.id) ? 1 : 0) - (mine.includes(a.id) ? 1 : 0));
  const projItems = ps.length ? ps.map(p => `<button data-tgm="newin" data-p="${p.id}" role="menuitem" title="${esc(p.path)}"><span class="mi"><i class="mic fa-regular fa-folder"></i>${esc(p.name)}</span>${mine.includes(p.id) ? '<code>grupta</code>' : ''}</button>`).join('') : '<div class="lbl">Proje yok</div>';
  const html = `<div class="lbl">${esc(g.name)}</div>`
    + tgSub('fa-solid fa-plus', 'Bu grupta yeni Claude oturumu', projItems)
    + tgIt('grename', 'fa-solid fa-i-cursor', 'Yeniden adlandır')
    + tgIt('gtoggle', g.collapsed ? 'fa-solid fa-angles-right' : 'fa-solid fa-angles-left', g.collapsed ? 'Genişlet' : 'Daralt')
    + `<div class="tg-colors" role="group" aria-label="Grup rengi">${TG_COLORS.map(([k, c, l]) => `<button data-tgm="gcolor" data-c="${k}" class="tg-sw${g.color === k ? ' on' : ''}" style="--g:${c}" title="${l}" aria-label="${l}" aria-pressed="${g.color === k}"></button>`).join('')}</div>`
    + tgSep + tgIt('gungroup', 'fa-solid fa-object-ungroup', 'Grubu çöz')
    + tgIt('gclose', 'fa-solid fa-square-xmark', 'Gruptaki tümünü kapat', '', 'danger');
  tgMenuAt(e, html);
}
function tgMenuAction(b) {
  const ctx = TGM.ctx, act = b.dataset.tgm;
  if (!ctx) return;
  if (act === 'gcolor') {
    const g = groupById(ctx.gid); if (!g) return;
    g.color = b.dataset.c;
    $$('#ideMenu .tg-colors .tg-sw').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    saveOpenTabs(); renderTabs();
    return; // keep the menu open to try other colours
  }
  closeIdeMenu();
  TGM.ctx = null;
  if (ctx.kind === 'sess') {
    const d = ctx.data;
    if (act === 'rename') renameSessionUi({ dataset: d });
    else if (act === 'swatch') openWatch(d.watch);
    else if (act === 'stake') takeOverSession(d.watch);
    else if (act === 'sresume') {
      const h = (S.history[d.pid] || []).find(x => x.id === d.resume);
      openTerminal({ kind: 'claude', projectId: d.pid, resume: d.resume, title: h ? shorten(h.title, 48) : 'Oturum' });
    }
  } else if (ctx.kind === 'tab') {
    if (act === 'newgroup') newGroupFrom(ctx.ids);
    else if (act === 'addto') addToGroup(ctx.ids, b.dataset.g);
    else if (act === 'ungroup') ungroupTabs(ctx.ids);
    else if (act === 'rename') renameSessionUi({ dataset: { tab: ctx.id } });
    else if (act === 'close') { S.tsel.clear(); (async () => { for (const id of ctx.ids) await closeTab(id); })(); }
  } else {
    if (act === 'newin') newSessionInGroup(ctx.gid, b.dataset.p);
    else if (act === 'grename') renameGroup(ctx.gid);
    else if (act === 'gtoggle') toggleGroup(ctx.gid);
    else if (act === 'gungroup') ungroupAll(ctx.gid);
    else if (act === 'gclose') closeGroup(ctx.gid);
  }
}

/* ---------- drag and drop: onto a group chip joins it, onto a tab moves next to it ---------- */
const DRAG = { ids: null };
function clearDropMarks() { $$('#tabs .drop-before,#tabs .drop-after,#tabs .drop-in').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-in')); }
function dropTarget(e) {
  const chip = e.target.closest('[data-tgroup]');
  if (chip) return { chip, gid: chip.dataset.tgroup };
  const tab = e.target.closest('[data-dragtab]');
  if (tab) { const r = tab.getBoundingClientRect(); return { tab, id: tab.dataset.dragtab, after: e.clientX > r.left + r.width / 2 }; }
  return { end: true };
}
function moveTabs(ids, targetId, after) {
  const target = tabById(targetId); if (!target || ids.includes(targetId)) return;
  const moving = ids.map(tabById).filter(Boolean);
  for (const t of moving) { S.tabs.splice(S.tabs.indexOf(t), 1); t.group = target.group || null; }
  const i = S.tabs.indexOf(target) + (after ? 1 : 0);
  S.tabs.splice(i, 0, ...moving);
  S.tsel.clear();
  tgChanged();
}

/* ---------- events ---------- */
(() => {
  const bar = $('#tabs');
  // Ctrl+click picks several tabs; a plain click clears the pick. Runs before app.js's click handler.
  bar.addEventListener('click', e => {
    const chip = e.target.closest('[data-tgroup]');
    if (chip) { e.stopPropagation(); toggleGroup(chip.dataset.tgroup); return; }
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation(); e.preventDefault();
      const id = b.dataset.tab;
      if (!S.tsel.size && S.active && S.active !== id && tabById(S.active)) S.tsel.add(S.active);
      if (S.tsel.has(id)) S.tsel.delete(id); else S.tsel.add(id);
      renderTabs();
    } else if (S.tsel.size) S.tsel.clear(); // activate() re-renders
  }, true);
  bar.addEventListener('contextmenu', e => {
    const chip = e.target.closest('[data-tgroup]');
    if (chip) { e.stopPropagation(); openGroupMenu(e, chip.dataset.tgroup); return; }
    const b = e.target.closest('[data-tab]');
    if (!b || !tabById(b.dataset.tab)) return;
    e.stopPropagation(); // replaces the plain "rename" prompt app.js shows for other session lists
    openTabMenu(e, b.dataset.tab);
  });
  $('#ideMenu').addEventListener('click', e => { const b = e.target.closest('[data-tgm]'); if (b) { e.stopPropagation(); tgMenuAction(b); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.tsel.size) { S.tsel.clear(); renderTabs(); } });

  bar.addEventListener('dragstart', e => {
    const el = e.target.closest && e.target.closest('[data-dragtab]');
    if (!el) return;
    const id = el.dataset.dragtab;
    DRAG.ids = S.tsel.has(id) ? S.tabs.filter(t => S.tsel.has(t.id)).map(t => t.id) : [id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-voxstorm-tab', DRAG.ids.join(','));
    el.classList.add('dragging');
  });
  bar.addEventListener('dragover', e => {
    if (!DRAG.ids) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    const d = dropTarget(e);
    if (d.chip) d.chip.classList.add('drop-in');
    else if (d.tab && !DRAG.ids.includes(d.id)) d.tab.classList.add(d.after ? 'drop-after' : 'drop-before');
  });
  bar.addEventListener('dragleave', e => { if (!bar.contains(e.relatedTarget)) clearDropMarks(); });
  bar.addEventListener('drop', e => {
    if (!DRAG.ids) return;
    e.preventDefault();
    const ids = DRAG.ids, d = dropTarget(e);
    DRAG.ids = null; clearDropMarks();
    if (d.chip) addToGroup(ids, d.gid);
    else if (d.tab) moveTabs(ids, d.id, d.after);
    else if (d.end) {
      // dropped on the empty end of the bar: last place, outside any group
      const moving = ids.map(tabById).filter(Boolean);
      for (const t of moving) { S.tabs.splice(S.tabs.indexOf(t), 1); t.group = null; }
      S.tabs.push(...moving);
      S.tsel.clear();
      tgChanged();
    }
  });
  bar.addEventListener('dragend', () => { DRAG.ids = null; clearDropMarks(); $$('#tabs .dragging').forEach(x => x.classList.remove('dragging')); });

  SHORTCUTS.push({
    group: 'Terminaller', keys: 'Ctrl+Shift+L', label: 'Seçili sekmeleri (ya da açık olanı) yeni gruba al (AI modu)',
    when: () => S.mode === 'claude', // in IDE Ctrl+Shift+L selects all matches
    run: () => {
      if (S.mode !== 'claude') return;
      const ids = S.tsel.size ? S.tabs.filter(t => S.tsel.has(t.id)).map(t => t.id) : S.active ? [S.active] : [];
      if (ids.length) newGroupFrom(ids);
    },
  });
})();
